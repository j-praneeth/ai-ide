"""
VS Code-style file watcher with EventCoalescer.

Architecture mirrors:
  src/vs/platform/files/node/watcher/watcher.ts
  src/vs/platform/files/common/watcher.ts  (EventCoalescer)

Strategy:
  • watchdog provides native OS watchers:
      macOS  → FSEvents   (same as VS Code's parcel-watcher/fsevents)
      Linux  → inotify
      Windows → ReadDirectoryChangesW
  • EventCoalescer deduplicates before dispatch:
      CREATE + DELETE → eliminated (temp file, no UI action needed)
      DELETE + CREATE → CHANGE    (atomic save pattern)
      child DELETE inside parent DELETE → child suppressed
  • Events batched for 300 ms then sent as a single WebSocket frame
"""

from __future__ import annotations

import asyncio
import json
import os
import threading
import time
from collections import defaultdict
from pathlib import Path
from typing import Dict, List, Optional, Set

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

# Optional watchdog import — gracefully degrade if not installed
try:
    from watchdog.observers import Observer
    from watchdog.events import (
        FileSystemEventHandler,
        FileCreatedEvent, FileDeletedEvent, FileModifiedEvent,
        FileMovedEvent, DirCreatedEvent, DirDeletedEvent, DirModifiedEvent,
    )
    WATCHDOG_AVAILABLE = True
except ImportError:
    WATCHDOG_AVAILABLE = False

router = APIRouter()

# ─── Change types (mirrors VS Code FileChangeType) ────────────────────────────
CHANGED = 'changed'
CREATED = 'created'
DELETED = 'deleted'


# ─── EventCoalescer ───────────────────────────────────────────────────────────
# Mirrors: src/vs/platform/files/common/watcher.ts → coalesceEvents()

def coalesce_events(events: List[dict]) -> List[dict]:
    """
    Deduplicate and simplify a batch of raw file-system events.

    Rules (same as VS Code):
      1. CREATE + DELETE of same path  → eliminate both (temp file)
      2. DELETE + CREATE of same path  → CHANGE         (atomic save)
      3. Child DELETE inside a parent DELETE → suppress child
      4. Duplicate events for same path → keep last
    """
    if not events:
        return []

    # Pass 1: collapse per-path sequences
    by_path: Dict[str, str] = {}  # path → last effective change type
    order: List[str] = []

    for ev in events:
        path = ev['path']
        kind = ev['type']
        prev = by_path.get(path)

        if prev is None:
            by_path[path] = kind
            order.append(path)
        elif prev == CREATED and kind == DELETED:
            # CREATE then DELETE → temp file, ignore entirely
            del by_path[path]
            order.remove(path)
        elif prev == DELETED and kind == CREATED:
            # DELETE then CREATE → atomic save pattern → CHANGE
            by_path[path] = CHANGED
        else:
            # Same or other combo → keep latest
            by_path[path] = kind

    # Pass 2: suppress child DELETEs whose parent folder was also deleted
    deleted_dirs: List[str] = [
        p for p in order
        if by_path.get(p) == DELETED and events and _is_dir_event(events, p)
    ]

    result: List[dict] = []
    for path in order:
        if path not in by_path:
            continue
        # Check if this path is a child of a deleted directory
        suppressed = any(
            path != d and path.startswith(d + os.sep)
            for d in deleted_dirs
        )
        if not suppressed:
            result.append({'path': path, 'type': by_path[path]})

    return result


def _is_dir_event(events: List[dict], path: str) -> bool:
    for ev in events:
        if ev['path'] == path and ev.get('is_dir', False):
            return True
    return False


# ─── Native watcher using watchdog ───────────────────────────────────────────

class _WatchdogHandler(FileSystemEventHandler if WATCHDOG_AVAILABLE else object):
    """Collects raw OS events into a buffer; the flush loop coalesces them."""

    BATCH_MS = 300  # VS Code uses similar 250-500ms batching

    def __init__(self, callback, loop: asyncio.AbstractEventLoop):
        if WATCHDOG_AVAILABLE:
            super().__init__()
        self._callback = callback
        self._loop = loop
        self._buffer: List[dict] = []
        self._lock = threading.Lock()
        self._flush_timer: Optional[threading.Timer] = None

    def _record(self, path: str, kind: str, is_dir: bool = False):
        with self._lock:
            self._buffer.append({'path': path, 'type': kind, 'is_dir': is_dir})
            # Reset the coalesce window
            if self._flush_timer:
                self._flush_timer.cancel()
            self._flush_timer = threading.Timer(
                self.BATCH_MS / 1000.0, self._flush
            )
            self._flush_timer.daemon = True
            self._flush_timer.start()

    def _flush(self):
        with self._lock:
            raw = self._buffer[:]
            self._buffer.clear()
            self._flush_timer = None
        coalesced = coalesce_events(raw)
        if coalesced:
            asyncio.run_coroutine_threadsafe(
                self._callback(coalesced), self._loop
            )

    # watchdog event handlers
    def on_created(self, event):
        self._record(event.src_path, CREATED, event.is_directory)

    def on_deleted(self, event):
        self._record(event.src_path, DELETED, event.is_directory)

    def on_modified(self, event):
        if not event.is_directory:  # skip directory mtime noise
            self._record(event.src_path, CHANGED)

    def on_moved(self, event):
        self._record(event.src_path, DELETED, event.is_directory)
        self._record(event.dest_path, CREATED, event.is_directory)


# ─── Per-connection watcher state ─────────────────────────────────────────────

class _WatchSession:
    def __init__(self, ws: WebSocket, root: Path, loop: asyncio.AbstractEventLoop):
        self.ws = ws
        self.root = root
        self.loop = loop
        self._observer: Optional[object] = None

    async def start(self):
        if not WATCHDOG_AVAILABLE:
            return

        async def _send(events: List[dict]):
            # Make paths relative to project root
            rel_events = []
            for ev in events:
                try:
                    rel = os.path.relpath(ev['path'], str(self.root))
                    rel_events.append({'path': rel, 'type': ev['type']})
                except ValueError:
                    continue  # path outside root (e.g. on different drive on Windows)
            if rel_events:
                try:
                    await self.ws.send_text(json.dumps({'changes': rel_events}))
                except Exception:
                    pass

        handler = _WatchdogHandler(_send, self.loop)
        observer = Observer()
        observer.schedule(handler, str(self.root), recursive=True)
        observer.daemon = True
        observer.start()
        self._observer = observer

    def stop(self):
        if self._observer:
            try:
                self._observer.stop()
                self._observer.join(timeout=2)
            except Exception:
                pass
            self._observer = None


# ─── WebSocket endpoint ───────────────────────────────────────────────────────

@router.websocket('/watch')
async def watch_files(websocket: WebSocket):
    """
    WebSocket endpoint — streams file-system changes to the frontend.

    The client sends no messages; the server pushes:
      { "changes": [{ "path": "relative/path", "type": "created|changed|deleted" }] }

    If watchdog is not installed, the connection stays open but never emits.
    """
    from file_manager import PROJECT_ROOT

    await websocket.accept()

    root = PROJECT_ROOT
    if not root:
        # No workspace open — stay connected, emit nothing
        try:
            while True:
                await asyncio.sleep(30)
        except (WebSocketDisconnect, Exception):
            return

    loop = asyncio.get_event_loop()
    session = _WatchSession(websocket, root, loop)
    await session.start()

    try:
        while True:
            # Keep connection alive; actual events pushed by the watchdog handler
            await asyncio.sleep(5)
            try:
                await websocket.send_text(json.dumps({'ping': True}))
            except Exception:
                break
    except (WebSocketDisconnect, Exception):
        pass
    finally:
        session.stop()

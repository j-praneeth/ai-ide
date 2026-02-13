"""
Nebula IDE Relay Server
-----------------------
A lightweight WebSocket relay deployed on Railway (or any cloud).
It bridges communication between the desktop IDE and mobile companion app.

Architecture:
  Desktop IDE ──ws──▶ Relay Server ◀──ws── Mobile App
                      (Railway.app)

- Desktop connects as a "desktop" client, pushes live IDE events
- Mobile connects as a "mobile" client, receives events and sends prompts
- Relay just forwards messages between them — no AI, no file access
- Sessions are identified by a unique room code
"""

import asyncio
import json
import logging
import os
import secrets
import time
from typing import Dict, Set
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Query, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("relay")

# ── Security ──────────────────────────────────────────────────────────
# Set RELAY_SECRET on Railway to restrict who can create rooms.
# Without a valid secret, no one can create rooms or connect as a desktop.
RELAY_SECRET = os.environ.get("RELAY_SECRET", "")

if not RELAY_SECRET:
    logger.warning("RELAY_SECRET not set! Anyone can create rooms. Set it in Railway env vars.")


def _check_secret(provided: str) -> bool:
    """Constant-time comparison to prevent timing attacks."""
    if not RELAY_SECRET:
        return True  # No secret configured = allow (dev mode)
    return secrets.compare_digest(provided, RELAY_SECRET)


# ── Session / Room Management ─────────────────────────────────────────

class Room:
    """A room connects one desktop IDE to one or more mobile clients."""
    def __init__(self, room_code: str):
        self.room_code = room_code
        self.desktop: WebSocket | None = None
        self.mobiles: Set[WebSocket] = set()
        self.created_at = time.time()
        self.last_activity = time.time()
        self.secret = secrets.token_urlsafe(12)  # Desktop uses this to authenticate
        self.event_history: list = []  # Last N events for newly connecting mobiles
        self.max_history = 50

    def touch(self):
        self.last_activity = time.time()

    def add_event(self, event: dict):
        event.setdefault("timestamp", time.time())
        self.event_history.append(event)
        if len(self.event_history) > self.max_history:
            self.event_history.pop(0)

    @property
    def is_expired(self):
        # Rooms expire after 24 hours of inactivity
        return (time.time() - self.last_activity) > 86400

    @property
    def has_desktop(self):
        return self.desktop is not None


# Global room registry
_rooms: Dict[str, Room] = {}


def _generate_room_code() -> str:
    """Generate a short, human-friendly room code (6 chars)."""
    chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # No 0/O/1/I to avoid confusion
    return "".join(secrets.choice(chars) for _ in range(6))


def get_room(room_code: str) -> Room | None:
    room = _rooms.get(room_code.upper())
    if room and not room.is_expired:
        return room
    return None


# ── Cleanup Task ──────────────────────────────────────────────────────

async def cleanup_expired_rooms():
    """Periodically remove expired rooms."""
    while True:
        await asyncio.sleep(300)  # Every 5 minutes
        expired = [code for code, room in _rooms.items() if room.is_expired]
        for code in expired:
            del _rooms[code]
            logger.info("Cleaned up expired room: %s", code)


@asynccontextmanager
async def lifespan(app: FastAPI):
    task = asyncio.create_task(cleanup_expired_rooms())
    yield
    task.cancel()


# ── FastAPI App ───────────────────────────────────────────────────────

app = FastAPI(title="Nebula IDE Relay", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
def root():
    return {"service": "Nebula IDE Relay", "status": "running"}


@app.get("/health")
def health():
    return {"status": "healthy", "rooms": len(_rooms)}


# ── Room Management Endpoints (called by Desktop IDE) ─────────────────

@app.post("/rooms/create")
def create_room(api_key: str = Query(default="")):
    """Desktop IDE calls this to create a new relay room. Requires RELAY_SECRET."""
    if not _check_secret(api_key):
        raise HTTPException(403, "Invalid API key. Set the correct RELAY_SECRET.")

    code = _generate_room_code()
    while code in _rooms:
        code = _generate_room_code()

    room = Room(code)
    _rooms[code] = room

    logger.info("Room created: %s", code)
    return {
        "room_code": code,
        "secret": room.secret,
        "ws_url": f"/ws/desktop?room={code}&secret={room.secret}",
        "mobile_ws_url": f"/ws/mobile?room={code}",
    }


@app.get("/rooms/{room_code}")
def room_info(room_code: str):
    """Check if a room exists and its status."""
    room = get_room(room_code)
    if not room:
        raise HTTPException(404, "Room not found or expired")
    return {
        "room_code": room.room_code,
        "has_desktop": room.has_desktop,
        "mobile_count": len(room.mobiles),
        "created_at": room.created_at,
    }


# ── Desktop WebSocket ────────────────────────────────────────────────

@app.websocket("/ws/desktop")
async def desktop_ws(ws: WebSocket, room: str = Query(...), secret: str = Query(...)):
    """WebSocket endpoint for the desktop IDE."""
    room_obj = get_room(room)
    if not room_obj or room_obj.secret != secret:
        await ws.close(code=4001, reason="Invalid room or secret")
        return

    await ws.accept()
    room_obj.desktop = ws
    room_obj.touch()
    logger.info("Desktop connected to room %s", room)

    # Notify mobiles that desktop is online
    await _broadcast_to_mobiles(room_obj, {
        "type": "desktop_status",
        "online": True,
        "timestamp": time.time(),
    })

    try:
        while True:
            data = await ws.receive_text()
            room_obj.touch()
            try:
                message = json.loads(data)
                message.setdefault("timestamp", time.time())

                # Store in history
                room_obj.add_event(message)

                # Forward to all connected mobiles
                await _broadcast_to_mobiles(room_obj, message)

            except json.JSONDecodeError:
                pass
    except WebSocketDisconnect:
        logger.info("Desktop disconnected from room %s", room)
    except Exception as e:
        logger.warning("Desktop WS error in room %s: %s", room, e)
    finally:
        room_obj.desktop = None
        # Notify mobiles that desktop went offline
        await _broadcast_to_mobiles(room_obj, {
            "type": "desktop_status",
            "online": False,
            "timestamp": time.time(),
        })


# ── Mobile WebSocket ─────────────────────────────────────────────────

@app.websocket("/ws/mobile")
async def mobile_ws(ws: WebSocket, room: str = Query(...)):
    """WebSocket endpoint for mobile companion apps."""
    room_obj = get_room(room)
    if not room_obj:
        await ws.close(code=4001, reason="Room not found or expired")
        return

    await ws.accept()
    room_obj.mobiles.add(ws)
    room_obj.touch()
    logger.info("Mobile connected to room %s (total: %d)", room, len(room_obj.mobiles))

    # Send welcome + desktop status + event history
    try:
        await ws.send_text(json.dumps({
            "type": "connected",
            "room_code": room_obj.room_code,
            "desktop_online": room_obj.has_desktop,
            "timestamp": time.time(),
        }))

        # Send recent event history
        for event in room_obj.event_history[-30:]:
            await ws.send_text(json.dumps(event))

    except Exception:
        pass

    # Listen for messages from mobile and forward to desktop
    try:
        while True:
            data = await ws.receive_text()
            room_obj.touch()
            try:
                message = json.loads(data)
                message["_from"] = "mobile"
                message.setdefault("timestamp", time.time())

                # Forward to desktop
                if room_obj.desktop:
                    try:
                        await room_obj.desktop.send_text(json.dumps(message))
                    except Exception:
                        await ws.send_text(json.dumps({
                            "type": "error",
                            "message": "Desktop is not responding",
                        }))
                else:
                    await ws.send_text(json.dumps({
                        "type": "error",
                        "message": "Desktop IDE is not connected",
                    }))

            except json.JSONDecodeError:
                await ws.send_text(json.dumps({
                    "type": "error",
                    "message": "Invalid JSON",
                }))
    except WebSocketDisconnect:
        logger.info("Mobile disconnected from room %s", room)
    except Exception as e:
        logger.warning("Mobile WS error in room %s: %s", room, e)
    finally:
        room_obj.mobiles.discard(ws)


# ── Helpers ───────────────────────────────────────────────────────────

async def _broadcast_to_mobiles(room: Room, event: dict):
    """Send an event to all mobile clients in a room."""
    msg = json.dumps(event)
    dead = set()
    for ws in room.mobiles:
        try:
            await ws.send_text(msg)
        except Exception:
            dead.add(ws)
    room.mobiles -= dead


# ── Entry Point ───────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8080))
    uvicorn.run(app, host="0.0.0.0", port=port)

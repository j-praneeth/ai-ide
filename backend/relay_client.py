"""
Desktop Relay Client
--------------------
Maintains a persistent outbound WebSocket connection from the desktop IDE
to the cloud relay server (Railway). This enables:

1. Desktop → Relay → Mobile: Stream IDE events (terminal, agent, file changes)
2. Mobile → Relay → Desktop: Receive prompts and commands, process locally

The AI model (Ollama) stays local — prompts from mobile are received here,
processed by the local agent, and results streamed back through the relay.
"""

import asyncio
import json
import logging
import threading
import time
from typing import Optional

import requests

logger = logging.getLogger(__name__)

# ── State ─────────────────────────────────────────────────────────────

_relay_url: Optional[str] = None  # e.g. "https://your-relay.up.railway.app"
_room_code: Optional[str] = None
_room_secret: Optional[str] = None
_ws = None
_connected = False
_mobile_count = 0
_loop: Optional[asyncio.AbstractEventLoop] = None
_thread: Optional[threading.Thread] = None
_should_run = False


def is_relay_connected() -> bool:
    return _connected


def get_relay_info() -> dict:
    return {
        "relay_url": _relay_url,
        "room_code": _room_code,
        "connected": _connected,
        "mobile_count": _mobile_count,
    }


# ── Event Queue (thread-safe) ────────────────────────────────────────
# Desktop events are pushed here from sync code, and the async relay loop sends them

_event_queue: asyncio.Queue = None


_last_screen_frame = {"data": None}

def relay_emit(event: dict):
    """Push an event to be sent through the relay. Thread-safe, non-blocking."""
    if not _connected or _event_queue is None:
        return
    event.setdefault("timestamp", time.time())

    # For screen frames, store the latest and let sender pick it up
    # This prevents the queue from filling with stale frames
    if event.get("type") == "screen_frame":
        _last_screen_frame["data"] = event
        return

    try:
        _event_queue.put_nowait(event)
    except asyncio.QueueFull:
        pass  # Drop if queue is full


# ── Relay Connection ──────────────────────────────────────────────────

async def _connect_and_run():
    """Main async loop: connect to relay, send events, receive commands."""
    global _ws, _connected, _event_queue
    import websockets

    _event_queue = asyncio.Queue(maxsize=500)

    reconnect_delay = 2

    while _should_run:
        # Build URL each iteration using current globals (in case room was re-created)
        ws_url = _relay_url.replace("https://", "wss://").replace("http://", "ws://")
        ws_url = f"{ws_url}/ws/desktop?room={_room_code}&secret={_room_secret}"

        try:
            logger.info("Connecting to relay: room=%s", _room_code)
            async with websockets.connect(
                ws_url,
                ping_interval=20,
                ping_timeout=10,
                close_timeout=5,
                open_timeout=15,
            ) as ws_conn:
                # Check if server sent an error before we consider ourselves connected
                _ws = ws_conn
                _connected = True
                reconnect_delay = 2
                logger.info("Connected to relay (room: %s)", _room_code)

                # Run sender and receiver concurrently
                sender_task = asyncio.create_task(_sender(ws_conn))
                receiver_task = asyncio.create_task(_receiver(ws_conn))

                done, pending = await asyncio.wait(
                    [sender_task, receiver_task],
                    return_when=asyncio.FIRST_COMPLETED,
                )
                for task in pending:
                    task.cancel()

        except Exception as e:
            logger.warning("Relay connection error: %s", e)
        finally:
            _ws = None
            _connected = False

        if _should_run:
            logger.info("Reconnecting to relay in %ds...", reconnect_delay)
            await asyncio.sleep(reconnect_delay)
            reconnect_delay = min(reconnect_delay * 2, 60)


async def _sender(ws):
    """Send queued events and latest screen frame to the relay."""
    while True:
        # Send queued events first
        try:
            event = _event_queue.get_nowait()
            try:
                await ws.send(json.dumps(event))
            except Exception:
                try:
                    _event_queue.put_nowait(event)
                except asyncio.QueueFull:
                    pass
                break
        except asyncio.QueueEmpty:
            pass

        # Send latest screen frame if available
        frame = _last_screen_frame.get("data")
        if frame:
            _last_screen_frame["data"] = None  # Consume it
            try:
                await ws.send(json.dumps(frame))
            except Exception:
                break

        # Small sleep to prevent busy loop
        await asyncio.sleep(0.05)


async def _receiver(ws):
    """Receive messages from relay (mobile commands/prompts)."""
    async for raw in ws:
        try:
            message = json.loads(raw)
            msg_type = message.get("type", "")

            if msg_type == "prompt":
                # Mobile sent an AI prompt — process it locally
                asyncio.create_task(_handle_mobile_prompt(message))

            elif msg_type == "terminal_command":
                await _handle_mobile_terminal(message)

            elif msg_type == "get_files":
                await _handle_get_files()

            elif msg_type == "read_file":
                await _handle_read_file(message)

            elif msg_type == "get_status":
                await _handle_get_status()

            elif msg_type == "ping":
                relay_emit({"type": "pong"})

            elif msg_type in ("mobile_joined", "mobile_left"):
                global _mobile_count
                _mobile_count = message.get("mobile_count", 0)
                logger.info("Mobile %s — count: %d", msg_type, _mobile_count)

            elif msg_type in ("remote_click", "remote_scroll", "remote_keypress"):
                # Queue remote input for Electron
                try:
                    from mobile_bridge import _remote_input_queue
                    input_event = {
                        "type": "click" if msg_type == "remote_click" else
                               "scroll" if msg_type == "remote_scroll" else "keypress",
                        "x": message.get("x", 0),
                        "y": message.get("y", 0),
                    }
                    if msg_type == "remote_scroll":
                        input_event["deltaX"] = message.get("deltaX", 0)
                        input_event["deltaY"] = message.get("deltaY", 0)
                    if msg_type == "remote_keypress":
                        input_event["key"] = message.get("key", "")
                    _remote_input_queue.append(input_event)
                except Exception:
                    pass

        except json.JSONDecodeError:
            pass
        except Exception as e:
            logger.warning("Error handling relay message: %s", e)


# ── Command Handlers (process locally, send results through relay) ────

async def _handle_mobile_prompt(message: dict):
    """Process an AI prompt from mobile using the local Ollama model."""
    prompt_text = message.get("message", "").strip()
    if not prompt_text:
        relay_emit({"type": "error", "message": "Empty prompt"})
        return

    relay_emit({"type": "mobile_prompt", "source": "mobile", "message": prompt_text})

    try:
        import ai
        if not ai.agent_available:
            relay_emit({
                "type": "agent_error",
                "message": "AI agent not available. Install Ollama and pull a model.",
            })
            return

        from agent.orchestrator import run_agent_stream
        import file_manager
        from agent.tools import set_project_root
        set_project_root(file_manager.PROJECT_ROOT)

        ai.CONVERSATION_HISTORY.append({"role": "user", "content": prompt_text})
        history = list(ai.CONVERSATION_HISTORY[:-1]) if len(ai.CONVERSATION_HISTORY) > 1 else []

        final_answer = ""
        # run_agent_stream is sync generator — run in thread
        def _run():
            nonlocal final_answer
            for event in run_agent_stream(prompt_text, conversation_history=history):
                event["source"] = "agent"
                relay_emit(event)
                if event.get("type") == "done":
                    final_answer = event.get("answer", "")

        await asyncio.get_event_loop().run_in_executor(None, _run)

        ai.CONVERSATION_HISTORY.append({"role": "assistant", "content": final_answer})
        if len(ai.CONVERSATION_HISTORY) > ai.MAX_HISTORY_MESSAGES:
            ai.CONVERSATION_HISTORY[:] = ai.CONVERSATION_HISTORY[-ai.MAX_HISTORY_MESSAGES:]

    except Exception as e:
        logger.exception("Mobile prompt error: %s", e)
        relay_emit({"type": "agent_error", "message": str(e)})


async def _handle_mobile_terminal(message: dict):
    """Run a terminal command from mobile."""
    command = message.get("command", "").strip()
    session = message.get("session", "mobile")
    if not command:
        return

    try:
        import terminal as term_module
        result = term_module.run_command(command=command, session=session)
        relay_emit({
            "type": "terminal_result",
            "command": command,
            "output": result.get("output", ""),
            "exit_code": result.get("exit_code", -1),
            "cwd": result.get("cwd", ""),
        })
    except Exception as e:
        relay_emit({"type": "error", "message": f"Terminal error: {e}"})


async def _handle_get_files():
    """Send file tree through relay."""
    try:
        import file_manager as fm
        tree = fm.get_tree()
        relay_emit({
            "type": "file_tree",
            "tree": tree,
            "workspace": str(fm.PROJECT_ROOT),
            "name": fm.PROJECT_ROOT.name,
        })
    except Exception as e:
        relay_emit({"type": "error", "message": f"File tree error: {e}"})


async def _handle_read_file(message: dict):
    """Send file content through relay."""
    path = message.get("path", "")
    try:
        import file_manager as fm
        result = fm.read_file(path=path)
        relay_emit({
            "type": "file_content",
            "path": path,
            "content": result.get("content", ""),
            "error": result.get("error"),
        })
    except Exception as e:
        relay_emit({"type": "error", "message": f"Read file error: {e}"})


async def _handle_get_status():
    """Send IDE status through relay."""
    try:
        import file_manager as fm
        relay_emit({
            "type": "ide_status",
            "workspace": str(fm.PROJECT_ROOT),
            "workspace_name": fm.PROJECT_ROOT.name,
            "desktop_online": True,
        })
    except Exception as e:
        relay_emit({"type": "error", "message": str(e)})


# ── Start / Stop ──────────────────────────────────────────────────────

def start_relay(relay_url: str = "", api_key: str = ""):
    """Create a room on the relay and start the connection in a background thread.
    If no arguments provided, uses values from relay_config.py."""
    global _relay_url, _room_code, _room_secret, _should_run, _thread, _loop

    # Stop any existing connection first
    if _should_run or _thread is not None:
        stop_relay()
        import time
        time.sleep(0.5)  # Give the old thread time to stop

    # Use admin config if not explicitly provided
    if not relay_url:
        from relay_config import RELAY_URL, RELAY_API_KEY
        relay_url = RELAY_URL
        api_key = api_key or RELAY_API_KEY

    if not relay_url:
        raise ValueError("Relay URL not configured.")

    _relay_url = relay_url.rstrip("/")

    # Create a room (pass API key for authentication)
    try:
        params = {}
        if api_key:
            params["api_key"] = api_key
        resp = requests.post(f"{_relay_url}/rooms/create", params=params, timeout=10)
        if resp.status_code == 403:
            raise ValueError("Invalid API key. Check your RELAY_SECRET.")
        resp.raise_for_status()
        data = resp.json()
        _room_code = data["room_code"]
        _room_secret = data["secret"]
        logger.info("Relay room created: %s", _room_code)
    except ValueError:
        raise
    except Exception as e:
        logger.error("Failed to create relay room: %s", e)
        raise

    # Start the async connection in a background thread
    _should_run = True

    def _run_loop():
        global _loop
        _loop = asyncio.new_event_loop()
        asyncio.set_event_loop(_loop)
        _loop.run_until_complete(_connect_and_run())

    _thread = threading.Thread(target=_run_loop, daemon=True, name="relay-client")
    _thread.start()

    return {"room_code": _room_code, "relay_url": _relay_url}


def stop_relay():
    """Disconnect from the relay."""
    global _should_run, _connected, _thread, _ws, _mobile_count, _room_code, _room_secret
    _should_run = False
    _connected = False
    _mobile_count = 0
    _room_code = None
    _room_secret = None
    # Close WebSocket if open
    if _ws:
        try:
            if _loop and _loop.is_running():
                asyncio.run_coroutine_threadsafe(_ws.close(), _loop)
        except Exception:
            pass
    _ws = None
    _thread = None
    logger.info("Relay client stopped")

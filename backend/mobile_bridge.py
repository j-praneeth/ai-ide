"""
Mobile Companion Bridge
-----------------------
Provides WebSocket connectivity for mobile companion apps,
QR code generation for pairing, and an event bus that captures
IDE activity (terminal, agent, file changes) and broadcasts
to all connected mobile clients.
"""

import asyncio
import json
import logging
import socket
import time
import io
import base64
from typing import Dict, Set

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Query

router = APIRouter()
logger = logging.getLogger(__name__)

# ── Connected mobile clients ──────────────────────────────────────────
_clients: Set[WebSocket] = set()
_client_lock = asyncio.Lock()

# ── Event history (ring buffer for newly connecting clients) ──────────
_event_history: list = []
MAX_HISTORY = 100

# ── Session token for simple auth ─────────────────────────────────────
import secrets
_session_token: str = secrets.token_urlsafe(16)


def get_local_ip() -> str:
    """Get the local network IP address."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(0.5)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


def _get_backend_port() -> int:
    """Get the port the backend is running on."""
    # Default; overridden by main.py at startup
    return getattr(_get_backend_port, "_port", 8000)


def set_backend_port(port: int):
    """Called by main.py to store the actual port."""
    _get_backend_port._port = port


# ── Event Bus ─────────────────────────────────────────────────────────

async def broadcast(event: dict):
    """Send an event to all connected mobile clients."""
    event.setdefault("timestamp", time.time())
    msg = json.dumps(event)

    # Store in history
    _event_history.append(event)
    if len(_event_history) > MAX_HISTORY:
        _event_history.pop(0)

    # Broadcast to all connected clients
    async with _client_lock:
        dead = set()
        for ws in _clients:
            try:
                await ws.send_text(msg)
            except Exception:
                dead.add(ws)
        _clients -= dead


def emit_sync(event: dict):
    """Synchronous wrapper for broadcast — call from sync code (terminal, agent, etc.)."""
    event.setdefault("timestamp", time.time())

    # Store in history
    _event_history.append(event)
    if len(_event_history) > MAX_HISTORY:
        _event_history.pop(0)

    # Schedule the async broadcast (local WebSocket clients)
    try:
        loop = asyncio.get_running_loop()
        loop.create_task(_broadcast_to_clients(event))
    except RuntimeError:
        # No running loop — happens during startup; skip
        pass

    # Also push to cloud relay if connected
    try:
        from relay_client import relay_emit
        relay_emit(event)
    except Exception:
        pass


async def _broadcast_to_clients(event: dict):
    """Internal async broadcast."""
    msg = json.dumps(event)
    async with _client_lock:
        dead = set()
        for ws in _clients:
            try:
                await ws.send_text(msg)
            except Exception:
                dead.add(ws)
        _clients -= dead


# ── QR Code Endpoint ──────────────────────────────────────────────────

@router.get("/qr")
def get_qr_code():
    """Generate a QR code containing the WebSocket connection URL and token."""
    ip = get_local_ip()
    port = _get_backend_port()
    ws_url = f"ws://{ip}:{port}/mobile/ws?token={_session_token}"
    http_url = f"http://{ip}:{port}"

    connection_info = {
        "ws_url": ws_url,
        "http_url": http_url,
        "token": _session_token,
        "ip": ip,
        "port": port,
    }

    # Try to generate QR image as base64
    qr_image_b64 = None
    try:
        import qrcode

        qr = qrcode.QRCode(version=1, box_size=10, border=2)
        qr.add_data(json.dumps(connection_info))
        qr.make(fit=True)
        img = qr.make_image(fill_color="white", back_color="#0D0D12")
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        qr_image_b64 = base64.b64encode(buf.getvalue()).decode("utf-8")
    except ImportError:
        logger.warning("qrcode package not installed — returning text-only connection info")
    except Exception as e:
        logger.warning("QR code generation failed: %s", e)

    return {
        "connection_info": connection_info,
        "qr_image": qr_image_b64,  # base64 PNG or null
    }


@router.get("/token")
def get_token():
    """Return the current session token (for desktop UI to display)."""
    return {"token": _session_token}


@router.post("/token/refresh")
def refresh_token():
    """Generate a new session token (invalidates existing mobile connections)."""
    global _session_token
    _session_token = secrets.token_urlsafe(16)
    return {"token": _session_token}


@router.get("/status")
def mobile_status():
    """Return the number of connected mobile clients and relay status."""
    relay_info = {"connected": False, "room_code": None, "relay_url": None}
    try:
        from relay_client import get_relay_info
        relay_info = get_relay_info()
    except Exception:
        pass

    return {
        "connected_clients": len(_clients),
        "local_ip": get_local_ip(),
        "port": _get_backend_port(),
        "relay": relay_info,
    }


# ── Cloud Relay Endpoints ─────────────────────────────────────────────

@router.post("/relay/connect")
def relay_connect():
    """Generate a room code by connecting to the cloud relay.
    Uses pre-configured admin credentials — users never see the relay URL or API key."""
    try:
        from relay_client import start_relay, is_relay_connected, get_relay_info
        if is_relay_connected():
            info = get_relay_info()
            return {"status": "connected", "room_code": info.get("room_code")}
        result = start_relay()  # Uses relay_config.py internally
        return {"status": "connected", **result}
    except Exception as e:
        return {"status": "error", "message": str(e)}


@router.post("/relay/disconnect")
def relay_disconnect():
    """Disconnect from the cloud relay server."""
    try:
        from relay_client import stop_relay
        stop_relay()
        return {"status": "disconnected"}
    except Exception as e:
        return {"status": "error", "message": str(e)}


@router.get("/relay/status")
def relay_status():
    """Get current relay connection status (room code, connected state)."""
    try:
        from relay_client import get_relay_info
        return get_relay_info()
    except Exception:
        return {"connected": False, "room_code": None}


@router.get("/relay/configured")
def relay_configured():
    """Check if the relay has been configured by the admin."""
    try:
        from relay_config import RELAY_URL
        return {"configured": bool(RELAY_URL)}
    except Exception:
        return {"configured": False}


# ── WebSocket Endpoint ────────────────────────────────────────────────

@router.websocket("/ws")
async def mobile_websocket(ws: WebSocket, token: str = Query(default="")):
    """Main WebSocket endpoint for mobile companion app communication."""
    # Validate token
    if token != _session_token:
        await ws.close(code=4001, reason="Invalid session token")
        return

    await ws.accept()
    logger.info("Mobile client connected from %s", ws.client.host if ws.client else "unknown")

    async with _client_lock:
        _clients.add(ws)

    # Send welcome + recent history
    try:
        await ws.send_text(json.dumps({
            "type": "connected",
            "message": "Connected to Nebula IDE",
            "timestamp": time.time(),
        }))

        # Send recent event history so the mobile app has context
        for event in _event_history[-20:]:
            await ws.send_text(json.dumps(event))

    except Exception:
        pass

    # Listen for messages from mobile
    try:
        while True:
            data = await ws.receive_text()
            try:
                message = json.loads(data)
                await _handle_mobile_message(message, ws)
            except json.JSONDecodeError:
                await ws.send_text(json.dumps({
                    "type": "error",
                    "message": "Invalid JSON",
                }))
    except WebSocketDisconnect:
        logger.info("Mobile client disconnected")
    except Exception as e:
        logger.warning("Mobile WebSocket error: %s", e)
    finally:
        async with _client_lock:
            _clients.discard(ws)


async def _handle_mobile_message(message: dict, ws: WebSocket):
    """Handle incoming messages from the mobile companion app."""
    msg_type = message.get("type", "")

    if msg_type == "ping":
        await ws.send_text(json.dumps({"type": "pong", "timestamp": time.time()}))

    elif msg_type == "prompt":
        # User sent an AI prompt from mobile
        prompt_text = message.get("message", "").strip()
        if not prompt_text:
            await ws.send_text(json.dumps({
                "type": "error",
                "message": "Empty prompt",
            }))
            return

        # Broadcast that a prompt was received
        await broadcast({
            "type": "mobile_prompt",
            "source": "mobile",
            "message": prompt_text,
        })

        # Execute the AI agent in background
        asyncio.create_task(_run_agent_from_mobile(prompt_text, ws))

    elif msg_type == "terminal_command":
        # Run a terminal command from mobile
        command = message.get("command", "").strip()
        session = message.get("session", "default")
        if command:
            await _run_terminal_from_mobile(command, session, ws)

    elif msg_type == "get_files":
        # Request file tree
        await _send_file_tree(ws)

    elif msg_type == "read_file":
        # Read a file
        path = message.get("path", "")
        await _send_file_content(path, ws)

    elif msg_type == "get_status":
        # Send full status update
        await _send_status(ws)

    else:
        await ws.send_text(json.dumps({
            "type": "error",
            "message": f"Unknown message type: {msg_type}",
        }))


async def _run_agent_from_mobile(prompt: str, ws: WebSocket):
    """Run the AI agent from a mobile prompt and stream results."""
    try:
        import ai
        if not ai.agent_available:
            await ws.send_text(json.dumps({
                "type": "agent_error",
                "message": "AI agent not available. Install Ollama and pull a model.",
            }))
            return

        from agent.orchestrator import run_agent_stream
        import file_manager
        from agent.tools import set_project_root
        set_project_root(file_manager.PROJECT_ROOT)

        ai.CONVERSATION_HISTORY.append({"role": "user", "content": prompt})
        history = list(ai.CONVERSATION_HISTORY[:-1]) if len(ai.CONVERSATION_HISTORY) > 1 else []

        final_answer = ""
        for event in run_agent_stream(prompt, conversation_history=history):
            # Forward agent events to mobile
            event["source"] = "agent"
            await ws.send_text(json.dumps(event))
            # Also broadcast to all clients
            await broadcast(event)

            if event.get("type") == "done":
                final_answer = event.get("answer", "")

        ai.CONVERSATION_HISTORY.append({"role": "assistant", "content": final_answer})
        if len(ai.CONVERSATION_HISTORY) > ai.MAX_HISTORY_MESSAGES:
            ai.CONVERSATION_HISTORY[:] = ai.CONVERSATION_HISTORY[-ai.MAX_HISTORY_MESSAGES:]

    except Exception as e:
        logger.exception("Mobile agent error: %s", e)
        await ws.send_text(json.dumps({
            "type": "agent_error",
            "message": str(e),
        }))


async def _run_terminal_from_mobile(command: str, session: str, ws: WebSocket):
    """Run a terminal command from mobile and return results."""
    try:
        import terminal as term_module
        result = term_module.run_command(command=command, session=session)
        await ws.send_text(json.dumps({
            "type": "terminal_result",
            "command": command,
            "output": result.get("output", ""),
            "exit_code": result.get("exit_code", -1),
            "cwd": result.get("cwd", ""),
        }))
        # Broadcast terminal activity
        await broadcast({
            "type": "terminal_output",
            "source": "mobile",
            "command": command,
            "output": result.get("output", "")[:500],
            "exit_code": result.get("exit_code", -1),
        })
    except Exception as e:
        await ws.send_text(json.dumps({
            "type": "error",
            "message": f"Terminal error: {e}",
        }))


async def _send_file_tree(ws: WebSocket):
    """Send the file tree to mobile."""
    try:
        import file_manager as fm
        tree = fm.get_tree()
        await ws.send_text(json.dumps({
            "type": "file_tree",
            "tree": tree,
            "workspace": str(fm.PROJECT_ROOT),
            "name": fm.PROJECT_ROOT.name,
        }))
    except Exception as e:
        await ws.send_text(json.dumps({
            "type": "error",
            "message": f"File tree error: {e}",
        }))


async def _send_file_content(path: str, ws: WebSocket):
    """Send file content to mobile."""
    try:
        import file_manager as fm
        result = fm.read_file(path=path)
        await ws.send_text(json.dumps({
            "type": "file_content",
            "path": path,
            "content": result.get("content", ""),
            "error": result.get("error"),
        }))
    except Exception as e:
        await ws.send_text(json.dumps({
            "type": "error",
            "message": f"Read file error: {e}",
        }))


async def _send_status(ws: WebSocket):
    """Send full IDE status to mobile."""
    try:
        import file_manager as fm
        await ws.send_text(json.dumps({
            "type": "ide_status",
            "workspace": str(fm.PROJECT_ROOT),
            "workspace_name": fm.PROJECT_ROOT.name,
            "connected_clients": len(_clients),
            "local_ip": get_local_ip(),
        }))
    except Exception as e:
        await ws.send_text(json.dumps({
            "type": "error",
            "message": str(e),
        }))

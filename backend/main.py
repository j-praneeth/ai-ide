import sys
import os
import argparse
import logging
import threading

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from file_manager import router as file_router, set_project_root_path
from terminal import router as terminal_router
from ai import router as ai_router
from mobile_bridge import router as mobile_router, set_backend_port

logger = logging.getLogger("nebula.main")

app = FastAPI(title="AI IDE Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(file_router, prefix="/files")
app.include_router(terminal_router, prefix="/terminal")
app.include_router(ai_router, prefix="/ai")
app.include_router(mobile_router, prefix="/mobile")

@app.get("")
def root():
    return {"status": "AI IDE Backend Running"}

@app.get("/health")
def health():
    return {"status": "healthy"}


def _auto_connect_relay():
    """Auto-connect to cloud relay on startup if configured."""
    try:
        from relay_config import RELAY_URL, RELAY_AUTO_CONNECT
        if RELAY_URL and RELAY_AUTO_CONNECT:
            import time
            time.sleep(2)  # Let uvicorn start first
            from relay_client import start_relay
            result = start_relay()
            logger.info("Auto-connected to relay. Room code: %s", result.get("room_code"))
    except Exception as e:
        logger.warning("Auto-connect to relay skipped: %s", e)


def main():
    import uvicorn

    parser = argparse.ArgumentParser(description="Nebula IDE Backend")
    parser.add_argument("--port", type=int, default=8000, help="Port to listen on")
    parser.add_argument("--host", type=str, default="0.0.0.0", help="Host to bind to")
    parser.add_argument("--project-root", type=str, default=None,
                        help="Project root directory (default: parent of backend/)")
    args = parser.parse_args()

    # Set project root if provided
    if args.project_root:
        set_project_root_path(args.project_root)

    # Store the port for mobile bridge QR code generation
    set_backend_port(args.port)

    # Auto-connect to relay in background (non-blocking)
    threading.Thread(target=_auto_connect_relay, daemon=True).start()

    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()

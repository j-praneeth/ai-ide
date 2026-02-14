import sys
import os
import argparse
import logging

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from file_manager import router as file_router, set_project_root_path
from terminal import router as terminal_router
from ai import router as ai_router
from mobile_bridge import router as mobile_router, set_backend_port, relay_qr

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
# Explicitly register relay QR endpoint so it is always available (fixes 404 in some run configurations)
app.add_api_route("/mobile/relay/qr", relay_qr, methods=["GET"])


def _chat_history():
    """Return current conversation history (delegate to ai module)."""
    from ai import CONVERSATION_HISTORY
    return {"history": list(CONVERSATION_HISTORY)}


# Ensure GET /ai/chat/history is always available (avoids 404 if router prefix/mount differs)
app.add_api_route("/ai/chat/history", _chat_history, methods=["GET"])


async def _set_api_key(request: Request):
    """Store API key for provider (explicit route so POST /ai/set-api-key always works)."""
    try:
        from ai import store_api_key
        body = await request.json()
        if isinstance(body, dict):
            store_api_key(body.get("provider") or "ollama", body.get("api_key") or "")
        return {"status": "ok", "message": "API key saved"}
    except Exception as e:
        logger.exception("set-api-key failed: %s", e)
        return {"status": "error", "message": str(e)}


app.add_api_route("/ai/set-api-key", _set_api_key, methods=["POST"])

@app.get("")
def root():
    return {"status": "AI IDE Backend Running"}

@app.get("/health")
def health():
    return {"status": "healthy"}


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

    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()

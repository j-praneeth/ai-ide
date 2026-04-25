import sys
import os
from dotenv import load_dotenv

# Load environment variables from .env file if it exists
load_dotenv()

import argparse
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.base import BaseHTTPMiddleware

# Import routers and other components
from file_manager import router as file_router, set_project_root_path
from terminal import router as terminal_router, cli_status, cli_websocket
from ai import router as ai_router
from mobile_bridge import router as mobile_router, set_backend_port, relay_qr
from security.routes import router as auth_router
from security.middleware import AuthMiddleware
from usage.routes import router as usage_router
from db.mongo import init_mongo

logger = logging.getLogger("nebula.main")

@asynccontextmanager
async def lifespan(app: FastAPI):
    print("DEBUG: Application starting up...")
    try:
        from security.auth import seed_initial_super_admin_from_env
        admin = seed_initial_super_admin_from_env()
        if admin:
            print(f"DEBUG: Initial Super Admin seeded: {admin.email}")
        else:
            print("DEBUG: No initial admin seeded (already exists or env vars missing)")
    except Exception as e:
        print(f"DEBUG: Failed to seed initial admin during startup: {e}")
    yield

app = FastAPI(title="AI IDE Backend", lifespan=lifespan)

@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    logger.exception("Unhandled exception: %s", exc)
    print(f"DEBUG: Unhandled exception caught in global_exception_handler: {exc}")
    
    origin = request.headers.get("origin")
    allowed_origins = ["http://localhost:3000", "http://127.0.0.1:3000", "http://localhost:8000", "http://127.0.0.1:8000"]
    
    response_content = {
        "error": "Internal Server Error", 
        "details": str(exc),
        "path": request.url.path
    }
    
    headers = {}
    if origin and (origin in allowed_origins or origin.startswith("http://localhost:") or origin.startswith("http://127.0.0.1:")):
        headers["Access-Control-Allow-Origin"] = origin
        headers["Access-Control-Allow-Credentials"] = "true"
        headers["Access-Control-Allow-Methods"] = "*"
        headers["Access-Control-Allow-Headers"] = "*"

    return JSONResponse(
        status_code=500,
        content=response_content,
        headers=headers
    )

# Request logging middleware
class LoggingMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        method = scope.get("method")
        path = scope.get("path")
        origin = None
        for k, v in scope.get("headers", []):
            if k == b"origin":
                origin = v.decode("utf-8")
                break
                
        print(f"DEBUG: Request: {method} {path} (Origin: {origin})")
        
        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                print(f"DEBUG: Response: {message['status']} for {path}")
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        except Exception as e:
            print(f"DEBUG: Exception in LoggingMiddleware for {path}: {e}")
            raise

# 1. Logging Middleware (Inner Layer)
app.add_middleware(LoggingMiddleware)

# 2. Auth Middleware (Middle Layer)
app.add_middleware(AuthMiddleware)

# 3. CORS Middleware (Outer Layer)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000", "http://localhost:8000", "http://127.0.0.1:8000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"],
)

# Include routers
app.include_router(file_router, prefix="/files")
app.include_router(terminal_router, prefix="/terminal")
app.include_router(ai_router, prefix="/ai")
app.include_router(mobile_router, prefix="/mobile")
app.include_router(auth_router)
app.include_router(usage_router)

app.add_api_route("/mobile/relay/qr", relay_qr, methods=["GET"])

def _chat_history(session_id: str = "default"):
    from ai import CONVERSATIONS
    sid = (session_id or "default").strip() or "default"
    return {"session_id": sid, "history": list(CONVERSATIONS.get(sid, []))}

app.add_api_route("/ai/chat/history", _chat_history, methods=["GET"])
app.add_api_route("/terminal/cli/status", cli_status, methods=["GET"])
app.add_api_websocket_route("/terminal/ws/cli", cli_websocket)

async def _set_api_key(request: Request):
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
@app.get("/")
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

    if args.project_root:
        set_project_root_path(args.project_root)

    set_backend_port(args.port)
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")

if __name__ == "__main__":
    main()

import sys
import os
import asyncio
import httpx
from dotenv import load_dotenv
from pathlib import Path

# Load environment variables from .env file if it exists
load_dotenv()

import argparse
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, FileResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware

# Import routers and other components
from file_manager import router as file_router, set_project_root_path
from file_watcher import router as watcher_router
from terminal import router as terminal_router, cli_status, cli_websocket
from ai import router as ai_router
from mobile_bridge import router as mobile_router, set_backend_port, relay_qr
from security.routes import router as auth_router
from security.middleware import AuthMiddleware
from usage.routes import router as usage_router
from db.mongo import init_mongo
from admin_routes import router as admin_router
from extensions_routes import router as extensions_router

logger = logging.getLogger("nebula.main")

DEFAULT_CORS_ORIGINS = [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:8000",
    "http://127.0.0.1:8000",
    "null",  # file:// origin sent by Electron packaged app
]

def _get_cors_origins():
    raw = (os.environ.get("NEBULA_CORS_ORIGINS") or "").strip()
    if not raw:
        return list(DEFAULT_CORS_ORIGINS)
    parts = [p.strip() for p in raw.split(",") if p.strip()]
    return parts or list(DEFAULT_CORS_ORIGINS)

async def _run_startup_tasks():
    """Run all slow startup tasks in the background so the server accepts requests immediately."""
    try:
        from security.auth import seed_initial_super_admin_from_env
        await asyncio.to_thread(seed_initial_super_admin_from_env)
    except Exception as e:
        logger.warning("Admin seed failed: %s", e)

    try:
        from security.claude_token import reconcile_disk_credentials
        await asyncio.to_thread(reconcile_disk_credentials)
    except Exception as e:
        logger.warning("Credential reconciliation failed: %s", e)

    try:
        from security.claude_token import seed_from_env
        await asyncio.to_thread(seed_from_env)
    except Exception as e:
        logger.warning("Claude token seed failed: %s", e)

    try:
        from security.claude_token import start_disk_credential_watcher
        await asyncio.to_thread(start_disk_credential_watcher, 60)
    except Exception as e:
        logger.warning("Credential watcher failed to start: %s", e)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Fire-and-forget: startup tasks run in background; server is ready instantly.
    asyncio.create_task(_run_startup_tasks())
    yield

app = FastAPI(title="AI IDE Backend", lifespan=lifespan)

@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    logger.exception("Unhandled exception: %s", exc)
    print(f"DEBUG: Unhandled exception caught in global_exception_handler: {exc}")
    
    origin = request.headers.get("origin")
    allowed_origins = _get_cors_origins()
    
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

# 1. Auth Middleware (Inner Layer)
app.add_middleware(AuthMiddleware)

# 2. CORS Middleware (Outer Layer)
app.add_middleware(
    CORSMiddleware,
    allow_origins=_get_cors_origins(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"],
)

# Include routers
app.include_router(file_router, prefix="/files")
app.include_router(watcher_router, prefix="/files")
app.include_router(terminal_router, prefix="/terminal")
app.include_router(ai_router, prefix="/ai")
app.include_router(mobile_router, prefix="/mobile")
app.include_router(auth_router)
app.include_router(usage_router)
app.include_router(admin_router)
app.include_router(extensions_router)

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

GITHUB_REPO = os.environ.get("GITHUB_REPO", "j-praneeth/ai-ide")
GH_TOKEN = os.environ.get("GH_TOKEN") or os.environ.get("GH_REPO_TOKEN") or ""

if getattr(sys, 'frozen', False):
    PROJECT_ROOT = Path(sys._MEIPASS)
else:
    PROJECT_ROOT = Path(__file__).resolve().parents[1]

DOWNLOAD_SITE_DIR = PROJECT_ROOT / "download"
FAVICON_PATH = PROJECT_ROOT / "frontend" / "public" / "favicon.ico"

if DOWNLOAD_SITE_DIR.exists() and DOWNLOAD_SITE_DIR.is_dir():
    app.mount("/download/static", StaticFiles(directory=str(DOWNLOAD_SITE_DIR), html=False), name="download_static")

@app.get("/download")
def download_page():
    index_path = DOWNLOAD_SITE_DIR / "index.html"
    if not index_path.exists():
        return JSONResponse(status_code=404, content={"error": "Download page not found"})
    return FileResponse(str(index_path), media_type="text/html", headers={"Cache-Control": "no-store"})

@app.get("/favicon.ico")
def favicon():
    if not FAVICON_PATH.exists():
        return JSONResponse(status_code=404, content={"error": "Not found"})
    return FileResponse(str(FAVICON_PATH), media_type="image/x-icon", headers={"Cache-Control": "no-store"})

PLATFORM_KEYWORDS = {
    "windows": ["windows", "win32", "win-x64", ".exe"],
    "macos": ["macos", "mac-x64", "mac-arm64", "darwin", ".dmg", "mac"],
    "linux": ["linux", "linux-x64", "linux-arm64", ".appimage", ".deb", ".rpm"],
}

def _classify_asset(name):
    name_lower = name.lower()
    for platform, keywords in PLATFORM_KEYWORDS.items():
        if any(kw in name_lower for kw in keywords):
            return platform
    return "other"

def _format_size(size_bytes):
    if size_bytes is None:
        return ""
    if size_bytes < 1024 * 1024:
        return f"{size_bytes / 1024:.0f} KB"
    return f"{size_bytes / (1024 * 1024):.1f} MB"

@app.get("/api/releases/latest")
async def api_releases_latest():
    headers = {
        "User-Agent": "Nebula-IDE/1.0",
        "Accept": "application/vnd.github+json",
    }
    if GH_TOKEN:
        headers["Authorization"] = f"Bearer {GH_TOKEN}"

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(
                f"https://api.github.com/repos/{GITHUB_REPO}/releases/latest",
                headers=headers,
            )
            if resp.status_code == 200:
                data = resp.json()
                version = str(data.get("tag_name", "v1.0.0")).lstrip("v")
                assets = []
                for a in data.get("assets", []):
                    platform = _classify_asset(a["name"])
                    assets.append({
                        "name": a["name"],
                        "size": a["size"],
                        "size_formatted": _format_size(a["size"]),
                        "url": a["browser_download_url"],
                        "platform": platform,
                        "content_type": a.get("content_type", ""),
                    })
                return {
                    "found": True,
                    "version": version,
                    "release_name": data.get("name", f"v{version}"),
                    "release_notes": data.get("body", ""),
                    "published_at": data.get("published_at", ""),
                    "html_url": data.get("html_url", ""),
                    "assets": assets,
                    "source": "github",
                }

            return {
                "found": True,
                "version": "",
                "release_name": "",
                "release_notes": "",
                "published_at": "",
                "html_url": "",
                "assets": [],
                "source": "github",
                "message": "No releases published yet.",
            }
    except Exception as e:
        logger.warning("GitHub releases API failed: %s", e)
        return {
            "found": True,
            "version": "",
            "release_name": "",
            "release_notes": "",
            "published_at": "",
            "html_url": "",
            "assets": [],
            "source": "github",
            "message": f"Could not fetch release data.",
        }

def main():
    import uvicorn
    parser = argparse.ArgumentParser(description="Nebula IDE Backend")
    parser.add_argument("--port", type=int, default=8000, help="Port to listen on")
    parser.add_argument("--host", type=str, default="0.0.0.0", help="Host to bind to")
    parser.add_argument("--project-root", type=str, default=None,
                        help="Project root directory (default: none)")
    args = parser.parse_args()

    if args.project_root:
        set_project_root_path(args.project_root)

    set_backend_port(args.port)
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")

if __name__ == "__main__":
    main()

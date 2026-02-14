import sys
import os
import argparse
import logging

from fastapi import FastAPI
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

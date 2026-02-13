import sys
import os
import argparse

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from file_manager import router as file_router, set_project_root_path
from terminal import router as terminal_router
from ai import router as ai_router

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
    parser.add_argument("--host", type=str, default="127.0.0.1", help="Host to bind to")
    parser.add_argument("--project-root", type=str, default=None,
                        help="Project root directory (default: parent of backend/)")
    args = parser.parse_args()

    # Set project root if provided
    if args.project_root:
        set_project_root_path(args.project_root)

    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()

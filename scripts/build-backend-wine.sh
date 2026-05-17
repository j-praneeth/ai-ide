#!/bin/bash
set -e
# Build Windows backend binary on Mac via Wine

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_DIR="$PROJECT_ROOT/backend"
DIST_DIR="$PROJECT_ROOT/dist/backend"

echo "Cleaning previous backend builds..."
rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"

echo "Building Windows backend via Wine..."
cd "$BACKEND_DIR"
wine python -m PyInstaller \
    --onefile \
    --name nebula-backend \
    --distpath "$DIST_DIR" \
    --workpath "build" \
    --specpath "." \
    --add-data "agent;agent" \
    --add-data "relay_config.json;." \
    --hidden-import uvicorn \
    --hidden-import uvicorn.logging \
    --hidden-import uvicorn.loops.auto \
    --hidden-import uvicorn.protocols.http.auto \
    --hidden-import uvicorn.protocols.websockets.auto \
    --hidden-import uvicorn.lifespan.on \
    --hidden-import uvicorn.lifespan.off \
    --hidden-import fastapi \
    --hidden-import fastapi.middleware.cors \
    --hidden-import starlette.middleware.cors \
    --hidden-import multipart \
    --hidden-import requests \
    --hidden-import file_manager \
    --hidden-import terminal \
    --hidden-import ai \
    --hidden-import agent \
    --hidden-import agent.orchestrator \
    --hidden-import agent.planner \
    --hidden-import agent.executor \
    --hidden-import agent.tools \
    --hidden-import agent.indexer \
    --hidden-import agent.diff_engine \
    --hidden-import mobile_bridge \
    --hidden-import relay_client \
    --hidden-import relay_config \
    --hidden-import websockets \
    --hidden-import websockets.asyncio \
    --hidden-import websockets.asyncio.client \
    --hidden-import websockets.legacy \
    --hidden-import websockets.legacy.client \
    --hidden-import certifi \
    --hidden-import qrcode \
    --exclude-module torch \
    --exclude-module transformers \
    --exclude-module sentence_transformers \
    --exclude-module numpy \
    --exclude-module scipy \
    --exclude-module matplotlib \
    --exclude-module tkinter \
    --exclude-module pywinpty \
    main.py

rm -rf "$BACKEND_DIR/build"

echo "Done: $DIST_DIR/nebula-backend.exe"
ls -lh "$DIST_DIR/nebula-backend.exe"

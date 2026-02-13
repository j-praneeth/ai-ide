#!/bin/bash
# Build the Python backend into a standalone executable using PyInstaller
# Usage: ./scripts/build-backend.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKEND_DIR="$PROJECT_ROOT/backend"
DIST_DIR="$PROJECT_ROOT/dist/backend"

echo "╔══════════════════════════════════════════════╗"
echo "║   Nebula IDE - Building Backend              ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

# Check for Python
if command -v python3 &> /dev/null; then
    PYTHON=python3
elif command -v python &> /dev/null; then
    PYTHON=python
else
    echo "Error: Python 3 is not installed."
    exit 1
fi

echo "Using Python: $($PYTHON --version)"

# Check for PyInstaller
if ! $PYTHON -m PyInstaller --version &> /dev/null; then
    echo "PyInstaller not found. Installing..."
    $PYTHON -m pip install pyinstaller
fi

echo "Using PyInstaller: $($PYTHON -m PyInstaller --version)"

# Install backend dependencies
echo ""
echo "Installing backend dependencies..."
cd "$BACKEND_DIR"
$PYTHON -m pip install -r requirements.txt

# Clean previous build
echo ""
echo "Cleaning previous build..."
rm -rf "$DIST_DIR"
rm -rf "$BACKEND_DIR/build" "$BACKEND_DIR/dist"
mkdir -p "$DIST_DIR"

# Build with PyInstaller
echo ""
echo "Building backend executable..."
cd "$BACKEND_DIR"
$PYTHON -m PyInstaller \
    --onefile \
    --name nebula-backend \
    --distpath "$DIST_DIR" \
    --workpath "$BACKEND_DIR/build" \
    --specpath "$BACKEND_DIR" \
    --add-data "agent:agent" \
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
    --exclude-module torch \
    --exclude-module transformers \
    --exclude-module sentence_transformers \
    --exclude-module numpy \
    --exclude-module scipy \
    --exclude-module matplotlib \
    --exclude-module tkinter \
    main.py

# Clean up build artifacts
rm -rf "$BACKEND_DIR/build"

echo ""
echo "Backend built successfully!"
echo "Output: $DIST_DIR/nebula-backend"
ls -lh "$DIST_DIR/nebula-backend"

#!/bin/bash
# Full build script for Nebula IDE desktop application
# Builds the frontend, backend, and packages as .dmg (macOS) or .exe (Windows)
#
# Usage:
#   ./scripts/build-all.sh          # Build for current platform
#   ./scripts/build-all.sh mac      # Build .dmg for macOS
#   ./scripts/build-all.sh win      # Build .exe for Windows (must be on Windows or use CI)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TARGET=${1:-$(uname -s | tr '[:upper:]' '[:lower:]')}

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║   Nebula IDE - Full Desktop App Build        ║"
echo "╠══════════════════════════════════════════════╣"
echo "║   Target: $TARGET"
echo "╚══════════════════════════════════════════════╝"
echo ""

cd "$PROJECT_ROOT"

# ─── Step 1: Install root dependencies ──────────────────────────
echo "Step 1/4: Installing root dependencies..."
npm install
echo "✓ Root dependencies installed"
echo ""

# ─── Step 2: Build frontend ────────────────────────────────────
echo "Step 2/4: Building React frontend..."
cd "$PROJECT_ROOT/frontend"
npm install
CI=false npm run build
echo "✓ Frontend built"
echo ""

# ─── Step 3: Build backend ─────────────────────────────────────
echo "Step 3/4: Building Python backend..."
cd "$PROJECT_ROOT"
bash scripts/build-backend.sh
echo "✓ Backend built"
echo ""

# ─── Step 4: Package with electron-builder ─────────────────────
echo "Step 4/4: Packaging desktop application..."
cd "$PROJECT_ROOT"

case "$TARGET" in
    darwin|mac|macos)
        echo "Building macOS .dmg..."
        npx electron-builder --mac
        echo ""
        echo "✓ macOS build complete!"
        echo "  Output: release/*.dmg"
        ls -lh release/*.dmg 2>/dev/null || true
        ;;
    win|windows|win32)
        echo "Building Windows .exe installer..."
        # On macOS, we skip PyInstaller (can't cross-compile) but include backend source
        if [[ "$(uname -s)" == "Darwin" ]]; then
            echo "Note: Cross-building from macOS. Backend will use Python source + auto-setup."
            echo "      For a native PyInstaller .exe, build on Windows with: scripts\\build-backend.bat"
        fi
        npx electron-builder --win
        echo ""
        echo "✓ Windows build complete!"
        echo "  Output: release/*.exe"
        ls -lh release/*.exe 2>/dev/null || true
        ;;
    linux)
        echo "Building Linux AppImage..."
        npx electron-builder --linux
        echo ""
        echo "✓ Linux build complete!"
        echo "  Output: release/*.AppImage"
        ls -lh release/*.AppImage 2>/dev/null || true
        ;;
    *)
        echo "Building for current platform..."
        npx electron-builder
        echo ""
        echo "✓ Build complete!"
        echo "  Output: release/"
        ls -lh release/ 2>/dev/null || true
        ;;
esac

echo ""
echo "═══════════════════════════════════════════════"
echo "  Build finished! Check the release/ directory."
echo "═══════════════════════════════════════════════"

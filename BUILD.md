# Nebula IDE - Desktop Application Build Guide

## Overview

Nebula IDE can be built as a standalone desktop application for **macOS** (.dmg) and **Windows** (.exe installer). The app bundles both the React frontend and Python backend into a single distributable package using Electron + PyInstaller.

## Prerequisites

### All Platforms
- **Node.js** >= 18 (with npm)
- **Python** >= 3.9
- **PyInstaller**: `pip install pyinstaller`
- **Git** (optional, for version control features)

### macOS Specific
- **Xcode Command Line Tools**: `xcode-select --install`
- For code signing: Apple Developer Certificate (optional, for distribution)

### Windows Specific
- **Visual Studio Build Tools** or **Visual Studio** with C++ workload
- **Python** added to PATH during installation

## Quick Build

### macOS (.dmg)

```bash
# 1. Install all dependencies
npm install
cd frontend && npm install && cd ..

# 2. Build everything and package as .dmg
./scripts/build-all.sh mac
```

The `.dmg` file will be in the `release/` directory.

### Windows (.exe)

```batch
REM 1. Install all dependencies
npm install
cd frontend && npm install && cd ..

REM 2. Build backend
scripts\build-backend.bat

REM 3. Build frontend
cd frontend && npm run build && cd ..

REM 4. Package as .exe installer
npx electron-builder --win
```

The `.exe` installer will be in the `release/` directory.

## Step-by-Step Build

### Step 1: Install Root Dependencies

```bash
npm install
```

This installs Electron, electron-builder, and dev utilities.

### Step 2: Install Frontend Dependencies

```bash
cd frontend
npm install
cd ..
```

### Step 3: Build the React Frontend

```bash
cd frontend
npm run build
cd ..
```

This creates a production build in `frontend/build/`.

### Step 4: Build the Python Backend

**macOS / Linux:**
```bash
./scripts/build-backend.sh
```

**Windows:**
```batch
scripts\build-backend.bat
```

This creates a standalone executable in `dist/backend/`:
- macOS: `dist/backend/nebula-backend`
- Windows: `dist/backend/nebula-backend.exe`

### Step 5: Package the Desktop App

**macOS (.dmg):**
```bash
npx electron-builder --mac
```

**Windows (.exe installer):**
```bash
npx electron-builder --win
```

Output will be in the `release/` directory.

## Development Mode

To run in development mode (with hot-reloading):

```bash
# Terminal 1: Start the Python backend
cd backend && python3 main.py --port 8000

# Terminal 2: Start the React dev server
cd frontend && npm start

# Terminal 3: Start Electron (after frontend is ready)
ELECTRON_DEV=true npx electron .
```

Or use the combined command:
```bash
npm start
```

## Project Structure

```
ai-ide/
├── electron/                 # Electron main process
│   ├── main.js              # App lifecycle, backend management
│   └── preload.js           # Secure bridge to renderer
├── frontend/                # React frontend
│   ├── src/
│   │   ├── config.js        # Dynamic API URL configuration
│   │   ├── App.js           # Main application
│   │   └── components/      # UI components
│   └── build/               # Production build (generated)
├── backend/                 # Python FastAPI backend
│   ├── main.py              # Entry point with CLI args
│   ├── terminal.py          # Cross-platform terminal
│   ├── file_manager.py      # File operations
│   ├── ai.py                # AI chat endpoints
│   └── agent/               # AI agent system
├── assets/                  # Build assets
│   ├── icons/               # App icons (.icns, .ico, .png)
│   └── entitlements.mac.plist
├── scripts/                 # Build scripts
│   ├── build-all.sh         # Full macOS build
│   ├── build-backend.sh     # Backend build (macOS/Linux)
│   └── build-backend.bat    # Backend build (Windows)
├── package.json             # Root: Electron + build config
├── dist/                    # Backend executable (generated)
└── release/                 # Final .dmg/.exe (generated)
```

## Architecture

```
┌──────────────────────────────┐
│      Electron Main Process   │
│  ┌─────────────────────────┐ │
│  │  Spawn Python Backend   │ │
│  │  (dynamic port)         │ │
│  └─────────────────────────┘ │
│  ┌─────────────────────────┐ │
│  │  BrowserWindow          │ │
│  │  (loads React app)      │ │
│  └─────────────────────────┘ │
└──────────────────────────────┘
         ↕ HTTP/SSE
┌──────────────────────────────┐
│     Python Backend           │
│  (FastAPI + Uvicorn)         │
│  - File operations           │
│  - Terminal (cross-platform) │
│  - AI Agent (Ollama)         │
└──────────────────────────────┘
```

## App Icons

Place your app icons in `assets/icons/`:
- `icon.icns` - macOS (1024x1024)
- `icon.ico` - Windows (256x256)
- `icon.png` - Linux/fallback (512x512)

You can generate these from a single PNG using tools like:
- [electron-icon-maker](https://www.npmjs.com/package/electron-icon-maker)
- [iconutil](https://developer.apple.com/library/archive/documentation/GraphicsAnimation/Conceptual/HighResolutionOSX/Optimizing/Optimizing.html) (macOS)

## Code Signing (Optional)

### macOS
For distribution outside the Mac App Store:
1. Get an Apple Developer ID certificate
2. Set environment variables:
   ```bash
   export CSC_LINK=/path/to/certificate.p12
   export CSC_KEY_PASSWORD=your_password
   ```
3. For notarization:
   ```bash
   export APPLE_ID=your@apple.id
   export APPLE_APP_SPECIFIC_PASSWORD=xxxx-xxxx-xxxx-xxxx
   ```

### Windows
For signed installers:
1. Get a code signing certificate (.pfx)
2. Set environment variable:
   ```bash
   export WIN_CSC_LINK=/path/to/certificate.pfx
   export WIN_CSC_KEY_PASSWORD=your_password
   ```

## Troubleshooting

### Backend fails to start
- Ensure Python 3.9+ is installed and in PATH
- Install backend dependencies: `cd backend && pip install -r requirements.txt`
- Check if port is in use: `lsof -i :8000` (macOS) or `netstat -ano | findstr :8000` (Windows)

### PyInstaller build fails
- Install PyInstaller: `pip install pyinstaller`
- On macOS with Apple Silicon, ensure you're using the correct architecture
- Try: `pip install --upgrade pyinstaller`

### Frontend build fails
- Ensure Node.js 18+ is installed
- Try: `cd frontend && rm -rf node_modules && npm install`

### AI features not working
- Ollama must be installed and running separately: https://ollama.ai
- Pull a model: `ollama pull qwen2.5-coder:7b`
- The IDE works without AI - only AI chat features require Ollama

@echo off
REM Build the Python backend into a standalone executable using PyInstaller
REM Usage: scripts\build-backend.bat

echo ================================================
echo   Nebula IDE - Building Backend (Windows)
echo ================================================
echo.

set PROJECT_ROOT=%~dp0..
set BACKEND_DIR=%PROJECT_ROOT%\backend
set DIST_DIR=%PROJECT_ROOT%\dist\backend

REM Check for Python
where python >nul 2>nul
if %errorlevel% neq 0 (
    echo Error: Python is not installed or not in PATH.
    exit /b 1
)

python --version

REM Check for PyInstaller
python -m PyInstaller --version >nul 2>nul
if %errorlevel% neq 0 (
    echo PyInstaller not found. Installing...
    python -m pip install pyinstaller
)

REM Install backend dependencies
echo.
echo Installing backend dependencies...
cd /d "%BACKEND_DIR%"
python -m pip install -r requirements.txt

REM Clean previous build
echo.
echo Cleaning previous build...
if exist "%DIST_DIR%" rmdir /s /q "%DIST_DIR%"
if exist "%BACKEND_DIR%\build" rmdir /s /q "%BACKEND_DIR%\build"
if exist "%BACKEND_DIR%\dist" rmdir /s /q "%BACKEND_DIR%\dist"
mkdir "%DIST_DIR%"

REM Build with PyInstaller
echo.
echo Building backend executable...
cd /d "%BACKEND_DIR%"
python -m PyInstaller ^
    --onefile ^
    --name nebula-backend ^
    --distpath "%DIST_DIR%" ^
    --workpath "%BACKEND_DIR%\build" ^
    --specpath "%BACKEND_DIR%" ^
    --add-data "agent;agent" ^
    --hidden-import uvicorn ^
    --hidden-import uvicorn.logging ^
    --hidden-import uvicorn.loops.auto ^
    --hidden-import uvicorn.protocols.http.auto ^
    --hidden-import uvicorn.protocols.websockets.auto ^
    --hidden-import uvicorn.lifespan.on ^
    --hidden-import uvicorn.lifespan.off ^
    --hidden-import fastapi ^
    --hidden-import fastapi.middleware.cors ^
    --hidden-import starlette.middleware.cors ^
    --hidden-import multipart ^
    --hidden-import requests ^
    --hidden-import file_manager ^
    --hidden-import terminal ^
    --hidden-import ai ^
    --hidden-import agent ^
    --hidden-import agent.orchestrator ^
    --hidden-import agent.planner ^
    --hidden-import agent.executor ^
    --hidden-import agent.tools ^
    --hidden-import agent.indexer ^
    --hidden-import agent.diff_engine ^
    --exclude-module torch ^
    --exclude-module transformers ^
    --exclude-module sentence_transformers ^
    --exclude-module numpy ^
    --exclude-module scipy ^
    --exclude-module matplotlib ^
    --exclude-module tkinter ^
    main.py

REM Clean up build artifacts
if exist "%BACKEND_DIR%\build" rmdir /s /q "%BACKEND_DIR%\build"

echo.
echo Backend built successfully!
echo Output: %DIST_DIR%\nebula-backend.exe
dir "%DIST_DIR%\nebula-backend.exe"

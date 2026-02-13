const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const http = require('http');

// Keep a global reference of the window object
let mainWindow = null;
let backendProcess = null;
let backendPort = null;

// Determine if we're in development or production
const isDev = process.env.ELECTRON_DEV === 'true' || !app.isPackaged;

/**
 * Find a free port on localhost
 */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

/**
 * Get the path to the Python backend executable
 */
function getBackendPath() {
  if (isDev) {
    // In development, use python directly
    return null; // Will use python command
  }

  // In production, use the bundled PyInstaller executable
  const platform = process.platform;
  const resourcesPath = process.resourcesPath;

  if (platform === 'darwin') {
    return path.join(resourcesPath, 'backend', 'nebula-backend');
  } else if (platform === 'win32') {
    return path.join(resourcesPath, 'backend', 'nebula-backend.exe');
  } else {
    return path.join(resourcesPath, 'backend', 'nebula-backend');
  }
}

/**
 * Start the Python backend server
 */
async function startBackend(port) {
  return new Promise((resolve, reject) => {
    const backendPath = getBackendPath();
    let args;
    let command;

    // Default project root to user's home directory for fresh start
    const defaultProjectRoot = app.getPath('home');

    if (isDev) {
      // Development: run with python
      const backendDir = path.join(__dirname, '..', 'backend');
      command = process.platform === 'win32' ? 'python' : 'python3';
      args = [
        path.join(backendDir, 'main.py'),
        '--port', port.toString(),
        '--host', '127.0.0.1',
        '--project-root', defaultProjectRoot,
      ];
    } else {
      // Production: run bundled executable
      command = backendPath;
      args = [
        '--port', port.toString(),
        '--host', '127.0.0.1',
        '--project-root', defaultProjectRoot,
      ];
    }

    console.log(`Starting backend: ${command} ${args.join(' ')}`);

    backendProcess = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
      // Set cwd to backend directory in dev mode
      cwd: isDev ? path.join(__dirname, '..', 'backend') : undefined,
    });

    backendProcess.stdout.on('data', (data) => {
      console.log(`[Backend] ${data.toString().trim()}`);
    });

    backendProcess.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      console.log(`[Backend] ${msg}`);
      // Uvicorn prints startup message to stderr
      if (msg.includes('Application startup complete') || msg.includes('Uvicorn running on')) {
        resolve();
      }
    });

    backendProcess.on('error', (err) => {
      console.error('Failed to start backend:', err);
      reject(err);
    });

    backendProcess.on('exit', (code) => {
      console.log(`Backend process exited with code ${code}`);
      backendProcess = null;
    });

    // Also poll the health endpoint as a fallback
    const startTime = Date.now();
    const maxWait = 30000; // 30 seconds max

    const pollHealth = () => {
      if (Date.now() - startTime > maxWait) {
        reject(new Error('Backend failed to start within 30 seconds'));
        return;
      }

      const req = http.get(`http://127.0.0.1:${port}/health`, (res) => {
        if (res.statusCode === 200) {
          resolve();
        } else {
          setTimeout(pollHealth, 500);
        }
      });

      req.on('error', () => {
        setTimeout(pollHealth, 500);
      });

      req.setTimeout(2000, () => {
        req.destroy();
        setTimeout(pollHealth, 500);
      });
    };

    // Start polling after a short delay
    setTimeout(pollHealth, 1000);
  });
}

/**
 * Stop the backend server
 */
function stopBackend() {
  if (backendProcess) {
    console.log('Stopping backend...');
    if (process.platform === 'win32') {
      // On Windows, use taskkill to kill the process tree
      spawn('taskkill', ['/pid', backendProcess.pid.toString(), '/f', '/t']);
    } else {
      backendProcess.kill('SIGTERM');
      // Force kill after 5 seconds if still running
      setTimeout(() => {
        if (backendProcess) {
          try { backendProcess.kill('SIGKILL'); } catch (e) { /* ignore */ }
        }
      }, 5000);
    }
    backendProcess = null;
  }
}

/**
 * Create the main application window
 */
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    title: 'Nebula IDE',
    backgroundColor: '#08090d',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    frame: process.platform !== 'darwin', // Frameless on macOS for native feel
    trafficLightPosition: { x: 12, y: 12 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
    icon: getAppIcon(),
    show: false, // Don't show until ready
  });

  // Load the React app
  if (isDev) {
    // In development, load from the CRA dev server
    mainWindow.loadURL('http://localhost:3000');
    // Open DevTools in dev mode
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    // In production, load the built React app
    const indexPath = path.join(__dirname, '..', 'frontend', 'build', 'index.html');
    mainWindow.loadFile(indexPath);
  }

  // Show window when ready to prevent white flash
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  // Handle external links
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/**
 * Get the app icon path
 */
function getAppIcon() {
  const iconDir = path.join(__dirname, '..', 'assets', 'icons');
  if (process.platform === 'darwin') {
    const icnsPath = path.join(iconDir, 'icon.icns');
    return fs.existsSync(icnsPath) ? icnsPath : undefined;
  } else if (process.platform === 'win32') {
    const icoPath = path.join(iconDir, 'icon.ico');
    return fs.existsSync(icoPath) ? icoPath : undefined;
  } else {
    const pngPath = path.join(iconDir, 'icon.png');
    return fs.existsSync(pngPath) ? pngPath : undefined;
  }
}

// ─── IPC Handlers ─────────────────────────────────────────────

ipcMain.handle('get-api-url', () => {
  return `http://127.0.0.1:${backendPort}`;
});

ipcMain.handle('get-platform', () => {
  return process.platform;
});

ipcMain.handle('open-folder-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Open Folder',
  });
  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths[0];
  }
  return null;
});

// ─── App Lifecycle ────────────────────────────────────────────

app.whenReady().then(async () => {
  try {
    // Find a free port for the backend
    backendPort = await findFreePort();
    console.log(`Using port ${backendPort} for backend`);

    // Start the Python backend
    await startBackend(backendPort);
    console.log('Backend started successfully');

    // Create the main window
    createWindow();
  } catch (err) {
    console.error('Failed to start application:', err);
    dialog.showErrorBox(
      'Nebula IDE - Startup Error',
      `Failed to start the backend server.\n\n${err.message}\n\nMake sure Python 3 and the required packages are installed.`
    );
    app.quit();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  stopBackend();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  stopBackend();
});

app.on('will-quit', () => {
  stopBackend();
});

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  stopBackend();
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});

const { app, BrowserWindow, dialog, ipcMain, shell, Menu } = require('electron');
const path = require('path');
const { spawn, execSync, execFile } = require('child_process');
const net = require('net');
const fs = require('fs');
const http = require('http');
const https = require('https');
const pty = require('node-pty');

// Keep a global reference of the window object
let mainWindow = null;
let backendProcess = null;
let backendPort = null;
let splashWindow = null;
let cliSessionCounter = 0;
const cliSessions = new Map();

// Determine if we're in development or production
const isDev = process.env.ELECTRON_DEV === 'true' || !app.isPackaged;

// Paths
const userDataPath = app.getPath('userData');
const embeddedPythonDir = path.join(userDataPath, 'python');

function loadDotEnvFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return;
    const raw = fs.readFileSync(filePath, 'utf-8');
    const lines = raw.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = (line || '').trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx <= 0) continue;
      const key = trimmed.slice(0, idx).trim();
      let value = trimmed.slice(idx + 1).trim();
      if (!key) continue;
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch (_) {}
}

loadDotEnvFile(path.join(__dirname, '..', 'backend', '.env'));
loadDotEnvFile(path.join(__dirname, '..', 'backend-src', '.env'));
const CLI_SPECS = [
  { label: 'Claude CLI', command: 'claude', packageName: '@anthropic-ai/claude-code' },
  { label: 'Codex CLI', command: 'codex', packageName: '@openai/codex' },
];

if (process.platform === 'win32') {
  CLI_SPECS.push(
    { label: 'PowerShell', command: 'powershell', file: 'powershell.exe', args: ['-NoLogo'] },
    { label: 'Command Prompt', command: 'cmd', file: 'cmd.exe', args: [] },
  );
}

// ─── Utility: Find a free port ──────────────────────────────────

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

function getPathKey(env = process.env) {
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path');
  return pathKey || 'PATH';
}

function prependToPath(dir, env = process.env) {
  if (!dir) return;
  const pathKey = getPathKey(env);
  const current = env[pathKey] || '';
  const parts = current.split(path.delimiter).filter(Boolean);
  if (!parts.includes(dir)) {
    env[pathKey] = [dir, ...parts].join(path.delimiter);
  }
}

function getNpmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function runFile(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { ...options, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
    return child;
  });
}

function getNpmGlobalBinDir() {
  try {
    const npmCommand = getNpmCommand();
    const prefix = execSync(`"${npmCommand}" config get prefix`, {
      encoding: 'utf-8',
      timeout: 10000,
      windowsHide: true,
    }).trim();

    if (!prefix) return null;
    return process.platform === 'win32' ? prefix : path.join(prefix, 'bin');
  } catch (_) {
    return null;
  }
}

function commandExists(command) {
  try {
    if (process.platform === 'win32') {
      execSync(`where ${command}`, {
        stdio: 'pipe',
        timeout: 5000,
        windowsHide: true,
        env: { ...process.env },
      });
    } else {
      execSync(`command -v ${command}`, {
        stdio: 'pipe',
        timeout: 5000,
        windowsHide: true,
        env: { ...process.env },
      });
    }
    return true;
  } catch (_) {
    return false;
  }
}

function resolveCommandPath(command) {
  try {
    if (process.platform === 'win32') {
      const output = execSync(`where ${command}`, {
        stdio: 'pipe',
        timeout: 5000,
        windowsHide: true,
        env: { ...process.env },
        encoding: 'utf-8',
      }).trim();
      return output.split(/\r?\n/).find(Boolean) || null;
    }

    const output = execSync(`command -v ${command}`, {
      stdio: 'pipe',
      timeout: 5000,
      windowsHide: true,
      env: { ...process.env },
      encoding: 'utf-8',
    }).trim();
    return output || null;
  } catch (_) {
    return null;
  }
}

function findGitBash() {
  if (process.platform !== 'win32') return null;

  const candidates = [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'usr', 'bin', 'bash.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
  ];

  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function getCliLaunchConfig(tool) {
  const spec = CLI_SPECS.find((item) => item.command === tool) || CLI_SPECS[0];

  // If it's a direct shell request (powershell/cmd)
  if (tool === 'powershell' || tool === 'cmd') {
    return {
      installed: true,
      label: spec.label,
      shellLabel: tool,
      file: spec.file,
      args: spec.args || [],
    };
  }

  const commandPath = resolveCommandPath(spec.command);
  const npmBin = getNpmGlobalBinDir();
  if (npmBin) {
    prependToPath(npmBin, process.env);
  }

  if (!commandPath && !commandExists(spec.command)) {
    return {
      installed: false,
      label: spec.label,
      packageName: spec.packageName,
      shellLabel: process.platform === 'win32' ? 'powershell' : 'shell',
    };
  }

  if (process.platform === 'win32' && tool === 'claude') {
    const gitBash = findGitBash();
    if (gitBash) {
      return {
        installed: true,
        label: spec.label,
        shellLabel: 'git-bash',
        file: gitBash,
        args: ['-lc', 'claude'],
      };
    }
  }

  return {
    installed: true,
    label: spec.label,
    shellLabel: process.platform === 'win32' ? 'powershell' : 'shell',
    file: commandPath || spec.command,
    args: [],
  };
}

function closeCliSession(sessionId) {
  const session = cliSessions.get(sessionId);
  if (!session) return;

  try {
    session.ptyProcess.kill();
  } catch (_) {}
  cliSessions.delete(sessionId);
}

async function ensureCliToolsInstalled() {
  updateSplash('Checking Claude and Codex CLI tools...');
  const npmBin = getNpmGlobalBinDir();
  if (npmBin) {
    prependToPath(npmBin, process.env);
  }

  let npmAvailable = true;
  try {
    await runFile(getNpmCommand(), ['--version'], { timeout: 10000, env: { ...process.env } });
  } catch (_) {
    npmAvailable = false;
  }

  for (const cli of CLI_SPECS) {
    if (!cli.packageName) continue;
    if (commandExists(cli.command)) {
      console.log(`${cli.label} already installed`);
      continue;
    }

    if (!npmAvailable) {
      console.warn(`Skipping ${cli.label} install because npm is unavailable`);
      continue;
    }

    updateSplash(`Installing ${cli.label}...`);
    console.log(`Installing ${cli.label} using ${cli.packageName}`);
    try {
      await runFile(getNpmCommand(), ['install', '-g', cli.packageName], {
        timeout: 300000,
        env: { ...process.env },
      });
    } catch (err) {
      console.error(`Failed to install ${cli.label}:`, err.stderr || err.message);
      continue;
    }

    const refreshedBin = getNpmGlobalBinDir();
    if (refreshedBin) {
      prependToPath(refreshedBin, process.env);
    }
  }
}

// ─── Splash Screen (shows during setup) ─────────────────────────

function createSplashWindow(message) {
  splashWindow = new BrowserWindow({
    width: 420,
    height: 260,
    frame: false,
    transparent: false,
    resizable: false,
    center: true,
    backgroundColor: '#08090d',
    webPreferences: { nodeIntegration: false, contextIsolation: true },
    icon: getAppIcon(),
  });

  const html = `<!DOCTYPE html>
<html><head><style>
  body { margin: 0; background: #08090d; color: #e0e0e0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
         display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; }
  .logo { font-size: 48px; margin-bottom: 16px; }
  h1 { font-size: 20px; font-weight: 600; margin: 0 0 12px 0; color: #fff; }
  p { font-size: 13px; color: #888; margin: 0; }
  .spinner { width: 24px; height: 24px; border: 2px solid #333; border-top: 2px solid #818cf8;
             border-radius: 50%; animation: spin 0.8s linear infinite; margin-top: 20px; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style></head><body>
  <div class="logo">✦</div>
  <h1>Nebula IDE</h1>
  <p id="msg">${message || 'Starting...'}</p>
  <div class="spinner"></div>
</body></html>`;

  splashWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

function updateSplash(message) {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.webContents.executeJavaScript(
      `document.getElementById('msg').textContent = ${JSON.stringify(message)};`
    ).catch(() => {});
  }
}

function closeSplash() {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.close();
    splashWindow = null;
  }
}

// ─── Python Detection ───────────────────────────────────────────

function findSystemPython() {
  const candidates = process.platform === 'win32'
    ? ['python', 'python3', 'py -3']
    : ['python3', 'python'];

  for (const cmd of candidates) {
    try {
      const version = execSync(`${cmd} --version 2>&1`, { encoding: 'utf-8', timeout: 5000 }).trim();
      if (version.includes('Python 3')) {
        console.log(`Found system Python: ${cmd} (${version})`);
        return cmd.split(' ')[0]; // return just the command
      }
    } catch (_) {}
  }
  return null;
}

function getEmbeddedPython() {
  if (process.platform === 'win32') {
    const pythonExe = path.join(embeddedPythonDir, 'python.exe');
    if (fs.existsSync(pythonExe)) return pythonExe;
  }
  return null;
}

// ─── Embedded Python Download (Windows) ─────────────────────────

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const get = url.startsWith('https') ? https.get : http.get;

    const request = (targetUrl) => {
      get(targetUrl, (response) => {
        // Handle redirects
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          request(response.headers.location);
          return;
        }
        if (response.statusCode !== 200) {
          reject(new Error(`Download failed with status ${response.statusCode}`));
          return;
        }
        response.pipe(file);
        file.on('finish', () => file.close(resolve));
      }).on('error', (err) => {
        fs.unlink(dest, () => {});
        reject(err);
      });
    };

    request(url);
  });
}

async function setupEmbeddedPython() {
  if (process.platform !== 'win32') return null;

  const pythonExe = getEmbeddedPython();
  if (pythonExe) return pythonExe;

  console.log('Setting up embedded Python for Windows...');
  updateSplash('Setting up Python (first-time only)...');

  const zipUrl = 'https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-amd64.zip';
  const pipUrl = 'https://bootstrap.pypa.io/get-pip.py';
  const zipPath = path.join(userDataPath, 'python-embed.zip');
  const getPipPath = path.join(userDataPath, 'get-pip.py');

  try {
    // Create directory
    fs.mkdirSync(embeddedPythonDir, { recursive: true });

    // Download Python embeddable
    updateSplash('Downloading Python runtime...');
    await downloadFile(zipUrl, zipPath);

    // Extract zip
    updateSplash('Extracting Python...');
    // Use PowerShell to extract on Windows
    execSync(
      `powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${embeddedPythonDir}' -Force"`,
      { timeout: 60000 }
    );

    // Enable pip: uncomment "import site" in python311._pth
    const pthFile = path.join(embeddedPythonDir, 'python311._pth');
    if (fs.existsSync(pthFile)) {
      let content = fs.readFileSync(pthFile, 'utf-8');
      content = content.replace(/^#\s*import site/m, 'import site');
      // Also add Lib\site-packages to the path
      if (!content.includes('Lib\\site-packages')) {
        content += '\nLib\\site-packages\n';
      }
      fs.writeFileSync(pthFile, content);
    }

    // Download get-pip.py
    updateSplash('Installing pip...');
    await downloadFile(pipUrl, getPipPath);

    // Install pip
    const newPythonExe = path.join(embeddedPythonDir, 'python.exe');
    execSync(`"${newPythonExe}" "${getPipPath}" --no-warn-script-location`, {
      timeout: 120000,
      cwd: embeddedPythonDir,
    });

    // Cleanup
    try { fs.unlinkSync(zipPath); } catch (_) {}
    try { fs.unlinkSync(getPipPath); } catch (_) {}

    console.log('Embedded Python setup complete');
    return newPythonExe;
  } catch (err) {
    console.error('Failed to setup embedded Python:', err);
    // Cleanup on failure
    try { fs.rmSync(embeddedPythonDir, { recursive: true, force: true }); } catch (_) {}
    try { fs.unlinkSync(zipPath); } catch (_) {}
    return null;
  }
}

// ─── Install Python dependencies ────────────────────────────────

function installDependencies(pythonCmd, backendSourceDir) {
  const reqFile = path.join(backendSourceDir, 'requirements.txt');
  if (!fs.existsSync(reqFile)) return;

  // Check if deps already installed by testing a key import
  try {
    execSync(`"${pythonCmd}" -c "import fastapi; import uvicorn"`, {
      timeout: 10000,
      stdio: 'pipe',
    });
    console.log('Dependencies already installed');
    return;
  } catch (_) {
    // Need to install
  }

  console.log('Installing Python dependencies...');
  updateSplash('Installing dependencies (first-time only)...');

  try {
    execSync(
      `"${pythonCmd}" -m pip install --no-warn-script-location -r "${reqFile}"`,
      { timeout: 300000, stdio: 'pipe' }
    );
    console.log('Dependencies installed successfully');
  } catch (err) {
    console.error('Failed to install dependencies:', err.message);
    throw new Error('Failed to install Python dependencies. Check your internet connection.');
  }
}

// ─── Backend Path Resolution ────────────────────────────────────

function getBundledBackendExe() {
  if (isDev) return null;

  const resourcesPath = process.resourcesPath;
  let exePath;

  if (process.platform === 'darwin') {
    exePath = path.join(resourcesPath, 'backend', 'nebula-backend');
  } else if (process.platform === 'win32') {
    exePath = path.join(resourcesPath, 'backend', 'nebula-backend.exe');
  } else {
    exePath = path.join(resourcesPath, 'backend', 'nebula-backend');
  }

  if (fs.existsSync(exePath)) {
    console.log('Found bundled backend at:', exePath);
    return exePath;
  }

  console.log('Bundled backend not found at:', exePath);
  return null;
}

function getBackendSourceDir() {
  if (isDev) {
    return path.join(__dirname, '..', 'backend');
  }
  // In production, backend source is in extraResources
  const srcDir = path.join(process.resourcesPath, 'backend-src');
  if (fs.existsSync(srcDir)) return srcDir;
  // Fallback: check if it's in the backend folder
  const altDir = path.join(process.resourcesPath, 'backend');
  if (fs.existsSync(path.join(altDir, 'main.py'))) return altDir;
  return null;
}

// ─── Start Backend ──────────────────────────────────────────────

async function startBackend(port) {
  return new Promise(async (resolve, reject) => {
    const defaultProjectRoot = app.getPath('home');
    let command, args, cwd;

    // ─── Strategy 1: Bundled PyInstaller executable ───────────
    const bundledExe = getBundledBackendExe();
    if (bundledExe) {
      console.log('Using bundled PyInstaller backend');
      command = bundledExe;
      args = ['--port', port.toString(), '--host', '0.0.0.0', '--project-root', defaultProjectRoot];
      cwd = undefined;
    } else {
      // ─── Strategy 2: Find or setup Python ───────────────────
      let pythonCmd = null;
      const backendSourceDir = getBackendSourceDir();

      if (!backendSourceDir) {
        return reject(new Error('Backend source files not found. The installation may be corrupted.'));
      }

      // Try system Python first
      pythonCmd = findSystemPython();

      // If no system Python on Windows, download embedded Python
      if (!pythonCmd) {
        if (process.platform === 'win32') {
          updateSplash('Setting up Python (one-time setup)...');
          pythonCmd = await setupEmbeddedPython();
        }

        if (!pythonCmd) {
          const msg = process.platform === 'win32'
            ? 'Python setup failed. Please install Python 3.11+ from python.org and restart the app.'
            : 'Python 3 is required. Please install it:\n\n' +
              (process.platform === 'darwin'
                ? '  brew install python3\n  or download from python.org'
                : '  sudo apt install python3 python3-pip');
          return reject(new Error(msg));
        }
      }

      // Install dependencies if needed
      try {
        installDependencies(pythonCmd, backendSourceDir);
      } catch (err) {
        return reject(err);
      }

      console.log(`Using Python: ${pythonCmd} with source: ${backendSourceDir}`);
      command = pythonCmd;
      args = [
        path.join(backendSourceDir, 'main.py'),
        '--port', port.toString(),
        '--host', '0.0.0.0',
        '--project-root', defaultProjectRoot,
      ];
      cwd = backendSourceDir;
    }

    console.log(`Starting backend: ${command} ${args.join(' ')}`);
    updateSplash('Starting IDE...');

    backendProcess = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
      cwd: cwd,
    });

    backendProcess.stdout.on('data', (data) => {
      console.log(`[Backend] ${data.toString().trim()}`);
    });

    backendProcess.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      console.log(`[Backend] ${msg}`);
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

    // Poll health endpoint as fallback
    const startTime = Date.now();
    const maxWait = 60000; // 60 seconds (more time for first-run setup)

    const pollHealth = () => {
      if (Date.now() - startTime > maxWait) {
        reject(new Error('Backend failed to start within 60 seconds'));
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

    setTimeout(pollHealth, 1500);
  });
}

// ─── Stop Backend ───────────────────────────────────────────────

function stopBackend() {
  if (backendProcess) {
    console.log('Stopping backend...');
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', backendProcess.pid.toString(), '/f', '/t']);
    } else {
      backendProcess.kill('SIGTERM');
      setTimeout(() => {
        if (backendProcess) {
          try { backendProcess.kill('SIGKILL'); } catch (e) { /* ignore */ }
        }
      }, 5000);
    }
    backendProcess = null;
  }
}

// ─── Create Main Window ─────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    title: 'Nebula IDE',
    backgroundColor: '#08090d',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    frame: process.platform !== 'darwin',
    autoHideMenuBar: true,
    trafficLightPosition: { x: 12, y: 12 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
    icon: getAppIcon(),
    show: false,
  });

  try {
    Menu.setApplicationMenu(null);
  } catch (_) {}
  try {
    mainWindow.setMenuBarVisibility(false);
    mainWindow.setMenu(null);
  } catch (_) {}

  if (isDev) {
    mainWindow.loadURL('http://localhost:3000');
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    const indexPath = path.join(__dirname, '..', 'frontend', 'build', 'index.html');
    mainWindow.loadFile(indexPath);
  }

  mainWindow.once('ready-to-show', () => {
    closeSplash();
    mainWindow.show();
    mainWindow.focus();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ─── App Icon ───────────────────────────────────────────────────

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

// ─── IPC Handlers ───────────────────────────────────────────────

ipcMain.handle('get-api-url', () => {
  return `http://127.0.0.1:${backendPort}`;
});

ipcMain.handle('get-auth-url', () => {
  const isProduction = !isDev && app.isPackaged;
  const productionUrl = process.env.NEBULA_AUTH_URL || 'https://api.nebula-ide.com';
  const developmentUrl = process.env.NEBULA_AUTH_URL_DEV || `http://127.0.0.1:${backendPort}`;
  return isProduction ? productionUrl : developmentUrl;
});

ipcMain.on('get-url-config-sync', (event) => {
  const apiUrl = `http://127.0.0.1:${backendPort}`;
  const isProduction = !isDev && app.isPackaged;
  const productionAuthUrl = process.env.NEBULA_AUTH_URL || 'https://api.nebula-ide.com';
  const developmentAuthUrl = process.env.NEBULA_AUTH_URL_DEV || apiUrl;
  const authUrl = isProduction ? productionAuthUrl : developmentAuthUrl;
  event.returnValue = { apiUrl, authUrl, isProduction };
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

ipcMain.handle('cli:start', (event, tool = 'claude') => {
  const launch = getCliLaunchConfig(tool);

  if (!launch.installed) {
    return {
      ok: false,
      installed: false,
      message: `${launch.label} is not installed. Run: npm install -g ${launch.packageName}`,
      shell: launch.shellLabel,
    };
  }

  const sessionId = `cli-${++cliSessionCounter}`;
  const env = { ...process.env, TERM: 'xterm-256color' };
  const ptyProcess = pty.spawn(launch.file, launch.args, {
    name: 'xterm-color',
    cols: 120,
    rows: 32,
    cwd: app.getPath('home'),
    env,
  });

  cliSessions.set(sessionId, {
    ptyProcess,
    sender: event.sender,
  });

  ptyProcess.onData((data) => {
    if (!event.sender.isDestroyed()) {
      event.sender.send('cli:data', { sessionId, data });
    }
    // Also relay to backend for mobile companion
    if (backendPort) {
      const postData = JSON.stringify({ sessionId, data });
      const req = http.request({
        hostname: '127.0.0.1',
        port: backendPort,
        path: '/terminal/cli/data',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
        },
      });
      req.on('error', () => {});
      req.write(postData);
      req.end();
    }
  });

  ptyProcess.onExit((exitEvent) => {
    if (!event.sender.isDestroyed()) {
      event.sender.send('cli:exit', { sessionId, ...exitEvent });
    }
    cliSessions.delete(sessionId);
  });

  return {
    ok: true,
    installed: true,
    sessionId,
    shell: launch.shellLabel,
  };
});

ipcMain.handle('cli:write', (event, sessionId, data) => {
  const session = cliSessions.get(sessionId);
  if (!session) return { ok: false };
  session.ptyProcess.write(data);
  return { ok: true };
});

ipcMain.handle('cli:resize', (event, sessionId, cols, rows) => {
  const session = cliSessions.get(sessionId);
  if (!session) return { ok: false };
  try {
    session.ptyProcess.resize(Math.max(20, cols || 80), Math.max(10, rows || 24));
  } catch (_) {}
  return { ok: true };
});

ipcMain.handle('cli:close', (event, sessionId) => {
  closeCliSession(sessionId);
  return { ok: true };
});

// ─── App Lifecycle ──────────────────────────────────────────────

app.whenReady().then(async () => {
  try {
    // Show splash screen
    createSplashWindow('Starting IDE...');

    // Ensure the CLI tools exist before the backend/terminal sessions use them.
    await ensureCliToolsInstalled();

    // Find a free port
    backendPort = await findFreePort();
    console.log(`Using port ${backendPort} for backend`);

    // Start the backend (handles all Python detection/setup)
    await startBackend(backendPort);
    console.log('Backend started successfully');

    // Create the main window
    createWindow();

    // Start screen streaming for mobile companion
    setTimeout(() => {
      startScreenStream();
      startRemoteInputPoller();
    }, 3000);
  } catch (err) {
    console.error('Failed to start application:', err);
    closeSplash();

    const choice = dialog.showMessageBoxSync({
      type: 'error',
      title: 'Nebula IDE - Startup Error',
      message: 'Failed to start the backend server.',
      detail: err.message,
      buttons: process.platform === 'win32'
        ? ['Download Python', 'Retry', 'Quit']
        : ['Retry', 'Quit'],
    });

    if (process.platform === 'win32' && choice === 0) {
      shell.openExternal('https://www.python.org/downloads/');
      app.quit();
    } else if (
      (process.platform === 'win32' && choice === 1) ||
      (process.platform !== 'win32' && choice === 0)
    ) {
      // Retry
      app.relaunch();
      app.quit();
    } else {
      app.quit();
    }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  for (const sessionId of cliSessions.keys()) {
    closeCliSession(sessionId);
  }
  stopScreenStream();
  stopBackend();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  for (const sessionId of cliSessions.keys()) {
    closeCliSession(sessionId);
  }
  stopScreenStream();
  stopBackend();
});

app.on('will-quit', () => {
  for (const sessionId of cliSessions.keys()) {
    closeCliSession(sessionId);
  }
  stopScreenStream();
  stopBackend();
});

// ─── Screen Streaming to Mobile ─────────────────────────────────

let streamInterval = null;
let isStreaming = false;
let pendingRemoteInputs = [];

function startScreenStream() {
  if (isStreaming || !mainWindow) return;
  isStreaming = true;
  console.log('Screen streaming started');

  streamInterval = setInterval(async () => {
    if (!mainWindow || mainWindow.isDestroyed() || !backendPort) return;

    try {
      const image = await mainWindow.webContents.capturePage();
      const resized = image.resize({ width: 720 });
      const jpegBuffer = resized.toJPEG(35);
      const base64 = jpegBuffer.toString('base64');

      // POST to backend
      const postData = JSON.stringify({
        frame: base64,
        width: resized.getSize().width,
        height: resized.getSize().height,
      });

      const req = http.request({
        hostname: '127.0.0.1',
        port: backendPort,
        path: '/mobile/screen-frame',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
        },
        timeout: 3000,
      });

      req.on('error', () => {}); // Ignore errors silently
      req.write(postData);
      req.end();
    } catch (err) {
      // Silently ignore capture errors
    }
  }, 1500); // ~0.67 fps — good balance of quality vs bandwidth
}

function stopScreenStream() {
  if (streamInterval) {
    clearInterval(streamInterval);
    streamInterval = null;
  }
  isStreaming = false;
}

// Poll for remote input events from mobile
function startRemoteInputPoller() {
  setInterval(() => {
    if (!backendPort || !mainWindow || mainWindow.isDestroyed()) return;

    const req = http.get(`http://127.0.0.1:${backendPort}/mobile/remote-input`, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (data.events && data.events.length > 0) {
            for (const evt of data.events) {
              handleRemoteInput(evt);
            }
          }
        } catch (_) {}
      });
    });
    req.on('error', () => {});
    req.setTimeout(2000, () => req.destroy());
  }, 500);
}

function handleRemoteInput(evt) {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  // Handle CLI input separately
  if (evt.type === 'cli_input') {
    // Write to all active CLI sessions (usually only one)
    for (const sessionId of cliSessions.keys()) {
      const session = cliSessions.get(sessionId);
      if (session && session.ptyProcess) {
        session.ptyProcess.write(evt.data);
      }
    }
    return;
  }

  if (evt.type === 'click') {
    const bounds = mainWindow.getContentBounds();
    const x = Math.round(evt.x * bounds.width);
    const y = Math.round(evt.y * bounds.height);

    // Simulate mouse click
    mainWindow.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    setTimeout(() => {
      mainWindow.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    }, 50);
  } else if (evt.type === 'scroll') {
    const bounds = mainWindow.getContentBounds();
    const x = Math.round(evt.x * bounds.width);
    const y = Math.round(evt.y * bounds.height);
    mainWindow.webContents.sendInputEvent({
      type: 'mouseWheel',
      x, y,
      deltaX: evt.deltaX || 0,
      deltaY: evt.deltaY || 0,
    });
  } else if (evt.type === 'keypress') {
    // Send keyboard input
    if (evt.key) {
      mainWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: evt.key });
      mainWindow.webContents.sendInputEvent({ type: 'char', keyCode: evt.key });
      mainWindow.webContents.sendInputEvent({ type: 'keyUp', keyCode: evt.key });
    }
  }
}

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  stopScreenStream();
  stopBackend();
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});

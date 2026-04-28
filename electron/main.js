const { app, BrowserWindow, dialog, ipcMain, shell, Menu } = require('electron');
const path = require('path');
const { spawn, execSync, execFile } = require('child_process');
const net = require('net');
const fs = require('fs');
const http = require('http');
const https = require('https');
const pty = require('node-pty');
const cliBundle = require('./cli-bundle');

// Keep a global reference of the window object
let mainWindow = null;
let backendProcess = null;
let backendPort = null;
let splashWindow = null;
let cliSessionCounter = 0;
const cliSessions = new Map();
let currentProjectRoot = null;
let cliToolsInstallPromise = null;
// Resolves once the bundled CLI credentials have been written (or definitively
// failed). `cli:start` awaits this before spawning so the CLI never launches
// against a missing ~/.claude/.credentials.json or ~/.codex/auth.json.
let cliBundleReadyPromise = null;

// ─── Deep-link / SSO callback handling ──────────────────────────
const APP_PROTOCOL = 'nebula';
let pendingAuthCallbackUrl = null;

function _loadPackagedDotEnv() {
  try {
    if (!app.isPackaged) return;
    const resourcesRoot = process.resourcesPath || '';
    if (!resourcesRoot) return;
    loadDotEnvFile(path.join(resourcesRoot, 'backend', '.env'));
    loadDotEnvFile(path.join(resourcesRoot, 'backend-src', '.env'));
  } catch (_) {}
}

function _extractDeepLinkFromArgv(argv) {
  try {
    return (argv || []).find((a) => typeof a === 'string' && a.startsWith(`${APP_PROTOCOL}://`)) || null;
  } catch (_) {
    return null;
  }
}

function handleAuthCallbackUrl(url) {
  if (!url) return;
  pendingAuthCallbackUrl = url;
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('auth:callback', { url });
      mainWindow.show();
      mainWindow.focus();
    }
  } catch (_) {}
}

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const url = _extractDeepLinkFromArgv(argv);
    if (url) handleAuthCallbackUrl(url);
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
        mainWindow.focus();
      }
    } catch (_) {}
  });
}

app.on('open-url', (event, url) => {
  try { event.preventDefault(); } catch (_) {}
  handleAuthCallbackUrl(url);
});

// Capture deep link when the app is launched via protocol (Windows/Linux).
const _initialDeepLink = _extractDeepLinkFromArgv(process.argv);
if (_initialDeepLink) {
  pendingAuthCallbackUrl = _initialDeepLink;
}

// Determine if we're in development or production
const isDev = process.env.ELECTRON_DEV === 'true' || !app.isPackaged;

// Paths
const userDataPath = app.getPath('userData');
const embeddedPythonDir = path.join(userDataPath, 'python');
const embeddedNodeDir = path.join(userDataPath, 'node');
const cliToolsPrefixDir = path.join(userDataPath, 'cli-tools');
const sessionStatePath = path.join(userDataPath, 'nebula-session.json');

function readSessionState() {
  try {
    if (!fs.existsSync(sessionStatePath)) return {};
    const raw = fs.readFileSync(sessionStatePath, 'utf-8');
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

function writeSessionState(patch = {}) {
  try {
    const prev = readSessionState();
    const next = { ...(prev || {}), ...(patch || {}) };
    fs.mkdirSync(path.dirname(sessionStatePath), { recursive: true });
    fs.writeFileSync(sessionStatePath, JSON.stringify(next, null, 2), 'utf-8');
  } catch (_) {}
}

function setCurrentProjectRoot(folderPath) {
  try {
    const p = typeof folderPath === 'string' ? folderPath.trim() : '';
    if (!p) return false;
    const resolved = path.resolve(p);
    if (!fs.existsSync(resolved)) return false;
    const st = fs.statSync(resolved);
    if (!st.isDirectory()) return false;
    currentProjectRoot = resolved;
    process.env.NEBULA_PROJECT_ROOT = resolved;
    writeSessionState({ lastProjectRoot: resolved });
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('project:root-changed', { projectRoot: resolved });
      }
    } catch (_) {}
    return true;
  } catch (_) {
    return false;
  }
}

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
_loadPackagedDotEnv();
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

function ensureCliPaths(env = process.env) {
  try {
    prependToPath(cliToolsPrefixDir, env);
  } catch (_) {}
  try {
    const nodeRoot = getEmbeddedNodeRoot();
    if (nodeRoot) prependToPath(nodeRoot, env);
  } catch (_) {}
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
      const lines = output.split(/\r?\n/).filter(Boolean);
      const winExecutable = lines.find(line => {
        const lower = line.toLowerCase();
        return lower.endsWith('.cmd') || lower.endsWith('.bat') || lower.endsWith('.exe') || lower.endsWith('.ps1');
      });
      return winExecutable || lines[0] || null;
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
  ensureCliPaths(process.env);

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

  const npmBin = getNpmGlobalBinDir();
  if (npmBin) {
    prependToPath(npmBin, process.env);
  }

  const commandPath = resolveCommandPath(spec.command);
  if (!commandPath && !commandExists(spec.command)) {
    return {
      installed: false,
      label: spec.label,
      packageName: spec.packageName,
      shellLabel: process.platform === 'win32' ? 'powershell' : 'shell',
    };
  }

  // Codex on Windows is often registered as an App Execution Alias under WindowsApps.
  // The resolved path from `where codex` may be non-executable for this process, so
  // we start an interactive PowerShell PTY and then run `codex` inside it.
  if (process.platform === 'win32' && tool === 'codex') {
    return {
      installed: true,
      label: spec.label,
      shellLabel: 'powershell',
      file: 'powershell.exe',
      args: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-NoExit'],
      bootstrapInput: 'codex\r',
    };
  }

  if (process.platform === 'win32' && tool === 'claude' && !commandPath) {
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

  // On Windows, many npm-installed CLIs are shimmed via `.cmd` / `.bat` / `.ps1`.
  // Spawn them via `cmd.exe` / `powershell.exe` for reliability with node-pty.
  if (process.platform === 'win32' && commandPath) {
    const lower = commandPath.toLowerCase();
    if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
      // Pass args as a single verbatim string so node-pty's argsToCommandLine
      // doesn't backslash-escape the wrapping quotes (cmd.exe can't parse `\"...\"`).
      return {
        installed: true,
        label: spec.label,
        shellLabel: 'cmd',
        file: 'cmd.exe',
        args: `/d /s /c "${commandPath}"`,
      };
    }
    if (lower.endsWith('.ps1')) {
      return {
        installed: true,
        label: spec.label,
        shellLabel: 'powershell',
        file: 'powershell.exe',
        args: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', commandPath],
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
  ensureCliPaths(process.env);
  try { fs.mkdirSync(cliToolsPrefixDir, { recursive: true }); } catch (_) {}

  let npmCommand = null;
  try {
    await runFile(getNpmCommand(), ['--version'], { timeout: 10000, env: { ...process.env } });
    npmCommand = getNpmCommand();
  } catch (_) {}

  // Windows: if npm is missing, download a portable Node.js runtime (includes npm)
  if (!npmCommand && process.platform === 'win32') {
    const nodeRoot = await setupEmbeddedNode();
    if (nodeRoot) {
      try {
        prependToPath(nodeRoot, process.env);
        ensureCliPaths(process.env);
        const embeddedNpm = path.join(nodeRoot, 'npm.cmd');
        await runFile(embeddedNpm, ['--version'], { timeout: 15000, env: { ...process.env } });
        npmCommand = embeddedNpm;
      } catch (_) {}
    }
  }

  for (const cli of CLI_SPECS) {
    if (!cli.packageName) continue;
    if (commandExists(cli.command)) {
      console.log(`${cli.label} already installed`);
      continue;
    }

    if (!npmCommand) {
      console.warn(`Skipping ${cli.label} install because npm is unavailable`);
      continue;
    }

    updateSplash(`Installing ${cli.label}...`);
    console.log(`Installing ${cli.label} using ${cli.packageName}`);
    try {
      await runFile(npmCommand, ['install', '-g', cli.packageName, '--prefix', cliToolsPrefixDir, '--no-audit', '--no-fund'], {
        timeout: 300000,
        env: { ...process.env },
      });
    } catch (err) {
      console.error(`Failed to install ${cli.label}:`, err.stderr || err.message);
      continue;
    }
    ensureCliPaths(process.env);
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

// ─── Embedded Node.js Setup (Windows) ────────────────────────────

function getEmbeddedNodeRoot() {
  if (process.platform !== 'win32') return null;
  try {
    const directNode = path.join(embeddedNodeDir, 'node.exe');
    const directNpm = path.join(embeddedNodeDir, 'npm.cmd');
    if (fs.existsSync(directNode) && fs.existsSync(directNpm)) return embeddedNodeDir;

    if (!fs.existsSync(embeddedNodeDir)) return null;
    const entries = fs.readdirSync(embeddedNodeDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(embeddedNodeDir, entry.name);
      const nodeExe = path.join(candidate, 'node.exe');
      const npmCmd = path.join(candidate, 'npm.cmd');
      if (fs.existsSync(nodeExe) && fs.existsSync(npmCmd)) return candidate;
    }
  } catch (_) {}
  return null;
}

function fetchText(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const get = url.startsWith('https') ? https.get : http.get;

    const request = (targetUrl) => {
      const req = get(targetUrl, (response) => {
        // Handle redirects
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          request(response.headers.location);
          return;
        }
        if (response.statusCode !== 200) {
          reject(new Error(`Request failed with status ${response.statusCode}`));
          return;
        }
        let raw = '';
        response.setEncoding('utf-8');
        response.on('data', (chunk) => { raw += chunk; });
        response.on('end', () => resolve(raw));
      });
      req.on('error', reject);
      req.setTimeout(timeoutMs, () => {
        try { req.destroy(new Error('Request timed out')); } catch (_) {}
      });
    };

    request(url);
  });
}

async function getLatestLtsNodeVersion() {
  const fallback = 'v20.11.1';
  try {
    const raw = await fetchText('https://nodejs.org/dist/index.json', 15000);
    const list = JSON.parse(raw || '[]');
    if (!Array.isArray(list)) return fallback;
    const lts = list.find((item) => item && item.lts);
    const v = lts && typeof lts.version === 'string' ? lts.version : '';
    return /^v\d+\.\d+\.\d+$/.test(v) ? v : fallback;
  } catch (_) {
    return fallback;
  }
}

async function setupEmbeddedNode() {
  if (process.platform !== 'win32') return null;

  const existing = getEmbeddedNodeRoot();
  if (existing) return existing;

  console.log('Setting up embedded Node.js for Windows...');
  updateSplash('Setting up Node.js (first-time only)...');

  const version = await getLatestLtsNodeVersion();
  const zipUrl = `https://nodejs.org/dist/${version}/node-${version}-win-x64.zip`;
  const zipPath = path.join(userDataPath, `node-${version}-win-x64.zip`);

  try {
    fs.mkdirSync(embeddedNodeDir, { recursive: true });

    updateSplash(`Downloading Node.js runtime (${version})...`);
    await downloadFile(zipUrl, zipPath);

    updateSplash('Extracting Node.js...');
    execSync(
      `powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${embeddedNodeDir}' -Force"`,
      { timeout: 600000 }
    );

    try { fs.unlinkSync(zipPath); } catch (_) {}

    const nodeRoot = getEmbeddedNodeRoot();
    if (!nodeRoot) {
      throw new Error('Embedded Node extraction did not produce node.exe');
    }

    console.log('Embedded Node.js setup complete');
    return nodeRoot;
  } catch (err) {
    console.error('Failed to setup embedded Node.js:', err);
    try { fs.rmSync(embeddedNodeDir, { recursive: true, force: true }); } catch (_) {}
    try { fs.unlinkSync(zipPath); } catch (_) {}
    return null;
  }
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

async function startBackend(port, projectRoot = null) {
  return new Promise(async (resolve, reject) => {
    const requestedProjectRoot = typeof projectRoot === 'string' ? projectRoot.trim() : '';
    const initialProjectRoot = (requestedProjectRoot && fs.existsSync(requestedProjectRoot))
      ? requestedProjectRoot
      : '';
    let command, args, cwd;

    // ─── Strategy 1: Bundled PyInstaller executable ───────────
    const bundledExe = getBundledBackendExe();
    if (bundledExe) {
      console.log('Using bundled PyInstaller backend');
      command = bundledExe;
      args = ['--port', port.toString(), '--host', '0.0.0.0'];
      if (initialProjectRoot) args.push('--project-root', initialProjectRoot);
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
      ];
      if (initialProjectRoot) args.push('--project-root', initialProjectRoot);
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

  mainWindow.webContents.on('did-finish-load', () => {
    if (pendingAuthCallbackUrl) {
      handleAuthCallbackUrl(pendingAuthCallbackUrl);
    }
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    try {
      if (!url || typeof url !== 'string') return;
      const isFile = url.startsWith('file://');
      const isDevApp = isDev && (url.startsWith('http://localhost:3000') || url.startsWith('http://127.0.0.1:3000'));
      if (isFile || isDevApp) return;
      event.preventDefault();
      shell.openExternal(url);
    } catch (_) {}
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
  const productionUrl = process.env.NEBULA_AUTH_URL || 'https://nebula-ide-server.up.railway.app';
  const developmentUrl = process.env.NEBULA_AUTH_URL_DEV || `http://127.0.0.1:${backendPort}`;
  return isProduction ? productionUrl : developmentUrl;
});

ipcMain.on('get-url-config-sync', (event) => {
  const apiUrl = `http://127.0.0.1:${backendPort}`;
  const isProduction = !isDev && app.isPackaged;
  const productionAuthUrl = process.env.NEBULA_AUTH_URL || 'https://nebula-ide-server.up.railway.app';
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
    const selected = result.filePaths[0];
    setCurrentProjectRoot(selected);
    return selected;
  }
  return null;
});

ipcMain.handle('project:set-root', async (_event, folderPath) => {
  const ok = setCurrentProjectRoot(folderPath);
  return { ok, projectRoot: currentProjectRoot };
});

ipcMain.handle('auth:get-pending-callback', () => {
  const url = pendingAuthCallbackUrl;
  pendingAuthCallbackUrl = null;
  return url;
});

ipcMain.handle('shell:open-external', async (_event, url) => {
  try {
    if (typeof url !== 'string' || !url.trim()) return { ok: false, error: 'Invalid URL' };
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, error: 'Blocked URL protocol' };
    await shell.openExternal(url);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message || 'Failed to open URL' };
  }
});

ipcMain.handle('cli:start', async (event, tool = 'claude', options = {}) => {
  // Wait until the shipped credential bundle has been unpacked into
  // ~/.claude and ~/.codex. If the bundle install hasn't started yet (very
  // early click), kick it off now. We always wait — never spawn the CLI
  // against an empty cred dir, otherwise the user gets a login prompt.
  try {
    if (!cliBundleReadyPromise) {
      try { cliBundle.init(app); } catch (_) {}
      cliBundleReadyPromise = cliBundle.ensureInstalled().catch((err) => ({
        ok: false, errorCode: 'BUNDLE_UNKNOWN', message: err?.message || String(err),
      }));
    }
    const bundleRes = await cliBundleReadyPromise;
    if (!bundleRes || bundleRes.ok !== true) {
      return {
        ok: false,
        installed: false,
        message: `Credential bundle not installed (${bundleRes && bundleRes.errorCode || 'unknown'}). Open Admin → Repair CLI Credentials, or reinstall.`,
        bundleError: bundleRes || null,
      };
    }
  } catch (e) {
    return {
      ok: false,
      installed: false,
      message: `Credential bundle check failed: ${e?.message || String(e)}`,
    };
  }

  let launch = getCliLaunchConfig(tool);

  if (!launch.installed) {
    // Try to install in the background (first launch may not have npm on PATH).
    if (launch.packageName) {
      try {
        if (!cliToolsInstallPromise) {
          cliToolsInstallPromise = ensureCliToolsInstalled()
            .catch(() => {})
            .finally(() => { cliToolsInstallPromise = null; });
        }
      } catch (_) {}
      return {
        ok: false,
        installed: false,
        message: `${launch.label} is not installed yet. Nebula is installing CLI tools in the background — please wait a moment and re-select the tool.`,
        shell: launch.shellLabel,
      };
    }

    return {
      ok: false,
      installed: false,
      message: `${launch.label} is not installed.`,
      shell: launch.shellLabel,
    };
  }

  const sessionId = `cli-${++cliSessionCounter}`;
  // CLI auth comes from on-disk credentials unpacked by cli-bundle into
  // ~/.claude/.credentials.json and ~/.codex/auth.json. Strip any env-var
  // overrides the user may have set globally — otherwise Claude/Codex CLI
  // will prefer the env var over our bundled creds and prompt for login.
  const env = { ...process.env, TERM: 'xterm-256color' };
  for (const k of [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'OPENAI_API_KEY',
    'OPENAI_AUTH_TOKEN',
    'CODEX_API_KEY',
  ]) {
    delete env[k];
  }
  const requestedCwd = options && typeof options === 'object'
    ? (options.cwd || options.projectRoot || '')
    : '';
  const sessionCwd = typeof requestedCwd === 'string' ? requestedCwd.trim() : '';
  const cwd = (sessionCwd && fs.existsSync(sessionCwd))
    ? sessionCwd
    : ((currentProjectRoot && fs.existsSync(currentProjectRoot)) ? currentProjectRoot : app.getPath('home'));

  let ptyProcess = null;
  try {
    ptyProcess = pty.spawn(launch.file, launch.args, {
      name: 'xterm-color',
      cols: 120,
      rows: 32,
      cwd,
      env,
    });
  } catch (e) {
    return {
      ok: false,
      installed: true,
      message: e?.message ? `Failed to start ${launch.label}: ${e.message}` : `Failed to start ${launch.label}.`,
      shell: launch.shellLabel,
    };
  }

  const argsForLog = Array.isArray(launch.args) ? launch.args.join(' ') : (launch.args || '');
  const ptyCommandLine = `${launch.file} ${argsForLog}`.trim();
  console.log(`CLI PTY spawn: ${ptyCommandLine}`);

  const ptyProcessRef = ptyProcess;
  if (launch && typeof launch.bootstrapInput === 'string' && launch.bootstrapInput) {
    setTimeout(() => {
      try {
        ptyProcessRef.write(launch.bootstrapInput);
      } catch (_) {}
    }, 250);
  }

  cliSessions.set(sessionId, {
    ptyProcess: ptyProcessRef,
    sender: event.sender,
  });

  ptyProcessRef.onData((data) => {
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

  ptyProcessRef.onExit((exitEvent) => {
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

// ─── CLI auth bundle (Claude/Codex credentials unpack) ─────────
ipcMain.handle('cli-bundle:status', () => {
  try { return cliBundle.getStatus(); }
  catch (e) { return { ok: false, errorCode: 'BUNDLE_UNKNOWN', message: e?.message || String(e) }; }
});

ipcMain.handle('cli-bundle:repair', async (_event, opts) => {
  try {
    const override = !!(opts && opts.override);
    return await cliBundle.forceReinstall({ override });
  } catch (e) {
    return { ok: false, errorCode: 'BUNDLE_UNKNOWN', message: e?.message || String(e) };
  }
});

// ─── App Lifecycle ──────────────────────────────────────────────

app.whenReady().then(async () => {
  try {
    try {
      if (process.defaultApp) {
        if (process.argv.length >= 2) {
          app.setAsDefaultProtocolClient(APP_PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
        }
      } else {
        app.setAsDefaultProtocolClient(APP_PROTOCOL);
      }
    } catch (_) {}

    // Show splash screen
    createSplashWindow('Starting IDE...');

    // Restore last opened folder session (if any)
    try {
      const s = readSessionState();
      const last = s && typeof s.lastProjectRoot === 'string' ? s.lastProjectRoot.trim() : '';
      if (last) setCurrentProjectRoot(last);
    } catch (_) {}

    // Ensure the CLI tools exist before the backend/terminal sessions use them.
    if (!cliToolsInstallPromise) {
      cliToolsInstallPromise = ensureCliToolsInstalled()
        .catch(() => {})
        .finally(() => { cliToolsInstallPromise = null; });
    }
    // We intentionally don't await cliToolsInstallPromise here so it doesn't block startup.

    // Unpack the shipped credential bundle into ~/.claude and ~/.codex.
    // Runs in parallel with backend startup; never blocks UI. `cli:start`
    // awaits cliBundleReadyPromise so a CLI session never spawns before the
    // bundled credentials are on disk.
    try {
      cliBundle.init(app);
      cliBundleReadyPromise = cliBundle.ensureInstalled().then((res) => {
        if (!res.ok) {
          console.warn(`[cli-bundle] install failed: ${res.errorCode} — ${res.message || ''}`);
          if (mainWindow && !mainWindow.isDestroyed()) {
            try { mainWindow.webContents.send('cli-bundle:event', { type: 'install-failed', ...res }); } catch (_) {}
          }
        } else if (res.status === 'installed') {
          console.log('[cli-bundle] installed CLI credentials into ~/.claude and ~/.codex');
        }
        return res;
      }).catch((err) => {
        console.error('[cli-bundle] unexpected error:', err);
        return { ok: false, errorCode: 'BUNDLE_UNKNOWN', message: err?.message || String(err) };
      });
    } catch (e) {
      console.error('[cli-bundle] init failed:', e);
      cliBundleReadyPromise = Promise.resolve({ ok: false, errorCode: 'BUNDLE_INIT_FAIL', message: e?.message || String(e) });
    }

    // Find a free port
    backendPort = await findFreePort();
    console.log(`Using port ${backendPort} for backend`);

    // Start the backend (handles all Python detection/setup)
    await startBackend(backendPort, currentProjectRoot);
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

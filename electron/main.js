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
// Maps webContents.id → folderPath for in-process new windows (Windows only)
const windowStartupFolders = new Map();
let backendProcess = null;
let backendPort = null;
let splashWindow = null;
let cliSessionCounter = 0;
const cliSessions = new Map();
/** Integrated IDE terminal (bottom panel) — node-pty in main; avoids WS→Python latency. */
const integratedTermSessions = new Map();
let currentProjectRoot = null;
let cliToolsInstallPromise = null;
let cliToolsInstallFailedCount = 0;
const CLI_TOOLS_INSTALL_MAX_RETRIES = 3;
let cliToolsInstallInProgress = false;
let cliToolsInstallLastResult = null; // 'success' | 'failed' | null
// Resolves once the bundled CLI credentials have been written (or definitively
// failed). `cli:start` awaits this before spawning so the CLI never launches
// against a missing ~/.claude/.credentials.json or ~/.codex/auth.json.
let cliBundleReadyPromise = null;
// Tracks the last refresh token written by _applyFreshClaudeToken so the
// credential watcher can distinguish our own writes from CLI-rotation events.
let _lastBackendRefreshToken = null;
let _credWatcher = null;

const SCROLLBACK_MAX_BYTES = 512 * 1024; // 512 KB per session

/** Set when this process was spawned as an additional IDE window — no auto-open last folder. */
const NEBULA_FRESH_WINDOW = process.argv.includes('--nebula-fresh-window');

/** Folder path passed via --nebula-open-folder=<path> when spawning a new window for a different project. */
const NEBULA_OPEN_FOLDER = (() => {
  const arg = process.argv.find(a => a.startsWith('--nebula-open-folder='));
  if (!arg) return null;
  try { return decodeURIComponent(arg.slice('--nebula-open-folder='.length)); } catch (_) { return null; }
})();

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

// We intentionally allow multiple app instances (separate windows / projects).
// Deep links use open-url (macOS) or argv on first launch.

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
const authPersistPath = path.join(userDataPath, 'nebula-auth.json');

function readPersistedAuth() {
  try {
    if (!fs.existsSync(authPersistPath)) return null;
    const raw = fs.readFileSync(authPersistPath, 'utf-8');
    const o = JSON.parse(raw);
    if (!o || typeof o !== 'object') return null;
    const token = typeof o.token === 'string' ? o.token.trim() : '';
    if (!token) return null;
    return { token, user: o.user && typeof o.user === 'object' ? o.user : null };
  } catch (_) {
    return null;
  }
}

function writePersistedAuth(payload) {
  const token = payload && typeof payload.token === 'string' ? payload.token.trim() : '';
  if (!token) return { ok: false, error: 'no_token' };
  try {
    fs.mkdirSync(path.dirname(authPersistPath), { recursive: true });
    fs.writeFileSync(
      authPersistPath,
      JSON.stringify({ token, user: payload.user && typeof payload.user === 'object' ? payload.user : null }),
      'utf-8',
    );
    try {
      if (process.platform !== 'win32') fs.chmodSync(authPersistPath, 0o600);
    } catch (_) {}
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

function clearPersistedAuth() {
  try {
    if (fs.existsSync(authPersistPath)) fs.unlinkSync(authPersistPath);
  } catch (_) {}
  return { ok: true };
}

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

function killAllIntegratedTerminals() {
  for (const [, sess] of integratedTermSessions) {
    try {
      sess.ptyProcess.kill();
    } catch (_) {}
  }
  integratedTermSessions.clear();
}

/** Open a different project in a separate window.
 *
 *  macOS packaged → `open -n -a` (OS handles multi-instance properly).
 *  Windows        → in-process BrowserWindow (spawning a second Electron process
 *                   fails silently on Windows due to Chromium's userData lockfile).
 *  Linux / dev    → direct spawn of the exe.
 */
function spawnNewAppInstance(folderPath, prevWindow) {
  try {
    const exe = process.execPath;
    const folderArg = folderPath ? `--nebula-open-folder=${encodeURIComponent(folderPath)}` : '--nebula-fresh-window';

    if (process.platform === 'darwin' && app.isPackaged) {
      const idx = exe.indexOf('.app/');
      if (idx >= 0) {
        const bundle = exe.slice(0, idx + 4);
        const child = spawn('open', ['-n', '-a', bundle, '--args', folderArg], {
          detached: true,
          stdio: 'ignore',
        });
        child.unref();
        return { ok: true };
      }
    }

    if (process.platform === 'win32') {
      return openFolderInProcessWindow(folderPath, prevWindow || mainWindow);
    }

    // Linux / macOS dev mode
    const child = spawn(exe, [folderArg], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.unref();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

function setCurrentProjectRoot(folderPath) {
  try {
    const p = typeof folderPath === 'string' ? folderPath.trim() : '';
    if (!p) return false;
    const resolved = path.resolve(p);
    if (!fs.existsSync(resolved)) return false;
    const st = fs.statSync(resolved);
    if (!st.isDirectory()) return false;
    const prev = currentProjectRoot;
    if (prev && path.resolve(prev) !== resolved) {
      killAllIntegratedTerminals();
    }
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

// ─── Module-level caches (avoids repeated execSync blocks) ──────

// undefined = not yet resolved; null = resolved but not found; string = path
let _npmGlobalBinDirCache = undefined;
let _npmGlobalBinDirPromise = null;

// Map of command → resolved path | null
const _commandPathCache = new Map();

// Resolved python command
let _systemPythonCache = undefined;

// Whether a mobile WebSocket client is currently connected.
// Used to gate PTY→HTTP relay so we don't fire HTTP requests when no mobile client exists.
let _mobileClientCount = 0;

function incrementMobileClients() { _mobileClientCount++; }
function decrementMobileClients() { if (_mobileClientCount > 0) _mobileClientCount--; }

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
    prependToPath(path.join(cliToolsPrefixDir, 'bin'), env);
  } catch (_) {}
  try {
    const nodeRoot = getEmbeddedNodeRoot();
    if (nodeRoot) prependToPath(nodeRoot, env);
  } catch (_) {}
}

function getNpmGlobalBinDir() {
  // Return cached value synchronously if available
  if (_npmGlobalBinDirCache !== undefined) return _npmGlobalBinDirCache;
  // Not resolved yet — return null so callers degrade gracefully;
  // the async version (getNpmGlobalBinDirAsync) will populate the cache.
  return null;
}

function getNpmGlobalBinDirAsync() {
  if (_npmGlobalBinDirCache !== undefined) return Promise.resolve(_npmGlobalBinDirCache);
  if (_npmGlobalBinDirPromise) return _npmGlobalBinDirPromise;

  _npmGlobalBinDirPromise = new Promise((resolve) => {
    const npmCommand = getNpmCommand();
    execFile(npmCommand, ['config', 'get', 'prefix'], {
      encoding: 'utf-8',
      timeout: 10000,
      windowsHide: true,
      env: { ...process.env },
    }, (err, stdout) => {
      const prefix = (stdout || '').trim();
      if (!err && prefix) {
        _npmGlobalBinDirCache = process.platform === 'win32' ? prefix : path.join(prefix, 'bin');
      } else {
        _npmGlobalBinDirCache = null;
      }
      _npmGlobalBinDirPromise = null;
      resolve(_npmGlobalBinDirCache);
    });
  });

  return _npmGlobalBinDirPromise;
}

// Async command resolution — never blocks the main process.
// Results are cached so subsequent calls are instant.
async function resolveCommandPathAsync(command) {
  const cached = _commandPathCache.get(command);
  if (cached !== undefined) return cached;

  try {
    let result = null;
    if (process.platform === 'win32') {
      const { stdout } = await runFile('where', [command], {
        timeout: 5000, env: { ...process.env },
      });
      const lines = (stdout || '').trim().split(/\r?\n/).filter(Boolean);
      const prefixDir = cliToolsPrefixDir.toLowerCase();
      const preferred = lines.find(l => l.toLowerCase().startsWith(prefixDir));
      const candidates = preferred ? [preferred] : lines;
      const exe = candidates.find(l => {
        const lower = l.toLowerCase();
        return lower.endsWith('.cmd') || lower.endsWith('.bat') ||
               lower.endsWith('.exe') || lower.endsWith('.ps1');
      });
      result = exe || lines[0] || null;
      // Verify the path actually exists on disk
      if (result && !_exeExists(result)) {
        console.warn(`[path-resolve] ${command} resolved to ${result} but file does not exist, re-checking...`);
        // Try with .exe extension
        const withExe = result.endsWith('.exe') ? result : result + '.exe';
        if (_exeExists(withExe)) {
          result = withExe;
        } else {
          result = null;
        }
      }
    } else {
      const { stdout } = await runFile('/bin/sh', ['-c', `command -v ${command}`], {
        timeout: 5000, env: { ...process.env },
      });
      result = (stdout || '').trim() || null;
      if (result && !_exeExists(result)) {
        console.warn(`[path-resolve] ${command} resolved to ${result} but file does not exist on disk`);
        result = null;
      }
    }
    _commandPathCache.set(command, result);
    return result;
  } catch (_) {
    _commandPathCache.set(command, null);
    return null;
  }
}

// Synchronous wrappers read from cache only — safe because we pre-warm at startup.
function commandExists(command) {
  const cached = _commandPathCache.get(command);
  if (cached !== undefined) return cached !== null;
  // Cache miss: not yet warmed. Fall back to a quick sync check.
  try {
    let resolved;
    if (process.platform === 'win32') {
      const output = execSync(`where ${command}`, {
        stdio: 'pipe', timeout: 5000, windowsHide: true, encoding: 'utf-8',
      }).trim();
      const lines = output.split(/\r?\n/).filter(Boolean);
      const prefixDir = cliToolsPrefixDir.toLowerCase();
      const preferred = lines.find(l => l.toLowerCase().startsWith(prefixDir));
      const candidates = preferred ? [preferred] : lines;
      const exe = candidates.find(l => {
        const lower = l.toLowerCase();
        return lower.endsWith('.cmd') || lower.endsWith('.bat') ||
               lower.endsWith('.exe') || lower.endsWith('.ps1');
      });
      resolved = exe || lines[0] || null;
      if (resolved && !_exeExists(resolved)) {
        const withExe = resolved.endsWith('.exe') ? resolved : resolved + '.exe';
        resolved = _exeExists(withExe) ? withExe : null;
      }
    } else {
      resolved = execSync(`command -v ${command} 2>/dev/null`, {
        stdio: 'pipe', timeout: 5000, encoding: 'utf-8', shell: '/bin/sh',
      }).trim() || null;
      if (resolved && !_exeExists(resolved)) resolved = null;
    }
    _commandPathCache.set(command, resolved);
    return resolved !== null;
  } catch (_) {
    _commandPathCache.set(command, null);
    return false;
  }
}

function resolveCommandPath(command) {
  const cached = _commandPathCache.get(command);
  if (cached !== undefined) return cached;
  // Cache miss fallback — same sync logic as commandExists.
  try {
    let result;
    if (process.platform === 'win32') {
      const output = execSync(`where ${command}`, {
        stdio: 'pipe', timeout: 5000, windowsHide: true, encoding: 'utf-8',
      }).trim();
      const lines = output.split(/\r?\n/).filter(Boolean);
      const prefixDir = cliToolsPrefixDir.toLowerCase();
      const preferred = lines.find(l => l.toLowerCase().startsWith(prefixDir));
      const candidates = preferred ? [preferred] : lines;
      const exe = candidates.find(l => {
        const lower = l.toLowerCase();
        return lower.endsWith('.cmd') || lower.endsWith('.bat') ||
               lower.endsWith('.exe') || lower.endsWith('.ps1');
      });
      result = exe || lines[0] || null;
      if (result && !_exeExists(result)) {
        const withExe = result.endsWith('.exe') ? result : result + '.exe';
        result = _exeExists(withExe) ? withExe : null;
      }
    } else {
      const output = execSync(`command -v ${command} 2>/dev/null`, {
        stdio: 'pipe', timeout: 5000, encoding: 'utf-8', shell: '/bin/sh',
      }).trim();
      result = output || null;
      if (result && !_exeExists(result)) result = null;
    }
    _commandPathCache.set(command, result);
    return result;
  } catch (_) {
    _commandPathCache.set(command, null);
    return null;
  }
}

// Pre-warm the command cache for all CLI tools at startup (async, non-blocking).
async function prewarmCommandCache() {
  const commands = CLI_SPECS.map(s => s.command).filter(Boolean);
  await Promise.all(commands.map(cmd => resolveCommandPathAsync(cmd).catch(() => {})));
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

function _exeExists(p) {
  try {
    if (!p || typeof p !== 'string') return false;
    if (fs.existsSync(p)) return true;
    // On Windows, also check with PATHEXT extensions
    if (process.platform === 'win32') {
      const pathext = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC').toLowerCase().split(';');
      for (const ext of pathext) {
        if (fs.existsSync(p + ext)) return true;
      }
    }
    return false;
  } catch (_) { return false; }
}

function _logCliConfig(tool, cfg) {
  const diag = {
    tool,
    installed: cfg.installed,
    file: cfg.file,
    args: Array.isArray(cfg.args) ? cfg.args.join('|') : cfg.args,
    shellLabel: cfg.shellLabel,
    fileExists: cfg.file ? _exeExists(cfg.file) : null,
    platform: process.platform,
  };
  if (process.platform === 'win32' && cfg.file) {
    try {
      const lower = cfg.file.toLowerCase();
      if (!lower.endsWith('.exe') && !lower.endsWith('.cmd') && !lower.endsWith('.bat')) {
        diag.warning = 'file_missing_extension';
      }
    } catch (_) {}
  }
  console.log('[cli-launch]', JSON.stringify(diag));
}

function getCliLaunchConfig(tool) {
  const spec = CLI_SPECS.find((item) => item.command === tool) || CLI_SPECS[0];
  ensureCliPaths(process.env);

  // If it's a direct shell request (powershell/cmd)
  if (tool === 'powershell' || tool === 'cmd') {
    const cfg = {
      installed: true,
      label: spec.label,
      shellLabel: tool,
      file: spec.file,
      args: spec.args || [],
    };
    _logCliConfig(tool, cfg);
    return cfg;
  }

  const commandPath = resolveCommandPath(spec.command);

  // Diagnostics: log what resolveCommandPath returned
  console.log(`[cli-launch] ${spec.command} resolved to: ${commandPath || '(not found)'}`);
  if (commandPath) {
    console.log(`[cli-launch]   exists=${_exeExists(commandPath)} cwd=${process.cwd()}`);
  }

  if (!commandPath && !commandExists(spec.command)) {
    const cfg = {
      installed: false,
      label: spec.label,
      packageName: spec.packageName,
      shellLabel: process.platform === 'win32' ? 'powershell' : 'shell',
    };
    _logCliConfig(tool, cfg);
    return cfg;
  }

  // Verify the resolved path actually exists on disk
  const resolvedExists = commandPath && _exeExists(commandPath);
  if (commandPath && !resolvedExists) {
    console.warn(`[cli-launch] WARNING: resolved path ${commandPath} does not exist on disk`);
  }

  // Codex on Windows is often registered as an App Execution Alias under WindowsApps.
  // The resolved path from `where codex` may be non-executable for this process, so
  // we start an interactive PowerShell PTY and then run `codex` inside it.
  if (process.platform === 'win32' && tool === 'codex') {
    const cfg = {
      installed: true,
      label: spec.label,
      shellLabel: 'powershell',
      file: 'powershell.exe',
      args: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-NoExit'],
      bootstrapInput: 'codex\r',
    };
    _logCliConfig(tool, cfg);
    return cfg;
  }

  if (process.platform === 'win32' && tool === 'claude' && (!commandPath || !resolvedExists)) {
    const gitBash = findGitBash();
    if (gitBash) {
      const cfg = {
        installed: true,
        label: spec.label,
        shellLabel: 'git-bash',
        file: gitBash,
        args: ['-lc', 'claude'],
      };
      _logCliConfig(tool, cfg);
      return cfg;
    }
  }

  // On Windows, many npm-installed CLIs are shimmed via `.cmd` / `.bat` / `.ps1`.
  // Spawn them via `cmd.exe` / `powershell.exe` for reliability with node-pty.
  if (process.platform === 'win32' && commandPath && resolvedExists) {
    const lower = commandPath.toLowerCase();
    if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
      // Verify the target exists (cmd.exe's "not recognized" error is misleading).
      if (!_exeExists(commandPath)) {
        console.warn(`[cli-launch] WARNING: cmd.exe /c target "${commandPath}" does not exist! Marking as not installed.`);
        const cfg = {
          installed: false,
          label: spec.label,
          packageName: spec.packageName,
          shellLabel: 'cmd',
        };
        _logCliConfig(tool, cfg);
        return cfg;
      }
      const cfg = {
        installed: true,
        label: spec.label,
        shellLabel: 'cmd',
        file: 'cmd.exe',
        args: ['/d', '/s', '/c', commandPath],
      };
      _logCliConfig(tool, cfg);
      return cfg;
    }
    if (lower.endsWith('.ps1')) {
      const cfg = {
        installed: true,
        label: spec.label,
        shellLabel: 'powershell',
        file: 'powershell.exe',
        args: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', commandPath],
      };
      _logCliConfig(tool, cfg);
      return cfg;
    }
  }

  // macOS/Linux: verify binary is executable
  let isExecutable = true;
  if (process.platform !== 'win32' && commandPath) {
    try {
      fs.accessSync(commandPath, fs.constants.X_OK);
    } catch (_) {
      console.warn(`[cli-launch] WARNING: ${commandPath} is not executable`);
      isExecutable = false;
    }
  }

  // If the resolved path doesn't actually exist on disk (or isn't executable
  // on macOS/Linux), mark as not installed. This covers stale `where` / `command -v`
  // cache entries and non-executable binaries.
  if (commandPath && (!_exeExists(commandPath) || !isExecutable)) {
    const cfg = {
      installed: false,
      label: spec.label,
      packageName: spec.packageName,
      shellLabel: process.platform === 'win32' ? 'powershell' : 'shell',
    };
    _logCliConfig(tool, cfg);
    return cfg;
  }

  const cfg = {
    installed: true,
    label: spec.label,
    shellLabel: process.platform === 'win32' ? 'powershell' : 'shell',
    file: commandPath || spec.command,
    args: [],
  };
  _logCliConfig(tool, cfg);
  return cfg;
}

function getIntegratedTerminalLaunch(shell) {
  if (process.platform === 'win32') {
    const sysRoot = process.env.SystemRoot || 'C:\\Windows';
    if (shell === 'cmd') {
      const comspec = process.env.ComSpec || path.join(sysRoot, 'System32', 'cmd.exe');
      return { file: comspec, args: ['/K'] };
    }
    const psPath = path.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const ps = fs.existsSync(psPath) ? psPath : 'powershell.exe';
    return {
      file: ps,
      args: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass'],
    };
  }
  if (shell === 'bash') {
    const bash = fs.existsSync('/bin/bash') ? '/bin/bash' : 'bash';
    return { file: bash, args: ['-l', '-i'] };
  }
  const sh = process.env.SHELL || (fs.existsSync('/bin/zsh') ? '/bin/zsh' : '/bin/bash');
  // Login + interactive so PATH matches Terminal.app (pip, nvm, pyenv, etc.).
  return { file: sh, args: ['-l', '-i'] };
}

function closeCliSession(sessionId) {
  const session = cliSessions.get(sessionId);
  if (!session) return;
  session.explicitlyTerminated = true; // prevent auto-respawn
  try {
    session.ptyProcess.kill();
  } catch (_) {}
  cliSessions.delete(sessionId);
}

// Runs a credential freshness check immediately and then every 6 hours.
// Warns the renderer if the OAuth refresh token appears to have expired.
function _scheduleCredentialFreshnessCheck() {
  const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

  function runCheck() {
    try {
      // Check if credentials file exists before attempting to read it
      const credsPath = path.join(app.getPath('home'), '.claude', '.credentials.json');
      if (!fs.existsSync(credsPath)) {
        return; // No credentials yet — bundle may still be installing
      }
      const result = cliBundle.checkTokenFreshness();
      if (!result.ok && result.reason === 'stale') {
        console.warn('[auth] Claude credentials stale:', result.message);
        if (mainWindow && !mainWindow.isDestroyed()) {
          try {
            mainWindow.webContents.send('claude:credential-warning', result);
          } catch (_) {}
        }
      }
    } catch (_) {}
  }

  // Wait a few seconds before the first check to ensure bundle install has completed
  setTimeout(runCheck, 5000);
  setInterval(runCheck, CHECK_INTERVAL_MS);
}

// ── Backend-mediated Claude token refresh ─────────────────────────────────
// The backend holds the master refresh token in MongoDB and handles rotation.
// We fetch a fresh access token from the backend before every CLI spawn and
// every 45 minutes in the background, so the user is never prompted to log in.

function _getNebulaBackendUrl() {
  const isProduction = !isDev && app.isPackaged;
  if (isProduction) {
    return (process.env.NEBULA_AUTH_URL || 'https://nebula-ide-server.up.railway.app').replace(/\/$/, '');
  }
  return `http://127.0.0.1:${backendPort}`;
}

function _fetchClaudeTokenFromBackend() {
  return new Promise((resolve, reject) => {
    try {
      const base = _getNebulaBackendUrl();
      const urlStr = `${base}/auth/claude-token`;
      const isHttps = urlStr.startsWith('https://');
      const mod = isHttps ? https : http;
      const req = mod.get(urlStr, { timeout: 15000 }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            if (data.ok && data.accessToken) resolve(data);
            else {
              const err = new Error(data.error || 'Backend returned no access token');
              err.authFailure = data.authFailure === true;
              err.statusCode = res.statusCode;
              reject(err);
            }
          } catch (e) { reject(new Error(`Bad JSON from token endpoint: ${e.message}`)); }
        });
      });
      req.on('error', (e) => {
        e.authFailure = false;
        reject(e);
      });
      req.on('timeout', () => { 
        const err = new Error('Token fetch timed out');
        err.authFailure = false;
        req.destroy(); 
        reject(err); 
      });
    } catch (e) { reject(e); }
  });
}

function _decodeJwtSubject(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return payload.sub || null;
  } catch (_) { return null; }
}

function _readDiskAccessToken() {
  try {
    const credsPath = path.join(app.getPath('home'), '.claude', '.credentials.json');
    if (!fs.existsSync(credsPath)) return null;
    const raw = fs.readFileSync(credsPath, 'utf8');
    const creds = JSON.parse(raw);
    const oauth = creds.claudeAiOauth || creds.oauth || creds;
    return (oauth.accessToken || oauth.access_token || '').trim() || null;
  } catch (_) { return null; }
}

let _refreshInProgress = false;
let _lastRefreshResult = null;

async function _applyFreshClaudeToken() {
  // Prevent concurrent refreshes — if a refresh is already in progress,
  // return the last result (or null if never refreshed).
  if (_refreshInProgress) {
    console.log('[claude-token] Skipping concurrent refresh.');
    return { ok: false, error: 'concurrent_refresh_skipped' };
  }

  _refreshInProgress = true;
  try {
    const data = await _fetchClaudeTokenFromBackend();

    // Guard: if both disk and backend have JWT access tokens with different
    // "sub" (subject) claims, the backend has credentials for a different
    // account. Skip the refresh to preserve the bundled credentials.
    // If tokens are opaque (not JWT), trust the backend and proceed.
    if (data.accessToken) {
      const diskSub = _decodeJwtSubject(_readDiskAccessToken());
      const backendSub = _decodeJwtSubject(data.accessToken);
      if (diskSub && backendSub && diskSub !== backendSub) {
        console.warn(
          '[claude-token] Backend user (sub=' + backendSub + ') differs from disk (sub=' + diskSub + '). ' +
          'Skipping refresh to preserve bundled credentials.'
        );
        _lastRefreshResult = { ok: true };
        return _lastRefreshResult;
      }

      console.log(`[claude-token] Token refreshed. Access token ${data.accessToken.slice(0, 8)}..., expiresAt=${data.expiresAt}, hasRefresh=${!!data.refreshToken}`);
    }

    // Mark this refresh token as ours BEFORE writing to disk, so the file watcher
    // ignores the change we're about to make (avoids a spurious sync loop).
    if (data.refreshToken) _lastBackendRefreshToken = data.refreshToken;

    const { accessToken, expiresAt, refreshToken, ok, ...extraOauthFields } = data;
    const patched = cliBundle.patchAccessToken(accessToken, expiresAt, refreshToken, extraOauthFields);
    console.log(`[claude-token] Claude credentials ${patched ? 'patched' : 'patch FAILED'} on disk.`);

    _lastRefreshResult = { ok: true };
    return _lastRefreshResult;
  } catch (e) {
    const msg = e.message || String(e);
    // Preserve authFailure flag from the underlying error (set by _fetchClaudeTokenFromBackend)
    const isAuth = e.authFailure === true || msg.includes('TOKEN_REFRESH_AUTH_FAILED');
    console.warn('[claude-token] Fresh token fetch failed:', msg, '(authFailure=' + isAuth + ')');
    _lastRefreshResult = { ok: false, error: msg, authFailure: isAuth };
    return _lastRefreshResult;
  } finally {
    _refreshInProgress = false;
  }
}

// Sync the on-disk credentials to the backend after bundle install. Ensures MongoDB
// matches the bundled credentials so the token refresh loop never returns a different
// account's token.
async function _syncBundleCredentialsToBackend() {
  if (!backendPort) return;
  const credsPath = path.join(app.getPath('home'), '.claude', '.credentials.json');
  try {
    if (!fs.existsSync(credsPath)) return;
    const raw = fs.readFileSync(credsPath, 'utf8');
    const creds = JSON.parse(raw);
    const oauth = creds.claudeAiOauth || creds.oauth || creds;
    const refreshToken = (oauth.refreshToken || oauth.refresh_token || '').trim();
    if (!refreshToken) return;
    const body = JSON.stringify({
      oauth: {
        ...oauth,
        accessToken: (oauth.accessToken || oauth.access_token || '').trim(),
        refreshToken,
        expiresAt: oauth.expiresAt || oauth.expires_at || 0,
      },
    });
    await new Promise((resolve) => {
      const req = http.request({
        hostname: '127.0.0.1', port: backendPort,
        path: '/auth/claude-credentials-internal',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (res) => {
        console.log(`[cli-bundle] Credential sync to backend → ${res.statusCode}`);
        resolve();
      });
      req.on('error', (e) => console.warn('[cli-bundle] Credential sync error:', e.message));
      req.write(body);
      req.end();
    });
  } catch (e) {
    console.warn('[cli-bundle] Credential sync failed:', e.message);
  }
}

// Watch ~/.claude/.credentials.json for changes made by an external Claude CLI
// session (e.g., when the developer runs `claude` in CMD and Anthropic rotates
// the refresh token). When a rotation is detected we POST the new credentials to
// the local backend so MongoDB stays in sync, allowing the next Electron
// token refresh to succeed.
//
// If the file does not exist yet (first boot before bundle install), retry
// every 10 s until it appears rather than silently giving up.
function _startCredentialWatcher() {
  const credsPath = path.join(app.getPath('home'), '.claude', '.credentials.json');

  if (!fs.existsSync(credsPath)) {
    console.log('[claude-token] Credentials file not found yet, will retry watcher in 10 s.');
    setTimeout(() => _startCredentialWatcher(), 10_000);
    return;
  }

  if (_credWatcher) {
    try { _credWatcher.close(); } catch (_) {}
  }
  let _debounceTimer = null;
  let _syncInProgress = false;
  try {
    _credWatcher = fs.watch(credsPath, { persistent: false }, () => {
      if (_debounceTimer) {
        clearTimeout(_debounceTimer);
      }
      _debounceTimer = setTimeout(async () => {
        _debounceTimer = null;
        if (_syncInProgress) {
          console.log('[claude-token] Sync already in progress, deferring.');
          _debounceTimer = setTimeout(() => {
            _debounceTimer = null;
            // Re-read on next tick
          }, 1000);
          return;
        }
        _syncInProgress = true;
        try {
          const raw = fs.readFileSync(credsPath, 'utf8');
          const creds = JSON.parse(raw);
          const oauth = creds.claudeAiOauth || creds.oauth || creds;
          const newRefresh = ((oauth.refreshToken || oauth.refresh_token) || '').trim();

          if (!newRefresh) return;
          // If this matches what we last wrote, we caused this change — skip sync.
          if (_lastBackendRefreshToken && newRefresh === _lastBackendRefreshToken) return;

          console.log('[claude-token] External refresh token rotation detected, syncing to backend.');
          _lastBackendRefreshToken = newRefresh;

          if (!backendPort) return;
          const body = JSON.stringify({
            oauth: {
              ...oauth,
              accessToken: ((oauth.accessToken || oauth.access_token) || '').trim(),
              refreshToken: newRefresh,
              expiresAt: oauth.expiresAt || oauth.expires_at || 0,
              scope: oauth.scope || '',
              subscriptionType: oauth.subscriptionType || '',
              rateLimitTier: oauth.rateLimitTier || '',
            },
          });
          const req = http.request({
            hostname: '127.0.0.1',
            port: backendPort,
            path: '/auth/claude-credentials-internal',
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
          }, (res) => {
            console.log(`[claude-token] Credential sync → ${res.statusCode}`);
            _syncInProgress = false;
          });
          req.on('error', (e) => {
            console.warn('[claude-token] Credential sync error:', e.message);
            _syncInProgress = false;
          });
          req.write(body);
          req.end();
        } catch (e) {
          console.warn('[claude-token] Credential watcher read error:', e.message);
          _syncInProgress = false;
        }
      }, 500);
    });
    console.log('[claude-token] Watching for credential rotation:', credsPath);
  } catch (e) {
    console.warn('[claude-token] Could not start credential watcher:', e.message);
  }
}

// Refresh token every 45 minutes so the on-disk access token never expires mid-session.
// Uses a clock-aware interval to avoid rapid catch-up after system sleep/hibernate.
function _startClaudeTokenRefreshLoop() {
  const INTERVAL_MS = 45 * 60 * 1000;
  let _lastRefreshTs = Date.now();

  async function _timedRefresh() {
    const now = Date.now();
    const elapsed = now - _lastRefreshTs;
    _lastRefreshTs = now;

    // If more than 90 minutes have elapsed (double the interval), the system
    // likely came out of sleep. Perform a single refresh instead of catching up.
    if (elapsed > INTERVAL_MS * 2) {
      console.log('[claude-token] Detected possible sleep/wake cycle (elapsed=' + elapsed + 'ms). Performing one catch-up refresh.');
    }

    await _applyFreshClaudeToken();
  }

  setInterval(_timedRefresh, INTERVAL_MS);
}

// Detects OAuth re-auth URLs that Claude CLI prints when the refresh token expires.
// Matches Claude AI and Anthropic auth domains.
const CLAUDE_AUTH_URL_RE = /https:\/\/(?:claude\.ai|auth\.anthropic\.com|accounts\.anthropic\.com)\/[^\s\r\n"'<>]+/i;

// Registers onData / onExit on a PTY process for a given session.
// Called at spawn time and again after each auto-respawn.
function attachPtyHandlers(sessionId, ptyProc, tool, env, cachedLaunch) {
  ptyProc.onData((data) => {
    const sess = cliSessions.get(sessionId);
    if (sess) {
      sess.scrollback.push(data);
      sess.scrollbackBytes += Buffer.byteLength(data, 'utf8');
      sess.lastActive = Date.now();
      while (sess.scrollbackBytes > SCROLLBACK_MAX_BYTES && sess.scrollback.length > 0) {
        const oldest = sess.scrollback.shift();
        sess.scrollbackBytes -= Buffer.byteLength(oldest, 'utf8');
      }
      if (sess.sender && !sess.sender.isDestroyed()) {
        sess.sender.send('cli:data', { sessionId, data });
      }

      // ── OAuth re-auth detection ──────────────────────────────────
      // Claude CLI prints an auth URL when the refresh token expires.
      // We catch it, open the browser automatically, and notify the renderer
      // so it can show a non-blocking banner — no manual terminal action needed.
      if (!sess.authDetectBuf) sess.authDetectBuf = '';
      sess.authDetectBuf = (sess.authDetectBuf + data).slice(-4096);
      const authMatch = sess.authDetectBuf.match(CLAUDE_AUTH_URL_RE);
      if (authMatch && !sess.pendingAuthUrl) {
        sess.pendingAuthUrl = authMatch[0];
        // Open in the user's default browser so the admin can complete OAuth
        try { shell.openExternal(sess.pendingAuthUrl); } catch (_) {}
        if (sess.sender && !sess.sender.isDestroyed()) {
          sess.sender.send('cli:auth-required', {
            sessionId,
            url: sess.pendingAuthUrl,
          });
        }
        // Allow re-detection after 10 minutes in case the first attempt failed
        setTimeout(() => {
          const s = cliSessions.get(sessionId);
          if (s) s.pendingAuthUrl = null;
        }, 10 * 60 * 1000);
      }
    }
    // Only relay PTY data to the backend (mobile companion) when a mobile client
    // is actually connected. This eliminates HTTP overhead during normal IDE use.
    if (backendPort && _mobileClientCount > 0) {
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

  ptyProc.onExit((exitEvent) => {
    const sess = cliSessions.get(sessionId);
    if (!sess) return;

    // Clean exit (/exit command) or explicit kill → notify and remove
    if (sess.explicitlyTerminated || exitEvent.exitCode === 0) {
      if (sess.sender && !sess.sender.isDestroyed()) {
        sess.sender.send('cli:exit', { sessionId, ...exitEvent });
      }
      cliSessions.delete(sessionId);
      return;
    }

    // Crash / unexpected exit → auto-respawn with exponential backoff
    const MAX_RESPAWNS = 5;
    if (sess.respawnCount >= MAX_RESPAWNS) {
      const msg = `\r\n\x1b[31m  [Claude crashed ${MAX_RESPAWNS} times — giving up. Re-select the tool to restart.]\x1b[0m\r\n`;
      sess.scrollback.push(msg);
      if (sess.sender && !sess.sender.isDestroyed()) {
        sess.sender.send('cli:data', { sessionId, data: msg });
        sess.sender.send('cli:exit', { sessionId, ...exitEvent });
      }
      cliSessions.delete(sessionId);
      return;
    }

    sess.respawnCount += 1;
    const delayMs = Math.min(1000 * Math.pow(2, sess.respawnCount - 1), 30000);
    const notif = `\r\n\x1b[33m  [Claude exited (code ${exitEvent.exitCode}) — restarting in ${delayMs / 1000}s (${sess.respawnCount}/${MAX_RESPAWNS})]\x1b[0m\r\n`;
    sess.scrollback.push(notif);
    if (sess.sender && !sess.sender.isDestroyed()) {
      sess.sender.send('cli:data', { sessionId, data: notif });
    }

    setTimeout(() => {
      const sessNow = cliSessions.get(sessionId);
      if (!sessNow || sessNow.explicitlyTerminated) return;

      // Use cached launch config from initial spawn for consistency.
      // This prevents a different path resolution on respawn.
      const launch = sessNow.cachedLaunch || getCliLaunchConfig(tool);
      console.log(`[cli-respawn] Using launch config for respawn ${sessNow.respawnCount}:`, JSON.stringify({
        file: launch.file, args: Array.isArray(launch.args) ? launch.args.join('|') : launch.args, fileExists: launch.file ? _exeExists(launch.file) : null
      }));

      // Verify the executable exists before attempting spawn
      if (launch.file && !_exeExists(launch.file)) {
        const errMsg = `\r\n\x1b[31m  [Respawn failed: executable not found: ${launch.file}]\x1b[0m\r\n`;
        console.error(`[cli-respawn] Executable not found: ${launch.file}`);
        sessNow.scrollback.push(errMsg);
        if (sessNow.sender && !sessNow.sender.isDestroyed()) {
          sessNow.sender.send('cli:data', { sessionId, data: errMsg });
          sessNow.sender.send('cli:exit', { sessionId, ...exitEvent });
        }
        cliSessions.delete(sessionId);
        return;
      }

      try {
        const newPty = pty.spawn(launch.file, launch.args, {
          name: 'xterm-color',
          cols: 120,
          rows: 32,
          cwd: sessNow.cwd,
          env,
        });
        sessNow.ptyProcess = newPty;
        attachPtyHandlers(sessionId, newPty, tool, env, launch);

        if (launch.bootstrapInput) {
          setTimeout(() => { try { newPty.write(launch.bootstrapInput); } catch (_) {} }, 250);
        }

        const ok = `\r\n\x1b[32m  [Claude restarted]\x1b[0m\r\n`;
        sessNow.scrollback.push(ok);
        if (sessNow.sender && !sessNow.sender.isDestroyed()) {
          sessNow.sender.send('cli:data', { sessionId, data: ok });
        }
      } catch (e) {
        const sessErr = cliSessions.get(sessionId);
        if (sessErr) {
          const errMsg = `\r\n\x1b[31m  [Respawn failed: ${e.message}]\x1b[0m\r\n`;
          console.error(`[cli-respawn] Spawn exception: ${e.message}`);
          sessErr.scrollback.push(errMsg);
          if (sessErr.sender && !sessErr.sender.isDestroyed()) {
            sessErr.sender.send('cli:data', { sessionId, data: errMsg });
            sessErr.sender.send('cli:exit', { sessionId, ...exitEvent });
          }
        }
        cliSessions.delete(sessionId);
      }
    }, delayMs);
  });
}

const CLI_INSTALL_STATE_PATH = path.join(userDataPath, 'cli-install-state.json');

function _readCliInstallState() {
  try {
    if (!fs.existsSync(CLI_INSTALL_STATE_PATH)) return {};
    const raw = fs.readFileSync(CLI_INSTALL_STATE_PATH, 'utf-8');
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) { return {}; }
}

function _writeCliInstallState(patch = {}) {
  try {
    const prev = _readCliInstallState();
    const next = { ...prev, ...patch };
    fs.mkdirSync(path.dirname(CLI_INSTALL_STATE_PATH), { recursive: true });
    fs.writeFileSync(CLI_INSTALL_STATE_PATH, JSON.stringify(next, null, 2), 'utf-8');
  } catch (_) {}
}

async function ensureCliToolsInstalled() {
  if (cliToolsInstallInProgress) {
    console.log('[cli-install] Installation already in progress, skipping duplicate call.');
    return;
  }
  cliToolsInstallInProgress = true;

  // Check persistent install state to avoid infinite reinstall loops
  const state = _readCliInstallState();
  const lastAttempt = state.lastAttempt || 0;
  const attempts = state.attempts || 0;
  const cooldownMs = 30 * 1000; // 30 seconds between retry attempts

  if (attempts >= CLI_TOOLS_INSTALL_MAX_RETRIES && lastAttempt > 0 && (Date.now() - lastAttempt) < 60000) {
    console.warn(`[cli-install] Max retries (${CLI_TOOLS_INSTALL_MAX_RETRIES}) reached within 60s, skipping.`);
    cliToolsInstallInProgress = false;
    return;
  }

  updateSplash('Checking Claude and Codex CLI tools...');
  ensureCliPaths(process.env);
  try { fs.mkdirSync(cliToolsPrefixDir, { recursive: true }); } catch (_) {}

  let npmCommand = null;
  try {
    await runFile(getNpmCommand(), ['--version'], { timeout: 10000, env: { ...process.env } });
    npmCommand = getNpmCommand();
    console.log(`[cli-install] npm command resolved: ${npmCommand}`);
  } catch (_) {
    console.log('[cli-install] npm not found on PATH, trying embedded node...');
  }

  // If npm is missing, download a portable Node.js runtime (includes npm).
  if (!npmCommand) {
    const nodeRoot = await setupEmbeddedNode();
    if (nodeRoot) {
      try {
        prependToPath(nodeRoot, process.env);
        ensureCliPaths(process.env);
        const embeddedNpm = process.platform === 'win32'
          ? path.join(nodeRoot, 'npm.cmd')
          : path.join(nodeRoot, 'npm');
        console.log(`[cli-install] Trying embedded npm: ${embeddedNpm} exists=${_exeExists(embeddedNpm)}`);
        await runFile(embeddedNpm, ['--version'], { timeout: 15000, env: { ...process.env } });
        npmCommand = embeddedNpm;
        console.log('[cli-install] Embedded npm works.');
      } catch (e) {
        console.warn('[cli-install] Embedded npm failed:', e.message);
      }
    }
  }

  const installErrors = [];
  let anyInstalled = false;

  for (const cli of CLI_SPECS) {
    if (!cli.packageName) continue;
    const cliPath = await resolveCommandPathAsync(cli.command);
    if (cliPath && _exeExists(cliPath)) {
      console.log(`[cli-install] ${cli.label} already installed at: ${cliPath}`);
      anyInstalled = true;
      continue;
    }

    if (!npmCommand) {
      const msg = `Skipping ${cli.label} install because npm is unavailable. Install Node.js from https://nodejs.org and restart.`;
      console.warn(`[cli-install] ${msg}`);
      installErrors.push(msg);
      continue;
    }

    updateSplash(`Installing ${cli.label}...`);
    console.log(`[cli-install] Installing ${cli.label} using npm install -g ${cli.packageName} --prefix ${cliToolsPrefixDir}`);
    try {
      await runFile(npmCommand, ['install', '-g', cli.packageName, '--prefix', cliToolsPrefixDir, '--no-audit', '--no-fund'], {
        timeout: 300000,
        env: { ...process.env },
      });
      console.log(`[cli-install] ${cli.label} installed successfully.`);
      anyInstalled = true;
    } catch (err) {
      const msg = `Failed to install ${cli.label}: ${(err.stderr || err.message || '').trim().slice(0, 200)}`;
      console.error(`[cli-install] ${msg}`);
      installErrors.push(msg);
      continue;
    }
    ensureCliPaths(process.env);
    // Clear the cached "not found" entry so subsequent lookups re-check the filesystem.
    _commandPathCache.delete(cli.command);
    // Verify the install worked
    const verifyPath = await resolveCommandPathAsync(cli.command);
    console.log(`[cli-install] ${cli.label} post-install verification: path=${verifyPath} exists=${verifyPath ? _exeExists(verifyPath) : 'N/A'}`);
  }

  if (installErrors.length > 0) {
    updateSplash('Some CLI tools could not be installed. Check the terminal for details.');
    // Give the user a moment to see the warning before the window opens.
    await new Promise(r => setTimeout(r, 3000));
  }

  // Update persistent install state
  _writeCliInstallState({
    lastAttempt: Date.now(),
    attempts: installErrors.length > 0 ? attempts + 1 : 0,
    lastResult: installErrors.length > 0 ? 'failed' : 'success',
    anyInstalled,
    lastErrors: installErrors.slice(0, 3),
  });

  cliToolsInstallFailedCount = installErrors.length > 0 ? cliToolsInstallFailedCount + 1 : 0;
  cliToolsInstallLastResult = installErrors.length > 0 ? 'failed' : 'success';
  cliToolsInstallInProgress = false;

  console.log(`[cli-install] Complete. installed=${anyInstalled} errors=${installErrors.length} failedCount=${cliToolsInstallFailedCount}`);
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

async function findSystemPython() {
  if (_systemPythonCache !== undefined) return _systemPythonCache;

  // On Windows: try 'python', 'python3', then the launcher 'py' with -3 flag.
  // On Mac/Linux: try 'python3' first, then 'python'.
  const candidates = process.platform === 'win32'
    ? [['python', []], ['python3', []], ['py', ['-3']]]
    : [['python3', []], ['python', []]];

  for (const [cmd, extraArgs] of candidates) {
    try {
      const { stdout } = await runFile(cmd, [...extraArgs, '--version'], {
        timeout: 5000, env: { ...process.env },
      });
      const version = (stdout || '').trim();
      if (version.includes('Python 3')) {
        console.log(`Found system Python: ${cmd} (${version})`);
        _systemPythonCache = cmd;
        return _systemPythonCache;
      }
    } catch (_) {}
  }
  _systemPythonCache = null;
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
  try {
    if (process.platform === 'win32') {
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
    } else {
      // macOS / Linux: look for bin/node and bin/npm in the extracted directory
      const binDir = path.join(embeddedNodeDir, 'bin');
      if (fs.existsSync(path.join(binDir, 'node')) && fs.existsSync(path.join(binDir, 'npm'))) return binDir;

      if (!fs.existsSync(embeddedNodeDir)) return null;
      const entries = fs.readdirSync(embeddedNodeDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const candidateBin = path.join(embeddedNodeDir, entry.name, 'bin');
        if (fs.existsSync(path.join(candidateBin, 'node')) && fs.existsSync(path.join(candidateBin, 'npm'))) return candidateBin;
      }
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
  const existing = getEmbeddedNodeRoot();
  if (existing) return existing;

  const isWin = process.platform === 'win32';
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const platform = isWin ? 'win' : 'darwin';
  const ext = isWin ? 'zip' : 'tar.gz';

  console.log(`Setting up embedded Node.js for ${process.platform}...`);
  updateSplash('Setting up Node.js (first-time only)...');

  const version = await getLatestLtsNodeVersion();
  const fileName = `node-${version}-${platform}-${arch}.${ext}`;
  const url = `https://nodejs.org/dist/${version}/${fileName}`;
  const downloadPath = path.join(userDataPath, fileName);

  try {
    fs.mkdirSync(embeddedNodeDir, { recursive: true });

    updateSplash(`Downloading Node.js runtime (${version})...`);
    await downloadFile(url, downloadPath);

    updateSplash('Extracting Node.js...');
    if (isWin) {
      await runFile('powershell', [
        '-Command',
        `Expand-Archive -Path '${downloadPath}' -DestinationPath '${embeddedNodeDir}' -Force`,
      ], { timeout: 600000, env: { ...process.env } });
    } else {
      await runFile('tar', ['-xzf', downloadPath, '-C', embeddedNodeDir], {
        timeout: 600000, env: { ...process.env },
      });
    }

    try { fs.unlinkSync(downloadPath); } catch (_) {}

    const nodeRoot = getEmbeddedNodeRoot();
    if (!nodeRoot) {
      throw new Error(`Embedded Node extraction did not produce ${isWin ? 'node.exe' : 'bin/node'}`);
    }

    console.log('Embedded Node.js setup complete');
    return nodeRoot;
  } catch (err) {
    console.error('Failed to setup embedded Node.js:', err);
    try { fs.rmSync(embeddedNodeDir, { recursive: true, force: true }); } catch (_) {}
    try { fs.unlinkSync(downloadPath); } catch (_) {}
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

    // Extract zip using PowerShell (async, non-blocking)
    updateSplash('Extracting Python...');
    await runFile('powershell', [
      '-Command',
      `Expand-Archive -Path '${zipPath}' -DestinationPath '${embeddedPythonDir}' -Force`,
    ], { timeout: 60000, env: { ...process.env } });

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

    // Install pip (async)
    const newPythonExe = path.join(embeddedPythonDir, 'python.exe');
    await runFile(newPythonExe, [getPipPath, '--no-warn-script-location'], {
      timeout: 120000, cwd: embeddedPythonDir, env: { ...process.env },
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

async function installDependencies(pythonCmd, backendSourceDir) {
  const reqFile = path.join(backendSourceDir, 'requirements.txt');
  if (!fs.existsSync(reqFile)) return;

  // Check if deps already installed by testing a key import
  try {
    await runFile(pythonCmd, ['-c', 'import fastapi; import uvicorn'], {
      timeout: 10000, env: { ...process.env },
    });
    console.log('Dependencies already installed');
    return;
  } catch (_) {
    // Need to install
  }

  console.log('Installing Python dependencies...');
  updateSplash('Installing dependencies (first-time only)...');

  try {
    await runFile(pythonCmd, ['-m', 'pip', 'install', '--no-warn-script-location', '-r', reqFile], {
      timeout: 300000, env: { ...process.env },
    });
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

      // Try system Python first (async — never blocks main process)
      pythonCmd = await findSystemPython();

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

      // Install dependencies if needed (async — never blocks main process)
      try {
        await installDependencies(pythonCmd, backendSourceDir);
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

    // Poll health endpoint — start quickly, retry every 200ms
    const startTime = Date.now();
    const maxWait = 60000;

    const pollHealth = () => {
      if (Date.now() - startTime > maxWait) {
        reject(new Error('Backend failed to start within 60 seconds'));
        return;
      }

      const req = http.get(`http://127.0.0.1:${port}/health`, (res) => {
        if (res.statusCode === 200) {
          resolve();
        } else {
          setTimeout(pollHealth, 200);
        }
      });

      req.on('error', () => {
        setTimeout(pollHealth, 200);
      });

      req.setTimeout(1000, () => {
        req.destroy();
        setTimeout(pollHealth, 200);
      });
    };

    // First check after 100ms — PyInstaller binary is often ready by then
    setTimeout(pollHealth, 100);
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

// Shared BrowserWindow factory — used by both createWindow() and openFolderInProcessWindow().
function _makeBrowserWindow() {
  const win = new BrowserWindow({
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
      webSecurity: isDev,
    },
    icon: getAppIcon(),
    show: false,
  });
  try { Menu.setApplicationMenu(null); } catch (_) {}
  try { win.setMenuBarVisibility(false); win.setMenu(null); } catch (_) {}
  win.webContents.on('will-navigate', (event, url) => {
    try {
      if (!url || typeof url !== 'string') return;
      const isFile = url.startsWith('file://');
      const isDevApp = isDev && (url.startsWith('http://localhost:3000') || url.startsWith('http://127.0.0.1:3000'));
      if (isFile || isDevApp) return;
      event.preventDefault();
      shell.openExternal(url);
    } catch (_) {}
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  return win;
}

function createWindow() {
  const win = _makeBrowserWindow();
  mainWindow = win;

  if (isDev) {
    win.loadURL('http://localhost:3000');
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(__dirname, '..', 'frontend', 'build', 'index.html'));
  }

  const showWindow = () => {
    closeSplash();
    win.show();
    win.focus();
  };

  const fallbackTimer = setTimeout(showWindow, 4000);

  win.once('ready-to-show', () => {
    clearTimeout(fallbackTimer);
    showWindow();
  });

  win.webContents.on('did-fail-load', (_event, _code, _desc, _url, isMainFrame) => {
    if (!isMainFrame) return;
    clearTimeout(fallbackTimer);
    showWindow();
  });

  win.webContents.on('did-finish-load', () => {
    if (pendingAuthCallbackUrl) handleAuthCallbackUrl(pendingAuthCallbackUrl);
  });

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
}

// Windows: open a folder in a new in-process BrowserWindow rather than spawning
// a second Electron process. Spawning on Windows is unreliable because Chromium
// places a lockfile in the shared userData directory, causing the second instance
// to crash silently before its window appears.
function openFolderInProcessWindow(folderPath, prevWindow) {
  try {
    const win = _makeBrowserWindow();

    // Register startup folder so app:get-startup-folder IPC returns it for this window.
    if (folderPath) {
      windowStartupFolders.set(win.webContents.id, folderPath);
      setCurrentProjectRoot(folderPath);
    }

    // Notify the running backend of the new project root so the new
    // window's frontend loads the correct file tree.
    if (folderPath && backendPort) {
      try {
        const qpath = encodeURIComponent(folderPath);
        const req = http.request(
          { hostname: '127.0.0.1', port: backendPort, path: `/files/open-folder?path=${qpath}`, method: 'POST', headers: { 'Content-Length': 0 } },
          (res) => { res.resume(); },
        );
        req.on('error', () => {});
        req.end();
      } catch (_) {}
    }

    // Promote to main window before loading so IPC events (backend:ready, etc.)
    // route to the new window from this point on.
    mainWindow = win;

    if (isDev) {
      win.loadURL('http://localhost:3000');
    } else {
      win.loadFile(path.join(__dirname, '..', 'frontend', 'build', 'index.html'));
    }

    win.webContents.on('did-finish-load', () => {
      if (pendingAuthCallbackUrl) handleAuthCallbackUrl(pendingAuthCallbackUrl);
    });

    win.once('ready-to-show', () => {
      win.show();
      win.focus();
      // Close the old window only after the new one is visible — no white flash.
      setTimeout(() => {
        try { if (prevWindow && !prevWindow.isDestroyed()) prevWindow.close(); } catch (_) {}
      }, 300);
    });

    win.on('closed', () => {
      if (mainWindow === win) mainWindow = null;
    });

    return { ok: true, inProcess: true };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
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
  event.returnValue = { apiUrl, authUrl, isProduction, appVersion: app.getVersion() };
});

ipcMain.handle('get-platform', () => {
  return process.platform;
});

ipcMain.handle('auth:read-disk', () => readPersistedAuth());
ipcMain.handle('auth:write-disk', (_event, payload) => writePersistedAuth(payload || {}));
ipcMain.handle('auth:clear-disk', () => {
  clearPersistedAuth();
  return { ok: true };
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

// Explorer listing via Node fs — same caps as backend/file_manager._list_dir.
// Avoids HTTP + Python + auth on every expand so the desktop app matches web
// (File System Access API) responsiveness for directory reads.
const _FS_SCAN_HARD_CAP = 3000;
const _FS_MAX_FILE_LIST = 2000;

function _resolveSafeProjectSubdir(rootRaw, relPathRaw) {
  const root = path.resolve(rootRaw);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return null;
  const rel = String(relPathRaw || '').replace(/\\/g, '/').split('/').filter(Boolean);
  let cur = root;
  for (const seg of rel) {
    if (seg === '..') return null;
    cur = path.join(cur, seg);
  }
  const resolved = path.resolve(cur);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (resolved !== root && !resolved.startsWith(rootWithSep)) return null;
  try {
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) return null;
  } catch (_) {
    return null;
  }
  return resolved;
}

function _listDirNative(absDir, showHidden) {
  const dirs = [];
  const files = [];
  let count = 0;
  let entries;
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch (_) {
    return [];
  }
  for (const ent of entries) {
    count += 1;
    if (count > _FS_SCAN_HARD_CAP) break;
    if (!showHidden && ent.name.startsWith('.')) continue;
    try {
      if (ent.isDirectory()) dirs.push(ent.name);
      else if (ent.isFile()) files.push(ent.name);
    } catch (_) {
      /* ignore broken symlinks / permission */
    }
  }
  dirs.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  files.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  const items = [];
  for (const name of dirs.slice(0, _FS_MAX_FILE_LIST)) {
    items.push({ name, type: 'folder', children: [], hasChildren: true });
  }
  const remaining = _FS_MAX_FILE_LIST - items.length;
  for (const name of files.slice(0, remaining)) {
    items.push({ name, type: 'file', size: 0 });
  }
  return items;
}

ipcMain.handle('fs:list-project-dir', async (_event, payload) => {
  const relPath = payload && typeof payload.relPath === 'string' ? payload.relPath : '';
  const showHidden = !!(payload && payload.showHidden);
  const root = currentProjectRoot;
  if (!root) return [];
  const abs = _resolveSafeProjectSubdir(root, relPath);
  if (!abs) return [];
  return _listDirNative(abs, showHidden);
});

ipcMain.handle('app:new-window', () => spawnNewAppInstance());

ipcMain.handle('app:get-startup-folder', (event) => {
  // In-process new windows (Windows): folder was registered in windowStartupFolders.
  const perWindowFolder = windowStartupFolders.get(event.sender.id);
  if (perWindowFolder) {
    windowStartupFolders.delete(event.sender.id); // consume once
    return perWindowFolder;
  }
  // Out-of-process new windows (macOS/Linux): folder arrives via CLI flag.
  return NEBULA_OPEN_FOLDER || null;
});

/** Open a folder in a brand-new window and close this one after the new one launches. */
ipcMain.handle('app:open-in-new-window', (_event, folderPath) => {
  const prevWindow = mainWindow; // capture before mainWindow may change
  const result = spawnNewAppInstance(folderPath, prevWindow);
  if (result.ok && !result.inProcess) {
    // Out-of-process spawn (macOS/Linux): give the new process ~1.5s to start,
    // then close this window. For in-process windows (Windows), openFolderInProcessWindow
    // closes prevWindow itself once ready-to-show fires.
    setTimeout(() => {
      try { if (prevWindow && !prevWindow.isDestroyed()) prevWindow.close(); } catch (_) {}
    }, 1500);
  }
  return result;
});

ipcMain.handle('term:start', async (event, payload) => {
  try {
    const sessionId = (payload && payload.sessionId) || `iterm-${Date.now()}`;
    if (integratedTermSessions.has(sessionId)) {
      return { ok: false, error: 'session_already_exists' };
    }
    const shell = (payload && payload.shell) || (process.platform === 'win32' ? 'powershell' : 'zsh');
    const cols = Math.max(20, Math.min(512, parseInt(payload && payload.cols, 10) || 80));
    const rows = Math.max(10, Math.min(256, parseInt(payload && payload.rows, 10) || 24));
    let cwd = payload && typeof payload.cwd === 'string' ? payload.cwd.trim() : '';
    if (!cwd || !fs.existsSync(cwd)) {
      cwd = (currentProjectRoot && fs.existsSync(currentProjectRoot)) ? currentProjectRoot : app.getPath('home');
    }
    const launch = getIntegratedTerminalLaunch(shell);
    const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
    if (process.platform === 'win32') {
      const sr = process.env.SystemRoot || 'C:\\Windows';
      if (!env.SystemRoot) env.SystemRoot = sr;
      if (!env.PATHEXT) env.PATHEXT = '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC';
      if (!env.ComSpec) env.ComSpec = path.join(sr, 'System32', 'cmd.exe');
    }
    const ptyProcess = pty.spawn(launch.file, launch.args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env,
    });
    const sender = event.sender;
    integratedTermSessions.set(sessionId, { ptyProcess, sender, cwd, shell });
    ptyProcess.onData((data) => {
      const sess = integratedTermSessions.get(sessionId);
      if (sess?.sender && !sess.sender.isDestroyed()) {
        try {
          sess.sender.send('term:data', { sessionId, data });
        } catch (_) {}
      }
    });
    ptyProcess.onExit(() => {
      integratedTermSessions.delete(sessionId);
      try {
        if (sender && !sender.isDestroyed()) sender.send('term:exit', { sessionId });
      } catch (_) {}
    });
    return { ok: true, sessionId };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
});

ipcMain.handle('term:write', (event, sessionId, data) => {
  const sess = integratedTermSessions.get(sessionId);
  if (!sess?.ptyProcess) return { ok: false };
  try {
    sess.ptyProcess.write(typeof data === 'string' ? data : String(data));
    return { ok: true };
  } catch (_) {
    return { ok: false };
  }
});

ipcMain.handle('term:resize', (event, sessionId, cols, rows) => {
  const sess = integratedTermSessions.get(sessionId);
  if (!sess?.ptyProcess) return { ok: false };
  try {
    sess.ptyProcess.resize(
      Math.max(20, cols || 80),
      Math.max(10, rows || 24),
    );
    return { ok: true };
  } catch (_) {
    return { ok: false };
  }
});

ipcMain.handle('term:kill', (event, sessionId) => {
  const sess = integratedTermSessions.get(sessionId);
  if (!sess) return { ok: false };
  try {
    sess.ptyProcess.kill();
  } catch (_) {}
  integratedTermSessions.delete(sessionId);
  return { ok: true };
});

ipcMain.handle('fs:read-project-file', async (_event, relPath) => {
  const root = currentProjectRoot;
  if (!root) return { ok: false, error: 'no_workspace' };
  const rel = String(relPath || '').replace(/\\/g, '/').split('/').filter(Boolean);
  let cur = path.resolve(root);
  for (const seg of rel) {
    if (seg === '..') return { ok: false, error: 'invalid_path' };
    cur = path.join(cur, seg);
  }
  const abs = path.resolve(cur);
  const rootRes = path.resolve(root);
  const rootWithSep = rootRes.endsWith(path.sep) ? rootRes : rootRes + path.sep;
  if (abs !== rootRes && !abs.startsWith(rootWithSep)) {
    return { ok: false, error: 'invalid_path' };
  }
  try {
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      return { ok: false, error: 'not_file' };
    }
    const size = fs.statSync(abs).size;
    if (size > 2 * 1024 * 1024) {
      return { ok: false, error: 'too_large' };
    }
    return { ok: true, content: fs.readFileSync(abs, 'utf8') };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
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
  // Ensure credentials are ready before spawning.
  // If the admin ran `claude login`, the bundle check is a no-op (returns
  // already-installed immediately). If no host login exists, the bundle
  // installs its own credentials as a fallback.
  let _tokenResult = { ok: false };

  // ── Phase 1: Ensure on-disk credentials exist ──────────────────────────
  // The shipped credential bundle (cli-bundle) is the first source. If it
  // fails (e.g. KEK not embedded in dev builds), fall back to the backend
  // which may have been seeded via CLAUDE_INITIAL_REFRESH_TOKEN or the Admin
  // Panel.
  try {
    if (!cliBundleReadyPromise) {
      try { cliBundle.init(app); } catch (_) {}
      cliBundleReadyPromise = cliBundle.ensureInstalled().catch((err) => ({
        ok: false, errorCode: 'BUNDLE_UNKNOWN', message: err?.message || String(err),
      }));
    }
    const bundleRes = await cliBundleReadyPromise;
    if (!bundleRes || bundleRes.ok !== true) {
      // If the admin has run `claude login`, credentials are on disk and the
      // bundle is irrelevant — proceed anyway.
      const { claudeCreds } = (cliBundle.getStatus() || {}).files || {};
      if (!claudeCreds) {
        // Bundle failed and no disk credentials — try the backend before giving up.
        // The backend may have been seeded via CLAUDE_INITIAL_REFRESH_TOKEN or
        // the Admin Panel, even when the shipped bundle can't be decrypted.
        console.warn('[cli-bundle] Bundle install failed, trying backend for credentials...');
        try {
          _tokenResult = await _applyFreshClaudeToken();
        } catch (_) {}
        if (!_tokenResult.ok) {
          return {
            ok: false,
            installed: false,
            message: 'No Claude credentials found. Run `claude login` in a terminal, or use Admin → Repair CLI Credentials.',
            bundleError: bundleRes || null,
          };
        }
        // Backend had credentials — they've been written to disk by _applyFreshClaudeToken.
        console.log('[cli-bundle] Credentials obtained from backend, proceeding.');
      }
    }
  } catch (e) {
    return {
      ok: false,
      installed: false,
      message: `Credential check failed: ${e?.message || String(e)}`,
    };
  }

  // ── Phase 2: Refresh the on-disk access token ──────────────────────────
  // Fetch a fresh access token from the backend and patch it on disk so Claude
  // CLI never starts against an expired token.
  if (!_tokenResult.ok) {
    _tokenResult = await _applyFreshClaudeToken();
  }
  if (!_tokenResult.ok) {
    // Check if the refresh token itself is dead (auth failure vs network error)
    const isAuthFailure = _tokenResult.authFailure === true ||
      (_tokenResult.error && _tokenResult.error.includes('TOKEN_REFRESH_AUTH_FAILED'));

    if (cliBundle.isAccessTokenExpired() || isAuthFailure) {
      const msg = isAuthFailure
        ? `Claude credentials have expired and cannot be refreshed (the refresh token was rejected). Please run \`claude login\` in a terminal to re-authenticate, or ask your Nebula admin to reseed the master credentials.`
        : `Claude credentials are expired and could not be refreshed from the server (${_tokenResult.error || 'server unreachable'}). Open the Admin panel → Repair CLI auth, or ask your Nebula administrator to reseed the master credentials.`;
      return {
        ok: false,
        installed: true,
        authFailure: isAuthFailure,
        message: msg,
      };
    }
    // Access token is not yet expired — let Claude CLI proceed; it can use the
    // token as-is or refresh with its own refresh token.
    console.warn('[claude-token] Backend refresh failed but access token is still valid, proceeding.');
  }

  let launch = getCliLaunchConfig(tool);

  if (!launch.installed) {
    // Try to install in the background (first launch may not have npm on PATH).
    if (launch.packageName) {
      // Prevent infinite reinstall loop: if we've already tried and failed
      // too many times, tell the user and stop.
      if (cliToolsInstallFailedCount >= CLI_TOOLS_INSTALL_MAX_RETRIES) {
        return {
          ok: false,
          installed: false,
          message: `${launch.label} installation failed after ${CLI_TOOLS_INSTALL_MAX_RETRIES} attempts. Open a terminal and run: npm install -g ${launch.packageName}`,
          shell: launch.shellLabel,
        };
      }

      // Only kick off install if not already running or if last result was not a failure
      if (!cliToolsInstallPromise) {
        if (cliToolsInstallLastResult !== 'failed') {
          cliToolsInstallPromise = ensureCliToolsInstalled()
            .catch(() => {})
            .finally(() => { cliToolsInstallPromise = null; });
        }
      }
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
  const env = { ...process.env, TERM: 'xterm-256color' };

  // Auth priority (highest → lowest):
  //
  //  1. ANTHROPIC_API_KEY in the system environment — a real API key never
  //     expires and requires zero maintenance. If the admin has set one, use
  //     it and leave all env vars intact.
  //
  //  2. On-disk credentials from `claude login` — Claude CLI handles silent
  //     token refresh automatically. alreadyInstalled() now preserves these
  //     so the bundle never overwrites a prior `claude login`.
  //
  //  3. Bundled credentials (cli-bundle fallback) — only used on machines
  //     where neither of the above exists.
  //
  // In cases 2 and 3 we strip env-var keys so the CLI reads from disk
  // instead of a stale env var.
  const hasExplicitApiKey = !!(
    process.env.ANTHROPIC_API_KEY
    || process.env.ANTHROPIC_AUTH_TOKEN
    || process.env.CLAUDE_CODE_OAUTH_TOKEN
  );
  if (!hasExplicitApiKey) {
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

  // Store the launch config for respawn (avoids path re-resolution inconsistency)
  const cachedLaunch = Object.freeze({ ...launch, args: [...(launch.args || [])] });

  cliSessions.set(sessionId, {
    ptyProcess: ptyProcessRef,
    sender: event.sender,
    scrollback: [],
    scrollbackBytes: 0,
    tool,
    cwd,
    env,
    createdAt: Date.now(),
    lastActive: Date.now(),
    detached: false,
    lastDetached: 0,
    respawnCount: 0,
    explicitlyTerminated: false,
    cachedLaunch,
  });

  attachPtyHandlers(sessionId, ptyProcessRef, tool, env, cachedLaunch);

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
  // Detach the renderer without killing the PTY — page refresh path.
  // The PTY stays alive so the client can reattach on reconnect.
  const sess = cliSessions.get(sessionId);
  if (sess) {
    sess.sender = null;
    sess.detached = true;
    sess.lastDetached = Date.now();
  }
  return { ok: true };
});

ipcMain.handle('cli:reattach', (event, sessionId) => {
  const sess = cliSessions.get(sessionId);
  if (!sess) return { ok: false };
  sess.sender = event.sender;
  sess.detached = false;
  sess.lastActive = Date.now();
  return { ok: true, sessionId, scrollback: [...sess.scrollback] };
});

ipcMain.handle('cli:terminate', (_event, sessionId) => {
  closeCliSession(sessionId);
  return { ok: true };
});

ipcMain.handle('cli:list', () => {
  return Array.from(cliSessions.entries()).map(([id, sess]) => ({
    sessionId: id,
    tool: sess.tool,
    detached: sess.detached,
    createdAt: sess.createdAt,
    lastActive: sess.lastActive,
  }));
});

// Reap sessions that have been orphaned for more than 30 minutes
setInterval(() => {
  const ORPHAN_TIMEOUT_MS = 30 * 60 * 1000;
  const now = Date.now();
  for (const [id, sess] of cliSessions) {
    if (sess.detached && (now - sess.lastDetached) > ORPHAN_TIMEOUT_MS) {
      try { sess.ptyProcess.kill(); } catch (_) {}
      cliSessions.delete(id);
    }
  }
}, 60 * 1000);

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

    // Restore last opened folder for normal launches only (not extra windows).
    try {
      if (NEBULA_OPEN_FOLDER) {
        // New window was spawned to open a specific project — use that path.
        setCurrentProjectRoot(NEBULA_OPEN_FOLDER);
      } else if (!NEBULA_FRESH_WINDOW) {
        const s = readSessionState();
        const last = s && typeof s.lastProjectRoot === 'string' ? s.lastProjectRoot.trim() : '';
        if (last) setCurrentProjectRoot(last);
      }
    } catch (_) {}

    // Ensure the CLI tools exist before the backend/terminal sessions use them.
    // We await this before createWindow() so the CLI is ready when the UI loads.
    let cliInstallDone = cliToolsInstallPromise;
    if (!cliInstallDone) {
      const state = _readCliInstallState();
      // If persistent state says install succeeded, don't re-install at startup
      if (state.lastResult === 'success') {
        console.log('[cli-install] Skipping startup install — last result was success.');
        // Still warm the cache
        cliInstallDone = prewarmCommandCache().catch(() => {});
      } else {
        const p = ensureCliToolsInstalled()
          .catch(() => {})
          .finally(() => { cliToolsInstallPromise = null; });
        cliToolsInstallPromise = p;
        cliInstallDone = p;
      }
    }
    // Block window creation until CLI tools are installed (splash shows progress).
    await cliInstallDone;

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

        // After the bundle is settled, run a credential freshness check.
        // This detects the rare case where the OAuth refresh token itself has
        // expired (months/years after install). We warn the renderer so the
        // admin sees a notification before users hit a login prompt.
        _scheduleCredentialFreshnessCheck();

        // Start the 45-minute background loop that keeps the on-disk access
        // token fresh via the backend. This means users are never prompted to
        // log in regardless of how long the app stays open.
        _startClaudeTokenRefreshLoop();

        // Watch the on-disk credentials file so that if the developer runs
        // Claude CLI in a separate terminal and Anthropic rotates the refresh
        // token, we automatically sync the new token to MongoDB.
        _startCredentialWatcher();

        return res;
      }).catch((err) => {
        console.error('[cli-bundle] unexpected error:', err);
        return { ok: false, errorCode: 'BUNDLE_UNKNOWN', message: err?.message || String(err) };
      });
    } catch (e) {
      console.error('[cli-bundle] init failed:', e);
      cliBundleReadyPromise = Promise.resolve({ ok: false, errorCode: 'BUNDLE_INIT_FAIL', message: e?.message || String(e) });
    }

    // Find a free port — must happen before createWindow so preload IPC works
    backendPort = await findFreePort();
    console.log(`Using port ${backendPort} for backend`);

    // Start npm prefix resolution in background immediately (avoids blocking CLI launch later)
    getNpmGlobalBinDirAsync().then(dir => {
      if (dir) prependToPath(dir, process.env);
    }).catch(() => {});

    // Pre-warm command cache for all CLI tools so
    // commandExists() / resolveCommandPath() never fall back to execSync.
    await prewarmCommandCache().catch(() => {});

    // Create the window immediately — React app will show a loading state while
    // waiting for backend readiness. This gives instant perceived startup.
    createWindow();

    // Start the backend in parallel — the frontend retries requests until it's up
    startBackend(backendPort, currentProjectRoot).then(async () => {
      console.log('Backend started successfully');

      // Notify renderer that the backend is ready (triggers tree/workspace refresh)
      try {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('backend:ready', { port: backendPort });
        }
      } catch (_) {}

      // Sync bundle credentials to backend so MongoDB matches the installed bundle.
      // This prevents a pre-seeded backend from later overwriting disk with different
      // account credentials.
      try {
        const bundleRes = await cliBundleReadyPromise;
        if (bundleRes && bundleRes.ok) {
          await _syncBundleCredentialsToBackend();
          // Immediately fetch a fresh token from the backend. This enriches the
          // on-disk credentials with fields from MongoDB that the build machine's
          // file didn't have (e.g. scopes, subscriptionType, rateLimitTier).
          try {
            await _applyFreshClaudeToken();
          } catch (_) {}
        }
      } catch (_) {}
    }).catch((err) => {
      console.error('Failed to start backend:', err);
      try {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('backend:error', { message: err.message });
        }
      } catch (_) {}
    });

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
          // Track connected mobile client count to gate PTY relay overhead
          _mobileClientCount = (typeof data.client_count === 'number') ? data.client_count : 0;
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

// ─── Auto-Update (electron-updater) ─────────────────────────────────────────

// Simple semver comparison (no extra dependency needed).
function _semverGt(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return true;
    if (pa[i] < pb[i]) return false;
  }
  return false;
}

// Fallback: hit the GitHub Releases API directly to detect a newer version when
// electron-updater can't (draft releases, missing latest.yml, private repo, etc.).
// If a newer version is found, fires update:available with manualDownload:true so
// the renderer shows a "Download" link instead of waiting for auto-install.
function _githubReleaseFallback(send, ghToken) {
  const https = require('https');
  const currentVersion = app.getVersion();
  const headers = {
    'User-Agent': `Nebula-IDE/${currentVersion}`,
    'Accept': 'application/vnd.github+json',
  };
  if (ghToken) headers['Authorization'] = `Bearer ${ghToken}`;

  return new Promise((resolve) => {
    const req = https.get(
      { hostname: 'api.github.com', path: `/repos/${process.env.GITHUB_OWNER || 'j-praneeth'}/${process.env.GITHUB_REPO || 'ai-ide'}/releases/latest`, headers },
      (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try {
            if (res.statusCode === 200) {
              const release = JSON.parse(data);
              const latestVer = String(release.tag_name || '').replace(/^v/i, '');
              if (latestVer && _semverGt(latestVer, currentVersion)) {
                console.log(`[updater] GitHub API: newer version ${latestVer} > ${currentVersion}`);
                send('update:available', {
                  version: latestVer,
                  releaseNotes: release.body || '',
                  downloadUrl: release.html_url,
                  manualDownload: true,
                });
                resolve(true);
                return;
              }
              console.log(`[updater] GitHub API: up to date (latest=${latestVer}, installed=${currentVersion})`);
            } else {
              console.log(`[updater] GitHub API: HTTP ${res.statusCode}`);
            }
          } catch (e) {
            console.log('[updater] GitHub API parse error:', e.message);
          }
          resolve(false);
        });
      },
    );
    req.on('error', (e) => { console.log('[updater] GitHub API request error:', e.message); resolve(false); });
    req.setTimeout(10000, () => { req.destroy(); resolve(false); });
  });
}

function _initAutoUpdater() {
  let autoUpdater;
  try {
    autoUpdater = require('electron-updater').autoUpdater;
  } catch (e) {
    console.log('[updater] electron-updater not available — using GitHub API fallback only');
    // Still register the IPC handlers so the renderer's "Check for Updates" works
    const send = (ch, p) => {
      try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(ch, p); } catch (_) {}
    };
    ipcMain.handle('update:check', async () => {
      send('update:checking', null);
      const found = await _githubReleaseFallback(send, '');
      if (!found) send('update:not-available', null);
    });
    ipcMain.handle('update:restart-and-install', () => {});
    return;
  }

  // Read optional GH token (for private repo access).
  let ghToken = process.env.GH_TOKEN || process.env.GH_REPO_TOKEN || '';
  if (!ghToken) {
    try {
      const cfgPath = path.join(process.resourcesPath || '', 'update-config.json');
      if (fs.existsSync(cfgPath)) {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
        if (cfg.githubToken) ghToken = cfg.githubToken;
      }
    } catch (_) {}
  }
  if (ghToken) process.env.GH_TOKEN = ghToken;

  // Always set feedURL explicitly — avoids falling back to releases.atom which
  // returns 404 for private repos or repos with no releases.
  try {
    const feedConfig = { provider: 'github', owner: process.env.GITHUB_OWNER || 'j-praneeth', repo: process.env.GITHUB_REPO || 'ai-ide' };
    if (ghToken) { feedConfig.private = true; feedConfig.token = ghToken; }
    autoUpdater.setFeedURL(feedConfig);
    console.log('[updater] feedURL configured — token:', ghToken ? 'yes' : 'no');
  } catch (_) {}

  autoUpdater.autoDownload = true;
  // Disable auto-install — we handle macOS manually (ditto fails on ad-hoc signed apps)
  autoUpdater.autoInstallOnAppQuit = false;
  let _downloadedPath = null;

  const send = (channel, payload) => {
    try {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
    } catch (_) {}
  };

  autoUpdater.on('checking-for-update', () => send('update:checking', null));

  // update-available: electron-updater found a newer latest.yml — auto-download starts.
  autoUpdater.on('update-available', (info) => send('update:available', info));

  // update-not-available: latest.yml matched current version. Run GitHub API fallback
  // to catch cases where a newer published release exists but latest.yml wasn't refreshed.
  autoUpdater.on('update-not-available', (info) => {
    _githubReleaseFallback(send, ghToken).then(found => {
      if (!found) send('update:not-available', info);
    });
  });

  autoUpdater.on('download-progress', (prog) => send('update:download-progress', prog));

  autoUpdater.on('update-downloaded', (info) => {
    _downloadedPath = info.downloadedFile || null;
    // Strip quarantine on the DMG itself
    if (process.platform === 'darwin' && _downloadedPath) {
      try { execSync(`xattr -dr com.apple.quarantine "${_downloadedPath}"`, { stdio: 'pipe' }); } catch (_) {}
    }
    send('update:downloaded', info);
  });

  autoUpdater.on('error', (err) => {
    const msg = err?.message || String(err);
    // 404 / network errors mean electron-updater couldn't reach latest.yml.
    // Run GitHub API fallback before telling the renderer "no update".
    if (/404|net::ERR_|ENOTFOUND|ECONNREFUSED|ETIMEDOUT/.test(msg)) {
      console.log('[updater] latest.yml unreachable — running GitHub API fallback:', msg);
      _githubReleaseFallback(send, ghToken).then(found => {
        if (!found) send('update:not-available', null);
      });
      return;
    }
    console.error('[updater] error:', msg);
    send('update:error', { message: msg });
  });

  ipcMain.handle('update:check', async () => {
    send('update:checking', null);
    try {
      const result = await autoUpdater.checkForUpdates();
      // checkForUpdates() returns null when it can't reach the feed at all
      // (no network, no releases). Run fallback in that case.
      if (!result) {
        const found = await _githubReleaseFallback(send, ghToken);
        if (!found) send('update:not-available', null);
      }
    } catch (e) {
      const msg = e?.message || String(e);
      console.log('[updater] checkForUpdates threw:', msg);
      const found = await _githubReleaseFallback(send, ghToken);
      if (!found) {
        if (!/404|net::ERR_|ENOTFOUND|ECONNREFUSED|ETIMEDOUT/.test(msg)) {
          send('update:error', { message: msg });
        } else {
          send('update:not-available', null);
        }
      }
    }
  });

  ipcMain.handle('update:restart-and-install', () => {
    // macOS manual install: bypasses ditto entirely (ditto fails with "Couldn't read PKZip
    // Signature" on quarantined files). We strip quarantine first, then extract manually.
    if (process.platform === 'darwin' && _downloadedPath) {
      const ext = path.extname(_downloadedPath).toLowerCase();
      const tmpBase = `/tmp/nebula-update-${Date.now()}`;

      // Always strip quarantine from the downloaded archive first
      try { execSync(`xattr -dr com.apple.quarantine "${_downloadedPath}"`, { stdio: 'pipe' }); } catch (_) {}

      try {
        if (ext === '.zip') {
          // ZIP update — extract with unzip (not ditto) to avoid PKZip signature checks
          fs.mkdirSync(tmpBase, { recursive: true });
          execSync(`unzip -o "${_downloadedPath}" -d "${tmpBase}"`, { stdio: 'pipe', timeout: 60000 });
          // Find the .app bundle in the extracted directory
          const entries = fs.readdirSync(tmpBase);
          const appName = entries.find(e => e.endsWith('.app'));
          if (appName) {
            const extractedApp = path.join(tmpBase, appName);
            try { execSync(`xattr -dr com.apple.quarantine "${extractedApp}"`, { stdio: 'pipe', timeout: 10000 }); } catch (_) {}
            execSync(`rm -rf "/Applications/${appName}"`, { stdio: 'pipe', timeout: 30000 });
            execSync(`cp -R "${extractedApp}" "/Applications/${appName}"`, { stdio: 'pipe', timeout: 60000 });
            try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch (_) {}
            console.log('[updater] zip install complete, relaunching...');
            app.relaunch();
            app.quit();
            return;
          }
        } else {
          // DMG update — mount, find the .app by scanning the mount point, copy with cp -R
          fs.mkdirSync(tmpBase, { recursive: true });
          execSync(`hdiutil attach "${_downloadedPath}" -nobrowse -mountpoint "${tmpBase}"`, { stdio: 'pipe', timeout: 30000 });
          // Scan mount point for any .app bundle (handles name variations)
          const mountEntries = fs.readdirSync(tmpBase);
          const appName = mountEntries.find(e => e.endsWith('.app'));
          if (appName) {
            const appBundle = path.join(tmpBase, appName);
            try { execSync(`xattr -dr com.apple.quarantine "${appBundle}"`, { stdio: 'pipe', timeout: 10000 }); } catch (_) {}
            execSync(`rm -rf "/Applications/${appName}"`, { stdio: 'pipe', timeout: 30000 });
            execSync(`cp -R "${appBundle}" "/Applications/${appName}"`, { stdio: 'pipe', timeout: 60000 });
            try { execSync(`hdiutil detach "${tmpBase}" 2>/dev/null || true`, { stdio: 'pipe' }); } catch (_) {}
            try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch (_) {}
            console.log('[updater] dmg install complete, relaunching...');
            app.relaunch();
            app.quit();
            return;
          }
          try { execSync(`hdiutil detach "${tmpBase}" 2>/dev/null || true`, { stdio: 'pipe' }); } catch (_) {}
        }
      } catch (e) {
        console.error('[updater] manual install failed:', e.message);
        // Clean up temp dir
        try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch (_) {}
      }
    }
    // Windows / Linux — electron-updater handles natively
    autoUpdater.quitAndInstall(false, true);
  });

  // Silent background check 8s after first window opens.
  app.once('browser-window-created', () => {
    setTimeout(async () => {
      try {
        const result = await autoUpdater.checkForUpdatesAndNotify();
        if (!result) _githubReleaseFallback(send, ghToken);
      } catch (_) {
        _githubReleaseFallback(send, ghToken);
      }
    }, 8000);
  });

  console.log('[updater] auto-update enabled, channel:', autoUpdater.channel || 'latest');
}

try { _initAutoUpdater(); } catch (e) { console.warn('[updater] init error:', e.message); }

// ─── Extension IPC handlers ──────────────────────────────────────────────────
//
// Extensions are downloaded as .vsix files (zip archives), extracted to:
//   {userData}/nebula-extensions/{publisher}.{name}/
// The extension's package.json is read to determine contributions (sidebar views, etc.)

const AdmZip = (() => { try { return require('adm-zip'); } catch { return null; } })();
const extensionsDir = path.join(userDataPath, 'nebula-extensions');

// ── git-check-ignore via IPC (reliable in packaged app where PATH may differ) ──
ipcMain.handle('git:check-ignore', async (_event, paths) => {
  if (!Array.isArray(paths) || !paths.length) return { ignored: [] };
  const root = currentProjectRoot;
  if (!root) return { ignored: [] };
  try {
    // Verify it's a git repo first
    const { execFileSync: efs } = require('child_process');
    const gitExe = process.platform === 'win32'
      ? (fs.existsSync('C:\\Program Files\\Git\\cmd\\git.exe') ? 'C:\\Program Files\\Git\\cmd\\git.exe' : 'git')
      : 'git';
    try { efs(gitExe, ['-C', root, 'rev-parse', '--git-dir'], { stdio: 'pipe', timeout: 5000 }); }
    catch (_) { return { ignored: [] }; }

    const safe = paths.map(p => String(p).replace(/\\/g, '/').trim()).filter(p => p && !p.includes('..'));
    if (!safe.length) return { ignored: [] };

    const { spawnSync } = require('child_process');
    const result = spawnSync(gitExe, ['-C', root, 'check-ignore', '--stdin'], {
      input: safe.join('\n') + '\n',
      encoding: 'utf8',
      timeout: 10000,
    });
    const ignored = (result.stdout || '').split('\n').map(l => l.trim()).filter(Boolean);
    return { ignored };
  } catch (_) {
    return { ignored: [] };
  }
});

ipcMain.handle('ext:install', async (_event, ext) => {
  if (!ext?.id || !ext?.publisherId || !ext?.name || !ext?.version) return { ok: false, error: 'Missing fields' };
  try {
    fs.mkdirSync(extensionsDir, { recursive: true });
    const destDir = path.join(extensionsDir, `${ext.publisherId}.${ext.name}`);
    fs.mkdirSync(destDir, { recursive: true });

    // Download vsix from Marketplace
    const vsixUrl = `https://marketplace.visualstudio.com/_apis/public/gallery/publishers/${ext.publisherId}/vsextensions/${ext.name}/${ext.version}/vspackage`;
    const vsixPath = path.join(extensionsDir, `${ext.publisherId}.${ext.name}-${ext.version}.vsix`);

    await downloadFile(vsixUrl, vsixPath);

    // Extract vsix (it's a zip)
    if (AdmZip) {
      const zip = new AdmZip(vsixPath);
      zip.extractAllTo(destDir, true);
    } else {
      // Fallback: use unzip command (macOS/Linux)
      const { execSync: ex } = require('child_process');
      ex(`unzip -o "${vsixPath}" -d "${destDir}"`, { stdio: 'ignore' });
    }

    // Cleanup downloaded archive
    try { fs.unlinkSync(vsixPath); } catch (_) {}

    // Read manifest
    let manifest = null;
    const manifestPath = path.join(destDir, 'extension', 'package.json');
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch (_) {}

    // Send webview URL back if the extension has a webview
    let webviewUrl = null;
    if (manifest?.contributes?.views || manifest?.contributes?.viewsContainers) {
      webviewUrl = `file://${destDir}/extension/media/index.html`;
      if (!fs.existsSync(path.join(destDir, 'extension', 'media', 'index.html'))) webviewUrl = null;
    }

    return { ok: true, manifest, webviewUrl };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
});

ipcMain.handle('ext:uninstall', (_event, id) => {
  try {
    // id is "Publisher.name" format — convert to dir name
    const parts = id.split('.');
    const dirName = parts.length >= 2 ? `${parts[0]}.${parts.slice(1).join('.')}` : id;
    const destDir = path.join(extensionsDir, dirName);
    if (fs.existsSync(destDir)) {
      fs.rmSync(destDir, { recursive: true, force: true });
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
});

ipcMain.handle('ext:get-webview-url', (_event, id) => {
  try {
    const parts = id.split('.');
    const dirName = parts.length >= 2 ? `${parts[0]}.${parts.slice(1).join('.')}` : id;
    const destDir = path.join(extensionsDir, dirName);
    // Check common webview entry points
    const candidates = [
      path.join(destDir, 'extension', 'dist', 'webview.html'),
      path.join(destDir, 'extension', 'media', 'index.html'),
      path.join(destDir, 'extension', 'webview', 'index.html'),
      path.join(destDir, 'extension', 'out', 'webview.html'),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return `file://${c}`;
    }
    return null;
  } catch (_) {
    return null;
  }
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  stopScreenStream();
  stopBackend();
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});

// Tolerate non-Electron require contexts (e.g., unit tests requiring this
// module just to read `_b`). In Electron main + renderer, `require('electron')`
// always succeeds; in raw Node it does not.
let contextBridge, ipcRenderer;
try {
  const electron = require('electron');
  contextBridge = electron.contextBridge;
  ipcRenderer = electron.ipcRenderer;
} catch (_) { /* non-Electron context */ }

/**
 * Preload script for Nebula IDE
 *
 * Exposes a safe API to the renderer process via contextBridge.
 * The renderer can access these via window.electronAPI.
 *
 * Also stores `_b`, the second half of the cli-bundle key IKM. The constant
 * is exported from this module so the main process can import it via
 * `require('./preload')._b`. It is NOT exposed to the renderer (no
 * contextBridge call), and the renderer-only Electron code below is guarded
 * so this file can be safely required from main without crashing.
 */

// Build-time-injected: second half of the build-time KEK IKM. Replaced by
// scripts/embed-kek.mjs during electron-builder. The default zeros render
// the bundle undecryptable — that's fine in dev where the bundle isn't built.
const _b = '762926fecc14250fb49142d2a501334f' /* NEBULA_KEK_PART_B */;
module.exports = { _b };

// Detect renderer context: contextBridge is only available in renderer
// preload contexts. When main.js does `require('./preload')` to read `_b`,
// contextBridge is undefined and we skip the rest.
if (!contextBridge) {
  return;
}

let urlConfig = { apiUrl: '', authUrl: '', isProduction: false };
try {
  urlConfig = ipcRenderer.sendSync('get-url-config-sync') || urlConfig;
} catch (_) {}

contextBridge.exposeInMainWorld('NEBULA_CONFIG', urlConfig);

contextBridge.exposeInMainWorld('electronAPI', {
  // Get the backend API URL
  getApiUrl: () => ipcRenderer.invoke('get-api-url'),
  getAuthUrl: () => ipcRenderer.invoke('get-auth-url'),

  // Get the current platform (darwin, win32, linux)
  getPlatform: () => ipcRenderer.invoke('get-platform'),

  // Open a native folder picker dialog
  openFolderDialog: () => ipcRenderer.invoke('open-folder-dialog'),

  // List a directory under the current project root (Node fs — fast path for explorer)
  listProjectDir: (relPath, showHidden) =>
    ipcRenderer.invoke('fs:list-project-dir', {
      relPath: relPath == null ? '' : String(relPath),
      showHidden: !!showHidden,
    }),

  // Integrated bottom terminal — node-pty in main (low latency vs WS→Python).
  startIntegratedTerminal: (opts) => ipcRenderer.invoke('term:start', opts || {}),
  writeIntegratedTerminal: (sessionId, data) => ipcRenderer.invoke('term:write', sessionId, data),
  resizeIntegratedTerminal: (sessionId, cols, rows) =>
    ipcRenderer.invoke('term:resize', sessionId, cols, rows),
  killIntegratedTerminal: (sessionId) => ipcRenderer.invoke('term:kill', sessionId),
  onIntegratedTermData: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('term:data', wrapped);
    return () => ipcRenderer.removeListener('term:data', wrapped);
  },
  onIntegratedTermExit: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('term:exit', wrapped);
    return () => ipcRenderer.removeListener('term:exit', wrapped);
  },

  readProjectFile: (relPath) =>
    ipcRenderer.invoke('fs:read-project-file', relPath == null ? '' : String(relPath)),

  openNewWindow: () => ipcRenderer.invoke('app:new-window'),
  openFolderInNewWindow: (folderPath) => ipcRenderer.invoke('app:open-in-new-window', folderPath),

  /** Programmatically set this window's project root (per-window — does not affect other windows). */
  setProjectRoot: (folderPath) => ipcRenderer.invoke('project:set-root', folderPath),

  /** The folder path this window was spawned to open (passed via --nebula-open-folder). */
  getStartupFolder: () => ipcRenderer.invoke('app:get-startup-folder'),

  /** Authoritative active workspace from the Electron main process. Used by the
   *  renderer to hydrate project name / root before any backend HTTP request,
   *  so session-restored workspaces never flash the default "Nebula" label. */
  getCurrentWorkspace: () => ipcRenderer.invoke('app:get-workspace'),

  readPersistedAuth: () => ipcRenderer.invoke('auth:read-disk'),
  writePersistedAuth: (payload) => ipcRenderer.invoke('auth:write-disk', payload || {}),
  clearPersistedAuth: () => ipcRenderer.invoke('auth:clear-disk'),

  // SSO deep-link callback
  getPendingAuthCallback: () => ipcRenderer.invoke('auth:get-pending-callback'),
  onAuthCallback: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('auth:callback', wrapped);
    return () => ipcRenderer.removeListener('auth:callback', wrapped);
  },

  // Open external URLs in the user's default browser
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),

  // Normalize the clipboard image to PNG so Claude CLI can read it on Windows.
  // Call this before sending Alt+V to the CLI PTY.
  normalizeClipboardImage: () => ipcRenderer.invoke('clipboard:normalize-image'),

  // Diagnostics — used by the SCM panel's error screen so users on packaged
  // builds (where the menu is hidden) can still inspect what's broken.
  openDevTools: () => ipcRenderer.invoke('app:open-devtools'),
  getBackendDiagnostics: () => ipcRenderer.invoke('app:backend-diagnostics'),

  // Right-side CLI PTY integration
  startCliSession: (tool, options) => ipcRenderer.invoke('cli:start', tool, options),
  writeCliSession: (sessionId, data) => ipcRenderer.invoke('cli:write', sessionId, data),
  resizeCliSession: (sessionId, cols, rows) => ipcRenderer.invoke('cli:resize', sessionId, cols, rows),
  closeCliSession: (sessionId) => ipcRenderer.invoke('cli:close', sessionId),
  reattachCliSession: (sessionId) => ipcRenderer.invoke('cli:reattach', sessionId),
  getCliHistory: (tool) => ipcRenderer.invoke('cli:get-history', tool),
  clearCliHistory: (tool) => ipcRenderer.invoke('cli:clear-history', tool),
  terminateCliSession: (sessionId) => ipcRenderer.invoke('cli:terminate', sessionId),
  listCliSessions: () => ipcRenderer.invoke('cli:list'),
  onCliData: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('cli:data', wrapped);
    return () => ipcRenderer.removeListener('cli:data', wrapped);
  },
  onCliExit: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('cli:exit', wrapped);
    return () => ipcRenderer.removeListener('cli:exit', wrapped);
  },
  onCliAuthRequired: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('cli:auth-required', wrapped);
    return () => ipcRenderer.removeListener('cli:auth-required', wrapped);
  },
  onClaudeCredentialWarning: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('claude:credential-warning', wrapped);
    return () => ipcRenderer.removeListener('claude:credential-warning', wrapped);
  },

  // Project root changes (used to restart CLI sessions in the active workspace)
  onProjectRootChanged: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('project:root-changed', wrapped);
    return () => ipcRenderer.removeListener('project:root-changed', wrapped);
  },

  // Backend lifecycle events — emitted when backend finishes starting up
  onBackendReady: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('backend:ready', wrapped);
    return () => ipcRenderer.removeListener('backend:ready', wrapped);
  },
  onBackendError: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('backend:error', wrapped);
    return () => ipcRenderer.removeListener('backend:error', wrapped);
  },

  // CLI auth bundle status / repair (admin)
  cliBundleStatus: () => ipcRenderer.invoke('cli-bundle:status'),
  cliBundleRepair: (opts) => ipcRenderer.invoke('cli-bundle:repair', opts || {}),

  // Check if running in Electron
  isElectron: true,

  // ── Window controls (custom frame) ──────────────────────────────────────────
  minimizeWindow: () => ipcRenderer.invoke('win:minimize'),
  maximizeWindow: () => ipcRenderer.invoke('win:maximize'),
  closeWindow:    () => ipcRenderer.invoke('win:close'),

  // ── Auto-Update API ──────────────────────────────────────────
  updates: {
    checkForUpdates: () => ipcRenderer.invoke('update:check'),
    restartAndInstall: () => ipcRenderer.invoke('update:restart-and-install'),

    onChecking: (listener) => {
      const w = (_, p) => listener(p);
      ipcRenderer.on('update:checking', w);
      return () => ipcRenderer.removeListener('update:checking', w);
    },
    onAvailable: (listener) => {
      const w = (_, p) => listener(p);
      ipcRenderer.on('update:available', w);
      return () => ipcRenderer.removeListener('update:available', w);
    },
    onNotAvailable: (listener) => {
      const w = (_, p) => listener(p);
      ipcRenderer.on('update:not-available', w);
      return () => ipcRenderer.removeListener('update:not-available', w);
    },
    onDownloadProgress: (listener) => {
      const w = (_, p) => listener(p);
      ipcRenderer.on('update:download-progress', w);
      return () => ipcRenderer.removeListener('update:download-progress', w);
    },
    onDownloaded: (listener) => {
      const w = (_, p) => listener(p);
      ipcRenderer.on('update:downloaded', w);
      return () => ipcRenderer.removeListener('update:downloaded', w);
    },
    onError: (listener) => {
      const w = (_, p) => listener(p);
      ipcRenderer.on('update:error', w);
      return () => ipcRenderer.removeListener('update:error', w);
    },
  },

  // ── Git utilities (reliable in packaged app) ─────────────────
  gitCheckIgnore: (paths) => ipcRenderer.invoke('git:check-ignore', paths),

  // ── Extension Host API ───────────────────────────────────────
  extensions: {
    install: (ext) => ipcRenderer.invoke('ext:install', ext),
    uninstall: (id) => ipcRenderer.invoke('ext:uninstall', id),
    getWebviewUrl: (id) => ipcRenderer.invoke('ext:get-webview-url', id),
  },
});

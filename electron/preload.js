const { contextBridge, ipcRenderer } = require('electron');

/**
 * Preload script for Nebula IDE
 * 
 * Exposes a safe API to the renderer process via contextBridge.
 * The renderer can access these via window.electronAPI
 * 
 * IMPORTANT: We set NEBULA_API_URL synchronously using ipcRenderer.sendSync
 * so it's available before the React app loads. For this, we use a workaround:
 * we fetch it via invoke (async) and inject it into the page via a script tag.
 */

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

  // SSO deep-link callback
  getPendingAuthCallback: () => ipcRenderer.invoke('auth:get-pending-callback'),
  onAuthCallback: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('auth:callback', wrapped);
    return () => ipcRenderer.removeListener('auth:callback', wrapped);
  },

  // Open external URLs in the user's default browser
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),

  // Right-side CLI PTY integration
  startCliSession: (tool, options) => ipcRenderer.invoke('cli:start', tool, options),
  writeCliSession: (sessionId, data) => ipcRenderer.invoke('cli:write', sessionId, data),
  resizeCliSession: (sessionId, cols, rows) => ipcRenderer.invoke('cli:resize', sessionId, cols, rows),
  closeCliSession: (sessionId) => ipcRenderer.invoke('cli:close', sessionId),
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

  // Check if running in Electron
  isElectron: true,
});

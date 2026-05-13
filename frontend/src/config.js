/**
 * Nebula IDE Configuration
 * 
 * Provides the API base URL for communicating with the backend.
 * In Electron (desktop app), the URL is injected via the preload script.
 * In browser development mode, it falls back to the default localhost URL.
 */

// Default fallback URL for development
const DEFAULT_API_URL = process.env.REACT_APP_API_URL || 'http://127.0.0.1:8000';

// Electron preload script sets window.NEBULA_API_URL with the dynamic port
// This may be set synchronously before React loads, or asynchronously after
function getApiUrl() {
  if (typeof window !== 'undefined') {
    const configUrl = window.NEBULA_CONFIG?.apiUrl;
    if (configUrl && String(configUrl).trim()) return String(configUrl).trim();
    if (window.NEBULA_API_URL && String(window.NEBULA_API_URL).trim()) {
      return String(window.NEBULA_API_URL).trim();
    }
  }
  if (process.env.REACT_APP_API_URL) return process.env.REACT_APP_API_URL;
  return DEFAULT_API_URL;
}

function getAuthUrl() {
  if (typeof window !== 'undefined') {
    const configUrl = window.NEBULA_CONFIG?.authUrl;
    if (configUrl && String(configUrl).trim()) return String(configUrl).trim();
    if (window.NEBULA_AUTH_URL && String(window.NEBULA_AUTH_URL).trim()) {
      return String(window.NEBULA_AUTH_URL).trim();
    }
  }
  if (process.env.REACT_APP_AUTH_URL) return process.env.REACT_APP_AUTH_URL;
  return getApiUrl();
}

// Export a static value for components that import at module level
// This works because:
// 1. In Electron: preload injects NEBULA_API_URL before the app loads
// 2. In browser dev: falls back to default localhost URL
const API_URL = getApiUrl();
const AUTH_URL = getAuthUrl();

// Whether we're running inside Electron
const IS_ELECTRON = typeof window !== 'undefined' && !!(window.electronAPI);

export { API_URL, AUTH_URL, IS_ELECTRON, getApiUrl, getAuthUrl };
export default API_URL;

import axios from 'axios';

const TOKEN_KEY = 'nebula_auth_token';
const USER_KEY = 'nebula_auth_user';

// ─── Apply token immediately at module load so every axios request
//     made during app startup already has the Authorization header. ──────────
(function applyOnLoad() {
  try {
    const token = localStorage.getItem(TOKEN_KEY) || '';
    if (token) {
      axios.defaults.headers.common.Authorization = `Bearer ${token}`;
    }
  } catch (_) {}
})();

// ─── Global 401 interceptor ──────────────────────────────────────────────────
// Swallows 401 errors when the user has no token (not yet logged in — backend
// requests fire before auth completes on startup). If a token IS present and
// we still get 401, the token has expired → force re-login.
let _interceptorId = null;
function _ensureInterceptor() {
  if (_interceptorId !== null) return;
  // Endpoints that legitimately return 401 for reasons unrelated to the
  // user's own session (e.g. /auth/claude-token returns 401 to mean
  // "Anthropic rejected our master refresh token"). For these, we must NOT
  // wipe the user's session — that would log them out for an unrelated
  // upstream failure.
  const SESSION_NEUTRAL_401_PATHS = ['/auth/claude-token'];
  const isSessionNeutral401 = (url) => {
    if (!url) return false;
    try {
      const path = new URL(url, window.location.origin).pathname;
      return SESSION_NEUTRAL_401_PATHS.some((p) => path.endsWith(p));
    } catch (_) {
      return SESSION_NEUTRAL_401_PATHS.some((p) => url.includes(p));
    }
  };

  _interceptorId = axios.interceptors.response.use(
    res => res,
    err => {
      if (err?.response?.status === 401) {
        // Don't conflate upstream OAuth failures with session expiry.
        if (isSessionNeutral401(err?.config?.url)) {
          return Promise.reject(err);
        }
        try {
          const token = localStorage.getItem(TOKEN_KEY) || '';
          if (token) {
            // Token exists but server rejected it — clear it and reload to login.
            localStorage.removeItem(TOKEN_KEY);
            localStorage.removeItem(USER_KEY);
            delete axios.defaults.headers.common.Authorization;
            // Only force reload if we are not already on the login page.
            if (!window.location.search.includes('login=true')) {
              window.location.search = '?login=true';
            }
          }
          // No token → backend requires auth but we haven't logged in yet.
          // Return an empty resolved response so callers don't throw.
          return Promise.resolve({ data: {}, status: 401, _silenced401: true });
        } catch (_) {
          return Promise.resolve({ data: {}, status: 401, _silenced401: true });
        }
      }
      return Promise.reject(err);
    }
  );
}
_ensureInterceptor();

export function getAuthToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || '';
  } catch (_) {
    return '';
  }
}

export function setAuthToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch (_) {}
  applyAxiosAuthHeader();
}

export function getAuthUser() {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

export function setAuthUser(user) {
  try {
    if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
    else localStorage.removeItem(USER_KEY);
  } catch (_) {}
}

export function logout(forceLogin = false) {
  try {
    if (typeof window !== 'undefined' && window.electronAPI?.clearPersistedAuth) {
      window.electronAPI.clearPersistedAuth().catch(() => {});
    }
  } catch (_) {}
  setAuthToken('');
  setAuthUser(null);
  if (forceLogin) {
    window.location.search = '?login=true';
  } else {
    window.location.reload();
  }
}

export function applyAxiosAuthHeader() {
  const token = getAuthToken();
  if (token) {
    axios.defaults.headers.common.Authorization = `Bearer ${token}`;
  } else {
    delete axios.defaults.headers.common.Authorization;
  }
}

export async function authFetch(url, options = {}) {
  const token = getAuthToken();
  const headers = { ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(url, { ...options, headers });
}


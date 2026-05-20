import React, { useEffect, useState, useRef, useCallback } from 'react';
import axios from 'axios';
import { AUTH_URL as AUTH } from '../config';
import { applyAxiosAuthHeader, authFetch, getAuthToken, setAuthToken, setAuthUser } from '../lib/auth';
import { startSsoLogin as startSsoLoginFlow } from '../lib/sso';

const overlayStyle = {
  position: 'fixed',
  inset: 0,
  zIndex: 20000,
  background: 'rgba(0,0,0,0.55)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 18,
};

const cardStyle = {
  width: 420,
  maxWidth: '95vw',
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border)',
  borderRadius: '12px',
  padding: 16,
  boxShadow: 'var(--shadow-lg)',
};

const inputStyle = {
  width: '100%',
  background: 'var(--bg-surface)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  padding: '10px 12px',
  color: 'var(--text-primary)',
  outline: 'none',
  fontSize: 13,
};

const buttonStyle = {
  background: 'var(--accent)',
  color: '#071018',
  border: 'none',
  borderRadius: 8,
  padding: '10px 12px',
  fontWeight: 700,
  cursor: 'pointer',
  fontSize: 13,
};

export default function AuthGate({ children, requireAuth: forceRequireAuth }) {
  const [loading, setLoading] = useState(true);
  const [hasUsers, setHasUsers] = useState(false);
  const [dbConnected, setDbConnected] = useState(true);
  const [authRequired, setAuthRequired] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [ssoBusy, setSsoBusy] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [retryCount, setRetryCount] = useState(0);
  const ssoStateRef = useRef('');

  useEffect(() => {
    applyAxiosAuthHeader();
  }, []);

  const persistElectronAuth = useCallback(async (token, user) => {
    try {
      if (window.electronAPI?.writePersistedAuth && token) {
        await window.electronAPI.writePersistedAuth({ token, user: user || null });
      }
    } catch (_) {}
  }, []);

  const exchangeSsoCode = useCallback(async (code, state) => {
    if (!code) return;
    if (state && ssoStateRef.current && state !== ssoStateRef.current) {
      // If state mismatches, ignore (can happen if app was relaunched).
    }

    setError('');
    setSsoBusy(true);
    try {
      const res = await axios.post(`${AUTH}/auth/sso/exchange`, { code });
      const data = res.data || {};
      if (data.error) {
        setError(data.error);
        return;
      }
      if (data.token && data.user) {
        setAuthToken(data.token);
        setAuthUser(data.user);
        await persistElectronAuth(data.token, data.user);
        setAuthenticated(true);
      } else {
        setError('SSO exchange failed.');
      }
    } catch (e) {
      setError(e?.response?.data?.error || e.message || 'SSO exchange failed');
    } finally {
      setSsoBusy(false);
    }
  }, [persistElectronAuth]);

  useEffect(() => {
    if (!window.electronAPI?.onAuthCallback && !window.electronAPI?.getPendingAuthCallback) return;

    const handle = async (payload) => {
      try {
        const rawUrl = payload?.url || payload;
        if (!rawUrl) return;
        const u = new URL(rawUrl);
        const code = u.searchParams.get('code') || '';
        const state = u.searchParams.get('state') || '';
        if (code) {
          await exchangeSsoCode(code, state);
        }
      } catch (_) {}
    };

    let unsubscribe = null;
    if (window.electronAPI?.onAuthCallback) {
      unsubscribe = window.electronAPI.onAuthCallback(handle);
    }

    (async () => {
      try {
        const pending = await window.electronAPI?.getPendingAuthCallback?.();
        if (pending) await handle(pending);
      } catch (_) {}
    })();

    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, [exchangeSsoCode]);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams(window.location.search);
    const forceLogin = params.get('login') === 'true';

    // In Electron the backend:ready event is the proper signal; give it 60s.
    // In browser dev mode there's no backend:ready so 5s is a reasonable cap.
    const timeoutMs = window.electronAPI?.onBackendReady ? 60000 : 5000;
    const timeout = setTimeout(() => {
      if (!cancelled) {
        console.warn("Auth status check timed out, falling back to offline mode");
        setLoading(false);
      }
    }, timeoutMs);

    const doAuthCheck = async () => {
      if (cancelled) return;
      try {
        try {
          if (window.electronAPI?.readPersistedAuth) {
            const disk = await window.electronAPI.readPersistedAuth();
            if (disk?.token && !getAuthToken()) {
              setAuthToken(disk.token);
              if (disk.user) setAuthUser(disk.user);
            }
          }
        } catch (_) {}

        const res = await fetch(`${AUTH}/auth/status`);
        clearTimeout(timeout);
        if (cancelled) return;
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;

        const h = !!data.has_users;
        const dbOk = data.db_connected !== false;
        const r = !!data.auth_required || forceLogin || forceRequireAuth;

        setHasUsers(h);
        setDbConnected(dbOk);
        setAuthRequired(r);

        if (!dbOk && data.error) {
          setError(data.error);
        } else {
          setError('');
        }

        if (h && getAuthToken() && dbOk) {
          const me = await authFetch(`${AUTH}/auth/me`);
          const meData = await me.json().catch(() => ({}));
          if (meData?.user) {
            setAuthUser(meData.user);
            setAuthenticated(true);
            try {
              if (window.electronAPI?.writePersistedAuth) {
                await window.electronAPI.writePersistedAuth({
                  token: getAuthToken(),
                  user: meData.user,
                });
              }
            } catch (_) {}
            setLoading(false);
            return;
          }
          if (me.status === 401) {
            setAuthToken('');
            try {
              await window.electronAPI?.clearPersistedAuth?.();
            } catch (_) {}
          }
        }
      } catch (_) {
        if (cancelled) return;
        clearTimeout(timeout);
        setDbConnected(false);
        setError('Cannot reach backend. Please ensure the server is running.');
      }
      setLoading(false);
    };

    // Delay initial auth check to avoid ERR_CONNECTION_REFUSED from racing
    // the backend startup. In Electron, wait for backend:ready if available.
    let runTimer = null;
    let retryTimer = null;
    let retries = 0;
    const MAX_CONNECT_RETRIES = 20;

    let unsubBackendReady = null;
    if (window.electronAPI?.onBackendReady) {
      unsubBackendReady = window.electronAPI.onBackendReady(() => {
        if (!cancelled) doAuthCheck();
      });
      // Fallback: start auth check after 6s regardless
      runTimer = setTimeout(() => { if (!cancelled) doAuthCheck(); }, 6000);
    } else {
      // Browser dev: short delay then check
      runTimer = setTimeout(() => { if (!cancelled) doAuthCheck(); }, 1500);
    }

    // Auto-retry when backend is unreachable: check every 3s up to 20 times.
    const poll = () => {
      if (cancelled) return;
      retries++;
      if (retries > MAX_CONNECT_RETRIES) return;
      fetch(`${AUTH}/auth/status`).then(async (res) => {
        if (cancelled) return;
        const data = await res.json().catch(() => ({}));
        if (data.db_connected !== false) {
          setDbConnected(true);
          setError('');
          if (data.has_users && getAuthToken()) {
            const me = await authFetch(`${AUTH}/auth/me`).catch(() => ({}));
            const meData = me?.json ? await me.json().catch(() => ({})) : {};
            if (meData?.user) {
              setAuthUser(meData.user);
              setAuthenticated(true);
            }
          }
        }
      }).catch(() => {
        retryTimer = setTimeout(poll, 3000);
      });
    };
    retryTimer = setTimeout(poll, 4000);

    return () => {
      cancelled = true;
      clearTimeout(timeout);
      if (runTimer) clearTimeout(runTimer);
      if (retryTimer) clearTimeout(retryTimer);
      if (unsubBackendReady) { try { unsubBackendReady(); } catch (_) {} }
    };
  }, [forceRequireAuth, retryCount]);

  const doLogin = async () => {
    setError('');
    try {
      const res = await axios.post(`${AUTH}/auth/login`, { email, password });
      const data = res.data || {};
      if (data.error) {
        setError(data.error);
        return;
      }
      setAuthToken(data.token || '');
      setAuthUser(data.user || null);
      try {
        if (window.electronAPI?.writePersistedAuth && data.token) {
          await window.electronAPI.writePersistedAuth({ token: data.token, user: data.user || null });
        }
      } catch (_) {}
      setAuthenticated(true);
      setLoading(false);
    } catch (e) {
      setError(e?.response?.data?.error || e.message || 'Login failed');
    }
  };

  const startSsoLogin = () => {
    setError('');
    (async () => {
      try {
        const { state } = await startSsoLoginFlow(AUTH, { redirectUri: 'nebula://auth' });
        ssoStateRef.current = state;
      } catch (e) {
        setError(e?.message || 'Failed to open login URL');
      }
    })();
  };

  if (loading) return null;
  if (!authRequired && !forceRequireAuth) return children;
  if (authenticated) return children;

  return (
    <div style={overlayStyle}>
      <div style={cardStyle}>
        <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--text-primary)' }}>
          Sign In
        </div>
        <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-muted)' }}>
          Sign in to access the IDE.
        </div>
        {!dbConnected ? (
          <div style={{ marginTop: 10, fontSize: 12, color: 'var(--error, #e5534b)', padding: '8px 12px', background: 'rgba(229, 83, 75, 0.1)', borderRadius: 6, border: '1px solid var(--error, #e5534b)' }}>
            <strong>Database Error:</strong> {error || 'Cannot connect to MongoDB. Please ensure the database service is running on port 27017.'}
            <div style={{ marginTop: 8 }}>
              <button 
                onClick={() => setRetryCount(c => c + 1)}
                style={{ ...buttonStyle, padding: '4px 8px', fontSize: 11, background: 'var(--error, #e5534b)', color: '#fff' }}
              >
                Retry Connection
              </button>
            </div>
          </div>
        ) : !hasUsers && (
          <div style={{ marginTop: 10, fontSize: 12, color: 'var(--error, #e5534b)' }}>
            No users exist on this backend yet. A Super Admin must seed the first account via server environment variables.
          </div>
        )}

        <div style={{ marginTop: 14 }}>
          <button type="button" onClick={startSsoLogin} style={{ ...buttonStyle, width: '100%' }} disabled={ssoBusy}>
            {ssoBusy ? 'Completing sign-in…' : 'Login'}
          </button>
        </div>

        <div style={{ marginTop: 12, fontSize: 12, color: 'var(--text-muted)' }}>
          Or sign in with local credentials:
        </div>

        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 12, marginBottom: 6, color: 'var(--text-muted)' }}>Email</div>
          <input value={email} onChange={e => setEmail(e.target.value)} style={inputStyle} autoFocus={false} />
        </div>

        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 12, marginBottom: 6, color: 'var(--text-muted)' }}>Password</div>
          <input type="password" value={password} onChange={e => setPassword(e.target.value)} style={inputStyle}
            onKeyDown={e => { if (e.key === 'Enter') doLogin(); }}
          />
        </div>

        {error && (
          <div style={{ marginTop: 10, fontSize: 12, color: 'var(--error, #e5534b)' }}>{error}</div>
        )}

        <div style={{ marginTop: 14, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" onClick={doLogin} style={buttonStyle} disabled={!hasUsers || ssoBusy}>
            Sign In
          </button>
        </div>
      </div>
    </div>
  );
}
// 
import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { AUTH_URL as AUTH } from '../config';
import { applyAxiosAuthHeader, authFetch, getAuthToken, setAuthToken, setAuthUser } from '../lib/auth';

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
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    applyAxiosAuthHeader();
  }, []);

  const checkStatus = async () => {
    let cancelled = false;
    const params = new URLSearchParams(window.location.search);
    const forceLogin = params.get('login') === 'true';

    const timeout = setTimeout(() => {
      if (!cancelled) {
        console.warn("Auth status check timed out, falling back to offline mode");
        setLoading(false);
      }
    }, 5000); // 5 second timeout

    try {
      const res = await fetch(`${AUTH}/auth/status`);
      clearTimeout(timeout);
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
          setLoading(false);
          return;
        }
        setAuthToken('');
      }
    } catch (_) {
      clearTimeout(timeout);
      setDbConnected(false);
      setError('Cannot reach backend. Please ensure the server is running.');
    }
    setLoading(false);
    return () => { cancelled = true; };
  };

  useEffect(() => {
    checkStatus();
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
      setAuthenticated(true);
      setLoading(false);
    } catch (e) {
      setError(e?.response?.data?.error || e.message || 'Login failed');
    }
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
          <div style={{ fontSize: 12, marginBottom: 6, color: 'var(--text-muted)' }}>Email</div>
          <input value={email} onChange={e => setEmail(e.target.value)} style={inputStyle} autoFocus />
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
          <button type="button" onClick={doLogin} style={buttonStyle} disabled={!hasUsers}>
            Sign In
          </button>
        </div>
      </div>
    </div>
  );
}

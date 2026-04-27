import React, { useEffect, useState, useCallback } from 'react';
import React, { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import { API_URL as API } from '../config';
import { getAuthUser } from '../lib/auth';
import UsagePanel from './UsagePanel';

const card = {
  background: 'var(--bg-surface)',
  border: '1px solid var(--border)',
  borderRadius: 10,
  padding: 12,
  marginBottom: 10,
};

const inputStyle = {
  width: '100%',
  background: 'var(--bg-elevated)',
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
  fontWeight: 800,
  cursor: 'pointer',
  fontSize: 13,
};

export default function AdminPanel() {
  const user = getAuthUser();
  const isAdmin = user?.role === 'super_admin';
  const [tab, setTab] = useState('users'); // 'users' | 'usage' | 'configurations'
  const [users, setUsers] = useState([]);
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [createEmail, setCreateEmail] = useState('');
  const [createPassword, setCreatePassword] = useState('');
  const [createRole, setCreateRole] = useState('user');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const [configLoading, setConfigLoading] = useState(false);
  const [claudeCfg, setClaudeCfg] = useState(null);
  const [claudeApiKey, setClaudeApiKey] = useState('');
  const [claudeOauthToken, setClaudeOauthToken] = useState('');
  const [cfgError, setCfgError] = useState('');
  const [cfgSuccess, setCfgSuccess] = useState('');

  const refreshUsers = useCallback(async () => {
    if (!isAdmin) return;
    setLoadingUsers(true);
    try {
      const res = await axios.get(`${API}/auth/users`);
      setUsers(res.data.users || []);
    } catch (e) {
      setUsers([]);
    } finally {
      setLoadingUsers(false);
    }
  }, [isAdmin]);

  useEffect(() => { refreshUsers(); }, [refreshUsers]);

  const refreshConfig = useCallback(async () => {
    if (!isAdmin) return;
    setConfigLoading(true);
    setCfgError('');
    try {
      const res = await axios.get(`${API}/admin/config/claude-cli`);
      setClaudeCfg(res.data?.claude_cli || null);
    } catch (e) {
      setClaudeCfg(null);
      setCfgError(e?.response?.data?.error || e.message || 'Failed to load configuration');
    } finally {
      setConfigLoading(false);
    }
  }, [isAdmin]);

  useEffect(() => {
    if (tab === 'configurations') refreshConfig();
  }, [tab, refreshConfig]);

  const createUser = async () => {
    setError('');
    setSuccess('');
    try {
      const res = await axios.post(`${API}/auth/users`, { email: createEmail, password: createPassword, role: createRole });
      if (res.data?.error) {
        setError(res.data.error);
        return;
      }
      setSuccess('User created.');
      setCreateEmail('');
      setCreatePassword('');
      setCreateRole('user');
      refreshUsers();
      setTimeout(() => setSuccess(''), 2500);
    } catch (e) {
      setError(e?.response?.data?.error || e.message || 'Create failed');
    }
  };

  const saveClaudeConfig = async () => {
    setCfgError('');
    setCfgSuccess('');
    try {
      const res = await axios.post(`${API}/admin/config/claude-cli`, { api_key: claudeApiKey, oauth_token: claudeOauthToken });
      if (res.data?.error) {
        setCfgError(res.data.error);
        return;
      }
      setClaudeCfg(res.data?.claude_cli || null);
      setCfgSuccess(`Saved. Provisioned ${res.data?.provisioned_users ?? 0} users.`);
      setClaudeApiKey('');
      setClaudeOauthToken('');
      setTimeout(() => setCfgSuccess(''), 3500);
    } catch (e) {
      setCfgError(e?.response?.data?.error || e.message || 'Save failed');
    }
  };

  const clearClaudeConfig = async () => {
    setCfgError('');
    setCfgSuccess('');
    try {
      const res = await axios.post(`${API}/admin/config/claude-cli/clear`, {});
      if (res.data?.error) {
        setCfgError(res.data.error);
        return;
      }
      setClaudeCfg(null);
      setCfgSuccess('Cleared.');
      setTimeout(() => setCfgSuccess(''), 2500);
    } catch (e) {
      setCfgError(e?.response?.data?.error || e.message || 'Clear failed');
    }
  };

  if (!isAdmin) {
    return (
      <div style={{ padding: 12, color: 'var(--text-muted)', fontSize: 12 }}>
        Admin access required.
      </div>
    );
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: 12, borderBottom: '1px solid var(--border)', display: 'flex', gap: 8 }}>
        <button
          type="button"
          onClick={() => setTab('users')}
          style={{
            ...buttonStyle,
            background: tab === 'users' ? 'var(--accent)' : 'var(--bg-elevated)',
            color: tab === 'users' ? '#071018' : 'var(--text-primary)',
            border: tab === 'users' ? 'none' : '1px solid var(--border)',
            padding: '8px 10px',
          }}
        >
          Users
        </button>
        <button
          type="button"
          onClick={() => setTab('usage')}
          style={{
            ...buttonStyle,
            background: tab === 'usage' ? 'var(--accent)' : 'var(--bg-elevated)',
            color: tab === 'usage' ? '#071018' : 'var(--text-primary)',
            border: tab === 'usage' ? 'none' : '1px solid var(--border)',
            padding: '8px 10px',
          }}
        >
          Monitoring
        </button>
        <button
          type="button"
          onClick={() => setTab('configurations')}
          style={{
            ...buttonStyle,
            background: tab === 'configurations' ? 'var(--accent)' : 'var(--bg-elevated)',
            color: tab === 'configurations' ? '#071018' : 'var(--text-primary)',
            border: tab === 'configurations' ? 'none' : '1px solid var(--border)',
            padding: '8px 10px',
          }}
        >
          Configurations
        </button>
      </div>

      <div style={{ flex: 1, overflow: 'auto' }}>
        {tab === 'usage' && <UsagePanel />}

        {tab === 'configurations' && (
          <div style={{ padding: 12 }}>
            <div style={card}>
              <div style={{ fontSize: 13, fontWeight: 900, color: 'var(--text-primary)', marginBottom: 8 }}>
                Claude CLI
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.4 }}>
                Save credentials once and Nebula will automatically provision CLI access for all users.
              </div>

              <div style={{ marginTop: 12, display: 'grid', gap: 10 }}>
                <div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>Current</div>
                  {configLoading ? (
                    <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Loading…</div>
                  ) : claudeCfg?.configured ? (
                    <div style={{ fontSize: 12, color: 'var(--text-primary)' }}>
                      API key: <span style={{ color: 'var(--text-muted)' }}>{claudeCfg.api_key_masked || '—'}</span>
                      <br />
                      OAuth token: <span style={{ color: 'var(--text-muted)' }}>{claudeCfg.oauth_token_masked || '—'}</span>
                    </div>
                  ) : (
                    <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Not configured.</div>
                  )}
                </div>

                <div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>ANTHROPIC_API_KEY</div>
                  <input type="password" value={claudeApiKey} onChange={e => setClaudeApiKey(e.target.value)} style={inputStyle} placeholder="Paste API key" />
                </div>
                <div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>CLAUDE_CODE_OAUTH_TOKEN (optional)</div>
                  <input type="password" value={claudeOauthToken} onChange={e => setClaudeOauthToken(e.target.value)} style={inputStyle} placeholder="Paste OAuth token (optional)" />
                </div>

                {(cfgError || cfgSuccess) && (
                  <div style={{ fontSize: 12, color: cfgError ? 'var(--error, #e5534b)' : 'var(--accent)', fontWeight: 700 }}>
                    {cfgError || cfgSuccess}
                  </div>
                )}

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                  <button type="button" onClick={refreshConfig} style={{ ...buttonStyle, padding: '8px 10px', background: 'var(--bg-elevated)', color: 'var(--text-primary)', border: '1px solid var(--border)' }} disabled={configLoading}>
                    Refresh
                  </button>
                  <button type="button" onClick={clearClaudeConfig} style={{ ...buttonStyle, padding: '8px 10px', background: 'var(--bg-elevated)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}>
                    Clear
                  </button>
                  <button type="button" onClick={saveClaudeConfig} style={buttonStyle} disabled={!claudeApiKey && !claudeOauthToken}>
                    Save &amp; Provision
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {tab === 'users' && (
          <div style={{ padding: 12 }}>
            <div style={card}>
              <div style={{ fontSize: 13, fontWeight: 900, color: 'var(--text-primary)', marginBottom: 8 }}>
                Create user
              </div>
              <div style={{ display: 'grid', gap: 10 }}>
                <div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>Email</div>
                  <input value={createEmail} onChange={e => setCreateEmail(e.target.value)} style={inputStyle} />
                </div>
                <div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>Password</div>
                  <input type="password" value={createPassword} onChange={e => setCreatePassword(e.target.value)} style={inputStyle} />
                </div>
                <div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>Role</div>
                  <select value={createRole} onChange={e => setCreateRole(e.target.value)} style={inputStyle}>
                    <option value="user">User</option>
                    <option value="super_admin">Super Admin</option>
                  </select>
                </div>
                {(error || success) && (
                  <div style={{ fontSize: 12, color: error ? 'var(--error, #e5534b)' : 'var(--accent)', fontWeight: 700 }}>
                    {error || success}
                  </div>
                )}
                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <button type="button" onClick={createUser} style={buttonStyle} disabled={!createEmail || !createPassword}>
                    Create
                  </button>
                </div>
              </div>
            </div>

            <div style={card}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <div style={{ fontSize: 13, fontWeight: 900, color: 'var(--text-primary)' }}>Users</div>
                <button type="button" onClick={refreshUsers} style={{ ...buttonStyle, padding: '8px 10px' }} disabled={loadingUsers}>
                  Refresh
                </button>
              </div>
              {loadingUsers ? (
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Loading…</div>
              ) : users.length === 0 ? (
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>No users.</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {users.map(u => (
                    <div key={u.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                      <div style={{ fontSize: 12, color: 'var(--text-primary)' }}>{u.email || u.id}</div>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{u.role || 'user'}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

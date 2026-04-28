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

  const [bundleLoading, setBundleLoading] = useState(false);
  const [bundleStatus, setBundleStatus] = useState(null);
  const [bundleError, setBundleError] = useState('');
  const [bundleSuccess, setBundleSuccess] = useState('');
  const [bundleRepairing, setBundleRepairing] = useState(false);

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

  const refreshBundleStatus = useCallback(async () => {
    if (!isAdmin) return;
    if (!window.electronAPI?.cliBundleStatus) {
      setBundleStatus(null);
      setBundleError('CLI bundle status is only available in the desktop app.');
      return;
    }
    setBundleLoading(true);
    setBundleError('');
    try {
      const res = await window.electronAPI.cliBundleStatus();
      setBundleStatus(res || null);
    } catch (e) {
      setBundleStatus(null);
      setBundleError(e?.message || 'Failed to load CLI bundle status');
    } finally {
      setBundleLoading(false);
    }
  }, [isAdmin]);

  useEffect(() => {
    if (tab === 'configurations') refreshBundleStatus();
  }, [tab, refreshBundleStatus]);

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

  const repairCliBundle = async (override = false) => {
    setBundleError('');
    setBundleSuccess('');
    if (!window.electronAPI?.cliBundleRepair) {
      setBundleError('CLI bundle repair is only available in the desktop app.');
      return;
    }
    setBundleRepairing(true);
    try {
      const res = await window.electronAPI.cliBundleRepair({ override });
      if (!res?.ok) {
        setBundleError(`${res?.errorCode || 'BUNDLE_UNKNOWN'}: ${res?.message || 'Repair failed'}`);
      } else {
        setBundleSuccess(res.status === 'installed' ? 'CLI credentials reinstalled.' : 'CLI credentials are healthy.');
        setTimeout(() => setBundleSuccess(''), 3500);
      }
      await refreshBundleStatus();
    } catch (e) {
      setBundleError(e?.message || 'Repair failed');
    } finally {
      setBundleRepairing(false);
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
                CLI Auth Bundle
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.4 }}>
                Claude and Codex CLI credentials are unpacked from a shipped bundle into <code>~/.claude</code> and <code>~/.codex</code> at startup. Use Repair if a CLI starts asking for login.
              </div>

              <div style={{ marginTop: 12, display: 'grid', gap: 10 }}>
                <div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>Status</div>
                  {bundleLoading ? (
                    <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Loading…</div>
                  ) : bundleStatus?.marker ? (
                    <div style={{ fontSize: 12, color: 'var(--text-primary)' }}>
                      Installed at: <span style={{ color: 'var(--text-muted)' }}>{bundleStatus.marker.installed_at || '—'}</span>
                      <br />
                      Bundle SHA: <span style={{ color: 'var(--text-muted)', fontFamily: 'monospace' }}>{(bundleStatus.marker.bundleSha || '').slice(0, 16)}…</span>
                      <br />
                      Files on disk:{' '}
                      <span style={{ color: bundleStatus.files?.claudeCreds ? 'var(--text-primary)' : 'var(--error, #e5534b)' }}>
                        claude.credentials_json {bundleStatus.files?.claudeCreds ? '✓' : '✗'}
                      </span>
                      {' · '}
                      <span style={{ color: bundleStatus.files?.codexAuth ? 'var(--text-primary)' : 'var(--error, #e5534b)' }}>
                        codex.auth_json {bundleStatus.files?.codexAuth ? '✓' : '✗'}
                      </span>
                    </div>
                  ) : (
                    <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                      {bundleStatus === null && bundleError ? bundleError : 'Not installed yet — try Repair.'}
                    </div>
                  )}
                </div>

                {bundleStatus?.lastError && (
                  <div style={{ fontSize: 12, color: 'var(--error, #e5534b)', fontFamily: 'monospace' }}>
                    Last error: {bundleStatus.lastError.code} — {bundleStatus.lastError.message}
                  </div>
                )}

                {(bundleError || bundleSuccess) && (
                  <div style={{ fontSize: 12, color: bundleError ? 'var(--error, #e5534b)' : 'var(--accent)', fontWeight: 700 }}>
                    {bundleError || bundleSuccess}
                  </div>
                )}

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                  <button
                    type="button"
                    onClick={refreshBundleStatus}
                    style={{ ...buttonStyle, padding: '8px 10px', background: 'var(--bg-elevated)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
                    disabled={bundleLoading}
                  >
                    Refresh
                  </button>
                  {bundleStatus?.lastError?.code === 'BUNDLE_LOCK_STUCK' && (
                    <button
                      type="button"
                      onClick={() => repairCliBundle(true)}
                      style={{ ...buttonStyle, padding: '8px 10px', background: 'var(--bg-elevated)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
                      disabled={bundleRepairing}
                      title="Override the install lock (use only after confirming no other instance is installing)"
                    >
                      Force Repair
                    </button>
                  )}
                  <button type="button" onClick={() => repairCliBundle(false)} style={buttonStyle} disabled={bundleRepairing}>
                    {bundleRepairing ? 'Repairing…' : 'Repair CLI auth'}
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

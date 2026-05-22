import React, { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import { API_URL as API, AUTH_URL as AUTH } from '../config';
import { getAuthUser, authFetch } from '../lib/auth';
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
  const [tab, setTab] = useState('users'); // 'users' | 'usage' | 'configurations' | 'tokens'
  const [tokenUsers, setTokenUsers] = useState([]);
  const [tokenLoading, setTokenLoading] = useState(false);
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

  const [credsStatus, setCredsStatus] = useState(null); // null | 'ok' | 'missing'
  const [credsStatusMsg, setCredsStatusMsg] = useState('');
  const [credsJson, setCredsJson] = useState('');
  const [credsSaving, setCredsSaving] = useState(false);
  const [credsError, setCredsError] = useState('');
  const [credsSuccess, setCredsSuccess] = useState('');

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
    if (tab === 'tokens' && isAdmin) {
      setTokenLoading(true);
      authFetch(`${API}/token-stats/all`)
        .then(r => r.json())
        .then(j => setTokenUsers(j.data || []))
        .catch(() => setTokenUsers([]))
        .finally(() => setTokenLoading(false));
    }
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

  const checkServerCreds = useCallback(async () => {
    setCredsStatus(null);
    setCredsStatusMsg('Checking…');
    try {
      const res = await axios.get(`${AUTH}/auth/claude-token`);
      if (res.data?.ok && res.data?.accessToken) {
        setCredsStatus('ok');
        setCredsStatusMsg('Server has valid Claude credentials.');
      } else {
        setCredsStatus('missing');
        setCredsStatusMsg(`Server returned: ${res.data?.error || 'no access token'}`);
      }
    } catch (e) {
      const data = e?.response?.data || {};
      setCredsStatus(data.authFailure ? 'expired' : 'missing');
      const baseMsg = data.error || e.message || 'Failed to reach server';
      setCredsStatusMsg(
        data.authFailure
          ? `${baseMsg} — Re-paste the contents of ~/.claude/.credentials.json below to seed a fresh refresh token.`
          : baseMsg,
      );
    }
  }, []);

  const seedMasterCredentials = async () => {
    setCredsError('');
    setCredsSuccess('');
    let parsed;
    try {
      parsed = JSON.parse(credsJson.trim());
    } catch (_) {
      setCredsError('Invalid JSON — paste the full contents of ~/.claude/.credentials.json');
      return;
    }
    // Support pasting the full .credentials.json or just the claudeAiOauth object
    const oauth = parsed.claudeAiOauth || parsed.oauth || parsed;
    if (!oauth?.refreshToken) {
      setCredsError('No refreshToken found. Paste the full ~/.claude/.credentials.json file.');
      return;
    }
    setCredsSaving(true);
    try {
      const res = await axios.post(`${AUTH}/auth/claude-credentials`, { oauth });
      if (res.data?.ok) {
        setCredsSuccess('Master credentials updated. New users will receive fresh tokens.');
        setCredsJson('');
        checkServerCreds();
        setTimeout(() => setCredsSuccess(''), 4000);
      } else {
        setCredsError(res.data?.error || 'Update failed');
      }
    } catch (e) {
      const data = e?.response?.data || {};
      const baseMsg = data.error || e.message || 'Update failed';
      setCredsError(data.hint ? `${baseMsg}\n\n${data.hint}` : baseMsg);
    } finally {
      setCredsSaving(false);
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
        <button
          type="button"
          onClick={() => setTab('tokens')}
          style={{
            ...buttonStyle,
            background: tab === 'tokens' ? 'var(--accent)' : 'var(--bg-elevated)',
            color: tab === 'tokens' ? '#071018' : 'var(--text-primary)',
            border: tab === 'tokens' ? 'none' : '1px solid var(--border)',
            padding: '8px 10px',
          }}
        >
          Token Stats
        </button>
      </div>

      <div style={{ flex: 1, overflow: 'auto' }}>
        {tab === 'usage' && <UsagePanel />}

        {tab === 'configurations' && (
          <div style={{ padding: 12 }}>
            <div style={card}>
              <div style={{ fontSize: 13, fontWeight: 900, color: 'var(--text-primary)', marginBottom: 8 }}>
                Master Claude Credentials
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.4 }}>
                The server holds a master Claude OAuth token that is distributed to all users at CLI start, so credentials never expire. Paste the contents of <code>~/.claude/.credentials.json</code> from the admin&apos;s machine (after running <code>claude login</code>) to seed or refresh the server credentials.
              </div>

              {credsStatus && (
                <div style={{ marginTop: 8, fontSize: 12, fontWeight: 700, color: credsStatus === 'ok' ? 'var(--accent)' : 'var(--error, #e5534b)' }}>
                  {credsStatus === 'ok' ? '✓ ' : '✗ '}{credsStatusMsg}
                </div>
              )}
              {!credsStatus && credsStatusMsg && (
                <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-muted)' }}>{credsStatusMsg}</div>
              )}

              <div style={{ marginTop: 10 }}>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>
                  Paste <code>~/.claude/.credentials.json</code> contents
                </div>
                <textarea
                  value={credsJson}
                  onChange={e => setCredsJson(e.target.value)}
                  placeholder={'{\n  "claudeAiOauth": {\n    "accessToken": "...",\n    "refreshToken": "...",\n    "expiresAt": 1234567890000\n  }\n}'}
                  style={{ ...inputStyle, height: 100, resize: 'vertical', fontFamily: 'monospace', fontSize: 11 }}
                />
              </div>

              {(credsError || credsSuccess) && (
                <div style={{ fontSize: 12, color: credsError ? 'var(--error, #e5534b)' : 'var(--accent)', fontWeight: 700, marginTop: 4 }}>
                  {credsError || credsSuccess}
                </div>
              )}

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10 }}>
                <button type="button" onClick={checkServerCreds}
                  style={{ ...buttonStyle, padding: '8px 10px', background: 'var(--bg-elevated)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}>
                  Check Status
                </button>
                <button type="button" onClick={seedMasterCredentials} style={buttonStyle} disabled={credsSaving || !credsJson.trim()}>
                  {credsSaving ? 'Saving…' : 'Update Credentials'}
                </button>
              </div>
            </div>

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
        {tab === 'tokens' && (
          <div style={{ padding: 12 }}>
            <div style={card}>
              <div style={{ fontSize: 13, fontWeight: 900, color: 'var(--text-primary)', marginBottom: 12 }}>
                Token Optimization — All Users
              </div>
              {tokenLoading ? (
                <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>Loading…</div>
              ) : tokenUsers.length === 0 ? (
                <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                  No data yet. Users must open the Token Dashboard tab in the IDE at least once to sync their stats.
                </div>
              ) : (
                <>
                  {/* Aggregate row */}
                  <div style={{ display: 'flex', gap: 20, marginBottom: 14, flexWrap: 'wrap' }}>
                    {[
                      { label: 'Users synced', value: tokenUsers.length },
                      { label: 'Total sessions', value: tokenUsers.reduce((s, u) => s + (u.stats?.sessions || 0), 0) },
                      { label: 'Avg cache hit', value: tokenUsers.length ? ((tokenUsers.reduce((s, u) => s + (u.stats?.avg_cache_hit || 0), 0) / tokenUsers.length) * 100).toFixed(0) + '%' : '—' },
                      { label: 'Avg quality', value: tokenUsers.length ? (tokenUsers.reduce((s, u) => s + (u.stats?.avg_quality || 0), 0) / tokenUsers.length).toFixed(0) : '—' },
                    ].map(({ label, value }) => (
                      <div key={label} style={{ textAlign: 'center', minWidth: 80 }}>
                        <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--accent)' }}>{value}</div>
                        <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</div>
                      </div>
                    ))}
                  </div>
                  {/* Per-user table */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 60px 60px 60px 60px 120px', gap: 4, fontSize: 11 }}>
                    {['User', 'Sess', 'Cache%', 'Qual', 'Min', 'Last Sync'].map(h => (
                      <div key={h} style={{ color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', fontSize: 10, letterSpacing: '0.06em', paddingBottom: 6, borderBottom: '1px solid var(--border)' }}>{h}</div>
                    ))}
                    {tokenUsers.map((u, i) => (
                      <React.Fragment key={i}>
                        <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', padding: '5px 0', borderBottom: '1px solid var(--border)' }} title={u.email}>{u.email}</div>
                        <div style={{ padding: '5px 0', borderBottom: '1px solid var(--border)' }}>{u.stats?.sessions || 0}</div>
                        <div style={{ padding: '5px 0', borderBottom: '1px solid var(--border)' }}>{u.stats?.avg_cache_hit != null ? (u.stats.avg_cache_hit * 100).toFixed(0) + '%' : '—'}</div>
                        <div style={{ padding: '5px 0', borderBottom: '1px solid var(--border)' }}>{u.stats?.avg_quality != null ? Number(u.stats.avg_quality).toFixed(0) : '—'}</div>
                        <div style={{ padding: '5px 0', borderBottom: '1px solid var(--border)' }}>{u.stats?.duration_minutes != null ? Number(u.stats.duration_minutes).toFixed(0) : '—'}</div>
                        <div style={{ padding: '5px 0', borderBottom: '1px solid var(--border)', color: 'var(--text-muted)' }}>{u.last_sync ? new Date(u.last_sync).toLocaleDateString() : '—'}</div>
                      </React.Fragment>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

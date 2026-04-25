import React, { useEffect, useState, useCallback } from 'react';
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
  const [tab, setTab] = useState('users'); // 'users' | 'usage'
  const [users, setUsers] = useState([]);
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [createEmail, setCreateEmail] = useState('');
  const [createPassword, setCreatePassword] = useState('');
  const [createRole, setCreateRole] = useState('user');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

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
      </div>

      <div style={{ flex: 1, overflow: 'auto' }}>
        {tab === 'usage' && <UsagePanel />}

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


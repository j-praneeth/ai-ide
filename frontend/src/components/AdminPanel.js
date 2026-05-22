import React, { useCallback, useEffect, useState, useMemo } from 'react';
import axios from 'axios';
import { API_URL as API, AUTH_URL as AUTH } from '../config';
import { getAuthUser, authFetch } from '../lib/auth';
import UsagePanel from './UsagePanel';
import {
  VscOrganization, VscPulse, VscKey, VscGraph,
  VscAdd, VscEdit, VscTrash, VscRefresh, VscSearch,
  VscClose, VscCheck, VscShield, VscLock,
} from 'react-icons/vsc';

const GRADE_COLOR = { A: '#4caf50', B: '#8bc34a', C: '#ffc107', D: '#ff9800', F: '#f44336' };
const ROLE_META = {
  super_admin: { label: 'Admin', bg: 'rgba(0,200,120,0.12)', color: '#00c878' },
  user:        { label: 'User',  bg: 'rgba(255,255,255,0.06)', color: 'var(--text-muted)' },
};

// ── Shared primitives ─────────────────────────────────────────────────────────
const inp = {
  width: '100%', background: 'var(--bg-elevated)', border: '1px solid var(--border)',
  borderRadius: 8, padding: '9px 12px', color: 'var(--text-primary)',
  outline: 'none', fontSize: 13, boxSizing: 'border-box',
};
const mkBtn = (variant = 'primary') => ({
  background: variant === 'primary' ? 'var(--accent)' : variant === 'danger' ? '#b71c1c' : 'var(--bg-elevated)',
  color: variant === 'primary' ? '#071018' : variant === 'danger' ? '#fff' : 'var(--text-primary)',
  border: variant === 'ghost' ? '1px solid var(--border)' : 'none',
  borderRadius: 8, padding: '8px 14px', fontWeight: 700, cursor: 'pointer',
  fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap',
});
const sectionCard = {
  background: 'var(--bg-surface)', border: '1px solid var(--border)',
  borderRadius: 12, padding: 20, marginBottom: 16,
};

function Avatar({ email, size = 30 }) {
  const c = ['#7c4dff','#00bcd4','#ff6b35','#4caf50','#e91e63'];
  const color = c[((email || '?').charCodeAt(0)) % c.length];
  return (
    <div style={{ width: size, height: size, borderRadius: '50%', background: color + '22',
      border: `1.5px solid ${color}55`, display: 'flex', alignItems: 'center',
      justifyContent: 'center', fontSize: size * 0.38, fontWeight: 700, color, flexShrink: 0 }}>
      {(email || '?')[0].toUpperCase()}
    </div>
  );
}
function RoleBadge({ role }) {
  const m = ROLE_META[role] || ROLE_META.user;
  return <span style={{ background: m.bg, color: m.color, fontSize: 10, fontWeight: 700,
    padding: '2px 8px', borderRadius: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{m.label}</span>;
}
function Alert({ ok, msg }) {
  if (!msg) return null;
  return <div style={{ fontSize: 12, fontWeight: 600, padding: '8px 12px', borderRadius: 8,
    background: ok ? 'rgba(76,175,80,0.1)' : 'rgba(183,28,28,0.1)',
    border: `1px solid ${ok ? '#4caf5066' : '#b71c1c66'}`,
    color: ok ? '#4caf50' : '#ef5350' }}>{ok ? '✓ ' : '✗ '}{msg}</div>;
}
function Label({ children }) {
  return <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)',
    textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>{children}</div>;
}

// ── Confirm Dialog ────────────────────────────────────────────────────────────
function ConfirmDialog({ message, onConfirm, onCancel, loading }) {
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 3000, background: 'rgba(0,0,0,0.65)',
      display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 14,
        padding: 28, width: 340, boxShadow: '0 24px 64px rgba(0,0,0,0.6)' }}>
        <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--text-primary)', marginBottom: 10 }}>Confirm Delete</div>
        <div style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.5, marginBottom: 24 }}>{message}</div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" onClick={onCancel} style={mkBtn('ghost')}>Cancel</button>
          <button type="button" onClick={onConfirm} style={mkBtn('danger')} disabled={loading}>
            <VscTrash size={13} />{loading ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Edit User Modal ───────────────────────────────────────────────────────────
function EditUserModal({ u, onClose, onSaved }) {
  const [role, setRole] = useState(u.role || 'user');
  const [pwd, setPwd] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const save = async () => {
    setSaving(true); setErr('');
    try {
      const body = { role };
      if (pwd.trim()) body.password = pwd.trim();
      const r = await authFetch(`${API}/auth/users/${u.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!j.ok) { setErr(j.error || 'Update failed'); return; }
      onSaved();
    } catch (e) { setErr(e.message || 'Update failed'); }
    finally { setSaving(false); }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 3000, background: 'rgba(0,0,0,0.65)',
      display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 14,
        padding: 28, width: 380, boxShadow: '0 24px 64px rgba(0,0,0,0.6)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 22 }}>
          <Avatar email={u.email} size={38} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.email}</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>Edit account</div>
          </div>
          <button type="button" onClick={onClose} style={{ ...mkBtn('ghost'), padding: '6px 8px' }}><VscClose size={14} /></button>
        </div>
        <div style={{ display: 'grid', gap: 14 }}>
          <div>
            <Label>Role</Label>
            <select value={role} onChange={e => setRole(e.target.value)} style={inp}>
              <option value="user">User</option>
              <option value="super_admin">Super Admin</option>
            </select>
          </div>
          <div>
            <Label>New Password <span style={{ fontWeight: 400, textTransform: 'none' }}>(blank = keep current)</span></Label>
            <input type="password" value={pwd} onChange={e => setPwd(e.target.value)}
              placeholder="Enter new password…" style={inp} />
          </div>
          {err && <Alert msg={err} />}
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 22 }}>
          <button type="button" onClick={onClose} style={mkBtn('ghost')}>Cancel</button>
          <button type="button" onClick={save} style={mkBtn('primary')} disabled={saving}>
            <VscCheck size={13} />{saving ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Users View ────────────────────────────────────────────────────────────────
function UsersView({ users, loading, onRefresh }) {
  const [search, setSearch] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [email, setEmail] = useState('');
  const [pwd, setPwd] = useState('');
  const [role, setRole] = useState('user');
  const [creating, setCreating] = useState(false);
  const [createMsg, setCreateMsg] = useState({ ok: false, msg: '' });
  const [editTarget, setEditTarget] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const filtered = useMemo(
    () => users.filter(u => !search || (u.email || '').toLowerCase().includes(search.toLowerCase())),
    [users, search],
  );

  const createUser = async () => {
    setCreating(true); setCreateMsg({ ok: false, msg: '' });
    try {
      const res = await axios.post(`${API}/auth/users`, { email, password: pwd, role });
      if (res.data?.error) { setCreateMsg({ ok: false, msg: res.data.error }); return; }
      setCreateMsg({ ok: true, msg: `User ${email} created.` });
      setEmail(''); setPwd(''); setRole('user'); setShowForm(false);
      onRefresh();
      setTimeout(() => setCreateMsg({ ok: false, msg: '' }), 3500);
    } catch (e) { setCreateMsg({ ok: false, msg: e?.response?.data?.error || e.message || 'Create failed' }); }
    finally { setCreating(false); }
  };

  const deleteUser = async () => {
    setDeleting(true);
    try {
      await authFetch(`${API}/auth/users/${deleteTarget.id}`, { method: 'DELETE' });
      setDeleteTarget(null); onRefresh();
    } catch (_) { setDeleteTarget(null); }
    finally { setDeleting(false); }
  };

  return (
    <div style={{ padding: '24px 28px', maxWidth: 860, display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Page header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ flex: 1 }}>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: 'var(--text-primary)' }}>User Management</h2>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>
            {users.length} total account{users.length !== 1 ? 's' : ''}
          </div>
        </div>
        <button type="button" onClick={onRefresh} style={mkBtn('ghost')} disabled={loading}>
          <VscRefresh size={13} />Refresh
        </button>
        <button type="button" onClick={() => setShowForm(v => !v)} style={mkBtn('primary')}>
          <VscAdd size={13} />New User
        </button>
      </div>

      {createMsg.msg && <Alert ok={createMsg.ok} msg={createMsg.msg} />}

      {/* Create form */}
      {showForm && (
        <div style={sectionCard}>
          <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 18 }}>Create New User</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <div>
              <Label>Email</Label>
              <input value={email} onChange={e => setEmail(e.target.value)} placeholder="user@example.com" style={inp} />
            </div>
            <div>
              <Label>Password</Label>
              <input type="password" value={pwd} onChange={e => setPwd(e.target.value)} placeholder="Min 8 characters" style={inp} />
            </div>
            <div>
              <Label>Role</Label>
              <select value={role} onChange={e => setRole(e.target.value)} style={inp}>
                <option value="user">User</option>
                <option value="super_admin">Super Admin</option>
              </select>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
            <button type="button" onClick={() => { setShowForm(false); setCreateMsg({ ok: false, msg: '' }); }} style={mkBtn('ghost')}>Cancel</button>
            <button type="button" onClick={createUser} style={mkBtn('primary')} disabled={creating || !email || !pwd}>
              <VscAdd size={13} />{creating ? 'Creating…' : 'Create User'}
            </button>
          </div>
        </div>
      )}

      {/* Search */}
      <div style={{ position: 'relative' }}>
        <VscSearch size={13} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
        <input value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search by email…" style={{ ...inp, paddingLeft: 34 }} />
      </div>

      {/* User table */}
      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '40px 1fr 110px 120px 88px', gap: 12,
          padding: '10px 18px', background: 'var(--bg-elevated)', borderBottom: '1px solid var(--border)' }}>
          {['', 'User', 'Role', 'Joined', 'Actions'].map(h => (
            <div key={h} style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
              letterSpacing: '0.07em', color: 'var(--text-muted)' }}>{h}</div>
          ))}
        </div>

        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>Loading users…</div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
            {search ? 'No users match your search.' : 'No users yet. Create one above.'}
          </div>
        ) : filtered.map((u, i) => (
          <div key={u.id || i} style={{ display: 'grid', gridTemplateColumns: '40px 1fr 110px 120px 88px',
            gap: 12, padding: '13px 18px', alignItems: 'center',
            borderBottom: i < filtered.length - 1 ? '1px solid var(--border)' : 'none',
            transition: 'background 0.1s',
          }}
            onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-elevated)'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
          >
            <Avatar email={u.email} size={30} />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.email}</div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 1, fontFamily: 'monospace' }}>
                {String(u.id || '').slice(0, 12)}…
              </div>
            </div>
            <RoleBadge role={u.role} />
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              {u.created_at ? new Date(u.created_at).toLocaleDateString() : '—'}
            </div>
            <div style={{ display: 'flex', gap: 5 }}>
              <button type="button" title="Edit user" onClick={() => setEditTarget(u)}
                style={{ ...mkBtn('ghost'), padding: '5px 9px' }}><VscEdit size={13} /></button>
              <button type="button" title="Delete user" onClick={() => setDeleteTarget(u)}
                style={{ ...mkBtn('ghost'), padding: '5px 9px', color: '#ef5350', borderColor: '#b71c1c44' }}>
                <VscTrash size={13} />
              </button>
            </div>
          </div>
        ))}
      </div>

      {editTarget && (
        <EditUserModal u={editTarget} onClose={() => setEditTarget(null)}
          onSaved={() => { setEditTarget(null); onRefresh(); }} />
      )}
      {deleteTarget && (
        <ConfirmDialog
          message={`Permanently delete "${deleteTarget.email}"? This action cannot be undone.`}
          onConfirm={deleteUser} onCancel={() => setDeleteTarget(null)} loading={deleting}
        />
      )}
    </div>
  );
}

// ── Token Stats View ──────────────────────────────────────────────────────────
const fmtTokens = n => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1000 ? (n / 1000).toFixed(0) + 'k' : String(n || '—');

function UserTokenDetail({ u }) {
  const saved = u.stats?.tokens_saved || (u.stats?.total_input && u.stats?.avg_cache_hit
    ? Math.round(u.stats.total_input * u.stats.avg_cache_hit) : 0);
  const cacheHitPct = u.stats?.avg_cache_hit != null ? (u.stats.avg_cache_hit * 100).toFixed(1) : '—';
  const tokensSavedM = saved > 0 ? (saved / 1e6).toFixed(1) : null;
  const totalInputM = u.stats?.total_input != null ? (u.stats.total_input / 1e6).toFixed(1) : '—';
  const sessions = u.recent_sessions || [];
  const daily = u.recent_daily || [];

  const statCardStyle = {
    background: 'var(--bg-elevated)', border: '1px solid var(--border)',
    borderRadius: 10, padding: '12px 10px', textAlign: 'center', flex: 1,
  };

  return (
    <div style={{ padding: '16px 18px', borderTop: '1px solid var(--border)', background: 'var(--bg-primary)' }}>
      {/* 4 stat cards */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
        {[
          { l: 'Cache Hit %', v: `${cacheHitPct}%` },
          { l: 'Quality',     v: u.stats?.avg_quality != null ? Number(u.stats.avg_quality).toFixed(0) : '—' },
          { l: 'Sessions',    v: u.stats?.sessions || 0 },
          { l: 'Input',       v: `${totalInputM}M` },
        ].map(({ l, v }) => (
          <div key={l} style={statCardStyle}>
            <div style={{ fontSize: 18, fontWeight: 800, color: 'var(--accent)' }}>{v}</div>
            <div style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginTop: 3 }}>{l}</div>
          </div>
        ))}
      </div>

      {/* Savings banner */}
      {tokensSavedM && (
        <div style={{ background: 'rgba(0,200,120,0.08)', border: '1px solid rgba(0,200,120,0.2)',
          borderRadius: 8, padding: '8px 12px', fontSize: 12, color: '#00c878', marginBottom: 14 }}>
          Token cache saved <strong>{tokensSavedM}M</strong> tokens ({cacheHitPct}% cache hit rate)
        </div>
      )}

      {/* Recent Sessions */}
      <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em',
        color: 'var(--text-muted)', marginBottom: 6 }}>Recent Sessions</div>
      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden', fontSize: 11, marginBottom: 14 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '90px 1fr 46px 50px 55px',
          gap: 4, padding: '7px 12px', background: 'var(--bg-elevated)',
          borderBottom: '1px solid var(--border)', fontSize: 10, fontWeight: 700,
          textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)' }}>
          {['Date', 'Project', 'Grade', 'Dur', 'Saved'].map(h => <span key={h}>{h}</span>)}
        </div>
        {sessions.length === 0 ? (
          <div style={{ padding: '12px', color: 'var(--text-muted)', fontSize: 11, textAlign: 'center' }}>No sessions synced.</div>
        ) : sessions.slice(0, 10).map((s, si) => {
          const sessSaved = (s.input_tokens && s.cache_hit_rate) ? s.input_tokens * s.cache_hit_rate : 0;
          const savedLabel = sessSaved >= 1e6 ? (sessSaved / 1e6).toFixed(1) + 'M'
            : sessSaved >= 1000 ? (sessSaved / 1000).toFixed(0) + 'k' : '—';
          return (
            <div key={si} style={{ display: 'grid', gridTemplateColumns: '90px 1fr 46px 50px 55px',
              gap: 4, padding: '7px 12px', borderBottom: si < sessions.slice(0, 10).length - 1 ? '1px solid var(--border)' : 'none',
              fontVariantNumeric: 'tabular-nums' }}>
              <span style={{ color: 'var(--text-muted)' }}>{s.date}</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={s.project}>
                {(s.project || '').replace(/^[A-Za-z]--/, '') || '—'}
              </span>
              <span style={{ fontWeight: 700, color: GRADE_COLOR[s.quality_grade] || 'var(--text-muted)' }}>{s.quality_grade || '—'}</span>
              <span>{s.duration_minutes != null ? `${Number(s.duration_minutes).toFixed(0)}m` : '—'}</span>
              <span>{savedLabel}</span>
            </div>
          );
        })}
      </div>

      {/* Daily Breakdown */}
      {daily.length > 0 && (
        <>
          <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em',
            color: 'var(--text-muted)', marginBottom: 6 }}>Daily Breakdown</div>
          <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden', fontSize: 11 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '90px 46px 64px 56px',
              gap: 4, padding: '7px 12px', background: 'var(--bg-elevated)',
              borderBottom: '1px solid var(--border)', fontSize: 10, fontWeight: 700,
              textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)' }}>
              {['Date', 'Sess', 'Cache%', 'Grade'].map(h => <span key={h}>{h}</span>)}
            </div>
            {daily.slice(0, 10).map((d, di) => (
              <div key={di} style={{ display: 'grid', gridTemplateColumns: '90px 46px 64px 56px',
                gap: 4, padding: '7px 12px', borderBottom: di < daily.slice(0, 10).length - 1 ? '1px solid var(--border)' : 'none',
                fontVariantNumeric: 'tabular-nums' }}>
                <span style={{ color: 'var(--text-muted)' }}>{d.date}</span>
                <span>{d.session_count}</span>
                <span>{d.avg_cache_hit != null ? (d.avg_cache_hit * 100).toFixed(0) + '%' : '—'}</span>
                <span style={{ fontWeight: 700, color: GRADE_COLOR[d.worst_grade] || 'var(--text-muted)' }}>{d.worst_grade || '—'}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function TokenStatsView({ tokenUsers, loading, expandedIdx, onExpand }) {
  const totalSaved = tokenUsers.reduce((s, u) => {
    const sv = u.stats?.tokens_saved || (u.stats?.total_input && u.stats?.avg_cache_hit
      ? Math.round(u.stats.total_input * u.stats.avg_cache_hit) : 0);
    return s + sv;
  }, 0);

  return (
    <div style={{ padding: '24px 28px', maxWidth: 900, display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: 'var(--text-primary)' }}>Token Analytics</h2>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>Per-user token optimization stats synced from local machines</div>
      </div>

      {/* Aggregate summary */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: 12 }}>
        {[
          { label: 'Users Synced',   value: tokenUsers.length, icon: '👥' },
          { label: 'Total Sessions', value: tokenUsers.reduce((s, u) => s + (u.stats?.sessions || 0), 0), icon: '💬' },
          { label: 'Tokens Saved',   value: fmtTokens(totalSaved), icon: '💾' },
          { label: 'Avg Cache Hit',  value: tokenUsers.length ? ((tokenUsers.reduce((s, u) => s + (u.stats?.avg_cache_hit || 0), 0) / tokenUsers.length) * 100).toFixed(0) + '%' : '—', icon: '⚡' },
          { label: 'Avg Quality',    value: tokenUsers.length ? (tokenUsers.reduce((s, u) => s + (u.stats?.avg_quality || 0), 0) / tokenUsers.length).toFixed(0) : '—', icon: '🏆' },
        ].map(({ label, value, icon }) => (
          <div key={label} style={{ ...sectionCard, marginBottom: 0, textAlign: 'center', padding: '16px 12px' }}>
            <div style={{ fontSize: 20, marginBottom: 4 }}>{icon}</div>
            <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--accent)' }}>{value}</div>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginTop: 4 }}>{label}</div>
          </div>
        ))}
      </div>

      {loading ? (
        <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)' }}>Loading…</div>
      ) : tokenUsers.length === 0 ? (
        <div style={{ ...sectionCard, textAlign: 'center', padding: 32, color: 'var(--text-muted)' }}>
          No data yet. Users must open the Token Dashboard sidebar tab at least once to sync their stats.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {tokenUsers.map((u, i) => {
            const saved = u.stats?.tokens_saved || (u.stats?.total_input && u.stats?.avg_cache_hit
              ? Math.round(u.stats.total_input * u.stats.avg_cache_hit) : 0);
            const exp = expandedIdx === i;
            return (
              <div key={i} style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
                <div onClick={() => onExpand(exp ? null : i)}
                  style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 16px', cursor: 'pointer',
                    background: exp ? 'var(--bg-elevated)' : 'transparent' }}>
                  <Avatar email={u.email} size={32} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.email}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>
                      Last sync: {u.last_sync ? new Date(u.last_sync).toLocaleString() : 'never'}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexShrink: 0 }}>
                    <div style={{ textAlign: 'center' }}>
                      <div style={{ fontSize: 14, fontWeight: 800, color: 'var(--accent)' }}>{u.stats?.sessions || 0}</div>
                      <div style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Sessions</div>
                    </div>
                    <div style={{ textAlign: 'center' }}>
                      <div style={{ fontSize: 14, fontWeight: 800, color: '#4caf50' }}>{fmtTokens(saved)}</div>
                      <div style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Saved</div>
                    </div>
                    <div style={{ textAlign: 'center' }}>
                      <div style={{ fontSize: 14, fontWeight: 800, color: 'var(--accent)' }}>
                        {u.stats?.avg_cache_hit != null ? (u.stats.avg_cache_hit * 100).toFixed(0) + '%' : '—'}
                      </div>
                      <div style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Cache</div>
                    </div>
                    <span style={{ color: 'var(--text-muted)', fontSize: 14 }}>{exp ? '▾' : '▸'}</span>
                  </div>
                </div>
                {exp && <UserTokenDetail u={u} />}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Limits View ───────────────────────────────────────────────────────────────
function LimitsView({ users, limitsData, loading, onSave, onRemove }) {
  const [editingId, setEditingId] = useState(null);
  const [sessDay, setSessDay] = useState('');
  const [tokMonth, setTokMonth] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);

  const openEdit = (u) => {
    const existing = limitsData.find(d => d.user_id === u.id);
    setSessDay(existing?.sessions_per_day != null ? String(existing.sessions_per_day) : '');
    setTokMonth(existing?.tokens_per_month != null ? String(Math.round(existing.tokens_per_month / 1e6)) : '');
    setEnabled(existing?.enabled !== false);
    setEditingId(u.id);
  };

  const cancelEdit = () => { setEditingId(null); };

  const handleSave = async (u) => {
    setSaving(true);
    try {
      const payload = {
        sessions_per_day: sessDay !== '' ? parseInt(sessDay, 10) : null,
        tokens_per_month: tokMonth !== '' ? Math.round(parseFloat(tokMonth) * 1e6) : null,
        enabled,
      };
      await onSave(u.id, u.email, payload);
      setEditingId(null);
    } finally { setSaving(false); }
  };

  const handleRemove = async (userId) => {
    setSaving(true);
    try { await onRemove(userId); setEditingId(null); }
    finally { setSaving(false); }
  };

  const getLimitDoc = (userId) => limitsData.find(d => d.user_id === userId);

  const fmtTokenLimit = (n) => n == null ? '—' : n >= 1e6 ? (n / 1e6).toFixed(0) + 'M' : n >= 1000 ? (n / 1000).toFixed(0) + 'k' : String(n);

  const colStyle = { fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
    letterSpacing: '0.07em', color: 'var(--text-muted)' };
  const gridCols = '1fr 120px 130px 80px 100px';

  return (
    <div style={{ padding: '24px 28px', maxWidth: 860, display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: 'var(--text-primary)' }}>Usage Limits</h2>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>
          Set per-user Claude CLI session and token limits. Leave blank for unlimited.
        </div>
      </div>

      {loading ? (
        <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)' }}>Loading…</div>
      ) : (
        <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
          {/* Header */}
          <div style={{ display: 'grid', gridTemplateColumns: gridCols, gap: 12,
            padding: '10px 18px', background: 'var(--bg-elevated)', borderBottom: '1px solid var(--border)' }}>
            {['User', 'Sessions/Day', 'Tokens/Month', 'Enabled', 'Actions'].map(h => (
              <div key={h} style={colStyle}>{h}</div>
            ))}
          </div>

          {users.length === 0 ? (
            <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>No users yet.</div>
          ) : users.map((u, i) => {
            const doc = getLimitDoc(u.id);
            const isEditing = editingId === u.id;

            return (
              <div key={u.id || i}>
                <div style={{ display: 'grid', gridTemplateColumns: gridCols, gap: 12,
                  padding: '13px 18px', alignItems: 'center',
                  borderBottom: '1px solid var(--border)',
                  background: isEditing ? 'var(--bg-elevated)' : 'transparent',
                  transition: 'background 0.1s' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                    <Avatar email={u.email} size={26} />
                    <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.email}</div>
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
                    {doc?.sessions_per_day != null ? doc.sessions_per_day : '—'}
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
                    {fmtTokenLimit(doc?.tokens_per_month)}
                  </div>
                  <div>
                    {doc ? (
                      <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 10,
                        background: doc.enabled ? 'rgba(76,175,80,0.12)' : 'rgba(255,255,255,0.06)',
                        color: doc.enabled ? '#4caf50' : 'var(--text-muted)',
                        textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                        {doc.enabled ? 'On' : 'Off'}
                      </span>
                    ) : <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>—</span>}
                  </div>
                  <div>
                    <button type="button" onClick={() => isEditing ? cancelEdit() : openEdit(u)}
                      style={{ ...mkBtn('ghost'), padding: '5px 10px', fontSize: 11 }}>
                      <VscEdit size={12} />{isEditing ? 'Cancel' : 'Edit'}
                    </button>
                  </div>
                </div>

                {isEditing && (
                  <div style={{ padding: '14px 18px', background: 'var(--bg-primary)',
                    borderBottom: '1px solid var(--border)' }}>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 120px', gap: 12, marginBottom: 12 }}>
                      <div>
                        <Label>Sessions / Day <span style={{ fontWeight: 400, textTransform: 'none' }}>(blank = unlimited)</span></Label>
                        <input type="number" min="1" value={sessDay}
                          onChange={e => setSessDay(e.target.value)}
                          placeholder="e.g. 10" style={inp} />
                      </div>
                      <div>
                        <Label>Tokens / Month (millions) <span style={{ fontWeight: 400, textTransform: 'none' }}>(blank = unlimited)</span></Label>
                        <input type="number" min="1" value={tokMonth}
                          onChange={e => setTokMonth(e.target.value)}
                          placeholder="e.g. 5 = 5M" style={inp} />
                      </div>
                      <div>
                        <Label>Enabled</Label>
                        <div style={{ display: 'flex', alignItems: 'center', height: 38, gap: 8 }}>
                          <button type="button"
                            onClick={() => setEnabled(v => !v)}
                            style={{ ...mkBtn(enabled ? 'primary' : 'ghost'), padding: '6px 14px' }}>
                            {enabled ? <VscCheck size={12} /> : <VscClose size={12} />}
                            {enabled ? 'On' : 'Off'}
                          </button>
                        </div>
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                      {getLimitDoc(u.id) && (
                        <button type="button" onClick={() => handleRemove(u.id)}
                          style={mkBtn('danger')} disabled={saving}>
                          <VscTrash size={12} />{saving ? 'Removing…' : 'Remove Limit'}
                        </button>
                      )}
                      <button type="button" onClick={cancelEdit} style={mkBtn('ghost')}>Cancel</button>
                      <button type="button" onClick={() => handleSave(u)}
                        style={mkBtn('primary')} disabled={saving}>
                        <VscCheck size={12} />{saving ? 'Saving…' : 'Save Limit'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Configurations View ───────────────────────────────────────────────────────
function ConfigurationsView({ isAdmin }) {
  const [bundleLoading, setBundleLoading] = useState(false);
  const [bundleStatus, setBundleStatus] = useState(null);
  const [bundleErr, setBundleErr] = useState('');
  const [bundleOk, setBundleOk] = useState('');
  const [repairing, setRepairing] = useState(false);
  const [credsStatus, setCredsStatus] = useState(null);
  const [credsMsg, setCredsMsg] = useState('');
  const [credsJson, setCredsJson] = useState('');
  const [credsSaving, setCredsSaving] = useState(false);
  const [credsErr, setCredsErr] = useState('');
  const [credsOk, setCredsOk] = useState('');

  const refreshBundle = useCallback(async () => {
    if (!window.electronAPI?.cliBundleStatus) {
      setBundleErr('CLI bundle status is only available in the desktop app.'); return;
    }
    setBundleLoading(true); setBundleErr('');
    try { setBundleStatus(await window.electronAPI.cliBundleStatus() || null); }
    catch (e) { setBundleErr(e?.message || 'Failed'); }
    finally { setBundleLoading(false); }
  }, []);

  const repairBundle = async (force = false) => {
    if (!window.electronAPI?.cliBundleRepair) { setBundleErr('Desktop app only.'); return; }
    setRepairing(true); setBundleErr(''); setBundleOk('');
    try {
      const res = await window.electronAPI.cliBundleRepair({ override: force });
      if (!res?.ok) { setBundleErr(`${res?.errorCode || 'ERR'}: ${res?.message || 'Failed'}`); }
      else { setBundleOk(res.status === 'installed' ? 'Credentials reinstalled.' : 'Credentials healthy.'); setTimeout(() => setBundleOk(''), 3500); }
      await refreshBundle();
    } catch (e) { setBundleErr(e?.message || 'Repair failed'); }
    finally { setRepairing(false); }
  };

  const checkCreds = useCallback(async () => {
    setCredsStatus(null); setCredsMsg('Checking…');
    try {
      const res = await axios.get(`${AUTH}/auth/claude-token`);
      if (res.data?.ok && res.data?.accessToken) { setCredsStatus('ok'); setCredsMsg('Server has valid Claude credentials.'); }
      else { setCredsStatus('missing'); setCredsMsg(res.data?.error || 'No access token'); }
    } catch (e) {
      const d = e?.response?.data || {};
      setCredsStatus(d.authFailure ? 'expired' : 'missing');
      setCredsMsg(d.error || e.message || 'Failed to reach server');
    }
  }, []);

  const saveCreds = async () => {
    setCredsErr(''); setCredsOk('');
    let parsed;
    try { parsed = JSON.parse(credsJson.trim()); } catch (_) { setCredsErr('Invalid JSON'); return; }
    const oauth = parsed.claudeAiOauth || parsed.oauth || parsed;
    if (!oauth?.refreshToken) { setCredsErr('No refreshToken found.'); return; }
    setCredsSaving(true);
    try {
      const res = await axios.post(`${AUTH}/auth/claude-credentials`, { oauth });
      if (res.data?.ok) { setCredsOk('Master credentials updated.'); setCredsJson(''); checkCreds(); setTimeout(() => setCredsOk(''), 4000); }
      else setCredsErr(res.data?.error || 'Update failed');
    } catch (e) { setCredsErr(e?.response?.data?.error || e.message || 'Failed'); }
    finally { setCredsSaving(false); }
  };

  useEffect(() => { refreshBundle(); }, [refreshBundle]);

  return (
    <div style={{ padding: '24px 28px', maxWidth: 700, display: 'flex', flexDirection: 'column', gap: 0 }}>
      <h2 style={{ margin: '0 0 20px', fontSize: 20, fontWeight: 800, color: 'var(--text-primary)' }}>Configurations</h2>

      {/* Master credentials */}
      <div style={sectionCard}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <div style={{ width: 34, height: 34, borderRadius: 8, background: 'rgba(0,200,120,0.1)',
            border: '1px solid rgba(0,200,120,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <VscKey size={16} style={{ color: '#00c878' }} />
          </div>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>Master Claude Credentials</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Distributed to all users at CLI start — tokens never expire</div>
          </div>
        </div>
        {credsStatus && <div style={{ marginBottom: 10 }}><Alert ok={credsStatus === 'ok'} msg={credsMsg} /></div>}
        {!credsStatus && credsMsg && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>{credsMsg}</div>}
        <Label>Paste contents of <code>~/.claude/.credentials.json</code></Label>
        <textarea value={credsJson} onChange={e => setCredsJson(e.target.value)}
          placeholder={'{\n  "claudeAiOauth": {\n    "accessToken": "...",\n    "refreshToken": "...",\n    "expiresAt": 1234567890000\n  }\n}'}
          style={{ ...inp, height: 96, resize: 'vertical', fontFamily: 'monospace', fontSize: 11 }} />
        {credsErr && <div style={{ marginTop: 8 }}><Alert msg={credsErr} /></div>}
        {credsOk  && <div style={{ marginTop: 8 }}><Alert ok msg={credsOk} /></div>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
          <button type="button" onClick={checkCreds} style={mkBtn('ghost')}>Check Status</button>
          <button type="button" onClick={saveCreds} style={mkBtn('primary')} disabled={credsSaving || !credsJson.trim()}>
            <VscShield size={13} />{credsSaving ? 'Saving…' : 'Update Credentials'}
          </button>
        </div>
      </div>

      {/* CLI Bundle */}
      <div style={sectionCard}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <div style={{ width: 34, height: 34, borderRadius: 8, background: 'rgba(124,77,255,0.1)',
            border: '1px solid rgba(124,77,255,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <VscLock size={16} style={{ color: '#7c4dff' }} />
          </div>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>CLI Auth Bundle</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Repair if Claude CLI starts prompting for login</div>
          </div>
        </div>
        {bundleLoading ? (
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Loading status…</div>
        ) : bundleStatus?.marker ? (
          <div style={{ fontSize: 12, color: 'var(--text-primary)', lineHeight: 1.8 }}>
            <span style={{ color: 'var(--text-muted)' }}>Installed:</span> {bundleStatus.marker.installed_at || '—'}<br />
            <span style={{ color: 'var(--text-muted)' }}>Bundle SHA:</span> <code style={{ fontSize: 11 }}>{(bundleStatus.marker.bundleSha || '').slice(0, 16)}…</code><br />
            <span style={{ color: bundleStatus.files?.claudeCreds ? '#4caf50' : '#ef5350' }}>
              {bundleStatus.files?.claudeCreds ? '✓' : '✗'} claude.credentials_json
            </span>{' · '}
            <span style={{ color: bundleStatus.files?.codexAuth ? '#4caf50' : '#ef5350' }}>
              {bundleStatus.files?.codexAuth ? '✓' : '✗'} codex.auth_json
            </span>
          </div>
        ) : (
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{bundleErr || 'Not installed — use Repair.'}</div>
        )}
        {bundleStatus?.lastError && (
          <div style={{ marginTop: 8, fontSize: 11, color: '#ef5350', fontFamily: 'monospace' }}>
            {bundleStatus.lastError.code}: {bundleStatus.lastError.message}
          </div>
        )}
        {bundleOk && <div style={{ marginTop: 8 }}><Alert ok msg={bundleOk} /></div>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
          <button type="button" onClick={refreshBundle} style={mkBtn('ghost')} disabled={bundleLoading}><VscRefresh size={13} />Refresh</button>
          {bundleStatus?.lastError?.code === 'BUNDLE_LOCK_STUCK' && (
            <button type="button" onClick={() => repairBundle(true)} style={mkBtn('ghost')} disabled={repairing}>Force Repair</button>
          )}
          <button type="button" onClick={() => repairBundle(false)} style={mkBtn('primary')} disabled={repairing}>
            <VscShield size={13} />{repairing ? 'Repairing…' : 'Repair CLI Auth'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main AdminPanel ───────────────────────────────────────────────────────────
const NAV = [
  { id: 'users',          label: 'Users',          icon: VscOrganization },
  { id: 'usage',          label: 'Monitoring',     icon: VscPulse },
  { id: 'configurations', label: 'Configurations', icon: VscKey },
  { id: 'tokens',         label: 'Token Analytics', icon: VscGraph },
  { id: 'limits',         label: 'Usage Limits',   icon: VscShield },
];

export default function AdminPanel() {
  const authUser = useMemo(() => getAuthUser(), []);
  const isAdmin = authUser?.role === 'super_admin';
  const [tab, setTab] = useState('users');
  const [users, setUsers] = useState([]);
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [tokenUsers, setTokenUsers] = useState([]);
  const [tokenLoading, setTokenLoading] = useState(false);
  const [expandedToken, setExpandedToken] = useState(null);
  const [limitsData, setLimitsData] = useState([]);
  const [limitsLoading, setLimitsLoading] = useState(false);

  const refreshUsers = useCallback(async () => {
    if (!isAdmin) return;
    setLoadingUsers(true);
    try { setUsers((await axios.get(`${API}/auth/users`)).data.users || []); }
    catch (_) { setUsers([]); }
    finally { setLoadingUsers(false); }
  }, [isAdmin]);

  useEffect(() => { refreshUsers(); }, [refreshUsers]);

  useEffect(() => {
    if (tab !== 'tokens' || !isAdmin) return;
    setTokenLoading(true);
    authFetch(`${API}/token-stats/all`)
      .then(r => r.json()).then(j => setTokenUsers(j.data || []))
      .catch(() => setTokenUsers([])).finally(() => setTokenLoading(false));
  }, [tab, isAdmin]);

  useEffect(() => {
    if (tab !== 'limits' || !isAdmin) return;
    setLimitsLoading(true);
    authFetch(`${API}/usage-limits/all`)
      .then(r => r.json()).then(j => setLimitsData(j.data || []))
      .catch(() => setLimitsData([])).finally(() => setLimitsLoading(false));
  }, [tab, isAdmin]);

  const saveLimit = useCallback(async (userId, email, limitPayload) => {
    await authFetch(`${API}/usage-limits/users/${userId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...limitPayload, email }),
    });
    authFetch(`${API}/usage-limits/all`)
      .then(r => r.json()).then(j => setLimitsData(j.data || []));
  }, []);

  const removeLimit = useCallback(async (userId) => {
    await authFetch(`${API}/usage-limits/users/${userId}`, { method: 'DELETE' });
    authFetch(`${API}/usage-limits/all`)
      .then(r => r.json()).then(j => setLimitsData(j.data || []));
  }, []);

  if (!isAdmin) {
    return <div style={{ padding: 24, color: 'var(--text-muted)', fontSize: 13 }}>Admin access required.</div>;
  }

  return (
    <div style={{ height: '100%', display: 'flex', overflow: 'hidden', background: 'var(--bg-primary)' }}>
      {/* Sidebar */}
      <div style={{ width: 200, flexShrink: 0, background: 'var(--bg-deep, var(--bg-surface))',
        borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', padding: '16px 10px', gap: 2 }}>
        <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em',
          color: 'var(--text-muted)', padding: '4px 8px 12px' }}>Admin Panel</div>
        {NAV.map(n => (
          <button key={n.id} type="button" onClick={() => setTab(n.id)}
            style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%',
              padding: '9px 12px', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13,
              fontWeight: tab === n.id ? 700 : 500, textAlign: 'left',
              background: tab === n.id ? 'var(--accent)' : 'transparent',
              color: tab === n.id ? '#071018' : 'var(--text-muted)',
              transition: 'background 0.15s, color 0.15s',
            }}
            onMouseEnter={e => { if (tab !== n.id) e.currentTarget.style.background = 'var(--bg-elevated)'; }}
            onMouseLeave={e => { if (tab !== n.id) e.currentTarget.style.background = 'transparent'; }}
          >
            <n.icon size={15} />
            <span style={{ flex: 1 }}>{n.label}</span>
            {n.id === 'users' && !loadingUsers && (
              <span style={{ fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 8,
                background: tab === 'users' ? 'rgba(0,0,0,0.18)' : 'var(--bg-elevated)',
                color: tab === 'users' ? '#071018' : 'var(--text-muted)' }}>{users.length}</span>
            )}
          </button>
        ))}

        {/* Bottom: logged-in admin */}
        <div style={{ marginTop: 'auto', padding: '12px 8px 4px', borderTop: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Avatar email={authUser?.email} size={26} />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-primary)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{authUser?.email}</div>
              <div style={{ fontSize: 9, color: '#00c878', textTransform: 'uppercase', fontWeight: 700 }}>Admin</div>
            </div>
          </div>
        </div>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: 'auto' }}>
        {tab === 'users'          && <UsersView users={users} loading={loadingUsers} onRefresh={refreshUsers} />}
        {tab === 'usage'          && <div style={{ padding: 0 }}><UsagePanel /></div>}
        {tab === 'configurations' && <ConfigurationsView isAdmin={isAdmin} />}
        {tab === 'tokens'         && <TokenStatsView tokenUsers={tokenUsers} loading={tokenLoading} expandedIdx={expandedToken} onExpand={setExpandedToken} />}
        {tab === 'limits'         && <LimitsView users={users} limitsData={limitsData} loading={limitsLoading || loadingUsers} onSave={saveLimit} onRemove={removeLimit} />}
      </div>
    </div>
  );
}

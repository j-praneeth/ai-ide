import React, { useState, useEffect, useCallback } from 'react';
import { VscGraph, VscRefresh, VscCircleFilled } from 'react-icons/vsc';
import { getAuthUser, authFetch } from '../lib/auth';
import { API_URL as API } from '../config';

const GRADE_COLOR = { A: '#4caf50', B: '#8bc34a', C: '#ffc107', D: '#ff9800', F: '#f44336' };

function StatCard({ label, value, sub }) {
  return (
    <div className="tok-stat-card">
      <div className="tok-stat-value">{value}</div>
      <div className="tok-stat-label">{label}</div>
      {sub && <div className="tok-stat-sub">{sub}</div>}
    </div>
  );
}

export default function TokenDashboardPanel() {
  const [localData, setLocalData] = useState(null);
  const [allUsers, setAllUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [synced, setSynced] = useState(false);
  const user = getAuthUser();
  const isAdmin = user?.role === 'super_admin';

  const load = useCallback(async () => {
    setLoading(true);
    try {
      if (window.electronAPI?.tokenStatsReadLocal) {
        const res = await window.electronAPI.tokenStatsReadLocal();
        if (res.ok && res.data) {
          setLocalData(res.data);
          if (user) {
            const { totals, recent_daily } = res.data;
            authFetch(`${API}/token-stats/sync`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                stats: {
                  total_input: totals.ti || 0,
                  total_output: totals.to_ || 0,
                  sessions: totals.sc || 0,
                  avg_cache_hit: totals.ch || 0,
                  avg_quality: totals.qs || 0,
                  duration_minutes: ((totals.dur || 0) / 60).toFixed(1),
                },
                recent_daily: (recent_daily || []).slice(0, 30),
              }),
            }).then(() => setSynced(true)).catch(() => {});
          }
        }
      }
      if (isAdmin) {
        const r = await authFetch(`${API}/token-stats/all`);
        if (r.ok) {
          const j = await r.json();
          setAllUsers(j.data || []);
        }
      }
    } finally {
      setLoading(false);
    }
  }, [user, isAdmin]);

  useEffect(() => { load(); }, [load]);

  const t = localData?.totals || {};
  const sessions = localData?.sessions || [];
  const cacheHitPct = t.ch != null ? (t.ch * 100).toFixed(1) : '—';
  const quality = t.qs != null ? Number(t.qs).toFixed(0) : '—';
  const totalSessions = t.sc || 0;
  const totalInputM = t.ti ? (t.ti / 1e6).toFixed(1) : '—';
  const durationMin = t.dur ? (t.dur / 60).toFixed(0) : '—';

  // Admin aggregate totals across all users
  const adminTotals = allUsers.reduce((acc, u) => ({
    sessions: acc.sessions + (u.stats?.sessions || 0),
    cacheHit: acc.cacheHit + (u.stats?.avg_cache_hit || 0),
    count: acc.count + 1,
  }), { sessions: 0, cacheHit: 0, count: 0 });

  return (
    <div className="tok-panel">
      <div className="tok-header">
        <VscGraph size={14} />
        <span>Token Dashboard</span>
        {synced && <span className="tok-synced" title="Synced to server"><VscCircleFilled size={8} style={{ color: '#4caf50' }} /></span>}
        <button className="tok-refresh-btn" onClick={load} title="Refresh"><VscRefresh size={13} /></button>
      </div>

      {loading ? (
        <div className="tok-loading">Loading…</div>
      ) : (
        <>
          {/* ── Personal stats ── */}
          <div className="tok-section-title">YOUR USAGE</div>
          {localData ? (
            <>
              <div className="tok-stat-grid">
                <StatCard label="Cache Hit" value={`${cacheHitPct}%`} sub="tokens saved" />
                <StatCard label="Quality" value={quality} sub="avg / 100" />
                <StatCard label="Sessions" value={totalSessions} sub={`${durationMin} min`} />
                <StatCard label="Input" value={`${totalInputM}M`} sub="tokens" />
              </div>

              <div className="tok-section-title">RECENT SESSIONS</div>
              <div className="tok-session-list">
                {sessions.length === 0 && <div className="tok-empty">No sessions yet.</div>}
                {sessions.map((s, i) => (
                  <div key={i} className="tok-session-row">
                    <span className="tok-sess-date">{s.date}</span>
                    <span className="tok-sess-proj">{(s.project || '').replace(/^[A-Z]--/, '') || '—'}</span>
                    <span className="tok-sess-grade" style={{ color: GRADE_COLOR[s.quality_grade] || 'var(--text-muted)' }}>
                      {s.quality_grade || '—'}
                    </span>
                    <span className="tok-sess-cost">${(s.cost_usd || 0).toFixed(3)}</span>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="tok-empty tok-empty-main">
              No data yet. Open the Claude CLI tab to start a session — token optimization runs automatically.
            </div>
          )}

          {/* ── Admin: all users ── */}
          {isAdmin && (
            <>
              <div className="tok-section-title tok-admin-sep">ALL USERS (ADMIN)</div>
              <div className="tok-admin-summary">
                <span>{allUsers.length} users</span>
                <span>{adminTotals.sessions} total sessions</span>
                {adminTotals.count > 0 && (
                  <span>{((adminTotals.cacheHit / adminTotals.count) * 100).toFixed(0)}% avg cache</span>
                )}
              </div>
              {allUsers.length === 0 ? (
                <div className="tok-empty">No user data synced yet.</div>
              ) : (
                <div className="tok-admin-table">
                  <div className="tok-admin-hdr">
                    <span>User</span><span>Sess</span><span>Cache%</span><span>Qual</span>
                  </div>
                  {allUsers.map((u, i) => (
                    <div key={i} className="tok-admin-row">
                      <span className="tok-admin-email" title={u.email}>{u.email}</span>
                      <span>{u.stats?.sessions || 0}</span>
                      <span>{u.stats?.avg_cache_hit != null ? (u.stats.avg_cache_hit * 100).toFixed(0) + '%' : '—'}</span>
                      <span>{u.stats?.avg_quality != null ? Number(u.stats.avg_quality).toFixed(0) : '—'}</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

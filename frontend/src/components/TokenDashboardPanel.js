import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { VscGraph, VscRefresh, VscCircleFilled, VscChevronDown, VscChevronRight } from 'react-icons/vsc';
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

function UserCard({ u, isExpanded, onToggle }) {
  const daily = u.recent_daily || [];
  return (
    <div className="tok-user-card">
      <div className="tok-user-card-hdr" onClick={onToggle}>
        <span className="tok-expand-icon">
          {isExpanded ? <VscChevronDown size={11} /> : <VscChevronRight size={11} />}
        </span>
        <span className="tok-admin-email" title={u.email}>{u.email}</span>
        <span className="tok-user-badge">{u.stats?.sessions || 0}s</span>
        <span className="tok-user-badge tok-cache-badge">
          {u.stats?.avg_cache_hit != null ? (u.stats.avg_cache_hit * 100).toFixed(0) + '%' : '—'}
        </span>
        <span className="tok-user-badge tok-qual-badge"
          style={{ color: u.stats?.avg_quality >= 70 ? '#4caf50' : u.stats?.avg_quality >= 50 ? '#ffc107' : '#f44336' }}>
          {u.stats?.avg_quality != null ? 'Q' + Number(u.stats.avg_quality).toFixed(0) : '—'}
        </span>
        <span className="tok-user-badge tok-sync-badge">
          {u.last_sync ? new Date(u.last_sync).toLocaleDateString() : 'never'}
        </span>
      </div>
      {isExpanded && (
        <div className="tok-user-detail">
          <div className="tok-user-stat-row">
            {[
              { label: 'Sessions',   value: u.stats?.sessions || 0 },
              { label: 'Cache Hit',  value: u.stats?.avg_cache_hit != null ? (u.stats.avg_cache_hit * 100).toFixed(0) + '%' : '—' },
              { label: 'Saved',      value: (u.stats?.total_input && u.stats?.avg_cache_hit) ? ((u.stats.total_input * u.stats.avg_cache_hit) / 1e6).toFixed(1) + 'M' : '—' },
              { label: 'Quality',    value: u.stats?.avg_quality != null ? Number(u.stats.avg_quality).toFixed(0) : '—' },
            ].map(({ label, value }) => (
              <div key={label} className="tok-user-stat-box">
                <div className="tok-user-stat-val">{value}</div>
                <div className="tok-user-stat-lbl">{label}</div>
              </div>
            ))}
          </div>
          {daily.length > 0 && (
            <>
              <div className="tok-detail-sep">Daily Breakdown</div>
              <div className="tok-daily-mini">
                <div className="tok-daily-hdr">
                  <span>Date</span><span>Sess</span><span>Cache%</span><span>Grade</span>
                </div>
                {daily.slice(0, 10).map((d, i) => (
                  <div key={i} className="tok-daily-row">
                    <span>{d.date}</span>
                    <span>{d.session_count}</span>
                    <span>{d.avg_cache_hit != null ? (d.avg_cache_hit * 100).toFixed(0) + '%' : '—'}</span>
                    <span style={{ color: GRADE_COLOR[d.worst_grade] || 'var(--text-muted)' }}>
                      {d.worst_grade || '—'}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default function TokenDashboardPanel() {
  // useMemo gives a stable object reference — prevents useCallback from recreating
  // `load` on every render, which was causing an infinite re-fetch/flicker cycle.
  const user = useMemo(() => getAuthUser(), []);
  const isAdmin = user?.role === 'super_admin';

  const [localData, setLocalData] = useState(null);
  const [allUsers, setAllUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [synced, setSynced] = useState(false);
  const [expandedUser, setExpandedUser] = useState(null);

  // Fetch local SQLite stats + admin user list. `user` is excluded from deps
  // because it is now stable (useMemo). Only `isAdmin` (boolean) drives branching.
  const load = useCallback(async () => {
    setLoading(true);
    try {
      if (window.electronAPI?.tokenStatsReadLocal) {
        const res = await window.electronAPI.tokenStatsReadLocal();
        setLocalData(res.ok && res.data ? res.data : null);
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
  }, [isAdmin]);

  useEffect(() => { load(); }, [load]);

  // Sync local data to backend once after it loads — separated from the fetch loop
  // so a sync response never triggers another load cycle.
  useEffect(() => {
    if (!localData || !user) return;
    // IPC (token-stats:read-local) returns `daily` rows from daily_stats; each row
    // carries `date` and `session_count`, which the usage-limit check relies on.
    const { totals, daily, sessions } = localData;
    authFetch(`${API}/token-stats/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stats: {
          total_input:      totals.ti  || 0,
          total_output:     totals.to_ || 0,
          sessions:         totals.sc  || 0,
          avg_cache_hit:    totals.ch  || 0,
          avg_quality:      totals.qs  || 0,
          duration_minutes: (totals.dur || 0).toFixed(1),
          tokens_saved:     Math.round((totals.ti || 0) * (totals.ch || 0)),
        },
        recent_daily: (daily || []).slice(0, 30),
        recent_sessions: (sessions || []).slice(0, 50),
      }),
    }).then(() => setSynced(true)).catch(() => {});
  }, [localData]); // eslint-disable-line react-hooks/exhaustive-deps

  const t = localData?.totals || {};
  const sessions = localData?.sessions || [];
  const cacheHitPct   = t.ch != null ? (t.ch * 100).toFixed(1) : '—';
  const quality       = t.qs != null ? Number(t.qs).toFixed(0)  : '—';
  const totalSessions = t.sc  || 0;
  const durationHrs   = t.dur ? (t.dur / 60).toFixed(1) : '—';
  // Tokens saved = total input that was served from cache (no re-processing cost)
  const tokensSavedM  = (t.ti && t.ch) ? ((t.ti * t.ch) / 1e6).toFixed(1) : null;
  const totalInputM   = t.ti ? (t.ti / 1e6).toFixed(1) : '—';

  const adminTotals = useMemo(() => allUsers.reduce(
    (acc, u) => ({
      sessions: acc.sessions + (u.stats?.sessions || 0),
      cacheHit: acc.cacheHit + (u.stats?.avg_cache_hit || 0),
      count: acc.count + 1,
    }),
    { sessions: 0, cacheHit: 0, count: 0 },
  ), [allUsers]);

  return (
    <div className="tok-panel">
      <div className="tok-header">
        <VscGraph size={14} />
        <span>Token Dashboard</span>
        {synced && (
          <span className="tok-synced" title="Synced to server">
            <VscCircleFilled size={8} style={{ color: '#4caf50' }} />
          </span>
        )}
        <button className="tok-refresh-btn" onClick={load} title="Refresh">
          <VscRefresh size={13} />
        </button>
      </div>

      {loading ? (
        <div className="tok-loading">Loading…</div>
      ) : (
        <>
          {/* ── Personal stats (scoped to the logged-in OS user's ~/.claude) ── */}
          <div className="tok-section-title">
            YOUR USAGE
            {user?.email && <span className="tok-user-pill">{user.email}</span>}
          </div>

          {localData ? (
            <>
              <div className="tok-stat-grid">
                <StatCard
                  label="Cache Hit"
                  value={`${cacheHitPct}%`}
                  sub={tokensSavedM ? `${tokensSavedM}M tokens saved` : 'tokens reused'}
                />
                <StatCard label="Quality"  value={quality}           sub="avg score / 100" />
                <StatCard label="Sessions" value={totalSessions}     sub={`${durationHrs} hrs total`} />
                <StatCard label="Input"    value={`${totalInputM}M`} sub="tokens processed" />
              </div>
              {tokensSavedM && (
                <div className="tok-savings-banner">
                  Token cache saved you <strong>{tokensSavedM}M</strong> tokens ({cacheHitPct}% cache hit rate)
                </div>
              )}

              <div className="tok-section-title">RECENT SESSIONS</div>
              <div className="tok-session-list">
                <div className="tok-session-hdr">
                  <span>Date</span><span>Project</span><span>Grade</span><span>Dur</span><span>Saved</span>
                </div>
                {sessions.length === 0 && <div className="tok-empty">No sessions yet.</div>}
                {sessions.map((s, i) => {
                  const saved = (s.input_tokens && s.cache_hit_rate)
                    ? s.input_tokens * s.cache_hit_rate
                    : 0;
                  const savedLabel = saved >= 1e6
                    ? (saved / 1e6).toFixed(1) + 'M'
                    : saved >= 1000
                      ? (saved / 1000).toFixed(0) + 'k'
                      : null;
                  return (
                    <div key={i} className="tok-session-row">
                      <span className="tok-sess-date">{s.date}</span>
                      <span className="tok-sess-proj" title={s.project}>
                        {(s.project || '').replace(/^[A-Za-z]--/, '') || '—'}
                      </span>
                      <span
                        className="tok-sess-grade"
                        style={{ color: GRADE_COLOR[s.quality_grade] || 'var(--text-muted)' }}
                      >
                        {s.quality_grade || '—'}
                      </span>
                      <span className="tok-sess-cost">
                        {s.duration_minutes != null ? `${Number(s.duration_minutes).toFixed(0)}m` : '—'}
                      </span>
                      <span className="tok-sess-saved">
                        {savedLabel || '—'}
                      </span>
                    </div>
                  );
                })}
              </div>
            </>
          ) : (
            <div className="tok-empty tok-empty-main">
              No data yet. Start a session in the Claude CLI tab — stats appear here automatically once your first session completes.
            </div>
          )}

          {/* ── Admin: all users with expandable per-user detail ── */}
          {isAdmin && (
            <>
              <div className="tok-section-title tok-admin-sep">ALL USERS (ADMIN)</div>
              <div className="tok-admin-summary">
                <span>{allUsers.length} users synced</span>
                <span>{adminTotals.sessions} total sessions</span>
                {adminTotals.count > 0 && (
                  <span>
                    {((adminTotals.cacheHit / adminTotals.count) * 100).toFixed(0)}% avg cache
                  </span>
                )}
              </div>

              {allUsers.length === 0 ? (
                <div className="tok-empty">
                  No user data synced yet. Users must open this panel at least once to sync their local stats.
                </div>
              ) : (
                <div className="tok-user-cards">
                  {allUsers.map((u, i) => (
                    <UserCard
                      key={i}
                      u={u}
                      isExpanded={expandedUser === i}
                      onToggle={() => setExpandedUser(expandedUser === i ? null : i)}
                    />
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

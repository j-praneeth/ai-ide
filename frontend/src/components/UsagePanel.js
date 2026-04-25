import React, { useEffect, useState, useCallback } from 'react';
import { API_URL as API } from '../config';
import { authFetch, getAuthUser } from '../lib/auth';
import SkillsModal from './SkillsModal';

const card = {
  background: 'var(--bg-surface)',
  border: '1px solid var(--border)',
  borderRadius: 10,
  padding: 12,
  marginBottom: 10,
};

function fmt(n) {
  try {
    return Number(n || 0).toLocaleString();
  } catch {
    return String(n || 0);
  }
}

export default function UsagePanel() {
  const [me, setMe] = useState(null);
  const [meSessions, setMeSessions] = useState([]);
  const [admin, setAdmin] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showSkills, setShowSkills] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const meRes = await authFetch(`${API}/usage/me/overview?days=30`);
      const meData = await meRes.json().catch(() => ({}));
      setMe(meData);

      const sessRes = await authFetch(`${API}/usage/me/sessions?limit=50`);
      const sessData = await sessRes.json().catch(() => ({}));
      setMeSessions(sessData.sessions || []);

      const user = getAuthUser();
      if (user?.role === 'super_admin') {
        const adminRes = await authFetch(`${API}/usage/admin/overview?days=30`);
        const adminData = await adminRes.json().catch(() => ({}));
        setAdmin(adminData);
      } else {
        setAdmin(null);
      }
    } catch (_) {
      setMe(null);
      setMeSessions([]);
      setAdmin(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  return (
    <div style={{ padding: 12, overflow: 'auto', height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--text-primary)' }}>Token Usage</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            onClick={() => setShowSkills(true)}
            style={{
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border)',
              color: 'var(--text-primary)',
              borderRadius: 8,
              padding: '6px 10px',
              cursor: 'pointer',
              fontSize: 12,
              fontWeight: 700,
            }}
          >
            Skills
          </button>
          <button
            type="button"
            onClick={refresh}
            disabled={loading}
            style={{
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border)',
              color: 'var(--text-primary)',
              borderRadius: 8,
              padding: '6px 10px',
              cursor: loading ? 'not-allowed' : 'pointer',
              fontSize: 12,
              fontWeight: 700,
            }}
          >
            Refresh
          </button>
        </div>
      </div>

      <div style={card}>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>You</div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Total tokens</div>
            <div style={{ fontSize: 16, fontWeight: 900, color: 'var(--text-primary)' }}>{fmt(me?.totals?.total_tokens)}</div>
          </div>
          <div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Estimated saved</div>
            <div style={{ fontSize: 16, fontWeight: 900, color: 'var(--accent)' }}>{fmt(me?.totals?.tokens_saved)}</div>
          </div>
          <div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>LLM calls</div>
            <div style={{ fontSize: 16, fontWeight: 900, color: 'var(--text-primary)' }}>{fmt(me?.totals?.calls)}</div>
          </div>
          <div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Estimated cost</div>
            <div style={{ fontSize: 16, fontWeight: 900, color: 'var(--text-primary)' }}>
              ${Number(me?.totals?.estimated_cost_usd || 0).toFixed(4)}
            </div>
          </div>
        </div>
      </div>

      <div style={card}>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>Your sessions</div>
        {meSessions.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>No sessions recorded yet.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {meSessions.map(s => (
              <div key={s.session_id} style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <div style={{ fontSize: 12, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {s.session_id}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  {fmt(s.total_tokens)} tokens · saved {fmt(s.tokens_saved)} · {fmt(s.calls)} calls
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {admin && !admin.error && (
        <div style={card}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>Admin overview</div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 10 }}>
            <div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Total tokens</div>
              <div style={{ fontSize: 16, fontWeight: 900, color: 'var(--text-primary)' }}>{fmt(admin?.totals?.total_tokens)}</div>
            </div>
            <div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Estimated saved</div>
              <div style={{ fontSize: 16, fontWeight: 900, color: 'var(--accent)' }}>{fmt(admin?.totals?.tokens_saved)}</div>
            </div>
            <div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>LLM calls</div>
              <div style={{ fontSize: 16, fontWeight: 900, color: 'var(--text-primary)' }}>{fmt(admin?.totals?.calls)}</div>
            </div>
            <div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Estimated cost</div>
              <div style={{ fontSize: 16, fontWeight: 900, color: 'var(--text-primary)' }}>
                ${Number(admin?.totals?.estimated_cost_usd || 0).toFixed(4)}
              </div>
            </div>
          </div>

          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>Per user</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {(admin.per_user || []).slice(0, 20).map(u => (
              <div key={u.user_id} style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <div style={{ fontSize: 12, color: 'var(--text-primary)' }}>
                  {u.email ? `${u.email} (${u.role || 'user'})` : u.user_id}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  {fmt(u.total_tokens)} tokens · saved {fmt(u.tokens_saved)} · {fmt(u.calls)} calls
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <SkillsModal open={showSkills} onClose={() => setShowSkills(false)} />
    </div>
  );
}

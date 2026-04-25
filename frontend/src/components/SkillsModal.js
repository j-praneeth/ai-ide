import React, { useEffect, useState } from 'react';
import { API_URL as API } from '../config';
import { authFetch } from '../lib/auth';

export default function SkillsModal({ open, onClose }) {
  const [skills, setSkills] = useState([]);
  const [selected, setSelected] = useState(null);
  const [content, setContent] = useState('');

  useEffect(() => {
    if (!open) return;
    (async () => {
      try {
        const res = await authFetch(`${API}/ai/skills`);
        const data = await res.json().catch(() => ({}));
        setSkills(data.skills || []);
      } catch (_) {
        setSkills([]);
      }
    })();
  }, [open]);

  useEffect(() => {
    if (!open || !selected) return;
    (async () => {
      try {
        const res = await authFetch(`${API}/ai/skills/raw?skill_id=${encodeURIComponent(selected)}`);
        const data = await res.json().catch(() => ({}));
        setContent(data.content || '');
      } catch (_) {
        setContent('');
      }
    })();
  }, [open, selected]);

  if (!open) return null;

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 22000, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 18 }}>
      <div style={{ width: 820, maxWidth: '95vw', height: '70vh', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 12, boxShadow: 'var(--shadow-lg)', overflow: 'hidden', display: 'flex' }}>
        <div style={{ width: 280, borderRight: '1px solid var(--border)', padding: 10, overflow: 'auto' }}>
          <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--text-primary)', marginBottom: 8 }}>Skills</div>
          {(skills || []).map(s => (
            <button
              key={s.id}
              type="button"
              onClick={() => setSelected(s.id)}
              style={{
                width: '100%',
                textAlign: 'left',
                padding: '8px 10px',
                marginBottom: 6,
                borderRadius: 8,
                border: '1px solid var(--border)',
                background: selected === s.id ? 'rgba(245,158,11,0.12)' : 'var(--bg-surface)',
                color: 'var(--text-primary)',
                cursor: 'pointer',
                fontSize: 12,
              }}
              title={s.description || s.id}
            >
              <div style={{ fontWeight: 800 }}>{s.title}</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{s.id}</div>
            </button>
          ))}
        </div>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: 10, borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--text-primary)' }}>
              {selected || 'Select a skill'}
            </div>
            <button type="button" onClick={onClose} style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-primary)', borderRadius: 8, padding: '6px 10px', cursor: 'pointer', fontSize: 12, fontWeight: 700 }}>
              Close
            </button>
          </div>
          <pre style={{ margin: 0, padding: 12, overflow: 'auto', flex: 1, color: 'var(--text-primary)', fontSize: 12, lineHeight: 1.45 }}>
            {content || '—'}
          </pre>
        </div>
      </div>
    </div>
  );
}


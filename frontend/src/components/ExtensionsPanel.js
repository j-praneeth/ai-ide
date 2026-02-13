import React, { useState, useMemo } from 'react';
import { VscExtensions, VscCheck } from 'react-icons/vsc';

const INSTALLED_EXTENSIONS = [
  { id: 'python', name: 'Python Language Support', description: 'Linting, debugging, and IntelliSense for Python.', builtin: false },
  { id: 'js-ts', name: 'JavaScript/TypeScript IntelliSense', description: 'Smart code completion and navigation for JS/TS.', builtin: false },
  { id: 'ai', name: 'AI Code Assistant', description: 'Inline suggestions and chat-powered editing.', builtin: true },
  { id: 'git', name: 'Git Integration', description: 'Source control and diff view in the sidebar.', builtin: true },
  { id: 'markdown', name: 'Markdown Preview', description: 'Live preview and shortcuts for Markdown files.', builtin: false },
  { id: 'formatter', name: 'Code Formatter', description: 'Format on save and manual format for multiple languages.', builtin: false },
];

export default function ExtensionsPanel() {
  const [search, setSearch] = useState('');
  const [enabled, setEnabled] = useState(() => {
    const o = {};
    INSTALLED_EXTENSIONS.forEach(ext => { o[ext.id] = true; });
    return o;
  });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return INSTALLED_EXTENSIONS;
    return INSTALLED_EXTENSIONS.filter(
      ext =>
        ext.name.toLowerCase().includes(q) ||
        ext.description.toLowerCase().includes(q)
    );
  }, [search]);

  const toggle = (id) => {
    setEnabled(prev => ({ ...prev, [id]: !prev[id] }));
  };

  return (
    <div className="file-explorer">
      <div className="sidebar-header">
        <span className="sidebar-title">EXTENSIONS</span>
      </div>
      <div className="search-inputs" style={{ padding: '0 12px 10px' }}>
        <div className="search-input-wrapper">
          <input
            className="search-input"
            placeholder="Search extensions"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
      </div>
      <div className="file-tree" style={{ paddingTop: 0 }}>
        <div style={{ padding: '4px 8px', fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          Installed
        </div>
        {filtered.length === 0 ? (
          <div className="search-message">No extensions match your search.</div>
        ) : (
          filtered.map(ext => (
            <div
              key={ext.id}
              className="tree-item"
              style={{ flexDirection: 'column', alignItems: 'stretch', gap: 4, padding: '10px 12px' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ color: 'var(--text-muted)' }}>
                  <VscExtensions size={18} />
                </span>
                <span className="tree-label" style={{ flex: 1, fontWeight: 500 }}>
                  {ext.name}
                  {ext.builtin && (
                    <span style={{ marginLeft: 6, fontSize: 'var(--font-size-xs)', color: 'var(--text-ghost)' }}>
                      (built-in)
                    </span>
                  )}
                </span>
                <button
                  className="icon-btn"
                  title={enabled[ext.id] ? 'Disable' : 'Enable'}
                  onClick={() => toggle(ext.id)}
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: 'var(--radius-md)',
                    background: enabled[ext.id] ? 'var(--accent-bg)' : 'var(--bg-surface)',
                    color: enabled[ext.id] ? 'var(--accent)' : 'var(--text-muted)',
                  }}
                >
                  {enabled[ext.id] ? <VscCheck size={18} /> : <span style={{ width: 18, height: 18, borderRadius: 4, border: '2px solid currentColor' }} />}
                </button>
              </div>
              <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)', paddingLeft: 26, lineHeight: 1.4 }}>
                {ext.description}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

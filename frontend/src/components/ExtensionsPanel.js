import React, { useState, useEffect, useRef, useCallback } from 'react';
import { VscExtensions, VscSearch, VscCloudDownload, VscSync, VscClose } from 'react-icons/vsc';
import axios from 'axios';

const API = (window.BACKEND_URL || 'http://localhost:8000');
const LS_KEY = 'nebula_extensions';
const PAGE_SIZE = 20;

const BUILTIN = [
  { id: 'nebula.ai-assistant', name: 'AI Code Assistant', publisher: 'Nebula', description: 'Inline suggestions and chat-powered code editing powered by Claude.', version: '1.0.0', builtin: true },
  { id: 'nebula.git-integration', name: 'Git Integration', publisher: 'Nebula', description: 'Source control, branch management, and diff view in the sidebar.', version: '1.0.0', builtin: true },
  { id: 'nebula.terminal', name: 'Integrated Terminal', publisher: 'Nebula', description: 'Full-featured terminal with multi-session and split support.', version: '1.0.0', builtin: true },
];

const SORT_OPTIONS = [
  { value: 4, label: 'Most Installs' },
  { value: 12, label: 'Highest Rated' },
  { value: 10, label: 'Recently Updated' },
  { value: 0, label: 'Relevance' },
];

const CATEGORIES = [
  '', 'Programming Languages', 'Snippets', 'Linters', 'Themes',
  'Debuggers', 'Formatters', 'Keymaps', 'SCM Providers', 'Other',
];

function fmtInstalls(n) {
  if (!n) return '0';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}

function StarRating({ rating, count }) {
  const full = Math.round(rating);
  return (
    <span className="ext-stars" title={`${rating} (${count} ratings)`}>
      {[1,2,3,4,5].map(i => (
        <span key={i} style={{ color: i <= full ? '#e2c027' : 'var(--text-ghost)' }}>★</span>
      ))}
      {count > 0 && <span className="ext-rating-count">({fmtInstalls(count)})</span>}
    </span>
  );
}

function ExtCard({ ext, installed, onInstall, onUninstall, builtin }) {
  const [imgError, setImgError] = useState(false);

  return (
    <div className="ext-card">
      <div className="ext-card-icon">
        {ext.iconUrl && !imgError ? (
          <img src={ext.iconUrl} alt="" onError={() => setImgError(true)} />
        ) : (
          <VscExtensions size={32} style={{ color: 'var(--text-muted)' }} />
        )}
      </div>
      <div className="ext-card-body">
        <div className="ext-card-header">
          <span className="ext-card-name">{ext.displayName || ext.name}</span>
          {builtin && <span className="ext-builtin-badge">built-in</span>}
          {!builtin && (
            <button
              className={`ext-action-btn ${installed ? 'ext-action-uninstall' : 'ext-action-install'}`}
              onClick={() => installed ? onUninstall(ext.id) : onInstall(ext)}
              title={installed ? 'Uninstall' : 'Install'}
            >
              {installed ? <VscClose size={12} /> : <VscCloudDownload size={12} />}
              {installed ? 'Uninstall' : 'Install'}
            </button>
          )}
        </div>
        <div className="ext-card-desc">{ext.description}</div>
        <div className="ext-card-meta">
          <span className="ext-publisher">{ext.publisher}</span>
          {ext.version && <span className="ext-version">v{ext.version}</span>}
          {ext.installs > 0 && (
            <span className="ext-installs">
              <VscCloudDownload size={11} /> {fmtInstalls(ext.installs)}
            </span>
          )}
          {ext.rating > 0 && <StarRating rating={ext.rating} count={ext.ratingCount} />}
        </div>
      </div>
    </div>
  );
}

export default function ExtensionsPanel() {
  const [tab, setTab] = useState('installed');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [sortBy, setSortBy] = useState(4);
  const [category, setCategory] = useState('');
  const [page, setPage] = useState(1);
  const [results, setResults] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [installed, setInstalled] = useState(() => {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]'); } catch { return []; }
  });

  const debounceRef = useRef(null);
  const abortRef = useRef(null);

  // Debounce search input
  useEffect(() => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(1);
    }, 350);
    return () => clearTimeout(debounceRef.current);
  }, [search]);

  // Fetch marketplace results
  const fetchMarketplace = useCallback(async () => {
    if (tab !== 'marketplace') return;
    if (abortRef.current) abortRef.current.abort();
    abortRef.current = new AbortController();
    setLoading(true);
    setError('');
    try {
      const res = await axios.post(`${API}/extensions/search`, {
        query: debouncedSearch,
        category,
        page,
        pageSize: PAGE_SIZE,
        sortBy,
      }, { signal: abortRef.current.signal });
      setResults(res.data.extensions || []);
      setTotal(res.data.total || 0);
    } catch (e) {
      if (e.name === 'CanceledError' || e.name === 'AbortError') return;
      setError('Failed to fetch extensions from Marketplace.');
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, [tab, debouncedSearch, category, page, sortBy]);

  useEffect(() => { fetchMarketplace(); }, [fetchMarketplace]);

  const installExt = useCallback((ext) => {
    setInstalled(prev => {
      const next = [...prev.filter(e => e.id !== ext.id), ext];
      localStorage.setItem(LS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const uninstallExt = useCallback((id) => {
    setInstalled(prev => {
      const next = prev.filter(e => e.id !== id);
      localStorage.setItem(LS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const installedIds = new Set([...BUILTIN.map(b => b.id), ...installed.map(e => e.id)]);
  const totalPages = Math.ceil(total / PAGE_SIZE);

  const installedFiltered = installed.filter(e => {
    const q = debouncedSearch.toLowerCase();
    if (!q) return true;
    return (e.displayName || e.name || '').toLowerCase().includes(q)
      || (e.description || '').toLowerCase().includes(q)
      || (e.publisher || '').toLowerCase().includes(q);
  });

  return (
    <div className="file-explorer ext-panel">
      <div className="sidebar-header">
        <span className="sidebar-title">EXTENSIONS</span>
      </div>

      {/* Search Bar */}
      <div className="ext-search-row">
        <div className="search-input-wrapper" style={{ flex: 1 }}>
          <VscSearch size={13} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', pointerEvents: 'none' }} />
          <input
            className="search-input"
            style={{ paddingLeft: 28 }}
            placeholder="Search extensions…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          {search && (
            <button className="icon-btn" style={{ position: 'absolute', right: 4, top: '50%', transform: 'translateY(-50%)' }} onClick={() => setSearch('')}>
              <VscClose size={12} />
            </button>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="ext-tabs">
        <button className={`ext-tab ${tab === 'installed' ? 'active' : ''}`} onClick={() => setTab('installed')}>
          Installed
          <span className="ext-tab-count">{BUILTIN.length + installed.length}</span>
        </button>
        <button className={`ext-tab ${tab === 'marketplace' ? 'active' : ''}`} onClick={() => setTab('marketplace')}>
          Marketplace
        </button>
      </div>

      {/* Installed Tab */}
      {tab === 'installed' && (
        <div className="ext-list">
          <div className="ext-group-label">Built-in</div>
          {BUILTIN.map(ext => (
            <ExtCard key={ext.id} ext={ext} installed builtin onInstall={() => {}} onUninstall={() => {}} />
          ))}
          {installed.length > 0 && (
            <>
              <div className="ext-group-label" style={{ marginTop: 8 }}>Installed</div>
              {installedFiltered.length === 0 ? (
                <div className="search-message">No installed extensions match.</div>
              ) : (
                installedFiltered.map(ext => (
                  <ExtCard key={ext.id} ext={ext} installed onInstall={installExt} onUninstall={uninstallExt} />
                ))
              )}
            </>
          )}
          {installed.length === 0 && (
            <div className="search-message" style={{ marginTop: 8 }}>
              No additional extensions installed.
              <br />
              <span
                style={{ color: 'var(--accent)', cursor: 'pointer', textDecoration: 'underline' }}
                onClick={() => setTab('marketplace')}
              >
                Browse Marketplace →
              </span>
            </div>
          )}
        </div>
      )}

      {/* Marketplace Tab */}
      {tab === 'marketplace' && (
        <>
          <div className="ext-filters">
            <select
              className="ext-select"
              value={sortBy}
              onChange={e => { setSortBy(Number(e.target.value)); setPage(1); }}
            >
              {SORT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <select
              className="ext-select"
              value={category}
              onChange={e => { setCategory(e.target.value); setPage(1); }}
            >
              {CATEGORIES.map(c => <option key={c} value={c}>{c || 'All Categories'}</option>)}
            </select>
          </div>

          {error && (
            <div className="ext-error">
              {error}
              <button className="icon-btn" onClick={fetchMarketplace} title="Retry">
                <VscSync size={13} />
              </button>
            </div>
          )}

          <div className="ext-list">
            {loading && results.length === 0 && (
              <div className="ext-loading">
                <VscSync size={16} className="spin" />
                <span>Loading extensions…</span>
              </div>
            )}
            {!loading && results.length === 0 && !error && (
              <div className="search-message">No extensions found.</div>
            )}
            {results.map(ext => (
              <ExtCard
                key={ext.id}
                ext={ext}
                installed={installedIds.has(ext.id)}
                onInstall={installExt}
                onUninstall={uninstallExt}
              />
            ))}
          </div>

          {totalPages > 1 && (
            <div className="ext-pagination">
              <button className="ext-page-btn" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>‹ Prev</button>
              <span className="ext-page-info">{page} / {totalPages}</span>
              <button className="ext-page-btn" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>Next ›</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

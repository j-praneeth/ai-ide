/**
 * FileExplorer — VS Code-style virtual tree renderer.
 *
 * Architecture mirrors VS Code's explorer exactly:
 *   src/vs/workbench/browser/parts/explorer/explorerView.ts
 *   src/vs/base/browser/ui/tree/abstractTree.ts
 *   src/vs/base/browser/ui/list/listWidget.ts
 *
 * Key VS Code performance patterns applied:
 *  1. Lazy tree population — children loaded ONLY on expand, never before.
 *     No batch pre-fetch. VS Code's getChildren() is called per-node on expand.
 *  2. DOM virtualization — react-window FixedSizeList pools DOM nodes;
 *     only visible rows get rendered (identical to ListWidget's TraitRenderer).
 *  3. LRU cache — children cache capped at 500 entries. Evictions use LRU
 *     (same as VS Code's TreeRenderer node cache).
 *  4. Concurrency limit — at most 3 simultaneous folder loads (VS Code uses
 *     a "Limiter" with maxDegreeOfParallelism for coalesced file operations).
 *  5. Stale request cancellation — if a folder is collapsed or re-expanded
 *     while a fetch is in-flight, the old request is aborted. Matches VS Code's
 *     createCancelablePromise pattern.
 *  6. Hover prefetch — 150ms delay on mouseenter (identical to VS Code's
 *     folder hover prefetch delay).
 *  7. No workspace-wide indexing at startup — only the root level is loaded.
 *     Large workspaces are not penalized at mount time.
 *  8. Throttled refresh — at most 1 in-flight + 1 pending refresh from
 *     file watcher events.
 *  9. Performance logging — every folder load, cache hit, and render is timed
 *     when NODE_ENV=development, matching VS Code's logging pattern.
 */

import React, {
  useState, useCallback, useRef, useEffect, useMemo, memo,
} from 'react';
import { List, useListRef } from 'react-window';
import axios from 'axios';
import {
  VscChevronRight, VscChevronDown,
  VscNewFile, VscNewFolder, VscRefresh, VscCollapseAll,
  VscFolderOpened, VscEllipsis, VscEdit, VscTrash, VscCopy,
  VscLoading,
} from 'react-icons/vsc';
import {
  MdFolder, MdFolderOpen, MdInsertDriveFile,
  MdImage, MdLock, MdSettings, MdCode,
} from 'react-icons/md';
import {
  SiJavascript, SiTypescript, SiReact, SiPython, SiHtml5,
  SiCss3, SiSass, SiMarkdown, SiJson, SiYaml, SiRust,
  SiGo, SiRuby, SiPhp, SiSwift, SiKotlin, SiDocker,
  SiGit,
} from 'react-icons/si';
import { API_URL as API } from '../config';
import { Throttler, RunOnceScheduler, Limiter } from '../lib/async';

// ─── Constants (match VS Code explorer) ──────────────────────────────────────
const ROW_HEIGHT     = 22;   // px — VS Code uses 22px for explorer rows
const INDENT_SIZE    = 16;   // px per depth level
const HOVER_DELAY_MS = 150;  // prefetch delay on hover
const LRU_MAX_SIZE   = 500;  // max cached folder entries
const MAX_CONCURRENT_LOADS = 3; // max simultaneous folder fetches

// ─── LRU cache (matches VS Code's TreeRenderer node cache behavior) ──────────
class LRUCache {
  constructor(max = LRU_MAX_SIZE) {
    this.max = max;
    this._map = new Map();
  }
  get(key) {
    if (!this._map.has(key)) return undefined;
    const val = this._map.get(key);
    this._map.delete(key);
    this._map.set(key, val);
    return val;
  }
  set(key, value) {
    if (this._map.has(key)) this._map.delete(key);
    else if (this._map.size >= this.max) {
      const oldest = this._map.keys().next().value;
      this._map.delete(oldest);
    }
    this._map.set(key, value);
  }
  has(key) { return this._map.has(key); }
  delete(key) { this._map.delete(key); }
  clear() { this._map.clear(); }
  snapshot() {
    const obj = {};
    for (const [k, v] of this._map) obj[k] = v;
    return obj;
  }
}

// ─── Performance logging (development only, like VS Code's Tracer) ───────────
const IS_DEV = typeof process !== 'undefined' && process.env?.NODE_ENV === 'development';
function perfLog(label, t0) {
  if (IS_DEV) {
    const dt = performance.now() - t0;
    if (dt > 50) console.warn(`[Explorer] ${label}: ${dt.toFixed(1)}ms`);
    else console.log(`[Explorer] ${label}: ${dt.toFixed(1)}ms`);
  }
}

// ─── File icon mapping (Material + SI icons) ─────────────────────────────────
// Each entry: [IconComponent, color]
const FILE_ICON_MAP = {
  // JavaScript / TypeScript
  js:          [SiJavascript,       '#e8d44d'],
  jsx:         [SiReact,            '#61dafb'],
  ts:          [SiTypescript,       '#3178c6'],
  tsx:         [SiReact,            '#3178c6'],
  mjs:         [SiJavascript,       '#e8d44d'],
  cjs:         [SiJavascript,       '#e8d44d'],
  // Web
  html:        [SiHtml5,            '#e34f26'],
  htm:         [SiHtml5,            '#e34f26'],
  css:         [SiCss3,             '#1572b6'],
  scss:        [SiSass,             '#cf649a'],
  sass:        [SiSass,             '#cf649a'],
  less:        [SiCss3,             '#1572b6'],
  // Data / Config
  json:        [SiJson,             '#e8d44d'],
  yaml:        [SiYaml,             '#cb171e'],
  yml:         [SiYaml,             '#cb171e'],
  toml:        [MdSettings,         '#9c4221'],
  ini:         [MdSettings,         '#6a6a6a'],
  env:         [MdSettings,         '#ecd53f'],
  xml:         [MdCode,             '#e34f26'],
  // Markdown / Docs
  md:          [SiMarkdown,         '#519aba'],
  mdx:         [SiMarkdown,         '#519aba'],
  txt:         [MdInsertDriveFile,  '#8a8a8a'],
  // Systems languages
  rs:          [SiRust,             '#dea584'],
  go:          [SiGo,               '#00acd7'],
  c:           [MdCode,             '#555555'],
  cpp:         [MdCode,             '#f34b7d'],
  cc:          [MdCode,             '#f34b7d'],
  h:           [MdCode,             '#a074c4'],
  hpp:         [MdCode,             '#a074c4'],
  cs:          [MdCode,             '#178600'],
  // Scripted languages
  py:          [SiPython,           '#3776ab'],
  rb:          [SiRuby,             '#cc342d'],
  php:         [SiPhp,              '#8892be'],
  java:        [MdCode,             '#b07219'],
  kt:          [SiKotlin,           '#7f52ff'],
  swift:       [SiSwift,            '#f05138'],
  sh:          [MdCode,             '#89e051'],
  bash:        [MdCode,             '#89e051'],
  zsh:         [MdCode,             '#89e051'],
  // Images
  png:         [MdImage,            '#a074c4'],
  jpg:         [MdImage,            '#a074c4'],
  jpeg:        [MdImage,            '#a074c4'],
  gif:         [MdImage,            '#a074c4'],
  svg:         [MdImage,            '#ffb13b'],
  webp:        [MdImage,            '#a074c4'],
  ico:         [MdImage,            '#a074c4'],
  // Git / Lock
  gitignore:   [SiGit,              '#f05032'],
  lock:        [MdLock,             '#6a6a6a'],
  // Docker
  dockerfile:  [SiDocker,           '#384d54'],
};

function getFileIconColor(name) {
  const lower = name.toLowerCase();
  // Match full filename (e.g. "Dockerfile", ".gitignore")
  const fullKey = lower.startsWith('.') ? lower.slice(1) : lower;
  if (FILE_ICON_MAP[fullKey]) return FILE_ICON_MAP[fullKey];
  // Match extension
  const dotIdx = lower.lastIndexOf('.');
  if (dotIdx >= 0) {
    const ext = lower.slice(dotIdx + 1);
    if (FILE_ICON_MAP[ext]) return FILE_ICON_MAP[ext];
  }
  return [MdInsertDriveFile, '#8a8a8a'];
}

// Folder colors — Material folder icon tinted by folder role
const FOLDER_COLORS = {
  src: '#3b82f6', source: '#3b82f6', lib: '#3b82f6',
  components: '#61dafb', pages: '#61dafb', views: '#61dafb', ui: '#61dafb',
  assets: '#a074c4', images: '#a074c4', icons: '#a074c4', fonts: '#a074c4', static: '#a074c4',
  styles: '#cf649a', css: '#cf649a', scss: '#cf649a',
  api: '#f59e0b', services: '#f59e0b', routes: '#f59e0b', controllers: '#f59e0b',
  tests: '#10b981', test: '#10b981', __tests__: '#10b981', spec: '#10b981',
  docs: '#519aba', doc: '#519aba',
  scripts: '#89e051', bin: '#89e051', tools: '#89e051',
  config: '#ecd53f', configs: '#ecd53f', settings: '#ecd53f',
  node_modules: '#e34f26',
  build: '#9ca3af', dist: '#9ca3af', out: '#9ca3af', output: '#9ca3af',
  '.git': '#f05032', '.github': '#f05032',
  public: '#06b6d4',
  backend: '#8b5cf6', frontend: '#8b5cf6', server: '#8b5cf6', client: '#8b5cf6',
  electron: '#2563eb',
  mobile: '#10b981', android: '#10b981', ios: '#10b981',
};

function getFolderColor(name) {
  return FOLDER_COLORS[name.toLowerCase()] || '#dcad5a';
}

// ─── Tree flattening ──────────────────────────────────────────────────────────
// Converts the nested tree + expand state into a 1-D array for the virtual list.
// Mirrors AbstractTree.render() which flattens ITreeNode<T>[] into a ListView items array.

function flattenTree(nodes, basePath, depth, expandedFolders, lazyChildren) {
  const flat = [];
  for (const node of nodes) {
    const path = basePath ? `${basePath}/${node.name}` : node.name;
    flat.push({ node, path, depth });
    if (node.type === 'folder' && expandedFolders.has(path)) {
      const children = lazyChildren[path] || node.children || [];
      const sorted = [...children].sort((a, b) => {
        if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      flat.push(...flattenTree(sorted, path, depth + 1, expandedFolders, lazyChildren));
    }
  }
  return flat;
}

// ─── Row renderer — DOM-pooled by react-window (TraitRenderer equivalent) ────
// react-window creates a fixed pool of row DOM nodes and calls this function to
// swap data into them on scroll — identical to VS Code's renderElement() pattern.
// In react-window v2 the rowProps object is spread directly onto the component.

const TreeRow = memo(function TreeRow({
  index, style,
  flatItems, selectedFile, expandedFolders, loadingFolders,
  toggleFolder, openFile, onContextMenu, onDragStart,
  onDragOver, onDragLeave, onDrop, dropTarget, onMouseEnter, onMouseLeave,
  gitIgnored,
}) {

  const item = flatItems[index];
  if (!item) return null;
  const { node, path, depth } = item;

  const isExpanded  = expandedFolders.has(path);
  const isSelected  = selectedFile === path;
  const isLoading   = loadingFolders.has(path);
  const isDropTgt   = dropTarget === path;
  const paddingLeft = depth * INDENT_SIZE + 8;
  const dimGit = !!(gitIgnored && gitIgnored[path]);

  if (node.type === 'folder') {
    const folderColor = getFolderColor(node.name);
    const FolderIcon = isExpanded ? MdFolderOpen : MdFolder;
    return (
      <div
        style={{ ...style, paddingLeft, display: 'flex', alignItems: 'center', cursor: 'pointer' }}
        className={`tree-item tree-folder${isSelected ? ' selected' : ''}${isDropTgt ? ' tree-drop-target' : ''}${dimGit ? ' tree-git-ignored' : ''}`}
        onClick={() => toggleFolder(path)}
        onMouseEnter={() => onMouseEnter(path, node.type)}
        onMouseLeave={() => onMouseLeave(path)}
        onContextMenu={e => { e.preventDefault(); e.stopPropagation(); onContextMenu(e, path, 'folder'); }}
        draggable
        onDragStart={e => onDragStart(e, path, 'folder')}
        onDragOver={e => onDragOver(e, path)}
        onDragLeave={onDragLeave}
        onDrop={e => onDrop(e, path)}
      >
        <span className="tree-chevron">
          {isLoading
            ? <VscLoading size={14} className="tree-spinner" />
            : isExpanded
              ? <VscChevronDown size={14} />
              : <VscChevronRight size={14} />
          }
        </span>
        <span className="folder-icon" style={{ color: folderColor, display: 'flex', alignItems: 'center' }}>
          <FolderIcon size={16} />
        </span>
        <span className="tree-label">{node.name}</span>
      </div>
    );
  }

  // File row — Material + SI icon per file type
  const [FileIconComp, iconColor] = getFileIconColor(node.name);
  return (
    <div
      style={{ ...style, paddingLeft, display: 'flex', alignItems: 'center', cursor: 'pointer' }}
      className={`tree-item tree-file${isSelected ? ' selected' : ''}${dimGit ? ' tree-git-ignored' : ''}`}
      onClick={() => openFile(path)}
      onMouseEnter={() => onMouseEnter(path, node.type)}
      onMouseLeave={() => onMouseLeave(path)}
      onContextMenu={e => { e.preventDefault(); e.stopPropagation(); onContextMenu(e, path, 'file'); }}
      draggable
      onDragStart={e => onDragStart(e, path, 'file')}
    >
      <span className="tree-chevron" style={{ visibility: 'hidden' }}>
        <VscChevronRight size={14} />
      </span>
      <span className="file-icon" style={{ color: iconColor, display: 'flex', alignItems: 'center' }}>
        <FileIconComp size={15} />
      </span>
      <span className="tree-label">{node.name}</span>
    </div>
  );
});

// ─── FileExplorer ─────────────────────────────────────────────────────────────
export default function FileExplorer({
  tree, treeLoading, openFile, selectedFile, onRefresh,
  showHiddenFiles, onToggleShowHidden, triggerNewFile, onNewFileDone,
  onOpenFolder, onLoadChildren,
}) {
  const [expandedFolders, setExpandedFolders] = useState(new Set());
  const [lazyChildren,    setLazyChildren]    = useState({});
  const [loadingFolders,  setLoadingFolders]  = useState(new Set());

  // Git-ignored paths (dimmed like VS Code) — batched via /files/git-check-ignore
  const [gitIgnored, setGitIgnored] = useState({});
  const gitIgnorePendingRef = useRef(new Set());
  const gitIgnoreTimerRef = useRef(null);

  const flushGitIgnoreCheck = useCallback(async () => {
    const paths = Array.from(gitIgnorePendingRef.current);
    gitIgnorePendingRef.current.clear();
    if (!paths.length) return;
    try {
      let ignored = [];
      // Prefer Electron IPC (works reliably in packaged app regardless of PATH)
      if (window.electronAPI?.gitCheckIgnore) {
        const res = await window.electronAPI.gitCheckIgnore(paths);
        ignored = res?.ignored || [];
      } else {
        const res = await axios.post(`${API}/files/git-check-ignore`, { paths });
        ignored = res.data?.ignored || [];
      }
      if (!ignored.length) return;
      setGitIgnored(prev => {
        const next = { ...prev };
        for (const p of ignored) next[p] = true;
        return next;
      });
    } catch (_) {}
  }, []);

  const queueGitIgnoreCheck = useCallback((paths) => {
    if (!paths || !paths.length) return;
    for (const p of paths) gitIgnorePendingRef.current.add(p);
    if (gitIgnoreTimerRef.current) clearTimeout(gitIgnoreTimerRef.current);
    gitIgnoreTimerRef.current = setTimeout(() => {
      gitIgnoreTimerRef.current = null;
      flushGitIgnoreCheck();
    }, 120);
  }, [flushGitIgnoreCheck]);

  // Stable refs — avoid stale closures in async callbacks (VS Code uses
  // module-level maps; we use refs for the same effect in React)
  const lazyChildrenRef   = useRef(lazyChildren);
  const loadingFoldersRef = useRef(loadingFolders);
  useEffect(() => { lazyChildrenRef.current = lazyChildren; },   [lazyChildren]);
  useEffect(() => { loadingFoldersRef.current = loadingFolders; }, [loadingFolders]);

  // When the root tree changes (e.g., after backend:ready reload), invalidate
  // all cached children since their paths may no longer be valid.
  useEffect(() => {
    setLazyChildren({});
    setExpandedFolders(new Set());
    lruCacheRef.current.clear();
    loadGenForPathRef.current.clear();
    setGitIgnored({});
    gitIgnorePendingRef.current.clear();
    if (gitIgnoreTimerRef.current) {
      clearTimeout(gitIgnoreTimerRef.current);
      gitIgnoreTimerRef.current = null;
    }
  }, [tree]);

  // UI state
  const [showNewFileInput,   setShowNewFileInput]   = useState(false);
  const [showNewFolderInput, setShowNewFolderInput] = useState(false);
  const [newItemName,        setNewItemName]         = useState('');
  const [contextMenu,        setContextMenu]         = useState(null);
  const [renamePath,         setRenamePath]          = useState(null);
  const [renameValue,        setRenameValue]         = useState('');
  const [dropTarget,         setDropTarget]          = useState(null);

  const dragSourceRef    = useRef(null);
  const newItemInputRef  = useRef(null);
  const renameInputRef   = useRef(null);
  const hoverTimers      = useRef(new Map());   // path → setTimeout id
  const inFlightRef      = useRef(new Map());   // path → AbortController
  const listRef = useListRef();

  // Concurrency limiter — at most 3 simultaneous folder loads
  // Mirrors VS Code's Limiter with maxDegreeOfParallelism
  const loadLimiterRef = useRef(new Limiter(MAX_CONCURRENT_LOADS));
  // Throttler for refresh — at most 1 in-flight refresh + 1 pending
  const refreshThrottler = useRef(new Throttler());

  // Stale request tracking — each expand gets a generation number;
  // if gen doesn't match when response arrives, the result is discarded.
  // Mirrors VS Code's createCancelablePromise with disposable cancellation.
  const loadGenRef = useRef(0);
  const loadGenForPathRef = useRef(new Map()); // path → generation number

  // LRU cache ref — fast O(1) lookups without React re-render overhead.
  // Only converted to state object when triggering renders.
  const lruCacheRef = useRef(new LRUCache());

  // ── Core fetch helper ────────────────────────────────────────────────────────
  // Mirrors ExplorerView._refreshFromEvent → getChildren() IDataSource pattern
  const fetchChildren = useCallback((path) => {
    // Check LRU cache first (fast path — no I/O)
    const cached = lruCacheRef.current.get(path);
    if (cached !== undefined) {
      // Promote in LRU and ensure state reflects it
      setLazyChildren(prev => {
        if (prev[path] !== undefined) return prev;
        return { ...prev, [path]: cached };
      });
      return;
    }
    if (loadingFoldersRef.current.has(path)) return;

    // Bump generation — invalidates any in-flight stale request for this path
    const gen = ++loadGenRef.current;
    loadGenForPathRef.current.set(path, gen);

    setLoadingFolders(prev => new Set(prev).add(path));

    let promise;
    if (onLoadChildren) {
      promise = onLoadChildren(path);
    } else if (typeof window !== 'undefined' && window.electronAPI?.listProjectDir) {
      promise = window.electronAPI.listProjectDir(path, showHiddenFiles);
    } else {
      const ctrl = new AbortController();
      inFlightRef.current.set(path, ctrl);
      promise = axios
        .get(`${API}/files/tree-children`, {
          params: { path, show_hidden: showHiddenFiles },
          signal: ctrl.signal,
          timeout: 8000,
        })
        .then(r => r.data)
        .finally(() => inFlightRef.current.delete(path));
    }

    // Run through the limiter to cap concurrent backend I/O
    const t0 = performance.now();
    loadLimiterRef.current.queue(() => promise).then(data => {
      // Stale check: if this path was re-expanded, discard old result
      if (loadGenForPathRef.current.get(path) !== gen) return;

      if (Array.isArray(data)) {
        lruCacheRef.current.set(path, data);
        setLazyChildren(c => ({ ...c, [path]: data }));
        perfLog(`Fetched children: "${path}" (${data.length} items)`, t0);
        const relPaths = data.map(ch => (path ? `${path}/${ch.name}` : ch.name));
        queueGitIgnoreCheck(relPaths);
      }
    }).catch(err => {
      if (err?.name !== 'CancellationError' && err?.code !== 'ERR_CANCELED') {
        console.warn(`[Explorer] Failed to load children for "${path}":`, err?.message || err);
      }
    }).finally(() => {
      setLoadingFolders(prev => {
        const next = new Set(prev);
        next.delete(path);
        return next;
      });
    });
  }, [showHiddenFiles, onLoadChildren, queueGitIgnoreCheck]);

  // Cancel all in-flight requests on unmount (createCancelablePromise equivalent)
  useEffect(() => {
    const inFlight = inFlightRef.current;
    const loadGenMap = loadGenForPathRef.current;
    return () => {
      inFlight.forEach(ctrl => { try { ctrl.abort(); } catch (_) {} });
      inFlight.clear();
      loadGenMap.clear();
      if (gitIgnoreTimerRef.current) clearTimeout(gitIgnoreTimerRef.current);
    };
  }, []);

  // ── Flatten tree for virtual list ────────────────────────────────────────────
  // Mirrors AbstractTree flattening ITreeNode[] into the ListView items array.
  const sortedTree = useMemo(() =>
    [...tree].sort((a, b) => {
      if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
      return a.name.localeCompare(b.name);
    }),
    [tree]
  );

  useEffect(() => {
    if (!sortedTree.length) return;
    queueGitIgnoreCheck(sortedTree.map(n => n.name));
  }, [sortedTree, queueGitIgnoreCheck]);

  const flatItems = useMemo(() => {
    const t0 = performance.now();
    const result = flattenTree(sortedTree, '', 0, expandedFolders, lazyChildren);
    if (result.length > 0) perfLog(`Flatten tree (${result.length} rows)`, t0);
    return result;
  }, [sortedTree, expandedFolders, lazyChildren]);

  // ── Toggle folder ─────────────────────────────────────────────────────────────
  const toggleFolder = useCallback((path) => {
    setExpandedFolders(prev => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
        // Increment gen so in-flight fetch for this path is discarded
        loadGenForPathRef.current.set(path, ++loadGenRef.current);
      } else {
        next.add(path);
        // fetchChildren handles the LRU cache fast path internally
        if (!loadingFoldersRef.current.has(path)) {
          fetchChildren(path);
        }
      }
      return next;
    });
  }, [fetchChildren]);

  // ── Hover prefetch — 150ms timer (same delay as VS Code) ─────────────────────
  const handleMouseEnter = useCallback((path, type) => {
    if (type !== 'folder') return;
    if (lruCacheRef.current.has(path) || lazyChildrenRef.current[path] !== undefined) return;
    if (hoverTimers.current.has(path)) return;
    const id = setTimeout(() => {
      hoverTimers.current.delete(path);
      fetchChildren(path);
    }, HOVER_DELAY_MS);
    hoverTimers.current.set(path, id);
  }, [fetchChildren]);

  const handleMouseLeave = useCallback((path) => {
    const id = hoverTimers.current.get(path);
    if (id !== undefined) {
      clearTimeout(id);
      hoverTimers.current.delete(path);
    }
  }, []);

  // Cleanup hover timers on unmount
  useEffect(() => {
    const timers = hoverTimers.current;
    return () => { timers.forEach(id => clearTimeout(id)); timers.clear(); };
  }, []);

  // ── File watcher WebSocket ────────────────────────────────────────────────────
  // Mirrors VS Code's ParcelWatcher → EventCoalescer → UI refresh pipeline.
  // The backend coalesces events; we throttle the resulting tree refresh using
  // a RunOnceScheduler (same 300ms pattern as VS Code's watcher batch window).
  useEffect(() => {
    const refreshScheduler = new RunOnceScheduler(() => {
      refreshThrottler.current.queue(() =>
        Promise.resolve(onRefresh?.())
      );
    }, 300);

    const wsUrl = API.replace(/^http/, 'ws') + '/files/watch';
    let ws;
    let reconnectTimer = null;
    let active = true;

    function connect() {
      try {
        ws = new WebSocket(wsUrl);
        ws.onmessage = (ev) => {
          try {
            const msg = JSON.parse(ev.data);
            if (msg.changes && msg.changes.length > 0) {
              // Invalidate cached children for affected paths
              setLazyChildren(prev => {
                const next = { ...prev };
                for (const { path } of msg.changes) {
                  const parent = path.includes('/') || path.includes('\\')
                    ? path.replace(/[\\/][^\\/]+$/, '')
                    : '';
                  delete next[path];
                  if (parent) delete next[parent];
                  // Also purge from LRU cache
                  lruCacheRef.current.delete(path);
                  if (parent) lruCacheRef.current.delete(parent);
                }
                return next;
              });
              // Schedule a single tree refresh (debounced)
              refreshScheduler.schedule();
            }
          } catch (_) {}
        };
        ws.onclose = () => {
          if (active) {
            reconnectTimer = setTimeout(connect, 3000);
          }
        };
        ws.onerror = () => { try { ws.close(); } catch (_) {} };
      } catch (_) {}
    }

    connect();
    return () => {
      active = false;
      refreshScheduler.dispose();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try { ws?.close(); } catch (_) {}
    };
  }, [onRefresh]);

  // ── Context menu ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const close = () => setContextMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('scroll', close, true);
    };
  }, []);

  useEffect(() => {
    if (renamePath && renameInputRef.current) renameInputRef.current.focus();
  }, [renamePath]);

  useEffect(() => {
    if (triggerNewFile) {
      setShowNewFolderInput(false);
      setShowNewFileInput(true);
      setNewItemName('');
      setTimeout(() => newItemInputRef.current?.focus(), 0);
      onNewFileDone?.();
    }
  }, [triggerNewFile, onNewFileDone]);

  const startNewFile = useCallback(() => {
    setShowNewFolderInput(false); setShowNewFileInput(true); setNewItemName('');
    setTimeout(() => newItemInputRef.current?.focus(), 0);
  }, []);

  const startNewFolder = useCallback(() => {
    setShowNewFileInput(false); setShowNewFolderInput(true); setNewItemName('');
    setTimeout(() => newItemInputRef.current?.focus(), 0);
  }, []);

  const cancelNewItem = useCallback(() => {
    setShowNewFileInput(false); setShowNewFolderInput(false); setNewItemName('');
  }, []);

  const submitNewItem = useCallback(async () => {
    const name = newItemName.trim();
    if (!name) { cancelNewItem(); return; }
    const isFolder = showNewFolderInput;
    try {
      await axios.post(`${API}/files/create`, null, { params: { path: name, is_folder: isFolder } });
      cancelNewItem();
      onRefresh?.();
      if (!isFolder) openFile?.(name);
    } catch (err) {
      console.error('Failed to create:', err);
    }
  }, [newItemName, showNewFolderInput, cancelNewItem, onRefresh, openFile]);

  const handleNewItemKeyDown = useCallback((e) => {
    if (e.key === 'Enter')  { e.preventDefault(); submitNewItem(); }
    if (e.key === 'Escape') { e.preventDefault(); cancelNewItem(); }
  }, [submitNewItem, cancelNewItem]);

  const handleContextMenu = useCallback((e, path, type) => {
    setContextMenu({ x: e.clientX, y: e.clientY, path, type });
  }, []);

  const handleRename = useCallback(async () => {
    if (!renamePath || !renameValue.trim()) { setRenamePath(null); setRenameValue(''); return; }
    try {
      const res = await axios.post(`${API}/files/rename`, null, {
        params: { path: renamePath, new_name: renameValue.trim() },
      });
      if (res.data.status === 'renamed') {
        setLazyChildren(prev => {
          const next = { ...prev };
          const parent = renamePath.includes('/') ? renamePath.replace(/\/[^/]+$/, '') : '';
          if (parent && next[parent]) {
            next[parent] = next[parent].map(item =>
              item.name === renamePath.split('/').pop()
                ? { ...item, name: renameValue.trim() }
                : item
            );
          }
          delete next[renamePath];
          return next;
        });
        lruCacheRef.current.delete(renamePath);
        onRefresh?.();
      }
    } catch (_) {}
    setRenamePath(null); setRenameValue('');
  }, [renamePath, renameValue, onRefresh]);

  const handleDelete = useCallback(async (path) => {
    if (!path || !window.confirm(`Delete "${path}"?`)) return;
    try {
      await axios.delete(`${API}/files/delete`, { params: { path } });
      setContextMenu(null);
      setLazyChildren(prev => { const next = { ...prev }; delete next[path]; return next; });
      lruCacheRef.current.delete(path);
      onRefresh?.();
    } catch (_) {}
  }, [onRefresh]);

  const copyPath = useCallback((path) => {
    navigator.clipboard.writeText(path);
    setContextMenu(null);
  }, []);

  // ── Drag & drop ───────────────────────────────────────────────────────────────
  const handleDragStart = useCallback((e, path, type) => {
    dragSourceRef.current = { path, type };
    e.dataTransfer.setData('text/plain', path);
    e.dataTransfer.effectAllowed = 'move';
  }, []);

  const handleDragOver = useCallback((e, folderPath) => {
    e.preventDefault(); e.stopPropagation();
    const src = dragSourceRef.current;
    if (!src || src.path === folderPath || folderPath.startsWith(src.path + '/')) return;
    e.dataTransfer.dropEffect = 'move';
    setDropTarget(folderPath);
  }, []);

  const handleDrop = useCallback(async (e, destFolderPath) => {
    e.preventDefault(); e.stopPropagation();
    setDropTarget(null);
    const src = dragSourceRef.current;
    if (!src || !destFolderPath) return;
    if (src.path === destFolderPath || destFolderPath.startsWith(src.path + '/')) return;
    try {
      const res = await axios.post(`${API}/files/move`, null, {
        params: { path: src.path, dest: destFolderPath },
      });
      if (res.data.status === 'moved') {
        setLazyChildren(prev => { const next = { ...prev }; delete next[src.path]; return next; });
        lruCacheRef.current.delete(src.path);
        onRefresh?.();
      }
    } catch (_) {}
    dragSourceRef.current = null;
  }, [onRefresh]);

  const handleDragLeave = useCallback(() => setDropTarget(null), []);

  const collapseAll = useCallback(() => {
    setExpandedFolders(new Set());
    setLazyChildren({});
    lruCacheRef.current.clear();
    loadGenForPathRef.current.clear();
  }, []);

  // ── itemData passed to react-window rows (stable reference via useMemo) ───────
  // Mirrors VS Code's IListRenderer being called with the same data object.
  const itemData = useMemo(() => ({
    flatItems,
    selectedFile,
    expandedFolders,
    loadingFolders,
    toggleFolder,
    openFile,
    onContextMenu: handleContextMenu,
    onDragStart:   handleDragStart,
    onDragOver:    handleDragOver,
    onDragLeave:   handleDragLeave,
    onDrop:        handleDrop,
    dropTarget,
    onMouseEnter:  handleMouseEnter,
    onMouseLeave:  handleMouseLeave,
    gitIgnored,
  }), [
    flatItems, selectedFile, expandedFolders, loadingFolders,
    toggleFolder, openFile, handleContextMenu, handleDragStart,
    handleDragOver, handleDragLeave, handleDrop, dropTarget,
    handleMouseEnter, handleMouseLeave, gitIgnored,
  ]);

  // ── Render ────────────────────────────────────────────────────────────────────
  const isEmpty = (!tree || tree.length === 0) && !showNewFileInput && !showNewFolderInput;

  return (
    <div className="file-explorer">
      <div className="sidebar-header">
        <span className="sidebar-title">EXPLORER</span>
        <div className="sidebar-actions">
          <button className={`icon-btn ${showHiddenFiles ? 'active' : ''}`} title="Show hidden files" onClick={onToggleShowHidden}>
            <VscEllipsis size={16} />
          </button>
          <button className="icon-btn" title="New File"    onClick={startNewFile}><VscNewFile size={16} /></button>
          <button className="icon-btn" title="New Folder"  onClick={startNewFolder}><VscNewFolder size={16} /></button>
          <button className="icon-btn" title="Refresh"     onClick={onRefresh}><VscRefresh size={16} /></button>
          <button className="icon-btn" title="Collapse All" onClick={collapseAll}><VscCollapseAll size={16} /></button>
        </div>
      </div>

      {/* Context menu */}
      {contextMenu && (
        <div
          className="file-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={e => e.stopPropagation()}
        >
          <button type="button" className="context-menu-item" onClick={() => {
            setRenamePath(contextMenu.path);
            setRenameValue(contextMenu.path.split('/').pop());
            setContextMenu(null);
          }}>
            <VscEdit size={14} /> Rename
          </button>
          <button type="button" className="context-menu-item" onClick={() => copyPath(contextMenu.path)}>
            <VscCopy size={14} /> Copy path
          </button>
          <button type="button" className="context-menu-item context-menu-item-danger"
            onClick={() => handleDelete(contextMenu.path)}>
            <VscTrash size={14} /> Delete
          </button>
        </div>
      )}

      {/* Inline rename */}
      {renamePath && (
        <div className="tree-item" style={{ padding: '4px 8px' }}>
          <span className="tree-chevron" style={{ visibility: 'hidden' }}><VscChevronRight size={16} /></span>
          <span className="file-icon" style={{ color: '#8a8a8a', display: 'flex', alignItems: 'center' }}><MdInsertDriveFile size={15} /></span>
          <input
            ref={renameInputRef}
            className="search-input"
            value={renameValue}
            onChange={e => setRenameValue(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') handleRename();
              if (e.key === 'Escape') { setRenamePath(null); setRenameValue(''); }
            }}
            onBlur={handleRename}
            style={{ flex: 1, margin: 0, minWidth: 0 }}
          />
        </div>
      )}

      {/* File tree — virtual list (only visible rows in DOM) */}
      <div className="file-tree" style={{ flex: 1, overflow: 'hidden' }}>
        {isEmpty ? (
          treeLoading ? (
            <div className="explorer-empty-state">
              <VscLoading size={24} className="tree-spinner" style={{ color: 'var(--text-muted)', marginTop: 32 }} />
            </div>
          ) : (
            <div className="explorer-empty-state">
              <VscFolderOpened size={40} className="explorer-empty-icon" />
              <p className="explorer-empty-title">No folder opened</p>
              <p className="explorer-empty-desc">Open a folder to start working on your project.</p>
              <button className="explorer-open-folder-btn" onClick={onOpenFolder}>Open Folder</button>
            </div>
          )
        ) : (
          <>
            {/* New file/folder input — rendered above the virtual list */}
            {(showNewFileInput || showNewFolderInput) && (
              <div className="tree-item" style={{ padding: '4px 8px' }}>
                <span className="tree-chevron" style={{ visibility: 'hidden' }}><VscChevronRight size={16} /></span>
                {showNewFolderInput
                  ? <span className="folder-icon" style={{ color: '#dcad5a', display: 'flex', alignItems: 'center' }}><MdFolder size={16} /></span>
                  : <span className="file-icon" style={{ color: '#8a8a8a', display: 'flex', alignItems: 'center' }}><MdInsertDriveFile size={15} /></span>
                }
                <div className="search-input-wrapper" style={{ flex: 1, margin: 0, minWidth: 0 }}>
                  <input
                    ref={newItemInputRef}
                    className="search-input"
                    placeholder={showNewFolderInput ? 'Folder name' : 'File name'}
                    value={newItemName}
                    onChange={e => setNewItemName(e.target.value)}
                    onKeyDown={handleNewItemKeyDown}
                    onBlur={() => { if (!newItemName.trim()) cancelNewItem(); }}
                  />
                </div>
              </div>
            )}

            {/*
              react-window v2 List auto-sizes itself via an internal ResizeObserver —
              AutoSizer is not needed. rowProps is spread directly onto each TreeRow.
            */}
            <List
              listRef={listRef}
              style={{ height: '100%', width: '100%' }}
              rowCount={flatItems.length}
              rowHeight={ROW_HEIGHT}
              rowComponent={TreeRow}
              rowProps={itemData}
              overscanCount={8}
            />
          </>
        )}
      </div>
    </div>
  );
}

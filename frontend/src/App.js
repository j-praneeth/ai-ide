import React, { useEffect, useState, useCallback, useRef } from 'react';
import Editor from '@monaco-editor/react';
import DiffTab, { buildDiffTabKey, isDiffTabKey, parseDiffTabKey } from './components/DiffTab';
import axios from 'axios';
import './App.css';
import { API_URL as API } from './config';
import ActivityBar from './components/ActivityBar';
import FileExplorer from './components/FileExplorer';
import SearchPanel from './components/SearchPanel';
import SourceControlPanel from './components/SourceControlPanel';
import ExtensionsPanel from './components/ExtensionsPanel';
import ExtensionAppPanel from './components/ExtensionAppPanel';
import SettingsPanel from './components/SettingsPanel';
import EditorTabs from './components/EditorTabs';
import TerminalPanel from './components/TerminalPanel';
import StatusBar from './components/StatusBar';
import CommandPalette from './components/CommandPalette';
import OpenFolderDialog from './components/OpenFolderDialog';
import MobileCompanionPopup from './components/MobileCompanionPopup';
import CliPanel from './components/CliPanel';
import AuthGate from './components/AuthGate';
import { VscDeviceMobile, VscTerminal, VscSync, VscRefresh, VscFile, VscSearch } from 'react-icons/vsc';
import { listDirFromHandle, getHandleForPath, getFileContentFromHandle, writeFileToHandle } from './lib/webFs';
import { authFetch, getAuthUser } from './lib/auth';
import { Throttler, ResourceQueue } from './lib/async';
import { waitForBackendReady } from './lib/gitService';
import { buildMatchRegex, firstMatchColumnsInLine } from './lib/searchMatch';
import { extensionRegistry } from './lib/extensionRegistry';

// Default HTTP timeout for axios (ms). Git / terminal / large trees can exceed a few seconds;
// keep this generous so Source Control and search fallbacks do not spuriously time out.
axios.defaults.timeout = 120000;

// Module-level singletons — mirrors VS Code's service-level Throttler instances.
// Throttler: at most 1 in-flight tree load + 1 pending (new requests replace old pending)
const _treeLoadThrottler = new Throttler();
// ResourceQueue: file saves are serialised per path — prevents out-of-order writes
const _fileSaveSequencer = new ResourceQueue();

// Compute which lines in the current text differ from the original, correctly
// handling insertions/deletions by trimming matching leading/trailing lines first.
function computeModifiedLines(originalText, currentText) {
  const o = originalText.split('\n');
  const c = currentText.split('\n');
  const oLen = o.length;
  const cLen = c.length;

  let start = 0;
  while (start < oLen && start < cLen && o[start] === c[start]) start++;

  let oEnd = oLen - 1;
  let cEnd = cLen - 1;
  while (oEnd >= start && cEnd >= start && o[oEnd] === c[cEnd]) { oEnd--; cEnd--; }

  const modified = new Set();
  for (let i = start; i <= cEnd; i++) modified.add(i + 1);
  return modified;
}

// Language detection by file extension
function getLanguage(filename) {
  if (!filename) return 'plaintext';
  const ext = filename.split('.').pop().toLowerCase();
  const map = {
    js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
    py: 'python', json: 'json', html: 'html', htm: 'html', css: 'css',
    scss: 'scss', less: 'less', md: 'markdown', yaml: 'yaml', yml: 'yaml',
    xml: 'xml', svg: 'xml', sh: 'shell', bash: 'shell', sql: 'sql',
    java: 'java', go: 'go', rs: 'rust', rb: 'ruby', php: 'php',
    swift: 'swift', kt: 'kotlin', c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp',
    cs: 'csharp', dockerfile: 'dockerfile', toml: 'ini', ini: 'ini',
    env: 'plaintext', gitignore: 'plaintext', txt: 'plaintext',
  };
  return map[ext] || 'plaintext';
}

// ─── Menu Definitions ─────────────────────────────────────────
const MENU_ITEMS = {
  File: [
    { id: 'file.newFile', label: 'New File', shortcut: '⌘ N' },
    { id: 'file.newFolder', label: 'New Folder' },
    { id: 'file.openFolder', label: 'Open Folder...', shortcut: '⌘ O' },
    { id: 'file.newWindow', label: 'New Window', shortcut: '⌘ ⇧ N' },
    { type: 'separator' },
    { id: 'file.save', label: 'Save', shortcut: '⌘ S' },
    { id: 'file.saveAll', label: 'Save All', shortcut: '⌘ ⇧ S' },
    { type: 'separator' },
    { id: 'file.closeTab', label: 'Close Tab', shortcut: '⌘ W' },
    { id: 'file.closeAllTabs', label: 'Close All Tabs' },
  ],
  Edit: [
    { id: 'edit.undo', label: 'Undo', shortcut: '⌘ Z' },
    { id: 'edit.redo', label: 'Redo', shortcut: '⌘ ⇧ Z' },
    { type: 'separator' },
    { id: 'edit.cut', label: 'Cut', shortcut: '⌘ X' },
    { id: 'edit.copy', label: 'Copy', shortcut: '⌘ C' },
    { id: 'edit.paste', label: 'Paste', shortcut: '⌘ V' },
    { type: 'separator' },
    { id: 'edit.find', label: 'Find', shortcut: '⌘ F' },
    { id: 'edit.replace', label: 'Replace', shortcut: '⌘ H' },
  ],
  View: [
    { id: 'view.commandPalette', label: 'Command Palette', shortcut: '⌘ ⇧ P' },
    { type: 'separator' },
    { id: 'view.explorer', label: 'Explorer', shortcut: '⌘ ⇧ E' },
    { id: 'view.search', label: 'Search', shortcut: '⌘ ⇧ F' },
    { id: 'view.sourceControl', label: 'Source Control', shortcut: '⌘ ⇧ G' },
    { id: 'view.extensions', label: 'Extensions', shortcut: '⌘ ⇧ X' },
    { type: 'separator' },
    { id: 'view.terminal', label: 'Terminal', shortcut: '⌘ `' },
    { id: 'view.chat', label: 'AI Chat', shortcut: '⌘ L' },
    { type: 'separator' },
    { id: 'view.settings', label: 'Settings', shortcut: '⌘ ,' },
  ],
  Help: [
    { id: 'help.checkUpdates', label: 'Check for Updates' },
    { type: 'separator' },
    { id: 'help.about', label: 'About Nebula IDE' },
  ],
};

function App() {
  // File system state
  const [tree, setTree] = useState([]);
  const [treeLoading, setTreeLoading] = useState(false);
  const [openFiles, setOpenFiles] = useState([]);
  const [activeFile, setActiveFile] = useState(null);
  const [fileContents, setFileContents] = useState({});
  const [originalContents, setOriginalContents] = useState({});
  const [modifiedFiles, setModifiedFiles] = useState(new Set());
  const activeFileRef = useRef(activeFile);
  const fileContentsRef = useRef(fileContents);
  const decorationsRef = useRef([]);
  activeFileRef.current = activeFile;
  fileContentsRef.current = fileContents;

  // UI state
  const [sidebarPanel, setSidebarPanel] = useState('explorer');
  const [showTerminal, setShowTerminal] = useState(false);
  const [showRightPanel, setShowRightPanel] = useState(true);
  const [rightPanelWidth, setRightPanelWidth] = useState(300);
  const [showMobileCompanionPopup, setShowMobileCompanionPopup] = useState(false);
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  // Unsaved-changes dialog state
  const [unsavedDialog, setUnsavedDialog] = useState(null); // { file: string, onSave, onDiscard, onCancel }
  const [terminalHeight, setTerminalHeight] = useState(250);
  const [cursorPosition, setCursorPosition] = useState({ line: 1, column: 1 });
  const [activeMenu, setActiveMenu] = useState(null);
  const [showAbout, setShowAbout] = useState(false);
  const [showNewFilePrompt, setShowNewFilePrompt] = useState(false);
  const [showOpenFolder, setShowOpenFolder] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searchFocused, setSearchFocused] = useState(false);
  const [searchSelectedIndex, setSearchSelectedIndex] = useState(0);
  const searchTimerRef = useRef(null);
  // Seed projectName / projectRoot from a localStorage snapshot of the last
  // hydrated workspace so the title bar / SCM panel render the right value on
  // the very first frame. The Electron main process then overrides this via
  // 'app:get-workspace' inside useLayoutEffect — but having a seed avoids the
  // visible flash to "Nebula" while the IPC round-trip completes.
  const [projectName, setProjectName] = useState(() => {
    try {
      const raw = localStorage.getItem('nebula_last_workspace');
      const o = raw ? JSON.parse(raw) : null;
      if (o && typeof o.name === 'string' && o.name) return o.name;
    } catch (_) {}
    return 'Nebula';
  });
  const [projectRoot, setProjectRoot] = useState(() => {
    try {
      const raw = localStorage.getItem('nebula_last_workspace');
      const o = raw ? JSON.parse(raw) : null;
      if (o && typeof o.path === 'string' && o.path) return o.path;
    } catch (_) {}
    return '';
  });
  const [webFolderHandle, setWebFolderHandle] = useState(null);

  // Map of repo-relative path (forward slashes) → status code (M / A / D / U / R / C / !).
  // Fed by a 15s poll against /files/git-status-bundle (same endpoint the SCM
  // panel uses). Consumed by FileExplorer to draw inline git decorations.
  const [gitDecorations, setGitDecorations] = useState({});

  /** Bump when switching workspaces so terminal / local UI fully remounts. */
  const [workspaceKey, setWorkspaceKey] = useState(0);
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [startupFolderName, setStartupFolderName] = useState('');

  // ── Extension sidebar apps ───────────────────────────────────
  const [extensionApps, setExtensionApps] = useState(() => extensionRegistry.getSidebarApps());

  // ── Auto-update state ────────────────────────────────────────
  const [updateState, setUpdateState] = useState(null); // null | 'checking' | 'available' | 'downloading' | 'ready' | 'error' | 'updated'
  const [updateProgress, setUpdateProgress] = useState(0);
  const [updateVersion, setUpdateVersion] = useState('');
  const [updateDownloadUrl, setUpdateDownloadUrl] = useState(''); // set when manualDownload:true
  const workspaceCtxRef = useRef({ projectRoot: '', webFolderHandle: null });
  const [sidebarWidth, setSidebarWidth] = useState(270);
  const sidebarResizingRef = useRef(false);
  const rightPanelResizingRef = useRef(false);
  const [ideSettings, setIdeSettings] = useState(() => {
    try {
      const raw = localStorage.getItem('nebula_ide_settings');
      if (raw) {
        const saved = JSON.parse(raw);
        if (saved.theme === 'Nebula Light') {
          document.documentElement.setAttribute('data-theme', 'light');
        }
        return saved;
      }
    } catch (_) {}
    return {};
  });

  // Refs
  const editorRef = useRef(null);
  const monacoRef = useRef(null);
  const pendingSearchNavRef = useRef(null);
  const resizingRef = useRef(false);
  const startYRef = useRef(0);
  const startHeightRef = useRef(0);
  const menuRef = useRef(null);

  const [showHiddenFiles, setShowHiddenFiles] = useState(() => {
    try {
      const s = localStorage.getItem('nebula_ide_settings');
      return s ? (JSON.parse(s).showHiddenFiles !== false) : true;
    } catch { return true; }
  });

  // Force explorer panel as default on every mount
  useEffect(() => { setSidebarPanel('explorer'); }, []);

  // ── Workspace hydration (deterministic, runs before any HTTP) ──
  //
  // The Electron main process restores `currentProjectRoot` from
  // nebula-session.json before it ever opens the BrowserWindow. We pull that
  // value via IPC the moment the renderer mounts so the title bar, file
  // explorer context, and Source Control panel all see the restored workspace
  // immediately — without waiting on the backend's /files/workspace HTTP.
  //
  // We also subscribe to live 'project:root-changed' events so subsequent
  // workspace switches (Open Folder, new-window spawn, etc.) update the same
  // React state via one path.
  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return undefined;
    let cancelled = false;

    const applyWorkspace = (ws) => {
      if (cancelled || !ws) return;
      const path = (ws.path || '').trim();
      const name = (ws.name || '').trim();
      console.log(`[App] workspace hydrated from main: path="${path}" name="${name}"`);
      if (path) {
        setProjectRoot(path);
        setProjectName(name || path.split(/[\\/]/).filter(Boolean).pop() || 'Nebula');
        try {
          localStorage.setItem(
            'nebula_last_workspace',
            JSON.stringify({ path, name: name || (path.split(/[\\/]/).filter(Boolean).pop() || '') }),
          );
        } catch (_) {}
      } else {
        // Explicitly clear — fresh window with no project; override the localStorage seed.
        _ipcSaidFreshWindow.current = true;
        setProjectRoot('');
        setProjectName('Nebula');
        // Clear stored CLI session IDs so the CLI panel starts fresh (not reattached
        // to the previous window's session which has the wrong project CWD).
        try {
          for (const key of Object.keys(localStorage)) {
            if (key.startsWith('nebula_cli_session_')) localStorage.removeItem(key);
          }
        } catch (_) {}
      }
    };

    if (api.getCurrentWorkspace) {
      api.getCurrentWorkspace().then(applyWorkspace).catch((e) => {
        console.warn('[App] getCurrentWorkspace failed:', e && e.message);
      });
    }

    let unsubscribe = null;
    if (api.onProjectRootChanged) {
      unsubscribe = api.onProjectRootChanged((payload) => {
        applyWorkspace({
          path: payload && payload.projectRoot,
          name: payload && payload.projectName,
        });
      });
    }
    return () => {
      cancelled = true;
      if (typeof unsubscribe === 'function') { try { unsubscribe(); } catch (_) {} }
    };
  }, []);

  // ── Sync sidebar extension apps from registry ────────────────
  useEffect(() => {
    const handler = () => setExtensionApps(extensionRegistry.getSidebarApps());
    extensionRegistry.addEventListener('change', handler);
    return () => extensionRegistry.removeEventListener('change', handler);
  }, []);

  // ── Git decorations (file-tree badges + colors) ──────────────
  // Poll the same status bundle the SCM panel uses. Cheap on the backend (one
  // execSync git invocation per tick, 15s cadence) and the FileExplorer only
  // re-renders when the parsed map actually changes shape, so the cost is
  // bounded even in huge repos.
  useEffect(() => {
    const hasNativeWorkspace = !!projectRoot;
    if (!hasNativeWorkspace) {
      // Web folder mode (FS Access API) has no git knowledge — clear and skip.
      setGitDecorations({});
      return undefined;
    }
    let cancelled = false;

    const parse = (porcelain) => {
      const map = {};
      if (!porcelain) return map;
      for (const rawLine of porcelain.split('\n')) {
        if (!rawLine) continue;
        // Porcelain format: XY <path>   (or XY <orig> -> <new> for renames)
        const code0 = rawLine[0] || ' ';
        const code1 = rawLine[1] || ' ';
        let rest = rawLine.slice(3);
        if (rest.includes(' -> ')) rest = rest.split(' -> ').pop();
        let rel = (rest || '').trim().replace(/^"(.*)"$/, '$1');
        if (!rel) continue;
        rel = rel.replace(/\\/g, '/');
        // VS Code's precedence: untracked > conflict > index > worktree.
        let code;
        if (code0 === '?' && code1 === '?') code = 'U';
        else if (code0 === 'U' || code1 === 'U' || (code0 === 'A' && code1 === 'A') || (code0 === 'D' && code1 === 'D')) code = '!';
        else if (code0 !== ' ' && code0 !== '?') code = code0;
        else code = code1;
        map[rel] = code;
      }
      return map;
    };

    const shallowEqual = (a, b) => {
      const ak = Object.keys(a); const bk = Object.keys(b);
      if (ak.length !== bk.length) return false;
      for (const k of ak) if (a[k] !== b[k]) return false;
      return true;
    };

    const tick = async () => {
      try {
        const res = await axios.get(`${API}/files/git-status-bundle`, { timeout: 30000 });
        if (cancelled) return;
        if (!res.data || res.data.ok === false) {
          setGitDecorations(prev => (Object.keys(prev).length ? {} : prev));
          return;
        }
        const next = parse(res.data.status || '');
        setGitDecorations(prev => (shallowEqual(prev, next) ? prev : next));
      } catch (_) {
        // Backend not ready / transient — keep prior decorations.
      }
    };

    waitForBackendReady().then(() => { if (!cancelled) tick(); });
    const id = setInterval(tick, 15000);

    // ── Live watcher → status refresh ─────────────────────────────────────
    //
    // The backend already runs a watchdog/FSEvents/inotify watcher on the
    // project root (publishes events on /files/watch). It includes .git/
    // because that lives under the root, so commits, stages, checkouts,
    // stashes — anything that mutates .git/index or working-tree files —
    // produce events here.
    //
    // We coalesce: any incoming batch refreshes the git bundle once, after a
    // 200ms quiet window. The 15s safety-net poll above still catches edge
    // cases (e.g. .git lives outside the root, or the WS dropped silently).
    let ws = null;
    let wsRetryTimer = null;
    let wsKeepalive = null;
    let debounceTimer = null;

    const refreshNow = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        tick();
        // Notify other panels (SCM) that something git-relevant moved on
        // disk, so they can refresh their own caches without polling.
        try { window.dispatchEvent(new CustomEvent('nebula:git-fs-change')); } catch (_) {}
      }, 200);
    };

    const wsUrl = (() => {
      try {
        // Build ws://host:port/files/watch from the API URL we already use.
        const u = new URL(API, window.location.origin);
        const proto = u.protocol === 'https:' ? 'wss:' : 'ws:';
        return `${proto}//${u.host}/files/watch`;
      } catch (_) {
        return null;
      }
    })();

    const connectWs = () => {
      if (cancelled || !wsUrl) return;
      try {
        ws = new WebSocket(wsUrl);
      } catch (_) {
        ws = null;
        wsRetryTimer = setTimeout(connectWs, 5000);
        return;
      }
      ws.onmessage = (ev) => {
        if (cancelled) return;
        let msg = null;
        try { msg = JSON.parse(ev.data); } catch (_) { return; }
        if (msg && Array.isArray(msg.changes) && msg.changes.length > 0) {
          refreshNow();
        }
      };
      ws.onclose = () => {
        if (cancelled) return;
        wsRetryTimer = setTimeout(connectWs, 3000);
      };
      ws.onerror = () => { try { ws && ws.close(); } catch (_) {} };
    };
    waitForBackendReady().then(() => { if (!cancelled) connectWs(); });

    // Belt-and-braces: also listen for explicit refresh requests from other
    // panels (SCM panel emits after every commit / stage / push), so a user
    // action immediately repaints decorations without waiting for the WS
    // event to round-trip through the OS watcher.
    const onExplicitRefresh = () => refreshNow();
    window.addEventListener('nebula:git-refresh-request', onExplicitRefresh);

    return () => {
      cancelled = true;
      clearInterval(id);
      if (wsRetryTimer) clearTimeout(wsRetryTimer);
      if (wsKeepalive) clearInterval(wsKeepalive);
      if (debounceTimer) clearTimeout(debounceTimer);
      window.removeEventListener('nebula:git-refresh-request', onExplicitRefresh);
      try { ws && ws.close(); } catch (_) {}
    };
  }, [projectRoot]);

  // ── Auto-update IPC listeners (Electron only) ────────────────
  const [updateError, setUpdateError] = useState('');
  useEffect(() => {
    const api = window.electronAPI?.updates;
    if (!api) return;
    const unsubs = [
      api.onChecking?.(() => { setUpdateState('checking'); setUpdateError(''); }),
      api.onAvailable?.((info) => {
        setUpdateVersion(info?.version || '');
        if (info?.manualDownload) {
          // GitHub API fallback: we know a newer version exists but can't auto-install.
          // Show a "Download" button that opens the release page.
          setUpdateDownloadUrl(info?.downloadUrl || '');
          setUpdateState('available-manual');
        } else {
          setUpdateDownloadUrl('');
          setUpdateState('available');
        }
      }),
      api.onNotAvailable?.(() => { setUpdateState('updated'); setUpdateVersion(''); setTimeout(() => setUpdateState(s => s === 'updated' ? null : s), 4000); }),
      api.onDownloadProgress?.((p) => { setUpdateState('downloading'); setUpdateProgress(Math.round(p?.percent || 0)); }),
      api.onDownloaded?.((info) => { setUpdateState('ready'); setUpdateVersion(info?.version || ''); }),
      api.onError?.((err) => { setUpdateState('error'); setUpdateError(err?.message || 'Update check failed'); }),
    ].filter(Boolean);
    return () => unsubs.forEach(fn => { try { fn(); } catch (_) {} });
  }, []);

  useEffect(() => {
    workspaceCtxRef.current = { projectRoot, webFolderHandle };
  }, [projectRoot, webFolderHandle]);

  // Load file tree — throttled so rapid refreshes (file watcher events) never
  // stack up. Mirrors VS Code's Throttler used for configuration/tree refresh.
  const loadTree = useCallback(() => {
    return _treeLoadThrottler.queue(async () => {
      setTreeLoading(true);
      try {
        if (webFolderHandle) {
          const nodes = await listDirFromHandle(webFolderHandle, '', showHiddenFiles);
          setTree(nodes);
        } else {
          const useNative = typeof window !== 'undefined' && window.electronAPI?.listProjectDir;
          const treeP = useNative
            ? window.electronAPI.listProjectDir('', showHiddenFiles)
            : axios.get(`${API}/files/tree`, { params: { show_hidden: showHiddenFiles } }).then(r => r.data);
          let pathKey = '';
          try {
            const wsRes = await axios.get(`${API}/files/workspace`);
            pathKey = (wsRes.data?.path || '').trim();
            if (pathKey) {
              try {
                const raw = sessionStorage.getItem('nebula_tree_cache');
                const parsed = raw ? JSON.parse(raw) : null;
                if (
                  parsed && typeof parsed === 'object' && Array.isArray(parsed.tree)
                  && String(parsed.path || '').trim() === pathKey
                ) {
                  setTree(parsed.tree);
                }
              } catch (_) {}
            } else {
              setTree([]);
            }
          } catch (_) {}
          const nodes = await treeP;
          const list = Array.isArray(nodes) ? nodes : [];
          setTree(list);
          try {
            sessionStorage.setItem(
              'nebula_tree_cache',
              JSON.stringify({ path: pathKey, tree: list }),
            );
          } catch (_) {}
        }
      } catch (err) {
        console.error('Failed to load file tree:', err);
        throw err; // re-throw so the Throttler can signal retry callers
      } finally {
        setTreeLoading(false);
      }
    });
  }, [showHiddenFiles, webFolderHandle]);

  // Load workspace info and file tree on startup with resilient retry.
  // Critical: In the packaged Electron app, the backend may start before or after
  // React mounts. If it starts first, the backend:ready event fires BEFORE the
  // onBackendReady listener is registered below, and the event is lost forever.
  // The retry loop below handles both cases:
  //   - Backend not ready → retry with backoff until it responds
  //   - Backend ready → succeeds immediately on first try
  const _startupFolderHandled = useRef(false);
  const _handleOpenFolder = useRef(null);
  // Set to true when IPC app:get-workspace returns empty — prevents the backend
  // HTTP /files/workspace from overwriting the cleared state with the old project.
  const _ipcSaidFreshWindow = useRef(false);

  useEffect(() => {
    let active = true;
    let retryTimer = null;
    let attempts = 0;
    const MAX_ATTEMPTS = 30; // ~30s total with backoff
    const cleanupFns = [];

    // Detect if this window was spawned to open a specific folder (show loading until ready).
    if (window.electronAPI?.getStartupFolder && !_startupFolderHandled.current) {
      window.electronAPI.getStartupFolder().then(startupPath => {
        if (!active) return;
        if (startupPath) {
          _startupFolderHandled.current = true;
          const name = startupPath.split(/[\\/]/).filter(Boolean).pop() || startupPath;
          setStartupFolderName(name);
          _handleOpenFolder.current(startupPath);
        } else {
          // Not a folder-open window — hide loading immediately.
          setWorkspaceLoading(false);
        }
      }).catch(() => { if (active) setWorkspaceLoading(false); });
    }

    const loadWorkspace = () => {
      if (!_ipcSaidFreshWindow.current) loadTree().catch(() => {});
      axios.get(`${API}/files/workspace`).then(res => {
        if (_ipcSaidFreshWindow.current) { setWorkspaceLoading(false); return; }
        if (res.data.name) setProjectName(res.data.name);
        if (res.data.path) setProjectRoot(res.data.path);
        setWorkspaceLoading(false);
      }).catch(() => {});
    };

    const elAPI = window.electronAPI;

    // Wait for backend:ready event (emitted by Electron main process when
    // backend finishes startup) before making initial requests. This avoids
    // ERR_CONNECTION_REFUSED errors when the renderer loads before the backend.
    // Fall back to a retry loop if the event never fires (e.g. in browser dev).
    let backendSignalled = false;

    const startLoading = () => {
      if (backendSignalled) return;
      backendSignalled = true;
      if (_ipcSaidFreshWindow.current) { setWorkspaceLoading(false); return; }
      loadTree().then(() => {
        axios.get(`${API}/files/workspace`).then(res => {
          if (!active) return;
          if (!_ipcSaidFreshWindow.current) {
            if (res.data.name) setProjectName(res.data.name);
            if (res.data.path) setProjectRoot(res.data.path);
          }
          setWorkspaceLoading(false);
        }).catch(() => { setWorkspaceLoading(false); });
      }).catch(() => {
        if (!active) return;
        attempts++;
        if (attempts >= MAX_ATTEMPTS) {
          console.warn('[App] Backend not reachable after 30 retries.');
          return;
        }
        const delay = Math.min(200 * Math.pow(1.5, attempts), 3000);
        retryTimer = setTimeout(startLoading, delay);
      });
    };

    if (elAPI?.onBackendReady) {
      // In Electron: wait for backend:ready, then load once.
      const cleanup = elAPI.onBackendReady(() => {
        if (!active || backendSignalled) return;
        backendSignalled = true;
        if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
        attempts = 0;
        loadWorkspace();
        try { window.dispatchEvent(new CustomEvent('nebula:backend-ready')); } catch (_) {}
      });
      cleanupFns.push(cleanup);
      // Fallback: if backend:ready never fires (e.g. backend startup failure),
      // start the retry loop after 8s.
      retryTimer = setTimeout(() => {
        if (!backendSignalled) startLoading();
      }, 8000);
    } else {
      // Browser dev: no backend:ready event available — start retry loop immediately.
      startLoading();
    }

    return () => {
      active = false;
      if (retryTimer) clearTimeout(retryTimer);
      cleanupFns.forEach(fn => { try { fn(); } catch (_) {} });
    };
  }, [loadTree]);

  // After login, Super Admin lands on Admin dashboard by default.
  useEffect(() => {
    const u = getAuthUser();
    if (u?.role === 'super_admin') {
      setSidebarPanel('admin');
    }
  }, []);

  // Sync selected AI model to backend on app load (so Kimi/OpenAI is used after refresh or server restart)
  useEffect(() => {
    try {
      const raw = localStorage.getItem('nebula_ide_settings');
      if (!raw) return;
      const s = JSON.parse(raw);
      const source = s.aiModelSource ?? 'providers';
      const provider = (s.aiApiKeyProvider ?? 'kimi').toLowerCase();
      if (source !== 'providers') return;
      const providerToModel = {
        kimi: 'moonshotai/kimi-k2.5',
        openai: 'openai/gpt-4',
        anthropic: 'anthropic/claude-3-sonnet-20240229',
        google: 'google/gemini-pro',
        groq: 'groq/llama-3-70b',
        together: 'together/llama-3-70b',
      };
      const modelId = providerToModel[provider];
      if (!modelId) return;
      authFetch(`${API}/ai/model/set?model=${encodeURIComponent(modelId)}`, { method: 'POST' })
        .then(r => r.json().catch(() => ({})))
        .catch(() => {});
    } catch (_) {}
  }, []);

  // Apply resizable sidebar and chat widths
  useEffect(() => {
    document.documentElement.style.setProperty('--sidebar-width', `${sidebarWidth}px`);
  }, [sidebarWidth]);
  // Open a file (from backend or from web folder handle). Optional opts: { line, search: { query, caseSensitive, wholeWord, useRegex } }
  const openFile = useCallback(async (path, opts = {}) => {
    // Diff tabs use a synthetic key (see DiffTab.buildDiffTabKey). They live
    // in the same openFiles array so the user can switch via the tab strip,
    // but they don't load file content — DiffTab fetches HEAD / index / WT on
    // its own. Short-circuit before any file-content fetch.
    if (isDiffTabKey(path)) {
      pendingSearchNavRef.current = null;
      setOpenFiles(prev => (prev.includes(path) ? prev : [...prev, path]));
      setActiveFile(path);
      return;
    }
    const line = opts.line != null ? Number(opts.line) : null;
    if (line != null && Number.isFinite(line) && opts.search) {
      pendingSearchNavRef.current = {
        path,
        line,
        query: opts.search.query,
        caseSensitive: !!opts.search.caseSensitive,
        wholeWord: !!opts.search.wholeWord,
        useRegex: !!opts.search.useRegex,
      };
    } else if (line != null && Number.isFinite(line)) {
      pendingSearchNavRef.current = { path, line, query: null };
    } else {
      pendingSearchNavRef.current = null;
    }

    if (openFiles.includes(path)) {
      setActiveFile(path);
      return;
    }
    try {
      let content;
      if (webFolderHandle) {
        content = await getFileContentFromHandle(webFolderHandle, path);
      } else if (typeof window !== 'undefined' && window.electronAPI?.readProjectFile) {
        const res = await window.electronAPI.readProjectFile(path);
        if (!res?.ok) {
          throw new Error(res?.error || 'Failed to read file');
        }
        content = res.content;
      } else {
        const res = await axios.get(`${API}/files/read`, { params: { path }, timeout: 10000 });
        content = res.data.content;
      }
      setFileContents(prev => ({ ...prev, [path]: content }));
      setOriginalContents(prev => ({ ...prev, [path]: content }));
      setOpenFiles(prev => [...prev, path]);
      setActiveFile(path);
    } catch (err) {
      console.error('Failed to open file:', err);
      pendingSearchNavRef.current = null;
    }
  }, [openFiles, webFolderHandle]);

  const handleSearchChange = useCallback((e) => {
    const q = e.target.value;
    setSearchQuery(q);
    setSearchSelectedIndex(0);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    if (!q.trim()) {
      setSearchResults([]);
      return;
    }
    searchTimerRef.current = setTimeout(async () => {
      try {
        const res = await axios.get(`${API}/files/glob-search`, { params: { query: q } });
        setSearchResults(res.data?.results || []);
      } catch {
        setSearchResults([]);
      }
    }, 150);
  }, []);

  const handleOpenSearchFile = useCallback((file) => {
    setSearchQuery('');
    setSearchResults([]);
    setSearchFocused(false);
    openFile(file);
  }, [openFile]);

  const handleSearchKeyDown = useCallback((e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSearchSelectedIndex(prev => Math.min(prev + 1, searchResults.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSearchSelectedIndex(prev => Math.max(prev - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (searchResults[searchSelectedIndex]) {
        handleOpenSearchFile(searchResults[searchSelectedIndex]);
      }
    } else if (e.key === 'Escape') {
      setSearchQuery('');
      setSearchResults([]);
      setSearchFocused(false);
      e.target.blur();
    }
  }, [searchResults, searchSelectedIndex, handleOpenSearchFile]);

  useEffect(() => {
    const nav = pendingSearchNavRef.current;
    if (!nav || !editorRef.current || !monacoRef.current || activeFile !== nav.path) return;
    const content = fileContents[nav.path];
    if (content === undefined) return;

    const run = () => {
      const ed = editorRef.current;
      const monaco = monacoRef.current;
      if (!ed || !monaco) {
        pendingSearchNavRef.current = null;
        return;
      }
      const model = ed.getModel();
      if (!model) {
        pendingSearchNavRef.current = null;
        return;
      }
      const ln = Math.max(1, Math.min(model.getLineCount(), nav.line));
      const lineText = model.getLineContent(ln);
      const re = nav.query != null
        ? buildMatchRegex(nav.query, {
          caseSensitive: nav.caseSensitive,
          wholeWord: nav.wholeWord,
          useRegex: nav.useRegex,
        })
        : null;
      const cols = firstMatchColumnsInLine(lineText, re);
      try {
        if (cols) {
          const range = new monaco.Range(ln, cols.startColumn, ln, cols.endColumn);
          ed.setSelection(range);
          ed.revealRangeInCenter(range);
        } else {
          ed.revealLineInCenter(ln);
        }
      } catch (_) {}
      pendingSearchNavRef.current = null;
    };

    const t = window.setTimeout(run, 64);
    return () => window.clearTimeout(t);
  }, [activeFile, fileContents]);

  // Internal close — no unsaved check (used after save/discard confirmed)
  const _forceCloseFile = useCallback((path) => {
    setOpenFiles(prev => {
      const newFiles = prev.filter(f => f !== path);
      if (activeFile === path) {
        const idx = prev.indexOf(path);
        const newActive = newFiles[Math.min(idx, newFiles.length - 1)] || null;
        setActiveFile(newActive);
      }
      return newFiles;
    });
    setFileContents(prev => { const next = { ...prev }; delete next[path]; return next; });
    setOriginalContents(prev => { const next = { ...prev }; delete next[path]; return next; });
    setModifiedFiles(prev => { const next = new Set(prev); next.delete(path); return next; });
  }, [activeFile]);

  // Close a file — shows unsaved-changes dialog if the file has been modified
  const closeFile = useCallback((path) => {
    if (modifiedFiles.has(path)) {
      setUnsavedDialog({
        file: path,
        onSave: async () => {
          // Save then close
          try {
            if (webFolderHandle) {
              const { writeFileToHandle } = await import('./lib/webFs');
              await writeFileToHandle(webFolderHandle, path, fileContents[path]);
            } else {
              await axios.post(`${API}/files/write`, { path, content: fileContents[path] }, {
                timeout: 10000,
              });
            }
          } catch (_) {}
          setUnsavedDialog(null);
          _forceCloseFile(path);
        },
        onDiscard: () => {
          setUnsavedDialog(null);
          _forceCloseFile(path);
        },
        onCancel: () => setUnsavedDialog(null),
      });
      return;
    }
    _forceCloseFile(path);
  }, [modifiedFiles, fileContents, webFolderHandle, _forceCloseFile]);

  // Close all tabs
  const closeAllTabs = useCallback(() => {
    setOpenFiles([]);
    setActiveFile(null);
    setFileContents({});
    setOriginalContents({});
    setModifiedFiles(new Set());
  }, []);

  // Save the current file — sequenced per path so rapid Ctrl+S presses on the
  // same file never cause out-of-order writes. Mirrors VS Code's ResourceQueue
  // for atomic file writes.
  // Reads activeFile + fileContents from refs to avoid stale closures
  // when called from the Monaco command registered on editor mount.
  const saveFile = useCallback(async () => {
    const path = activeFileRef.current;
    const fc = fileContentsRef.current;
    if (!path || !fc[path]) return;
    const content = fc[path];
    try {
      await _fileSaveSequencer.queueFor(path, async () => {
        if (webFolderHandle) {
          await writeFileToHandle(webFolderHandle, path, content);
        } else {
          await axios.post(`${API}/files/write`, { path, content });
        }
      });
      setOriginalContents(prev => ({ ...prev, [path]: content }));
      setModifiedFiles(prev => { const next = new Set(prev); next.delete(path); return next; });
    } catch (err) {
      console.error('Failed to save file:', err);
    }
  }, [webFolderHandle]);

  // Save all files
  const saveAllFiles = useCallback(async () => {
    const promises = [...modifiedFiles].map(async (path) => {
      if (fileContents[path]) {
        try {
          if (webFolderHandle) {
            await writeFileToHandle(webFolderHandle, path, fileContents[path]);
          } else {
            await axios.post(`${API}/files/write`, { path, content: fileContents[path] });
          }
          return path;
        } catch (err) {
          console.error(`Failed to save ${path}:`, err);
          return null;
        }
      }
      return null;
    });
    const saved = await Promise.all(promises);
    saved.forEach(path => {
      if (path) {
        setOriginalContents(prev => ({ ...prev, [path]: fileContents[path] }));
      }
    });
    setModifiedFiles(new Set());
  }, [modifiedFiles, fileContents, webFolderHandle]);

  // Handle editor content change
  const handleEditorChange = useCallback((value) => {
    if (!activeFile) return;
    setFileContents(prev => ({ ...prev, [activeFile]: value }));
    if (value !== originalContents[activeFile]) {
      setModifiedFiles(prev => new Set(prev).add(activeFile));
    } else {
      setModifiedFiles(prev => { const next = new Set(prev); next.delete(activeFile); return next; });
    }
    // Update gutter decorations for modified lines
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (editor && monaco) {
      const modifiedLines = computeModifiedLines(originalContents[activeFile] || '', value);
      const decos = [];
      for (const line of modifiedLines) {
        decos.push({
          range: new monaco.Range(line, 1, line, 1),
          options: {
            isWholeLine: true,
            linesDecorationsClassName: 'modified-line-gutter',
          },
        });
      }
      decorationsRef.current = editor.deltaDecorations(decorationsRef.current, decos);
    }
  }, [activeFile, originalContents]);

  // Clear gutter decorations when switching files
  useEffect(() => {
    decorationsRef.current = editorRef.current?.deltaDecorations(decorationsRef.current, []) || [];
  }, [activeFile]);

  // Handle editor mount
  const handleEditorMount = useCallback((editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;

    // Configure Monaco theme — Nebula
    monaco.editor.defineTheme('nebula', {
      base: 'vs-dark',
      inherit: true,
      rules: [
        { token: 'comment', foreground: '7A7A74', fontStyle: 'italic' },
        { token: 'keyword', foreground: 'FF6188' },
        { token: 'keyword.control', foreground: 'FF6188' },
        { token: 'keyword.operator', foreground: '78DCE8' },
        { token: 'string', foreground: 'FFD866' },
        { token: 'string.quoted', foreground: 'FFD866' },
        { token: 'number', foreground: 'FC9483' },
        { token: 'type', foreground: '78DCE8' },
        { token: 'type.identifier', foreground: '78DCE8' },
        { token: 'function', foreground: 'A9DC76' },
        { token: 'function.declaration', foreground: 'A9DC76' },
        { token: 'variable', foreground: 'FCFCFA' },
        { token: 'variable.other', foreground: 'FCFCFA' },
        { token: 'constant', foreground: 'AB9DF2' },
        { token: 'constant.language', foreground: 'AB9DF2' },
        { token: 'regexp', foreground: '78DCE8' },
        { token: 'operator', foreground: '78DCE8' },
        { token: 'tag', foreground: 'FF6188' },
        { token: 'attribute', foreground: 'AB9DF2' },
        { token: 'delimiter', foreground: 'B0B0A8' },
        { token: 'meta.tag', foreground: 'FF6188' },
        { token: 'string.key', foreground: 'FFD866' },
        { token: 'entity.name.class', foreground: '78DCE8' },
        { token: 'entity.name.function', foreground: 'A9DC76' },
        { token: 'support.class', foreground: '78DCE8' },
        { token: 'support.function', foreground: 'A9DC76' },
        { token: 'support.constant', foreground: 'AB9DF2' },
        { token: 'punctuation', foreground: 'B0B0A8' },
        { token: 'storage', foreground: 'FF6188' },
        { token: 'parameter', foreground: 'FC9483' },
      ],
      colors: {
        'editor.background': '#161618',
        'editor.foreground': '#E6E6E0',
        'editor.lineHighlightBackground': '#1E1E26',
        'editor.lineHighlightBorder': '#2A2A35',
        'editor.selectionBackground': '#3A3A4A',
        'editor.inactiveSelectionBackground': '#2A2A38',
        'editorLineNumber.foreground': '#46464A',
        'editorLineNumber.activeForeground': '#7A7A74',
        'editorCursor.foreground': '#7DD3FC',
        'editorCursor.background': '#161618',
        'editor.selectionHighlightBackground': '#7DD3FC15',
        'editorBracketMatch.background': '#7DD3FC15',
        'editorBracketMatch.border': '#7DD3FC40',
        'editorIndentGuide.background1': '#2A2A32',
        'editorIndentGuide.activeBackground1': '#3A3A46',
        'editorWhitespace.foreground': '#2A2A32',
        'editorOverviewRuler.border': '#161618',
        'scrollbar.shadow': '#00000000',
        'scrollbarSlider.background': '#ffffff0d',
        'scrollbarSlider.hoverBackground': '#ffffff1a',
        'scrollbarSlider.activeBackground': '#ffffff26',
        'minimap.background': '#161618',
        'editorWidget.background': '#1E1E24',
        'editorWidget.border': '#2A2A35',
        'editorSuggestWidget.background': '#1E1E24',
        'editorSuggestWidget.border': '#2A2A35',
        'editorSuggestWidget.selectedBackground': '#3A3A4A',
        'editorSuggestWidget.foreground': '#E6E6E0',
        'input.background': '#161618',
        'input.border': '#2A2A35',
        'focusBorder': '#7DD3FC60',
        'editorBracketHighlight.foreground1': '#7DD3FC',
        'editorBracketHighlight.foreground2': '#78DCE8',
        'editorBracketHighlight.foreground3': '#FFD866',
        'editorBracketHighlight.foreground4': '#A9DC76',
        'editorBracketHighlight.foreground5': '#AB9DF2',
        'editorBracketHighlight.foreground6': '#FC9483',
        'editorBracketPairGuide.background1': '#7DD3FC20',
        'editorBracketPairGuide.background2': '#78DCE820',
        'editorBracketPairGuide.background3': '#FFD86620',
      }
    });
    monaco.editor.defineTheme('nebula-light', {
      base: 'vs',
      inherit: true,
      rules: [
        { token: 'comment', foreground: '8A8A92', fontStyle: 'italic' },
        { token: 'keyword', foreground: '7B6FD4' },
        { token: 'keyword.control', foreground: '7B6FD4' },
        { token: 'keyword.operator', foreground: '4F9AC2' },
        { token: 'string', foreground: 'C99F2E' },
        { token: 'string.quoted', foreground: 'C99F2E' },
        { token: 'number', foreground: 'D94A6E' },
        { token: 'type', foreground: '4F9AC2' },
        { token: 'type.identifier', foreground: '4F9AC2' },
        { token: 'function', foreground: '5E9E6A' },
        { token: 'function.declaration', foreground: '5E9E6A' },
        { token: 'variable', foreground: '2C2C30' },
        { token: 'variable.other', foreground: '2C2C30' },
        { token: 'constant', foreground: '7B6FD4' },
        { token: 'constant.language', foreground: '7B6FD4' },
        { token: 'tag', foreground: '7B6FD4' },
        { token: 'attribute', foreground: '4F9AC2' },
        { token: 'delimiter', foreground: '5C5C62' },
        { token: 'meta.tag', foreground: '7B6FD4' },
        { token: 'entity.name.class', foreground: '4F9AC2' },
        { token: 'entity.name.function', foreground: '5E9E6A' },
      ],
      colors: {
        'editor.background': '#FAFAFA',
        'editor.foreground': '#2C2C30',
        'editor.lineHighlightBackground': '#E8E8EC',
        'editor.lineHighlightBorder': '#D0D0D8',
        'editor.selectionBackground': '#C4D8E8',
        'editor.inactiveSelectionBackground': '#D8E4EE',
        'editorLineNumber.foreground': '#C4C4CC',
        'editorLineNumber.activeForeground': '#5C5C62',
        'editorCursor.foreground': '#4F9AC2',
        'editorCursor.background': '#FAFAFA',
        'editor.selectionHighlightBackground': '#4F9AC215',
        'editorBracketMatch.background': '#4F9AC215',
        'editorBracketMatch.border': '#4F9AC240',
        'editorIndentGuide.background1': '#E0E0E4',
        'editorIndentGuide.activeBackground1': '#D0D0D8',
        'editorWhitespace.foreground': '#E0E0E4',
        'editorOverviewRuler.border': '#FAFAFA',
        'scrollbar.shadow': '#00000000',
        'scrollbarSlider.background': '#0000000d',
        'scrollbarSlider.hoverBackground': '#0000001a',
        'scrollbarSlider.activeBackground': '#00000026',
        'minimap.background': '#FAFAFA',
        'editorWidget.background': '#F0F0F2',
        'editorWidget.border': '#D0D0D8',
        'editorSuggestWidget.background': '#F0F0F2',
        'editorSuggestWidget.border': '#D0D0D8',
        'editorSuggestWidget.selectedBackground': '#C4D8E8',
        'editorSuggestWidget.foreground': '#2C2C30',
        'input.background': '#FAFAFA',
        'input.border': '#D0D0D8',
        'focusBorder': '#4F9AC260',
      }
    });
    if (ideSettings.theme === 'Nebula Light') {
      monaco.editor.setTheme('nebula-light');
    } else {
      monaco.editor.setTheme('nebula');
    }

    // Track cursor position
    editor.onDidChangeCursorPosition((e) => {
      setCursorPosition({ line: e.position.lineNumber, column: e.position.column });
    });

    // Editor keyboard shortcuts
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveFile());
  }, [saveFile]);

  // ─── Menu command handler ─────────────────────────────────
  const executeMenuCommand = useCallback((commandId) => {
    setActiveMenu(null); // close menus

    switch (commandId) {
      // File
      case 'file.newFile':
        setSidebarPanel('explorer');
        setShowNewFilePrompt(true);
        break;
      case 'file.newFolder':
        setSidebarPanel('explorer');
        // Handled inside FileExplorer
        break;
      case 'file.openFolder':
        setShowOpenFolder(true);
        break;
      case 'file.newWindow':
        if (window.electronAPI?.openNewWindow) {
          window.electronAPI.openNewWindow().catch(() => {});
        }
        break;
      case 'file.save':
        saveFile();
        break;
      case 'file.saveAll':
        saveAllFiles();
        break;
      case 'file.closeTab':
        if (activeFile) closeFile(activeFile);
        break;
      case 'file.closeAllTabs':
        closeAllTabs();
        break;

      // Edit
      case 'edit.undo':
        editorRef.current?.trigger('keyboard', 'undo');
        break;
      case 'edit.redo':
        editorRef.current?.trigger('keyboard', 'redo');
        break;
      case 'edit.cut':
        editorRef.current?.trigger('keyboard', 'editor.action.clipboardCutAction');
        break;
      case 'edit.copy':
        editorRef.current?.trigger('keyboard', 'editor.action.clipboardCopyAction');
        break;
      case 'edit.paste':
        editorRef.current?.trigger('keyboard', 'editor.action.clipboardPasteAction');
        break;
      case 'edit.find':
        editorRef.current?.trigger('keyboard', 'actions.find');
        break;
      case 'edit.replace':
        editorRef.current?.trigger('keyboard', 'editor.action.startFindReplaceAction');
        break;

      // Selection
      case 'selection.selectAll':
        editorRef.current?.trigger('keyboard', 'editor.action.selectAll');
        break;
      case 'selection.expandSelection':
        editorRef.current?.trigger('keyboard', 'editor.action.smartSelect.expand');
        break;
      case 'selection.copyLineUp':
        editorRef.current?.trigger('keyboard', 'editor.action.copyLinesUpAction');
        break;
      case 'selection.copyLineDown':
        editorRef.current?.trigger('keyboard', 'editor.action.copyLinesDownAction');
        break;

      // View
      case 'view.commandPalette':
        setShowCommandPalette(true);
        break;
      case 'view.explorer':
        setSidebarPanel(prev => prev === 'explorer' ? null : 'explorer');
        break;
      case 'view.search':
        setSidebarPanel(prev => prev === 'search' ? null : 'search');
        break;
      case 'view.sourceControl':
        setSidebarPanel(prev => prev === 'source-control' ? null : 'source-control');
        break;
      case 'view.extensions':
        setSidebarPanel(prev => prev === 'extensions' ? null : 'extensions');
        break;
      case 'view.terminal':
        setShowTerminal(prev => !prev);
        break;
      case 'view.sidebar':
        setSidebarPanel(prev => prev ? null : 'explorer');
        break;
      case 'view.settings':
        setSidebarPanel(prev => prev === 'settings' ? null : 'settings');
        break;

      // Go
      case 'go.quickOpen':
        setShowCommandPalette(true);
        break;
      case 'go.goToLine':
        editorRef.current?.trigger('keyboard', 'editor.action.gotoLine');
        break;
      case 'go.goToSymbol':
        editorRef.current?.trigger('keyboard', 'editor.action.quickOutline');
        break;

      // Run
      case 'run.start':
      case 'run.runNoDebug':
        setShowTerminal(true);
        break;

      // Terminal
      case 'terminal.new':
      case 'terminal.toggle':
        setShowTerminal(prev => !prev);
        break;
      case 'terminal.split':
        setShowTerminal(true);
        break;

      // Help
      case 'help.welcome':
        closeAllTabs();
        break;
      case 'help.docs':
        window.open('https://code.visualstudio.com/docs', '_blank');
        break;
      case 'help.shortcuts':
        editorRef.current?.trigger('keyboard', 'editor.action.quickCommand');
        break;
      case 'help.checkUpdates':
        window.electronAPI?.updates?.checkForUpdates?.();
        setUpdateState('checking');
        setUpdateError('');
        // Safety: if no IPC event fires within 20s, reset so UI doesn't hang
        setTimeout(() => setUpdateState(s => s === 'checking' ? null : s), 20000);
        break;
      case 'help.about':
        setShowAbout(true);
        break;

      // Settings
      case 'settings.open':
        setSidebarPanel(prev => prev === 'settings' ? null : 'settings');
        break;

      default:
        break;
    }
  }, [saveFile, saveAllFiles, activeFile, closeFile, closeAllTabs]);

  // Command palette handler
  const handleCommand = useCallback((command) => {
    // If it starts with known prefixes, treat as command
    if (command.startsWith('file.') || command.startsWith('view.') ||
        command.startsWith('editor.') || command.startsWith('settings.') ||
        command.startsWith('edit.') || command.startsWith('go.') ||
        command.startsWith('terminal.') || command.startsWith('run.') ||
        command.startsWith('help.') || command.startsWith('selection.')) {
      executeMenuCommand(command);
      return;
    }
    // Otherwise treat as file path
    openFile(command);
  }, [executeMenuCommand, openFile]);

  // Global keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e) => {
      // Cmd/Ctrl + Shift + P - Command Palette
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'P') {
        e.preventDefault();
        setShowCommandPalette(prev => !prev);
      }
      // Cmd/Ctrl + P - Quick Open
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === 'p') {
        e.preventDefault();
        setShowCommandPalette(prev => !prev);
      }
      // Cmd/Ctrl + B - Toggle Sidebar
      if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
        e.preventDefault();
        setSidebarPanel(prev => prev ? null : 'explorer');
      }
      // Cmd/Ctrl + ` - Toggle Terminal
      if ((e.metaKey || e.ctrlKey) && e.key === '`') {
        e.preventDefault();
        setShowTerminal(prev => !prev);
      }
      // Cmd/Ctrl + S - Save
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === 's') {
        e.preventDefault();
        saveFile();
      }
      // Cmd/Ctrl + Shift + S - Save All
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'S') {
        e.preventDefault();
        saveAllFiles();
      }
      // Cmd/Ctrl + W - Close Tab
      if ((e.metaKey || e.ctrlKey) && e.key === 'w') {
        e.preventDefault();
        if (activeFile) closeFile(activeFile);
      }
      // Cmd/Ctrl + O - Open Folder
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === 'o') {
        e.preventDefault();
        setShowOpenFolder(true);
      }
      // Cmd/Ctrl + Shift + N — New Window (Electron only)
      if (
        window.electronAPI?.openNewWindow &&
        (e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'n' || e.key === 'N')
      ) {
        e.preventDefault();
        window.electronAPI.openNewWindow().catch(() => {});
      }
      // Cmd/Ctrl + , - Settings
      if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault();
        setSidebarPanel(prev => prev === 'settings' ? null : 'settings');
      }
      // Cmd/Ctrl + Shift + E - Explorer
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'E') {
        e.preventDefault();
        setSidebarPanel(prev => prev === 'explorer' ? null : 'explorer');
      }
      // Cmd/Ctrl + Shift + F - Search
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'F') {
        e.preventDefault();
        setSidebarPanel(prev => prev === 'search' ? null : 'search');
      }
      // Cmd/Ctrl + Shift + G - Source Control
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'G') {
        e.preventDefault();
        setSidebarPanel(prev => prev === 'source-control' ? null : 'source-control');
      }
      // Cmd/Ctrl + Shift + X - Extensions
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'X') {
        e.preventDefault();
        setSidebarPanel(prev => prev === 'extensions' ? null : 'extensions');
      }
      // Escape
      if (e.key === 'Escape') {
        setShowCommandPalette(false);
        setActiveMenu(null);
        setShowAbout(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [saveFile, saveAllFiles, activeFile, closeFile]);

  // Click outside to close menus
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (activeMenu && menuRef.current && !menuRef.current.contains(e.target)) {
        setActiveMenu(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [activeMenu]);

  // Warn before closing the window/tab when there are unsaved changes
  useEffect(() => {
    const handleBeforeUnload = (e) => {
      if (modifiedFiles.size > 0) {
        e.preventDefault();
        e.returnValue = 'You have unsaved changes. Are you sure you want to leave?';
        return e.returnValue;
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [modifiedFiles]);

  // Terminal resize
  const handlePanelResizeStart = useCallback((e) => {
    e.preventDefault();
    resizingRef.current = true;
    startYRef.current = e.clientY;
    startHeightRef.current = terminalHeight;

    const handleMouseMove = (e) => {
      if (!resizingRef.current) return;
      const delta = startYRef.current - e.clientY;
      const newHeight = Math.max(100, Math.min(600, startHeightRef.current + delta));
      setTerminalHeight(newHeight);
    };

    const handleMouseUp = () => {
      resizingRef.current = false;
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [terminalHeight]);

  // Left sidebar resize
  const handleSidebarResizeStart = useCallback((e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebarWidth;
    const handleMouseMove = (ev) => {
      const delta = ev.clientX - startX;
      setSidebarWidth(Math.max(180, Math.min(500, startW + delta)));
    };
    const handleMouseUp = () => {
      sidebarResizingRef.current = false;
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    sidebarResizingRef.current = true;
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [sidebarWidth]);

  const handleRightPanelResizeStart = useCallback((e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = rightPanelWidth;
    const handleMouseMove = (ev) => {
      const delta = startX - ev.clientX;
      const activityBar = 48;
      const sidebarW = sidebarPanel ? sidebarWidth + 3 : 0;
      const maxW = window.innerWidth - activityBar - sidebarW - 200;
      setRightPanelWidth(Math.max(260, Math.min(maxW, startW + delta)));
    };
    const handleMouseUp = () => {
      rightPanelResizingRef.current = false;
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    rightPanelResizingRef.current = true;
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [rightPanelWidth]);

  // Handle settings change — apply to editor in real-time
  const handleSettingsChange = useCallback((settings) => {
    setIdeSettings(settings);
    const root = document.documentElement;
    if (settings.theme === 'Nebula Light') {
      root.setAttribute('data-theme', 'light');
      if (monacoRef.current) monacoRef.current.editor.setTheme('nebula-light');
    } else {
      root.removeAttribute('data-theme');
      if (monacoRef.current) monacoRef.current.editor.setTheme('nebula');
    }
    if (editorRef.current && settings) {
      const opts = {};
      if (settings.fontSize !== undefined && settings.fontSize !== null) opts.fontSize = Number(settings.fontSize) || 14;
      if (settings.tabSize !== undefined && settings.tabSize !== null) opts.tabSize = Number(settings.tabSize) || 2;
      if (settings.wordWrap !== undefined) opts.wordWrap = settings.wordWrap ? 'on' : 'off';
      if (settings.minimap !== undefined) opts.minimap = { enabled: !!settings.minimap };
      if (settings.lineNumbers !== undefined) opts.lineNumbers = settings.lineNumbers ? 'on' : 'off';
      if (settings.bracketPairColorization !== undefined) opts.bracketPairColorization = { enabled: !!settings.bracketPairColorization };
      if (settings.fontLigatures !== undefined) opts.fontLigatures = !!settings.fontLigatures;
      if (settings.fontFamily !== undefined && settings.fontFamily) opts.fontFamily = `'${settings.fontFamily}', 'Fira Code', Menlo, Monaco, monospace`;
      if (settings.renderWhitespace !== undefined && settings.renderWhitespace) opts.renderWhitespace = settings.renderWhitespace;
      editorRef.current.updateOptions(opts);
    }
  }, []);

  // Handle open folder (path/name from Electron; or null, name, handle from web picker)
  const handleOpenFolder = useCallback(async (folderPath, folderName, handle = null, treeData = null) => {
    const { projectRoot: prevRoot, webFolderHandle: prevHandle } = workspaceCtxRef.current;
    const hadWorkspace = !!(prevRoot || prevHandle);
    const openingSomething = !!(folderPath || handle);

    // In Electron: if a workspace is already open and the new folder is DIFFERENT,
    // open it in a fresh window. On macOS/Linux this spawns a new process; on Windows
    // it creates an in-process BrowserWindow. The main process closes this window once
    // the new one is ready.
    //
    // Guard: skip when folderPath === prevRoot — this happens during new-window
    // initialization where the startup folder and current workspace are the same path
    // (the main process already set currentProjectRoot before this window loaded).
    // Without the guard the new window would cascade-open another window forever.
    // Normalize separators for cross-platform comparison (Windows uses \, POSIX uses /)
    const _normPath = (p) => (p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const folderAlreadyOpen = folderPath && prevRoot &&
      _normPath(folderPath) === _normPath(prevRoot);
    if (hadWorkspace && openingSomething && folderPath && !folderAlreadyOpen && window.electronAPI?.openFolderInNewWindow) {
      setWorkspaceLoading(true);
      try {
        const result = await window.electronAPI.openFolderInNewWindow(folderPath);
        if (result && !result.ok) {
          // Spawn failed — fall through to open in-place instead
          setWorkspaceLoading(false);
        } else {
          // Main process will close this window. Just keep the loading screen visible.
          return;
        }
      } catch (_) {
        setWorkspaceLoading(false);
      }
    }

    const showBlockingLoad = hadWorkspace && openingSomething;
    if (showBlockingLoad) setWorkspaceLoading(true);
    try {
      if (showBlockingLoad) {
        setWorkspaceKey(k => k + 1);
        try {
          sessionStorage.removeItem('nebula_tree_cache');
        } catch (_) {}
      }

      setOpenFiles([]);
      setActiveFile(null);
      setFileContents({});
      setOriginalContents({});
      setModifiedFiles(new Set());
      setProjectName(folderName || 'Nebula');
      if (folderPath) setProjectRoot(folderPath);
      try {
        if (folderPath) {
          localStorage.setItem(
            'nebula_last_workspace',
            JSON.stringify({ path: folderPath, name: folderName || '' }),
          );
        } else {
          localStorage.removeItem('nebula_last_workspace');
        }
      } catch (_) {}
      setWebFolderHandle(handle || null);
      if (handle && treeData) {
        setTree(treeData);
        try {
          const keyPath = (folderPath || '').trim();
          sessionStorage.setItem('nebula_tree_cache', JSON.stringify({ path: keyPath, tree: treeData }));
        } catch (_) {}
      } else if (handle) {
        try {
          const nodes = await listDirFromHandle(handle, '', showHiddenFiles);
          setTree(nodes);
        } catch (e) {
          console.error(e);
        }
      } else if (treeData) {
        setTree(treeData);
        try {
          const keyPath = (folderPath || '').trim();
          sessionStorage.setItem('nebula_tree_cache', JSON.stringify({ path: keyPath, tree: treeData }));
        } catch (_) {}
      } else {
        await loadTree();
      }
      setSidebarPanel('explorer');
    } finally {
      if (showBlockingLoad) setWorkspaceLoading(false);
    }
  }, [loadTree, showHiddenFiles]);
  _handleOpenFolder.current = handleOpenFolder;

  // Load children for a folder (used when web folder handle is set)
  const loadChildrenFromHandle = useCallback(async (path) => {
    if (!webFolderHandle) return [];
    const h = await getHandleForPath(webFolderHandle, path);
    return listDirFromHandle(h, path, showHiddenFiles);
  }, [webFolderHandle, showHiddenFiles]);

  // Render breadcrumbs
  const renderBreadcrumbs = () => {
    if (!activeFile) return null;
    const parts = activeFile.split('/');
    return (
      <div className="breadcrumbs">
        {parts.map((part, idx) => (
          <React.Fragment key={idx}>
            {idx > 0 && <span className="breadcrumb-separator">›</span>}
            <span className="breadcrumb-item">{part}</span>
          </React.Fragment>
        ))}
      </div>
    );
  };

  // Render welcome screen
  const renderWelcome = () => (
    <div className="editor-welcome">
      <div className="editor-welcome-logo">✦</div>
      <h2><span>Nebula</span> IDE</h2>
      <p className="editor-welcome-subtitle">
        {tree.length === 0
          ? 'Open a folder to get started'
          : 'Open a file to start editing, or press ⌘P to search'
        }
      </p>
      {tree.length === 0 && (
        <button
          className="explorer-open-folder-btn"
          style={{ marginBottom: 24 }}
          onClick={() => setShowOpenFolder(true)}
        >
          Open Folder
        </button>
      )}
      <div className="editor-welcome-shortcuts">
        {[
          ['⌘ O', 'Open Folder'],
          ['⌘ P', 'Quick Open'],
          ['⌘ ⇧ P', 'Commands'],
          ['⌘ `', 'Terminal'],
          ['⌘ B', 'Sidebar'],
          ['⌘ L', 'AI Chat'],
        ].map(([key, label]) => (
          <div className="editor-welcome-shortcut" key={label}>
            <kbd>{key}</kbd>
            <span>{label}</span>
          </div>
        ))}
      </div>
    </div>
  );

  // Render dropdown menu
  const renderMenu = (menuName) => {
    if (activeMenu !== menuName) return null;
    const items = MENU_ITEMS[menuName];
    if (!items) return null;

    return (
      <div className="menu-dropdown">
        {items.map((item, idx) => {
          if (item.type === 'separator') {
            return <div key={`sep-${idx}`} className="menu-separator" />;
          }
          return (
            <div
              key={item.id}
              className="menu-item"
              onClick={() => executeMenuCommand(item.id)}
            >
              <span className="menu-item-label">{item.label}</span>
              {item.shortcut && (
                <span className="menu-item-shortcut">{item.shortcut}</span>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  // Render about dialog
  const renderAboutDialog = () => {
    if (!showAbout) return null;
    return (
      <div className="command-palette-overlay" onClick={() => setShowAbout(false)}>
        <div className="about-dialog" onClick={e => e.stopPropagation()}>
          <div className="about-logo">✦</div>
          <h2>Nebula IDE</h2>
          <p className="about-version">Version {window.NEBULA_CONFIG?.appVersion || '1.0.0'}</p>
          <p className="about-desc">A modern, AI-powered code editor with a unique deep-space theme.</p>
          <div className="about-info">
            <div><strong>Frontend:</strong> React + Monaco Editor</div>
            <div><strong>Backend:</strong> FastAPI + Ollama</div>
            <div><strong>Theme:</strong> Nebula Dark</div>
          </div>
          <button className="about-close" onClick={() => setShowAbout(false)}>Close</button>
        </div>
      </div>
    );
  };

  // Detect platform for CSS adjustments and window controls
  const isMac     = navigator.platform?.toLowerCase().includes('mac');
  const isWindows = window.electronAPI?.isElectron && !isMac;
  const platformClass = isMac ? 'platform-darwin' : isWindows ? 'platform-win' : '';

  return (
    <AuthGate>
      <div className={`ide-container ${platformClass}`}>
      {workspaceLoading && (
        <div className="workspace-loading-overlay" aria-live="polite" aria-busy="true">
          <div className="workspace-loading-refresh" aria-hidden="true">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
              <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
              <path d="M16 21h5v-5" />
            </svg>
          </div>
          <div className="workspace-loading-spinner" />
          <div className="workspace-loading-text">
            {startupFolderName ? `Opening ${startupFolderName}…` : 'Loading project…'}
          </div>
          <div className="workspace-loading-sub">
            {startupFolderName
              ? `Setting up workspace for ${startupFolderName}`
              : 'Workspace and terminal will use the new folder.'}
          </div>
        </div>
      )}
      {/* ── Auto-update downloading banner ── */}
      {updateState === 'downloading' && (
        <div className="update-banner update-banner-downloading">
          <VscSync size={14} className="spin" style={{ flexShrink: 0 }} />
          <span>Downloading update… {updateProgress}%</span>
          <div className="update-progress-bar">
            <div className="update-progress-fill" style={{ width: `${updateProgress}%` }} />
          </div>
        </div>
      )}
      {/* Title Bar */}
      <div className="title-bar">
        <div className="title-bar-left">
          {/* Brand logo */}
          <div className="title-bar-brand">
            <span className="title-bar-brand-icon">
              <svg width="15" height="15" viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M7.5 0L8.9 5.6L14.5 7.5L8.9 9.4L7.5 15L6.1 9.4L0.5 7.5L6.1 5.6L7.5 0Z" fill="currentColor"/>
                <path d="M7.5 3L8.3 6.2L11.5 7.5L8.3 8.8L7.5 12L6.7 8.8L3.5 7.5L6.7 6.2L7.5 3Z" fill="rgba(255,255,255,0.25)"/>
              </svg>
            </span>
            <span className="title-bar-brand-name">Nebula</span>
          </div>
          {/* Menu items */}
          <div className="title-bar-menu" ref={menuRef}>
            {Object.keys(MENU_ITEMS).map(menuName => (
              <div key={menuName} className="menu-wrapper">
                <button
                  className={`menu-trigger ${activeMenu === menuName ? 'active' : ''}`}
                  onClick={() => setActiveMenu(prev => prev === menuName ? null : menuName)}
                  onMouseEnter={() => { if (activeMenu) setActiveMenu(menuName); }}
                >
                  {menuName}
                </button>
                {renderMenu(menuName)}
              </div>
            ))}
          </div>
        </div>
        <div className="title-bar-center">
          <div className="title-bar-search" style={{ position: 'relative' }}>
            <div className="title-bar-search-wrapper">
              <VscSearch size={14} className="title-bar-search-icon" />
              <input
                type="text"
                className="title-bar-search-input"
                placeholder={`Search files in ${projectName || 'project'}...`}
                value={searchQuery}
                onChange={handleSearchChange}
                onFocus={() => setSearchFocused(true)}
                onBlur={() => setTimeout(() => setSearchFocused(false), 200)}
                onKeyDown={handleSearchKeyDown}
              />
            </div>
            {searchFocused && searchResults.length > 0 && (
              <div className="title-bar-search-results">
                {searchResults.map((file, i) => (
                  <div
                    key={file}
                    className={`title-bar-search-item ${i === searchSelectedIndex ? 'selected' : ''}`}
                    onMouseDown={() => handleOpenSearchFile(file)}
                  >
                    <VscFile size={13} />
                    <span className="title-bar-search-item-name">{file}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="title-bar-right">
          <div className="layout-toggles">
            <button
              className={`layout-toggle-btn ${sidebarPanel ? 'active' : ''}`}
              title="Toggle Sidebar (⌘B)"
              onClick={() => setSidebarPanel(prev => prev ? null : 'explorer')}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <rect x="1" y="2" width="14" height="12" rx="1" stroke="currentColor" strokeWidth="1.2" />
                <line x1="5.5" y1="2" x2="5.5" y2="14" stroke="currentColor" strokeWidth="1.2" />
              </svg>
            </button>
            <button
              className={`layout-toggle-btn ${showTerminal ? 'active' : ''}`}
              title="Toggle Terminal (⌘`)"
              onClick={() => setShowTerminal(prev => !prev)}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <rect x="1" y="2" width="14" height="12" rx="1" stroke="currentColor" strokeWidth="1.2" />
                <line x1="1" y1="10" x2="15" y2="10" stroke="currentColor" strokeWidth="1.2" />
              </svg>
            </button>
            <button
              className={`layout-toggle-btn ${showRightPanel ? 'active' : ''}`}
              title="Toggle Right Panel"
              onClick={() => setShowRightPanel(prev => !prev)}
            >
              <VscTerminal size={16} />
            </button>
            <button
              className="layout-toggle-btn"
              title="Connect Mobile"
              onClick={() => setShowMobileCompanionPopup(prev => !prev)}
            >
              <VscDeviceMobile size={16} />
            </button>
          </div>
          {updateState === 'checking' && (
            <span className="title-bar-updated-label" style={{ opacity: 0.7 }}>
              Checking for updates…
            </span>
          )}
          {updateState === 'available-manual' && (
            <button
              className="title-bar-update-btn ready"
              onClick={() => window.electronAPI?.openExternal?.(updateDownloadUrl)}
              title={`Version ${updateVersion} available — click to open download page`}
            >
              <VscRefresh size={14} />
              <span>Update {updateVersion} available — Download</span>
            </button>
          )}
          {updateState === 'ready' && (
            <button
              className="title-bar-update-btn ready"
              onClick={() => window.electronAPI?.updates?.restartAndInstall?.()}
              title={`Update ${updateVersion} ready — click to restart and install`}
            >
              <VscRefresh size={14} />
              <span>Restart to Update {updateVersion && `(${updateVersion})`}</span>
            </button>
          )}
          {updateState === 'updated' && (
            <span className="title-bar-updated-label">Up to date</span>
          )}
          {updateState === 'error' && (
            <button
              className="title-bar-update-btn error"
              onClick={() => { window.electronAPI?.updates?.checkForUpdates?.(); setUpdateState('checking'); setUpdateError(''); setTimeout(() => setUpdateState(s => s === 'checking' ? null : s), 20000); }}
              title={updateError || 'Update check failed — click to retry'}
            >
              <VscRefresh size={14} />
              <span>Update Error — Retry</span>
            </button>
          )}
        </div>

        {/* Custom window controls — Windows only (no native frame) */}
        {isWindows && (
          <div className="win-controls">
            <button
              className="win-btn win-btn-min"
              title="Minimize"
              onClick={() => window.electronAPI?.minimizeWindow?.()}
            >
              <svg width="11" height="1" viewBox="0 0 11 1" fill="currentColor">
                <rect width="11" height="1" />
              </svg>
            </button>
            <button
              className="win-btn win-btn-max"
              title="Maximize / Restore"
              onClick={() => window.electronAPI?.maximizeWindow?.()}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
                <rect x="0.5" y="0.5" width="9" height="9" />
              </svg>
            </button>
            <button
              className="win-btn win-btn-close"
              title="Close"
              onClick={() => window.electronAPI?.closeWindow?.()}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round">
                <line x1="1" y1="1" x2="9" y2="9" />
                <line x1="9" y1="1" x2="1" y2="9" />
              </svg>
            </button>
          </div>
        )}
      </div>

      {/* Main Body */}
      <div className="ide-body">
        {/* Vertical Activity Bar — always visible (Cursor-style) */}
        <ActivityBar
          activePanel={sidebarPanel}
          onPanelChange={setSidebarPanel}
          extensionApps={extensionApps}
        />

        {sidebarPanel && (
          <>
          <div className="sidebar">
            {/* Panel Content */}
            {sidebarPanel === 'explorer' && (
              <FileExplorer
                tree={tree}
                treeLoading={treeLoading}
                openFile={openFile}
                selectedFile={activeFile}
                onRefresh={loadTree}
                onLoadChildren={webFolderHandle ? loadChildrenFromHandle : undefined}
                gitDecorations={gitDecorations}
                projectRoot={projectRoot}
                onOpenDiff={(p, against) => openFile(buildDiffTabKey(p, against || 'HEAD'))}
                showHiddenFiles={showHiddenFiles}
                onToggleShowHidden={() => {
                  setShowHiddenFiles(prev => {
                    const next = !prev;
                    try {
                      const s = localStorage.getItem('nebula_ide_settings');
                      const o = s ? JSON.parse(s) : {};
                      o.showHiddenFiles = next;
                      localStorage.setItem('nebula_ide_settings', JSON.stringify(o));
                    } catch (_) {}
                    return next;
                  });
                }}
                triggerNewFile={showNewFilePrompt}
                onNewFileDone={() => setShowNewFilePrompt(false)}
                onOpenFolder={() => setShowOpenFolder(true)}
              />
            )}
            {sidebarPanel === 'search' && (
              <SearchPanel onOpenFile={openFile} hasWorkspace={!!projectRoot || !!webFolderHandle} />
            )}
            {sidebarPanel === 'source-control' && (
              <SourceControlPanel
                onOpenFile={openFile}
                hasWorkspace={!!projectRoot || !!webFolderHandle}
              />
            )}
            {sidebarPanel === 'extensions' && (
              <ExtensionsPanel />
            )}
            {sidebarPanel?.startsWith('ext:') && (
              <ExtensionAppPanel
                extensionId={sidebarPanel.slice(4)}
                onClose={() => setSidebarPanel('explorer')}
              />
            )}
            {sidebarPanel === 'settings' && (
              <SettingsPanel onSettingsChange={handleSettingsChange} />
            )}
          </div>
          <div className="sidebar-resizer" onMouseDown={handleSidebarResizeStart} title="Drag to resize" />
          </>
        )}

        {/* Main Editor Area */}
        <div className="ide-main">
          <div className="ide-editor-area">
            {/* Editor Tabs */}
            <EditorTabs
              openFiles={openFiles}
              activeFile={activeFile}
              onSelectFile={setActiveFile}
              onCloseFile={closeFile}
              modifiedFiles={modifiedFiles}
              gitDecorations={gitDecorations}
            />

            {/* Editor */}
            <div className="editor-content">
              {activeFile && isDiffTabKey(activeFile) ? (
                (() => {
                  const parsed = parseDiffTabKey(activeFile);
                  return parsed ? (
                    <DiffTab
                      key={activeFile}
                      path={parsed.path}
                      against={parsed.against}
                      monacoTheme="nebula"
                      ideSettings={ideSettings}
                    />
                  ) : renderWelcome();
                })()
              ) : activeFile ? (
                <Editor
                  height="100%"
                  language={getLanguage(activeFile)}
                  value={fileContents[activeFile] || ''}
                  onChange={handleEditorChange}
                  onMount={handleEditorMount}
                  theme="nebula"
                  options={{
                    fontSize: ideSettings.fontSize || 14,
                    fontFamily: ideSettings.fontFamily
                      ? `'${ideSettings.fontFamily}', 'Fira Code', 'Cascadia Code', 'SF Mono', Menlo, Monaco, monospace`
                      : "'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'SF Mono', Menlo, Monaco, monospace",
                    fontLigatures: ideSettings.fontLigatures !== undefined ? ideSettings.fontLigatures : true,
                    lineHeight: 22,
                    minimap: { enabled: ideSettings.minimap !== undefined ? ideSettings.minimap : true, maxColumn: 80, renderCharacters: false },
                    scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
                    renderLineHighlight: 'line',
                    cursorBlinking: 'smooth',
                    cursorSmoothCaretAnimation: 'on',
                    smoothScrolling: true,
                    bracketPairColorization: { enabled: ideSettings.bracketPairColorization !== undefined ? ideSettings.bracketPairColorization : true },
                    guides: { bracketPairs: true, indentation: true },
                    padding: { top: 8 },
                    automaticLayout: true,
                    wordWrap: ideSettings.wordWrap ? 'on' : 'off',
                    tabSize: ideSettings.tabSize || 2,
                    lineNumbers: ideSettings.lineNumbers !== undefined ? (ideSettings.lineNumbers ? 'on' : 'off') : 'on',
                    formatOnPaste: true,
                    suggestOnTriggerCharacters: true,
                    quickSuggestions: true,
                    renderWhitespace: ideSettings.renderWhitespace || 'selection',
                    folding: true,
                    foldingHighlight: true,
                    showFoldingControls: 'mouseover',
                    matchBrackets: 'always',
                    occurrencesHighlight: 'singleFile',
                    selectionHighlight: true,
                    contextmenu: true,
                    mouseWheelZoom: true,
                  }}
                />
              ) : (
                renderWelcome()
              )}
            </div>

            {/* Terminal Panel */}
            {showTerminal && (
              <div className="bottom-panel-container" style={{ height: terminalHeight }}>
                <div className="panel-resizer" onMouseDown={handlePanelResizeStart} />
                <TerminalPanel
                  key={workspaceKey}
                  visible={showTerminal}
                  onClose={() => setShowTerminal(false)}
                  onResize={terminalHeight}
                  projectRoot={projectRoot}
                />
              </div>
            )}
          </div>

        </div>
        
        {/* Right Panel */}
        {showRightPanel && (
          <>
            <div
              className="sidebar-resizer"
              style={{ cursor: 'ew-resize', width: '4px', background: 'transparent' }}
              onMouseDown={handleRightPanelResizeStart}
              title="Drag to resize"
            />
            <div className="sidebar-right" style={{ width: `${rightPanelWidth}px` }}>
              <CliPanel visible={showRightPanel} projectRoot={projectRoot} />
            </div>
          </>
        )}
      </div>

      {/* Status Bar */}
      <StatusBar
        activeFile={activeFile}
        cursorPosition={cursorPosition}
        hasWorkspace={!!projectRoot || !!webFolderHandle}
        updateState={updateState}
        updateError={updateError}
      />

      {/* Command Palette */}
      <CommandPalette
        visible={showCommandPalette}
        onClose={() => setShowCommandPalette(false)}
        onExecuteCommand={handleCommand}
        openFiles={openFiles}
      />

      {/* About Dialog */}
      {renderAboutDialog()}

      {/* Open Folder Dialog */}
      <OpenFolderDialog
        visible={showOpenFolder}
        onClose={() => setShowOpenFolder(false)}
        onOpen={handleOpenFolder}
        showHiddenFiles={showHiddenFiles}
      />

      {/* Mobile Companion popup (title bar icon) */}
      {showMobileCompanionPopup && (
        <MobileCompanionPopup onClose={() => setShowMobileCompanionPopup(false)} />
      )}

      {/* Unsaved changes dialog */}
      {unsavedDialog && (
        <div className="command-palette-overlay" onClick={unsavedDialog.onCancel}>
          <div
            className="about-dialog"
            style={{ maxWidth: 420, padding: '28px 32px' }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ fontSize: 28, marginBottom: 12 }}>⚠️</div>
            <h2 style={{ marginBottom: 8, fontSize: 16 }}>Unsaved Changes</h2>
            <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 24 }}>
              Do you want to save the changes you made to{' '}
              <strong style={{ color: 'var(--text)' }}>
                {unsavedDialog.file.split('/').pop()}
              </strong>
              ?<br />
              <span style={{ fontSize: 11, opacity: 0.6 }}>Your changes will be lost if you don't save them.</span>
            </p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button
                className="about-close"
                style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-muted)', minWidth: 80 }}
                onClick={unsavedDialog.onCancel}
              >
                Cancel
              </button>
              <button
                className="about-close"
                style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--text)', minWidth: 80 }}
                onClick={unsavedDialog.onDiscard}
              >
                Don't Save
              </button>
              <button
                className="about-close"
                style={{ background: 'var(--accent)', border: 'none', color: '#fff', minWidth: 80 }}
                onClick={unsavedDialog.onSave}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
      </div>
    </AuthGate>
  );
}

export default App;

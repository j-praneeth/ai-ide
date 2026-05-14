import React, { useEffect, useState, useCallback, useRef } from 'react';
import Editor from '@monaco-editor/react';
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
import UsagePanel from './components/UsagePanel';
import ChatPanel from './components/ChatPanel';
import EditorTabs from './components/EditorTabs';
import TerminalPanel from './components/TerminalPanel';
import StatusBar from './components/StatusBar';
import CommandPalette from './components/CommandPalette';
import OpenFolderDialog from './components/OpenFolderDialog';
import MobileCompanionPopup from './components/MobileCompanionPopup';
import CliPanel from './components/CliPanel';
import AuthGate from './components/AuthGate';
import { VscDeviceMobile, VscTerminal, VscSync, VscRefresh } from 'react-icons/vsc';
import { listDirFromHandle, getHandleForPath, getFileContentFromHandle, writeFileToHandle } from './lib/webFs';
import { authFetch, getAuthUser } from './lib/auth';
import { Throttler, SequencerByKey } from './lib/async';
import { buildMatchRegex, firstMatchColumnsInLine } from './lib/searchMatch';
import { extensionRegistry } from './lib/extensionRegistry';

// Default HTTP timeout for axios (ms). Git / terminal / large trees can exceed a few seconds;
// keep this generous so Source Control and search fallbacks do not spuriously time out.
axios.defaults.timeout = 120000;

// Module-level singletons — mirrors VS Code's service-level Throttler instances.
// Throttler: at most 1 in-flight tree load + 1 pending (new requests replace old pending)
const _treeLoadThrottler = new Throttler();
// SequencerByKey: file saves are serialised per path — prevents out-of-order writes
const _fileSaveSequencer = new SequencerByKey();

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
  const [projectName, setProjectName] = useState('Nebula');
  const [projectRoot, setProjectRoot] = useState('');
  const [webFolderHandle, setWebFolderHandle] = useState(null);
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
  const workspaceCtxRef = useRef({ projectRoot: '', webFolderHandle: null });
  const [sidebarWidth, setSidebarWidth] = useState(270);
  const sidebarResizingRef = useRef(false);
  const rightPanelResizingRef = useRef(false);
  const [ideSettings, setIdeSettings] = useState(() => {
    // Load saved settings on mount
    try {
      const raw = localStorage.getItem('nebula_ide_settings');
      if (raw) return JSON.parse(raw);
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

  // ── Sync sidebar extension apps from registry ────────────────
  useEffect(() => {
    const handler = () => setExtensionApps(extensionRegistry.getSidebarApps());
    extensionRegistry.addEventListener('change', handler);
    return () => extensionRegistry.removeEventListener('change', handler);
  }, []);

  // ── Auto-update IPC listeners (Electron only) ────────────────
  const [updateError, setUpdateError] = useState('');
  useEffect(() => {
    const api = window.electronAPI?.updates;
    if (!api) return;
    const unsubs = [
      api.onChecking?.(() => { setUpdateState('checking'); setUpdateError(''); }),
      api.onAvailable?.((info) => { setUpdateState('available'); setUpdateVersion(info?.version || ''); }),
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
  useEffect(() => {
    let active = true;
    let retryTimer = null;
    let attempts = 0;
    const MAX_ATTEMPTS = 30; // ~30s total with backoff
    const cleanupFns = [];

    // Detect if this window was spawned to open a specific folder (show loading until ready).
    if (window.electronAPI?.getStartupFolder) {
      window.electronAPI.getStartupFolder().then(startupPath => {
        if (startupPath) {
          const name = startupPath.split(/[\\/]/).filter(Boolean).pop() || startupPath;
          setStartupFolderName(name);
        } else {
          // Not a folder-open window — hide loading immediately.
          setWorkspaceLoading(false);
        }
      }).catch(() => setWorkspaceLoading(false));
    }

    const loadWorkspace = () => {
      loadTree().catch(() => {}); // error already logged inside loadTree
      axios.get(`${API}/files/workspace`).then(res => {
        if (res.data.name) setProjectName(res.data.name);
        if (res.data.path) setProjectRoot(res.data.path);
        setWorkspaceLoading(false);
      }).catch(() => {});
    };

    const tryLoad = () => {
      if (!active) return;
      loadTree().then(() => {
        // Success — also load workspace info
        axios.get(`${API}/files/workspace`).then(res => {
          if (!active) return;
          if (res.data.name) setProjectName(res.data.name);
          if (res.data.path) setProjectRoot(res.data.path);
          setWorkspaceLoading(false);
        }).catch(() => { setWorkspaceLoading(false); });
      }).catch(() => {
        // Failed — retry with exponential backoff (200ms, 400ms, 800ms, ... up to ~3s)
        if (!active) return;
        attempts++;
        if (attempts >= MAX_ATTEMPTS) {
          console.warn('[App] Backend not reachable after 30 retries. Check that the backend is running.');
          return;
        }
        const delay = Math.min(200 * Math.pow(1.5, attempts), 3000);
        retryTimer = setTimeout(tryLoad, delay);
      });
    };

    tryLoad();

    // Also register for backend:ready event as an optimization (faster recovery).
    const elAPI = window.electronAPI;
    if (elAPI?.onBackendReady) {
      const cleanup = elAPI.onBackendReady(() => {
        if (!active) return;
        attempts = 0;
        if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
        loadWorkspace();
      });
      cleanupFns.push(cleanup);
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
              await axios.post(`${API}/files/write`, null, {
                params: { path, content: fileContents[path] },
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
  // / SequencerByKey used for atomic file writes.
  const saveFile = useCallback(async () => {
    if (!activeFile || !fileContents[activeFile]) return;
    const path    = activeFile;
    const content = fileContents[activeFile];
    try {
      await _fileSaveSequencer.queueFor(path, async () => {
        if (webFolderHandle) {
          await writeFileToHandle(webFolderHandle, path, content);
        } else {
          await axios.post(`${API}/files/write`, null, {
            params: { path, content },
          });
        }
      });
      setOriginalContents(prev => ({ ...prev, [path]: content }));
      setModifiedFiles(prev => { const next = new Set(prev); next.delete(path); return next; });
    } catch (err) {
      console.error('Failed to save file:', err);
    }
  }, [activeFile, fileContents, webFolderHandle]);

  // Save all files
  const saveAllFiles = useCallback(async () => {
    const promises = [...modifiedFiles].map(async (path) => {
      if (fileContents[path]) {
        try {
          if (webFolderHandle) {
            await writeFileToHandle(webFolderHandle, path, fileContents[path]);
          } else {
            await axios.post(`${API}/files/write`, null, {
              params: { path, content: fileContents[path] }
            });
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
  }, [activeFile, originalContents]);

  // Handle editor mount
  const handleEditorMount = useCallback((editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;

    // Configure Monaco theme — Nebula
    monaco.editor.defineTheme('nebula', {
      base: 'vs-dark',
      inherit: true,
      rules: [
        { token: 'comment', foreground: '4a6a53', fontStyle: 'italic' },
        { token: 'keyword', foreground: 'c792ea' },
        { token: 'string', foreground: 'ecc48d' },
        { token: 'number', foreground: 'f78c6c' },
        { token: 'type', foreground: 'ffcb6b' },
        { token: 'function', foreground: '82aaff' },
        { token: 'variable', foreground: 'a9c0d6' },
        { token: 'constant', foreground: '89ddff' },
        { token: 'regexp', foreground: '89ddff' },
        { token: 'operator', foreground: '89ddff' },
        { token: 'tag', foreground: 'f07178' },
        { token: 'attribute', foreground: 'c792ea' },
        { token: 'delimiter', foreground: '7a8ba3' },
      ],
      colors: {
        'editor.background': '#0d1117',
        'editor.foreground': '#c9d1d9',
        'editor.lineHighlightBackground': '#131a2705',
        'editor.lineHighlightBorder': '#182032',
        'editor.selectionBackground': '#253551',
        'editor.inactiveSelectionBackground': '#1e2a3f',
        'editorLineNumber.foreground': '#2d3a4e',
        'editorLineNumber.activeForeground': '#7a8ba3',
        'editorCursor.foreground': '#f59e0b',
        'editorCursor.background': '#000000',
        'editor.selectionHighlightBackground': '#f59e0b12',
        'editorBracketMatch.background': '#f59e0b15',
        'editorBracketMatch.border': '#f59e0b40',
        'editorIndentGuide.background1': '#1e2a3f',
        'editorIndentGuide.activeBackground1': '#253551',
        'editorWhitespace.foreground': '#1e2a3f',
        'editorOverviewRuler.border': '#0d1117',
        'scrollbar.shadow': '#00000000',
        'scrollbarSlider.background': '#ffffff0d',
        'scrollbarSlider.hoverBackground': '#ffffff1a',
        'scrollbarSlider.activeBackground': '#ffffff26',
        'minimap.background': '#0d1117',
        'editorWidget.background': '#131a27',
        'editorWidget.border': '#1e2a3f',
        'editorSuggestWidget.background': '#131a27',
        'editorSuggestWidget.border': '#1e2a3f',
        'editorSuggestWidget.selectedBackground': '#253551',
        'input.background': '#0d1117',
        'input.border': '#1e2a3f',
        'focusBorder': '#f59e0b60',
      }
    });
    monaco.editor.setTheme('nebula');

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
      setRightPanelWidth(Math.max(260, Math.min(560, startW + delta)));
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

    // In Electron: if a workspace is already open, spawn the new folder in a fresh window
    // and show a loading screen — then close this window. This matches VS Code's behavior.
    if (hadWorkspace && openingSomething && folderPath && window.electronAPI?.openFolderInNewWindow) {
      setWorkspaceLoading(true);
      try {
        await window.electronAPI.openFolderInNewWindow(folderPath);
      } catch (_) {
        setWorkspaceLoading(false);
      }
      // Window will be closed by the main process after the new one starts.
      return;
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

  // Detect platform for CSS adjustments (macOS traffic lights etc.)
  const platformClass = navigator.platform?.toLowerCase().includes('mac') ? 'platform-darwin' : '';

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
          <span className="title-bar-project">{projectName}</span>
          {activeFile && (
            <>
              <span className="title-bar-separator">—</span>
              <span className="title-bar-file">
                {activeFile.split('/').pop()}
                {modifiedFiles.has(activeFile) && ' ●'}
              </span>
            </>
          )}
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
          {updateState === 'ready' && (
            <button
              className="title-bar-update-btn ready"
              onClick={() => window.electronAPI?.updates?.restartAndInstall?.()}
              title={`Update ${updateVersion} ready — click to restart and install`}
            >
              <VscRefresh size={14} />
              <span>Restart to Update</span>
            </button>
          )}
          {updateState === 'updated' && (
            <span className="title-bar-updated-label">Updated</span>
          )}
          {updateState === 'error' && (
            <button
              className="title-bar-update-btn error"
              onClick={() => { window.electronAPI?.updates?.checkForUpdates?.(); setUpdateState('checking'); setUpdateError(''); }}
              title={updateError || 'Update check failed — click to retry'}
            >
              <VscRefresh size={14} />
              <span>Update Error</span>
            </button>
          )}
        </div>
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
            {sidebarPanel === 'usage' && (
              <UsagePanel />
            )}
            {sidebarPanel === 'chat' && (
              <ChatPanel
                visible={true}
                onClose={() => setSidebarPanel('explorer')}
                currentFile={activeFile}
                currentContent={activeFile ? (fileContents[activeFile] || '') : ''}
              />
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
            />

            {/* Breadcrumbs */}
            {activeFile && renderBreadcrumbs()}

            {/* Editor */}
            <div className="editor-content">
              {activeFile ? (
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
            <div className="sidebar" style={{ borderLeft: '1px solid var(--border)', borderRight: 'none', width: `${rightPanelWidth}px` }}>
              <CliPanel visible={showRightPanel} />
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

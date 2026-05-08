import React, { useEffect, useState, useCallback, useRef } from 'react';
import Editor from '@monaco-editor/react';
import axios from 'axios';
import './App.css';
import { API_URL as API } from './config';

// Components
import ActivityBar from './components/ActivityBar';
import FileExplorer from './components/FileExplorer';
import SearchPanel from './components/SearchPanel';
import SourceControlPanel from './components/SourceControlPanel';
import ExtensionsPanel from './components/ExtensionsPanel';
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
import { VscDeviceMobile, VscTerminal } from 'react-icons/vsc';
import { listDirFromHandle, getHandleForPath, getFileContentFromHandle, writeFileToHandle } from './lib/webFs';
import { authFetch, getAuthUser } from './lib/auth';

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
  const [terminalHeight, setTerminalHeight] = useState(250);
  const [cursorPosition, setCursorPosition] = useState({ line: 1, column: 1 });
  const [activeMenu, setActiveMenu] = useState(null);
  const [showAbout, setShowAbout] = useState(false);
  const [showNewFilePrompt, setShowNewFilePrompt] = useState(false);
  const [showOpenFolder, setShowOpenFolder] = useState(false);
  const [projectName, setProjectName] = useState('Nebula');
  const [webFolderHandle, setWebFolderHandle] = useState(null);
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

  // Load file tree (optionally include hidden files); from backend or from web folder handle
  const loadTree = useCallback(async () => {
    setTreeLoading(true);
    try {
      if (webFolderHandle) {
        const nodes = await listDirFromHandle(webFolderHandle, '', showHiddenFiles);
        setTree(nodes);
      } else {
        const res = await axios.get(`${API}/files/tree`, { params: { show_hidden: showHiddenFiles } });
        setTree(res.data);
      }
    } catch (err) {
      console.error('Failed to load file tree:', err);
    } finally {
      setTreeLoading(false);
    }
  }, [showHiddenFiles, webFolderHandle]);

  // Load workspace info and file tree on startup
  useEffect(() => {
    loadTree();
    // Fetch workspace name so the title bar shows the real project name
    axios.get(`${API}/files/workspace`).then(res => {
      if (res.data.name) {
        setProjectName(res.data.name);
      }
    }).catch(() => {});
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
  // Open a file (from backend or from web folder handle)
  const openFile = useCallback(async (path) => {
    if (openFiles.includes(path)) {
      setActiveFile(path);
      return;
    }
    try {
      let content;
      if (webFolderHandle) {
        content = await getFileContentFromHandle(webFolderHandle, path);
      } else {
        const res = await axios.get(`${API}/files/read`, { params: { path } });
        content = res.data.content;
      }
      setFileContents(prev => ({ ...prev, [path]: content }));
      setOriginalContents(prev => ({ ...prev, [path]: content }));
      setOpenFiles(prev => [...prev, path]);
      setActiveFile(path);
    } catch (err) {
      console.error('Failed to open file:', err);
    }
  }, [openFiles, webFolderHandle]);

  // Close a file
  const closeFile = useCallback((path) => {
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

  // Close all tabs
  const closeAllTabs = useCallback(() => {
    setOpenFiles([]);
    setActiveFile(null);
    setFileContents({});
    setOriginalContents({});
    setModifiedFiles(new Set());
  }, []);

  // Save the current file (to backend or to web folder handle)
  const saveFile = useCallback(async () => {
    if (!activeFile || !fileContents[activeFile]) return;
    try {
      if (webFolderHandle) {
        await writeFileToHandle(webFolderHandle, activeFile, fileContents[activeFile]);
      } else {
        await axios.post(`${API}/files/write`, null, {
          params: { path: activeFile, content: fileContents[activeFile] }
        });
      }
      setOriginalContents(prev => ({ ...prev, [activeFile]: fileContents[activeFile] }));
      setModifiedFiles(prev => { const next = new Set(prev); next.delete(activeFile); return next; });
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
  const handleOpenFolder = useCallback((folderPath, folderName, handle = null) => {
    setOpenFiles([]);
    setActiveFile(null);
    setFileContents({});
    setOriginalContents({});
    setModifiedFiles(new Set());
    setProjectName(folderName || 'Nebula');
    setWebFolderHandle(handle || null);
    if (handle) {
      listDirFromHandle(handle, '', showHiddenFiles).then(setTree).catch(console.error);
    } else {
      loadTree();
    }
    setSidebarPanel('explorer');
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
          <p className="about-version">Version 1.0.0</p>
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
        </div>
      </div>

      {/* Main Body */}
      <div className="ide-body">
        {/* Vertical Activity Bar — always visible (Cursor-style) */}
        <ActivityBar
          activePanel={sidebarPanel}
          onPanelChange={setSidebarPanel}
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
              <SearchPanel onOpenFile={openFile} />
            )}
            {sidebarPanel === 'source-control' && (
              <SourceControlPanel onOpenFile={openFile} />
            )}
            {sidebarPanel === 'extensions' && (
              <ExtensionsPanel />
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
                  visible={showTerminal}
                  onClose={() => setShowTerminal(false)}
                  onResize={terminalHeight}
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
      />

      {/* Mobile Companion popup (title bar icon) */}
      {showMobileCompanionPopup && (
        <MobileCompanionPopup onClose={() => setShowMobileCompanionPopup(false)} />
      )}
      </div>
    </AuthGate>
  );
}

export default App;

/**
 * TerminalPanel — VS Code-identical terminal architecture.
 *
 * Mirrors:
 *   src/vs/workbench/contrib/terminal/browser/xterm/xtermTerminal.ts
 *   src/vs/workbench/contrib/terminal/browser/terminalProcessManager.ts
 *
 * Critical performance fixes vs the old implementation:
 *
 *  1. ZERO-LATENCY INPUT  — onData sends immediately with NO setTimeout.
 *     The old 20ms batch was the single biggest source of typing lag.
 *     VS Code dispatches input synchronously on every onData event.
 *
 *  2. NO RAF DOUBLE-BUFFER — term.write() is called directly in onmessage.
 *     xterm.js 6.x has its own internal write-queue that coalesces writes
 *     and renders at 60 fps via its own scheduler.  Adding an extra rAF
 *     layer added ~16ms latency with no throughput benefit.
 *
 *  3. WEBGL RENDERER — GPU-accelerated canvas (same as VS Code default).
 *     Falls back to the DOM canvas renderer if WebGL context is unavailable.
 *     WebGL renders large outputs 5-10× faster than the CPU canvas path.
 *
 *  4. UNICODE11 ADDON — proper wide-character and emoji column widths.
 *     Without this, CJK characters misalign the cursor.
 *
 *  5. WEBLINKS ADDON — clickable URLs (VS Code ships this by default).
 *
 *  6. VS CODE XTERM OPTIONS — logLevel:'off', minimumContrastRatio:1,
 *     fastScrollModifier, altClickMovesCursor, letterSpacing:0, etc.
 *     minimumContrastRatio:1 alone skips a per-cell contrast calculation
 *     that VS Code disables for performance.
 *
 *  7. BINARY WEBSOCKET — output received as ArrayBuffer (Uint8Array),
 *     avoiding a UTF-8 string allocation per frame on the JS heap.
 *     Input remains JSON for control messages (resize) and raw text.
 *
 *  8. RESIZE DEBOUNCE 50ms — VS Code uses a short debounce so resizing
 *     the panel doesn't thrash the PTY with SIGWINCH.
 */

import React, { useEffect, useRef, useCallback, useState } from 'react';
import { Terminal }       from '@xterm/xterm';
import { FitAddon }       from '@xterm/addon-fit';
import { WebglAddon }     from '@xterm/addon-webgl';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon }  from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import {
  VscAdd, VscTrash, VscSplitHorizontal, VscClose, VscEllipsis,
  VscChevronUp, VscChevronDown,
} from 'react-icons/vsc';
import { API_URL as API } from '../config';

// ─── VS Code terminal color theme (matches VS Code Dark+) ────────────────────
const TERM_THEME = {
  background:          '#1E1E1E',
  foreground:          '#D4D4D4',
  cursor:              '#AEAFAD',
  cursorAccent:        '#1E1E1E',
  selectionBackground: 'rgba(55,148,255,0.25)',
  black:               '#1E1E1E', brightBlack:   '#666666',
  red:                 '#CD3131', brightRed:     '#F14C4C',
  green:               '#0DBC79', brightGreen:   '#23D18B',
  yellow:              '#E5E510', brightYellow:  '#F5F543',
  blue:                '#2472C8', brightBlue:    '#3B8EEA',
  magenta:             '#BC3FBC', brightMagenta: '#D670D6',
  cyan:                '#11A8CD', brightCyan:    '#29B8DB',
  white:               '#E5E5E5', brightWhite:   '#E5E5E5',
};

// ─── VS Code xterm.js options ─────────────────────────────────────────────────
// Source: src/vs/workbench/contrib/terminal/browser/xterm/xtermTerminal.ts
const TERM_OPTIONS = {
  allowProposedApi:          true,         // required for WebGL addon
  theme:                     TERM_THEME,
  fontFamily:                "'Cascadia Code', 'JetBrains Mono', 'Fira Code', Consolas, monospace",
  fontSize:                  13,
  lineHeight:                1.2,          // VS Code default (was 1.4 — heavy)
  letterSpacing:             0,            // VS Code default
  cursorBlink:               true,
  cursorStyle:               'bar',
  scrollback:                1000,         // VS Code default (was 5000 — uses heap)
  tabStopWidth:              8,            // VS Code default
  logLevel:                  'off',        // eliminates internal xterm logging overhead
  minimumContrastRatio:      1,            // disables per-cell contrast calc (VS Code perf)
  fastScrollModifier:        'alt',        // VS Code: Alt+scroll = fast scroll
  fastScrollSensitivity:     5,
  drawBoldTextInBrightColors: true,        // VS Code default
  rightClickSelectsWord:     true,         // VS Code: right-click selects word
  altClickMovesCursor:       true,         // VS Code default
  allowTransparency:         false,        // false = faster compositing
  macOptionIsMeta:           false,        // can be toggled per user pref
  wordSeparators:            ' ()[]{}\',"`─',
};

// ─── initTerminal ─────────────────────────────────────────────────────────────
// Web: xterm + WebSocket → FastAPI PTY.  Electron: xterm + IPC → node-pty in main
// (same architecture as the right-side CLI panel — avoids Python/WS round-trip).

function initTerminal(container, sessionId, shell, projectRoot) {
  const term = new Terminal(TERM_OPTIONS);
  const fit  = new FitAddon();
  term.loadAddon(fit);

  // Unicode11 — wide characters and emoji (VS Code ships this by default)
  try {
    const uni11 = new Unicode11Addon();
    term.loadAddon(uni11);
    term.unicode.activeVersion = '11';
  } catch (_) {}

  // WebLinks — clickable URLs (VS Code ships this by default)
  try {
    term.loadAddon(new WebLinksAddon());
  } catch (_) {}

  // Attach to DOM — canvas renderer starts immediately so the terminal is visible
  term.open(container);

  // Initial fit before WebGL init so user sees the prompt right away
  try { fit.fit(); } catch (_) {}

  // WebGL renderer — deferred so the canvas renderer paints first (no blank frame).
  let webglAddon = null;
  setTimeout(() => {
    try {
      webglAddon = new WebglAddon();
      webglAddon.onContextLost(() => {
        try { webglAddon.dispose(); } catch (_) {}
        webglAddon = null;
      });
      term.loadAddon(webglAddon);
    } catch (_) {
      webglAddon = null;
    }
  }, 0);

  let ws = null;
  let disposed = false;
  let resizeTimer = null;
  const isWin = navigator.platform?.startsWith('Win') || navigator.userAgent?.includes('Windows');
  const useElectronNative = typeof window !== 'undefined' && window.electronAPI?.startIntegratedTerminal;

  const wireResizeWs = () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    }
  };

  const attachInputShortcuts = (sendText) => {
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      if (e.ctrlKey && e.shiftKey && e.code === 'KeyC') {
        const sel = term.getSelection();
        if (sel) navigator.clipboard.writeText(sel).catch(() => {});
        return false;
      }
      if (e.ctrlKey && e.shiftKey && e.code === 'KeyV') {
        navigator.clipboard.readText().then(text => { sendText(text); }).catch(() => {});
        return false;
      }
      if (e.ctrlKey && e.shiftKey && e.code === 'KeyK') {
        term.clear();
        return false;
      }
      return true;
    });
    const onCtx = (e) => {
      e.preventDefault();
      const sel = term.getSelection();
      if (sel) {
        navigator.clipboard.writeText(sel).catch(() => {});
      } else {
        navigator.clipboard.readText().then(text => { sendText(text); }).catch(() => {});
      }
    };
    container.addEventListener('contextmenu', onCtx);
    return () => container.removeEventListener('contextmenu', onCtx);
  };

  // ── Electron: node-pty in main (low-latency — no WebSocket → Python hop) ──
  if (useElectronNative) {
    let nativeUnsub = null;
    let nativeExitUnsub = null;
    let nativeReady = false;
    const pending = [];

    const flushPending = () => {
      if (!nativeReady || disposed) return;
      while (pending.length) {
        const d = pending.shift();
        try { window.electronAPI.writeIntegratedTerminal(sessionId, d); } catch (_) {}
      }
    };

    const sendText = (data) => {
      if (disposed || data == null) return;
      if (!nativeReady) {
        pending.push(typeof data === 'string' ? data : String(data));
        return;
      }
      try { window.electronAPI.writeIntegratedTerminal(sessionId, data); } catch (_) {}
    };

    const removeCtx = attachInputShortcuts(sendText);

    term.onData(sendText);

    window.electronAPI.startIntegratedTerminal({
      sessionId,
      shell: shell || (isWin ? 'powershell' : 'zsh'),
      cols: term.cols,
      rows: term.rows,
      cwd: projectRoot && String(projectRoot).trim() ? String(projectRoot).trim() : null,
    }).then((res) => {
      if (disposed) return;
      if (!res?.ok) {
        term.writeln(`\r\n\x1b[31mTerminal: ${res?.error || 'failed to start shell'}\x1b[0m`);
        return;
      }
      nativeReady = true;
      flushPending();
      try { fit.fit(); } catch (_) {}
      try { window.electronAPI.resizeIntegratedTerminal(sessionId, term.cols, term.rows); } catch (_) {}
      nativeUnsub = window.electronAPI.onIntegratedTermData(({ sessionId: sid, data }) => {
        if (disposed || sid !== sessionId) return;
        term.write(data);
      });
      if (window.electronAPI.onIntegratedTermExit) {
        nativeExitUnsub = window.electronAPI.onIntegratedTermExit(({ sessionId: sid }) => {
          if (disposed || sid !== sessionId) return;
          term.writeln('\r\n\x1b[33m[Shell exited]\x1b[0m');
        });
      }
    }).catch((err) => {
      if (!disposed) term.writeln(`\r\n\x1b[31m${err?.message || String(err)}\x1b[0m`);
    });

    ws = {
      get readyState() {
        return nativeReady ? WebSocket.OPEN : WebSocket.CONNECTING;
      },
      send(msg) {
        try {
          const o = JSON.parse(msg);
          if (o.type === 'input') sendText(o.data);
          else if (o.type === 'resize') {
            window.electronAPI.resizeIntegratedTerminal(sessionId, o.cols, o.rows);
          }
        } catch (_) {}
      },
      close() {},
    };

    const fitAndResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        try { fit.fit(); } catch (_) {}
        if (nativeReady && !disposed) {
          try { window.electronAPI.resizeIntegratedTerminal(sessionId, term.cols, term.rows); } catch (_) {}
        }
      }, 50);
    };

    const destroyWs = () => {
      disposed = true;
      clearTimeout(resizeTimer);
      try { removeCtx(); } catch (_) {}
      try { nativeUnsub?.(); } catch (_) {}
      try { nativeExitUnsub?.(); } catch (_) {}
      try { window.electronAPI?.killIntegratedTerminal?.(sessionId); } catch (_) {}
    };

    return {
      term,
      fitAddon: fit,
      get ws() { return ws; },
      fitAndResize,
      destroyWs,
    };
  }

  // ── Web / backend PTY via WebSocket ───────────────────────────────────────
  let retries = 0;
  const MAX_RETRIES = 30;

  const wsBase = API.replace(/^http/, 'ws');
  const wsUrl  = `${wsBase}/terminal/ws/pty/${sessionId}`
    + `?shell=${encodeURIComponent(shell || 'powershell')}`
    + `&cols=${term.cols}&rows=${term.rows}`
    + (projectRoot ? `&cwd=${encodeURIComponent(projectRoot)}` : '');

  const sendWsInput = (data) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'input', data }));
    }
  };

  const removeCtx = attachInputShortcuts(sendWsInput);

  term.onData(sendWsInput);

  function connect() {
    if (disposed) return;
    ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      retries = 0;
      try { fit.fit(); } catch (_) {}
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    };

    ws.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) {
        term.write(new Uint8Array(e.data));
      } else {
        term.write(e.data);
      }
    };

    ws.onerror = () => { /* handled by onclose */ };

    ws.onclose = () => {
      if (disposed) return;
      if (retries < MAX_RETRIES) {
        retries++;
        setTimeout(connect, Math.min(1500 * retries, 10000));
      } else {
        term.writeln('\r\n\x1b[31mCould not connect to terminal backend.\x1b[0m');
        term.writeln('\x1b[2mRestart the backend, then reopen this terminal.\x1b[0m');
      }
    };
  }

  connect();

  const fitAndResize = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      try { fit.fit(); } catch (_) {}
      wireResizeWs();
    }, 50);
  };

  const destroyWs = () => {
    disposed = true;
    clearTimeout(resizeTimer);
    try { removeCtx(); } catch (_) {}
    if (ws) { ws.onclose = null; ws.close(); }
  };

  return {
    term,
    fitAddon: fit,
    get ws() { return ws; },
    fitAndResize,
    destroyWs,
  };
}

// ─── TerminalPanel ────────────────────────────────────────────────────────────
export default function TerminalPanel({ visible, onClose, onResize, projectRoot }) {
  const isWindows       = navigator.platform?.startsWith('Win') || navigator.userAgent?.includes('Windows');
  const shellName       = isWindows ? 'powershell' : 'zsh';
  const shellDisplayName = isWindows ? 'pwsh' : 'zsh';

  const [terminals,    setTerminals]    = useState([{ id: 1, name: shellDisplayName, shell: shellName }]);
  const [activeTermId, setActiveTermId] = useState(1);
  const [viewTab,      setViewTab]      = useState('terminals');
  const [splitMode,    setSplitMode]    = useState(false);
  const [problems]   = useState([]);
  const [outputLogs] = useState([]);
  const [showShellMenu,    setShowShellMenu]    = useState(false);
  const [shellMenuPos,     setShellMenuPos]     = useState({ top: 0, left: 0 });
  const chevronBtnRef = useRef(null);

  const nextId     = useRef(2);
  const instances  = useRef(new Map());   // id → { term, fitAddon, ws, fitAndResize, destroyWs }
  const containers = useRef(new Map());   // id → DOM element
  const roMap      = useRef(new Map());   // id → ResizeObserver

  // ── Mount a terminal into a DOM node ───────────────────────────────────────
  const attachRef = useCallback((id, el) => {
    if (!el) return;
    containers.current.set(id, el);
    if (instances.current.has(id)) return;

    const terminal  = terminals.find(t => t.id === id);
    const sessionId = `pty-${id}-${Date.now()}`;
    const inst      = initTerminal(el, sessionId, terminal?.shell, projectRoot);
    instances.current.set(id, inst);

    // Double-rAF ensures the DOM has painted before fitting
    requestAnimationFrame(() => {
      requestAnimationFrame(() => { try { inst.fitAndResize(); } catch (_) {} });
    });

    // ResizeObserver with 50ms debounce (VS Code's resize debounce period)
    const ro = new ResizeObserver(() => { try { inst.fitAndResize(); } catch (_) {} });
    ro.observe(el);
    roMap.current.set(id, ro);
  }, [terminals, projectRoot]); // eslint-disable-line

  // Clean up ResizeObservers for closed terminals
  useEffect(() => {
    const ids = new Set(terminals.map(t => t.id));
    roMap.current.forEach((ro, id) => {
      if (!ids.has(id)) { ro.disconnect(); roMap.current.delete(id); }
    });
  }, [terminals]);

  // Navigate all live terminals to the new workspace root
  useEffect(() => {
    if (!projectRoot) return;
    const cdCmd = isWindows
      ? `Set-Location -LiteralPath '${projectRoot.replace(/'/g, "''")}'\r`
      : `cd "${projectRoot.replace(/"/g, '\\"')}"\r`;
    instances.current.forEach((inst) => {
      try {
        const { ws } = inst;
        if (ws && ws.readyState === WebSocket.OPEN)
          ws.send(JSON.stringify({ type: 'input', data: cdCmd }));
      } catch (_) {}
    });
  }, [projectRoot, isWindows]);

  // Re-spawn a terminal if the panel is shown empty
  useEffect(() => {
    if (!visible) return;
    if (terminals.length === 0) {
      const newId = nextId.current++;
      setTerminals([{ id: newId, name: shellDisplayName, shell: shellName }]);
      setActiveTermId(newId);
    }
  }, [visible]); // eslint-disable-line

  // Fit on visibility / tab / split changes
  useEffect(() => {
    if (!visible || viewTab !== 'terminals') return;
    const fitAll = () => {
      if (splitMode) {
        terminals.forEach(t => {
          try { instances.current.get(t.id)?.fitAndResize(); } catch (_) {}
        });
      } else {
        try { instances.current.get(activeTermId)?.fitAndResize(); } catch (_) {}
      }
    };
    const t = setTimeout(fitAll, 80);
    return () => clearTimeout(t);
  }, [visible, activeTermId, viewTab, onResize, splitMode, terminals]);

  // Fit on window resize
  useEffect(() => {
    const handleResize = () => {
      if (splitMode) {
        terminals.forEach(t => {
          try { instances.current.get(t.id)?.fitAndResize(); } catch (_) {}
        });
      } else {
        try { instances.current.get(activeTermId)?.fitAndResize(); } catch (_) {}
      }
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [activeTermId, splitMode, terminals]);

  // ── Shell helpers ─────────────────────────────────────────────────────────
  const shellLabel = (s) => {
    if (s === 'powershell') return 'pwsh';
    if (s === 'cmd')        return 'cmd';
    return s || shellDisplayName;
  };

  const addTerminal = useCallback((specificShell) => {
    const id = nextId.current++;
    const s  = specificShell || shellName;
    setTerminals(prev => [...prev, { id, name: shellLabel(s), shell: s }]);
    setActiveTermId(id);
    setViewTab('terminals');
    setSplitMode(false);
    setShowShellMenu(false);
  }, [shellName]); // eslint-disable-line

  const splitTerminal = useCallback(() => {
    const id = nextId.current++;
    setTerminals(prev => [...prev, { id, name: shellDisplayName, shell: shellName }]);
    setActiveTermId(id);
    setViewTab('terminals');
    setSplitMode(true);
  }, [shellName, shellDisplayName]);

  const closeTerminal = useCallback((id, e) => {
    if (e) e.stopPropagation();

    const inst = instances.current.get(id);
    if (inst) {
      try { inst.destroyWs?.(); }   catch (_) {}
      try { inst.term.dispose(); }  catch (_) {}
      instances.current.delete(id);
    }
    containers.current.delete(id);

    const remaining = terminals.filter(t => t.id !== id);
    if (remaining.length === 0) {
      setTerminals([]);
      setSplitMode(false);
      onClose?.();
    } else {
      setTerminals(remaining);
      if (remaining.length < 2) setSplitMode(false);
      setActiveTermId(curr => {
        if (curr !== id) return curr;
        const idx = terminals.findIndex(t => t.id === id);
        return remaining[Math.min(idx, remaining.length - 1)].id;
      });
    }
  }, [terminals, onClose]);

  const killActive = useCallback(() => closeTerminal(activeTermId), [activeTermId, closeTerminal]);

  // Close shell menu on outside click
  useEffect(() => {
    if (!showShellMenu) return;
    const handler = (e) => {
      if (!e.target.closest('.terminal-chevron-btn') && !e.target.closest('.shell-selection-menu'))
        setShowShellMenu(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showShellMenu]);

  // Compute fixed position for shell menu when it opens
  const openShellMenu = useCallback(() => {
    if (chevronBtnRef.current) {
      const rect = chevronBtnRef.current.getBoundingClientRect();
      setShellMenuPos({ top: rect.top, left: rect.left });
    }
    setShowShellMenu(v => !v);
  }, []);

  // Scroll hooks — must be above the early return to satisfy Rules of Hooks
  const scrollToBottom = useCallback(() => {
    const inst = instances.current.get(activeTermId);
    if (inst?.term) inst.term.scrollToBottom();
  }, [activeTermId]);

  const scrollToTop = useCallback(() => {
    const inst = instances.current.get(activeTermId);
    if (inst?.term) inst.term.scrollToTop();
  }, [activeTermId]);

  if (!visible) return null;

  const showingTerminals = viewTab === 'terminals';

  const shellMenuItems = isWindows ? (
    <>
      <div className="shell-menu-item" onClick={() => addTerminal('powershell')}>
        <span style={{ color: '#3B8EEA' }}>&#x2B24;</span> PowerShell
      </div>
      <div className="shell-menu-item" onClick={() => addTerminal('cmd')}>
        <span style={{ color: '#888' }}>&#x2B24;</span> Command Prompt
      </div>
      <div className="shell-menu-separator" />
      <div className="shell-menu-item" onClick={() => { splitTerminal(); setShowShellMenu(false); }}>
        <VscSplitHorizontal size={12} style={{ flexShrink: 0 }} /> Split Terminal
      </div>
    </>
  ) : (
    <>
      <div className="shell-menu-item" onClick={() => addTerminal('zsh')}>
        <span style={{ color: '#23D18B' }}>&#x2B24;</span> Zsh
      </div>
      <div className="shell-menu-item" onClick={() => addTerminal('bash')}>
        <span style={{ color: '#888' }}>&#x2B24;</span> Bash
      </div>
      <div className="shell-menu-separator" />
      <div className="shell-menu-item" onClick={() => { splitTerminal(); setShowShellMenu(false); }}>
        <VscSplitHorizontal size={12} style={{ flexShrink: 0 }} /> Split Terminal
      </div>
    </>
  );

  return (
    <div className="terminal-panel">
      {/* ── Header ── */}
      <div className="terminal-header">
        {/* LEFT: view tabs — VS Code sentence case */}
        <div className="terminal-view-tabs">
          {[
            { id: 'problems',      label: 'Problems',      badge: problems.length },
            { id: 'output',        label: 'Output' },
            { id: 'debug-console', label: 'Debug Console' },
            { id: 'terminals',     label: 'Terminal' },
            { id: 'ports',         label: 'Ports' },
          ].map(({ id, label, badge }) => (
            <div
              key={id}
              className={`terminal-view-tab${viewTab === id ? ' active' : ''}`}
              onClick={() => setViewTab(id)}
            >
              {label}
              {badge > 0 && <span className="terminal-tab-badge">{badge}</span>}
            </div>
          ))}
        </div>

        {/* RIGHT: VS Code action bar */}
        <div className="terminal-right-area">
          {/* + ▾ new terminal / shell picker */}
          <div className="terminal-action-group">
            <button type="button" className="icon-btn" title="New Terminal (Ctrl+`)"
              onClick={() => addTerminal()}>
              <VscAdd size={14} />
            </button>
            <button type="button" className="icon-btn terminal-chevron-btn"
              ref={chevronBtnRef}
              title="Launch Profile…" onClick={openShellMenu}>
              <span className="terminal-chevron">&#9662;</span>
            </button>
            {showShellMenu && (
              <div
                className="shell-selection-menu"
                style={{ position: 'fixed', top: shellMenuPos.top - 4, left: shellMenuPos.left, transform: 'translateY(-100%)' }}
              >
                {shellMenuItems}
              </div>
            )}
          </div>

          <span className="terminal-action-sep" />

          {/* Split */}
          <button className="icon-btn" title={splitMode ? 'Unsplit' : 'Split Terminal'}
            onClick={() => {
              if (splitMode) setSplitMode(false);
              else if (terminals.length >= 2) setSplitMode(true);
              else splitTerminal();
            }}>
            <VscSplitHorizontal size={13} />
          </button>

          {/* Kill */}
          <button className="icon-btn" title="Kill Terminal" onClick={killActive}>
            <VscTrash size={13} />
          </button>

          <span className="terminal-action-sep" />

          {/* Scroll navigation */}
          <button className="icon-btn" title="Scroll to Top" onClick={scrollToTop}>
            <VscChevronUp size={14} />
          </button>
          <button className="icon-btn" title="Scroll to Bottom" onClick={scrollToBottom}>
            <VscChevronDown size={14} />
          </button>

          <span className="terminal-action-sep" />

          {/* More / Close */}
          <button className="icon-btn" title="More Actions…">
            <VscEllipsis size={14} />
          </button>
          <button className="icon-btn" title="Close Panel" onClick={onClose}>
            <VscClose size={13} />
          </button>
        </div>
      </div>

      {/* ── Terminal view ── */}
      {showingTerminals && (
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
          {/* xterm canvases */}
          <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minWidth: 0 }}>
            {splitMode ? (
              terminals.map((t, idx) => (
                <React.Fragment key={t.id}>
                  {idx > 0 && (
                    <div style={{ width: 1, background: '#2d2d2d', flexShrink: 0 }} />
                  )}
                  <div
                    className="terminal-body"
                    ref={(el) => attachRef(t.id, el)}
                    style={{
                      flex: 1, display: 'block', minWidth: 0,
                      outline: activeTermId === t.id
                        ? '1px solid rgba(55,148,255,0.3)' : 'none',
                      outlineOffset: '-1px',
                    }}
                    onClick={() => setActiveTermId(t.id)}
                  />
                </React.Fragment>
              ))
            ) : (
              terminals.map((t) => (
                <div
                  key={t.id}
                  className="terminal-body"
                  ref={(el) => attachRef(t.id, el)}
                  style={{ display: activeTermId === t.id ? 'block' : 'none', flex: 1 }}
                />
              ))
            )}
          </div>

          {/* Instance sidebar — only shown with 2+ terminals */}
          {terminals.length >= 2 && (
            <div className="terminal-sidebar">
              {terminals.map((t) => (
                <div
                  key={t.id}
                  className={`terminal-sidebar-item${activeTermId === t.id ? ' active' : ''}`}
                  onClick={() => setActiveTermId(t.id)}
                >
                  <span className="term-status-dot" />
                  <span className="terminal-sidebar-name">{t.name}</span>
                  <button
                    type="button"
                    className="terminal-sidebar-close"
                    title="Remove Terminal"
                    onClick={(e) => closeTerminal(t.id, e)}
                  >
                    <VscClose size={10} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Problems view ── */}
      {viewTab === 'problems' && (
        <div className="terminal-body-content">
          {problems.length === 0 ? (
            <div className="terminal-empty-message">
              <span style={{ color: '#23d18b', fontSize: 13 }}>✓</span>
              No problems have been detected in the workspace.
            </div>
          ) : problems.map((p, idx) => (
            <div key={idx} className="terminal-problem-item">
              <span className={`problem-icon ${p.severity}`}>
                {p.severity === 'error' ? '✕' : '⚠'}
              </span>
              <span className="problem-file">{p.file}</span>
              <span className="problem-text">{p.message}</span>
            </div>
          ))}
        </div>
      )}

      {/* ── Output view ── */}
      {viewTab === 'output' && (
        <div className="terminal-body-content">
          {outputLogs.length === 0 ? (
            <div className="terminal-empty-message">
              No output yet.
            </div>
          ) : outputLogs.map((log, idx) => (
            <div key={idx} className="terminal-output-entry">
              <div className="output-header">
                <span className="output-time">[{log.time}]</span>
                <span className="output-command">$ {log.command}</span>
              </div>
              {log.output && <pre className="output-content">{log.output}</pre>}
            </div>
          ))}
        </div>
      )}

      {/* ── Debug Console / Ports (placeholder) ── */}
      {(viewTab === 'debug-console' || viewTab === 'ports') && (
        <div className="terminal-body-content">
          <div className="terminal-empty-message">
            {viewTab === 'debug-console'
              ? 'Start a debug session to see output here.'
              : 'No forwarded ports.'}
          </div>
        </div>
      )}
    </div>
  );
}

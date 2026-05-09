import React, { useEffect, useRef, useCallback, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import {
  VscAdd,
  VscTrash,
  VscSplitHorizontal,
  VscClose,
  VscTerminal,
} from 'react-icons/vsc';
import { API_URL as API } from '../config';

const TERM_THEME = {
  background: '#1E1E1E',
  foreground: '#D4D4D4',
  cursor: '#AEAFAD',
  cursorAccent: '#1E1E1E',
  selectionBackground: 'rgba(55, 148, 255, 0.25)',
  black: '#1E1E1E',
  red: '#CD3131',
  green: '#0DBC79',
  yellow: '#E5E510',
  blue: '#2472C8',
  magenta: '#BC3FBC',
  cyan: '#11A8CD',
  white: '#E5E5E5',
  brightBlack: '#666666',
  brightRed: '#F14C4C',
  brightGreen: '#23D18B',
  brightYellow: '#F5F543',
  brightBlue: '#3B8EEA',
  brightMagenta: '#D670D6',
  brightCyan: '#29B8DB',
  brightWhite: '#E5E5E5',
};

const TERM_OPTIONS = {
  theme: TERM_THEME,
  fontFamily: "'Cascadia Code', 'JetBrains Mono', 'Fira Code', 'Consolas', monospace",
  fontSize: 13,
  lineHeight: 1.4,
  cursorBlink: true,
  cursorStyle: 'bar',
  scrollback: 5000,
  allowProposedApi: true,
};

function initTerminal(container, sessionId, shell, projectRoot) {
  const term = new Terminal(TERM_OPTIONS);
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(container);

  let ws = null;
  let disposed = false;
  let retries = 0;
  const MAX_RETRIES = 8;

  const wsBase = API.replace(/^http/, 'ws');
  let wsUrl = `${wsBase}/terminal/ws/pty/${sessionId}?shell=${encodeURIComponent(shell || 'powershell')}&cols=80&rows=24`;
  if (projectRoot) wsUrl += `&cwd=${encodeURIComponent(projectRoot)}`;

  // ── Input: forward every keystroke to the PTY (registered once) ───
  term.onData(data => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'input', data }));
    }
  });

  // ── Copy/paste keyboard shortcuts ────────────────────────────────
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    // Ctrl+Shift+C → copy selection
    if (e.ctrlKey && e.shiftKey && e.code === 'KeyC') {
      const sel = term.getSelection();
      if (sel) navigator.clipboard.writeText(sel).catch(() => {});
      return false;
    }
    // Ctrl+Shift+V → paste from clipboard
    if (e.ctrlKey && e.shiftKey && e.code === 'KeyV') {
      navigator.clipboard.readText().then(text => {
        if (ws && ws.readyState === WebSocket.OPEN)
          ws.send(JSON.stringify({ type: 'input', data: text }));
      }).catch(() => {});
      return false;
    }
    return true;
  });

  // ── Right-click: copy if text selected, else paste ───────────────
  container.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const sel = term.getSelection();
    if (sel) {
      navigator.clipboard.writeText(sel).catch(() => {});
    } else {
      navigator.clipboard.readText().then(text => {
        if (ws && ws.readyState === WebSocket.OPEN)
          ws.send(JSON.stringify({ type: 'input', data: text }));
      }).catch(() => {});
    }
  });

  // ── WebSocket connection with auto-reconnect ──────────────────────
  function connect() {
    if (disposed) return;
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      retries = 0;
      try { fit.fit(); } catch (_) {}
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    };

    ws.onmessage = (e) => { term.write(e.data); };

    ws.onerror = () => {};

    ws.onclose = () => {
      if (disposed) return;
      if (retries < MAX_RETRIES) {
        retries++;
        setTimeout(connect, 1500);
      } else {
        term.writeln('\r\n\x1b[31mCould not connect to terminal backend.\x1b[0m');
        term.writeln('\x1b[2mRestart the backend server, then reopen this terminal.\x1b[0m');
      }
    };
  }

  connect();

  const fitAndResize = () => {
    try { fit.fit(); } catch (_) {}
    if (ws && ws.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
  };

  const destroyWs = () => {
    disposed = true;
    if (ws) { ws.onclose = null; ws.close(); }
  };

  return { term, fitAddon: fit, get ws() { return ws; }, fitAndResize, destroyWs };
}

export default function TerminalPanel({ visible, onClose, onResize, projectRoot }) {
  const isWindows = navigator.platform?.startsWith('Win') || navigator.userAgent?.includes('Windows');
  const shellName = isWindows ? 'powershell' : 'zsh';
  const shellDisplayName = isWindows ? 'pwsh' : 'zsh';
  const [terminals, setTerminals] = useState([{ id: 1, name: shellDisplayName, shell: shellName }]);
  const [activeTermId, setActiveTermId] = useState(1);
  const [viewTab, setViewTab] = useState('terminals');
  const [splitMode, setSplitMode] = useState(false);
  const [problems] = useState([]);
  const [outputLogs] = useState([]);
  const [showShellMenu, setShowShellMenu] = useState(false);

  const nextId = useRef(2);
  const instances = useRef(new Map());
  const containers = useRef(new Map());
  const roMap = useRef(new Map());

  const attachRef = useCallback((id, el) => {
    if (!el) return;
    containers.current.set(id, el);
    if (!instances.current.has(id)) {
      const terminal = terminals.find(t => t.id === id);
      const sessionId = `pty-${id}-${Date.now()}`;
      const inst = initTerminal(el, sessionId, terminal?.shell, projectRoot);
      instances.current.set(id, inst);
      setTimeout(() => {
        try { inst.fitAndResize(); } catch (_) {}
      }, 60);

      let rafId = null;
      const ro = new ResizeObserver(() => {
        if (rafId) cancelAnimationFrame(rafId);
        rafId = requestAnimationFrame(() => {
          try { inst.fitAndResize(); } catch (_) {}
          rafId = null;
        });
      });
      ro.observe(el);
      roMap.current.set(id, ro);
    }
  }, [terminals, projectRoot]);

  // Disconnect ResizeObservers when terminals are closed
  useEffect(() => {
    const ids = new Set(terminals.map(t => t.id));
    roMap.current.forEach((ro, id) => {
      if (!ids.has(id)) { ro.disconnect(); roMap.current.delete(id); }
    });
  }, [terminals]);

  // When the workspace folder changes, navigate all live terminals to the new root
  useEffect(() => {
    if (!projectRoot) return;
    // Use Set-Location on Windows (handles spaces/special chars); plain cd elsewhere
    const cdCmd = isWindows
      ? `Set-Location -LiteralPath '${projectRoot.replace(/'/g, "''")}'\r`
      : `cd "${projectRoot.replace(/"/g, '\\"')}"\r`;
    instances.current.forEach((inst) => {
      try {
        const ws = inst.ws;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'input', data: cdCmd }));
        }
      } catch (_) {}
    });
  }, [projectRoot, isWindows]);

  // When the panel becomes visible and has no terminals (e.g. after all were closed), spawn one
  useEffect(() => {
    if (!visible) return;
    if (terminals.length === 0) {
      const newId = nextId.current++;
      setTerminals([{ id: newId, name: shellDisplayName, shell: shellName }]);
      setActiveTermId(newId);
    }
  }, [visible]); // eslint-disable-line

  // Fit + notify PTY of new size on visibility/layout changes
  useEffect(() => {
    if (!visible || viewTab !== 'terminals') return;
    const fitAll = () => {
      if (splitMode) {
        terminals.forEach(t => {
          const inst = instances.current.get(t.id);
          if (inst) try { inst.fitAndResize(); } catch (_) {}
        });
      } else {
        const inst = instances.current.get(activeTermId);
        if (inst) try { inst.fitAndResize(); } catch (_) {}
      }
    };
    const t = setTimeout(fitAll, 80);
    return () => clearTimeout(t);
  }, [visible, activeTermId, viewTab, onResize, splitMode, terminals]);

  useEffect(() => {
    const handleResize = () => {
      if (splitMode) {
        terminals.forEach(t => {
          const inst = instances.current.get(t.id);
          if (inst) try { inst.fitAndResize(); } catch (_) {}
        });
      } else {
        const inst = instances.current.get(activeTermId);
        if (inst) try { inst.fitAndResize(); } catch (_) {}
      }
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [activeTermId, splitMode, terminals]);

  const shellLabel = (s) => {
    if (s === 'powershell') return 'pwsh';
    if (s === 'cmd') return 'cmd';
    return s || shellDisplayName;
  };

  const addTerminal = useCallback((specificShell) => {
    const id = nextId.current++;
    const s = specificShell || shellName;
    setTerminals(prev => [...prev, { id, name: shellLabel(s), shell: s }]);
    setActiveTermId(id);
    setViewTab('terminals');
    setSplitMode(false);
    setShowShellMenu(false);
  }, [shellName, shellDisplayName]); // eslint-disable-line

  const splitTerminal = useCallback(() => {
    const id = nextId.current++;
    setTerminals(prev => [...prev, { id, name: shellDisplayName, shell: shellName }]);
    setActiveTermId(id);
    setViewTab('terminals');
    setSplitMode(true);
  }, [shellName, shellDisplayName]);

  const closeTerminal = useCallback((id, e) => {
    if (e) e.stopPropagation();

    // Destroy the PTY + xterm instance
    const inst = instances.current.get(id);
    if (inst) {
      try { inst.destroyWs?.(); } catch (_) {}
      try { inst.term.dispose(); } catch (_) {}
      instances.current.delete(id);
    }
    containers.current.delete(id);

    // Compute new list directly — no setState-inside-updater side effects
    const remaining = terminals.filter(t => t.id !== id);

    if (remaining.length === 0) {
      // Last terminal closed — clear state then close the panel
      setTerminals([]);
      setSplitMode(false);
      onClose?.();
    } else {
      setTerminals(remaining);
      if (remaining.length < 2) setSplitMode(false);
      // Switch away from the closed terminal if it was active
      setActiveTermId(curr => {
        if (curr !== id) return curr;
        const idx = terminals.findIndex(t => t.id === id);
        return remaining[Math.min(idx, remaining.length - 1)].id;
      });
    }
  }, [terminals, onClose]);

  const killActive = useCallback(() => {
    closeTerminal(activeTermId);
  }, [activeTermId, closeTerminal]);

  // Close shell menu on outside click
  useEffect(() => {
    if (!showShellMenu) return;
    const handler = (e) => {
      if (!e.target.closest('.terminal-chevron-btn') && !e.target.closest('.shell-selection-menu')) {
        setShowShellMenu(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showShellMenu]);

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
      <div className="terminal-header">
        {/* LEFT: view-type tabs */}
        <div className="terminal-view-tabs">
          <div className={`terminal-view-tab ${viewTab === 'problems' ? 'active' : ''}`}
            onClick={() => setViewTab('problems')}>
            PROBLEMS{problems.length > 0 && <span className="terminal-tab-badge">{problems.length}</span>}
          </div>
          <div className={`terminal-view-tab ${viewTab === 'output' ? 'active' : ''}`}
            onClick={() => setViewTab('output')}>
            OUTPUT
          </div>
          <div className={`terminal-view-tab ${viewTab === 'terminals' ? 'active' : ''}`}
            onClick={() => setViewTab('terminals')}>
            TERMINAL
          </div>
        </div>

        {/* RIGHT: action buttons */}
        <div className="terminal-right-area">
          <div className="terminal-actions">
            <div style={{ position: 'relative', display: 'flex' }}>
              <button type="button" className="icon-btn" title="New Terminal"
                onClick={() => addTerminal()}>
                <VscAdd size={14} />
              </button>
              <button type="button" className="icon-btn terminal-chevron-btn"
                title="Select Shell" onClick={() => setShowShellMenu(v => !v)}>
                <span className="terminal-chevron">&#9662;</span>
              </button>
              {showShellMenu && (
                <div className="shell-selection-menu">
                  {shellMenuItems}
                </div>
              )}
            </div>
            <button className="icon-btn" title={splitMode ? 'Unsplit' : 'Split Terminal'} onClick={() => {
              if (splitMode) setSplitMode(false);
              else if (terminals.length >= 2) setSplitMode(true);
              else splitTerminal();
            }}><VscSplitHorizontal size={14} /></button>
            <button className="icon-btn" title="Kill Terminal" onClick={killActive}><VscTrash size={14} /></button>
            <button className="icon-btn" title="Close Panel" onClick={onClose}><VscClose size={14} /></button>
          </div>
        </div>
      </div>

      {showingTerminals && (
        <div className="terminal-split-container" style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
          {/* Terminal output area */}
          <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minWidth: 0 }}>
            {splitMode ? (
              terminals.map((t, idx) => (
                <React.Fragment key={t.id}>
                  {idx > 0 && <div style={{ width: 1, background: 'var(--border)', flexShrink: 0 }} />}
                  <div className="terminal-body" ref={(el) => attachRef(t.id, el)}
                    style={{ flex: 1, display: 'block', minWidth: 0,
                      outline: activeTermId === t.id ? '1px solid rgba(55,148,255,0.25)' : 'none',
                      outlineOffset: '-1px' }}
                    onClick={() => setActiveTermId(t.id)} />
                </React.Fragment>
              ))
            ) : (
              terminals.map((t) => (
                <div key={t.id} className="terminal-body" ref={(el) => attachRef(t.id, el)}
                  style={{ display: activeTermId === t.id ? 'block' : 'none', flex: 1 }} />
              ))
            )}
          </div>

          {/* Right sidebar — terminal instance list */}
          <div className="terminal-sidebar">
            {terminals.map((t) => (
              <div key={t.id}
                className={`terminal-sidebar-item ${activeTermId === t.id ? 'active' : ''}`}
                onClick={() => setActiveTermId(t.id)}>
                <VscTerminal className="terminal-sidebar-icon" />
                <span className="terminal-sidebar-name">{t.name}</span>
                <button type="button" className="terminal-sidebar-close" title="Close"
                  onClick={(e) => closeTerminal(t.id, e)}>
                  <VscClose size={10} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {viewTab === 'problems' && (
        <div className="terminal-body-content">
          {problems.length === 0 ? (
            <div className="terminal-empty-message">
              <span style={{ color: 'var(--success)', marginRight: 8 }}>&#10003;</span>
              No problems detected in the workspace.
            </div>
          ) : (
            problems.map((p, idx) => (
              <div key={idx} className="terminal-problem-item">
                <span className={`problem-icon ${p.severity}`}>{p.severity === 'error' ? '✕' : '⚠'}</span>
                <span className="problem-file">{p.file}</span>
                <span className="problem-text">{p.message}</span>
              </div>
            ))
          )}
        </div>
      )}

      {viewTab === 'output' && (
        <div className="terminal-body-content">
          {outputLogs.length === 0 ? (
            <div className="terminal-empty-message">No output yet. Run commands in the terminal to see output here.</div>
          ) : (
            outputLogs.map((log, idx) => (
              <div key={idx} className="terminal-output-entry">
                <div className="output-header">
                  <span className="output-time">[{log.time}]</span>
                  <span className="output-command">$ {log.command}</span>
                </div>
                {log.output && <pre className="output-content">{log.output}</pre>}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

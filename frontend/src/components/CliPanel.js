import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { AUTH_URL as AUTH } from '../config';
import { getAuthToken } from '../lib/auth';
import { startSsoLogin as startSsoLoginFlow } from '../lib/sso';

const TERM_THEME = {
  background: 'var(--bg-deepest)',
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
};

const CLI_LABELS = { claude: 'Claude CLI', codex: 'Codex CLI', powershell: 'PowerShell', cmd: 'Command Prompt' };

// ── localStorage helpers (keyed per CLI tool) ─────────────────────────
function _getStoredSessionId(cli) {
  try { return localStorage.getItem(`nebula_cli_session_${cli}`) || null; } catch (_) { return null; }
}
function _setStoredSessionId(cli, id) {
  try { localStorage.setItem(`nebula_cli_session_${cli}`, id); } catch (_) {}
}
function _clearStoredSessionId(cli) {
  try { localStorage.removeItem(`nebula_cli_session_${cli}`); } catch (_) {}
}

// ── Browser WebSocket CLI (used when Electron IPC is not available) ──────────
function BrowserCliPanel({ visible }) {
  const containerRef = useRef(null);
  const termRef = useRef(null);
  const fitRef = useRef(null);
  const wsRef = useRef(null);
  const sessionIdRef = useRef(null);
  const disposedRef = useRef(false);
  const roRef = useRef(null);

  const [selectedCli, setSelectedCli] = useState(() => {
    try { return localStorage.getItem('nebula_selected_cli') || 'claude'; } catch (_) { return 'claude'; }
  });

  useEffect(() => {
    try { localStorage.setItem('nebula_selected_cli', selectedCli); } catch (_) {}
  }, [selectedCli]);

  const wsBase = AUTH.replace(/^http/, 'ws');

  const sendResize = useCallback((ws, fit) => {
    if (!ws || ws.readyState !== WebSocket.OPEN || !fit) return;
    try {
      const dims = fit.proposeDimensions?.();
      if (dims) ws.send(JSON.stringify({ type: 'resize', cols: dims.cols, rows: dims.rows }));
    } catch (_) {}
  }, []);

  const connectWs = useCallback((cli) => {
    if (disposedRef.current) return;
    if (wsRef.current) {
      try { wsRef.current.onclose = null; wsRef.current.close(); } catch (_) {}
      wsRef.current = null;
    }

    const storedId = (() => { try { return localStorage.getItem(`nebula_ws_cli_${cli}`) || ''; } catch (_) { return ''; } })();
    if (storedId && !sessionIdRef.current) sessionIdRef.current = storedId;

    let retries = 0;
    const MAX_RETRIES = 8;

    function open() {
      if (disposedRef.current) return;
      const sid = sessionIdRef.current || '';
      const tok = getAuthToken() || '';
      const wsUrl = `${wsBase}/terminal/ws/cli?tool=${encodeURIComponent(cli)}`
        + (sid ? `&session_id=${encodeURIComponent(sid)}` : '')
        + (tok ? `&token=${encodeURIComponent(tok)}` : '');
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        retries = 0;
        sendResize(ws, fitRef.current);
      };

      let outBuf = '';
      let writeScheduled = false;
      function flushOutput() {
        if (outBuf && termRef.current) { termRef.current.write(outBuf); outBuf = ''; }
        writeScheduled = false;
      }
      ws.onmessage = (e) => {
        if (!termRef.current) return;
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'session_id') {
            sessionIdRef.current = msg.session_id;
            try { localStorage.setItem(`nebula_ws_cli_${cli}`, msg.session_id); } catch (_) {}
            termRef.current.writeln('\x1b[32m  Connected.\x1b[0m\r\n');
            try { fitRef.current?.fit(); } catch (_) {}
            sendResize(ws, fitRef.current);
            return;
          }
        } catch (_) {}
        outBuf += e.data;
        if (!writeScheduled) { writeScheduled = true; requestAnimationFrame(flushOutput); }
      };

      ws.onerror = () => {};

      ws.onclose = () => {
        if (disposedRef.current) return;
        if (retries < MAX_RETRIES) {
          retries++;
          setTimeout(open, 1500);
        } else {
          termRef.current?.writeln('\r\n\x1b[31m  Could not connect to backend.\x1b[0m');
        }
      };
    }

    open();
  }, [wsBase, sendResize]);

  useEffect(() => {
    if (!visible || termRef.current) return;

    const term = new Terminal(TERM_OPTIONS);
    const fit = new FitAddon();
    term.loadAddon(fit);
    if (containerRef.current) term.open(containerRef.current);
    termRef.current = term;
    fitRef.current = fit;

    term.onData((data) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(data);
    });

    requestAnimationFrame(() => { requestAnimationFrame(() => { try { fit.fit(); } catch (_) {} }); });
    connectWs(selectedCli);

    if (roRef.current) roRef.current.disconnect();
    let resizeTimer = null;
    const ro = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        try { fit.fit(); } catch (_) {}
        sendResize(wsRef.current, fit);
      }, 80);
    });
    if (containerRef.current) ro.observe(containerRef.current);
    roRef.current = ro;

    return () => {
      disposedRef.current = true;
      ro.disconnect();
      if (wsRef.current) { wsRef.current.onclose = null; try { wsRef.current.close(); } catch (_) {} }
      term.dispose();
    };
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleCliChange = (e) => {
    const newCli = e.target.value;
    setSelectedCli(newCli);
    sessionIdRef.current = null;
    if (termRef.current) {
      termRef.current.clear();
      termRef.current.writeln(`\x1b[1;33m  ✦ Starting ${CLI_LABELS[newCli] || newCli}...\x1b[0m`);
    }
    connectWs(newCli);
  };

  if (!visible) return null;

  return (
    <div className="cli-panel" style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--bg-deepest)' }}>
      <div className="cli-header" style={{
        height: 36, padding: '0 10px', borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0,
        background: 'var(--bg-deepest)',
      }}>
        <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>CLI</span>
        <select
          value={selectedCli}
          onChange={handleCliChange}
          style={{
            background: 'var(--bg-elevated)', color: 'var(--text-primary)',
            border: '1px solid var(--border)', padding: '3px 6px',
            borderRadius: 3, outline: 'none', fontSize: 12, cursor: 'pointer',
          }}
        >
          <option value="claude">Claude CLI</option>
          <option value="codex">Codex CLI</option>
        </select>
      </div>
      <div ref={containerRef} style={{ flex: 1, padding: 0, overflow: 'hidden' }} />
    </div>
  );
}

export default function CliPanel({ visible, projectRoot }) {
  const containerRef = useRef(null);
  const termRef = useRef(null);
  const fitAddonRef = useRef(null);
  const dataListenerRef = useRef(null);
  const sessionIdRef = useRef(null);
  const selectedCliRef = useRef(null);
  const unsubscribeDataRef = useRef(null);
  const unsubscribeExitRef = useRef(null);
  const roRef = useRef(null);

  const [selectedCli, setSelectedCli] = useState(() => {
    try {
      return localStorage.getItem('nebula_selected_cli') || 'claude';
    } catch (_) {
      return 'claude';
    }
  });
  const [authToken, setAuthTokenState] = useState(() => getAuthToken());
  const [authWarning, setAuthWarning] = useState(null); // { url?, message } | null

  // Keep a ref in sync so callbacks closed over at mount time can read the current value
  useEffect(() => { selectedCliRef.current = selectedCli; }, [selectedCli]);

  useEffect(() => {
    const onStorage = () => setAuthTokenState(getAuthToken());
    window.addEventListener('storage', onStorage);
    let t = null;
    if (visible) {
      t = setInterval(() => setAuthTokenState(getAuthToken()), 750);
    }
    return () => {
      window.removeEventListener('storage', onStorage);
      if (t) clearInterval(t);
    };
  }, [visible]);

  // ── Connect / reattach logic ──────────────────────────────────────────
  //
  // First tries to reattach to a persistent PTY from a previous page load.
  // If no live session is found it spawns a new one.
  //
  // Options:
  //   kill     – terminate sessionIdRef.current before proceeding (explicit kills)
  //   reattach – attempt reattach from localStorage (default true)
  const connectCliSession = useCallback(async (term, cli, { kill = false, reattach = true } = {}) => {
    // Handle any session currently tracked by this panel
    if (sessionIdRef.current) {
      if (kill) {
        if (window.electronAPI?.terminateCliSession) {
          try { await window.electronAPI.terminateCliSession(sessionIdRef.current); } catch (_) {}
        }
      } else {
        // Soft-detach: keep the PTY alive so we can reattach next time
        if (window.electronAPI?.closeCliSession) {
          try { await window.electronAPI.closeCliSession(sessionIdRef.current); } catch (_) {}
        }
      }
      sessionIdRef.current = null;
    }

    // Fresh window (no project) — don't reattach sessions that belong to other projects.
    // Clear any stored IDs so we always spawn a clean session in this context.
    if (reattach && !projectRoot) {
      _clearStoredSessionId(cli);
      reattach = false;
    }

    let hasSavedHistory = false;

    if (reattach) {
      const storedId = _getStoredSessionId(cli);
      if (storedId && window.electronAPI?.reattachCliSession) {
        const res = await window.electronAPI.reattachCliSession(storedId);
        if (res?.ok) {
          sessionIdRef.current = res.sessionId;
          // Replay what Claude printed while the page was away
          for (const chunk of res.scrollback || []) {
            term.write(chunk.replace(/\r?\n/g, '\r\n'));
          }
          term.writeln('\r\n\x1b[2;37m  (session restored — reconnected)\x1b[0m\r\n');
          term.focus();
          try {
            const dims = fitAddonRef.current?.proposeDimensions?.();
            if (dims) await window.electronAPI.resizeCliSession(res.sessionId, dims.cols, dims.rows);
          } catch (_) {}
          return;
        }
        // Stored session is gone (app restarted) — load history saved to disk
        _clearStoredSessionId(cli);
        if (window.electronAPI?.getCliHistory) {
          const hist = await window.electronAPI.getCliHistory(cli).catch(() => null);
          if (hist?.scrollback?.length) {
            hasSavedHistory = true;
            for (const chunk of hist.scrollback) {
              term.write(chunk.replace(/\r?\n/g, '\r\n'));
            }
            term.writeln('\r\n\x1b[2;37m  ── previous session ── starting new session below ──\x1b[0m\r\n');
          }
        }
      }
    }

    // ── Spawn a fresh session ───────────────────────────────────────
    if (!hasSavedHistory) term.clear();
    term.writeln('');
    const label = CLI_LABELS[cli] || 'Terminal';
    term.writeln(`\x1b[1;33m  ✦ Starting ${label}...\x1b[0m`);

    if (!window.electronAPI?.startCliSession) {
      term.writeln('\x1b[31m  Electron CLI bridge is not available.\x1b[0m');
      return;
    }

    const startPromise = window.electronAPI.startCliSession(cli, { authToken });
    const timeoutPromise = new Promise((resolve) => {
      setTimeout(() => resolve({ ok: false, message: 'CLI start timed out. Try re-selecting the tool or restarting the app.' }), 30000);
    });
    const result = await Promise.race([startPromise, timeoutPromise]);

    if (!result?.ok) {
      const msg = result?.message || 'Failed to start CLI session.';
      term.writeln(`\x1b[31m  ${msg}\x1b[0m`);

      // If auth failure, show a helpful re-authentication hint
      if (result?.authFailure) {
        term.writeln('');
        term.writeln('\x1b[33m  To fix this, open a terminal and run:\x1b[0m');
        term.writeln('\x1b[33m    claude login\x1b[0m');
        term.writeln('');
        setAuthWarning({ message: 'Claude authentication expired. Run `claude login` in a terminal to re-authenticate.' });
      }

      // If it's an "installing" message, add a retry hint
      if (msg.includes('installing in the background') || msg.includes('not installed')) {
        const installCmd = result?.installCommand || 'curl -fsSL https://claude.ai/install.sh | bash';
        term.writeln('');
        term.writeln('\x1b[33m  The installer may still be running. Try again in 30 seconds.\x1b[0m');
        term.writeln('\x1b[33m  If this persists, run manually:\x1b[0m');
        term.writeln(`\x1b[33m    ${installCmd}\x1b[0m`);
        term.writeln('');
      }
      return;
    }

    sessionIdRef.current = result.sessionId;
    _setStoredSessionId(cli, result.sessionId);
    if (result.shell) {
      term.writeln(`\x1b[2;37m  Shell: ${result.shell}\x1b[0m`);
    }
    term.writeln('\x1b[32m  Connected.\x1b[0m');
    term.writeln('');
    term.focus();

    try {
      const dims = fitAddonRef.current?.proposeDimensions?.();
      if (dims && sessionIdRef.current) {
        await window.electronAPI.resizeCliSession(sessionIdRef.current, dims.cols, dims.rows);
      }
    } catch (_) {}
  }, [authToken]);

  const initTerm = useCallback(() => {
    if (!containerRef.current || termRef.current) return;

    const term = new Terminal(TERM_OPTIONS);
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);

    termRef.current = term;
    fitAddonRef.current = fit;

    if (!unsubscribeDataRef.current && window.electronAPI?.onCliData) {
      unsubscribeDataRef.current = window.electronAPI.onCliData(({ sessionId, data }) => {
        if (!termRef.current) return;
        // Accept data from the active session or before sessionId is set
        // (initial PTY data can arrive before the IPC response returns).
        if (sessionId !== sessionIdRef.current && sessionIdRef.current) return;
        termRef.current.write(data.replace(/\r?\n/g, '\r\n'));
      });
    }

    if (!unsubscribeExitRef.current && window.electronAPI?.onCliExit) {
      unsubscribeExitRef.current = window.electronAPI.onCliExit(({ sessionId }) => {
        if (sessionId !== sessionIdRef.current || !termRef.current) return;
        termRef.current.writeln('\r\n\x1b[33m  CLI session ended. Re-select the tool to restart.\x1b[0m');
        _clearStoredSessionId(selectedCliRef.current || selectedCli);
        sessionIdRef.current = null;
      });
    }

    // Auth-required: Claude's refresh token expired. Browser was auto-opened;
    // show a non-blocking banner so the admin knows what's happening.
    if (window.electronAPI?.onCliAuthRequired) {
      window.electronAPI.onCliAuthRequired(({ url }) => {
        setAuthWarning({ url, message: 'Claude needs to re-authenticate. A browser window has been opened — complete the login and Claude will resume automatically.' });
      });
    }

    // Proactive warning: credential file is stale (detected on startup).
    if (window.electronAPI?.onClaudeCredentialWarning) {
      window.electronAPI.onClaudeCredentialWarning((payload) => {
        setAuthWarning({ message: payload.message || 'Claude credentials may be stale. If Claude shows a login prompt, contact your administrator.' });
      });
    }

    connectCliSession(term, selectedCli);

    if (!dataListenerRef.current) {
      dataListenerRef.current = term.onData((data) => {
        if (sessionIdRef.current && window.electronAPI?.writeCliSession) {
          window.electronAPI.writeCliSession(sessionIdRef.current, data);
        }
      });
    }

    // Alt+V — paste image from clipboard into Claude CLI.
    // On Windows the clipboard image is often stored as CF_DIB/CF_BITMAP which
    // Claude CLI cannot read. We intercept the keypress, re-write the clipboard
    // image as PNG via Electron (which handles all Windows formats), then send
    // the escape sequence to the PTY so Claude CLI finds a proper PNG.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown' || !e.altKey || e.key !== 'v') return true;
      if (!window.electronAPI?.normalizeClipboardImage) return true;
      window.electronAPI.normalizeClipboardImage().then((res) => {
        // Whether normalization succeeded or not, forward the keystroke so Claude
        // CLI can show its own "no image" message if the clipboard is empty.
        if (sessionIdRef.current && window.electronAPI?.writeCliSession) {
          window.electronAPI.writeCliSession(sessionIdRef.current, '\x1bv');
        }
      }).catch(() => {
        if (sessionIdRef.current && window.electronAPI?.writeCliSession) {
          window.electronAPI.writeCliSession(sessionIdRef.current, '\x1bv');
        }
      });
      return false; // block xterm from sending the keystroke itself
    });

    requestAnimationFrame(() => { requestAnimationFrame(() => { try { fit.fit(); } catch (_) {} }); });

    // ResizeObserver — auto-refit whenever the container changes size (panel drag, etc.)
    // requestAnimationFrame prevents "ResizeObserver loop" browser warnings.
    if (roRef.current) roRef.current.disconnect();
    let rafId = null;
    const ro = new ResizeObserver(() => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        if (!fitAddonRef.current) return;
        try { fitAddonRef.current.fit(); } catch (_) {}
        const dims = fitAddonRef.current.proposeDimensions?.();
        if (dims && sessionIdRef.current && window.electronAPI?.resizeCliSession) {
          window.electronAPI.resizeCliSession(sessionIdRef.current, dims.cols, dims.rows);
        }
        rafId = null;
      });
    });
    ro.observe(containerRef.current);
    roRef.current = ro;
  }, [connectCliSession, selectedCli]);

  useEffect(() => {
    if (visible) {
      if (!termRef.current) {
        initTerm();
      } else {
        setTimeout(() => {
          try { fitAddonRef.current?.fit(); } catch (_) {}
        }, 50);
      }
    }
  }, [visible, initTerm]);

  // IPC listener cleanup on full unmount (tab close / component teardown)
  useEffect(() => () => {
    if (unsubscribeDataRef.current) unsubscribeDataRef.current();
    if (unsubscribeExitRef.current) unsubscribeExitRef.current();
    if (roRef.current) { roRef.current.disconnect(); roRef.current = null; }
  }, []);

  // Soft-detach on unmount (page refresh, panel hide): keep PTY alive
  useEffect(() => () => {
    if (sessionIdRef.current && window.electronAPI?.closeCliSession) {
      try { window.electronAPI.closeCliSession(sessionIdRef.current); } catch (_) {}
    }
    sessionIdRef.current = null;
  }, []);

  useEffect(() => {
    const handleResize = () => {
      if (visible && fitAddonRef.current) {
        try { fitAddonRef.current.fit(); } catch (_) {}
        if (sessionIdRef.current && window.electronAPI?.resizeCliSession) {
          const dims = fitAddonRef.current.proposeDimensions?.();
          if (dims) {
            window.electronAPI.resizeCliSession(sessionIdRef.current, dims.cols, dims.rows);
          }
        }
      }
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [visible]);

  // When the project root changes, kill the current session and start fresh
  // (the old session was tied to the previous workspace)
  useEffect(() => {
    if (!visible) return;
    if (!window.electronAPI?.onProjectRootChanged) return;

    const unsubscribe = window.electronAPI.onProjectRootChanged(() => {
      if (termRef.current) {
        _clearStoredSessionId(selectedCliRef.current || selectedCli);
        connectCliSession(termRef.current, selectedCliRef.current || selectedCli, { kill: true, reattach: false });
      }
    });

    return () => {
      try { unsubscribe?.(); } catch (_) {}
    };
  }, [visible, connectCliSession, selectedCli]);

  useEffect(() => {
    try {
      localStorage.setItem('nebula_selected_cli', selectedCli);
    } catch (_) {}
  }, [selectedCli]);

  const handleCliChange = async (e) => {
    const prevCli = selectedCli;
    const newCli = e.target.value;

    // Kill the session for the old tool (user is switching away from it)
    if (sessionIdRef.current && window.electronAPI?.terminateCliSession) {
      try { await window.electronAPI.terminateCliSession(sessionIdRef.current); } catch (_) {}
      sessionIdRef.current = null;
    }
    _clearStoredSessionId(prevCli);

    setSelectedCli(newCli);
    if (termRef.current) {
      connectCliSession(termRef.current, newCli);
    }
  };

  if (!visible) return null;

  if (!window.electronAPI?.startCliSession) {
    return <BrowserCliPanel visible={visible} />;
  }

  if (!authToken) {
    const startSsoLogin = () => {
      startSsoLoginFlow(AUTH, { redirectUri: 'nebula://auth' }).catch(() => {});
    };
    return (
      <div style={{ height: '100%', display: 'grid', placeItems: 'center', background: 'var(--bg-deep)', padding: 18 }}>
        <div style={{ width: 520, maxWidth: '95vw', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 12, padding: 16 }}>
          <div style={{ fontSize: 14, fontWeight: 900, color: 'var(--text-primary)' }}>CLI access requires login</div>
          <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.4 }}>
            Please authenticate to use the CLI tools.
          </div>
          <div style={{ marginTop: 12, display: 'flex', justifyContent: 'flex-end' }}>
            <button type="button" onClick={startSsoLogin} style={{ background: 'var(--accent)', color: '#071018', border: 'none', borderRadius: 8, padding: '10px 12px', fontWeight: 800, cursor: 'pointer', fontSize: 13 }}>
              Login
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="cli-panel" style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--bg-deepest)' }}>
      <div className="cli-header" style={{
        height: 36, padding: '0 10px', borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0,
        background: 'var(--bg-deepest)',
      }}>
        <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>CLI</span>
        <select
          value={selectedCli}
          onChange={handleCliChange}
          style={{
            background: 'var(--bg-elevated)',
            color: 'var(--text-primary)',
            border: '1px solid var(--border)',
            padding: '3px 6px',
            borderRadius: 3,
            outline: 'none',
            fontSize: 12,
            cursor: 'pointer',
          }}
        >
          <option value="claude">Claude CLI</option>
          <option value="codex">Codex CLI</option>
          {window.electronAPI?.isElectron && navigator.platform?.startsWith('Win') && (
            <>
              <option value="powershell">PowerShell</option>
              <option value="cmd">Command Prompt</option>
            </>
          )}
        </select>
      </div>
      {authWarning && (
        <div style={{ padding: '5px 12px', background: 'rgba(255,180,0,0.08)', borderBottom: '1px solid rgba(255,180,0,0.15)', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <span style={{ fontSize: 11, color: '#CCA700', flex: 1, lineHeight: 1.4 }}>
            {authWarning.message}
            {authWarning.url && (
              <> &nbsp;<a href={authWarning.url} target="_blank" rel="noreferrer" style={{ color: '#E5C000', textDecoration: 'underline' }}>Open login page</a></>
            )}
          </span>
          <button type="button" onClick={() => setAuthWarning(null)}
            style={{ background: 'none', border: 'none', color: '#CCA700', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: '0 4px' }}
            aria-label="Dismiss">×</button>
        </div>
      )}
      {/* padding: 0 — xterm manages its own internal padding */}
      <div className="cli-body" ref={containerRef} style={{ flex: 1, padding: 0, overflow: 'hidden' }} />
    </div>
  );
}

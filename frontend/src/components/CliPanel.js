import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { AUTH_URL as AUTH } from '../config';
import { getAuthToken } from '../lib/auth';
import { startSsoLogin as startSsoLoginFlow } from '../lib/sso';

const TERM_THEME = {
  background: '#08090d',
  foreground: '#c9d1d9',
  cursor: '#f59e0b',
  cursorAccent: '#000000',
  selectionBackground: '#253551',
  black: '#0d1117',
  red: '#f87171',
  green: '#34d399',
  yellow: '#fbbf24',
  blue: '#82aaff',
  magenta: '#c792ea',
  cyan: '#89ddff',
  white: '#c9d1d9',
};

const TERM_OPTIONS = {
  theme: TERM_THEME,
  fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'SF Mono', Menlo, Monaco, monospace",
  fontSize: 13,
  lineHeight: 1.4,
  cursorBlink: true,
  cursorStyle: 'bar',
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

export default function CliPanel({ visible }) {
  const containerRef = useRef(null);
  const termRef = useRef(null);
  const fitAddonRef = useRef(null);
  const dataListenerRef = useRef(null);
  const sessionIdRef = useRef(null);
  const selectedCliRef = useRef(null);
  const unsubscribeDataRef = useRef(null);
  const unsubscribeExitRef = useRef(null);

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
        // Stored session is gone; clear it and fall through to spawn
        _clearStoredSessionId(cli);
      }
    }

    // ── Spawn a fresh session ───────────────────────────────────────
    term.clear();
    term.writeln('');
    const label = CLI_LABELS[cli] || 'Terminal';
    term.writeln(`\x1b[1;33m  ✦ Starting ${label}...\x1b[0m`);

    if (!window.electronAPI?.startCliSession) {
      term.writeln('\x1b[31m  Electron CLI bridge is not available.\x1b[0m');
      return;
    }

    const startPromise = window.electronAPI.startCliSession(cli, { authToken });
    const timeoutPromise = new Promise((resolve) => {
      setTimeout(() => resolve({ ok: false, message: 'CLI start timed out. Try re-selecting the tool or restarting the app.' }), 8000);
    });
    const result = await Promise.race([startPromise, timeoutPromise]);

    if (!result?.ok) {
      term.writeln(`\x1b[31m  ${result?.message || 'Failed to start CLI session.'}\x1b[0m`);
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
        if (sessionId !== sessionIdRef.current || !termRef.current) return;
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

    setTimeout(() => {
      try { fit.fit(); } catch (_) {}
    }, 100);
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
    return (
      <div style={{ height: '100%', display: 'grid', placeItems: 'center', background: 'var(--bg-deep)', padding: 18 }}>
        <div style={{ width: 560, maxWidth: '95vw', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 12, padding: 16 }}>
          <div style={{ fontSize: 14, fontWeight: 900, color: 'var(--text-primary)' }}>CLI is available in the Desktop app</div>
          <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.4 }}>
            The embedded CLI panel requires the Electron desktop build. In a browser build, local CLIs cannot be spawned.
          </div>
        </div>
      </div>
    );
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
    <div className="cli-panel" style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--bg-deep)' }}>
      <div className="cli-header" style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: '8px' }}>
        <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>CLI Tool:</span>
        <select
          value={selectedCli}
          onChange={handleCliChange}
          style={{
            background: 'var(--bg-surface)',
            color: 'var(--text-primary)',
            border: '1px solid var(--border)',
            padding: '4px 8px',
            borderRadius: '4px',
            outline: 'none',
            fontSize: '13px'
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
        <div style={{ padding: '6px 12px', background: '#7c3c00', borderBottom: '1px solid #a05000', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <span style={{ fontSize: 12, color: '#fbbf24', flex: 1, lineHeight: 1.4 }}>
            {authWarning.message}
            {authWarning.url && (
              <> &nbsp;<a href={authWarning.url} target="_blank" rel="noreferrer" style={{ color: '#fde68a', textDecoration: 'underline' }}>Open login page</a></>
            )}
          </span>
          <button
            type="button"
            onClick={() => setAuthWarning(null)}
            style={{ background: 'none', border: 'none', color: '#fbbf24', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: '0 4px' }}
            aria-label="Dismiss"
          >×</button>
        </div>
      )}
      <div className="cli-body" ref={containerRef} style={{ flex: 1, padding: '4px' }} />
    </div>
  );
}

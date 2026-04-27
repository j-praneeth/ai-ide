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

export default function CliPanel({ visible }) {
  const containerRef = useRef(null);
  const termRef = useRef(null);
  const fitAddonRef = useRef(null);
  const dataListenerRef = useRef(null);
  const sessionIdRef = useRef(null);
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

  useEffect(() => {
    const onStorage = () => setAuthTokenState(getAuthToken());
    window.addEventListener('storage', onStorage);
    // Same-tab updates won't fire storage; poll lightly when visible.
    let t = null;
    if (visible) {
      t = setInterval(() => setAuthTokenState(getAuthToken()), 750);
    }
    return () => {
      window.removeEventListener('storage', onStorage);
      if (t) clearInterval(t);
    };
  }, [visible]);

  const cleanupSession = useCallback(async () => {
    if (sessionIdRef.current && window.electronAPI?.closeCliSession) {
      try {
        await window.electronAPI.closeCliSession(sessionIdRef.current);
      } catch (_) {}
    }
    sessionIdRef.current = null;
  }, []);

  const connectCliSession = useCallback(async (term, cli) => {
    await cleanupSession();

    term.clear();
    term.writeln('');
    const label = cli === 'claude'
      ? 'Claude CLI'
      : cli === 'codex'
        ? 'Codex CLI'
        : cli === 'powershell'
          ? 'PowerShell'
          : cli === 'cmd'
            ? 'Command Prompt'
            : 'Terminal';
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
    if (result.shell) {
      term.writeln(`\x1b[2;37m  Shell: ${result.shell}\x1b[0m`);
    }
    term.writeln('\x1b[32m  Connected to terminal.\x1b[0m');
    term.writeln('');
    term.focus();

    try {
      const dims = fitAddonRef.current?.proposeDimensions?.();
      if (dims && sessionIdRef.current) {
        await window.electronAPI.resizeCliSession(sessionIdRef.current, dims.cols, dims.rows);
      }
    } catch (_) {}
  }, [cleanupSession, authToken]);

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
        sessionIdRef.current = null;
      });
    }

    connectCliSession(term, selectedCli);

    // Only hook up data once
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

  useEffect(() => () => {
    if (unsubscribeDataRef.current) unsubscribeDataRef.current();
    if (unsubscribeExitRef.current) unsubscribeExitRef.current();
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

  useEffect(() => {
    if (!visible) return;
    if (!window.electronAPI?.onProjectRootChanged) return;

    const unsubscribe = window.electronAPI.onProjectRootChanged(() => {
      if (termRef.current) {
        connectCliSession(termRef.current, selectedCli);
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

  useEffect(() => () => {
    cleanupSession();
  }, [cleanupSession]);

  const handleCliChange = (e) => {
    const newCli = e.target.value;
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
      <div className="cli-body" ref={containerRef} style={{ flex: 1, padding: '4px' }} />
    </div>
  );
}

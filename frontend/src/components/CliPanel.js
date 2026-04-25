import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

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

    const result = await window.electronAPI.startCliSession(cli);
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
  }, [cleanupSession]);

  const initTerm = useCallback(() => {
    if (!containerRef.current || termRef.current) return;

    const term = new Terminal(TERM_OPTIONS);
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    
    termRef.current = term;
    fitAddonRef.current = fit;

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

  useEffect(() => {
    if (unsubscribeDataRef.current) {
      unsubscribeDataRef.current();
    }
    if (unsubscribeExitRef.current) {
      unsubscribeExitRef.current();
    }

    if (window.electronAPI?.onCliData) {
      unsubscribeDataRef.current = window.electronAPI.onCliData(({ sessionId, data }) => {
        if (sessionId !== sessionIdRef.current || !termRef.current) return;
        termRef.current.write(data.replace(/\r?\n/g, '\r\n'));
      });
    }

    if (window.electronAPI?.onCliExit) {
      unsubscribeExitRef.current = window.electronAPI.onCliExit(({ sessionId }) => {
        if (sessionId !== sessionIdRef.current || !termRef.current) return;
        termRef.current.writeln('\r\n\x1b[33m  CLI session ended. Re-select the tool to restart.\x1b[0m');
        sessionIdRef.current = null;
      });
    }

    return () => {
      if (unsubscribeDataRef.current) unsubscribeDataRef.current();
      if (unsubscribeExitRef.current) unsubscribeExitRef.current();
    };
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

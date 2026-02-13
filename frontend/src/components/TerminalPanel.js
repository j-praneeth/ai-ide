import React, { useEffect, useRef, useCallback, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import {
  VscAdd,
  VscTrash,
  VscSplitHorizontal,
  VscClose,
} from 'react-icons/vsc';
import axios from 'axios';
import { API_URL as API } from '../config';

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
  brightBlack: '#4a5972',
  brightRed: '#fca5a5',
  brightGreen: '#6ee7b7',
  brightYellow: '#fde68a',
  brightBlue: '#93c5fd',
  brightMagenta: '#d8b4fe',
  brightCyan: '#a5f3fc',
  brightWhite: '#f1f5f9',
};

const TERM_OPTIONS = {
  theme: TERM_THEME,
  fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'SF Mono', Menlo, Monaco, monospace",
  fontSize: 13,
  lineHeight: 1.4,
  cursorBlink: true,
  cursorStyle: 'bar',
  scrollback: 5000,
  allowProposedApi: true,
};

function initTerminal(container, sessionId, onOutput) {
  const term = new Terminal(TERM_OPTIONS);
  const fit = new FitAddon();
  const inputBuffer = { current: '' };
  const promptInfo = { current: { username: '', hostname: '', short_cwd: '', prompt_char: '%', platform: '' } };

  // Fetch prompt info from backend
  const fetchPrompt = async () => {
    try {
      const res = await axios.get(`${API}/terminal/info`, { params: { session: sessionId } });
      promptInfo.current = {
        username: res.data.username || 'user',
        hostname: res.data.hostname || 'localhost',
        short_cwd: res.data.short_cwd || '~',
        prompt_char: res.data.prompt_char || '%',
        platform: res.data.platform || '',
      };
    } catch (_) {}
  };

  const writePrompt = () => {
    const { username, hostname, short_cwd, prompt_char } = promptInfo.current;
    // Cross-platform prompt: user@host dir % (or > on Windows)
    term.write(`\x1b[1;32m${username}@${hostname}\x1b[0m \x1b[1;34m${short_cwd}\x1b[0m \x1b[1;33m${prompt_char}\x1b[0m `);
  };

  const executeCommand = async (command) => {
    try {
      if (command === 'clear' || command === 'cls') {
        term.clear();
        await fetchPrompt();
        writePrompt();
        return;
      }
      const res = await axios.post(`${API}/terminal/run`, null, {
        params: { command, session: sessionId }
      });
      const output = res.data.output || res.data.error || '';
      if (onOutput) onOutput({ time: new Date().toLocaleTimeString(), command, output });
      if (output) {
        // Write each line, trimming trailing newline
        const lines = output.replace(/\n$/, '').split('\n');
        lines.forEach(line => term.writeln(line));
      }
      // Update prompt info (cwd may have changed from cd)
      await fetchPrompt();
    } catch (err) {
      term.writeln(`\x1b[31mError: ${err.message}\x1b[0m`);
    }
    writePrompt();
  };

  term.loadAddon(fit);
  term.open(container);

  term.writeln('');
  term.writeln('\x1b[1;33m  ✦ Nebula Terminal\x1b[0m');
  term.writeln('\x1b[2;37m  Type commands below\x1b[0m');
  term.writeln('');

  // Initial prompt fetch then display
  fetchPrompt().then(() => writePrompt());

  term.onData(data => {
    const code = data.charCodeAt(0);
    if (code === 13) { // Enter
      term.write('\r\n');
      const cmd = inputBuffer.current.trim();
      inputBuffer.current = '';
      if (cmd) executeCommand(cmd);
      else writePrompt();
    } else if (code === 127) { // Backspace
      if (inputBuffer.current.length > 0) {
        inputBuffer.current = inputBuffer.current.slice(0, -1);
        term.write('\b \b');
      }
    } else if (code === 3) { // Ctrl+C
      inputBuffer.current = '';
      term.write('^C\r\n');
      writePrompt();
    } else if (data >= String.fromCharCode(32)) {
      inputBuffer.current += data;
      term.write(data);
    }
  });

  return { term, fitAddon: fit, inputBuffer };
}

export default function TerminalPanel({ visible, onClose, onResize }) {
  // Detect shell name from platform
  const shellName = (window.electronAPI?.isElectron && navigator.platform?.startsWith('Win')) ? 'powershell' : 'zsh';
  const [terminals, setTerminals] = useState([{ id: 1, name: shellName }]);
  const [activeTermId, setActiveTermId] = useState(1);
  const [viewTab, setViewTab] = useState('terminals');
  const [splitMode, setSplitMode] = useState(false);
  const [problems] = useState([]);
  const [outputLogs, setOutputLogs] = useState([]);

  const nextId = useRef(2);
  const instances = useRef(new Map());
  const containers = useRef(new Map());
  const onOutputRef = useRef((log) => setOutputLogs(prev => [...prev, log]));

  const attachRef = useCallback((id, el) => {
    if (!el) return;
    containers.current.set(id, el);
    if (!instances.current.has(id)) {
      const sessionId = `term-${id}`;
      const inst = initTerminal(el, sessionId, (log) => onOutputRef.current(log));
      instances.current.set(id, inst);
      setTimeout(() => {
        try { inst.fitAddon.fit(); } catch (_) {}
      }, 100);
    }
  }, []);

  // Fit active terminal on visibility/resize changes
  useEffect(() => {
    if (!visible || viewTab !== 'terminals') return;
    const fitAll = () => {
      if (splitMode) {
        terminals.forEach(t => {
          const inst = instances.current.get(t.id);
          if (inst) try { inst.fitAddon.fit(); } catch (_) {}
        });
      } else {
        const inst = instances.current.get(activeTermId);
        if (inst) try { inst.fitAddon.fit(); } catch (_) {}
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
          if (inst) try { inst.fitAddon.fit(); } catch (_) {}
        });
      } else {
        const inst = instances.current.get(activeTermId);
        if (inst) try { inst.fitAddon.fit(); } catch (_) {}
      }
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [activeTermId, splitMode, terminals]);

  const addTerminal = useCallback(() => {
    const id = nextId.current++;
    setTerminals(prev => [...prev, { id, name: `${shellName} ${id}` }]);
    setActiveTermId(id);
    setViewTab('terminals');
    setSplitMode(false);
  }, [shellName]);

  const splitTerminal = useCallback(() => {
    const id = nextId.current++;
    setTerminals(prev => [...prev, { id, name: `${shellName} ${id}` }]);
    setActiveTermId(id);
    setViewTab('terminals');
    setSplitMode(true);
  }, [shellName]);

  const closeTerminal = useCallback((id, e) => {
    if (e) e.stopPropagation();
    const inst = instances.current.get(id);
    if (inst) {
      try { inst.term.dispose(); } catch (_) {}
      instances.current.delete(id);
    }
    containers.current.delete(id);

    setTerminals(prev => {
      const remaining = prev.filter(t => t.id !== id);
      if (remaining.length === 0) {
        const newId = nextId.current++;
        setActiveTermId(newId);
        setSplitMode(false);
        return [{ id: newId, name: shellName }];
      }
      setActiveTermId(curr => {
        if (curr === id) {
          const idx = prev.findIndex(t => t.id === id);
          return remaining[Math.min(idx, remaining.length - 1)].id;
        }
        return curr;
      });
      if (remaining.length < 2) setSplitMode(false);
      return remaining;
    });
  }, [shellName]);

  const killActive = useCallback(() => {
    closeTerminal(activeTermId);
  }, [activeTermId, closeTerminal]);

  if (!visible) return null;

  const showingTerminals = viewTab === 'terminals';

  return (
    <div className="terminal-panel">
      <div className="terminal-header">
        <div className="terminal-tabs">
          {terminals.map((t) => (
            <div
              key={t.id}
              className={`terminal-tab terminal-instance-tab ${showingTerminals && activeTermId === t.id ? 'active' : ''}`}
              onClick={() => { setActiveTermId(t.id); setViewTab('terminals'); }}
            >
              <span className="terminal-tab-icon">&#x2B24;</span>
              <span>{t.name}</span>
              {terminals.length > 0 && (
                <button type="button" className="terminal-tab-close" title="Close terminal"
                  onClick={(e) => closeTerminal(t.id, e)}>
                  <VscClose size={12} />
                </button>
              )}
            </div>
          ))}
          <button type="button" className="terminal-tab terminal-tab-add" title="New Terminal" onClick={addTerminal}>
            <VscAdd size={14} />
          </button>
          <div style={{ width: 1, height: 16, background: 'var(--border)', margin: '0 6px', flexShrink: 0 }} />
          <div className={`terminal-tab ${viewTab === 'problems' ? 'active' : ''}`} onClick={() => setViewTab('problems')}>
            <span>Problems</span>
            {problems.length > 0 && <span className="terminal-tab-badge">{problems.length}</span>}
          </div>
          <div className={`terminal-tab ${viewTab === 'output' ? 'active' : ''}`} onClick={() => setViewTab('output')}>
            <span>Output</span>
          </div>
        </div>
        <div className="terminal-actions">
          <button className="icon-btn" title="New Terminal" onClick={addTerminal}><VscAdd size={14} /></button>
          <button className="icon-btn" title={splitMode ? 'Unsplit' : 'Split Terminal'} onClick={() => {
            if (splitMode) setSplitMode(false);
            else if (terminals.length >= 2) setSplitMode(true);
            else splitTerminal();
          }}><VscSplitHorizontal size={14} /></button>
          <button className="icon-btn" title="Kill Terminal" onClick={killActive}><VscTrash size={14} /></button>
          <button className="icon-btn" title="Close Panel" onClick={onClose}><VscClose size={14} /></button>
        </div>
      </div>

      {showingTerminals && (
        <div className="terminal-split-container" style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
          {splitMode ? (
            terminals.map((t, idx) => (
              <React.Fragment key={t.id}>
                {idx > 0 && <div style={{ width: 1, background: 'var(--border)', flexShrink: 0 }} />}
                <div className="terminal-body" ref={(el) => attachRef(t.id, el)}
                  style={{ flex: 1, display: 'block', minWidth: 0,
                    border: activeTermId === t.id ? '1px solid rgba(245,158,11,0.2)' : 'none' }}
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

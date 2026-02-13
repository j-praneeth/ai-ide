import { useState, useEffect, useRef } from 'react';
import nebulaWS from '../services/websocket';
import './TerminalPage.css';

export default function TerminalPage() {
  const [lines, setLines] = useState([]);
  const [input, setInput] = useState('');
  const [cwd, setCwd] = useState('');
  const [running, setRunning] = useState(false);
  const terminalRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    // Listen for terminal results
    const unsubResult = nebulaWS.on('terminal_result', (data) => {
      setRunning(false);
      setCwd(data.cwd || '');
      setLines(prev => [
        ...prev,
        { type: 'command', text: data.command },
        { type: data.exit_code === 0 ? 'output' : 'error', text: data.output || '' },
      ]);
    });

    // Listen for desktop terminal activity too
    const unsubDesktop = nebulaWS.on('terminal_output', (data) => {
      if (data.source === 'desktop') {
        setLines(prev => [
          ...prev,
          { type: 'desktop', text: `[desktop] $ ${data.command}` },
          { type: data.exit_code === 0 ? 'output' : 'error', text: data.output || '' },
        ]);
      }
    });

    return () => {
      unsubResult();
      unsubDesktop();
    };
  }, []);

  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [lines]);

  const runCommand = () => {
    const cmd = input.trim();
    if (!cmd || running) return;

    setInput('');
    setRunning(true);

    try {
      nebulaWS.sendTerminalCommand(cmd);
    } catch {
      setRunning(false);
      setLines(prev => [...prev, {
        type: 'error',
        text: 'Not connected to IDE.',
      }]);
    }
  };

  const clearTerminal = () => {
    setLines([]);
  };

  return (
    <div className="page terminal-page">
      <div className="page-header">
        <div className="terminal-header-row">
          <div>
            <h1>Terminal</h1>
            {cwd && <p className="terminal-cwd">{cwd}</p>}
          </div>
          <button className="btn btn-secondary btn-sm" onClick={clearTerminal}>
            Clear
          </button>
        </div>
      </div>

      <div className="terminal-output" ref={terminalRef}>
        {lines.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">⌘</div>
            <div className="empty-state-text">
              Run terminal commands remotely.<br />
              Commands execute in your project directory.
            </div>
          </div>
        ) : (
          lines.map((line, i) => (
            <div key={i} className={`terminal-line ${line.type}`}>
              {line.type === 'command' && <span className="prompt">$ </span>}
              {line.type === 'desktop' && <span className="prompt-desktop"></span>}
              <span className="line-text">{line.text}</span>
            </div>
          ))
        )}
        {running && (
          <div className="terminal-line running">
            <span className="dot dot-yellow dot-pulse" /> Running...
          </div>
        )}
      </div>

      <div className="terminal-input-area">
        <div className="input-group">
          <span className="terminal-prompt-char">$</span>
          <input
            ref={inputRef}
            className="input terminal-input"
            type="text"
            placeholder={running ? 'Running...' : 'Enter command...'}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && runCommand()}
            disabled={running}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck="false"
          />
          <button
            className="btn btn-primary send-btn"
            onClick={runCommand}
            disabled={running || !input.trim()}
          >
            ↑
          </button>
        </div>
      </div>
    </div>
  );
}

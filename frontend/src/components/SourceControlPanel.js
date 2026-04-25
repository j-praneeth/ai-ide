import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  VscFile,
  VscHistory,
  VscRefresh,
  VscAdd,
  VscRemove,
  VscCheck,
  VscSourceControl,
  VscChevronDown,
  VscChevronRight,
  VscEllipsis,
  VscGitMerge,
  VscClose,
  VscDiscard,
  VscArrowDown,
  VscArrowUp,
  VscCloud,
  VscTarget,
  VscSparkle,
} from 'react-icons/vsc';
import axios from 'axios';
import { API_URL as API } from '../config';

async function runCommand(command) {
  const res = await axios.post(`${API}/terminal/run`, null, {
    params: { command },
  });
  return { output: res.data.output ?? '', exit_code: res.data.exit_code ?? 0 };
}

function parsePorcelain(output) {
  const staged = [];
  const unstaged = [];
  const lines = (output || '').trim().split('\n').filter(Boolean);
  for (const line of lines) {
    const code0 = line[0] || ' ';
    const code1 = line[1] || ' ';
    let path = line.slice(3).trim();
    if (path.includes(' -> ')) {
      path = path.split(' -> ')[1].trim();
    }
    path = path.replace(/^"(.*)"$/, '$1').trim();
    if (!path) continue;

    const isStaged = code0 !== ' ' && code0 !== '?';
    const isUnstaged = (code1 !== ' ' && code1 !== '?') || code0 === '?';

    const stagedStatus = code0 === '?' ? 'untracked' : code0;
    const unstagedStatus = code1 === '?' ? 'untracked' : code1;

    if (isStaged) {
      staged.push({ path, status: stagedStatus });
    }
    if (isUnstaged) {
      unstaged.push({ path, status: code0 === '?' ? 'untracked' : unstagedStatus });
    }
  }
  return { staged, unstaged };
}

function getFileInfo(fullPath) {
  const parts = fullPath.split('/');
  const name = parts.pop();
  const dir = parts.join('/');
  return { name, dir };
}

const GRAPH_COLORS = [
  '#3b82f6', // blue (primary)
  '#60a5fa', // light blue
  '#2563eb', // dark blue
  '#9333ea', // purple
  '#ec4899', // pink
  '#f59e0b', // amber
  '#10b981', // green
];

function parseGraphLines(lines) {
  const entries = [];

  for (const line of lines) {
    const match = line.match(/^([*\s|/\\]+)\s*([a-f0-9]{7,})\s+(.+)$/);
    if (!match) continue;
    const [, graphSymbols, hash, rest] = match;
    let message = rest;
    let branchName = '';
    let remoteRef = '';
    
    // Refs parsing
    const refParenMatch = rest.match(/\(([^)]+)\)/);
    if (refParenMatch) {
      const refsStr = refParenMatch[1];
      if (refsStr.includes('HEAD ->') || refsStr.includes('origin/') || refsStr.includes('upstream/')) {
        message = rest.replace(/\s*\([^)]+\)\s*/, ' ').trim();
        const refs = refsStr.split(/,\s*/);
        for (const r of refs) {
          if (r.startsWith('HEAD -> ')) {
            branchName = r.replace(/^HEAD -> \s*/, '').trim();
          } else if (r.includes('/') && (r.startsWith('origin/') || r.startsWith('upstream/'))) {
            remoteRef = r.trim();
          }
        }
      }
    }

    // Advanced symbol analysis for rendering
    // Each character position is a column
    const symbols = graphSymbols.split('');
    const colInfo = symbols.map((char, idx) => {
      if (char === ' ') return null;
      return { char, col: idx };
    }).filter(Boolean);

    entries.push({
      hash,
      message: message.trim(),
      isHead: entries.length === 0,
      branchName,
      remoteRef,
      graphSymbols: graphSymbols.trimEnd(),
      colInfo,
    });
  }
  return entries;
}

// Inline diff viewer for a file
function DiffViewer({ path, isStaged, onClose }) {
  const [diff, setDiff] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const cmd = isStaged
      ? `git diff --cached -- ${JSON.stringify(path)}`
      : `git diff -- ${JSON.stringify(path)}`;
    runCommand(cmd).then(res => {
      setDiff(res.output || '(No diff available — new or binary file)');
      setLoading(false);
    }).catch(() => {
      setDiff('Failed to load diff.');
      setLoading(false);
    });
  }, [path, isStaged]);

  return (
    <div className="scm-diff-viewer">
      <div className="scm-diff-header">
        <span className="scm-diff-path">{path}</span>
        <button className="scm-icon-btn" onClick={onClose} title="Close diff"><VscClose size={14} /></button>
      </div>
      <div className="scm-diff-content">
        {loading ? <div style={{ padding: 12, color: 'var(--text-muted)' }}>Loading diff...</div> : (
          <pre className="scm-diff-pre">
            {diff.split('\n').map((line, i) => {
              let cls = 'scm-diff-line';
              if (line.startsWith('+') && !line.startsWith('+++')) cls += ' added';
              else if (line.startsWith('-') && !line.startsWith('---')) cls += ' removed';
              else if (line.startsWith('@@')) cls += ' hunk';
              return <div key={i} className={cls}>{line}</div>;
            })}
          </pre>
        )}
      </div>
    </div>
  );
}

function GitGraphSVG({ colInfo, isLast, nextColInfo }) {
  const colWidth = 14;
  const height = 24;
  const dotRadius = 3;
  const strokeWidth = 2;
  
  const maxCol = Math.max(
    ...colInfo.map(c => c.col),
    ...(nextColInfo ? nextColInfo.map(c => c.col) : [])
  );
  const width = (maxCol + 1) * colWidth + 8;

  return (
    <svg width={width} height={height} className="scm-graph-svg" style={{ overflow: 'visible', flexShrink: 0 }}>
      {colInfo.map((c, i) => {
        const color = GRAPH_COLORS[c.col % GRAPH_COLORS.length];
        const x = c.col * colWidth + 10;
        const centerY = height / 2;

        const elements = [];

        // 1. Connection from top
        elements.push(
          <line key={`top-${i}`} x1={x} y1={0} x2={x} y2={centerY} stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
        );

        // 2. Connection to next row
        if (!isLast && nextColInfo) {
          const nextSame = nextColInfo.find(nc => nc.col === c.col);
          const nextLeft = nextColInfo.find(nc => nc.col === c.col - 1 && (nc.char === '/' || nc.char === '*'));
          const nextRight = nextColInfo.find(nc => nc.col === c.col + 1 && (nc.char === '\\' || nc.char === '*'));

          if (nextSame) {
            elements.push(
              <line key={`bot-s-${i}`} x1={x} y1={centerY} x2={x} y2={height} stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
            );
          }
          if (nextLeft) {
            const tx = (c.col - 1) * colWidth + 10;
            elements.push(
              <path key={`bot-l-${i}`} d={`M ${x} ${centerY} L ${tx} ${height}`} fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
            );
          }
          if (nextRight) {
            const tx = (c.col + 1) * colWidth + 10;
            elements.push(
              <path key={`bot-r-${i}`} d={`M ${x} ${centerY} L ${tx} ${height}`} fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
            );
          }
        } else if (!isLast) {
          elements.push(
            <line key={`bot-d-${i}`} x1={x} y1={centerY} x2={x} y2={height} stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
          );
        }

        // 3. Commit dot
        if (c.char === '*') {
          elements.push(
            <g key={`dot-g-${i}`}>
              <circle 
                cx={x} cy={centerY} r={dotRadius} 
                fill={color} 
              />
              <circle 
                cx={x} cy={centerY} r={dotRadius / 1.8} 
                fill="white" 
                opacity="0.8"
              />
            </g>
          );
        }

        return <React.Fragment key={i}>{elements}</React.Fragment>;
      })}
    </svg>
  );
}

export default function SourceControlPanel({ onOpenFile }) {
  const [branch, setBranch] = useState('');
  const [statusOutput, setStatusOutput] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [commitMessage, setCommitMessage] = useState('');
  const [committing, setCommitting] = useState(false);
  const [sectionsCollapsed, setSectionsCollapsed] = useState({ changesSection: false, agentReview: true, staged: false, changes: false, graph: false });
  const [viewingDiff, setViewingDiff] = useState(null); // { path, isStaged }
  const [graphLines, setGraphLines] = useState([]);
  const [graphEntries, setGraphEntries] = useState([]); // parsed { message, isHead, branchName, remoteRef }
  const [selectedCommit, setSelectedCommit] = useState(null);
  const [commitDetails, setCommitDetails] = useState(null);
  const [graphLoading, setGraphLoading] = useState(false);
  const [panelHeights, setPanelHeights] = useState({
    changes: 300,
    agentReview: 150,
    graph: 400
  });

  const isResizing = useRef(null);

  const fetchGraph = useCallback(async () => {
    setGraphLoading(true);
    try {
      const res = await runCommand('git log --oneline --graph --decorate -30');
      const lines = (res.output || '').trim().split('\n').filter(Boolean);
      setGraphLines(lines);
      const entries = parseGraphLines(lines);
      setGraphEntries(entries);
    } catch (_) {
      setGraphLines([]);
      setGraphEntries([]);
    } finally {
      setGraphLoading(false);
    }
  }, []);

  const fetchStatus = useCallback(async () => {
    setError(null);
    try {
      const [statusRes, branchRes] = await Promise.all([
        runCommand('git status --porcelain -uall'),
        runCommand('git branch --show-current'),
      ]);
      if (statusRes.exit_code !== 0) {
        setStatusOutput(null);
        setError(statusRes.output || 'Not a git repository');
        setBranch('');
        return;
      }
      setStatusOutput(statusRes.output);
      setBranch((branchRes.output || '').trim());
    } catch (err) {
      setStatusOutput(null);
      setError(err.message || 'Not a git repository');
      setBranch('');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);

  const hasRepo = !error && statusOutput !== null;
  const { staged = [], unstaged = [] } = hasRepo ? parsePorcelain(statusOutput) : {};

  useEffect(() => {
    if (hasRepo && sectionsCollapsed.graph === false && graphLines.length === 0 && !graphLoading) {
      fetchGraph();
    }
  }, [hasRepo, sectionsCollapsed.graph, graphLines.length, graphLoading, fetchGraph]);

  useEffect(() => {
    if (!statusOutput && error) return;
    const id = setInterval(fetchStatus, 8000);
    return () => clearInterval(id);
  }, [fetchStatus, statusOutput, error]);

  const hasStaged = staged.length > 0;
  const canCommit = hasStaged && commitMessage.trim();

  const handleStage = async (path) => {
    try { await runCommand(`git add ${JSON.stringify(path)}`); await fetchStatus(); } catch (e) { setError(e.message); }
  };
  const handleUnstage = async (path) => {
    try { await runCommand(`git reset HEAD ${JSON.stringify(path)}`); await fetchStatus(); } catch (e) { setError(e.message); }
  };
  const handleDiscard = async (path) => {
    if (!window.confirm(`Discard changes in ${path}?`)) return;
    try { await runCommand(`git checkout -- ${JSON.stringify(path)}`); await fetchStatus(); } catch (e) { setError(e.message); }
  };
  const handleCommit = async () => {
    if (!canCommit) return;
    setCommitting(true);
    try {
      const msg = commitMessage.trim().replace(/"/g, '\\"');
      await runCommand(`git commit -m "${msg}"`);
      setCommitMessage('');
      await fetchStatus();
    } catch (err) { setError(err.output ?? err.message); }
    setCommitting(false);
  };
  const handleRefresh = () => { setLoading(true); fetchStatus().then(() => setLoading(false)); };
  const toggleSection = (key) => { setSectionsCollapsed(prev => ({ ...prev, [key]: !prev[key] })); };

  const handlePush = async () => {
    setLoading(true);
    try {
      await runCommand('git push');
      await fetchStatus();
    } catch (err) { setError(err.output ?? err.message); }
    setLoading(false);
  };

  const handlePull = async () => {
    setLoading(true);
    try {
      await runCommand('git pull');
      await fetchStatus();
    } catch (err) { setError(err.output ?? err.message); }
    setLoading(false);
  };

  const handleFetch = async () => {
    setLoading(true);
    try {
      await runCommand('git fetch');
      await fetchStatus();
    } catch (err) { setError(err.output ?? err.message); }
    setLoading(false);
  };

  const handleResizeStart = (e, panel) => {
    e.preventDefault();
    isResizing.current = {
      panel,
      startY: e.clientY,
      startHeight: panelHeights[panel]
    };
    document.addEventListener('mousemove', handleResizeMove);
    document.addEventListener('mouseup', handleResizeEnd);
    document.body.style.cursor = 'ns-resize';
  };

  const handleResizeMove = (e) => {
    if (!isResizing.current) return;
    const { panel, startY, startHeight } = isResizing.current;
    const delta = e.clientY - startY;
    const newHeight = Math.max(100, startHeight + delta);
    setPanelHeights(prev => ({ ...prev, [panel]: newHeight }));
  };

  const handleResizeEnd = () => {
    isResizing.current = null;
    document.removeEventListener('mousemove', handleResizeMove);
    document.removeEventListener('mouseup', handleResizeEnd);
    document.body.style.cursor = 'default';
  };

  const handleCommitClick = async (hash) => {
    if (selectedCommit === hash) {
      setSelectedCommit(null);
      setCommitDetails(null);
      return;
    }
    setSelectedCommit(hash);
    setCommitDetails(null);
    try {
      // Get full details: %H (hash), %an (author), %ae (email), %ad (date), %s (subject), %b (body)
      const res = await runCommand(`git show --quiet --format="%H%n%an%n%ae%n%ad%n%s%n%b" ${hash}`);
      if (res.exit_code === 0) {
        const lines = res.output.split('\n');
        const details = {
          hash: lines[0],
          author: lines[1],
          email: lines[2],
          date: lines[3],
          subject: lines[4],
          body: lines.slice(5).join('\n').trim(),
        };
        // Get changed files
        const filesRes = await runCommand(`git show --pretty="" --name-status ${hash}`);
        if (filesRes.exit_code === 0) {
          details.files = filesRes.output.trim().split('\n').map(line => {
            const [status, path] = line.split(/\s+/);
            return { status, path };
          });
        }
        setCommitDetails(details);
      }
    } catch (err) { console.error(err); }
  };

  if (loading && !statusOutput && !error) {
    return (
      <div className="scm-panel">
        <div className="scm-panel-header">
          <span className="scm-panel-title">SOURCE CONTROL</span>
        </div>
        <div className="scm-loading">Loading...</div>
      </div>
    );
  }

  // If viewing a diff, show it
  if (viewingDiff) {
    return (
      <div className="scm-panel">
        <div className="scm-panel-header">
          <span className="scm-panel-title">SOURCE CONTROL</span>
          <div className="scm-panel-actions">
            <button className="scm-icon-btn" title="Back" onClick={() => setViewingDiff(null)}>
              <VscClose size={14} />
            </button>
          </div>
        </div>
        <DiffViewer
          path={viewingDiff.path}
          isStaged={viewingDiff.isStaged}
          onClose={() => setViewingDiff(null)}
        />
      </div>
    );
  }

  return (
    <div className="scm-panel">
      {/* Header */}
      <div className="scm-panel-header">
        <span className="scm-panel-title">Source Control</span>
        <div className="scm-panel-actions" style={{ marginLeft: 'auto', display: 'flex', gap: '8px' }}>
          <button className="scm-icon-btn" title="View History" onClick={() => toggleSection('historySection')}>
            <VscHistory size={16} />
          </button>
          <button className="scm-icon-btn" title="Refresh" onClick={handleRefresh}>
            <VscRefresh size={16} />
          </button>
          <button className="scm-icon-btn" title="More Actions...">
            <VscEllipsis size={16} />
          </button>
        </div>
      </div>

      {!hasRepo ? (
        <div className="scm-empty">
          <VscSourceControl size={40} className="scm-empty-icon" />
          <p className="scm-empty-text">
            {error && typeof error === 'string' ? error : 'No git repository found.'}
          </p>
          <button
            className="scm-btn primary"
            onClick={async () => {
              setLoading(true);
              try { await runCommand('git init'); await fetchStatus(); } catch (e) { setError(e.message); }
              setLoading(false);
            }}
          >
            Initialize Repository
          </button>
        </div>
      ) : (
        <div className="scm-panel-body">
          {/* Main SCM Content (Repository, Commit, Changes) */}
          <div className="scm-panel-main" style={{ height: sectionsCollapsed.changesSection ? 'auto' : panelHeights.changes }}>
            {/* Commit section redesigned */}
            <div className="scm-commit-section">
              <div className="scm-commit-input-container">
                <input
                  className="scm-commit-input"
                  placeholder={`Message (Ctrl+Enter to commit on "${branch || 'main'}")`}
                  value={commitMessage}
                  onChange={(e) => setCommitMessage(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                      handleCommit();
                    }
                  }}
                />
                <div className="scm-commit-sparkle" title="AI Commit Message">
                  <VscSparkle size={14} />
                </div>
              </div>
              
              <div className="scm-commit-btn-split">
                <button 
                  className="scm-commit-btn-main" 
                  onClick={handleCommit}
                  disabled={!canCommit || committing}
                >
                  <VscCheck size={16} />
                  <span>{committing ? 'Committing...' : 'Commit'}</span>
                </button>
                <button className="scm-commit-btn-arrow">
                  <VscChevronDown size={14} />
                </button>
              </div>
            </div>

            {/* Changes sections */}
            <div className="scm-changes-list">
              {hasRepo && staged.length > 0 && (
                <div className="scm-section scm-subsection">
                  <div className="scm-section-header" onClick={() => toggleSection('staged')}>
                    <div className="scm-section-toggle">
                      {sectionsCollapsed.staged ? <VscChevronRight size={14} /> : <VscChevronDown size={14} />}
                    </div>
                    <span className="scm-section-title">Staged</span>
                    <span className="scm-section-count">{staged.length}</span>
                  </div>
                  {!sectionsCollapsed.staged && (
                    <div className="scm-file-list">
                     {staged.map((file) => {
                       const { name, dir } = getFileInfo(file.path);
                       const ext = name.split('.').pop()?.toUpperCase() || '';
                       return (
                         <div key={file.path} className="scm-file-row" onClick={() => setViewingDiff({ path: file.path, isStaged: true })}>
                           <div className="scm-file-type-icon">{ext === 'JS' || ext === 'TS' ? ext : <VscFile size={14} />}</div>
                           <span className="scm-file-name">{name}</span>
                           <span className="scm-file-dir">{dir}</span>
                           <span className="scm-file-status">{file.status}</span>
                           <button className="scm-file-action" onClick={(e) => { e.stopPropagation(); handleUnstage(file.path); }}>
                             <VscRemove size={14} />
                           </button>
                         </div>
                       );
                     })}
                   </div>
                  )}
                </div>
              )}

              {hasRepo && unstaged.length > 0 && (
                <div className="scm-section scm-subsection">
                  <div className="scm-section-header" onClick={() => toggleSection('changes')}>
                    <div className="scm-section-toggle">
                      {sectionsCollapsed.changes ? <VscChevronRight size={14} /> : <VscChevronDown size={14} />}
                    </div>
                    <span className="scm-section-title">Changes</span>
                    <span className="scm-section-count">{unstaged.length}</span>
                  </div>
                  {!sectionsCollapsed.changes && (
                    <div className="scm-file-list">
                      {unstaged.map((file) => {
                        const { name, dir } = getFileInfo(file.path);
                        const ext = name.split('.').pop()?.toUpperCase() || '';
                        return (
                          <div key={file.path} className="scm-file-row" onClick={() => setViewingDiff({ path: file.path, isStaged: false })}>
                            <div className="scm-file-type-icon">{ext === 'JS' || ext === 'TS' ? ext : <VscFile size={14} />}</div>
                            <span className="scm-file-name">{name}</span>
                            <span className="scm-file-dir">{dir}</span>
                            <span className="scm-file-status">{file.status === 'untracked' ? 'U' : file.status}</span>
                            <div className="scm-file-actions">
                              <button className="scm-file-action" title="Discard Changes" onClick={(e) => { e.stopPropagation(); handleDiscard(file.path); }}>
                                <VscDiscard size={14} />
                              </button>
                              <button className="scm-file-action" title="Stage Changes" onClick={(e) => { e.stopPropagation(); handleStage(file.path); }}>
                                <VscAdd size={14} />
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* AGENT REVIEW */}
          <div className="scm-section" style={{ height: sectionsCollapsed.agentReview ? 'auto' : panelHeights.agentReview }}>
            <div className="scm-section-header" onClick={() => toggleSection('agentReview')}>
              <span className="scm-section-toggle">
                {sectionsCollapsed.agentReview ? <VscChevronRight size={14} /> : <VscChevronDown size={14} />}
              </span>
              <span className="scm-section-title">Agent Review</span>
            </div>
            {!sectionsCollapsed.agentReview && <div className="scm-resize-handle" onMouseDown={(e) => handleResizeStart(e, 'agentReview')} />}
          </div>

          {/* Graph section */}
          <div className="scm-graph-section-wrap" style={{ height: sectionsCollapsed.graph ? 'auto' : panelHeights.graph }}>
            <div className="scm-section scm-section-graph">
              <div className="scm-section-header" onClick={() => { toggleSection('graph'); if (!sectionsCollapsed.graph && graphLines.length === 0) fetchGraph(); }}>
                <span className="scm-section-toggle">
                  {sectionsCollapsed.graph ? <VscChevronRight size={14} /> : <VscChevronDown size={14} />}
                </span>
                <span className="scm-section-title">Graph</span>
                <div className="scm-graph-toolbar">
                  <span className="scm-graph-toolbar-auto">Auto</span>
                  <button className="scm-icon-btn" title="Push" type="button" onClick={handlePush}><VscArrowUp size={14} /></button>
                  <button className="scm-icon-btn" title="Fetch" type="button" onClick={handleFetch}><VscTarget size={14} /></button>
                  <button className="scm-icon-btn" title="Pull" type="button" onClick={handlePull}><VscArrowDown size={14} /></button>
                </div>
              </div>
              {!sectionsCollapsed.graph && (
                <div className="scm-graph-container">
                  {graphLoading ? (
                    <div className="scm-graph-loading">Loading...</div>
                  ) : graphEntries.length > 0 ? (
                    <div className="scm-graph-list">
                      {graphEntries.map((entry, i) => (
                        <React.Fragment key={`${entry.hash}-${i}`}>
                          <div
                            className={`scm-graph-row ${selectedCommit === entry.hash ? 'selected' : ''}`}
                            onClick={() => handleCommitClick(entry.hash)}
                          >
                            <GitGraphSVG
                              colInfo={entry.colInfo}
                              isLast={i === graphEntries.length - 1}
                              nextColInfo={graphEntries[i + 1]?.colInfo}
                            />
                            <span className="scm-graph-commit-msg">{entry.message}</span>
                            <div className="scm-graph-pills">
                              {entry.branchName && (
                                <span className="scm-graph-pill branch">
                                  <VscGitMerge size={10} />
                                  {entry.branchName}
                                </span>
                              )}
                              {entry.remoteRef && (
                                <span className="scm-graph-pill remote">
                                  <VscCloud size={10} />
                                  {entry.remoteRef}
                                </span>
                              )}
                            </div>
                          </div>
                          {selectedCommit === entry.hash && commitDetails && (
                            <div className="scm-commit-details">
                              <div className="scm-commit-details-header">
                                <strong>{commitDetails.author}</strong>
                                <span className="scm-commit-details-date">{commitDetails.date}</span>
                              </div>
                              <div className="scm-commit-details-body">
                                {commitDetails.subject}
                                {commitDetails.body && <div className="scm-commit-details-full">{commitDetails.body}</div>}
                              </div>
                              <div className="scm-commit-details-files">
                                {commitDetails.files?.map(file => (
                                  <div key={file.path} className="scm-commit-details-file">
                                    <span className={`scm-status-icon ${file.status}`}>{file.status}</span>
                                    <span className="scm-file-path">{file.path}</span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </React.Fragment>
                      ))}
                    </div>
                  ) : (
                    <div className="scm-no-changes">No commits</div>
                  )}
                </div>
              )}
              {!sectionsCollapsed.graph && <div className="scm-resize-handle top" onMouseDown={(e) => handleResizeStart(e, 'graph')} />}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

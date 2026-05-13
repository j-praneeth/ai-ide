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
  const res = await axios.post(
    `${API}/terminal/run`,
    { command },
    { timeout: 180000 },
  );
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
  '#3b82f6', // blue
  '#10b981', // green
  '#e8c547', // yellow
  '#ec4899', // pink
  '#9333ea', // purple
  '#ef4444', // red
  '#06b6d4', // cyan
  '#f97316', // orange
  '#8b5cf6', // violet
  '#14b8a6', // teal
  '#d946ef', // fuchsia
  '#84cc16', // lime
];

// Extracts per-character lane info from the raw graph prefix of a git log line.
// Each logical lane is 2 chars wide in git's output ("* ", "| ", etc.).
function extractLanes(graphStr) {
  const lanes = [];
  for (let i = 0; i < graphStr.length; i++) {
    const ch = graphStr[i];
    if (ch === ' ') continue;
    lanes.push({ ch, col: Math.floor(i / 2) });
  }
  return lanes;
}

// Parse `git log --graph --format="COMMIT:%H\x00%s\x00%an\x00%ar\x00%D"` output.
// Returns an array of row objects — both commit rows and connector rows.
function parseGraphOutput(raw) {
  const rows = [];
  const lines = raw.split('\n');

  for (const line of lines) {
    if (!line.trim()) continue;

    // Git --graph prefixes every line (commit or connector) with graph chars.
    const graphMatch = line.match(/^([*|/\\ ._\-+]+)/);
    const graphStr = graphMatch ? graphMatch[1] : '';
    const rest = line.slice(graphStr.length);
    const lanes = extractLanes(graphStr);

    const commitIdx = rest.indexOf('COMMIT:');
    if (commitIdx >= 0) {
      const data = rest.slice(commitIdx + 'COMMIT:'.length);
      const parts = data.split('\x00');
      const hash    = (parts[0] || '').trim();
      const message = (parts[1] || '').trim();
      const author  = (parts[2] || '').trim();
      const date    = (parts[3] || '').trim();
      const refsStr = (parts[4] || '').trim();

      let branchName = '';
      let remoteRef  = '';
      let isHead     = false;

      if (refsStr) {
        for (const r of refsStr.split(/,\s*/)) {
          const t = r.trim();
          if (t.startsWith('HEAD -> ')) {
            branchName = t.replace('HEAD -> ', '');
            isHead = true;
          } else if (t === 'HEAD') {
            isHead = true;
          } else if (t.startsWith('origin/') || t.startsWith('upstream/')) {
            if (!remoteRef) remoteRef = t;
          } else if (!t.startsWith('HEAD') && !isHead && !branchName && t && !t.includes('/')) {
            branchName = t;
          }
        }
      }

      if (hash) {
        rows.push({ type: 'commit', hash, message, author, date, branchName, remoteRef, isHead, lanes });
      }
    } else {
      // Connector row (only graph chars — no commit data)
      if (lanes.length > 0) {
        rows.push({ type: 'connector', lanes });
      }
    }
  }
  return rows;
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

// Renders one row's SVG lane segment.
// `row`      — the current row object (commit or connector)
// `prevRow`  — the row above (for top connections)
// `nextRow`  — the row below (for bottom connections)
// `isHead`   — true for the HEAD commit (draws open ring dot)
function GitGraphSVG({ row, prevRow, nextRow, isHead }) {
  const COL_W     = 16;   // px per lane column
  const ROW_H     = row.type === 'connector' ? 10 : 24;
  const STROKE    = 1.5;
  const DOT_R     = 3.5;
  const OFFSET    = 8;    // left margin

  const allCols = [
    ...row.lanes.map(l => l.col),
    ...(prevRow?.lanes || []).map(l => l.col),
    ...(nextRow?.lanes || []).map(l => l.col),
  ];
  const maxCol = allCols.length ? Math.max(...allCols) : 0;
  const svgW   = (maxCol + 1) * COL_W + OFFSET;
  const midY   = ROW_H / 2;

  const elements = [];

  // Draw connections: for every lane in this row, draw top + bottom segments
  for (const lane of row.lanes) {
    const color = GRAPH_COLORS[lane.col % GRAPH_COLORS.length];
    const x     = OFFSET + lane.col * COL_W;

    // Top connection: draw from top-edge to midY
    const hasPrevSame = prevRow?.lanes.some(l => l.col === lane.col);
    const hasPrevLeft = prevRow?.lanes.some(l => l.col === lane.col - 1 && (l.ch === '/' || l.ch === '*'));
    const hasPrevRight = prevRow?.lanes.some(l => l.col === lane.col + 1 && (l.ch === '\\' || l.ch === '*'));

    if (hasPrevSame) {
      elements.push(<line key={`t-s-${lane.col}`} x1={x} y1={0} x2={x} y2={midY} stroke={color} strokeWidth={STROKE} strokeLinecap="round" />);
    }
    if (hasPrevLeft) {
      const px = OFFSET + (lane.col - 1) * COL_W;
      elements.push(<line key={`t-l-${lane.col}`} x1={px} y1={0} x2={x} y2={midY} stroke={color} strokeWidth={STROKE} strokeLinecap="round" />);
    }
    if (hasPrevRight) {
      const px = OFFSET + (lane.col + 1) * COL_W;
      elements.push(<line key={`t-r-${lane.col}`} x1={px} y1={0} x2={x} y2={midY} stroke={color} strokeWidth={STROKE} strokeLinecap="round" />);
    }
    // If this row has no known connection above but is a | or * lane, draw from top
    if (!hasPrevSame && !hasPrevLeft && !hasPrevRight && (lane.ch === '|' || lane.ch === '*')) {
      elements.push(<line key={`t-d-${lane.col}`} x1={x} y1={0} x2={x} y2={midY} stroke={color} strokeWidth={STROKE} strokeLinecap="round" />);
    }

    // Bottom connection: draw from midY to bottom-edge
    const hasNextSame  = nextRow?.lanes.some(l => l.col === lane.col);
    const hasNextRight = nextRow?.lanes.some(l => l.col === lane.col + 1 && (l.ch === '/' || l.ch === '*'));
    const hasNextLeft  = nextRow?.lanes.some(l => l.col === lane.col - 1 && (l.ch === '\\' || l.ch === '*'));

    if (hasNextSame) {
      elements.push(<line key={`b-s-${lane.col}`} x1={x} y1={midY} x2={x} y2={ROW_H} stroke={color} strokeWidth={STROKE} strokeLinecap="round" />);
    }
    if (hasNextRight) {
      const nx = OFFSET + (lane.col + 1) * COL_W;
      elements.push(<line key={`b-r-${lane.col}`} x1={x} y1={midY} x2={nx} y2={ROW_H} stroke={color} strokeWidth={STROKE} strokeLinecap="round" />);
    }
    if (hasNextLeft) {
      const nx = OFFSET + (lane.col - 1) * COL_W;
      elements.push(<line key={`b-l-${lane.col}`} x1={x} y1={midY} x2={nx} y2={ROW_H} stroke={color} strokeWidth={STROKE} strokeLinecap="round" />);
    }
    if (!hasNextSame && !hasNextRight && !hasNextLeft && lane.ch === '|') {
      elements.push(<line key={`b-d-${lane.col}`} x1={x} y1={midY} x2={x} y2={ROW_H} stroke={color} strokeWidth={STROKE} strokeLinecap="round" />);
    }

    // Commit dot
    if (lane.ch === '*') {
      if (isHead) {
        // HEAD: open ring with colored stroke
        elements.push(
          <circle key={`dot-outer-${lane.col}`} cx={x} cy={midY} r={DOT_R} fill="#1e1e1e" stroke={color} strokeWidth={1.8} />
        );
        elements.push(
          <circle key={`dot-inner-${lane.col}`} cx={x} cy={midY} r={DOT_R - 2} fill={color} />
        );
      } else {
        // Normal: solid filled dot
        elements.push(
          <circle key={`dot-${lane.col}`} cx={x} cy={midY} r={DOT_R} fill={color} />
        );
      }
    }
  }

  return (
    <svg
      width={svgW} height={ROW_H}
      style={{ flexShrink: 0, overflow: 'visible', display: 'block' }}
    >
      {elements}
    </svg>
  );
}

export default function SourceControlPanel({ onOpenFile, hasWorkspace = true }) {
  const [branch, setBranch] = useState('');
  const [hasUpstream, setHasUpstream] = useState(false);
  const [statusOutput, setStatusOutput] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [commitMessage, setCommitMessage] = useState('');
  const [committing, setCommitting] = useState(false);
  const [sectionsCollapsed, setSectionsCollapsed] = useState({ changesSection: false, agentReview: true, staged: false, changes: false, graph: false });
  const [viewingDiff, setViewingDiff] = useState(null); // { path, isStaged }
  const [graphRows, setGraphRows] = useState([]); // all parsed rows (commit + connector)
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
    if (!hasWorkspace) return;
    setGraphLoading(true);
    try {
      // %x00 as field separator avoids conflicts with | in commit messages.
      const res = await runCommand(
        'git log --graph --format="COMMIT:%H%x00%s%x00%an%x00%ar%x00%D" -50'
      );
      const raw = (res.output || '').trim();
      setGraphRows(parseGraphOutput(raw));
    } catch (_) {
      setGraphRows([]);
    } finally {
      setGraphLoading(false);
    }
  }, [hasWorkspace]);

  const fetchStatus = useCallback(async () => {
    if (!hasWorkspace) {
      setLoading(false);
      setStatusOutput(null);
      setError(null);
      setBranch('');
      setHasUpstream(false);
      return;
    }
    setError(null);
    try {
      // Note: do NOT use -uall here — it recursively enumerates every untracked
      // file in the workspace tree which can take minutes on large projects.
      const [statusRes, branchRes, upstreamRes] = await Promise.all([
        runCommand('git status --porcelain'),
        runCommand('git branch --show-current'),
        runCommand("git rev-parse --abbrev-ref --symbolic-full-name '@{u}'"),
      ]);
      if (statusRes.exit_code !== 0) {
        setStatusOutput(null);
        setError(statusRes.output || 'Not a git repository');
        setBranch('');
        setHasUpstream(false);
        return;
      }
      setStatusOutput(statusRes.output);
      const currentBranch = (branchRes.output || '').trim();
      setBranch(currentBranch);
      // upstreamRes exit_code is 0 only when a tracking remote exists
      setHasUpstream(upstreamRes.exit_code === 0 && !!upstreamRes.output.trim());
    } catch (err) {
      setStatusOutput(null);
      setError(err.message || 'Not a git repository');
      setBranch('');
      setHasUpstream(false);
    } finally {
      setLoading(false);
    }
  }, [hasWorkspace]);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);

  const hasRepo = !error && statusOutput !== null;
  const { staged = [], unstaged = [] } = hasRepo ? parsePorcelain(statusOutput) : {};

  useEffect(() => {
    if (!hasWorkspace) return;
    if (hasRepo && sectionsCollapsed.graph === false && graphRows.length === 0 && !graphLoading) {
      fetchGraph();
    }
  }, [hasWorkspace, hasRepo, sectionsCollapsed.graph, graphRows.length, graphLoading, fetchGraph]);

  useEffect(() => {
    if (!hasWorkspace || (!statusOutput && error)) return;
    const id = setInterval(fetchStatus, 8000);
    return () => clearInterval(id);
  }, [fetchStatus, statusOutput, error, hasWorkspace]);

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
      // When the branch has no remote tracking counterpart, set one up automatically
      // so "Publish Branch" works identically to the button in VS Code / Cursor.
      const pushCmd = !hasUpstream && branch
        ? `git push --set-upstream origin ${branch}`
        : 'git push';
      await runCommand(pushCmd);
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

  if (!hasWorkspace) {
    return (
      <div className="scm-panel">
        <div className="scm-panel-header">
          <span className="scm-panel-title">SOURCE CONTROL</span>
        </div>
        <div className="scm-empty">
          <VscSourceControl size={40} className="scm-empty-icon" />
          <p className="scm-empty-text">Open a folder to use source control.</p>
        </div>
      </div>
    );
  }

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

              {/* Publish Branch — shown when the current branch has no remote upstream */}
              {hasRepo && !hasUpstream && branch && (
                <button
                  className="scm-btn primary"
                  style={{ margin: '6px 0 2px 0', width: '100%', display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'center' }}
                  onClick={handlePush}
                  disabled={loading}
                >
                  <VscCloud size={14} />
                  <span>Publish Branch</span>
                </button>
              )}
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
              <div className="scm-section-header" onClick={() => { toggleSection('graph'); if (!sectionsCollapsed.graph && graphRows.length === 0) fetchGraph(); }}>
                <span className="scm-section-toggle">
                  {sectionsCollapsed.graph ? <VscChevronRight size={14} /> : <VscChevronDown size={14} />}
                </span>
                <span className="scm-section-title">GRAPH</span>
                <div className="scm-graph-toolbar">
                  <span className="scm-graph-toolbar-auto">
                    <VscGitMerge size={11} style={{ marginRight: 3 }} /> Auto
                  </span>
                  <button className="scm-icon-btn" title="Push" type="button" onClick={(e) => { e.stopPropagation(); handlePush(); }}><VscArrowUp size={13} /></button>
                  <button className="scm-icon-btn" title="Fetch" type="button" onClick={(e) => { e.stopPropagation(); handleFetch(); }}><VscTarget size={13} /></button>
                  <button className="scm-icon-btn" title="Pull" type="button" onClick={(e) => { e.stopPropagation(); handlePull(); }}><VscArrowDown size={13} /></button>
                  <button className="scm-icon-btn" title="Refresh Graph" type="button" onClick={(e) => { e.stopPropagation(); fetchGraph(); }}><VscRefresh size={13} /></button>
                </div>
              </div>
              {!sectionsCollapsed.graph && (
                <div className="scm-graph-container">
                  {graphLoading ? (
                    <div className="scm-graph-loading">Loading graph…</div>
                  ) : graphRows.length > 0 ? (
                    <div className="scm-graph-list">
                      {graphRows.map((row, i) => {
                        if (row.type === 'connector') {
                          return (
                            <div key={`c-${i}`} className="scm-graph-connector-row">
                              <GitGraphSVG row={row} prevRow={graphRows[i - 1]} nextRow={graphRows[i + 1]} isHead={false} />
                            </div>
                          );
                        }
                        // Commit row
                        const isSelected = selectedCommit === row.hash;
                        const isFirstCommit = i === 0;
                        return (
                          <React.Fragment key={`${row.hash}-${i}`}>
                            <div
                              className={`scm-graph-row${isSelected ? ' selected' : ''}`}
                              onClick={() => handleCommitClick(row.hash)}
                              title={`${row.hash} · ${row.author}`}
                            >
                              <GitGraphSVG
                                row={row}
                                prevRow={graphRows[i - 1]}
                                nextRow={graphRows[i + 1]}
                                isHead={isFirstCommit}
                              />
                              <div className="scm-graph-row-content">
                                <div className="scm-graph-row-top">
                                  <span className="scm-graph-commit-msg">{row.message}</span>
                                  <div className="scm-graph-pills">
                                    {row.branchName && (
                                      <span className="scm-graph-pill branch">
                                        <VscGitMerge size={10} />
                                        {row.branchName}
                                      </span>
                                    )}
                                    {row.remoteRef && (
                                      <span className="scm-graph-pill remote">
                                        <VscCloud size={10} />
                                      </span>
                                    )}
                                  </div>
                                </div>
                                <div className="scm-graph-row-bottom">
                                  <span className="scm-graph-author">{row.author}</span>
                                  <span className="scm-graph-date">{row.date}</span>
                                </div>
                              </div>
                            </div>
                            {isSelected && commitDetails && (
                              <div className="scm-commit-details">
                                <div className="scm-commit-details-header">
                                  <span className="scm-commit-details-hash">{commitDetails.hash?.slice(0, 7)}</span>
                                  <strong className="scm-commit-details-author">{commitDetails.author}</strong>
                                  <span className="scm-commit-details-date">{commitDetails.date}</span>
                                </div>
                                <div className="scm-commit-details-body">{commitDetails.subject}</div>
                                {commitDetails.body && (
                                  <div className="scm-commit-details-full">{commitDetails.body}</div>
                                )}
                                <div className="scm-commit-details-files">
                                  {commitDetails.files?.map((file, fi) => (
                                    <div key={`${file.path}-${fi}`} className="scm-commit-details-file">
                                      <span className={`scm-status-icon ${file.status}`}>{file.status}</span>
                                      <span className="scm-file-path">{file.path}</span>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                          </React.Fragment>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="scm-no-changes">No commits found</div>
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

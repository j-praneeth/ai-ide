import React, { useState, useEffect, useCallback } from 'react';
import {
  VscDiffAdded,
  VscDiffModified,
  VscDiffRemoved,
  VscRefresh,
  VscAdd,
  VscRemove,
  VscCheck,
  VscSourceControl,
  VscChevronDown,
  VscChevronRight,
  VscEllipsis,
  VscGitMerge,
  VscSync,
  VscClose,
  VscDiscard,
  VscArrowDown,
  VscArrowUp,
  VscCloud,
  VscTarget,
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

function StatusBadge({ status }) {
  const letter = status === 'untracked' ? 'U'
    : status === 'A' ? 'A'
    : status === 'M' ? 'M'
    : status === 'D' ? 'D'
    : status === 'R' ? 'R'
    : status;

  const color = status === 'untracked' ? '#73c991'
    : status === 'A' ? '#73c991'
    : status === 'D' ? '#f87171'
    : (status === 'M' || status === 'R') ? '#e2c08d'
    : '#999';

  return <span className="scm-status-badge" style={{ color }}>{letter}</span>;
}

function getFileInfo(fullPath) {
  const parts = fullPath.split('/');
  const name = parts.pop();
  const dir = parts.join('/');
  return { name, dir };
}

function parseGraphLines(lines) {
  const entries = [];
  for (const line of lines) {
    const match = line.match(/^([*\s|/\\]+)\s*([a-f0-9]{7,})\s+(.+)$/);
    if (!match) continue;
    const [, , hash, rest] = match;
    let message = rest;
    let branchName = '';
    let remoteRef = '';
    // Refs can be at end: "msg (HEAD -> x, origin/y)" or after hash: "(HEAD -> x, origin/y) msg"
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
    entries.push({
      hash,
      message: message.trim(),
      isHead: entries.length === 0,
      branchName,
      remoteRef,
    });
  }
  return entries;
}

function FileIcon({ status }) {
  if (status === 'A' || status === 'untracked') return <VscDiffAdded size={14} style={{ color: '#73c991', flexShrink: 0 }} />;
  if (status === 'D') return <VscDiffRemoved size={14} style={{ color: '#f87171', flexShrink: 0 }} />;
  if (status === 'M' || status === 'R') return <VscDiffModified size={14} style={{ color: '#e2c08d', flexShrink: 0 }} />;
  return <VscDiffModified size={14} style={{ color: '#999', flexShrink: 0 }} />;
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

export default function SourceControlPanel({ onOpenFile }) {
  const [branch, setBranch] = useState('');
  const [repoName, setRepoName] = useState('');
  const [statusOutput, setStatusOutput] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [commitMessage, setCommitMessage] = useState('');
  const [committing, setCommitting] = useState(false);
  const [sectionsCollapsed, setSectionsCollapsed] = useState({ changesSection: false, agentReview: true, staged: false, changes: false, graph: false });
  const [viewingDiff, setViewingDiff] = useState(null); // { path, isStaged }
  const [graphLines, setGraphLines] = useState([]);
  const [graphEntries, setGraphEntries] = useState([]); // parsed { message, isHead, branchName, remoteRef }
  const [graphLoading, setGraphLoading] = useState(false);

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
      const [statusRes, branchRes, repoRootRes] = await Promise.all([
        runCommand('git status --porcelain -uall'),
        runCommand('git branch --show-current'),
        runCommand('git rev-parse --show-toplevel'),
      ]);
      if (statusRes.exit_code !== 0) {
        setStatusOutput(null);
        setError(statusRes.output || 'Not a git repository');
        setBranch('');
        setRepoName('');
        return;
      }
      setStatusOutput(statusRes.output);
      setBranch((branchRes.output || '').trim());
      // Extract folder name from the git root path
      const rootPath = (repoRootRes.output || '').trim();
      if (rootPath) {
        const parts = rootPath.replace(/\\/g, '/').split('/');
        setRepoName(parts[parts.length - 1] || '');
      }
    } catch (err) {
      setStatusOutput(null);
      setError(err.message || 'Not a git repository');
      setBranch('');
      setRepoName('');
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
  const handleStageAll = async () => {
    try { await runCommand('git add -A'); await fetchStatus(); } catch (e) { setError(e.message); }
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
        <span className="scm-panel-title">SOURCE CONTROL</span>
        <div className="scm-panel-actions">
          <button className="scm-icon-btn" title="Refresh" onClick={handleRefresh} disabled={loading}>
            <VscRefresh size={14} />
          </button>
          <button className="scm-icon-btn" title="More Actions">
            <VscEllipsis size={14} />
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
          {/* CHANGES section first (match reference image) */}
          <div className="scm-section scm-section-changes">
            <div className="scm-section-header" onClick={() => toggleSection('changesSection')}>
              <span className="scm-section-toggle">
                {sectionsCollapsed.changesSection ? <VscChevronRight size={14} /> : <VscChevronDown size={14} />}
              </span>
              <span className="scm-section-title">Changes</span>
            </div>
            {!sectionsCollapsed.changesSection && (
              <div className="scm-panel-main">
          {/* Repository row */}
          <div className="scm-repo-row">
            <VscGitMerge size={14} className="scm-repo-icon" />
            <span className="scm-repo-name">{repoName || 'Repository'}</span>
            <span className="scm-branch-name">{branch || 'HEAD'}</span>
            <div className="scm-repo-actions">
              <button className="scm-icon-btn" title="Sync Changes" onClick={handleRefresh}>
                <VscSync size={13} />
              </button>
              <button className="scm-icon-btn" title="Refresh">
                <VscRefresh size={13} />
              </button>
            </div>
          </div>

          {/* Commit message + button */}
          <div className="scm-commit-section">
            <div className="scm-commit-input-wrapper">
              <input
                className="scm-commit-input"
                placeholder={branch ? `Message (⌘↵ to commit on '${branch}')` : "Message (⌘↵ to commit)"}
                value={commitMessage}
                onChange={e => setCommitMessage(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleCommit();
                }}
              />
            </div>
            <button
              className={`scm-commit-btn ${canCommit ? 'active' : ''}`}
              onClick={handleCommit}
              disabled={!canCommit || committing}
            >
              <VscCheck size={14} />
              <span>Commit</span>
            </button>
          </div>

          {/* Staged Changes */}
          {hasStaged && (
            <div className="scm-section">
              <div className="scm-section-header" onClick={() => toggleSection('staged')}>
                <span className="scm-section-toggle">
                  {sectionsCollapsed.staged ? <VscChevronRight size={14} /> : <VscChevronDown size={14} />}
                </span>
                <span className="scm-section-title">Staged Changes</span>
                <span className="scm-section-count">{staged.length}</span>
              </div>
              {!sectionsCollapsed.staged && (
                <div className="scm-file-list">
                  {staged.map(({ path, status }) => {
                    const { name, dir } = getFileInfo(path);
                    return (
                      <div key={`s-${path}`} className="scm-file-row"
                        onClick={() => { if (onOpenFile) onOpenFile(path); }}
                        onDoubleClick={() => setViewingDiff({ path, isStaged: true })}>
                        <FileIcon status={status} />
                        <span className="scm-file-name">{name}</span>
                        <span className="scm-file-dir">{dir}</span>
                        <StatusBadge status={status} />
                        <button className="scm-file-action" title="Unstage" onClick={(e) => { e.stopPropagation(); handleUnstage(path); }}>
                          <VscRemove size={14} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Changes (unstaged) list */}
          <div className="scm-section scm-subsection">
            <div className="scm-section-header" onClick={() => toggleSection('changes')}>
              <span className="scm-section-toggle">
                {sectionsCollapsed.changes ? <VscChevronRight size={14} /> : <VscChevronDown size={14} />}
              </span>
              <span className="scm-section-title">Changes</span>
              <span className="scm-section-count">{unstaged.length}</span>
              {unstaged.length > 0 && (
                <button className="scm-file-action stage-all" title="Stage All Changes" onClick={(e) => { e.stopPropagation(); handleStageAll(); }}>
                  <VscAdd size={14} />
                </button>
              )}
            </div>
            {!sectionsCollapsed.changes && (
              <div className="scm-file-list">
                {unstaged.map(({ path, status }) => {
                  const { name, dir } = getFileInfo(path);
                  return (
                    <div key={`u-${path}`} className="scm-file-row"
                      onClick={() => { if (onOpenFile) onOpenFile(path); }}
                      onDoubleClick={() => setViewingDiff({ path, isStaged: false })}>
                      <FileIcon status={status} />
                      <span className="scm-file-name">{name}</span>
                      <span className="scm-file-dir">{dir}</span>
                      <StatusBadge status={status} />
                      <div className="scm-file-actions-group">
                        {status !== 'untracked' && (
                          <button className="scm-file-action" title="Discard Changes" onClick={(e) => { e.stopPropagation(); handleDiscard(path); }}>
                            <VscDiscard size={14} />
                          </button>
                        )}
                        <button className="scm-file-action" title="Stage" onClick={(e) => { e.stopPropagation(); handleStage(path); }}>
                          <VscAdd size={14} />
                        </button>
                      </div>
                    </div>
                  );
                })}
                {unstaged.length === 0 && !hasStaged && (
                  <div className="scm-no-changes">No changes</div>
                )}
              </div>
            )}
          </div>
              </div>
            )}
          </div>

          {/* AGENT REVIEW - collapsed */}
          <div className="scm-section">
            <div className="scm-section-header" onClick={() => toggleSection('agentReview')}>
              <span className="scm-section-toggle">
                {sectionsCollapsed.agentReview ? <VscChevronRight size={14} /> : <VscChevronDown size={14} />}
              </span>
              <span className="scm-section-title">Agent Review</span>
            </div>
          </div>

          {/* Graph section - at bottom, fills remaining space */}
          <div className="scm-graph-section-wrap">
            <div className="scm-section scm-section-graph">
              <div className="scm-section-header" onClick={() => { toggleSection('graph'); if (!sectionsCollapsed.graph && graphLines.length === 0) fetchGraph(); }}>
                <span className="scm-section-toggle">
                  {sectionsCollapsed.graph ? <VscChevronRight size={14} /> : <VscChevronDown size={14} />}
                </span>
                <span className="scm-section-title">Graph</span>
                <div className="scm-graph-toolbar">
                  <span className="scm-graph-toolbar-auto">Auto</span>
                  <button className="scm-icon-btn" title="Branch" type="button"><VscGitMerge size={14} /></button>
                  <button className="scm-icon-btn" title="Fetch" type="button"><VscTarget size={14} /></button>
                  <button className="scm-icon-btn" title="Pull" type="button"><VscArrowDown size={14} /></button>
                  <button className="scm-icon-btn" title="Pull (rebase)" type="button"><VscArrowDown size={14} /></button>
                  <button className="scm-icon-btn" title="Push" type="button"><VscArrowUp size={14} /></button>
                  <button className="scm-icon-btn" title="Refresh graph" type="button" onClick={(e) => { e.stopPropagation(); fetchGraph(); }} disabled={graphLoading}>
                    <VscRefresh size={14} />
                  </button>
                </div>
              </div>
              {!sectionsCollapsed.graph && (
                <div className="scm-graph-container">
                  {graphLoading ? (
                    <div className="scm-graph-loading">Loading...</div>
                  ) : graphEntries.length > 0 ? (
                    <div className="scm-graph-list">
                      {graphEntries.map((entry, i) => (
                        <div key={`${entry.hash}-${i}`} className="scm-graph-row scm-graph-row-has-tooltip">
                          <div className="scm-graph-tooltip">
                            <div className="scm-graph-tooltip-hash">{entry.hash}</div>
                            <div className="scm-graph-tooltip-msg">{entry.message}</div>
                          </div>
                          <div className="scm-graph-line-col">
                            {i < graphEntries.length - 1 && <span className="scm-graph-vline" />}
                            <span className={`scm-graph-dot ${entry.isHead ? 'empty' : ''}`} />
                          </div>
                          <span className="scm-graph-commit-msg">
                            {entry.message.length > 42 ? entry.message.slice(0, 42) + '...' : entry.message}
                          </span>
                          <div className="scm-graph-pills">
                            {entry.branchName && (
                              <span className="scm-graph-pill branch">
                                <VscTarget size={12} />
                                {entry.branchName}
                              </span>
                            )}
                            {entry.branchName && (
                              <span className="scm-graph-pill cloud-icon" title="Remote tracking">
                                <VscCloud size={14} />
                              </span>
                            )}
                            {entry.remoteRef && (
                              <span className="scm-graph-pill remote">
                                <VscCloud size={12} />
                                {entry.remoteRef}
                              </span>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="scm-no-changes">No commits</div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

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
  const [sectionsCollapsed, setSectionsCollapsed] = useState({ staged: false, changes: false });
  const [viewingDiff, setViewingDiff] = useState(null); // { path, isStaged }

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

  useEffect(() => {
    if (!statusOutput && error) return;
    const id = setInterval(fetchStatus, 8000);
    return () => clearInterval(id);
  }, [fetchStatus, statusOutput, error]);

  const hasRepo = !error && statusOutput !== null;
  const { staged = [], unstaged = [] } = hasRepo ? parsePorcelain(statusOutput) : {};
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
        <>
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
                placeholder="Message (⌘⏎ to commit)"
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

          {/* Changes (unstaged) */}
          <div className="scm-section">
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
        </>
      )}
    </div>
  );
}

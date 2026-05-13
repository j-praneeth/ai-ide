import React, { useState, useEffect, useCallback, useRef, memo } from 'react';
import {
  VscFile, VscRefresh, VscAdd, VscRemove, VscCheck,
  VscSourceControl, VscChevronDown, VscChevronRight, VscEllipsis,
  VscGitMerge, VscClose, VscDiscard, VscArrowDown, VscArrowUp,
  VscCloud, VscTarget, VscSparkle, VscTag, VscCircleSlash,
} from 'react-icons/vsc';
import axios from 'axios';
import { API_URL as API } from '../config';

// ─── Backend runner ───────────────────────────────────────────────────────────
async function runCommand(command) {
  const res = await axios.post(`${API}/terminal/run`, { command }, { timeout: 180000 });
  return { output: res.data.output ?? '', exit_code: res.data.exit_code ?? 0 };
}

// ─── Git porcelain parser ─────────────────────────────────────────────────────
function parsePorcelain(output) {
  const staged = [], unstaged = [];
  for (const line of (output || '').trim().split('\n').filter(Boolean)) {
    const code0 = line[0] || ' ', code1 = line[1] || ' ';
    let path = line.slice(3).trim();
    if (path.includes(' -> ')) path = path.split(' -> ')[1].trim();
    path = path.replace(/^"(.*)"$/, '$1').trim();
    if (!path) continue;
    if (code0 !== ' ' && code0 !== '?') staged.push({ path, status: code0 === '?' ? 'untracked' : code0 });
    if ((code1 !== ' ' && code1 !== '?') || code0 === '?') unstaged.push({ path, status: code0 === '?' ? 'untracked' : code1 });
  }
  return { staged, unstaged };
}

function getFileInfo(p) {
  const parts = p.split('/'), name = parts.pop();
  return { name, dir: parts.join('/') };
}

// ─── Graph colors (Cursor/GitLens palette) ────────────────────────────────────
const GRAPH_COLORS = [
  '#3b82f6', '#10b981', '#e8c547', '#ec4899',
  '#9333ea', '#ef4444', '#06b6d4', '#f97316',
  '#8b5cf6', '#14b8a6', '#d946ef', '#84cc16',
];
const gc = lane => GRAPH_COLORS[Math.abs(lane) % GRAPH_COLORS.length];

// ─── Git log parser ───────────────────────────────────────────────────────────
// Format: %H\x00%P\x00%s\x00%an\x00%ar\x00%D  (fields sep by NUL)
function parseGitLog(raw) {
  return raw.trim().split('\n').filter(Boolean).map(line => {
    const [hash = '', parents = '', subject = '', author = '', date = '', refs = ''] = line.split('\x00');
    const parentList = parents.trim() ? parents.trim().split(' ') : [];

    let branchName = '', remoteName = '', isHead = false;
    const tags = [];
    if (refs.trim()) {
      for (const r of refs.split(',').map(s => s.trim()).filter(Boolean)) {
        if (r.startsWith('HEAD -> ')) { branchName = r.slice(8); isHead = true; }
        else if (r === 'HEAD') isHead = true;
        else if (r.startsWith('tag: ')) tags.push(r.slice(5));
        else if (r.startsWith('origin/') || r.startsWith('upstream/')) { if (!remoteName) remoteName = r; }
        else if (!branchName && !r.includes('/')) branchName = r;
      }
    }
    return { hash, parents: parentList, subject, author, date, branchName, remoteName, isHead, tags };
  });
}

// ─── Lane-tracking algorithm ──────────────────────────────────────────────────
// Processes commits top-to-bottom (newest first) assigning each to a rail.
// Returns enriched commit objects with `lane`, `inRails`, `outRails`, `connections`.
function buildGraphLayout(commits) {
  // rails[i] = parentHash we expect to arrive on lane i, null = free
  let rails = [];
  const result = [];

  for (const commit of commits) {
    const { hash, parents } = commit;

    // Find this commit's lane (was reserved by earlier processing, or allocate new)
    let lane = rails.indexOf(hash);
    if (lane === -1) {
      lane = rails.indexOf(null);
      if (lane === -1) lane = rails.length;
      if (lane === rails.length) rails.push(null);
    }

    const inRails = [...rails];   // snapshot before changes (for top-half lines)
    rails[lane] = null;           // consume this slot

    // Build outgoing connections (lane -> target lane for each parent)
    const connections = [];
    parents.forEach((p, i) => {
      if (i === 0) {
        const existing = rails.indexOf(p);
        if (existing !== -1) {
          connections.push({ from: lane, to: existing });   // converge left/right
        } else {
          rails[lane] = p;                                  // stay in same lane
          connections.push({ from: lane, to: lane });
        }
      } else {
        const existing = rails.indexOf(p);
        if (existing !== -1) {
          connections.push({ from: lane, to: existing });
        } else {
          let newRail = rails.indexOf(null);
          if (newRail === -1) newRail = rails.length;
          if (newRail === rails.length) rails.push(null);
          rails[newRail] = p;
          connections.push({ from: lane, to: newRail });
        }
      }
    });

    const outRails = [...rails];
    // Trim trailing nulls
    while (rails.length && rails[rails.length - 1] === null) rails.pop();

    result.push({ ...commit, lane, inRails, outRails, connections });
  }
  return result;
}

// ─── Commit row SVG ───────────────────────────────────────────────────────────
const COL = 16, DOT_R = 3.5, ROW_H = 32;

const CommitSVG = memo(function CommitSVG({ entry, isFirst }) {
  const maxLane = Math.max(
    entry.inRails.length - 1,
    entry.outRails.length - 1,
    ...entry.connections.map(c => Math.max(c.from, c.to)),
    entry.lane
  );
  const W = (maxLane + 1) * COL + 14;
  const mid = ROW_H / 2;
  const cx = ln => 8 + ln * COL;

  const els = [];

  // Top-half vertical lines (from top edge to midY) for each active inRail
  entry.inRails.forEach((h, ln) => {
    if (!h) return;
    els.push(<line key={`in${ln}`} x1={cx(ln)} y1={0} x2={cx(ln)} y2={mid} stroke={gc(ln)} strokeWidth={1.5} strokeLinecap="round" />);
  });

  // Bottom-half lines (from midY to bottom edge) using outgoing connections
  const connectedTo = new Set(entry.connections.map(c => c.to));
  entry.connections.forEach((conn, i) => {
    const fx = cx(conn.from), tx = cx(conn.to);
    if (fx === tx) {
      els.push(<line key={`ob${i}`} x1={fx} y1={mid} x2={tx} y2={ROW_H} stroke={gc(conn.from)} strokeWidth={1.5} strokeLinecap="round" />);
    } else {
      // Bezier curve for merge/diverge
      const cp1y = mid + (ROW_H - mid) * 0.5;
      els.push(<path key={`ob${i}`} d={`M${fx},${mid} C${fx},${cp1y} ${tx},${cp1y} ${tx},${ROW_H}`} fill="none" stroke={gc(conn.from)} strokeWidth={1.5} strokeLinecap="round" />);
    }
  });

  // Pass-through rails not covered by connections
  entry.outRails.forEach((h, ln) => {
    if (!h || connectedTo.has(ln)) return;
    els.push(<line key={`pt${ln}`} x1={cx(ln)} y1={mid} x2={cx(ln)} y2={ROW_H} stroke={gc(ln)} strokeWidth={1.5} strokeLinecap="round" />);
  });

  // Commit dot
  const dotX = cx(entry.lane), dotColor = gc(entry.lane);
  if (isFirst) {
    els.push(<circle key="ring" cx={dotX} cy={mid} r={DOT_R + 1.5} fill="#1e1e1e" stroke={dotColor} strokeWidth={2} />);
    els.push(<circle key="inner" cx={dotX} cy={mid} r={DOT_R - 1} fill={dotColor} />);
  } else {
    els.push(<circle key="dot" cx={dotX} cy={mid} r={DOT_R} fill={dotColor} />);
  }

  return <svg width={W} height={ROW_H} style={{ flexShrink: 0, overflow: 'visible', display: 'block' }}>{els}</svg>;
});

// ─── Diff viewer ──────────────────────────────────────────────────────────────
function DiffViewer({ path, isStaged, onClose }) {
  const [diff, setDiff] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const cmd = isStaged ? `git diff --cached -- ${JSON.stringify(path)}` : `git diff -- ${JSON.stringify(path)}`;
    runCommand(cmd).then(r => { setDiff(r.output || '(No diff)'); setLoading(false); })
      .catch(() => { setDiff('Failed to load diff.'); setLoading(false); });
  }, [path, isStaged]);

  return (
    <div className="scm-diff-viewer">
      <div className="scm-diff-header">
        <span className="scm-diff-path">{path}</span>
        <button className="scm-icon-btn" onClick={onClose}><VscClose size={14} /></button>
      </div>
      <div className="scm-diff-content">
        {loading ? <div style={{ padding: 12, color: 'var(--text-muted)' }}>Loading…</div> : (
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

// ─── Main component ───────────────────────────────────────────────────────────
export default function SourceControlPanel({ onOpenFile, hasWorkspace = true }) {
  const [branch, setBranch]               = useState('');
  const [hasUpstream, setHasUpstream]     = useState(false);
  const [statusOutput, setStatusOutput]   = useState(null);
  const [loading, setLoading]             = useState(true);
  const [error, setError]                 = useState(null);
  const [commitMessage, setCommitMessage] = useState('');
  const [committing, setCommitting]       = useState(false);
  const [commitDropdown, setCommitDropdown] = useState(false);
  const [graphEntries, setGraphEntries]   = useState([]);
  const [graphLoading, setGraphLoading]   = useState(false);
  const [selectedCommit, setSelectedCommit] = useState(null);
  const [commitDetails, setCommitDetails] = useState(null);
  const [viewingDiff, setViewingDiff]     = useState(null);
  const [collapsed, setCollapsed]         = useState({ staged: false, changes: false, graph: false, agentReview: true });
  const [panelH, setPanelH]              = useState({ changes: 300, graph: 420 });
  const isResizing = useRef(null);
  const commitDropdownRef = useRef(null);

  // ── Close commit dropdown on outside click ──────────────────────────────────
  useEffect(() => {
    if (!commitDropdown) return;
    const h = e => { if (!commitDropdownRef.current?.contains(e.target)) setCommitDropdown(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [commitDropdown]);

  // ── Fetch git status ────────────────────────────────────────────────────────
  const fetchStatus = useCallback(async () => {
    if (!hasWorkspace) { setLoading(false); setStatusOutput(null); setBranch(''); setHasUpstream(false); return; }
    setError(null);
    try {
      const [sRes, bRes, uRes] = await Promise.all([
        runCommand('git status --porcelain'),
        runCommand('git branch --show-current'),
        runCommand("git rev-parse --abbrev-ref --symbolic-full-name '@{u}'"),
      ]);
      if (sRes.exit_code !== 0) { setStatusOutput(null); setError(sRes.output || 'Not a git repository'); setBranch(''); setHasUpstream(false); return; }
      setStatusOutput(sRes.output);
      setBranch((bRes.output || '').trim());
      setHasUpstream(uRes.exit_code === 0 && !!uRes.output.trim());
    } catch (e) { setStatusOutput(null); setError(e.message || 'Not a git repository'); setBranch(''); setHasUpstream(false); }
    finally { setLoading(false); }
  }, [hasWorkspace]);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);
  useEffect(() => {
    if (!hasWorkspace || (!statusOutput && error)) return;
    const id = setInterval(fetchStatus, 8000);
    return () => clearInterval(id);
  }, [fetchStatus, statusOutput, error, hasWorkspace]);

  // ── Fetch git graph ─────────────────────────────────────────────────────────
  const fetchGraph = useCallback(async () => {
    if (!hasWorkspace) return;
    setGraphLoading(true);
    try {
      const res = await runCommand(
        'git log --format="%H%x00%P%x00%s%x00%an%x00%ar%x00%D" -80'
      );
      const commits = parseGitLog(res.output || '');
      setGraphEntries(buildGraphLayout(commits));
    } catch (_) { setGraphEntries([]); }
    finally { setGraphLoading(false); }
  }, [hasWorkspace]);

  const hasRepo = !error && statusOutput !== null;
  const { staged = [], unstaged = [] } = hasRepo ? parsePorcelain(statusOutput) : {};
  const hasStaged = staged.length > 0;
  const canCommit = hasStaged && commitMessage.trim();

  useEffect(() => {
    if (hasWorkspace && hasRepo && !collapsed.graph && graphEntries.length === 0 && !graphLoading) {
      fetchGraph();
    }
  }, [hasWorkspace, hasRepo, collapsed.graph, graphEntries.length, graphLoading, fetchGraph]);

  // ── Git operations ──────────────────────────────────────────────────────────
  const handleStage   = async p => { try { await runCommand(`git add ${JSON.stringify(p)}`); await fetchStatus(); } catch (e) { setError(e.message); } };
  const handleUnstage = async p => { try { await runCommand(`git reset HEAD ${JSON.stringify(p)}`); await fetchStatus(); } catch (e) { setError(e.message); } };
  const handleDiscard = async p => {
    if (!window.confirm(`Discard changes in ${p}?`)) return;
    try { await runCommand(`git checkout -- ${JSON.stringify(p)}`); await fetchStatus(); } catch (e) { setError(e.message); }
  };

  const doCommit = async () => {
    if (!canCommit) return false;
    setCommitting(true);
    try {
      const msg = commitMessage.trim().replace(/"/g, '\\"');
      const r = await runCommand(`git commit -m "${msg}"`);
      if (r.exit_code !== 0) { setError(r.output); return false; }
      setCommitMessage('');
      await fetchStatus();
      setGraphEntries([]);
      return true;
    } catch (e) { setError(e.message); return false; }
    finally { setCommitting(false); }
  };

  const handleCommit = async () => { await doCommit(); };

  const handleCommitAndPush = async () => {
    setCommitDropdown(false);
    const ok = await doCommit();
    if (!ok) return;
    setLoading(true);
    try {
      const pushCmd = !hasUpstream && branch ? `git push --set-upstream origin ${branch}` : 'git push';
      const r = await runCommand(pushCmd);
      if (r.exit_code !== 0) setError(r.output);
      else { await fetchStatus(); await fetchGraph(); }
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };

  const handlePush  = async () => { setLoading(true); try { const cmd = !hasUpstream && branch ? `git push --set-upstream origin ${branch}` : 'git push'; const r = await runCommand(cmd); if (r.exit_code !== 0) setError(r.output); else await fetchStatus(); } catch (e) { setError(e.message); } finally { setLoading(false); } };
  const handlePull  = async () => { setLoading(true); try { const r = await runCommand('git pull'); if (r.exit_code !== 0) setError(r.output); else await fetchStatus(); } catch (e) { setError(e.message); } finally { setLoading(false); } };
  const handleFetch = async () => { setLoading(true); try { await runCommand('git fetch'); await fetchStatus(); } catch (e) { setError(e.message); } finally { setLoading(false); } };

  // ── Commit detail click ─────────────────────────────────────────────────────
  const handleCommitClick = async hash => {
    if (selectedCommit === hash) { setSelectedCommit(null); setCommitDetails(null); return; }
    setSelectedCommit(hash);
    setCommitDetails(null);
    try {
      const r = await runCommand(`git show --quiet --format="%H%n%an%n%ae%n%ad%n%s%n%b" ${hash}`);
      if (r.exit_code === 0) {
        const ln = r.output.split('\n');
        const details = { hash: ln[0], author: ln[1], email: ln[2], date: ln[3], subject: ln[4], body: ln.slice(5).join('\n').trim() };
        const fr = await runCommand(`git show --pretty="" --name-status ${hash}`);
        if (fr.exit_code === 0) {
          details.files = fr.output.trim().split('\n').filter(Boolean).map(l => { const [s, ...p] = l.split(/\s+/); return { status: s, path: p.join(' ') }; });
        }
        setCommitDetails(details);
      }
    } catch (_) {}
  };

  // ── Panel resize ────────────────────────────────────────────────────────────
  const startResize = (e, panel) => {
    e.preventDefault();
    isResizing.current = { panel, startY: e.clientY, startH: panelH[panel] };
    const move = ev => { if (!isResizing.current) return; setPanelH(p => ({ ...p, [isResizing.current.panel]: Math.max(80, isResizing.current.startH + (ev.clientY - isResizing.current.startY)) })); };
    const up   = () => { isResizing.current = null; document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); document.body.style.cursor = ''; };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
    document.body.style.cursor = 'ns-resize';
  };
  const toggle = k => setCollapsed(p => ({ ...p, [k]: !p[k] }));

  // ── Early returns ────────────────────────────────────────────────────────────
  if (!hasWorkspace) return (
    <div className="scm-panel">
      <div className="scm-panel-header"><span className="scm-panel-title">SOURCE CONTROL</span></div>
      <div className="scm-empty"><VscSourceControl size={40} className="scm-empty-icon" /><p className="scm-empty-text">Open a folder to use source control.</p></div>
    </div>
  );
  if (loading && !statusOutput && !error) return (
    <div className="scm-panel">
      <div className="scm-panel-header"><span className="scm-panel-title">SOURCE CONTROL</span></div>
      <div className="scm-loading">Loading…</div>
    </div>
  );
  if (viewingDiff) return (
    <div className="scm-panel">
      <div className="scm-panel-header"><span className="scm-panel-title">SOURCE CONTROL</span><div className="scm-panel-actions"><button className="scm-icon-btn" onClick={() => setViewingDiff(null)}><VscClose size={14} /></button></div></div>
      <DiffViewer path={viewingDiff.path} isStaged={viewingDiff.isStaged} onClose={() => setViewingDiff(null)} />
    </div>
  );

  // ── Main render ──────────────────────────────────────────────────────────────
  return (
    <div className="scm-panel">
      {/* Header */}
      <div className="scm-panel-header">
        <span className="scm-panel-title">Source Control</span>
        <div className="scm-panel-actions">
          {branch && <span className="scm-branch-badge"><VscGitMerge size={11} style={{ marginRight: 4 }} />{branch}</span>}
          <button className="scm-icon-btn" title="Refresh" onClick={() => { setLoading(true); fetchStatus().then(() => setLoading(false)); }}><VscRefresh size={15} /></button>
          <button className="scm-icon-btn" title="More Actions"><VscEllipsis size={15} /></button>
        </div>
      </div>

      {!hasRepo ? (
        <div className="scm-empty">
          <VscSourceControl size={40} className="scm-empty-icon" />
          <p className="scm-empty-text">{typeof error === 'string' ? error : 'No git repository found.'}</p>
          <button className="scm-btn primary" onClick={async () => { setLoading(true); try { await runCommand('git init'); await fetchStatus(); } catch (e) { setError(e.message); } setLoading(false); }}>Initialize Repository</button>
        </div>
      ) : (
        <div className="scm-panel-body">
          {error && <div className="scm-error-banner">{typeof error === 'string' ? error : 'Git error'}</div>}

          {/* ── Changes panel ─────────────────────────────────────────────── */}
          <div className="scm-panel-main" style={{ height: collapsed.changesSection ? 'auto' : panelH.changes }}>

            {/* Commit input + button */}
            <div className="scm-commit-section">
              <div className="scm-commit-input-container">
                <textarea
                  className="scm-commit-input"
                  placeholder={`Message (⌘↵ to commit on "${branch || 'main'}")`}
                  value={commitMessage}
                  rows={2}
                  onChange={e => setCommitMessage(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) handleCommit(); }}
                />
                <div className="scm-commit-sparkle" title="AI Commit Message"><VscSparkle size={13} /></div>
              </div>

              {/* Split commit button */}
              <div className="scm-commit-btn-split" ref={commitDropdownRef}>
                <button className="scm-commit-btn-main" onClick={handleCommit} disabled={!canCommit || committing}>
                  <VscCheck size={14} />
                  <span>{committing ? 'Committing…' : 'Commit'}</span>
                </button>
                <button className="scm-commit-btn-arrow" onClick={() => setCommitDropdown(v => !v)} disabled={committing} title="Commit options">
                  <VscChevronDown size={13} />
                </button>
                {commitDropdown && (
                  <div className="scm-commit-dropdown">
                    <div className="scm-commit-dropdown-item" onClick={handleCommit}>
                      <VscCheck size={13} /> Commit
                    </div>
                    <div className="scm-commit-dropdown-item" onClick={handleCommitAndPush}>
                      <VscArrowUp size={13} /> Commit &amp; Push
                    </div>
                    <div className="scm-commit-dropdown-sep" />
                    <div className="scm-commit-dropdown-item" onClick={async () => { setCommitDropdown(false); setLoading(true); try { await runCommand('git stash'); await fetchStatus(); } catch (e) { setError(e.message); } finally { setLoading(false); } }}>
                      <VscCircleSlash size={13} /> Stash All
                    </div>
                  </div>
                )}
              </div>

              {hasRepo && !hasUpstream && branch && (
                <button className="scm-btn primary scm-publish-btn" onClick={handlePush} disabled={loading}>
                  <VscCloud size={13} /> Publish Branch
                </button>
              )}
            </div>

            {/* Staged */}
            {staged.length > 0 && (
              <div className="scm-section scm-subsection">
                <div className="scm-section-header" onClick={() => toggle('staged')}>
                  <span className="scm-section-toggle">{collapsed.staged ? <VscChevronRight size={13} /> : <VscChevronDown size={13} />}</span>
                  <span className="scm-section-title">Staged Changes</span>
                  <span className="scm-section-count">{staged.length}</span>
                  <button className="scm-file-action stage-all" title="Unstage All" onClick={e => { e.stopPropagation(); staged.forEach(f => handleUnstage(f.path)); }}><VscRemove size={13} /></button>
                </div>
                {!collapsed.staged && (
                  <div className="scm-file-list">
                    {staged.map(file => {
                      const { name, dir } = getFileInfo(file.path);
                      return (
                        <div key={file.path} className="scm-file-row" onClick={() => setViewingDiff({ path: file.path, isStaged: true })}>
                          <VscFile size={13} className="scm-file-icon" />
                          <span className="scm-file-name">{name}</span>
                          {dir && <span className="scm-file-dir">{dir}</span>}
                          <span className={`scm-status-badge s-${file.status}`}>{file.status}</span>
                          <div className="scm-file-actions">
                            <button className="scm-file-action" title="Unstage" onClick={e => { e.stopPropagation(); handleUnstage(file.path); }}><VscRemove size={13} /></button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* Changes */}
            {unstaged.length > 0 && (
              <div className="scm-section scm-subsection">
                <div className="scm-section-header" onClick={() => toggle('changes')}>
                  <span className="scm-section-toggle">{collapsed.changes ? <VscChevronRight size={13} /> : <VscChevronDown size={13} />}</span>
                  <span className="scm-section-title">Changes</span>
                  <span className="scm-section-count">{unstaged.length}</span>
                  <button className="scm-file-action stage-all" title="Stage All" onClick={e => { e.stopPropagation(); unstaged.forEach(f => handleStage(f.path)); }}><VscAdd size={13} /></button>
                </div>
                {!collapsed.changes && (
                  <div className="scm-file-list">
                    {unstaged.map(file => {
                      const { name, dir } = getFileInfo(file.path);
                      return (
                        <div key={file.path} className="scm-file-row" onClick={() => setViewingDiff({ path: file.path, isStaged: false })}>
                          <VscFile size={13} className="scm-file-icon" />
                          <span className="scm-file-name">{name}</span>
                          {dir && <span className="scm-file-dir">{dir}</span>}
                          <span className={`scm-status-badge s-${file.status}`}>{file.status === 'untracked' ? 'U' : file.status}</span>
                          <div className="scm-file-actions">
                            <button className="scm-file-action" title="Discard" onClick={e => { e.stopPropagation(); handleDiscard(file.path); }}><VscDiscard size={13} /></button>
                            <button className="scm-file-action" title="Stage"   onClick={e => { e.stopPropagation(); handleStage(file.path); }}><VscAdd size={13} /></button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {staged.length === 0 && unstaged.length === 0 && (
              <div className="scm-no-changes">No changes — working tree clean</div>
            )}
          </div>

          <div className="scm-resize-handle" onMouseDown={e => startResize(e, 'changes')} />

          {/* ── Graph section ──────────────────────────────────────────────── */}
          <div className="scm-graph-section-wrap" style={{ flex: collapsed.graph ? '0 0 auto' : '1 1 0', minHeight: 0 }}>
            <div className="scm-section scm-section-graph">

              <div className="scm-section-header" onClick={() => { toggle('graph'); if (collapsed.graph && graphEntries.length === 0) fetchGraph(); }}>
                <span className="scm-section-toggle">{collapsed.graph ? <VscChevronRight size={13} /> : <VscChevronDown size={13} />}</span>
                <span className="scm-section-title">GRAPH</span>
                <div className="scm-graph-toolbar">
                  <span className="scm-graph-toolbar-auto"><VscGitMerge size={11} style={{ marginRight: 3 }} />Auto</span>
                  <button className="scm-icon-btn" title="Push"    onClick={e => { e.stopPropagation(); handlePush();  }}><VscArrowUp size={13} /></button>
                  <button className="scm-icon-btn" title="Fetch"   onClick={e => { e.stopPropagation(); handleFetch(); }}><VscTarget size={13} /></button>
                  <button className="scm-icon-btn" title="Pull"    onClick={e => { e.stopPropagation(); handlePull();  }}><VscArrowDown size={13} /></button>
                  <button className="scm-icon-btn" title="Refresh" onClick={e => { e.stopPropagation(); setGraphEntries([]); fetchGraph(); }}><VscRefresh size={13} /></button>
                </div>
              </div>

              {!collapsed.graph && (
                <div className="scm-graph-container">
                  {graphLoading ? (
                    <div className="scm-graph-loading">Loading graph…</div>
                  ) : graphEntries.length === 0 ? (
                    <div className="scm-no-changes">No commits found</div>
                  ) : (
                    <div className="scm-graph-list">
                      {graphEntries.map((entry, i) => {
                        const isSelected = selectedCommit === entry.hash;
                        const isFirst    = i === 0;
                        const dotColor   = gc(entry.lane);
                        return (
                          <React.Fragment key={entry.hash}>
                            <div
                              className={`scm-graph-row${isSelected ? ' selected' : ''}`}
                              onClick={() => handleCommitClick(entry.hash)}
                              title={`${entry.hash.slice(0, 7)} · ${entry.author}`}
                            >
                              <CommitSVG entry={entry} isFirst={isFirst} />
                              <div className="scm-graph-row-content">
                                <div className="scm-graph-row-top">
                                  <span className="scm-graph-commit-msg">{entry.subject}</span>
                                  <div className="scm-graph-pills">
                                    {entry.tags.map(tag => (
                                      <span key={tag} className="scm-graph-pill tag"><VscTag size={9} />{tag}</span>
                                    ))}
                                    {entry.branchName && (
                                      <span className="scm-graph-pill branch" style={{ borderColor: dotColor, color: dotColor, background: `${dotColor}1a` }}>
                                        <VscGitMerge size={9} />{entry.branchName}
                                      </span>
                                    )}
                                    {entry.remoteName && (
                                      <span className="scm-graph-pill remote">
                                        <VscCloud size={9} />{entry.remoteName}
                                      </span>
                                    )}
                                  </div>
                                </div>
                                <div className="scm-graph-row-bottom">
                                  <span className="scm-graph-author">{entry.author}</span>
                                  <span className="scm-graph-date">{entry.date}</span>
                                  <span className="scm-graph-hash">{entry.hash.slice(0, 7)}</span>
                                </div>
                              </div>
                            </div>

                            {isSelected && commitDetails && (
                              <div className="scm-commit-details">
                                <div className="scm-commit-details-header">
                                  <code className="scm-commit-details-hash">{commitDetails.hash?.slice(0, 7)}</code>
                                  <strong className="scm-commit-details-author">{commitDetails.author}</strong>
                                  <span className="scm-commit-details-date">{commitDetails.date}</span>
                                </div>
                                <div className="scm-commit-details-body">{commitDetails.subject}</div>
                                {commitDetails.body && <div className="scm-commit-details-full">{commitDetails.body}</div>}
                                <div className="scm-commit-details-files">
                                  {commitDetails.files?.map((f, fi) => (
                                    <div key={fi} className="scm-commit-details-file">
                                      <span className={`scm-status-icon ${f.status}`}>{f.status}</span>
                                      <span className="scm-file-path">{f.path}</span>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                          </React.Fragment>
                        );
                      })}
                    </div>
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

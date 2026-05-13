import React, { useState, useEffect, useCallback, useRef, memo } from 'react';
import {
  VscRefresh, VscAdd, VscRemove, VscCheck,
  VscSourceControl, VscChevronDown, VscChevronRight, VscEllipsis,
  VscGitMerge, VscClose, VscDiscard, VscArrowDown, VscArrowUp,
  VscCloud, VscTarget, VscSparkle, VscTag, VscCircleSlash,
} from 'react-icons/vsc';
import {
  SiJavascript, SiTypescript, SiReact, SiPython, SiHtml5,
  SiCss3, SiMarkdown, SiJson, SiRust, SiGo,
  SiDocker, SiGit,
} from 'react-icons/si';
import { MdInsertDriveFile } from 'react-icons/md';
import axios from 'axios';
import { API_URL as API } from '../config';

// ─── Backend runner ───────────────────────────────────────────────────────────
async function runCommand(command) {
  const res = await axios.post(`${API}/terminal/run`, { command }, { timeout: 180000 });
  return { output: res.data.output ?? '', exit_code: res.data.exit_code ?? 0 };
}

// Single-request status fetch — replaces 3 separate runCommand calls
async function fetchStatusBundle() {
  const res = await axios.get(`${API}/files/git-status-bundle`, { timeout: 30000 });
  return res.data;
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
    if (code0 !== ' ' && code0 !== '?') staged.push({ path, status: code0 });
    if ((code1 !== ' ' && code1 !== '?') || code0 === '?')
      unstaged.push({ path, status: code0 === '?' ? 'U' : code1 });
  }
  return { staged, unstaged };
}

function getFileInfo(p) {
  const parts = p.replace(/\\/g, '/').split('/');
  const name = parts.pop();
  return { name, dir: parts.join('/') };
}

// ─── File-type icon map ───────────────────────────────────────────────────────
const EXT_ICONS = {
  js: [SiJavascript, '#f7df1e'], jsx: [SiReact, '#61dafb'],
  ts: [SiTypescript, '#3178c6'], tsx: [SiReact, '#61dafb'],
  py: [SiPython, '#3572a5'],    html: [SiHtml5, '#e34c26'],
  css: [SiCss3, '#264de4'],     scss: [SiCss3, '#c76395'],
  md: [SiMarkdown, '#7a8ba3'],  json: [SiJson, '#cbcb41'],
  rs: [SiRust, '#dea584'],      go: [SiGo, '#00acd7'],
  dockerfile: [SiDocker, '#0db7ed'],
  gitignore: [SiGit, '#f05033'], gitattributes: [SiGit, '#f05033'],
};
function fileIcon(name) {
  const ext = (name || '').split('.').pop().toLowerCase();
  const full = name.toLowerCase();
  if (EXT_ICONS[full]) return EXT_ICONS[full];
  if (EXT_ICONS[ext])  return EXT_ICONS[ext];
  return [MdInsertDriveFile, '#7a8ba3'];
}

// ─── Status badge config (Cursor-style) ──────────────────────────────────────
const STATUS_CONFIG = {
  M: { label: 'M', color: '#e5a000', title: 'Modified'  },
  A: { label: 'A', color: '#73c991', title: 'Added'     },
  D: { label: 'D', color: '#f14c4c', title: 'Deleted'   },
  R: { label: 'R', color: '#f97316', title: 'Renamed'   },
  C: { label: 'C', color: '#60a5fa', title: 'Copied'    },
  U: { label: 'U', color: '#3dc9b0', title: 'Untracked' },
  '!': { label: '!', color: '#f14c4c', title: 'Conflict' },
};
const statusCfg = (s) => STATUS_CONFIG[s] || { label: s, color: '#7a8ba3', title: s };

// ─── File row ─────────────────────────────────────────────────────────────────
const FileRow = memo(function FileRow({ file, onOpenDiff, primaryAction, secondaryAction, primaryIcon, secondaryIcon, primaryTitle, secondaryTitle }) {
  const [hover, setHover] = useState(false);
  const { name, dir } = getFileInfo(file.path);
  const [IconComp, iconColor] = fileIcon(name);
  const sc = statusCfg(file.status);

  return (
    <div
      className="scm-file-row"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={() => onOpenDiff(file.path)}
      title={`${file.path} — ${sc.title}`}
    >
      <IconComp size={13} style={{ color: iconColor, flexShrink: 0 }} />
      <span className="scm-file-name">{name}</span>
      {dir && <span className="scm-file-dir">{dir}</span>}
      <div className="scm-file-row-right">
        {hover ? (
          <div className="scm-file-actions">
            {secondaryAction && (
              <button className="scm-file-action" title={secondaryTitle}
                onClick={e => { e.stopPropagation(); secondaryAction(file.path); }}>
                {secondaryIcon}
              </button>
            )}
            {primaryAction && (
              <button className="scm-file-action" title={primaryTitle}
                onClick={e => { e.stopPropagation(); primaryAction(file.path); }}>
                {primaryIcon}
              </button>
            )}
          </div>
        ) : (
          <span className="scm-status-letter" style={{ color: sc.color }}>{sc.label}</span>
        )}
      </div>
    </div>
  );
});

// ─── Graph colors ─────────────────────────────────────────────────────────────
const GRAPH_COLORS = [
  '#3b82f6','#10b981','#e8c547','#ec4899',
  '#9333ea','#ef4444','#06b6d4','#f97316',
  '#8b5cf6','#14b8a6','#d946ef','#84cc16',
];
const gc = lane => GRAPH_COLORS[Math.abs(lane) % GRAPH_COLORS.length];

// ─── Git log parser ───────────────────────────────────────────────────────────
function parseGitLog(raw) {
  return raw.trim().split('\n').filter(Boolean).map(line => {
    const [hash='',parents='',subject='',author='',date='',refs=''] = line.split('\x00');
    const parentList = parents.trim() ? parents.trim().split(' ') : [];
    let branchName='', remoteName='', isHead=false;
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
function buildGraphLayout(commits) {
  let rails = [];
  const result = [];
  for (const commit of commits) {
    const { hash, parents } = commit;
    let lane = rails.indexOf(hash);
    if (lane === -1) {
      lane = rails.indexOf(null);
      if (lane === -1) lane = rails.length;
      if (lane === rails.length) rails.push(null);
    }
    const inRails = [...rails];
    rails[lane] = null;
    const connections = [];
    parents.forEach((p, i) => {
      if (i === 0) {
        const ex = rails.indexOf(p);
        if (ex !== -1) { connections.push({ from: lane, to: ex }); }
        else { rails[lane] = p; connections.push({ from: lane, to: lane }); }
      } else {
        const ex = rails.indexOf(p);
        if (ex !== -1) { connections.push({ from: lane, to: ex }); }
        else {
          let nr = rails.indexOf(null); if (nr === -1) nr = rails.length;
          if (nr === rails.length) rails.push(null);
          rails[nr] = p; connections.push({ from: lane, to: nr });
        }
      }
    });
    const outRails = [...rails];
    while (rails.length && rails[rails.length - 1] === null) rails.pop();
    result.push({ ...commit, lane, inRails, outRails, connections });
  }
  return result;
}

// ─── Commit SVG ───────────────────────────────────────────────────────────────
const COL=16, DOT_R=3.5, ROW_H=32;
const cx = lane => COL / 2 + lane * COL;
const CommitSVG = memo(function CommitSVG({ entry, isFirst }) {
  const maxLane = Math.max(entry.lane, ...entry.inRails.map((_,i)=>i), ...entry.outRails.map((_,i)=>i));
  const W = Math.max(COL, (maxLane + 1) * COL);
  const mid = ROW_H / 2;
  const els = [];

  entry.inRails.forEach((h, ln) => {
    if (!h) return;
    els.push(<line key={`in${ln}`} x1={cx(ln)} y1={0} x2={cx(ln)} y2={mid} stroke={gc(ln)} strokeWidth={1.5} strokeLinecap="round" />);
  });

  const connTo = new Set(entry.connections.map(c => c.to));
  entry.connections.forEach((conn, i) => {
    const fx=cx(conn.from), tx=cx(conn.to);
    if (fx === tx) {
      els.push(<line key={`ob${i}`} x1={fx} y1={mid} x2={tx} y2={ROW_H} stroke={gc(conn.from)} strokeWidth={1.5} strokeLinecap="round" />);
    } else {
      const cp1y = mid + (ROW_H - mid) * 0.5;
      els.push(<path key={`ob${i}`} d={`M${fx},${mid} C${fx},${cp1y} ${tx},${cp1y} ${tx},${ROW_H}`} fill="none" stroke={gc(conn.from)} strokeWidth={1.5} strokeLinecap="round" />);
    }
  });

  entry.outRails.forEach((h, ln) => {
    if (!h || connTo.has(ln)) return;
    els.push(<line key={`pt${ln}`} x1={cx(ln)} y1={mid} x2={cx(ln)} y2={ROW_H} stroke={gc(ln)} strokeWidth={1.5} strokeLinecap="round" />);
  });

  const dotX=cx(entry.lane), dotColor=gc(entry.lane);
  if (isFirst) {
    els.push(<circle key="ring" cx={dotX} cy={mid} r={DOT_R+1.5} fill="#1e1e1e" stroke={dotColor} strokeWidth={2} />);
    els.push(<circle key="inner" cx={dotX} cy={mid} r={DOT_R-1} fill={dotColor} />);
  } else {
    els.push(<circle key="dot" cx={dotX} cy={mid} r={DOT_R} fill={dotColor} />);
  }
  return <svg width={W} height={ROW_H} style={{ flexShrink:0, overflow:'visible', display:'block' }}>{els}</svg>;
});

// ─── Diff viewer ──────────────────────────────────────────────────────────────
function DiffViewer({ path, isStaged, onClose }) {
  const [diff, setDiff] = useState(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    setLoading(true);
    const cmd = isStaged ? `git diff --cached -- ${JSON.stringify(path)}` : `git diff -- ${JSON.stringify(path)}`;
    runCommand(cmd)
      .then(r => { setDiff(r.output || '(No diff)'); setLoading(false); })
      .catch(() => { setDiff('Failed to load diff.'); setLoading(false); });
  }, [path, isStaged]);

  return (
    <div className="scm-diff-viewer">
      <div className="scm-diff-header">
        <span className="scm-diff-path">{path}</span>
        <button className="scm-icon-btn" onClick={onClose}><VscClose size={14} /></button>
      </div>
      <div className="scm-diff-content">
        {loading ? <div style={{ padding:12, color:'var(--text-muted)' }}>Loading…</div> : (
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

// ─── Section header ───────────────────────────────────────────────────────────
function SectionHeader({ title, count, collapsed, onToggle, actions }) {
  return (
    <div className="scm-section-header" onClick={onToggle}>
      <span className="scm-section-toggle">
        {collapsed ? <VscChevronRight size={13} /> : <VscChevronDown size={13} />}
      </span>
      <span className="scm-section-title">{title}</span>
      {count != null && <span className="scm-section-count">{count}</span>}
      {actions && <div className="scm-section-actions" onClick={e => e.stopPropagation()}>{actions}</div>}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────
export default function SourceControlPanel({ onOpenFile, hasWorkspace = true }) {
  const [branch, setBranch]         = useState('');
  const [ahead, setAhead]           = useState(0);
  const [behind, setBehind]         = useState(0);
  const [hasUpstream, setHasUpstream] = useState(false);
  const [statusOutput, setStatusOutput] = useState(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [bgRefreshing, setBgRefreshing] = useState(false);
  const [error, setError]           = useState(null);
  const [commitMessage, setCommitMessage] = useState('');
  const [committing, setCommitting] = useState(false);
  const [commitDropdown, setCommitDropdown] = useState(false);
  const [graphEntries, setGraphEntries] = useState([]);
  const [graphLoading, setGraphLoading] = useState(false);
  const [selectedCommit, setSelectedCommit] = useState(null);
  const [commitDetails, setCommitDetails] = useState(null);
  const [viewingDiff, setViewingDiff] = useState(null);
  const [collapsed, setCollapsed]   = useState({ staged: false, changes: false, graph: false });
  const [panelH, setPanelH]         = useState({ changes: 300 });
  const isResizing = useRef(null);
  const commitDropdownRef = useRef(null);
  const firstFetchDone = useRef(false);

  useEffect(() => {
    if (!commitDropdown) return;
    const h = e => { if (!commitDropdownRef.current?.contains(e.target)) setCommitDropdown(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [commitDropdown]);

  // ── Fetch git status via single bundle endpoint ─────────────────────────────
  const fetchStatus = useCallback(async (isBackground = false) => {
    if (!hasWorkspace) { setInitialLoading(false); setStatusOutput(null); setBranch(''); return; }
    setError(null);
    if (!isBackground) setInitialLoading(true);
    else setBgRefreshing(true);
    try {
      const data = await fetchStatusBundle();
      if (!data.ok) {
        setStatusOutput(null);
        setError(data.error || 'Not a git repository');
        setBranch('');
        setHasUpstream(false);
        setAhead(0);
        setBehind(0);
        return;
      }
      setStatusOutput(data.status);
      setBranch(data.branch || '');
      setHasUpstream(!!data.upstream);
      setAhead(data.ahead || 0);
      setBehind(data.behind || 0);
    } catch (e) {
      setStatusOutput(null);
      setError(e.message || 'Not a git repository');
      setBranch('');
      setHasUpstream(false);
    } finally {
      setInitialLoading(false);
      setBgRefreshing(false);
      firstFetchDone.current = true;
    }
  }, [hasWorkspace]);

  // Initial load
  useEffect(() => { fetchStatus(false); }, [fetchStatus]);

  // Background polling — no spinner flash
  useEffect(() => {
    if (!hasWorkspace) return;
    const id = setInterval(() => fetchStatus(true), 8000);
    return () => clearInterval(id);
  }, [fetchStatus, hasWorkspace]);

  // ── Fetch git graph ─────────────────────────────────────────────────────────
  const fetchGraph = useCallback(async () => {
    if (!hasWorkspace) return;
    setGraphLoading(true);
    try {
      const res = await runCommand('git log --format="%H%x00%P%x00%s%x00%an%x00%ar%x00%D" -80');
      setGraphEntries(buildGraphLayout(parseGitLog(res.output || '')));
    } catch (_) { setGraphEntries([]); }
    finally { setGraphLoading(false); }
  }, [hasWorkspace]);

  const hasRepo = !error && statusOutput !== null;
  const { staged = [], unstaged = [] } = hasRepo ? parsePorcelain(statusOutput) : {};
  const hasStaged = staged.length > 0;
  const canCommit = hasStaged && commitMessage.trim();

  useEffect(() => {
    if (hasWorkspace && hasRepo && !collapsed.graph && graphEntries.length === 0 && !graphLoading)
      fetchGraph();
  }, [hasWorkspace, hasRepo, collapsed.graph, graphEntries.length, graphLoading, fetchGraph]);

  // ── Git operations ──────────────────────────────────────────────────────────
  const handleStage   = async p => { try { await runCommand(`git add ${JSON.stringify(p)}`); await fetchStatus(true); } catch (e) { setError(e.message); } };
  const handleUnstage = async p => { try { await runCommand(`git reset HEAD ${JSON.stringify(p)}`); await fetchStatus(true); } catch (e) { setError(e.message); } };
  const handleDiscard = async p => {
    if (!window.confirm(`Discard changes in ${p}?`)) return;
    try { await runCommand(`git checkout -- ${JSON.stringify(p)}`); await fetchStatus(true); } catch (e) { setError(e.message); }
  };

  const doCommit = async () => {
    if (!canCommit) return false;
    setCommitting(true);
    try {
      const msg = commitMessage.trim().replace(/"/g, '\\"');
      const r = await runCommand(`git commit -m "${msg}"`);
      if (r.exit_code !== 0) { setError(r.output); return false; }
      setCommitMessage('');
      await fetchStatus(true);
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
    setInitialLoading(true);
    try {
      const pushCmd = !hasUpstream && branch ? `git push --set-upstream origin ${branch}` : 'git push';
      const r = await runCommand(pushCmd);
      if (r.exit_code !== 0) setError(r.output);
      else { await fetchStatus(true); await fetchGraph(); }
    } catch (e) { setError(e.message); }
    finally { setInitialLoading(false); }
  };

  const handlePush  = async () => { setInitialLoading(true); try { const cmd = !hasUpstream && branch ? `git push --set-upstream origin ${branch}` : 'git push'; const r = await runCommand(cmd); if (r.exit_code !== 0) setError(r.output); else await fetchStatus(true); } catch (e) { setError(e.message); } finally { setInitialLoading(false); } };
  const handlePull  = async () => { setInitialLoading(true); try { const r = await runCommand('git pull'); if (r.exit_code !== 0) setError(r.output); else await fetchStatus(true); } catch (e) { setError(e.message); } finally { setInitialLoading(false); } };
  const handleFetch = async () => { setInitialLoading(true); try { await runCommand('git fetch'); await fetchStatus(true); } catch (e) { setError(e.message); } finally { setInitialLoading(false); } };

  // ── Commit detail click ─────────────────────────────────────────────────────
  const handleCommitClick = async hash => {
    if (selectedCommit === hash) { setSelectedCommit(null); setCommitDetails(null); return; }
    setSelectedCommit(hash);
    setCommitDetails(null);
    try {
      const r = await runCommand(`git show --quiet --format="%H%n%an%n%ae%n%ad%n%s%n%b" ${hash}`);
      if (r.exit_code === 0) {
        const ln = r.output.split('\n');
        const d = { hash: ln[0], author: ln[1], email: ln[2], date: ln[3], subject: ln[4], body: ln.slice(5).join('\n').trim() };
        const fr = await runCommand(`git show --pretty="" --name-status ${hash}`);
        if (fr.exit_code === 0)
          d.files = fr.output.trim().split('\n').filter(Boolean).map(l => { const [s,...p]=l.split(/\s+/); return { status:s, path:p.join(' ') }; });
        setCommitDetails(d);
      }
    } catch (_) {}
  };

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

  if (initialLoading && !firstFetchDone.current) return (
    <div className="scm-panel">
      <div className="scm-panel-header">
        <span className="scm-panel-title">SOURCE CONTROL</span>
        <div className="scm-panel-actions">
          <div className="scm-spinner" />
        </div>
      </div>
      <div className="scm-loading">Checking repository…</div>
    </div>
  );

  if (viewingDiff) return (
    <div className="scm-panel">
      <div className="scm-panel-header">
        <span className="scm-panel-title">SOURCE CONTROL</span>
        <div className="scm-panel-actions">
          <button className="scm-icon-btn" onClick={() => setViewingDiff(null)}><VscClose size={14} /></button>
        </div>
      </div>
      <DiffViewer path={viewingDiff.path} isStaged={viewingDiff.isStaged} onClose={() => setViewingDiff(null)} />
    </div>
  );

  return (
    <div className="scm-panel">
      {/* Header */}
      <div className="scm-panel-header">
        <span className="scm-panel-title">Source Control</span>
        <div className="scm-panel-actions">
          {branch && (
            <span className="scm-branch-badge" title={branch}>
              <VscGitMerge size={10} style={{ marginRight: 3 }} />
              {branch}
              {(ahead > 0 || behind > 0) && (
                <span style={{ marginLeft: 4, opacity: 0.7 }}>
                  {ahead > 0 && <span title={`${ahead} ahead`}>↑{ahead}</span>}
                  {behind > 0 && <span title={`${behind} behind`} style={{ marginLeft: 2 }}>↓{behind}</span>}
                </span>
              )}
            </span>
          )}
          {bgRefreshing && <div className="scm-spinner scm-spinner-sm" title="Refreshing…" />}
          <button className="scm-icon-btn" title="Refresh" onClick={() => fetchStatus(false)}><VscRefresh size={14} /></button>
          <button className="scm-icon-btn" title="More Actions"><VscEllipsis size={14} /></button>
        </div>
      </div>

      {!hasRepo ? (
        <div className="scm-empty">
          <VscSourceControl size={40} className="scm-empty-icon" />
          <p className="scm-empty-text">{typeof error === 'string' ? error : 'No git repository found.'}</p>
          <button className="scm-btn primary" onClick={async () => { setInitialLoading(true); try { await runCommand('git init'); await fetchStatus(false); } catch (e) { setError(e.message); } setInitialLoading(false); }}>
            Initialize Repository
          </button>
        </div>
      ) : (
        <div className="scm-panel-body">
          {error && <div className="scm-error-banner">{typeof error === 'string' ? error : 'Git error'}</div>}

          {/* ── Changes area ─────────────────────────────────────────────────── */}
          <div className="scm-panel-main" style={{ height: panelH.changes }}>

            {/* Commit input */}
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
                  <VscCheck size={13} />
                  <span>{committing ? 'Committing…' : 'Commit'}</span>
                </button>
                <button className="scm-commit-btn-arrow" onClick={() => setCommitDropdown(v => !v)} disabled={committing}>
                  <VscChevronDown size={12} />
                </button>
                {commitDropdown && (
                  <div className="scm-commit-dropdown">
                    <div className="scm-commit-dropdown-item" onClick={handleCommit}><VscCheck size={13} /> Commit</div>
                    <div className="scm-commit-dropdown-item" onClick={handleCommitAndPush}><VscArrowUp size={13} /> Commit &amp; Push</div>
                    <div className="scm-commit-dropdown-sep" />
                    <div className="scm-commit-dropdown-item" onClick={async () => {
                      setCommitDropdown(false); setInitialLoading(true);
                      try { await runCommand('git stash'); await fetchStatus(true); }
                      catch (e) { setError(e.message); }
                      finally { setInitialLoading(false); }
                    }}><VscCircleSlash size={13} /> Stash All</div>
                  </div>
                )}
              </div>

              {!hasUpstream && branch && (
                <button className="scm-btn primary scm-publish-btn" onClick={handlePush} disabled={initialLoading}>
                  <VscCloud size={12} /> Publish Branch
                </button>
              )}
            </div>

            {/* Staged Changes */}
            {staged.length > 0 && (
              <div className="scm-section">
                <SectionHeader
                  title="Staged Changes" count={staged.length}
                  collapsed={collapsed.staged} onToggle={() => toggle('staged')}
                  actions={
                    <button className="scm-file-action" title="Unstage All"
                      onClick={() => staged.forEach(f => handleUnstage(f.path))}>
                      <VscRemove size={13} />
                    </button>
                  }
                />
                {!collapsed.staged && (
                  <div className="scm-file-list">
                    {staged.map(file => (
                      <FileRow
                        key={file.path} file={file}
                        onOpenDiff={p => setViewingDiff({ path: p, isStaged: true })}
                        primaryAction={handleUnstage}
                        primaryIcon={<VscRemove size={13} />}
                        primaryTitle="Unstage"
                      />
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Changes */}
            {unstaged.length > 0 && (
              <div className="scm-section">
                <SectionHeader
                  title="Changes" count={unstaged.length}
                  collapsed={collapsed.changes} onToggle={() => toggle('changes')}
                  actions={
                    <button className="scm-file-action" title="Stage All"
                      onClick={() => unstaged.forEach(f => handleStage(f.path))}>
                      <VscAdd size={13} />
                    </button>
                  }
                />
                {!collapsed.changes && (
                  <div className="scm-file-list">
                    {unstaged.map(file => (
                      <FileRow
                        key={file.path} file={file}
                        onOpenDiff={p => setViewingDiff({ path: p, isStaged: false })}
                        primaryAction={handleStage}
                        primaryIcon={<VscAdd size={13} />}
                        primaryTitle="Stage"
                        secondaryAction={file.status !== 'U' ? handleDiscard : null}
                        secondaryIcon={<VscDiscard size={13} />}
                        secondaryTitle="Discard Changes"
                      />
                    ))}
                  </div>
                )}
              </div>
            )}

            {staged.length === 0 && unstaged.length === 0 && (
              <div className="scm-no-changes">
                <VscCheck size={16} style={{ opacity: 0.4, marginRight: 6 }} />
                No changes — working tree clean
              </div>
            )}
          </div>

          <div className="scm-resize-handle" onMouseDown={e => startResize(e, 'changes')} />

          {/* ── Graph ──────────────────────────────────────────────────────── */}
          <div className="scm-graph-section-wrap" style={{ flex: collapsed.graph ? '0 0 auto' : '1 1 0', minHeight: 0 }}>
            <div className="scm-section scm-section-graph">
              <div className="scm-section-header" onClick={() => { toggle('graph'); if (collapsed.graph && graphEntries.length === 0) fetchGraph(); }}>
                <span className="scm-section-toggle">{collapsed.graph ? <VscChevronRight size={13}/> : <VscChevronDown size={13}/>}</span>
                <span className="scm-section-title">GRAPH</span>
                <div className="scm-graph-toolbar">
                  <span className="scm-graph-toolbar-auto"><VscGitMerge size={10} style={{ marginRight:3 }}/>Auto</span>
                  <button className="scm-icon-btn" title="Push"    onClick={e=>{e.stopPropagation();handlePush();}}><VscArrowUp size={13}/></button>
                  <button className="scm-icon-btn" title="Fetch"   onClick={e=>{e.stopPropagation();handleFetch();}}><VscTarget size={13}/></button>
                  <button className="scm-icon-btn" title="Pull"    onClick={e=>{e.stopPropagation();handlePull();}}><VscArrowDown size={13}/></button>
                  <button className="scm-icon-btn" title="Refresh" onClick={e=>{e.stopPropagation();setGraphEntries([]);fetchGraph();}}><VscRefresh size={13}/></button>
                </div>
              </div>

              {!collapsed.graph && (
                <div className="scm-graph-container">
                  {graphLoading ? (
                    <div className="scm-graph-loading">
                      <div className="scm-spinner scm-spinner-sm" style={{ marginRight: 6 }} />
                      Loading graph…
                    </div>
                  ) : graphEntries.length === 0 ? (
                    <div className="scm-no-changes">No commits found</div>
                  ) : (
                    <div className="scm-graph-list">
                      {graphEntries.map((entry, i) => {
                        const isSelected = selectedCommit === entry.hash;
                        const dotColor   = gc(entry.lane);
                        return (
                          <React.Fragment key={entry.hash}>
                            <div
                              className={`scm-graph-row${isSelected ? ' selected' : ''}`}
                              onClick={() => handleCommitClick(entry.hash)}
                              title={`${entry.hash.slice(0,7)} · ${entry.author}`}
                            >
                              <CommitSVG entry={entry} isFirst={i === 0} />
                              <div className="scm-graph-row-content">
                                <div className="scm-graph-row-top">
                                  <span className="scm-graph-commit-msg">{entry.subject}</span>
                                  <div className="scm-graph-pills">
                                    {entry.tags.map(tag => (
                                      <span key={tag} className="scm-graph-pill tag"><VscTag size={9}/>{tag}</span>
                                    ))}
                                    {entry.branchName && (
                                      <span className="scm-graph-pill branch" style={{ borderColor:dotColor, color:dotColor, background:`${dotColor}1a` }}>
                                        <VscGitMerge size={9}/>{entry.branchName}
                                      </span>
                                    )}
                                    {entry.remoteName && (
                                      <span className="scm-graph-pill remote">
                                        <VscCloud size={9}/>{entry.remoteName}
                                      </span>
                                    )}
                                  </div>
                                </div>
                                <div className="scm-graph-row-bottom">
                                  <span className="scm-graph-author">{entry.author}</span>
                                  <span className="scm-graph-date">{entry.date}</span>
                                  <span className="scm-graph-hash">{entry.hash.slice(0,7)}</span>
                                </div>
                              </div>
                            </div>

                            {isSelected && commitDetails && (
                              <div className="scm-commit-details">
                                <div className="scm-commit-details-header">
                                  <code className="scm-commit-details-hash">{commitDetails.hash?.slice(0,7)}</code>
                                  <strong className="scm-commit-details-author">{commitDetails.author}</strong>
                                  <span className="scm-commit-details-date">{commitDetails.date}</span>
                                </div>
                                <div className="scm-commit-details-body">{commitDetails.subject}</div>
                                {commitDetails.body && <div className="scm-commit-details-full">{commitDetails.body}</div>}
                                <div className="scm-commit-details-files">
                                  {commitDetails.files?.map((f, fi) => {
                                    const [FIcon, fColor] = fileIcon(f.path.split('/').pop());
                                    const fsc = statusCfg(f.status[0]);
                                    return (
                                      <div key={fi} className="scm-commit-details-file">
                                        <FIcon size={11} style={{ color: fColor, flexShrink: 0 }} />
                                        <span className="scm-file-path">{f.path}</span>
                                        <span className="scm-status-letter" style={{ color: fsc.color, marginLeft: 'auto' }}>{fsc.label}</span>
                                      </div>
                                    );
                                  })}
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

import React, { useState, useEffect, useCallback, useRef, memo } from 'react';
import {
  VscRefresh, VscAdd, VscRemove, VscCheck,
  VscSourceControl, VscChevronDown, VscChevronRight, VscEllipsis,
  VscGitMerge, VscClose, VscDiscard, VscArrowDown, VscArrowUp,
  VscCloud, VscTarget, VscSparkle, VscTag, VscCircleSlash,
  VscRepoClone, VscTrash, VscEdit, VscCopy,
} from 'react-icons/vsc';
import {
  SiJavascript, SiTypescript, SiReact, SiPython, SiHtml5,
  SiCss3, SiMarkdown, SiJson, SiRust, SiGo,
  SiDocker, SiGit,
} from 'react-icons/si';
import { MdInsertDriveFile } from 'react-icons/md';
import { buildDiffTabKey } from './DiffTab';
import {
  runCommand, runGit, fetchStatusBundle, withGitRetry, friendlyGitError,
  listBranches, createAndSwitchBranch, switchBranch, deleteBranch, renameBranch,
  checkoutRemoteBranch,
  listRemotes, addRemote, removeRemote, renameRemote, setRemoteUrl,
  listTags, createTag, deleteTag, pushTag, pushAllTags,
  mergeBranch, abortMerge, continueMerge,
  rebaseOnto, abortRebase, continueRebase, skipRebase,
  abortCherryPick, continueCherryPick,
  gitProgress, gitClone, gitInit,
} from '../lib/gitService';

// Local alias so existing callsites stay terse. The retry layer is now baked
// into every gitService method, so `withRetry` is rarely needed here — but
// the graph fetcher still uses it directly against axios, so re-export.
const withRetry = (fn) => withGitRetry(fn);

// ─── Git porcelain parser ─────────────────────────────────────────────────────
//
// Splits the porcelain output into three buckets that mirror VS Code's SCM
// view exactly:
//
//   conflicts — files in an unmerged state (codes DD, AU, UD, UA, DU, AA, UU);
//               these need user intervention before they can be staged.
//   staged    — entries with a non-space, non-'?' index code; safe to commit.
//   unstaged  — entries with a non-space worktree code, OR untracked files.
//
// A conflict file is reported ONCE (in `conflicts`); it does not appear under
// staged or unstaged. That matches VS Code's behaviour and prevents the user
// from accidentally `git add`ing a half-resolved file by clicking "Stage" in
// the Changes section.
const CONFLICT_KEYS = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);
function parsePorcelain(output) {
  const staged = [], unstaged = [], conflicts = [];
  // CRITICAL: do NOT .trim() the whole output before splitting. Git porcelain
  // lines are positional — the first character is the INDEX state and the
  // second character is the WORKTREE state. For an unstaged-only change the
  // first char is a literal space (" M file.py"). A top-level `.trim()`
  // strips the leading space off the FIRST line only, turning " M" into "M "
  // and mis-classifying the file as staged. We instead strip just the
  // trailing newline and let `.filter(Boolean)` drop blank lines.
  const raw = String(output || '').replace(/\r/g, '').replace(/\n+$/, '');
  for (const line of raw.split('\n').filter((l) => l.length > 0)) {
    const code0 = line[0] || ' ', code1 = line[1] || ' ';
    // Path starts at column 3 (porcelain is "XY <path>"); rename arrow ` -> `
    // separates from→to, the new name is what we display. The trailing
    // `.trim()` here is safe — it only trims the path, not the status codes.
    let path = line.slice(3).trim();
    if (path.includes(' -> ')) path = path.split(' -> ')[1].trim();
    path = path.replace(/^"(.*)"$/, '$1').trim();
    if (!path) continue;

    const codePair = code0 + code1;
    if (CONFLICT_KEYS.has(codePair)) {
      conflicts.push({ path, status: '!', conflictKind: codePair });
      continue;
    }
    if (code0 !== ' ' && code0 !== '?') staged.push({ path, status: code0 });
    if ((code1 !== ' ' && code1 !== '?') || code0 === '?')
      unstaged.push({ path, status: code0 === '?' ? 'U' : code1 });
  }
  return { staged, unstaged, conflicts };
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

// ─── Conflict row ─────────────────────────────────────────────────────────────
//
// Shows a conflicted file with three inline actions (mirrors VS Code's
// "Resolve in Merge Editor" / "Accept Current/Incoming" buttons):
//   ⬅ Accept Current Change  (--ours, then add)
//   ➡ Accept Incoming Change (--theirs, then add)
//   ✓ Mark as Resolved       (the user fixed the markers by hand)
// Clicking the row body opens the diff editor (HEAD ↔ working tree by
// default — DiffTab is built around 2-pane comparison; a full 3-way merge
// editor is a separate slice).
const CONFLICT_LABEL = {
  UU: 'Both modified',
  AA: 'Both added',
  DD: 'Both deleted',
  AU: 'Added by us',
  UA: 'Added by them',
  DU: 'Deleted by us',
  UD: 'Deleted by them',
};

const ConflictRow = memo(function ConflictRow({ file, onOpenDiff, onAcceptCurrent, onAcceptIncoming, onMarkResolved }) {
  const [hover, setHover] = useState(false);
  const { name, dir } = getFileInfo(file.path);
  const [IconComp, iconColor] = fileIcon(name);
  const kindLabel = CONFLICT_LABEL[file.conflictKind] || 'Conflict';

  // For DD (both deleted) there's no content to merge — the only sane action
  // is "Mark as Resolved" (which `git add` records the deletion).
  const isBothDeleted = file.conflictKind === 'DD';

  return (
    <div
      className="scm-file-row scm-conflict-row"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={() => onOpenDiff(file.path)}
      title={`${file.path} — ${kindLabel}`}
    >
      <IconComp size={13} style={{ color: iconColor, flexShrink: 0 }} />
      <span className="scm-file-name" style={{ color: '#f14c4c' }}>{name}</span>
      {dir && <span className="scm-file-dir">{dir}</span>}
      <div className="scm-file-row-right">
        {hover ? (
          <div className="scm-file-actions">
            {!isBothDeleted && (
              <button
                className="scm-file-action"
                title="Accept Current Change (ours)"
                onClick={e => { e.stopPropagation(); onAcceptCurrent(file.path); }}
              >
                <VscArrowDown size={13} style={{ transform: 'rotate(90deg)' }} />
              </button>
            )}
            {!isBothDeleted && (
              <button
                className="scm-file-action"
                title="Accept Incoming Change (theirs)"
                onClick={e => { e.stopPropagation(); onAcceptIncoming(file.path); }}
              >
                <VscArrowDown size={13} style={{ transform: 'rotate(-90deg)' }} />
              </button>
            )}
            <button
              className="scm-file-action"
              title="Mark as Resolved (stage)"
              onClick={e => { e.stopPropagation(); onMarkResolved(file.path); }}
            >
              <VscCheck size={13} />
            </button>
          </div>
        ) : (
          <span className="scm-status-letter" style={{ color: '#f14c4c' }} title={kindLabel}>!</span>
        )}
      </div>
    </div>
  );
});

// ─── Stash row ────────────────────────────────────────────────────────────────
// One row per `git stash list` entry. Hover reveals Pop / Apply / Drop. The
// row body shows the canonical stash ref (`stash@{N}`) plus the message git
// records ("WIP on main: 1234 init", or the user's `-m` text).
const StashRow = memo(function StashRow({ entry, onPop, onApply, onDrop }) {
  const [hover, setHover] = useState(false);
  return (
    <div
      className="scm-file-row"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={entry.message}
    >
      <SiGit size={13} style={{ color: '#f05033', flexShrink: 0 }} />
      <span className="scm-file-name" style={{ fontFamily: 'var(--font-mono, monospace)' }}>{entry.id}</span>
      <span className="scm-file-dir">{entry.message}</span>
      <div className="scm-file-row-right">
        {hover ? (
          <div className="scm-file-actions">
            <button className="scm-file-action" title="Apply (keep stash)"
              onClick={(e) => { e.stopPropagation(); onApply(); }}>
              <VscArrowDown size={13} />
            </button>
            <button className="scm-file-action" title="Pop (apply and drop)"
              onClick={(e) => { e.stopPropagation(); onPop(); }}>
              <VscArrowUp size={13} />
            </button>
            <button className="scm-file-action" title="Drop"
              onClick={(e) => { e.stopPropagation(); onDrop(); }}>
              <VscClose size={13} />
            </button>
          </div>
        ) : null}
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
  const [commitError, setCommitError] = useState(null);
  const [commitDropdown, setCommitDropdown] = useState(false);
  const [graphEntries, setGraphEntries] = useState([]);
  const [graphLoading, setGraphLoading] = useState(false);
  const [selectedCommit, setSelectedCommit] = useState(null);
  const [commitDetails, setCommitDetails] = useState(null);
  const [viewingDiff, setViewingDiff] = useState(null);
  // ── Hash-copy feedback. Stores the full hash that was just copied so the
  //    matching chip can briefly render "Copied!". A single shared piece of
  //    state (rather than per-chip) keeps the timer logic outside the row
  //    component, where it would otherwise cancel itself across re-renders.
  const [copiedHash, setCopiedHash] = useState(null);
  const [collapsed, setCollapsed]   = useState({ staged: false, changes: false, graph: false, stash: true });
  const [panelH, setPanelH]         = useState({ changes: 300 });
  const isResizing = useRef(null);
  const commitDropdownRef = useRef(null);
  const firstFetchDone = useRef(false);

  // Stash list — parsed `git stash list --format=%gd<TAB>%s`.
  // Each entry: { id: 'stash@{0}', message: 'WIP on main…' }
  const [stashList, setStashList] = useState([]);
  const [graphContextMenu, setGraphContextMenu] = useState(null); // { x, y, hash, subject }

  // ── New: branches / remotes / tags / merge-rebase state ────────────────────
  // The four picker-style features (branches, remotes, tags, merge-rebase) all
  // route through `activeModal` so only one is open at a time and the close
  // handler can be uniform. The `localBranches` / `remoteBranches` / `remotes`
  // / `tags` arrays are refreshed lazily — only when the respective modal
  // opens or after a write op that could have invalidated them.
  const [localBranches,  setLocalBranches]  = useState([]);
  const [remoteBranches, setRemoteBranches] = useState([]);
  const [remotes,        setRemotes]        = useState([]);
  const [tags,           setTags]           = useState([]);
  const [inProgress,     setInProgress]     = useState({});
  const [activeModal,    setActiveModal]    = useState(null);
    // one of: null | 'clone' | 'branches' | 'remotes' | 'tags' | 'merge' | 'rebase' | 'newBranch'
  const [moreMenuOpen,   setMoreMenuOpen]   = useState(false);
  const moreMenuRef = useRef(null);

  // Open a Monaco diff tab in the main editor area when an opener is available
  // (the App.js wiring exposes one). Falls back to the in-panel modal viewer
  // for embeddings that don't host the editor, preserving prior behaviour.
  const openDiffTab = useCallback((relPath, isStaged) => {
    if (typeof onOpenFile === 'function') {
      onOpenFile(buildDiffTabKey(relPath, isStaged ? 'STAGE' : 'HEAD'));
      return;
    }
    setViewingDiff({ path: relPath, isStaged: !!isStaged });
  }, [onOpenFile]);

  useEffect(() => {
    if (!commitDropdown) return;
    const h = e => { if (!commitDropdownRef.current?.contains(e.target)) setCommitDropdown(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [commitDropdown]);

  // ── Fetch git status via single bundle endpoint ─────────────────────────────
  const fetchStatus = useCallback(async (isBackground = false) => {
    if (!hasWorkspace) { setInitialLoading(false); setStatusOutput(null); setBranch(''); return; }
    if (!isBackground) { setError(null); setInitialLoading(true); }
    else setBgRefreshing(true);
    try {
      // Retry up to 3 times on transient network/timeout errors before giving up
      const data = await withRetry(() => fetchStatusBundle());
      if (!data.ok) {
        // "not a git repository" is a real error — show it
        if (!isBackground) {
          setStatusOutput(null);
          setError(data.error || 'Not a git repository');
          setBranch('');
          setHasUpstream(false);
          setAhead(0);
          setBehind(0);
        }
        return;
      }
      setStatusOutput(data.status ?? '');
      setBranch(data.branch || '');
      setHasUpstream(!!data.upstream);
      setAhead(data.ahead || 0);
      setBehind(data.behind || 0);
      // Clear any previous error once we succeed
      setError(null);
    } catch (e) {
      // On background polls, never overwrite the current UI with a timeout error —
      // the data the user sees stays intact and we silently retry on the next tick.
      if (!isBackground) {
        setStatusOutput(null);
        setBranch('');
        setHasUpstream(false);
        // Show a friendlier message instead of the raw axios timeout string
        const msg = e.message || '';
        setError(/timeout|ECONNABORTED/i.test(msg) ? 'Taking longer than usual — retrying…' : msg || 'Unable to read git status');
      }
    } finally {
      setInitialLoading(false);
      setBgRefreshing(false);
      firstFetchDone.current = true;
    }
  }, [hasWorkspace]);

  // Broadcast a refresh hint after any local git write so the explorer's
  // decoration map repaints instantly. App.js listens for this and debounces.
  const requestExplorerRefresh = useCallback(() => {
    try { window.dispatchEvent(new CustomEvent('nebula:git-refresh-request')); } catch (_) {}
  }, []);

  // Initial load
  useEffect(() => { fetchStatus(false); }, [fetchStatus]);

  // Background polling — no spinner flash, 15s interval to avoid piling up on slow repos
  useEffect(() => {
    if (!hasWorkspace) return;
    const id = setInterval(() => fetchStatus(true), 15000);
    return () => clearInterval(id);
  }, [fetchStatus, hasWorkspace]);

  // Live watcher: App.js opens a single WebSocket against /files/watch and
  // dispatches 'nebula:git-fs-change' whenever the OS watcher reports a
  // batch (debounced 200ms). We piggy-back on that so this panel refreshes
  // the instant the user's commit / stage / push lands, without waiting for
  // the 15s safety-net poll above.
  useEffect(() => {
    if (!hasWorkspace) return undefined;
    const onFsChange = () => fetchStatus(true);
    window.addEventListener('nebula:git-fs-change', onFsChange);
    return () => window.removeEventListener('nebula:git-fs-change', onFsChange);
  }, [fetchStatus, hasWorkspace]);

  // ── Fetch git graph ─────────────────────────────────────────────────────────
  const fetchGraph = useCallback(async () => {
    if (!hasWorkspace) return;
    setGraphLoading(true);
    try {
      // 2 min — large repos with deep history can be slow over a network drive.
      const res = await runCommand(
        'git log --format="%H%x00%P%x00%s%x00%an%x00%ar%x00%D" -80',
        { timeout: 120000 },
      );
      setGraphEntries(buildGraphLayout(parseGitLog(res.output || '')));
    } catch (_) { setGraphEntries([]); }
    finally { setGraphLoading(false); }
  }, [hasWorkspace]);

  const hasRepo = !error && statusOutput !== null;
  const { staged = [], unstaged = [], conflicts = [] } = hasRepo ? parsePorcelain(statusOutput) : {};
  const hasStaged = staged.length > 0;
  const hasConflicts = conflicts.length > 0;
  const hasChanges = hasStaged || unstaged.length > 0 || hasConflicts;
  // VS Code blocks `git commit` while there are unmerged paths — the index
  // is in a partial state and the user must resolve all conflicts first.
  const canCommit = hasChanges && commitMessage.trim() && !hasConflicts;

  useEffect(() => {
    if (hasWorkspace && hasRepo && !collapsed.graph && graphEntries.length === 0 && !graphLoading)
      fetchGraph();
  }, [hasWorkspace, hasRepo, collapsed.graph, graphEntries.length, graphLoading, fetchGraph]);

  // ── Git operations ──────────────────────────────────────────────────────────
  const handleStage   = async p => { try { await runGit(['add', p]); await fetchStatus(true); requestExplorerRefresh(); } catch (e) { setError(e.message); } };
  const handleUnstage = async p => { try { await runGit(['reset', 'HEAD', p]); await fetchStatus(true); requestExplorerRefresh(); } catch (e) { setError(e.message); } };
  const handleDiscard = async p => {
    if (!window.confirm(`Discard changes in ${p}?`)) return;
    try { await runGit(['checkout', '--', p]); await fetchStatus(true); requestExplorerRefresh(); } catch (e) { setError(e.message); }
  };

  // ── Merge conflict resolution ───────────────────────────────────────────────
  // VS Code exposes three top-level actions on each conflicted file:
  //   Accept Current Change (--ours)   → `git checkout --ours <p> && git add <p>`
  //   Accept Incoming Change (--theirs)→ `git checkout --theirs <p> && git add <p>`
  //   Open the side-by-side merge diff → we open OURS ↔ THEIRS via DiffTab
  // After any "accept" we re-fetch status; once all conflicts vanish the
  // commit button re-enables automatically.
  const handleAcceptCurrent = useCallback(async (p) => {
    try {
      const r1 = await runGit(['checkout', '--ours', '--', p]);
      if (r1.exit_code !== 0) { setError(friendlyGitError(r1.output)); return; }
      const r2 = await runGit(['add', p]);
      if (r2.exit_code !== 0) { setError(friendlyGitError(r2.output)); return; }
      await fetchStatus(true);
      requestExplorerRefresh();
    } catch (e) { setError(friendlyGitError(e.message)); }
  }, [fetchStatus, requestExplorerRefresh]);

  const handleAcceptIncoming = useCallback(async (p) => {
    try {
      const r1 = await runGit(['checkout', '--theirs', '--', p]);
      if (r1.exit_code !== 0) { setError(friendlyGitError(r1.output)); return; }
      const r2 = await runGit(['add', p]);
      if (r2.exit_code !== 0) { setError(friendlyGitError(r2.output)); return; }
      await fetchStatus(true);
      requestExplorerRefresh();
    } catch (e) { setError(friendlyGitError(e.message)); }
  }, [fetchStatus, requestExplorerRefresh]);

  // "Mark as resolved" — the user manually edited the file and just wants to
  // tell git the conflict markers are gone. Same as `git add` but framed
  // explicitly so the user understands the consequence.
  const handleMarkResolved = useCallback(async (p) => {
    try {
      const r = await runGit(['add', p]);
      if (r.exit_code !== 0) { setError(friendlyGitError(r.output)); return; }
      await fetchStatus(true);
      requestExplorerRefresh();
    } catch (e) { setError(friendlyGitError(e.message)); }
  }, [fetchStatus, requestExplorerRefresh]);

  // ── Stash operations ────────────────────────────────────────────────────────
  // `git stash list --format=%gd%x09%s` → `stash@{0}<TAB>WIP on main: 1234 init`
  const fetchStashList = useCallback(async () => {
    if (!hasWorkspace) return;
    try {
      const r = await runGit(['stash', 'list', '--format=%gd%x09%s']);
      if (r.exit_code !== 0) { setStashList([]); return; }
      const entries = (r.output || '').trim().split('\n').filter(Boolean).map(line => {
        const tab = line.indexOf('\t');
        if (tab < 0) return { id: line.trim(), message: '' };
        return { id: line.slice(0, tab).trim(), message: line.slice(tab + 1).trim() };
      });
      setStashList(entries);
    } catch (_) { setStashList([]); }
  }, [hasWorkspace]);

  const handleStashPush = useCallback(async () => {
    const msg = (window.prompt('Stash message (optional):', '') || '').trim();
    try {
      const args = msg ? ['stash', 'push', '-m', msg] : ['stash', 'push'];
      const r = await runGit(args);
      if (r.exit_code !== 0) setError(friendlyGitError(r.output));
      await fetchStatus(true);
      await fetchStashList();
      requestExplorerRefresh();
    } catch (e) { setError(friendlyGitError(e.message)); }
  }, [fetchStatus, fetchStashList, requestExplorerRefresh]);

  const handleStashPop = useCallback(async (id) => {
    try {
      const r = await runGit(['stash', 'pop', id]);
      if (r.exit_code !== 0) setError(friendlyGitError(r.output));
      await fetchStatus(true);
      await fetchStashList();
      requestExplorerRefresh();
    } catch (e) { setError(friendlyGitError(e.message)); }
  }, [fetchStatus, fetchStashList, requestExplorerRefresh]);

  const handleStashApply = useCallback(async (id) => {
    try {
      const r = await runGit(['stash', 'apply', id]);
      if (r.exit_code !== 0) setError(friendlyGitError(r.output));
      await fetchStatus(true);
      requestExplorerRefresh();
    } catch (e) { setError(friendlyGitError(e.message)); }
  }, [fetchStatus, requestExplorerRefresh]);

  const handleStashDrop = useCallback(async (id) => {
    if (!window.confirm(`Drop ${id}? This cannot be undone.`)) return;
    try {
      const r = await runGit(['stash', 'drop', id]);
      if (r.exit_code !== 0) setError(friendlyGitError(r.output));
      await fetchStashList();
    } catch (e) { setError(friendlyGitError(e.message)); }
  }, [fetchStashList]);

  // ── Branches / Remotes / Tags / In-progress fetchers ────────────────────────
  //
  // Each fetcher silently no-ops when the workspace is closed, mirrors the
  // pattern used by fetchStashList. We expose them so action handlers can
  // refresh state without re-renders crossing module boundaries.
  const refreshBranches = useCallback(async () => {
    if (!hasWorkspace) { setLocalBranches([]); setRemoteBranches([]); return; }
    try {
      const data = await listBranches();
      if (data?.ok) {
        setLocalBranches(data.local || []);
        setRemoteBranches(data.remote || []);
      }
    } catch (_) { /* surfaced via fetchStatus error banner if persistent */ }
  }, [hasWorkspace]);

  const refreshRemotes = useCallback(async () => {
    if (!hasWorkspace) { setRemotes([]); return; }
    try {
      const data = await listRemotes();
      if (data?.ok) setRemotes(data.remotes || []);
    } catch (_) {}
  }, [hasWorkspace]);

  const refreshTags = useCallback(async () => {
    if (!hasWorkspace) { setTags([]); return; }
    try {
      const data = await listTags();
      if (data?.ok) setTags(data.tags || []);
    } catch (_) {}
  }, [hasWorkspace]);

  const refreshInProgress = useCallback(async () => {
    if (!hasWorkspace) { setInProgress({}); return; }
    try {
      const data = await gitProgress();
      if (data?.ok) setInProgress(data.inProgress || {});
    } catch (_) {}
  }, [hasWorkspace]);

  // Auto-refresh in-progress state whenever the file-watcher fires — that's
  // exactly when MERGE_HEAD / rebase-merge appears or disappears.
  useEffect(() => {
    if (!hasWorkspace) return undefined;
    refreshInProgress();
    const onFsChange = () => refreshInProgress();
    window.addEventListener('nebula:git-fs-change', onFsChange);
    return () => window.removeEventListener('nebula:git-fs-change', onFsChange);
  }, [hasWorkspace, refreshInProgress]);

  // ── Branch actions ──────────────────────────────────────────────────────────
  const handleSwitchBranch = useCallback(async (name) => {
    try {
      const r = await switchBranch(name);
      if (r.exit_code !== 0) { setError(friendlyGitError(r.output)); return; }
      setActiveModal(null);
      await fetchStatus(true);
      await refreshBranches();
      setGraphEntries([]);
      requestExplorerRefresh();
    } catch (e) { setError(friendlyGitError(e.message)); }
  }, [fetchStatus, refreshBranches, requestExplorerRefresh]);

  const handleCheckoutRemote = useCallback(async (remoteRef) => {
    try {
      const r = await checkoutRemoteBranch(remoteRef);
      if (r.exit_code !== 0) { setError(friendlyGitError(r.output)); return; }
      setActiveModal(null);
      await fetchStatus(true);
      await refreshBranches();
      setGraphEntries([]);
      requestExplorerRefresh();
    } catch (e) { setError(friendlyGitError(e.message)); }
  }, [fetchStatus, refreshBranches, requestExplorerRefresh]);

  const handleCreateBranch = useCallback(async (name) => {
    const clean = (name || '').trim();
    if (!clean) return;
    try {
      const r = await createAndSwitchBranch(clean);
      if (r.exit_code !== 0) { setError(friendlyGitError(r.output)); return; }
      setActiveModal(null);
      await fetchStatus(true);
      await refreshBranches();
      setGraphEntries([]);
      requestExplorerRefresh();
    } catch (e) { setError(friendlyGitError(e.message)); }
  }, [fetchStatus, refreshBranches, requestExplorerRefresh]);

  const handleDeleteBranch = useCallback(async (name, force = false) => {
    if (!window.confirm(`Delete branch "${name}"?${force ? ' This is irreversible.' : ''}`)) return;
    try {
      const r = await deleteBranch(name, force);
      if (r.exit_code !== 0) {
        // git refuses to delete unmerged branches without -D; offer force-delete.
        if (!force && /not fully merged/i.test(r.output || '')) {
          if (window.confirm(`Branch "${name}" is not fully merged. Force-delete?`)) {
            return handleDeleteBranch(name, true);
          }
          return;
        }
        setError(friendlyGitError(r.output));
        return;
      }
      await refreshBranches();
    } catch (e) { setError(friendlyGitError(e.message)); }
  }, [refreshBranches]);

  const handleRenameBranch = useCallback(async (oldName) => {
    const newName = (window.prompt(`Rename branch "${oldName}" to:`, oldName) || '').trim();
    if (!newName || newName === oldName) return;
    try {
      const r = await renameBranch(oldName, newName);
      if (r.exit_code !== 0) { setError(friendlyGitError(r.output)); return; }
      await fetchStatus(true);
      await refreshBranches();
    } catch (e) { setError(friendlyGitError(e.message)); }
  }, [fetchStatus, refreshBranches]);

  // ── Remote actions ──────────────────────────────────────────────────────────
  const handleAddRemote = useCallback(async (name, url) => {
    const cleanName = (name || '').trim();
    const cleanUrl  = (url || '').trim();
    if (!cleanName || !cleanUrl) return;
    try {
      const r = await addRemote(cleanName, cleanUrl);
      if (r.exit_code !== 0) { setError(friendlyGitError(r.output)); return; }
      await refreshRemotes();
    } catch (e) { setError(friendlyGitError(e.message)); }
  }, [refreshRemotes]);

  const handleRemoveRemote = useCallback(async (name) => {
    if (!window.confirm(`Remove remote "${name}"?`)) return;
    try {
      const r = await removeRemote(name);
      if (r.exit_code !== 0) { setError(friendlyGitError(r.output)); return; }
      await refreshRemotes();
    } catch (e) { setError(friendlyGitError(e.message)); }
  }, [refreshRemotes]);

  const handleRenameRemote = useCallback(async (oldName) => {
    const newName = (window.prompt(`Rename remote "${oldName}" to:`, oldName) || '').trim();
    if (!newName || newName === oldName) return;
    try {
      const r = await renameRemote(oldName, newName);
      if (r.exit_code !== 0) { setError(friendlyGitError(r.output)); return; }
      await refreshRemotes();
    } catch (e) { setError(friendlyGitError(e.message)); }
  }, [refreshRemotes]);

  const handleSetRemoteUrl = useCallback(async (name, currentUrl) => {
    const url = (window.prompt(`New URL for "${name}":`, currentUrl || '') || '').trim();
    if (!url || url === currentUrl) return;
    try {
      const r = await setRemoteUrl(name, url);
      if (r.exit_code !== 0) { setError(friendlyGitError(r.output)); return; }
      await refreshRemotes();
    } catch (e) { setError(friendlyGitError(e.message)); }
  }, [refreshRemotes]);

  // ── Tag actions ─────────────────────────────────────────────────────────────
  const handleCreateTag = useCallback(async (name, message) => {
    const clean = (name || '').trim();
    if (!clean) return;
    try {
      const r = await createTag(clean, (message || '').trim() || undefined);
      if (r.exit_code !== 0) { setError(friendlyGitError(r.output)); return; }
      await refreshTags();
    } catch (e) { setError(friendlyGitError(e.message)); }
  }, [refreshTags]);

  const handleDeleteTag = useCallback(async (name) => {
    if (!window.confirm(`Delete tag "${name}"?`)) return;
    try {
      const r = await deleteTag(name);
      if (r.exit_code !== 0) { setError(friendlyGitError(r.output)); return; }
      await refreshTags();
    } catch (e) { setError(friendlyGitError(e.message)); }
  }, [refreshTags]);

  const handlePushTag = useCallback(async (name) => {
    try {
      const r = await pushTag(name);
      if (r.exit_code !== 0) setError(friendlyGitError(r.output));
    } catch (e) { setError(friendlyGitError(e.message)); }
  }, []);

  const handlePushAllTags = useCallback(async () => {
    try {
      const r = await pushAllTags();
      if (r.exit_code !== 0) setError(friendlyGitError(r.output));
    } catch (e) { setError(friendlyGitError(e.message)); }
  }, []);

  // ── Merge / Rebase ──────────────────────────────────────────────────────────
  const handleMerge = useCallback(async (branchName, noFF = false) => {
    try {
      const r = await mergeBranch(branchName, noFF);
      if (r.exit_code !== 0) setError(friendlyGitError(r.output));
      setActiveModal(null);
      await fetchStatus(true);
      await refreshInProgress();
      await fetchGraph();
      requestExplorerRefresh();
    } catch (e) { setError(friendlyGitError(e.message)); }
  }, [fetchStatus, refreshInProgress, fetchGraph, requestExplorerRefresh]);

  const handleRebase = useCallback(async (branchName) => {
    try {
      const r = await rebaseOnto(branchName);
      if (r.exit_code !== 0) setError(friendlyGitError(r.output));
      setActiveModal(null);
      await fetchStatus(true);
      await refreshInProgress();
      await fetchGraph();
      requestExplorerRefresh();
    } catch (e) { setError(friendlyGitError(e.message)); }
  }, [fetchStatus, refreshInProgress, fetchGraph, requestExplorerRefresh]);

  // Abort / Continue helpers — same shape so we can wire them as a single
  // dispatcher inside the in-progress banner.
  const handleAbortInProgress = useCallback(async () => {
    if (!window.confirm('Abort the in-progress operation? Working-tree changes from it will be discarded.')) return;
    try {
      if (inProgress.merge)         await abortMerge();
      else if (inProgress.rebase)   await abortRebase();
      else if (inProgress.cherryPick) await abortCherryPick();
      await fetchStatus(true);
      await refreshInProgress();
    } catch (e) { setError(friendlyGitError(e.message)); }
  }, [inProgress, fetchStatus, refreshInProgress]);

  const handleContinueInProgress = useCallback(async () => {
    try {
      if (inProgress.merge)            await continueMerge();
      else if (inProgress.rebase)      await continueRebase();
      else if (inProgress.cherryPick)  await continueCherryPick();
      await fetchStatus(true);
      await refreshInProgress();
      await fetchGraph();
      requestExplorerRefresh();
    } catch (e) { setError(friendlyGitError(e.message)); }
  }, [inProgress, fetchStatus, refreshInProgress, fetchGraph, requestExplorerRefresh]);

  const handleSkipInProgress = useCallback(async () => {
    try {
      if (inProgress.rebase) await skipRebase();
      await fetchStatus(true);
      await refreshInProgress();
    } catch (e) { setError(friendlyGitError(e.message)); }
  }, [inProgress, fetchStatus, refreshInProgress]);

  // ── Clone ───────────────────────────────────────────────────────────────────
  const handleClone = useCallback(async ({ url, targetDir, branch, depth }) => {
    try {
      const r = await gitClone({ url, targetDir, branch, depth: depth ? Number(depth) : undefined });
      if (!r.ok) {
        setError(friendlyGitError(r.output));
        return null;
      }
      setActiveModal(null);
      return r.target;
    } catch (e) {
      setError(friendlyGitError(e.message));
      return null;
    }
  }, []);

  // Close the more-actions menu when clicking outside.
  useEffect(() => {
    if (!moreMenuOpen) return undefined;
    const h = (e) => { if (!moreMenuRef.current?.contains(e.target)) setMoreMenuOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [moreMenuOpen]);

  // ── Commit-graph actions (right-click on a row) ─────────────────────────────
  const handleCherryPick = useCallback(async (hash) => {
    try {
      const r = await runGit(['cherry-pick', hash], { timeout: 90000 });
      if (r.exit_code !== 0) setError(friendlyGitError(r.output));
      await fetchStatus(true);
      await fetchGraph();
      requestExplorerRefresh();
    } catch (e) { setError(friendlyGitError(e.message)); }
  }, [fetchStatus, fetchGraph, requestExplorerRefresh]);

  const handleResetTo = useCallback(async (hash, mode) => {
    // mode: 'soft' | 'mixed' | 'hard'
    const confirmMsg = mode === 'hard'
      ? `Hard-reset to ${hash.slice(0, 7)}? Working tree changes will be DISCARDED.`
      : `Reset to ${hash.slice(0, 7)} (${mode})?`;
    if (!window.confirm(confirmMsg)) return;
    try {
      const r = await runGit(['reset', `--${mode}`, hash]);
      if (r.exit_code !== 0) setError(friendlyGitError(r.output));
      await fetchStatus(true);
      await fetchGraph();
      requestExplorerRefresh();
    } catch (e) { setError(friendlyGitError(e.message)); }
  }, [fetchStatus, fetchGraph, requestExplorerRefresh]);

  // Initial stash fetch + refresh on demand.
  useEffect(() => {
    if (!hasWorkspace) { setStashList([]); return; }
    fetchStashList();
  }, [hasWorkspace, fetchStashList]);

  // Stash list is also stale after every write op — re-fetch when the panel
  // refreshes its status bundle.
  useEffect(() => {
    if (!hasWorkspace) return undefined;
    const onFsChange = () => fetchStashList();
    window.addEventListener('nebula:git-fs-change', onFsChange);
    return () => window.removeEventListener('nebula:git-fs-change', onFsChange);
  }, [hasWorkspace, fetchStashList]);

  // Open a 2-pane diff comparing OURS (index stage 2) vs THEIRS (stage 3).
  // The user can also see BASE (stage 1) by switching tools — we ship the
  // simple OURS↔THEIRS view first, matching VS Code's default merge editor.
  const handleOpenConflictDiff = useCallback((p) => {
    if (typeof onOpenFile !== 'function') return;
    // The "against" value is plumbed through DiffTab; here we want HEAD on
    // the left so the user sees their branch as the baseline. (We could
    // build a dedicated 3-way view later — out of scope for this slice.)
    onOpenFile(buildDiffTabKey(p, 'HEAD'));
  }, [onOpenFile]);

  const doCommit = async (stageAllFirst = false) => {
    if (!commitMessage.trim()) { setCommitError('Enter a commit message.'); return false; }
    // If nothing staged but there are unstaged changes, auto-stage all (VS Code behavior)
    if (staged.length === 0) {
      if (unstaged.length > 0) {
        // Silently stage all unstaged files, then commit
        try {
          const stageResult = await runGit(['add', '-A']);
          if (stageResult.exit_code !== 0) {
            setCommitError('Failed to stage changes: ' + friendlyGitError(stageResult.output));
            return false;
          }
        } catch (e) { setCommitError(friendlyGitError(e.message)); return false; }
      } else {
        setCommitError('Nothing to commit — working tree is clean.');
        return false;
      }
    }
    setCommitting(true);
    setCommitError(null);
    try {
      const r = await runGit(['commit', '-m', commitMessage.trim()]);
      if (r.exit_code !== 0) { setCommitError(friendlyGitError(r.output)); return false; }
      setCommitMessage('');
      setCommitError(null);
      await fetchStatus(true);
      setGraphEntries([]);
      requestExplorerRefresh();
      return true;
    } catch (e) { setCommitError(friendlyGitError(e.message)); return false; }
    finally { setCommitting(false); }
  };

  const handleCommit = async () => { await doCommit(); };

  const handleCommitAndPush = async () => {
    setCommitDropdown(false);
    const ok = await doCommit();
    if (!ok) return;
    setInitialLoading(true);
    setCommitError(null);
    try {
      const pushArgs = (!hasUpstream && branch)
        ? ['push', '--set-upstream', 'origin', branch]
        : ['push'];
      const r = await runGit(pushArgs, { timeout: 120000 });
      if (r.exit_code !== 0) setCommitError(friendlyGitError(r.output));
      else { await fetchStatus(true); await fetchGraph(); requestExplorerRefresh(); }
    } catch (e) { setCommitError(friendlyGitError(e.message)); }
    finally { setInitialLoading(false); }
  };

  const handlePush = async () => {
    setInitialLoading(true);
    setCommitError(null);
    try {
      const pushArgs = (!hasUpstream && branch) ? ['push', '--set-upstream', 'origin', branch] : ['push'];
      const r = await runGit(pushArgs, { timeout: 120000 });
      if (r.exit_code !== 0) setCommitError(friendlyGitError(r.output));
      else { await fetchStatus(true); requestExplorerRefresh(); }
    } catch (e) { setCommitError(friendlyGitError(e.message)); } finally { setInitialLoading(false); }
  };
  const handlePull = async () => {
    setInitialLoading(true);
    setCommitError(null);
    try {
      const r = await runGit(['pull'], { timeout: 120000 });
      if (r.exit_code !== 0) setCommitError(friendlyGitError(r.output));
      else { await fetchStatus(true); requestExplorerRefresh(); }
    } catch (e) { setCommitError(friendlyGitError(e.message)); } finally { setInitialLoading(false); }
  };
  const handleFetch = async () => {
    setInitialLoading(true);
    setCommitError(null);
    try { await runGit(['fetch']); await fetchStatus(true); requestExplorerRefresh(); }
    catch (e) { setCommitError(friendlyGitError(e.message)); } finally { setInitialLoading(false); }
  };

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

  // ── Copy commit hash with transient feedback ────────────────────────────────
  // Reusable across the graph hash chip and the commit-details header chip.
  // We deliberately copy the FULL 40-char hash (not the 7-char abbrev) so the
  // user can paste it into a CLI or another tool without ambiguity.
  const copyHashTimer = useRef(null);
  const handleCopyHash = useCallback((fullHash) => {
    if (!fullHash) return;
    try { navigator.clipboard && navigator.clipboard.writeText(fullHash); } catch (_) {}
    setCopiedHash(fullHash);
    if (copyHashTimer.current) clearTimeout(copyHashTimer.current);
    copyHashTimer.current = setTimeout(() => setCopiedHash(null), 1500);
  }, []);

  // ── SCM panel resize ──────────────────────────────────────────────────────
  //
  // Why ref-based imperative resize instead of `style={{ height }}` + setState?
  //
  // The Changes section must NOT have `style={{ height: panelH.changes }}` in
  // JSX. If it does, every React re-render between mousedown and mouseup —
  // and there are many: status polls, file-watcher events, parent re-renders
  // from sibling state — will reset the height back to the stale
  // `panelH.changes` value, undoing the drag's in-progress DOM write. That
  // was the bug we were chasing: the math was right, the DOM write fired,
  // but a re-render half a frame later wiped it out.
  //
  // The robust pattern instead:
  //   * Hold the element in `panelMainRef`.
  //   * On mount / on external state change, a useEffect syncs
  //     `panelH.changes` → `el.style.height` so the user's persisted
  //     preference survives reloads.
  //   * During drag, write directly to `el.style.height` only — no setState,
  //     no React render path involvement. Final value is committed to state
  //     on mouseup so it persists across remounts.
  const panelMainRef = useRef(null);

  // Sync state → DOM. Runs on mount and whenever panelH.changes changes
  // from a non-drag source. During an active drag we don't change state, so
  // this effect doesn't fire — the DOM is purely under startResize's control.
  useEffect(() => {
    if (panelMainRef.current) {
      panelMainRef.current.style.height = panelH.changes + 'px';
    }
  }, [panelH.changes]);

  const startResize = useCallback((e) => {
    e.preventDefault();
    const startY   = e.clientY;
    const handleEl = e.currentTarget;
    const el       = panelMainRef.current;
    if (!el) return;
    const startH   = el.getBoundingClientRect().height;
    const bodyEl   = handleEl?.closest?.('.scm-panel-body');
    const totalH   = bodyEl ? bodyEl.getBoundingClientRect().height : 800;
    const maxH     = Math.max(120, totalH - 120);

    let lastH = startH;
    const handleMouseMove = (ev) => {
      const delta = ev.clientY - startY;
      const next  = Math.max(80, Math.min(maxH, startH + delta));
      if (next === lastH) return;
      lastH = next;
      el.style.height = next + 'px';
    };
    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup',   handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      handleEl?.classList?.remove('resizing');
      if (lastH !== startH) {
        // Commit final height to state so it survives remounts (e.g. when
        // the user switches sidebar panels and comes back). The sync-effect
        // above re-applies it imperatively after the next render.
        setPanelH((p) => (p.changes === lastH ? p : { ...p, changes: lastH }));
      }
    };

    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
    handleEl?.classList?.add('resizing');
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup',   handleMouseUp);
  }, []);

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
            <button
              className="scm-branch-badge"
              title={`${branch} — click to switch / manage branches`}
              onClick={() => { refreshBranches(); setActiveModal('branches'); }}
              style={{ cursor: 'pointer', background: 'transparent', border: 'none', font: 'inherit', color: 'inherit', padding: 0 }}
            >
              <VscGitMerge size={10} style={{ marginRight: 3 }} />
              {branch}
              {(ahead > 0 || behind > 0) && (
                <span style={{ marginLeft: 4, opacity: 0.7 }}>
                  {ahead > 0 && <span title={`${ahead} ahead`}>↑{ahead}</span>}
                  {behind > 0 && <span title={`${behind} behind`} style={{ marginLeft: 2 }}>↓{behind}</span>}
                </span>
              )}
            </button>
          )}
          {bgRefreshing && <div className="scm-spinner scm-spinner-sm" title="Refreshing…" />}
          <button className="scm-icon-btn" title="Refresh" onClick={() => fetchStatus(false)}><VscRefresh size={14} /></button>
          <div ref={moreMenuRef} style={{ position: 'relative' }}>
            <button
              className="scm-icon-btn"
              title="More Actions"
              onClick={() => setMoreMenuOpen((v) => !v)}
            >
              <VscEllipsis size={14} />
            </button>
            {moreMenuOpen && (
              <div className="scm-commit-dropdown" style={{ right: 0, left: 'auto', top: '100%', minWidth: 200 }}>
                <div className="scm-commit-dropdown-item" onClick={() => { setMoreMenuOpen(false); handlePull(); }}>
                  <VscArrowDown size={13} /> Pull
                </div>
                <div className="scm-commit-dropdown-item" onClick={() => { setMoreMenuOpen(false); handlePush(); }}>
                  <VscArrowUp size={13} /> Push
                </div>
                <div className="scm-commit-dropdown-item" onClick={() => { setMoreMenuOpen(false); handleFetch(); }}>
                  <VscTarget size={13} /> Fetch
                </div>
                <div className="scm-commit-dropdown-sep" />
                <div className="scm-commit-dropdown-item" onClick={() => { setMoreMenuOpen(false); refreshBranches(); setActiveModal('branches'); }}>
                  <VscGitMerge size={13} /> Checkout to…
                </div>
                <div className="scm-commit-dropdown-item" onClick={() => { setMoreMenuOpen(false); setActiveModal('newBranch'); }}>
                  <VscAdd size={13} /> Create Branch…
                </div>
                <div className="scm-commit-dropdown-item" onClick={() => { setMoreMenuOpen(false); refreshBranches(); setActiveModal('merge'); }}>
                  Merge Branch…
                </div>
                <div className="scm-commit-dropdown-item" onClick={() => { setMoreMenuOpen(false); refreshBranches(); setActiveModal('rebase'); }}>
                  Rebase Branch…
                </div>
                <div className="scm-commit-dropdown-sep" />
                <div className="scm-commit-dropdown-item" onClick={() => { setMoreMenuOpen(false); refreshRemotes(); setActiveModal('remotes'); }}>
                  <VscCloud size={13} /> Manage Remotes…
                </div>
                <div className="scm-commit-dropdown-item" onClick={() => { setMoreMenuOpen(false); refreshTags(); setActiveModal('tags'); }}>
                  <VscTag size={13} /> Manage Tags…
                </div>
                <div className="scm-commit-dropdown-sep" />
                <div className="scm-commit-dropdown-item" onClick={() => { setMoreMenuOpen(false); setActiveModal('clone'); }}>
                  <VscRepoClone size={13} /> Clone Repository…
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {!hasRepo ? (
        <div className="scm-empty">
          <VscSourceControl size={40} className="scm-empty-icon" />
          <p className="scm-empty-text">{typeof error === 'string' ? error : 'No git repository found.'}</p>
          <button className="scm-btn primary" onClick={async () => {
            setInitialLoading(true);
            try {
              const r = await gitInit();
              if (!r.ok) setError(friendlyGitError(r.output || 'init failed'));
              await fetchStatus(false);
            } catch (e) {
              setError(friendlyGitError(e.message));
            } finally {
              setInitialLoading(false);
            }
          }}>
            Initialize Repository
          </button>
          <button
            className="scm-btn"
            style={{ marginTop: 8 }}
            onClick={() => setActiveModal('clone')}
          >
            <VscRepoClone size={12} style={{ marginRight: 6, verticalAlign: '-2px' }} />
            Clone Repository
          </button>
        </div>
      ) : (
        <div className="scm-panel-body">
          {error && <div className="scm-error-banner">{typeof error === 'string' ? error : 'Git error'}</div>}

          {/* ── In-progress banner ─────────────────────────────────────────────
              Mirrors VS Code's "You have a merge in progress" pill at the top
              of the SCM panel. Visible whenever .git/MERGE_HEAD,
              .git/rebase-merge/, .git/rebase-apply/, or CHERRY_PICK_HEAD exists.
              The Continue button is only safe when there are no unresolved
              conflicts — match VS Code's disabled state for that case. */}
          {(inProgress.merge || inProgress.rebase || inProgress.cherryPick) && (
            <div className="scm-error-banner" style={{
              background: 'rgba(245, 158, 11, 0.12)',
              borderLeft: '3px solid #f59e0b',
              color: 'var(--text-primary, #d4d4d4)',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              flexWrap: 'wrap',
            }}>
              <strong style={{ marginRight: 4 }}>
                {inProgress.merge ? 'Merge' : inProgress.rebase ? 'Rebase' : 'Cherry-pick'} in progress.
              </strong>
              <span style={{ opacity: 0.85, fontSize: 11 }}>
                {hasConflicts
                  ? 'Resolve conflicts above, then Continue.'
                  : 'Stage your resolutions, then Continue — or Abort to roll back.'}
              </span>
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                <button
                  className="scm-btn"
                  disabled={hasConflicts}
                  onClick={handleContinueInProgress}
                  title={hasConflicts ? 'Resolve conflicts first' : 'Continue'}
                >
                  Continue
                </button>
                {inProgress.rebase && (
                  <button className="scm-btn" onClick={handleSkipInProgress} title="Skip this commit">
                    Skip
                  </button>
                )}
                <button className="scm-btn" onClick={handleAbortInProgress} title="Abort and roll back">
                  Abort
                </button>
              </div>
            </div>
          )}

          {/* ── Changes area ─────────────────────────────────────────────────── */}
          {/*
            Height is managed imperatively via panelMainRef + a useEffect that
            syncs panelH.changes → DOM. We intentionally do NOT set
            `style={{ height }}` here because React re-rendering during a
            drag (status polls, file-watcher events, etc.) would overwrite
            the in-progress drag's DOM height with the stale state value.
            See the comment on startResize for the full reasoning.
          */}
          <div className="scm-panel-main" ref={panelMainRef}>

            {/* Commit input */}
            <div className="scm-commit-section">
            {commitError && (
              <div className="scm-commit-error-banner">
                <span>{commitError}</span>
                <button className="scm-commit-error-dismiss" onClick={() => setCommitError(null)}>✕</button>
              </div>
            )}
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
                      try {
                        await handleStashPush();
                      } catch (e) { setError(e.message); }
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

            {/* Merge Changes — VS Code parity: list of unmerged paths with
                Accept Current / Accept Incoming / Open Diff / Mark Resolved
                actions. Rendered above Staged so the user can't miss it. */}
            {hasConflicts && (
              <div className="scm-section">
                <SectionHeader
                  title="Merge Changes" count={conflicts.length}
                  collapsed={false} onToggle={() => {}}
                />
                <div className="scm-file-list">
                  {conflicts.map(file => (
                    <ConflictRow
                      key={file.path}
                      file={file}
                      onOpenDiff={p => handleOpenConflictDiff(p)}
                      onAcceptCurrent={handleAcceptCurrent}
                      onAcceptIncoming={handleAcceptIncoming}
                      onMarkResolved={handleMarkResolved}
                    />
                  ))}
                </div>
              </div>
            )}

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
                        onOpenDiff={p => openDiffTab(p, true)}
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
                        onOpenDiff={p => openDiffTab(p, false)}
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

          <div
            className="scm-resize-handle"
            role="separator"
            aria-orientation="horizontal"
            title="Drag to resize"
            onMouseDown={startResize}
          />

          {/* ── Stashes ──────────────────────────────────────────────────────
              Collapsed by default; auto-shows a count badge. Each row reveals
              Pop / Apply / Drop on hover (mirrors VS Code stash list). */}
          {stashList.length > 0 && (
            <div className="scm-section">
              <SectionHeader
                title="Stashes"
                count={stashList.length}
                collapsed={collapsed.stash}
                onToggle={() => toggle('stash')}
                actions={
                  <button className="scm-file-action" title="Refresh stash list"
                    onClick={(e) => { e.stopPropagation(); fetchStashList(); }}>
                    <VscRefresh size={13} />
                  </button>
                }
              />
              {!collapsed.stash && (
                <div className="scm-file-list">
                  {stashList.map(s => (
                    <StashRow
                      key={s.id}
                      entry={s}
                      onPop={() => handleStashPop(s.id)}
                      onApply={() => handleStashApply(s.id)}
                      onDrop={() => handleStashDrop(s.id)}
                    />
                  ))}
                </div>
              )}
            </div>
          )}

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
                              onContextMenu={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                setGraphContextMenu({
                                  x: e.clientX,
                                  y: e.clientY,
                                  hash: entry.hash,
                                  subject: entry.subject || entry.hash.slice(0, 7),
                                });
                              }}
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
                                  <CommitHashChip
                                    fullHash={entry.hash}
                                    copied={copiedHash === entry.hash}
                                    onCopy={(e) => { e.stopPropagation(); handleCopyHash(entry.hash); }}
                                  />
                                </div>
                              </div>
                            </div>

                            {isSelected && commitDetails && (
                              <div className="scm-commit-details">
                                <div className="scm-commit-details-header">
                                  <CommitHashChip
                                    fullHash={commitDetails.hash}
                                    copied={copiedHash === commitDetails.hash}
                                    onCopy={(e) => { e.stopPropagation(); handleCopyHash(commitDetails.hash); }}
                                    asCode
                                  />
                                  <strong className="scm-commit-details-author">{commitDetails.author}</strong>
                                  <span className="scm-commit-details-date">{commitDetails.date}</span>
                                </div>
                                <div className="scm-commit-details-body">{commitDetails.subject}</div>
                                {commitDetails.body && <div className="scm-commit-details-full">{commitDetails.body}</div>}
                                <div className="scm-commit-details-files">
                                  {commitDetails.files?.map((f, fi) => {
                                    const [FIcon, fColor] = fileIcon(f.path.split('/').pop());
                                    const fsc = statusCfg(f.status[0]);
                                    // Click → open a Monaco diff tab in the main editor area
                                    // comparing `<hash>^` (parent) vs `<hash>`. That's the canonical
                                    // "what did this commit do to this file" view. Falls back to
                                    // a no-op if the host didn't supply an `onOpenFile` opener.
                                    const openInEditor = () => {
                                      if (typeof onOpenFile !== 'function') return;
                                      onOpenFile(buildDiffTabKey(f.path, `COMMIT:${commitDetails.hash}`));
                                    };
                                    return (
                                      <div
                                        key={fi}
                                        className="scm-commit-details-file"
                                        onClick={openInEditor}
                                        style={{ cursor: typeof onOpenFile === 'function' ? 'pointer' : 'default' }}
                                        title={typeof onOpenFile === 'function'
                                          ? `Open diff in editor — ${f.path}`
                                          : f.path}
                                      >
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

      {/* ── Commit-graph context menu ─────────────────────────────────────
          Right-click on any commit row opens this anchored at the cursor.
          Covers cherry-pick (the most common request) plus the three reset
          flavours and a "Copy hash" convenience. */}
      {graphContextMenu && (
        <>
          <div
            className="scm-graph-context-overlay"
            onClick={() => setGraphContextMenu(null)}
            onContextMenu={(e) => { e.preventDefault(); setGraphContextMenu(null); }}
            style={{ position: 'fixed', inset: 0, zIndex: 999 }}
          />
          <div
            className="scm-graph-context-menu"
            style={{
              position: 'fixed',
              top: graphContextMenu.y,
              left: graphContextMenu.x,
              zIndex: 1000,
              background: 'var(--bg-elevated, #252526)',
              border: '1px solid var(--border, #2b2b2b)',
              borderRadius: 4,
              padding: 4,
              minWidth: 220,
              boxShadow: '0 6px 24px rgba(0,0,0,0.4)',
              fontSize: 12,
              color: 'var(--text-primary, #d4d4d4)',
            }}
          >
            <div
              className="scm-commit-dropdown-item"
              onClick={() => { const h = graphContextMenu.hash; setGraphContextMenu(null); handleCherryPick(h); }}
            >
              <VscArrowDown size={13} /> Cherry-pick this commit
            </div>
            <div className="scm-commit-dropdown-sep" />
            <div
              className="scm-commit-dropdown-item"
              onClick={() => { const h = graphContextMenu.hash; setGraphContextMenu(null); handleResetTo(h, 'soft'); }}
            >
              Reset to here (soft)
            </div>
            <div
              className="scm-commit-dropdown-item"
              onClick={() => { const h = graphContextMenu.hash; setGraphContextMenu(null); handleResetTo(h, 'mixed'); }}
            >
              Reset to here (mixed)
            </div>
            <div
              className="scm-commit-dropdown-item"
              onClick={() => { const h = graphContextMenu.hash; setGraphContextMenu(null); handleResetTo(h, 'hard'); }}
              style={{ color: '#f14c4c' }}
            >
              Reset to here (hard) — discards changes
            </div>
            <div className="scm-commit-dropdown-sep" />
            <div
              className="scm-commit-dropdown-item"
              onClick={() => {
                const h = graphContextMenu.hash;
                setGraphContextMenu(null);
                try { navigator.clipboard && navigator.clipboard.writeText(h); } catch (_) {}
              }}
            >
              Copy commit hash
            </div>
          </div>
        </>
      )}

      {/* ── Modals ──────────────────────────────────────────────────────────
          One modal is open at a time, gated by `activeModal`. Each modal is a
          small purpose-built component below. They all share the same overlay
          chrome via <ScmModal>. */}
      {activeModal === 'clone' && (
        <ScmModal title="Clone Repository" onClose={() => setActiveModal(null)}>
          <CloneForm onSubmit={handleClone} />
        </ScmModal>
      )}

      {activeModal === 'branches' && (
        <ScmModal title="Branches" onClose={() => setActiveModal(null)}>
          <BranchPicker
            current={branch}
            local={localBranches}
            remote={remoteBranches}
            onSwitch={handleSwitchBranch}
            onCheckoutRemote={handleCheckoutRemote}
            onDelete={(name) => handleDeleteBranch(name, false)}
            onRename={handleRenameBranch}
            onCreate={() => setActiveModal('newBranch')}
            onRefresh={refreshBranches}
          />
        </ScmModal>
      )}

      {activeModal === 'newBranch' && (
        <ScmModal title="Create New Branch" onClose={() => setActiveModal(null)}>
          <SingleInputForm
            label="Branch name"
            submitLabel="Create &amp; Switch"
            placeholder="feature/awesome-thing"
            onSubmit={handleCreateBranch}
            onCancel={() => setActiveModal(null)}
          />
        </ScmModal>
      )}

      {activeModal === 'merge' && (
        <ScmModal title={`Merge into ${branch || 'current branch'}`} onClose={() => setActiveModal(null)}>
          <BranchSelectionForm
            local={localBranches.filter((b) => !b.isCurrent)}
            remote={remoteBranches}
            submitLabel="Merge"
            extra={(selected, setExtra, extra) => (
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, marginTop: 6 }}>
                <input type="checkbox" checked={!!extra.noFF} onChange={(e) => setExtra({ noFF: e.target.checked })} />
                Always create a merge commit (--no-ff)
              </label>
            )}
            onSubmit={(name, extra) => handleMerge(name, !!extra?.noFF)}
            onCancel={() => setActiveModal(null)}
          />
        </ScmModal>
      )}

      {activeModal === 'rebase' && (
        <ScmModal title={`Rebase ${branch || 'current branch'} onto…`} onClose={() => setActiveModal(null)}>
          <BranchSelectionForm
            local={localBranches.filter((b) => !b.isCurrent)}
            remote={remoteBranches}
            submitLabel="Rebase"
            onSubmit={(name) => handleRebase(name)}
            onCancel={() => setActiveModal(null)}
          />
        </ScmModal>
      )}

      {activeModal === 'remotes' && (
        <ScmModal title="Remotes" onClose={() => setActiveModal(null)}>
          <RemoteManager
            remotes={remotes}
            onAdd={handleAddRemote}
            onRemove={handleRemoveRemote}
            onRename={handleRenameRemote}
            onSetUrl={handleSetRemoteUrl}
            onRefresh={refreshRemotes}
          />
        </ScmModal>
      )}

      {activeModal === 'tags' && (
        <ScmModal title="Tags" onClose={() => setActiveModal(null)}>
          <TagManager
            tags={tags}
            onCreate={handleCreateTag}
            onDelete={handleDeleteTag}
            onPush={handlePushTag}
            onPushAll={handlePushAllTags}
            onRefresh={refreshTags}
          />
        </ScmModal>
      )}
    </div>
  );
}

// ─── Modal primitives ─────────────────────────────────────────────────────────
//
// A small, dependency-free modal kit kept colocated with the panel because
// nothing else needs it. The overlay traps clicks and Esc closes. We
// intentionally do NOT use a portal so the modal inherits the panel's CSS
// variables (theme tokens) without extra wiring.

const MODAL_OVERLAY_STYLE = {
  position: 'fixed', inset: 0, zIndex: 1100,
  background: 'rgba(0,0,0,0.45)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
};
const MODAL_BODY_STYLE = {
  background: 'var(--bg-elevated, #252526)',
  color: 'var(--text-primary, #d4d4d4)',
  border: '1px solid var(--border, #2b2b2b)',
  borderRadius: 6,
  width: 420,
  maxWidth: 'calc(100vw - 32px)',
  maxHeight: 'calc(100vh - 60px)',
  display: 'flex',
  flexDirection: 'column',
  boxShadow: '0 16px 48px rgba(0,0,0,0.5)',
  fontSize: 12,
};
const MODAL_HEADER_STYLE = {
  display: 'flex', alignItems: 'center', gap: 8,
  padding: '10px 12px', borderBottom: '1px solid var(--border, #2b2b2b)',
};
const MODAL_CONTENT_STYLE = { padding: 12, overflowY: 'auto', minHeight: 0 };

function ScmModal({ title, children, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div style={MODAL_OVERLAY_STYLE} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={MODAL_BODY_STYLE} onMouseDown={(e) => e.stopPropagation()}>
        <div style={MODAL_HEADER_STYLE}>
          <strong style={{ flex: 1 }}>{title}</strong>
          <button className="scm-icon-btn" onClick={onClose} title="Close"><VscClose size={14} /></button>
        </div>
        <div style={MODAL_CONTENT_STYLE}>{children}</div>
      </div>
    </div>
  );
}

// Simple single-input form (used for "New branch") — also serves as a
// pattern reference for any future single-field flow.
function SingleInputForm({ label, placeholder, submitLabel, onSubmit, onCancel, autoFocus = true }) {
  const [v, setV] = useState('');
  const ref = useRef(null);
  useEffect(() => { if (autoFocus) ref.current?.focus(); }, [autoFocus]);
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit((v || '').trim()); }}>
      <label style={{ display: 'block', marginBottom: 6, opacity: 0.85 }}>{label}</label>
      <input
        ref={ref}
        value={v}
        onChange={(e) => setV(e.target.value)}
        placeholder={placeholder}
        style={{
          width: '100%', padding: '6px 8px', border: '1px solid var(--border, #3b3b3b)',
          background: 'var(--bg-input, #1e1e1e)', color: 'inherit', borderRadius: 4, fontSize: 12,
        }}
      />
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
        <button type="button" className="scm-btn" onClick={onCancel}>Cancel</button>
        <button type="submit" className="scm-btn primary" disabled={!v.trim()}>{submitLabel}</button>
      </div>
    </form>
  );
}

// Clone form — URL, target dir, optional branch / depth. Uses the platform's
// native file picker via electronAPI when available; otherwise falls back to a
// plain text input.
function CloneForm({ onSubmit }) {
  const [url, setUrl]         = useState('');
  const [targetDir, setTD]    = useState('');
  const [branch, setBranch]   = useState('');
  const [depth, setDepth]     = useState('');
  const [busy, setBusy]       = useState(false);

  // Derive a sane default folder name from the URL so the user usually only
  // needs to pick the parent directory once.
  useEffect(() => {
    if (!targetDir && url) {
      const slug = url.replace(/[/\\]+$/, '').split(/[/\\]/).pop().replace(/\.git$/i, '');
      if (slug) {
        try {
          // Use electronAPI to suggest under the user's home if available; fall back to slug.
          setTD(slug);
        } catch (_) {}
      }
    }
  }, [url, targetDir]);

  const pickFolder = async () => {
    try {
      const folder = await window.electronAPI?.openFolderDialog?.();
      if (folder) {
        // If the user already typed a slug, append it to keep the cloned repo
        // in its own subdir; otherwise just use the picked folder verbatim.
        const slug = url.replace(/[/\\]+$/, '').split(/[/\\]/).pop().replace(/\.git$/i, '');
        const sep  = folder.includes('\\') ? '\\' : '/';
        setTD(slug ? `${folder}${sep}${slug}` : folder);
      }
    } catch (_) {}
  };

  return (
    <form onSubmit={async (e) => {
      e.preventDefault();
      if (!url.trim() || !targetDir.trim()) return;
      setBusy(true);
      const target = await onSubmit({
        url: url.trim(),
        targetDir: targetDir.trim(),
        branch: branch.trim() || undefined,
        depth: depth.trim() || undefined,
      });
      setBusy(false);
      // If clone succeeded, open the cloned folder. App.js subscribes to
      // electronAPI.openFolderInNewWindow which routes through the existing
      // workspace-switch path (handles the backend re-rooting cleanly).
      if (target) {
        try { await window.electronAPI?.openFolderInNewWindow?.(target); }
        catch (_) {}
      }
    }}>
      <label style={{ display: 'block', marginBottom: 4, opacity: 0.85 }}>Repository URL</label>
      <input
        autoFocus
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="https://github.com/user/repo.git or git@github.com:user/repo.git"
        style={{
          width: '100%', padding: '6px 8px', border: '1px solid var(--border, #3b3b3b)',
          background: 'var(--bg-input, #1e1e1e)', color: 'inherit', borderRadius: 4, fontSize: 12,
        }}
      />

      <label style={{ display: 'block', margin: '10px 0 4px', opacity: 0.85 }}>Clone into</label>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          value={targetDir}
          onChange={(e) => setTD(e.target.value)}
          placeholder="/Users/you/code/repo"
          style={{
            flex: 1, padding: '6px 8px', border: '1px solid var(--border, #3b3b3b)',
            background: 'var(--bg-input, #1e1e1e)', color: 'inherit', borderRadius: 4, fontSize: 12,
          }}
        />
        <button type="button" className="scm-btn" onClick={pickFolder}>Browse…</button>
      </div>

      <label style={{ display: 'block', margin: '10px 0 4px', opacity: 0.85 }}>Branch (optional)</label>
      <input
        value={branch}
        onChange={(e) => setBranch(e.target.value)}
        placeholder="main"
        style={{
          width: '100%', padding: '6px 8px', border: '1px solid var(--border, #3b3b3b)',
          background: 'var(--bg-input, #1e1e1e)', color: 'inherit', borderRadius: 4, fontSize: 12,
        }}
      />

      <label style={{ display: 'block', margin: '10px 0 4px', opacity: 0.85 }}>Shallow depth (optional)</label>
      <input
        value={depth}
        onChange={(e) => setDepth(e.target.value)}
        placeholder="e.g. 1 for the latest commit only"
        type="number"
        min={1}
        style={{
          width: '100%', padding: '6px 8px', border: '1px solid var(--border, #3b3b3b)',
          background: 'var(--bg-input, #1e1e1e)', color: 'inherit', borderRadius: 4, fontSize: 12,
        }}
      />

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
        <button type="submit" className="scm-btn primary" disabled={busy || !url.trim() || !targetDir.trim()}>
          {busy ? 'Cloning…' : 'Clone'}
        </button>
      </div>
    </form>
  );
}

// Branch picker — VS Code-style: search field, list of local branches with
// the current marked, then a divider, then remote branches. Hover reveals
// delete/rename per row. "Create new branch" sits at the top.
function BranchPicker({ current, local, remote, onSwitch, onCheckoutRemote, onDelete, onRename, onCreate, onRefresh }) {
  const [q, setQ] = useState('');
  const filterText = q.trim().toLowerCase();
  const matchedLocal  = local.filter((b)  => !filterText || b.name.toLowerCase().includes(filterText));
  const matchedRemote = remote.filter((b) => !filterText || b.name.toLowerCase().includes(filterText));

  return (
    <div>
      <input
        autoFocus
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search branches…"
        style={{
          width: '100%', padding: '6px 8px', border: '1px solid var(--border, #3b3b3b)',
          background: 'var(--bg-input, #1e1e1e)', color: 'inherit', borderRadius: 4, fontSize: 12,
          marginBottom: 8,
        }}
      />
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
        <button className="scm-btn" onClick={onCreate}><VscAdd size={11} style={{ marginRight: 4 }} />Create new branch</button>
        <button className="scm-icon-btn" onClick={onRefresh} title="Refresh"><VscRefresh size={13} /></button>
      </div>

      <BranchListSection
        label={`Local (${matchedLocal.length})`}
        items={matchedLocal}
        renderItem={(b) => (
          <BranchRow
            key={`local-${b.name}`}
            label={b.name}
            sublabel={b.upstream ? `↑${b.ahead} ↓${b.behind} · ${b.upstream}${b.gone ? ' (gone)' : ''}` : 'no upstream'}
            isCurrent={b.isCurrent}
            onClick={() => !b.isCurrent && onSwitch(b.name)}
            rightActions={!b.isCurrent && (
              <>
                <button className="scm-file-action" title="Rename" onClick={(e) => { e.stopPropagation(); onRename(b.name); }}>
                  <VscEdit size={12} />
                </button>
                <button className="scm-file-action" title="Delete" onClick={(e) => { e.stopPropagation(); onDelete(b.name); }}>
                  <VscTrash size={12} />
                </button>
              </>
            )}
          />
        )}
      />

      <BranchListSection
        label={`Remote (${matchedRemote.length})`}
        items={matchedRemote}
        renderItem={(b) => (
          <BranchRow
            key={`remote-${b.name}`}
            label={b.name}
            sublabel="Checkout creates a local tracking branch"
            onClick={() => onCheckoutRemote(b.name)}
          />
        )}
      />
    </div>
  );
}

function BranchListSection({ label, items, renderItem }) {
  if (!items.length) return null;
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ opacity: 0.6, fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.3, marginBottom: 4 }}>{label}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        {items.map(renderItem)}
      </div>
    </div>
  );
}

function BranchRow({ label, sublabel, isCurrent, onClick, rightActions }) {
  const [hover, setHover] = useState(false);
  return (
    <div
      className="scm-file-row"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={onClick}
      style={{ cursor: isCurrent ? 'default' : 'pointer', padding: '4px 6px' }}
    >
      <VscGitMerge size={12} style={{ color: isCurrent ? '#73c991' : 'inherit', flexShrink: 0 }} />
      <span className="scm-file-name" style={{ fontWeight: isCurrent ? 600 : 400 }}>
        {label}{isCurrent && <span style={{ opacity: 0.6, marginLeft: 6 }}>(current)</span>}
      </span>
      <span className="scm-file-dir">{sublabel}</span>
      {hover && rightActions && (
        <div className="scm-file-row-right" style={{ display: 'flex', gap: 2 }}>
          {rightActions}
        </div>
      )}
    </div>
  );
}

// Branch selection list used by merge / rebase modals — same UI as the picker
// minus the create/delete affordances, plus an optional <extra> render slot
// for things like a "--no-ff" checkbox.
function BranchSelectionForm({ local, remote, submitLabel, extra, onSubmit, onCancel }) {
  const [selected, setSelected] = useState('');
  const [extraState, setExtraState] = useState({});
  const setExtra = (patch) => setExtraState((s) => ({ ...s, ...patch }));

  const all = [
    ...local.map((b) => ({ kind: 'local', name: b.name })),
    ...remote.map((b) => ({ kind: 'remote', name: b.name })),
  ];

  return (
    <form onSubmit={(e) => { e.preventDefault(); if (selected) onSubmit(selected, extraState); }}>
      <div style={{ maxHeight: 280, overflowY: 'auto', border: '1px solid var(--border, #3b3b3b)', borderRadius: 4 }}>
        {all.length === 0 && <div style={{ padding: 12, opacity: 0.6 }}>No other branches available.</div>}
        {all.map((b) => (
          <label
            key={`${b.kind}-${b.name}`}
            style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '6px 10px', cursor: 'pointer',
              background: selected === b.name ? 'var(--bg-row-hover, rgba(255,255,255,0.05))' : 'transparent',
            }}
          >
            <input
              type="radio"
              name="branch-select"
              value={b.name}
              checked={selected === b.name}
              onChange={() => setSelected(b.name)}
            />
            <VscGitMerge size={12} style={{ opacity: 0.7 }} />
            <span>{b.name}</span>
            <span style={{ marginLeft: 'auto', opacity: 0.5, fontSize: 10 }}>{b.kind}</span>
          </label>
        ))}
      </div>

      {typeof extra === 'function' && extra(selected, setExtra, extraState)}

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
        <button type="button" className="scm-btn" onClick={onCancel}>Cancel</button>
        <button type="submit" className="scm-btn primary" disabled={!selected}>{submitLabel}</button>
      </div>
    </form>
  );
}

// Remote manager — list + add form. Edit / delete are inline per row.
function RemoteManager({ remotes, onAdd, onRemove, onRename, onSetUrl, onRefresh }) {
  const [newName, setNewName] = useState('');
  const [newUrl, setNewUrl]   = useState('');

  return (
    <div>
      <div style={{ marginBottom: 12 }}>
        {remotes.length === 0 ? (
          <div style={{ padding: 12, opacity: 0.6, textAlign: 'center' }}>No remotes configured.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            {remotes.map((r) => (
              <RemoteRow
                key={r.name}
                remote={r}
                onRemove={() => onRemove(r.name)}
                onRename={() => onRename(r.name)}
                onSetUrl={() => onSetUrl(r.name, r.push || r.fetch)}
              />
            ))}
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 6 }}>
          <button className="scm-icon-btn" onClick={onRefresh} title="Refresh"><VscRefresh size={13} /></button>
        </div>
      </div>

      <div style={{ borderTop: '1px solid var(--border, #2b2b2b)', paddingTop: 12 }}>
        <div style={{ opacity: 0.85, marginBottom: 6 }}>Add a remote</div>
        <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: 6 }}>
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="name (e.g. origin)"
            style={{ padding: '6px 8px', border: '1px solid var(--border, #3b3b3b)',
              background: 'var(--bg-input, #1e1e1e)', color: 'inherit', borderRadius: 4, fontSize: 12 }}
          />
          <input
            value={newUrl}
            onChange={(e) => setNewUrl(e.target.value)}
            placeholder="URL"
            style={{ padding: '6px 8px', border: '1px solid var(--border, #3b3b3b)',
              background: 'var(--bg-input, #1e1e1e)', color: 'inherit', borderRadius: 4, fontSize: 12 }}
          />
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
          <button
            className="scm-btn primary"
            disabled={!newName.trim() || !newUrl.trim()}
            onClick={() => { onAdd(newName, newUrl); setNewName(''); setNewUrl(''); }}
          >
            Add Remote
          </button>
        </div>
      </div>
    </div>
  );
}

function RemoteRow({ remote, onRemove, onRename, onSetUrl }) {
  const [hover, setHover] = useState(false);
  return (
    <div
      className="scm-file-row"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ padding: '6px 10px' }}
    >
      <VscCloud size={12} style={{ flexShrink: 0, opacity: 0.8 }} />
      <span className="scm-file-name">{remote.name}</span>
      <span className="scm-file-dir" title={remote.fetch || remote.push}>{remote.fetch || remote.push}</span>
      {hover && (
        <div className="scm-file-row-right" style={{ display: 'flex', gap: 2 }}>
          <button className="scm-file-action" title="Edit URL" onClick={onSetUrl}><VscEdit size={12} /></button>
          <button className="scm-file-action" title="Rename" onClick={onRename}>R</button>
          <button className="scm-file-action" title="Remove" onClick={onRemove}><VscTrash size={12} /></button>
        </div>
      )}
    </div>
  );
}

// Tag manager — list + create form (name + optional message → annotated).
function TagManager({ tags, onCreate, onDelete, onPush, onPushAll, onRefresh }) {
  const [name, setName]       = useState('');
  const [message, setMessage] = useState('');

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <strong style={{ opacity: 0.85 }}>{tags.length} tag{tags.length === 1 ? '' : 's'}</strong>
        <div style={{ display: 'flex', gap: 4 }}>
          <button className="scm-btn" onClick={onPushAll} title="Push all tags to origin">Push all</button>
          <button className="scm-icon-btn" onClick={onRefresh} title="Refresh"><VscRefresh size={13} /></button>
        </div>
      </div>

      <div style={{ maxHeight: 240, overflowY: 'auto', border: '1px solid var(--border, #3b3b3b)', borderRadius: 4 }}>
        {tags.length === 0 ? (
          <div style={{ padding: 12, opacity: 0.6, textAlign: 'center' }}>No tags yet.</div>
        ) : (
          tags.map((t) => (
            <TagRow
              key={t.name}
              tag={t}
              onDelete={() => onDelete(t.name)}
              onPush={() => onPush(t.name)}
            />
          ))
        )}
      </div>

      <div style={{ borderTop: '1px solid var(--border, #2b2b2b)', paddingTop: 12, marginTop: 12 }}>
        <div style={{ opacity: 0.85, marginBottom: 6 }}>Create a tag at HEAD</div>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="v1.0.0"
          style={{ width: '100%', padding: '6px 8px', border: '1px solid var(--border, #3b3b3b)',
            background: 'var(--bg-input, #1e1e1e)', color: 'inherit', borderRadius: 4, fontSize: 12 }}
        />
        <input
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Optional annotation message"
          style={{ width: '100%', padding: '6px 8px', border: '1px solid var(--border, #3b3b3b)',
            background: 'var(--bg-input, #1e1e1e)', color: 'inherit', borderRadius: 4, fontSize: 12,
            marginTop: 6 }}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
          <button
            className="scm-btn primary"
            disabled={!name.trim()}
            onClick={() => { onCreate(name, message); setName(''); setMessage(''); }}
          >
            Create tag
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Commit hash chip ────────────────────────────────────────────────────────
// Click-to-copy with transient "Copied!" feedback. Used in both the graph row
// (compact `<span>` form) and the commit-details header (monospace `<code>`
// form). Keyboard-accessible via the `<button>` semantics underneath.
function CommitHashChip({ fullHash, copied, onCopy, asCode }) {
  const short = (fullHash || '').slice(0, 7);
  const monoStyle = { fontFamily: 'var(--font-mono, monospace)' };
  return (
    <button
      type="button"
      onClick={onCopy}
      title={copied ? 'Copied!' : `Copy commit hash · ${fullHash || ''}`}
      className={asCode ? 'scm-commit-details-hash' : 'scm-graph-hash'}
      style={{
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 3,
        background: 'transparent',
        border: 'none',
        padding: 0,
        font: 'inherit',
        color: 'inherit',
      }}
    >
      {asCode
        ? <code style={monoStyle}>{short}</code>
        : <span style={monoStyle}>{short}</span>}
      {copied
        ? <VscCheck size={11} style={{ color: '#73c991' }} />
        : <VscCopy  size={11} style={{ opacity: 0.55 }} />}
    </button>
  );
}


function TagRow({ tag, onDelete, onPush }) {
  const [hover, setHover] = useState(false);
  return (
    <div
      className="scm-file-row"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ padding: '5px 10px' }}
    >
      <VscTag size={12} style={{ flexShrink: 0, opacity: 0.8 }} />
      <span className="scm-file-name">{tag.name}</span>
      <span className="scm-file-dir" title={tag.subject}>
        {tag.annotated ? '🏷' : ''} {tag.subject || tag.sha}
      </span>
      {hover && (
        <div className="scm-file-row-right" style={{ display: 'flex', gap: 2 }}>
          <button className="scm-file-action" title="Push to origin" onClick={onPush}><VscArrowUp size={12} /></button>
          <button className="scm-file-action" title="Delete tag" onClick={onDelete}><VscTrash size={12} /></button>
        </div>
      )}
    </div>
  );
}

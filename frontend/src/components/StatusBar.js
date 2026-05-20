import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  VscSourceControl,
  VscError,
  VscWarning,
  VscBell,
  VscCheck,
  VscTrash,
  VscGitMerge,
  VscRepoForked,
} from 'react-icons/vsc';
import { runGit } from '../lib/gitService';

function getLanguageFromFile(filename) {
  if (!filename) return '';
  const ext = filename.split('.').pop().toLowerCase();
  const map = {
    js: 'JavaScript',
    jsx: 'JavaScript React',
    ts: 'TypeScript',
    tsx: 'TypeScript React',
    py: 'Python',
    json: 'JSON',
    html: 'HTML',
    css: 'CSS',
    scss: 'SCSS',
    md: 'Markdown',
    yaml: 'YAML',
    yml: 'YAML',
    xml: 'XML',
    java: 'Java',
    sh: 'Shell Script',
    txt: 'Plain Text',
    sql: 'SQL',
    go: 'Go',
    rs: 'Rust',
    rb: 'Ruby',
    php: 'PHP',
    swift: 'Swift',
    kt: 'Kotlin',
    c: 'C',
    cpp: 'C++',
    h: 'C Header',
  };
  return map[ext] || ext.toUpperCase();
}

function BranchPicker({ currentBranch, onClose, onSwitch }) {
  const [branches, setBranches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [switching, setSwitching] = useState(null);
  const inputRef = useRef(null);
  const pickerRef = useRef(null);

  useEffect(() => {
    const fetchBranches = async () => {
      try {
        // runGit goes through waitForBackendReady + retry — safe to call on mount.
        const res = await runGit(['branch', '-a', '--no-color']);
        const output = (res.output || '').trim();
        if (res.exit_code === 0 && output) {
          const parsed = output.split('\n').map(line => {
            const isCurrent = line.startsWith('*');
            const name = line.replace(/^\*?\s+/, '').trim();
            // Clean up remote tracking refs
            const isRemote = name.startsWith('remotes/');
            const displayName = isRemote ? name.replace('remotes/', '') : name;
            return { name, displayName, isCurrent, isRemote };
          }).filter(b => b.name && !b.name.includes('HEAD'));
          setBranches(parsed);
        }
      } catch (_) { setBranches([]); }
      setLoading(false);
    };
    fetchBranches();
    setTimeout(() => inputRef.current?.focus(), 100);
  }, []);

  // Close on outside click
  useEffect(() => {
    const handler = (e) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  // Close on Escape
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const filtered = branches.filter(b =>
    b.displayName.toLowerCase().includes(filter.toLowerCase())
  );

  const handleSwitch = async (branchName) => {
    // Extract just the local branch name for checkout
    let checkoutName = branchName;
    if (branchName.startsWith('remotes/')) {
      checkoutName = branchName.replace(/^remotes\/[^/]+\//, '');
    }
    setSwitching(checkoutName);
    try {
      const res = await runGit(['checkout', checkoutName]);
      if (res.exit_code === 0) {
        if (onSwitch) onSwitch(checkoutName);
        onClose();
      } else {
        // Try creating the branch locally if it only exists on the remote.
        const res2 = await runGit(['checkout', '-b', checkoutName]);
        if (res2.exit_code === 0) {
          if (onSwitch) onSwitch(checkoutName);
          onClose();
        }
      }
    } catch (_) {}
    setSwitching(null);
  };

  const handleCreateBranch = async () => {
    if (!filter) return;
    setSwitching(filter);
    try {
      // Pass filter as an argument element — never interpolated into a shell string.
      const res = await runGit(['checkout', '-b', filter]);
      if (res.exit_code === 0) {
        if (onSwitch) onSwitch(filter);
        onClose();
      }
    } catch (_) {}
    setSwitching(null);
  };

  const handleDeleteBranch = async (e, branchName) => {
    e.stopPropagation();
    if (!window.confirm(`Are you sure you want to delete branch '${branchName}'?`)) return;
    try {
      await runGit(['branch', '-D', branchName]);
      // Refresh list
      const res = await runGit(['branch', '-a', '--no-color']);
      const output = (res.output || '').trim();
      if (res.exit_code === 0 && output) {
        const parsed = output.split('\n').map(line => {
          const isCurrent = line.startsWith('*');
          const name = line.replace(/^\*?\s+/, '').trim();
          const isRemote = name.startsWith('remotes/');
          const displayName = isRemote ? name.replace('remotes/', '') : name;
          return { name, displayName, isCurrent, isRemote };
        }).filter(b => b.name && !b.name.includes('HEAD'));
        setBranches(parsed);
      }
    } catch (_) {}
  };

  const handleMergeBranch = async (e, branchName) => {
    e.stopPropagation();
    const src = branchName.replace(/^remotes\//, '');
    if (!window.confirm(`Merge '${src}' into the current branch?`)) return;
    const r = await runGit(['merge', src], { timeout: 90000 });
    if (!r.ok) {
      window.alert(`Merge failed:\n${(r.output || '').slice(0, 600)}`);
    }
    try { window.dispatchEvent(new CustomEvent('nebula:git-refresh-request')); } catch (_) {}
  };

  const handleRebaseOnto = async (e, branchName) => {
    e.stopPropagation();
    const onto = branchName.replace(/^remotes\//, '');
    if (!window.confirm(`Rebase the current branch onto '${onto}'?`)) return;
    const r = await runGit(['rebase', onto], { timeout: 90000 });
    if (!r.ok) {
      window.alert(`Rebase failed (you may be mid-rebase — use 'git rebase --continue/--abort'):\n${(r.output || '').slice(0, 600)}`);
    }
    try { window.dispatchEvent(new CustomEvent('nebula:git-refresh-request')); } catch (_) {}
  };

  return (
    <div className="branch-picker" ref={pickerRef}>
      <div className="branch-picker-header">
        <input
          ref={inputRef}
          className="branch-picker-input"
          placeholder="Switch branch..."
          value={filter}
          onChange={e => setFilter(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && filtered.length > 0) {
              handleSwitch(filtered[0].name);
            }
          }}
        />
      </div>
      <div className="branch-picker-list">
        {loading ? (
          <div className="branch-picker-empty">Loading branches...</div>
        ) : filtered.length === 0 ? (
          <div className="branch-picker-empty">
            {filter ? (
              <button className="branch-picker-create" onClick={handleCreateBranch}>
                <span>Create branch <strong>{filter}</strong>...</span>
              </button>
            ) : 'No branches found'}
          </div>
        ) : (
          filtered.map(b => {
            // The row hosts secondary action buttons (merge/rebase/delete) on
            // the right. Real <button> elements cannot be nested inside a
            // <button>, so the row itself is a div with role="button" plus
            // keyboard handlers — keeps accessibility intact without
            // triggering React's validateDOMNesting warning.
            const isDisabled = !!switching;
            const canSwitch  = !b.isCurrent && !isDisabled;
            const onRowActivate = () => { if (canSwitch) handleSwitch(b.name); };
            return (
              <div
                key={b.name}
                className={`branch-picker-item ${b.isCurrent ? 'current' : ''} ${isDisabled ? 'is-disabled' : ''}`}
                role="button"
                tabIndex={canSwitch ? 0 : -1}
                aria-disabled={isDisabled || b.isCurrent}
                onClick={onRowActivate}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onRowActivate();
                  }
                }}
              >
                <span className="branch-picker-item-name">
                  {b.isRemote && <span className="branch-picker-remote-tag">remote</span>}
                  {b.displayName}
                </span>
                {b.isCurrent && <VscCheck size={14} className="branch-picker-check" />}
                {!b.isCurrent && (
                  <>
                    <button
                      className="branch-picker-delete"
                      title={`Merge '${b.displayName}' into current branch`}
                      onClick={(e) => handleMergeBranch(e, b.name)}
                    >
                      <VscGitMerge size={14} />
                    </button>
                    <button
                      className="branch-picker-delete"
                      title={`Rebase current branch onto '${b.displayName}'`}
                      onClick={(e) => handleRebaseOnto(e, b.name)}
                    >
                      <VscRepoForked size={14} />
                    </button>
                    {!b.isRemote && (
                      <button className="branch-picker-delete" title="Delete Branch" onClick={(e) => handleDeleteBranch(e, b.name)}>
                        <VscTrash size={14} />
                      </button>
                    )}
                  </>
                )}
                {switching === b.displayName && <span className="branch-picker-switching">...</span>}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

export default function StatusBar({ activeFile, cursorPosition, encoding, hasWorkspace = true, updateState, updateError }) {
  const [branch, setBranch] = useState('');
  const [gitChanges, setGitChanges] = useState(0);
  const [showBranchPicker, setShowBranchPicker] = useState(false);
  const language = getLanguageFromFile(activeFile);

  const fetchGitInfo = useCallback(async () => {
    if (!hasWorkspace) {
      setBranch('');
      setGitChanges(0);
      return;
    }
    try {
      const branchRes = await runGit(['branch', '--show-current'], { timeout: 180000 });
      const branchName = (branchRes.output || '').trim();
      if (branchName && branchRes.exit_code === 0) {
        setBranch(branchName);
      } else {
        setBranch('');
      }

      // Do not use -uall here — it can enumerate huge untracked trees and stall for minutes.
      const statusRes = await runGit(['status', '--porcelain'], { timeout: 180000 });
      const lines = (statusRes.output || '').trim().split('\n').filter(Boolean);
      setGitChanges(statusRes.exit_code === 0 ? lines.length : 0);
    } catch {
      setBranch('');
      setGitChanges(0);
    }
  }, [hasWorkspace]);

  useEffect(() => {
    fetchGitInfo();
    const interval = setInterval(fetchGitInfo, 10000);
    return () => clearInterval(interval);
  }, [fetchGitInfo]);

  return (
    <div className="status-bar">
      <div className="status-bar-left">
        <div className="status-item remote" title="Nebula IDE">
          <span>✦</span>
          <span>Nebula</span>
        </div>
        {branch ? (
          <div
            className="status-item branch clickable"
            title={`Git Branch: ${branch} (click to switch)`}
            onClick={() => setShowBranchPicker(prev => !prev)}
          >
            <VscSourceControl size={12} />
            <span>{branch}</span>
            {gitChanges > 0 && (
              <span className="status-badge">{gitChanges}</span>
            )}
          </div>
        ) : !hasWorkspace ? (
          <div className="status-item branch" title="Open a folder for Git status">
            <VscSourceControl size={12} />
            <span>No folder</span>
          </div>
        ) : (
          <div className="status-item branch" title="No git repository">
            <VscSourceControl size={12} />
            <span>No repo</span>
          </div>
        )}
        <div className="status-item problems" title="Errors and Warnings">
          <VscError size={12} />
          <span>0</span>
          <VscWarning size={12} />
          <span>0</span>
        </div>
      </div>
      <div className="status-bar-right">
        {activeFile && (
          <>
            <div className="status-item" title="Cursor Position">
              <span>Ln {cursorPosition?.line || 1}, Col {cursorPosition?.column || 1}</span>
            </div>
            <div className="status-item" title="Indentation">
              <span>Spaces: 2</span>
            </div>
            <div className="status-item" title="Encoding">
              <span>{encoding || 'UTF-8'}</span>
            </div>
            <div className="status-item" title="End of Line">
              <span>LF</span>
            </div>
            <div className="status-item language" title="Language Mode">
              <span>{language}</span>
            </div>
          </>
        )}
        {updateState === 'error' && updateError && (
          <div className="status-item update-error" title={updateError}>
            <VscError size={12} />
            <span style={{ color: '#fca5a5', marginLeft: 4 }}>{updateError}</span>
          </div>
        )}
        <div className="status-item" title="Notifications">
          <VscBell size={12} />
        </div>
      </div>

      {/* Branch Picker */}
      {showBranchPicker && (
        <BranchPicker
          currentBranch={branch}
          onClose={() => setShowBranchPicker(false)}
          onSwitch={(newBranch) => {
            setBranch(newBranch);
            fetchGitInfo();
          }}
        />
      )}
    </div>
  );
}

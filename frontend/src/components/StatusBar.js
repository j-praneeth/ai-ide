import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  VscSourceControl,
  VscError,
  VscWarning,
  VscBell,
  VscCheck,
} from 'react-icons/vsc';
import axios from 'axios';

const API = 'http://127.0.0.1:8000';

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
        const res = await axios.post(`${API}/terminal/run`, null, {
          params: { command: 'git branch -a --no-color' }
        });
        const output = (res.data.output || '').trim();
        if (res.data.exit_code === 0 && output) {
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
      const res = await axios.post(`${API}/terminal/run`, null, {
        params: { command: `git checkout ${checkoutName}` }
      });
      if (res.data.exit_code === 0) {
        if (onSwitch) onSwitch(checkoutName);
        onClose();
      } else {
        // Try creating branch if it doesn't exist locally
        const res2 = await axios.post(`${API}/terminal/run`, null, {
          params: { command: `git checkout -b ${checkoutName}` }
        });
        if (res2.data.exit_code === 0) {
          if (onSwitch) onSwitch(checkoutName);
          onClose();
        }
      }
    } catch (_) {}
    setSwitching(null);
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
            {filter ? 'No matching branches' : 'No branches found'}
          </div>
        ) : (
          filtered.map(b => (
            <button
              key={b.name}
              className={`branch-picker-item ${b.isCurrent ? 'current' : ''}`}
              onClick={() => !b.isCurrent && handleSwitch(b.name)}
              disabled={!!switching}
            >
              <span className="branch-picker-item-name">
                {b.isRemote && <span className="branch-picker-remote-tag">remote</span>}
                {b.displayName}
              </span>
              {b.isCurrent && <VscCheck size={14} className="branch-picker-check" />}
              {switching === b.displayName && <span className="branch-picker-switching">...</span>}
            </button>
          ))
        )}
      </div>
    </div>
  );
}

export default function StatusBar({ activeFile, cursorPosition, encoding }) {
  const [branch, setBranch] = useState('');
  const [gitChanges, setGitChanges] = useState(0);
  const [showBranchPicker, setShowBranchPicker] = useState(false);
  const language = getLanguageFromFile(activeFile);

  const fetchGitInfo = useCallback(async () => {
    try {
      const branchRes = await axios.post(`${API}/terminal/run`, null, {
        params: { command: 'git branch --show-current' }
      });
      const branchName = (branchRes.data.output || '').trim();
      if (branchName && branchRes.data.exit_code === 0) {
        setBranch(branchName);
      } else {
        setBranch('');
      }

      const statusRes = await axios.post(`${API}/terminal/run`, null, {
        params: { command: 'git status --porcelain -uall' }
      });
      const lines = (statusRes.data.output || '').trim().split('\n').filter(Boolean);
      setGitChanges(statusRes.data.exit_code === 0 ? lines.length : 0);
    } catch {
      setBranch('');
      setGitChanges(0);
    }
  }, []);

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

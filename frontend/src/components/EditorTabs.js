import React from 'react';
import { VscClose, VscCircleFilled, VscGitCompare } from 'react-icons/vsc';
import { isDiffTabKey, parseDiffTabKey } from './DiffTab';

// Mirrors GIT_DECORATION in FileExplorer.js / STATUS_CONFIG in SourceControlPanel.js.
// Kept inline (rather than imported) so EditorTabs stays a self-contained leaf —
// changes to either of those files don't risk a hidden render-time regression here.
const GIT_BADGE = {
  M: { color: '#e5a000', title: 'Modified'  },
  A: { color: '#73c991', title: 'Added'     },
  D: { color: '#f14c4c', title: 'Deleted'   },
  R: { color: '#f97316', title: 'Renamed'   },
  C: { color: '#60a5fa', title: 'Copied'    },
  U: { color: '#3dc9b0', title: 'Untracked' },
  '!': { color: '#f14c4c', title: 'Conflict' },
};

function getFileLanguageIcon(name) {
  const ext = name.split('.').pop().toLowerCase();
  const map = {
    js: { color: '#e8d44d', label: 'JS' },
    jsx: { color: '#61dafb', label: 'JSX' },
    ts: { color: '#3178c6', label: 'TS' },
    tsx: { color: '#3178c6', label: 'TSX' },
    py: { color: '#3776ab', label: 'PY' },
    json: { color: '#e8d44d', label: '{}' },
    html: { color: '#e34f26', label: '<>' },
    css: { color: '#1572b6', label: '#' },
    md: { color: '#519aba', label: 'M' },
    yaml: { color: '#cb171e', label: 'Y' },
    yml: { color: '#cb171e', label: 'Y' },
  };
  const icon = map[ext];
  if (icon) return <span className="tab-file-icon" style={{ color: icon.color }}>{icon.label}</span>;
  return <span className="tab-file-icon" style={{ color: '#6a6a6a' }}>F</span>;
}

// Returns { icon, label, title } for any tab entry — handles both file paths
// and synthetic diff-tab keys (see DiffTab.buildDiffTabKey).
function describeTab(file) {
  if (isDiffTabKey(file)) {
    const parsed = parseDiffTabKey(file);
    const name = parsed ? parsed.path.split(/[\\/]/).filter(Boolean).pop() : 'Diff';
    // The DiffTab now supports three comparison modes — derive the tab suffix
    // from `against` so the tab strip surfaces what the user is looking at.
    //   HEAD          → Working Tree
    //   STAGE         → Index
    //   COMMIT:<hash> → first 7 chars of the hash (matches git log conventions)
    let suffix = ' (Working Tree)';
    if (parsed) {
      if (parsed.against === 'STAGE')                  suffix = ' (Index)';
      else if (parsed.against === 'HEAD')              suffix = ' (Working Tree)';
      else if (parsed.against.startsWith('COMMIT:'))   suffix = ` (${parsed.against.slice(7, 14)})`;
      else                                             suffix = ` (${parsed.against})`;
    }
    return {
      icon: (
        <span className="tab-file-icon" style={{ color: '#e5a000', display: 'flex', alignItems: 'center' }}>
          <VscGitCompare size={14} />
        </span>
      ),
      label: `${name}${suffix}`,
      title: parsed ? `${parsed.path} — ${suffix.trim()}` : file,
    };
  }
  const fileName = file.split('/').pop();
  return {
    icon: getFileLanguageIcon(fileName),
    label: fileName,
    title: file,
  };
}

export default function EditorTabs({
  openFiles, activeFile, onSelectFile, onCloseFile, modifiedFiles,
  // Map of repo-relative path → git status code (M/A/D/R/C/U/!).
  // Optional — when omitted, tabs render exactly as before.
  gitDecorations,
}) {
  if (openFiles.length === 0) return null;

  return (
    <div className="editor-tabs">
      <div className="tabs-scroll">
        {openFiles.map(file => {
          const isActive = file === activeFile;
          const isDiff = isDiffTabKey(file);
          // Diff tabs are read-only — never flag them as modified.
          const isModified = !isDiff && modifiedFiles && modifiedFiles.has(file);
          const { icon, label, title } = describeTab(file);

          // Tab label colour follows git status (parity with file-tree
          // decorations). Diff tabs keep their default colour; the dedicated
          // diff icon already signals what they are.
          const gitCode = !isDiff && gitDecorations ? gitDecorations[file] : null;
          const badge = gitCode ? GIT_BADGE[gitCode] : null;
          const labelStyle = badge ? { color: badge.color } : undefined;

          return (
            <div
              key={file}
              className={`tab ${isActive ? 'active' : ''}${badge ? ` tab-git-${gitCode === '!' ? 'conflict' : 'changed'}` : ''}`}
              onClick={() => onSelectFile(file)}
              title={badge ? `${title}  ·  ${badge.title}` : title}
            >
              {icon}
              <span className="tab-name" style={labelStyle}>{label}</span>
              {badge && (
                <span
                  className="tab-git-badge"
                  style={{
                    marginLeft: 6,
                    fontSize: 10,
                    fontWeight: 700,
                    color: badge.color,
                    letterSpacing: '0.02em',
                  }}
                >
                  {gitCode === '!' ? '!' : gitCode}
                </span>
              )}
              {isModified && (
                <VscCircleFilled size={8} className="tab-modified-dot" />
              )}
              <button
                className="tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseFile(file);
                }}
                title={isModified ? 'Close (unsaved changes)' : 'Close'}
              >
                {/* Always show X — unsaved dot is shown separately in the tab label.
                    Clicking X on a modified file triggers the save-changes dialog. */}
                <VscClose size={14} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

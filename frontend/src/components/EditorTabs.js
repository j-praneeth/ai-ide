import React from 'react';
import { VscClose, VscCircleFilled } from 'react-icons/vsc';

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

export default function EditorTabs({ openFiles, activeFile, onSelectFile, onCloseFile, modifiedFiles }) {
  if (openFiles.length === 0) return null;

  return (
    <div className="editor-tabs">
      <div className="tabs-scroll">
        {openFiles.map(file => {
          const fileName = file.split('/').pop();
          const isActive = file === activeFile;
          const isModified = modifiedFiles && modifiedFiles.has(file);

          return (
            <div
              key={file}
              className={`tab ${isActive ? 'active' : ''}`}
              onClick={() => onSelectFile(file)}
              title={file}
            >
              {getFileLanguageIcon(fileName)}
              <span className="tab-name">{fileName}</span>
              {isModified && !isActive && (
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

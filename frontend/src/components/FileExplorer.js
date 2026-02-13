import React, { useState, useCallback, useRef } from 'react';
import axios from 'axios';
import {
  VscChevronRight,
  VscChevronDown,
  VscNewFile,
  VscNewFolder,
  VscRefresh,
  VscCollapseAll,
  VscFolderOpened,
} from 'react-icons/vsc';
import { API_URL as API } from '../config';

// File icon mapping by extension
const FILE_ICONS = {
  js: { color: '#e8d44d', label: 'JS' },
  jsx: { color: '#61dafb', label: 'JSX' },
  ts: { color: '#3178c6', label: 'TS' },
  tsx: { color: '#3178c6', label: 'TSX' },
  py: { color: '#3776ab', label: 'PY' },
  json: { color: '#e8d44d', label: '{}' },
  html: { color: '#e34f26', label: '<>' },
  css: { color: '#1572b6', label: '#' },
  scss: { color: '#cf649a', label: '#' },
  md: { color: '#519aba', label: 'M' },
  svg: { color: '#ffb13b', label: 'SVG' },
  png: { color: '#a074c4', label: 'IMG' },
  jpg: { color: '#a074c4', label: 'IMG' },
  gif: { color: '#a074c4', label: 'IMG' },
  yaml: { color: '#cb171e', label: 'YML' },
  yml: { color: '#cb171e', label: 'YML' },
  env: { color: '#ecd53f', label: 'ENV' },
  gitignore: { color: '#f05032', label: 'GIT' },
  lock: { color: '#6a6a6a', label: 'LCK' },
  txt: { color: '#6a6a6a', label: 'TXT' },
  sh: { color: '#89e051', label: 'SH' },
  java: { color: '#b07219', label: 'JV' },
  xml: { color: '#e34f26', label: 'XML' },
};

function getFileIcon(name) {
  const ext = name.split('.').pop().toLowerCase();
  const icon = FILE_ICONS[ext];
  if (icon) {
    return (
      <span className="file-icon" style={{ color: icon.color }}>
        {icon.label}
      </span>
    );
  }
  return <span className="file-icon" style={{ color: '#6a6a6a' }}>F</span>;
}

function TreeNode({ node, basePath, depth, openFile, selectedFile, expandedFolders, toggleFolder }) {
  const fullPath = basePath ? `${basePath}/${node.name}` : node.name;
  const isExpanded = expandedFolders.has(fullPath);
  const isSelected = selectedFile === fullPath;

  if (node.type === 'folder') {
    return (
      <div className="tree-node">
        <div
          className={`tree-item tree-folder ${isSelected ? 'selected' : ''}`}
          style={{ paddingLeft: depth * 16 + 8 }}
          onClick={() => toggleFolder(fullPath)}
        >
          <span className="tree-chevron">
            {isExpanded ? <VscChevronDown size={16} /> : <VscChevronRight size={16} />}
          </span>
          <span className="folder-icon">{isExpanded ? '📂' : '📁'}</span>
          <span className="tree-label">{node.name}</span>
        </div>
        {isExpanded && node.children && (
          <div className="tree-children">
            {node.children
              .sort((a, b) => {
                if (a.type === b.type) return a.name.localeCompare(b.name);
                return a.type === 'folder' ? -1 : 1;
              })
              .map(child => (
                <TreeNode
                  key={child.name}
                  node={child}
                  basePath={fullPath}
                  depth={depth + 1}
                  openFile={openFile}
                  selectedFile={selectedFile}
                  expandedFolders={expandedFolders}
                  toggleFolder={toggleFolder}
                />
              ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className={`tree-item tree-file ${isSelected ? 'selected' : ''}`}
      style={{ paddingLeft: depth * 16 + 8 }}
      onClick={() => openFile(fullPath)}
    >
      <span className="tree-chevron" style={{ visibility: 'hidden' }}>
        <VscChevronRight size={16} />
      </span>
      {getFileIcon(node.name)}
      <span className="tree-label">{node.name}</span>
    </div>
  );
}

export default function FileExplorer({ tree, openFile, selectedFile, onRefresh, triggerNewFile, onNewFileDone, onOpenFolder }) {
  const [expandedFolders, setExpandedFolders] = useState(new Set());
  const [showNewFileInput, setShowNewFileInput] = useState(false);
  const [showNewFolderInput, setShowNewFolderInput] = useState(false);
  const [newItemName, setNewItemName] = useState('');
  const newItemInputRef = useRef(null);

  // Respond to external trigger for new file
  React.useEffect(() => {
    if (triggerNewFile) {
      setShowNewFolderInput(false);
      setShowNewFileInput(true);
      setNewItemName('');
      setTimeout(() => newItemInputRef.current?.focus(), 0);
      onNewFileDone?.();
    }
  }, [triggerNewFile, onNewFileDone]);

  const startNewFile = useCallback(() => {
    setShowNewFolderInput(false);
    setShowNewFileInput(true);
    setNewItemName('');
    setTimeout(() => newItemInputRef.current?.focus(), 0);
  }, []);

  const startNewFolder = useCallback(() => {
    setShowNewFileInput(false);
    setShowNewFolderInput(true);
    setNewItemName('');
    setTimeout(() => newItemInputRef.current?.focus(), 0);
  }, []);

  const cancelNewItem = useCallback(() => {
    setShowNewFileInput(false);
    setShowNewFolderInput(false);
    setNewItemName('');
  }, []);

  const submitNewItem = useCallback(async () => {
    const name = newItemName.trim();
    if (!name) {
      cancelNewItem();
      return;
    }
    const isFolder = showNewFolderInput;
    try {
      await axios.post(`${API}/files/create`, null, {
        params: { path: name, is_folder: isFolder },
      });
      cancelNewItem();
      onRefresh?.();
      if (!isFolder) openFile?.(name);
    } catch (err) {
      console.error('Failed to create:', err);
    }
  }, [newItemName, showNewFolderInput, cancelNewItem, onRefresh, openFile]);

  const handleNewItemKeyDown = useCallback((e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitNewItem();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelNewItem();
    }
  }, [submitNewItem, cancelNewItem]);

  const toggleFolder = useCallback((path) => {
    setExpandedFolders(prev => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const collapseAll = useCallback(() => {
    setExpandedFolders(new Set());
  }, []);

  return (
    <div className="file-explorer">
      <div className="sidebar-header">
        <span className="sidebar-title">EXPLORER</span>
        <div className="sidebar-actions">
          <button className="icon-btn" title="New File" onClick={startNewFile}>
            <VscNewFile size={16} />
          </button>
          <button className="icon-btn" title="New Folder" onClick={startNewFolder}>
            <VscNewFolder size={16} />
          </button>
          <button className="icon-btn" title="Refresh" onClick={onRefresh}>
            <VscRefresh size={16} />
          </button>
          <button className="icon-btn" title="Collapse All" onClick={collapseAll}>
            <VscCollapseAll size={16} />
          </button>
        </div>
      </div>
      <div className="file-tree">
        {(!tree || tree.length === 0) && !showNewFileInput && !showNewFolderInput ? (
          <div className="explorer-empty-state">
            <VscFolderOpened size={40} className="explorer-empty-icon" />
            <p className="explorer-empty-title">No folder opened</p>
            <p className="explorer-empty-desc">
              Open a folder to start working on your project.
            </p>
            <button className="explorer-open-folder-btn" onClick={onOpenFolder}>
              Open Folder
            </button>
          </div>
        ) : (
          <>
            {(showNewFileInput || showNewFolderInput) && (
              <div className="tree-item" style={{ padding: '4px 8px' }}>
                <span className="tree-chevron" style={{ visibility: 'hidden' }}>
                  <VscChevronRight size={16} />
                </span>
                {showNewFolderInput ? <span className="folder-icon">📁</span> : <span className="file-icon" style={{ color: '#6a6a6a' }}>F</span>}
                <div className="search-input-wrapper" style={{ flex: 1, margin: 0, minWidth: 0 }}>
                  <input
                    ref={newItemInputRef}
                    className="search-input"
                    placeholder={showNewFolderInput ? 'Folder name' : 'File name'}
                    value={newItemName}
                    onChange={e => setNewItemName(e.target.value)}
                    onKeyDown={handleNewItemKeyDown}
                    onBlur={() => { if (!newItemName.trim()) cancelNewItem(); }}
                  />
                </div>
              </div>
            )}
            {tree
              .sort((a, b) => {
                if (a.type === b.type) return a.name.localeCompare(b.name);
                return a.type === 'folder' ? -1 : 1;
              })
              .map(node => (
                <TreeNode
                  key={node.name}
                  node={node}
                  basePath=""
                  depth={0}
                  openFile={openFile}
                  selectedFile={selectedFile}
                  expandedFolders={expandedFolders}
                  toggleFolder={toggleFolder}
                />
              ))}
          </>
        )}
      </div>
    </div>
  );
}

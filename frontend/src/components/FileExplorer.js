import React, { useState, useCallback, useRef, useEffect } from 'react';
import axios from 'axios';
import {
  VscChevronRight,
  VscChevronDown,
  VscNewFile,
  VscNewFolder,
  VscRefresh,
  VscCollapseAll,
  VscFolderOpened,
  VscEllipsis,
  VscEdit,
  VscTrash,
  VscCopy,
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

function TreeNode({ node, basePath, depth, openFile, selectedFile, expandedFolders, toggleFolder, lazyChildren, showHiddenFiles, onContextMenu, onDragStart, onDragOver, onDragLeave, onDrop, isDropTarget, dropTarget }) {
  const fullPath = basePath ? `${basePath}/${node.name}` : node.name;
  const isExpanded = expandedFolders.has(fullPath);
  const isSelected = selectedFile === fullPath;

  const children = lazyChildren?.[fullPath] || node.children || [];
  const hasContent = node.hasChildren !== false;
  const childDropTarget = dropTarget;

        if (node.type === 'folder') {
    return (
      <div className="tree-node">
        <div
          className={`tree-item tree-folder ${isSelected ? 'selected' : ''} ${isDropTarget ? 'tree-drop-target' : ''}`}
          style={{ paddingLeft: depth * 16 + 8 }}
          onClick={() => toggleFolder(fullPath)}
          onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onContextMenu?.(e, fullPath, 'folder'); }}
          draggable
          onDragStart={(e) => onDragStart?.(e, fullPath, 'folder')}
          onDragOver={(e) => onDragOver?.(e, fullPath)}
          onDragLeave={() => onDragLeave?.()}
          onDrop={(e) => onDrop?.(e, fullPath)}
        >
          <span className="tree-chevron">
            {hasContent
              ? (isExpanded ? <VscChevronDown size={16} /> : <VscChevronRight size={16} />)
              : <VscChevronRight size={16} style={{ opacity: 0 }} />
            }
          </span>
          <span className="folder-icon">{isExpanded ? '📂' : '📁'}</span>
          <span className="tree-label">{node.name}</span>
        </div>
        {isExpanded && children.length > 0 && (
          <div className="tree-children">
            {children
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
                  lazyChildren={lazyChildren}
                  showHiddenFiles={showHiddenFiles}
                  onContextMenu={onContextMenu}
                  onDragStart={onDragStart}
                  onDragOver={onDragOver}
                  onDragLeave={onDragLeave}
                  onDrop={onDrop}
                  isDropTarget={childDropTarget === `${fullPath}/${child.name}`}
                  dropTarget={childDropTarget}
                />
              ))}
          </div>
        )}
        {isExpanded && children.length === 0 && hasContent && (
          <div style={{ paddingLeft: (depth + 1) * 16 + 8, color: 'var(--text-ghost)', fontSize: 'var(--font-size-xs)', padding: '4px 8px' }}>
            Loading...
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
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onContextMenu?.(e, fullPath, 'file'); }}
      draggable
      onDragStart={(e) => onDragStart?.(e, fullPath, 'file')}
    >
      <span className="tree-chevron" style={{ visibility: 'hidden' }}>
        <VscChevronRight size={16} />
      </span>
      {getFileIcon(node.name)}
      <span className="tree-label">{node.name}</span>
    </div>
  );
}

export default function FileExplorer({ tree, openFile, selectedFile, onRefresh, showHiddenFiles, onToggleShowHidden, triggerNewFile, onNewFileDone, onOpenFolder, onLoadChildren }) {
  const [expandedFolders, setExpandedFolders] = useState(new Set());
  const [lazyChildren, setLazyChildren] = useState({});
  const [showNewFileInput, setShowNewFileInput] = useState(false);
  const [showNewFolderInput, setShowNewFolderInput] = useState(false);
  const [newItemName, setNewItemName] = useState('');
  const [contextMenu, setContextMenu] = useState(null);
  const [renamePath, setRenamePath] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  const [dropTarget, setDropTarget] = useState(null);
  const dragSourceRef = useRef(null);
  const newItemInputRef = useRef(null);
  const renameInputRef = useRef(null);

  useEffect(() => {
    const close = () => setContextMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('scroll', close, true);
    return () => { window.removeEventListener('click', close); window.removeEventListener('scroll', close, true); };
  }, []);

  useEffect(() => {
    if (renamePath && renameInputRef.current) renameInputRef.current.focus();
  }, [renamePath]);

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
        if (!lazyChildren[path]) {
          if (onLoadChildren) {
            onLoadChildren(path).then(data => {
              if (Array.isArray(data)) setLazyChildren(prev => ({ ...prev, [path]: data }));
            }).catch(() => {});
          } else {
            axios.get(`${API}/files/tree-children`, { params: { path, show_hidden: showHiddenFiles } })
              .then(res => {
                if (Array.isArray(res.data)) setLazyChildren(prev => ({ ...prev, [path]: res.data }));
              })
              .catch(() => {});
          }
        }
      }
      return next;
    });
  }, [lazyChildren, showHiddenFiles, onLoadChildren]);

  const handleContextMenu = useCallback((e, path, type) => {
    setContextMenu({ x: e.clientX, y: e.clientY, path, type });
  }, []);

  const handleRename = useCallback(async () => {
    if (!renamePath || !renameValue.trim()) { setRenamePath(null); setRenameValue(''); return; }
    const newName = renameValue.trim();
    try {
      const res = await axios.post(`${API}/files/rename`, null, { params: { path: renamePath, new_name: newName } });
      if (res.data.status === 'renamed') {
        setLazyChildren(prev => {
          const next = { ...prev };
          const parent = renamePath.includes('/') ? renamePath.replace(/\/[^/]+$/, '') : '';
          if (parent && next[parent]) {
            next[parent] = next[parent].map(item => item.name === renamePath.split('/').pop() ? { ...item, name: newName } : item);
          }
          delete next[renamePath];
          return next;
        });
        onRefresh?.();
      }
    } catch (_) {}
    setRenamePath(null); setRenameValue('');
  }, [renamePath, renameValue, onRefresh]);

  const handleDelete = useCallback(async (path) => {
    if (!path || !window.confirm(`Delete "${path}"?`)) return;
    try {
      await axios.delete(`${API}/files/delete`, { params: { path } });
      setContextMenu(null);
      setLazyChildren(prev => { const next = { ...prev }; delete next[path]; return next; });
      onRefresh?.();
    } catch (_) {}
  }, [onRefresh]);

  const copyPath = useCallback((path) => {
    navigator.clipboard.writeText(path);
    setContextMenu(null);
  }, []);

  const handleDragStart = useCallback((e, path, type) => {
    dragSourceRef.current = { path, type };
    e.dataTransfer.setData('text/plain', path);
    e.dataTransfer.effectAllowed = 'move';
  }, []);

  const handleDragOver = useCallback((e, folderPath) => {
    e.preventDefault();
    e.stopPropagation();
    const src = dragSourceRef.current;
    if (!src || src.path === folderPath || folderPath.startsWith(src.path + '/')) return;
    e.dataTransfer.dropEffect = 'move';
    setDropTarget(folderPath);
  }, []);

  const handleDrop = useCallback(async (e, destFolderPath) => {
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(null);
    const src = dragSourceRef.current;
    if (!src || !destFolderPath) return;
    if (src.path === destFolderPath || destFolderPath.startsWith(src.path + '/')) return;
    try {
      const res = await axios.post(`${API}/files/move`, null, { params: { path: src.path, dest: destFolderPath } });
      if (res.data.status === 'moved') {
        setLazyChildren(prev => { const next = { ...prev }; delete next[src.path]; return next; });
        onRefresh?.();
      }
    } catch (_) {}
    dragSourceRef.current = null;
  }, [onRefresh]);

  const handleDragLeave = useCallback(() => setDropTarget(null), []);

  const collapseAll = useCallback(() => {
    setExpandedFolders(new Set());
    setLazyChildren({});
  }, []);

  return (
    <div className="file-explorer">
      <div className="sidebar-header">
        <span className="sidebar-title">EXPLORER</span>
        <div className="sidebar-actions">
          <button className={`icon-btn ${showHiddenFiles ? 'active' : ''}`} title="Show hidden files" onClick={onToggleShowHidden}>
            <VscEllipsis size={16} />
          </button>
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
      {contextMenu && (
        <div
          className="file-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button type="button" className="context-menu-item" onClick={() => { setRenamePath(contextMenu.path); setRenameValue(contextMenu.path.split('/').pop()); setContextMenu(null); }}>
            <VscEdit size={14} /> Rename
          </button>
          <button type="button" className="context-menu-item" onClick={() => copyPath(contextMenu.path)}>
            <VscCopy size={14} /> Copy path
          </button>
          <button type="button" className="context-menu-item context-menu-item-danger" onClick={() => handleDelete(contextMenu.path)}>
            <VscTrash size={14} /> Delete
          </button>
        </div>
      )}
      {renamePath && (
        <div className="tree-item" style={{ padding: '4px 8px' }}>
          <span className="tree-chevron" style={{ visibility: 'hidden' }}><VscChevronRight size={16} /></span>
          <span className="file-icon" style={{ color: '#6a6a6a' }}>F</span>
          <input
            ref={renameInputRef}
            className="search-input"
            value={renameValue}
            onChange={e => setRenameValue(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleRename(); if (e.key === 'Escape') { setRenamePath(null); setRenameValue(''); } }}
            onBlur={handleRename}
            style={{ flex: 1, margin: 0, minWidth: 0 }}
          />
        </div>
      )}
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
                  lazyChildren={lazyChildren}
                  showHiddenFiles={showHiddenFiles}
                  onContextMenu={handleContextMenu}
                  onDragStart={handleDragStart}
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                  onDrop={handleDrop}
                  isDropTarget={node.type === 'folder' && dropTarget === node.name}
                  dropTarget={dropTarget}
                />
              ))}
          </>
        )}
      </div>
    </div>
  );
}

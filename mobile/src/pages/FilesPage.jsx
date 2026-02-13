import { useState, useEffect } from 'react';
import nebulaWS from '../services/websocket';
import './FilesPage.css';

function fileIcon(name, type) {
  if (type === 'folder') return '📁';
  const ext = name.split('.').pop()?.toLowerCase();
  const icons = {
    js: '📜', jsx: '⚛', ts: '📘', tsx: '⚛',
    py: '🐍', json: '{ }', css: '🎨', html: '🌐',
    md: '📝', txt: '📄', sh: '⌘', yml: '⚙',
    yaml: '⚙', toml: '⚙', env: '🔒', gitignore: '🔒',
    png: '🖼', jpg: '🖼', svg: '🖼', ico: '🖼',
  };
  return icons[ext] || '📄';
}

export default function FilesPage() {
  const [tree, setTree] = useState([]);
  const [workspace, setWorkspace] = useState('');
  const [loading, setLoading] = useState(true);
  const [expandedDirs, setExpandedDirs] = useState(new Set());
  const [viewingFile, setViewingFile] = useState(null);
  const [fileContent, setFileContent] = useState('');
  const [fileLoading, setFileLoading] = useState(false);

  useEffect(() => {
    const unsubTree = nebulaWS.on('file_tree', (data) => {
      setTree(data.tree || []);
      setWorkspace(data.name || '');
      setLoading(false);
    });

    const unsubContent = nebulaWS.on('file_content', (data) => {
      setFileContent(data.content || data.error || '');
      setFileLoading(false);
    });

    // Request file tree
    if (nebulaWS.connected) {
      nebulaWS.requestFiles();
    }

    return () => {
      unsubTree();
      unsubContent();
    };
  }, []);

  const toggleDir = (path) => {
    setExpandedDirs(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const openFile = (path) => {
    setViewingFile(path);
    setFileContent('');
    setFileLoading(true);
    nebulaWS.requestFileContent(path);
  };

  const refresh = () => {
    setLoading(true);
    nebulaWS.requestFiles();
  };

  if (viewingFile) {
    return (
      <div className="page files-page">
        <div className="page-header">
          <div className="file-viewer-header">
            <button className="btn btn-secondary btn-sm" onClick={() => setViewingFile(null)}>
              ← Back
            </button>
            <span className="file-viewer-name">{viewingFile.split('/').pop()}</span>
          </div>
          <p className="file-viewer-path">{viewingFile}</p>
        </div>
        <div className="page-content">
          {fileLoading ? (
            <div className="file-loading">Loading file...</div>
          ) : (
            <div className="code-block file-code">{fileContent}</div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="page files-page">
      <div className="page-header">
        <div className="files-header-row">
          <div>
            <h1>Files</h1>
            {workspace && <p>{workspace}</p>}
          </div>
          <button className="btn btn-secondary btn-sm" onClick={refresh}>
            ↻ Refresh
          </button>
        </div>
      </div>

      <div className="page-content">
        {loading ? (
          <div className="file-loading">Loading file tree...</div>
        ) : tree.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">◧</div>
            <div className="empty-state-text">
              No files found.<br />
              Make sure the IDE is running with a project open.
            </div>
          </div>
        ) : (
          <div className="file-tree">
            {tree.map((item) => (
              <FileNode
                key={item.name}
                item={item}
                path={item.name}
                depth={0}
                expandedDirs={expandedDirs}
                toggleDir={toggleDir}
                openFile={openFile}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function FileNode({ item, path, depth, expandedDirs, toggleDir, openFile }) {
  const isFolder = item.type === 'folder';
  const isExpanded = expandedDirs.has(path);

  const handleClick = () => {
    if (isFolder) {
      toggleDir(path);
    } else {
      openFile(path);
    }
  };

  return (
    <>
      <div
        className={`file-node ${isFolder ? 'folder' : 'file'}`}
        style={{ paddingLeft: `${depth * 20 + 12}px` }}
        onClick={handleClick}
      >
        <span className="file-expand">
          {isFolder ? (isExpanded ? '▾' : '▸') : ' '}
        </span>
        <span className="file-icon">{fileIcon(item.name, item.type)}</span>
        <span className="file-name">{item.name}</span>
        {!isFolder && item.size > 0 && (
          <span className="file-size">
            {item.size < 1024 ? `${item.size}B` : `${(item.size / 1024).toFixed(1)}K`}
          </span>
        )}
      </div>
      {isFolder && isExpanded && item.children && (
        item.children.map((child) => (
          <FileNode
            key={child.name}
            item={child}
            path={`${path}/${child.name}`}
            depth={depth + 1}
            expandedDirs={expandedDirs}
            toggleDir={toggleDir}
            openFile={openFile}
          />
        ))
      )}
    </>
  );
}

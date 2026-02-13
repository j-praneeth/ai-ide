import React, { useState, useEffect, useCallback } from 'react';
import {
  VscFolderOpened,
  VscChevronLeft,
  VscHome,
  VscRefresh,
} from 'react-icons/vsc';
import axios from 'axios';

const API = 'http://127.0.0.1:8000';

export default function OpenFolderDialog({ visible, onClose, onOpen }) {
  const [currentPath, setCurrentPath] = useState('~');
  const [folders, setFolders] = useState([]);
  const [parentPath, setParentPath] = useState('');
  const [loading, setLoading] = useState(false);
  const [pathInput, setPathInput] = useState('');
  const [error, setError] = useState('');

  const loadFolders = useCallback(async (path) => {
    setLoading(true);
    setError('');
    try {
      const res = await axios.get(`${API}/files/list-folders`, {
        params: { path },
      });
      if (res.data.error) {
        setError(res.data.error);
      } else {
        setCurrentPath(res.data.current || path);
        setPathInput(res.data.current || path);
        setFolders(res.data.folders || []);
        setParentPath(res.data.parent || '');
      }
    } catch (err) {
      setError('Failed to load folders. Is the backend running?');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (visible) {
      loadFolders('~');
    }
  }, [visible, loadFolders]);

  const handleOpen = async () => {
    const target = pathInput.trim() || currentPath;
    try {
      const res = await axios.post(`${API}/files/open-folder`, null, {
        params: { path: target },
      });
      if (res.data.error) {
        setError(res.data.error);
      } else {
        onOpen(res.data.path, res.data.name);
        onClose();
      }
    } catch (err) {
      setError('Failed to open folder');
    }
  };

  const navigateTo = (path) => {
    loadFolders(path);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      // If the input looks like a path, navigate or open
      const val = pathInput.trim();
      if (val) {
        loadFolders(val);
      }
    }
    if (e.key === 'Escape') {
      onClose();
    }
  };

  if (!visible) return null;

  return (
    <div className="command-palette-overlay" onClick={onClose}>
      <div className="open-folder-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="open-folder-header">
          <VscFolderOpened size={20} style={{ color: 'var(--accent)' }} />
          <h3>Open Folder</h3>
        </div>

        {/* Path input bar */}
        <div className="open-folder-path-bar">
          <button
            className="icon-btn"
            title="Go to parent"
            disabled={!parentPath}
            onClick={() => parentPath && navigateTo(parentPath)}
          >
            <VscChevronLeft size={16} />
          </button>
          <button
            className="icon-btn"
            title="Home"
            onClick={() => navigateTo('~')}
          >
            <VscHome size={16} />
          </button>
          <input
            className="open-folder-path-input"
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Enter folder path..."
          />
          <button
            className="icon-btn"
            title="Refresh"
            onClick={() => loadFolders(currentPath)}
          >
            <VscRefresh size={16} />
          </button>
        </div>

        {error && (
          <div className="open-folder-error">{error}</div>
        )}

        {/* Folder list */}
        <div className="open-folder-list">
          {loading ? (
            <div className="open-folder-empty">Loading...</div>
          ) : folders.length === 0 ? (
            <div className="open-folder-empty">No subfolders found</div>
          ) : (
            folders.map((folder) => (
              <div
                key={folder.path}
                className="open-folder-item"
                onDoubleClick={() => navigateTo(folder.path)}
                onClick={() => setPathInput(folder.path)}
              >
                <span className="open-folder-icon">📁</span>
                <span className="open-folder-name">{folder.name}</span>
              </div>
            ))
          )}
        </div>

        {/* Actions */}
        <div className="open-folder-actions">
          <div className="open-folder-current">
            {currentPath}
          </div>
          <div className="open-folder-buttons">
            <button className="open-folder-cancel" onClick={onClose}>
              Cancel
            </button>
            <button className="open-folder-open" onClick={handleOpen}>
              Open Folder
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

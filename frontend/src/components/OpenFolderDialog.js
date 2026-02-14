import { useEffect, useState } from 'react';
import axios from 'axios';
import { API_URL as API } from '../config';
import { IS_ELECTRON } from '../config';

/**
 * OpenFolderDialog — uses native OS / system file picker.
 * - Electron: native folder dialog via electronAPI.
 * - Web: File System Access API showDirectoryPicker() when available; then user enters path for backend.
 */
export default function OpenFolderDialog({ visible, onClose, onOpen }) {
  const [webFolderName, setWebFolderName] = useState(null);
  const [webPath, setWebPath] = useState('');
  const [webError, setWebError] = useState('');

  useEffect(() => {
    if (!visible) {
      setWebFolderName(null);
      setWebPath('');
      setWebError('');
    }
  }, [visible]);

  useEffect(() => {
    if (!visible) return;

    const openNative = async () => {
      try {
        if (IS_ELECTRON && window.electronAPI?.openFolderDialog) {
          const folderPath = await window.electronAPI.openFolderDialog();
          if (folderPath) {
            const res = await axios.post(`${API}/files/open-folder`, null, {
              params: { path: folderPath },
            });
            if (!res.data.error) {
              onOpen(res.data.path, res.data.name);
            }
          }
          onClose();
          return;
        }

        // Web: use system folder picker when available
        if (typeof window.showDirectoryPicker === 'function') {
          const handle = await window.showDirectoryPicker();
          setWebFolderName(handle.name);
          setWebPath('');
          setWebError('');
          return;
        }

        // Fallback: prompt for path (e.g. Safari, or no File System Access API)
        const folderPath = window.prompt('Enter folder path:');
        if (folderPath) {
          const res = await axios.post(`${API}/files/open-folder`, null, {
            params: { path: folderPath },
          });
          if (!res.data.error) {
            onOpen(res.data.path, res.data.name);
          }
        }
        onClose();
      } catch (err) {
        if (err.name === 'AbortError') {
          // User cancelled the picker
        } else {
          console.error('Failed to open folder:', err);
        }
        onClose();
      }
    };

    openNative();
  }, [visible, onClose, onOpen]);

  const handleWebPathSubmit = async (e) => {
    e.preventDefault();
    setWebError('');
    const path = webPath.trim();
    if (!path) {
      setWebError('Enter the folder path');
      return;
    }
    try {
      const res = await axios.post(`${API}/files/open-folder`, null, {
        params: { path },
      });
      if (res.data.error) {
        setWebError(res.data.error);
        return;
      }
      onOpen(res.data.path, res.data.name);
      setWebFolderName(null);
      setWebPath('');
      onClose();
    } catch (err) {
      setWebError(err.message || 'Failed to open folder');
    }
  };

  if (!visible) return null;

  // Web: after user picked a folder via system picker, show path input (backend needs path)
  if (webFolderName) {
    return (
      <div className="open-folder-overlay" onClick={() => { setWebFolderName(null); onClose(); }}>
        <div className="open-folder-dialog" onClick={e => e.stopPropagation()} style={{ padding: '20px' }}>
          <h3 className="open-folder-title">Open Folder</h3>
          <p className="open-folder-hint">
            Selected: <strong>{webFolderName}</strong>. Enter the full path to this folder on your computer (the backend needs it):
          </p>
          <form onSubmit={handleWebPathSubmit}>
            <input
              type="text"
              className="open-folder-input"
              placeholder="e.g. /Users/you/projects/my-app"
              value={webPath}
              onChange={e => setWebPath(e.target.value)}
              autoFocus
            />
            {webError && <p className="open-folder-error">{webError}</p>}
            <div className="open-folder-actions">
              <button type="button" onClick={() => { setWebFolderName(null); onClose(); }}>
                Cancel
              </button>
              <button type="submit">Open</button>
            </div>
          </form>
        </div>
      </div>
    );
  }

  return null;
}

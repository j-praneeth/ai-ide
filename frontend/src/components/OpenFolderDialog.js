import { useEffect, useState } from 'react';
import axios from 'axios';
import { API_URL as API } from '../config';
import { IS_ELECTRON } from '../config';

/**
 * OpenFolderDialog — system file picker only (no project folder URL input).
 * - Electron: native folder picker, then open that path on the backend.
 * - Web: showDirectoryPicker() only; folder is used via the handle (tree/read/write in frontend).
 */
export default function OpenFolderDialog({ visible, onClose, onOpen }) {
  const [unsupported, setUnsupported] = useState(false);

  useEffect(() => {
    if (!visible) {
      setUnsupported(false);
      return;
    }

    const run = async () => {
      try {
        if (IS_ELECTRON && window.electronAPI?.openFolderDialog) {
          const folderPath = await window.electronAPI.openFolderDialog();
          if (folderPath) {
            const res = await axios.post(`${API}/files/open-folder`, null, {
              params: { path: folderPath },
            });
            if (!res.data.error) {
              onOpen(res.data.path, res.data.name, null);
            }
          }
          onClose();
          return;
        }

        if (typeof window.showDirectoryPicker !== 'function') {
          setUnsupported(true);
          return;
        }

        const handle = await window.showDirectoryPicker();
        onOpen(null, handle.name, handle);
        onClose();
      } catch (err) {
        if (err.name !== 'AbortError') console.error('Failed to open folder:', err);
        onClose();
      }
    };

    run();
  }, [visible, onClose, onOpen]);

  if (!visible) return null;
  if (unsupported) {
    return (
      <div className="open-folder-overlay" onClick={onClose}>
        <div className="open-folder-dialog" onClick={e => e.stopPropagation()} style={{ padding: '20px' }}>
          <h3 className="open-folder-title">Open Folder</h3>
          <p className="open-folder-hint">Folder picker is not supported in this browser. Use Chrome or Edge, or run the desktop app.</p>
          <div className="open-folder-actions">
            <button type="button" onClick={onClose}>Close</button>
          </div>
        </div>
      </div>
    );
  }
  return null;
}

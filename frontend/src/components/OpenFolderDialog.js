import { useEffect, useState } from 'react';
import axios from 'axios';
import { API_URL as API } from '../config';
import { IS_ELECTRON } from '../config';

export default function OpenFolderDialog({ visible, onClose, onOpen, showHiddenFiles = true }) {
  const [unsupported, setUnsupported] = useState(false);

  useEffect(() => {
    if (!visible) {
      setUnsupported(false);
      return;
    }

    const run = async () => {
      try {
        // Electron: native OS dialog — always gives full path
        if (IS_ELECTRON && window.electronAPI?.openFolderDialog) {
          const folderPath = await window.electronAPI.openFolderDialog();
          if (folderPath) {
            const postOpen = axios.post(`${API}/files/open-folder`, null, {
              params: { path: folderPath, show_hidden: showHiddenFiles },
            });
            const nativeTree = window.electronAPI?.listProjectDir
              ? window.electronAPI.listProjectDir('', showHiddenFiles).catch(() => null)
              : Promise.resolve(null);
            const [ipcTree, res] = await Promise.all([nativeTree, postOpen]);
            if (!res.data.error) {
              const apiTree = Array.isArray(res.data.tree) ? res.data.tree : [];
              const tree = Array.isArray(ipcTree) && ipcTree.length > 0 ? ipcTree : apiTree;
              onOpen(res.data.path, res.data.name, null, tree);
            }
          }
          onClose();
          return;
        }

        // Web browser: showDirectoryPicker doesn't give path, but we can
        // read top-level entry names and ask the backend to find the folder.
        if (typeof window.showDirectoryPicker !== 'function') {
          setUnsupported(true);
          return;
        }

        const handle = await window.showDirectoryPicker();

        // Collect up to 20 top-level entry names for backend matching
        const entries = [];
        try {
          for await (const [name] of handle.entries()) {
            entries.push(name);
            if (entries.length >= 20) break;
          }
        } catch (_) {}

        // Ask the backend to find the folder's absolute path by name + entries
        let resolvedPath = null;
        try {
          const res = await axios.post(`${API}/files/resolve-path`, {
            folder_name: handle.name,
            entries,
          });
          if (res.data.found && res.data.path) {
            resolvedPath = res.data.path;
          }
        } catch (_) {}

        if (resolvedPath) {
          // Backend already set PROJECT_ROOT; call open-folder to confirm name
          try {
            const res = await axios.post(`${API}/files/open-folder`, null, {
              params: { path: resolvedPath, show_hidden: showHiddenFiles },
            });
            if (!res.data.error) {
              onOpen(res.data.path, res.data.name, handle, res.data.tree);
              onClose();
              return;
            }
          } catch (_) {}
        }

        // Fallback: open with handle only (terminal will use home dir)
        onOpen(null, handle.name, handle);
        onClose();
      } catch (err) {
        if (err.name !== 'AbortError') console.error('Failed to open folder:', err);
        onClose();
      }
    };

    run();
  }, [visible, onClose, onOpen, showHiddenFiles]);

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

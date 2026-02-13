import { useEffect } from 'react';
import axios from 'axios';
import { API_URL as API } from '../config';

/**
 * OpenFolderDialog — always uses the native OS file picker.
 * No custom browser, no delay. Instant native dialog.
 */
export default function OpenFolderDialog({ visible, onClose, onOpen }) {
  useEffect(() => {
    if (!visible) return;

    const openNative = async () => {
      try {
        // Use native Electron dialog
        if (window.electronAPI?.openFolderDialog) {
          const folderPath = await window.electronAPI.openFolderDialog();
          if (folderPath) {
            const res = await axios.post(`${API}/files/open-folder`, null, {
              params: { path: folderPath },
            });
            if (!res.data.error) {
              onOpen(res.data.path, res.data.name);
            }
          }
        } else {
          // Fallback for browser (non-Electron): prompt for path
          const folderPath = window.prompt('Enter folder path:');
          if (folderPath) {
            const res = await axios.post(`${API}/files/open-folder`, null, {
              params: { path: folderPath },
            });
            if (!res.data.error) {
              onOpen(res.data.path, res.data.name);
            }
          }
        }
      } catch (err) {
        console.error('Failed to open folder:', err);
      } finally {
        onClose();
      }
    };

    openNative();
  }, [visible, onClose, onOpen]);

  // No UI — the native OS dialog handles everything
  return null;
}

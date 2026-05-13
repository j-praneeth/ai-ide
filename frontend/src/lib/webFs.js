/**
 * Helpers for using File System Access API (showDirectoryPicker) in web.
 * Used when Open Folder in browser: we only have a handle, no path.
 *
 * Performance characteristics:
 * - Uses hard caps to prevent infinite iteration on huge directories.
 * - Skips hidden files early (before push) to reduce memory pressure.
 * - Iterates at most _SCAN_HARD_CAP entries in any single directory.
 * - Only reads one directory level — no recursion. Children are loaded
 *   lazily on expand via loadChildrenFromHandle in App.js.
 */

const _SCAN_HARD_CAP = 3000;

export async function listDirFromHandle(handle, basePath = '', showHidden = false) {
  const nodes = [];
  let count = 0;
  for await (const [name, entry] of handle.entries()) {
    count++;
    if (count > _SCAN_HARD_CAP) break;
    if (!showHidden && name.startsWith('.')) continue;
    const path = basePath ? `${basePath}/${name}` : name;
    const isDir = entry.kind === 'directory';
    nodes.push({
      name,
      type: isDir ? 'folder' : 'file',
      path,
      hasChildren: isDir,
      children: [],
    });
  }
  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
  return nodes;
}

export async function getHandleForPath(rootHandle, path) {
  const parts = path.split('/').filter(Boolean);
  let h = rootHandle;
  for (const p of parts) {
    h = await h.getDirectoryHandle(p);
  }
  return h;
}

export async function getFileContentFromHandle(rootHandle, path) {
  const parts = path.split('/').filter(Boolean);
  const fileName = parts.pop();
  if (!fileName) throw new Error('Invalid path');
  let dirHandle = rootHandle;
  for (const p of parts) {
    dirHandle = await dirHandle.getDirectoryHandle(p);
  }
  const fileHandle = await dirHandle.getFileHandle(fileName);
  const file = await fileHandle.getFile();
  return await file.text();
}

export async function writeFileToHandle(rootHandle, path, content) {
  const parts = path.split('/').filter(Boolean);
  const fileName = parts.pop();
  if (!fileName) throw new Error('Invalid path');
  let dirHandle = rootHandle;
  for (const p of parts) {
    dirHandle = await dirHandle.getDirectoryHandle(p, { create: true });
  }
  const fileHandle = await dirHandle.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(content);
  await writable.close();
}

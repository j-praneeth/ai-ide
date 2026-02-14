/**
 * Helpers for using File System Access API (showDirectoryPicker) in web.
 * Used when Open Folder in browser: we only have a handle, no path.
 */

const SKIP_DIRS = new Set([
  'node_modules', '.git', '__pycache__', '.next', '.cache', 'venv', 'env',
  'dist', 'build', '.idea', '.vscode', '.cursor', 'coverage',
]);

export async function listDirFromHandle(handle, basePath = '', showHidden = false) {
  const nodes = [];
  for await (const [name, entry] of handle.entries()) {
    if (!showHidden && name.startsWith('.') && name !== '.env' && name !== '.gitignore') continue;
    if (entry.kind === 'directory' && SKIP_DIRS.has(name)) continue;
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

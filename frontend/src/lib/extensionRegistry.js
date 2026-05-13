/**
 * extensionRegistry — single source of truth for installed extensions.
 *
 * Persists to localStorage, emits CustomEvents on change so any component
 * can react without prop-drilling.
 */

const STORAGE_KEY = 'nebula_installed_extensions_v2';

// Extensions whose sidebar view we support natively (first-class integration)
const KNOWN_SIDEBAR_IDS = new Set([
  'Continue.continue',
  'kilocode.kilo-code',
  'RooveterinaryInc.roo-cline',
  'saoudrizwan.claude-dev',
  'github.copilot-chat',
  'github.copilot',
  'ms-toolsai.jupyter',
  'ms-python.python',
  'esbenp.prettier-vscode',
  'dbaeumer.vscode-eslint',
  'eamodio.gitlens',
]);

// Tags / categories that imply a sidebar panel
const SIDEBAR_TAGS = new Set(['ai', 'assistant', 'chat', 'copilot', 'notebook']);
const SIDEBAR_CATEGORIES = new Set(['Debuggers', 'Notebooks', 'Testing']);

function _isSidebarApp(ext) {
  if (KNOWN_SIDEBAR_IDS.has(ext.id)) return true;
  const tags = (ext.tags || []).map(t => t.toLowerCase());
  if (tags.some(t => SIDEBAR_TAGS.has(t))) return true;
  const cats = ext.categories || [];
  if (cats.some(c => SIDEBAR_CATEGORIES.has(c))) return true;
  return false;
}

class ExtensionRegistry extends EventTarget {
  constructor() {
    super();
    this._exts = this._load();
  }

  _load() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); }
    catch { return []; }
  }

  _persist() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this._exts)); } catch (_) {}
    this.dispatchEvent(new CustomEvent('change', { detail: this.getAll() }));
  }

  getAll() { return [...this._exts]; }

  isInstalled(id) { return this._exts.some(e => e.id === id); }

  install(ext) {
    if (!ext?.id || this.isInstalled(ext.id)) return;
    const entry = { ...ext, installedAt: Date.now(), sidebarApp: _isSidebarApp(ext) };
    this._exts = [...this._exts, entry];
    this._persist();
    // Trigger vsix download/extract in Electron if available
    if (window.electronAPI?.extensions?.install) {
      window.electronAPI.extensions.install(entry).catch(() => {});
    }
  }

  uninstall(id) {
    this._exts = this._exts.filter(e => e.id !== id);
    this._persist();
    if (window.electronAPI?.extensions?.uninstall) {
      window.electronAPI.extensions.uninstall(id).catch(() => {});
    }
  }

  getSidebarApps() {
    return this._exts.filter(e => e.sidebarApp);
  }

  /** Called by Electron after vsix extraction to update the manifest */
  updateManifest(id, manifest) {
    this._exts = this._exts.map(e => e.id === id ? { ...e, manifest } : e);
    this._persist();
  }

  find(id) { return this._exts.find(e => e.id === id) || null; }
}

export const extensionRegistry = new ExtensionRegistry();

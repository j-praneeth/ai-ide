function getConfig() {
  const cfg = (typeof window !== 'undefined' && window.NEBULA_DOWNLOAD_CONFIG) ? window.NEBULA_DOWNLOAD_CONFIG : {};
  const metaEndpoint = typeof cfg.metaEndpoint === 'string' ? cfg.metaEndpoint : '/download/latest/meta';
  const downloadEndpoint = typeof cfg.downloadEndpoint === 'string' ? cfg.downloadEndpoint : '/download/latest';
  return { metaEndpoint, downloadEndpoint };
}

function setNotice(message, { isError } = {}) {
  const el = document.getElementById('notice');
  if (!el) return;
  el.classList.toggle('is-error', !!isError);
  el.innerHTML = message || '';
}

function setLoading(loading) {
  const primary = document.getElementById('downloadPrimary');
  const row = document.getElementById('downloadRow');
  if (primary) {
    primary.classList.toggle('is-loading', !!loading);
    primary.setAttribute('aria-busy', loading ? 'true' : 'false');
  }
  if (row) {
    row.classList.toggle('is-loading', !!loading);
    row.setAttribute('aria-busy', loading ? 'true' : 'false');
  }
}

function setDisabled(disabled) {
  const primary = document.getElementById('downloadPrimary');
  const row = document.getElementById('downloadRow');
  const apply = (a) => {
    if (!a) return;
    a.classList.toggle('is-disabled', !!disabled);
    if (disabled) {
      a.setAttribute('aria-disabled', 'true');
      a.removeAttribute('href');
    } else {
      a.removeAttribute('aria-disabled');
    }
  };
  apply(primary);
  apply(row);
}

function setButtonLabel(text) {
  const primary = document.querySelector('#downloadPrimary .btn-label');
  if (primary) primary.textContent = text;
}

function setMeta(text) {
  const el = document.getElementById('downloadMeta');
  if (el) el.textContent = text;
}

function escapeHtml(s) {
  return String(s || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

async function fetchLatestWindowsExe({ metaEndpoint, downloadEndpoint }) {
  const res = await fetch(metaEndpoint, { cache: 'no-store' });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (res.status === 404) throw new Error('No Windows build found on this server.');
    throw new Error(text || `Failed to fetch latest build metadata (${res.status})`);
  }
  const data = await res.json().catch(() => null);
  if (!data || data.found !== true) {
    throw new Error('No Windows build found on this server.');
  }
  return {
    url: data.url || downloadEndpoint,
    name: data.filename || 'NebulaIDE.exe',
    tag: '',
    htmlUrl: '',
    mtime: data.mtime || null,
    size: data.size || null,
  };
}

function wireDownload(button, getUrl) {
  if (!button) return;
  button.addEventListener('click', (e) => {
    const url = getUrl();
    if (!url) {
      e.preventDefault();
      return;
    }
    e.preventDefault();
    try {
      button.classList.add('is-loading');
      button.setAttribute('aria-busy', 'true');
    } catch (_) {}
    window.location.assign(url);
    setTimeout(() => {
      try {
        button.classList.remove('is-loading');
        button.setAttribute('aria-busy', 'false');
      } catch (_) {}
    }, 1200);
  });
}

async function init() {
  const primary = document.getElementById('downloadPrimary');
  const row = document.getElementById('downloadRow');

  setLoading(true);
  setDisabled(true);
  setNotice('');
  setButtonLabel('Finding latest Windows build…');
  setMeta('Optimized for Windows x64.');

  const { metaEndpoint, downloadEndpoint } = getConfig();
  let latest = null;

  try {
    latest = await fetchLatestWindowsExe({ metaEndpoint, downloadEndpoint });
  } catch (err) {
    setLoading(false);
    setDisabled(true);
    setButtonLabel('Download unavailable');
    const msg = err && err.message ? err.message : 'Failed to load the latest build.';
    setNotice(
      `${escapeHtml(msg)}`,
      { isError: true }
    );
    return;
  }

  setLoading(false);
  setDisabled(false);

  if (primary) primary.href = latest.url;
  if (row) row.href = latest.url;

  setButtonLabel('Download for Windows');
  setMeta(`${latest.name}`);

  wireDownload(primary, () => latest && latest.url);
  wireDownload(row, () => latest && latest.url);

  setNotice('');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

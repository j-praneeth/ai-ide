function getConfig() {
  var cfg = (typeof window !== 'undefined' && window.NEBULA_DOWNLOAD_CONFIG) ? window.NEBULA_DOWNLOAD_CONFIG : {};
  return cfg.releasesEndpoint || '/api/releases/latest';
}

function qs(id) { return document.getElementById(id); }
function qsa(sel) { return document.querySelectorAll(sel); }

function showNotice(message, opts) {
  opts = opts || {};
  var el = qs('notice');
  if (!el) return;
  el.textContent = message;
  el.classList.toggle('is-visible', true);
  el.classList.toggle('is-error', !!opts.isError);
  if (opts.isError) {
    setTimeout(function () { el.classList.remove('is-visible'); }, 8000);
  } else {
    setTimeout(function () { el.classList.remove('is-visible'); }, 4000);
  }
}

function escapeHtml(s) {
  return String(s || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function detectPlatform() {
  var p = navigator.platform || '';
  if (p.indexOf('Win') !== -1) return 'windows';
  if (p.indexOf('Mac') !== -1) return 'macos';
  return 'windows';
}

function formatDate(iso) {
  if (!iso) return '';
  try {
    var d = new Date(iso);
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  } catch (_) { return iso; }
}

function renderMarkdown(md) {
  if (!md) return '';
  var html = escapeHtml(md);
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  html = html.replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>');
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
  html = html.replace(/<\/li>\n<li>/g, '</li>\n<li>');
  html = html.replace(/(<li>.*<\/li>)/gs, function (m) {
    if (m.split('\n').length > 1) return '<ul>\n' + m.split('\n').map(function (l) { return '  ' + l; }).join('\n') + '\n</ul>';
    return '<ul>\n  ' + m + '\n</ul>';
  });
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/\n{2,}/g, '</p><p>');
  html = html.replace(/\n/g, '<br>');
  html = '<p>' + html + '</p>';
  html = html.replace(/<p><\/p>/g, '');
  html = html.replace(/<\/ul>\n?<br>/g, '</ul>');
  html = html.replace(/<br>\n?<ul>/g, '\n<ul>');
  html = html.replace(/<\/blockquote>\n?<br>/g, '</blockquote>');
  return html;
}

function populateCards(assets, version) {
  var cards = {
    windows: { name: 'Windows', icon: '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>' },
    macos: { name: 'macOS', icon: '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="1"/><path d="M20.2 20.2A2 2 0 0 1 18 22h-12a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v16.2z"/><path d="M8 2v4"/><path d="M16 2v4"/></svg>' },
  };

  var grid = qs('platformCards');
  if (!grid) return;
  grid.innerHTML = '';

  var platformOrder = ['windows', 'macos'];

  platformOrder.forEach(function (key) {
    var info = cards[key];
    var matches = assets.filter(function (a) { return a.platform === key; });

    var card = document.createElement('div');
    card.className = 'platform-card';

    if (matches.length > 0) {
      var best = matches.reduce(function (a, b) { return (a.size || 0) > (b.size || 0) ? a : b; });
      card.classList.add('has-download');

      card.innerHTML =
        '<div class="platform-card-icon">' + info.icon + '</div>' +
        '<div class="platform-card-name">' + info.name + '</div>' +
        '<div class="platform-card-meta">v' + escapeHtml(version) + ' &middot; ' + escapeHtml(best.size_formatted) + '</div>' +
        '<div class="platform-card-action">' +
          '<a class="btn btn-card" href="' + escapeHtml(best.url) + '" download>' +
            'Download for ' + info.name +
          '</a>' +
        '</div>';
    } else {
      card.innerHTML =
        '<div class="platform-card-icon">' + info.icon + '</div>' +
        '<div class="platform-card-name">' + info.name + '</div>' +
        '<div class="platform-card-meta">Not available</div>' +
        '<div class="platform-card-action">' +
          '<span class="btn btn-card is-disabled">Unavailable</span>' +
        '</div>';
    }

    grid.appendChild(card);
  });
}

function setupPrimaryCta(assets, version) {
  var userPlatform = detectPlatform();
  var platformMap = { windows: 'Windows', macos: 'macOS' };

  var matches = assets.filter(function (a) { return a.platform === userPlatform; });
  var targetPlatform = userPlatform;
  if (matches.length === 0) {
      var ordered = ['windows', 'macos'];
    for (var i = 0; i < ordered.length; i++) {
      if (assets.some(function (a) { return a.platform === ordered[i]; })) {
        targetPlatform = ordered[i];
        break;
      }
    }
    matches = assets.filter(function (a) { return a.platform === targetPlatform; });
  }

  if (matches.length === 0) {
    qs('primaryCta').style.display = 'none';
    qs('primaryMeta').textContent = 'No downloads available at this time.';
    return;
  }

  var best = matches.reduce(function (a, b) { return (a.size || 0) > (b.size || 0) ? a : b; });
  var el = qs('primaryCta');
  el.style.display = 'flex';
  qs('primaryPlatform').textContent = platformMap[targetPlatform] || 'Desktop';
  qs('downloadPrimary').href = best.url;
  qs('primaryMeta').textContent = 'Version ' + version + ' &middot; ' + best.size_formatted + ' &middot; ' + (platformMap[targetPlatform] || 'Desktop');
}

function showReleaseNotes(release) {
  var section = qs('releaseNotes');
  if (!release.release_notes) {
    section.style.display = 'none';
    return;
  }
  section.style.display = 'block';
  qs('notesVersion').textContent = 'v' + release.version;
  qs('notesBody').innerHTML = renderMarkdown(release.release_notes);
}

function setAllUnavailable(message) {
  var cards = qsa('.platform-card.is-loading');
  for (var i = 0; i < cards.length; i++) {
    cards[i].classList.remove('is-loading');
    cards[i].querySelector('.platform-card-meta').textContent = message || 'Unavailable';
    var action = cards[i].querySelector('.platform-card-action');
    if (action) {
      action.innerHTML = '<span class="btn btn-card is-disabled">' + (message || 'Unavailable') + '</span>';
    }
  }
}

async function init() {
  var endpoint = getConfig();

  try {
    var resp = await fetch(endpoint, { cache: 'no-store' });
    if (!resp.ok) throw new Error('Failed to fetch release data (' + resp.status + ')');

    var data = await resp.json();
    if (!data || data.found !== true) throw new Error('No release data available.');

    var version = data.version || '';
    var assets = data.assets || [];

    if (version) {
      qs('versionBadge').textContent = 'v' + version + ' \u2014 Latest release';
    } else {
      qs('versionBadge').textContent = data.message || 'No releases yet';
    }

    if (assets.length > 0) {
      populateCards(assets, version);
      setupPrimaryCta(assets, version);
      showReleaseNotes(data);
    } else {
      qs('primaryCta').style.display = 'none';
      qs('primaryMeta').textContent = data.message || 'No downloads available yet. Check back soon.';
      setAllUnavailable('Coming soon');
    }

  } catch (err) {
    qs('versionBadge').textContent = 'Release data unavailable';
    showNotice(err && err.message ? err.message : 'Failed to load release data.', { isError: true });
    setAllUnavailable('Unavailable');
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

export function buildSsoStartUrl(authBaseUrl, { redirectUri = 'nebula://auth', state } = {}) {
  const base = (authBaseUrl || '').toString().replace(/\/+$/, '');
  if (!base) throw new Error('Missing auth URL');
  const ssoState = (state || (crypto?.randomUUID?.() || String(Date.now()))).toString();
  const url = `${base}/auth/sso/start?redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(ssoState)}`;
  return { url, state: ssoState };
}

export async function openExternalUrl(url) {
  const target = (url || '').toString();
  if (!target) throw new Error('Missing URL');

  if (window?.electronAPI?.openExternal) {
    const res = await window.electronAPI.openExternal(target);
    if (res && res.ok === false) throw new Error(res.error || 'Failed to open URL');
    return;
  }

  const w = window.open(target, '_blank', 'noopener,noreferrer');
  if (!w) throw new Error('Popup blocked');
}

export async function startSsoLogin(authBaseUrl, { redirectUri = 'nebula://auth' } = {}) {
  const { url, state } = buildSsoStartUrl(authBaseUrl, { redirectUri });
  try {
    sessionStorage.setItem('nebula_sso_state', state);
  } catch (_) {}
  await openExternalUrl(url);
  return { state, url };
}


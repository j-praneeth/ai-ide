import { buildSsoStartUrl } from './sso';

test('buildSsoStartUrl builds start URL and strips trailing slash', () => {
  const { url, state } = buildSsoStartUrl('https://nebula-ide-server.up.railway.app/', {
    redirectUri: 'nebula://auth',
    state: 'state123',
  });

  expect(state).toBe('state123');
  expect(url).toBe(
    'https://nebula-ide-server.up.railway.app/auth/sso/start?redirect_uri=nebula%3A%2F%2Fauth&state=state123',
  );
});

test('buildSsoStartUrl throws on missing auth URL', () => {
  expect(() => buildSsoStartUrl('')).toThrow(/Missing auth URL/i);
});

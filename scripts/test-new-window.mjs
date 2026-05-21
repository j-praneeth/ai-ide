/**
 * Smoke-test for the two multi-window bugs fixed in main.js.
 *
 * Strategy: start the React dev server, then launch Electron (dev mode).
 * Skips the splash and DevTools windows; waits for the real React window.
 */

import { _electron as electron } from 'playwright-core';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let app;
let devServer;
let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}`); failed++; }
}

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

function waitForPort(port, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const req = http.get(`http://localhost:${port}`, res => { res.destroy(); resolve(); });
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) return reject(new Error(`Port ${port} not ready`));
        setTimeout(check, 400);
      });
      req.setTimeout(500, () => { req.destroy(); });
    };
    check();
  });
}

/** Return the first window that has electronAPI (skips splash + DevTools). */
async function waitForReactWindow(app, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const win of app.windows()) {
      const url = win.url();
      if (url.startsWith('devtools://') || url.startsWith('data:')) continue;
      try {
        const hasApi = await win.evaluate(() => !!window.electronAPI).catch(() => false);
        if (hasApi) return win;
      } catch (_) {}
    }
    await wait(400);
  }
  throw new Error('Timed out waiting for React window with electronAPI');
}

try {
  // ── 1. Start the React dev server ────────────────────────────────
  console.log('\n── Starting React dev server on :3000 ───────────────────────────');
  devServer = spawn('npm', ['run', 'start:frontend'], {
    cwd: ROOT,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, BROWSER: 'none', CI: 'false' },
  });
  devServer.stdout.on('data', d => {
    const txt = d.toString().trim();
    if (txt) console.log('[react]', txt.slice(0, 120));
  });
  devServer.stderr.on('data', d => {
    const txt = d.toString().trim();
    if (txt && !txt.includes('DeprecationWarning')) console.log('[react-err]', txt.slice(0, 120));
  });

  console.log('  Waiting for :3000...');
  await waitForPort(3000, 60000);
  console.log('  React dev server ready.');

  // ── 2. Launch Electron ─────────────────────────────────────────────
  console.log('\n── Launching Electron (dev mode) ────────────────────────────────');
  app = await electron.launch({
    executablePath: path.join(ROOT, 'node_modules', '.bin', 'electron'),
    args: [ROOT],
    env: { ...process.env, ELECTRON_DEV: 'true', NODE_ENV: 'development' },
    timeout: 30000,
  });
  app.on('console', msg => {
    const t = msg.text();
    if (t.includes('[workspace]') || t.includes('error') || t.includes('window')) {
      console.log('[main]', t.slice(0, 160));
    }
  });

  // ── 3. Wait for the React app window ──────────────────────────────
  console.log('  Waiting for React window with electronAPI...');
  const mainWin = await waitForReactWindow(app, 25000);
  await wait(2000); // let React hydrate

  const mainTitle = await mainWin.title();
  console.log(`\n  Window 1 title: "${mainTitle}"`);

  const ws1 = await mainWin.evaluate(() => window.electronAPI.getCurrentWorkspace()).catch(() => null);
  console.log(`  Window 1 workspace: ${JSON.stringify(ws1)}`);

  // ── 4. Open a New Window ──────────────────────────────────────────
  console.log('\n── Opening new window via File > New Window ─────────────────────');
  await mainWin.evaluate(() => window.electronAPI.openNewWindow());
  await wait(5000);

  const nonSplash = app.windows().filter(w =>
    !w.url().startsWith('data:') && !w.url().startsWith('devtools://'),
  );
  console.log(`  App windows (non-splash/devtools): ${nonSplash.length}`);
  assert(nonSplash.length >= 2, 'Second window opened');

  if (nonSplash.length >= 2) {
    const win2 = nonSplash.find(w => w !== mainWin) || nonSplash[nonSplash.length - 1];

    // Wait for win2's electronAPI
    const hasApi2 = await (async () => {
      for (let i = 0; i < 10; i++) {
        const ok = await win2.evaluate(() => !!window.electronAPI).catch(() => false);
        if (ok) return true;
        await wait(500);
      }
      return false;
    })();
    console.log(`  Window 2 electronAPI: ${hasApi2}`);

    const win2Title = await win2.title().catch(() => '');
    console.log(`  Window 2 title: "${win2Title}"`);

    // Bug 2: Window 2 must NOT inherit Window 1's project name
    const w1Name = ws1?.name || '';
    if (w1Name) {
      assert(!win2Title.includes(w1Name), `Bug 2: W2 title doesn't contain W1's project "${w1Name}"`);
    }
    assert(
      win2Title === 'Nebula IDE' || win2Title === '',
      `Bug 2: W2 shows default title (got "${win2Title}")`,
    );

    // Bug 1: Window 2 workspace must be empty
    const ws2 = await win2.evaluate(() => window.electronAPI?.getCurrentWorkspace?.()).catch(() => null);
    console.log(`  Window 2 workspace: ${JSON.stringify(ws2)}`);
    assert(!ws2?.path, 'Bug 1: Window 2 has no project path (fresh window)');
    assert(!ws2?.open, 'Bug 1: Window 2 workspace.open is false');

    // ── 5. Change folder in W1 — W2 must stay unchanged ──────────────
    console.log('\n── Changing folder in W1, verifying W2 is unaffected ───────────');
    const electronDir = path.join(ROOT, 'frontend');
    const w2TitleBefore = win2Title;
    const ws2Before = ws2?.path || '';

    const setRes = await mainWin.evaluate(
      async folder => window.electronAPI?.setProjectRoot?.(folder),
      electronDir,
    ).catch(e => ({ error: e.message }));
    console.log(`  setProjectRoot result: ${JSON.stringify(setRes)}`);
    await wait(1000);

    const ws1After = await mainWin.evaluate(() => window.electronAPI?.getCurrentWorkspace?.()).catch(() => null);
    const w2TitleAfter = await win2.title().catch(() => w2TitleBefore);
    const ws2After = await win2.evaluate(() => window.electronAPI?.getCurrentWorkspace?.()).catch(() => ws2);

    console.log(`  W1 workspace after folder change: ${JSON.stringify(ws1After)}`);
    console.log(`  W2 title after W1 folder change: "${w2TitleAfter}"  (was: "${w2TitleBefore}")`);
    console.log(`  W2 workspace after: ${JSON.stringify(ws2After)}`);

    assert(ws1After?.path?.includes('frontend'), 'W1 workspace updated to new folder');
    assert(w2TitleBefore === w2TitleAfter, 'Bug 2: W2 title unchanged when W1 changes folder');
    assert((ws2After?.path || '') === ws2Before, 'Bug 2: W2 workspace unchanged when W1 changes folder');
  }

} catch (err) {
  console.error('\nFatal:', err.message);
  failed++;
} finally {
  if (app) await app.close().catch(() => {});
  if (devServer) { devServer.kill('SIGTERM'); }
  console.log(`\n── ${passed} passed, ${failed} failed ─────────────────────────────`);
  process.exit(failed > 0 ? 1 : 0);
}

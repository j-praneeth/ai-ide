#!/usr/bin/env node
// Wrapper that:
//   1. embeds NEBULA_CLI_KEK halves into electron/cli-bundle.js + preload.js
//   2. runs electron-builder with the forwarded platform flags
//   3. ALWAYS restores the placeholders afterward (even on failure / signal)
//   4. exits with electron-builder's status code
//
// This avoids fragile shell quoting in npm scripts on Windows cmd.

import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');

function run(cmd, args, opts = {}) {
  // Default to shell:false. Using shell:true on Windows mangles paths with
  // spaces (e.g. process.execPath = "C:\Program Files\nodejs\node.exe"),
  // because cmd.exe splits the unquoted path on the first space.
  // Only callers that genuinely need shell resolution (e.g. invoking
  // npx.cmd) should opt in via opts.shell.
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: REPO_ROOT, shell: false, ...opts });
  return r.status ?? 1;
}

function preflight() {
  // Without these the installer would ship with placeholder zeros / no bundle,
  // and every user would see a login prompt instead of inheriting the master
  // account. Fail loudly before electron-builder runs.
  const errors = [];

  const kek = (process.env.NEBULA_CLI_KEK || '').trim();
  if (!/^[0-9a-fA-F]{64}$/.test(kek)) {
    errors.push('NEBULA_CLI_KEK is not set to 64 hex chars. Set it on the build machine before running this script.');
  }

  const enc = path.join(REPO_ROOT, 'build', 'creds.bundle.enc');
  const meta = path.join(REPO_ROOT, 'build', 'creds.bundle.meta.json');
  if (!fs.existsSync(enc) || !fs.existsSync(meta)) {
    errors.push(`Credential bundle missing at build/. Run "npm run build:vault" first (logged in with the master Claude/Codex account).`);
  } else {
    try {
      const st = fs.statSync(enc);
      if (st.size < 32) errors.push(`build/creds.bundle.enc is suspiciously small (${st.size} bytes).`);
    } catch (_) {}
  }

  if (errors.length) {
    process.stderr.write(`[build-with-kek] preflight failed:\n  - ${errors.join('\n  - ')}\n`);
    process.exit(2);
  }
}

function restore() {
  const code = run(process.execPath, ['scripts/embed-kek.mjs', 'restore']);
  if (code !== 0) {
    process.stderr.write(`[build-with-kek] WARNING: restore exited ${code}; check working tree before committing.\n`);
  }
}

async function main() {
  preflight();

  const ebArgs = process.argv.slice(2);

  // 1. embed
  const embedCode = run(process.execPath, ['scripts/embed-kek.mjs', 'embed']);
  if (embedCode !== 0) {
    process.stderr.write(`[build-with-kek] embed failed (${embedCode}); aborting.\n`);
    process.exit(embedCode);
  }

  // Always restore on any exit path.
  let restored = false;
  const safeRestore = () => { if (restored) return; restored = true; restore(); };
  process.on('exit', safeRestore);
  process.on('SIGINT',  () => { safeRestore(); process.exit(130); });
  process.on('SIGTERM', () => { safeRestore(); process.exit(143); });

  // 2. run electron-builder
  const builder = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const child = spawn(builder, ['electron-builder', ...ebArgs], { stdio: 'inherit', cwd: REPO_ROOT, shell: process.platform === 'win32' });
  const status = await new Promise((resolve) => {
    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', (err) => { process.stderr.write(`[build-with-kek] spawn error: ${err.message}\n`); resolve(1); });
  });

  // 3. restore via the 'exit' handler above; just exit with the right code.
  process.exit(status);
}

main().catch((e) => {
  process.stderr.write(`[build-with-kek] fatal: ${e?.stack || e}\n`);
  process.exit(1);
});

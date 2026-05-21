#!/usr/bin/env node
// Build-time tool that splits NEBULA_CLI_KEK into two halves and embeds each
// into a different Electron module. Restore mode reverts to placeholders so
// the real key never lands in a committed file.
//
// Usage:
//   node scripts/embed-kek.mjs embed     # before electron-builder
//   node scripts/embed-kek.mjs restore   # after electron-builder (always run, even on failure)
//
// Layout:
//   electron/cli-bundle.js  contains   const _a = '__NEBULA_KEK_PART_A__';
//   electron/preload.js     contains   const _b = '__NEBULA_KEK_PART_B__';
// Both placeholders are 32-hex-char strings ('0' * 32 by default) so the
// modules parse + run correctly during dev (decryption obviously fails then).

import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');

const PLACEHOLDER_A = '__NEBULA_KEK_PART_A__';
const PLACEHOLDER_B = '__NEBULA_KEK_PART_B__';
const PLACEHOLDER_DEFAULT = '0'.repeat(32);

const TARGETS = [
  { file: path.join(REPO_ROOT, 'electron', 'cli-bundle.js'), placeholder: PLACEHOLDER_A, half: 'a' },
  { file: path.join(REPO_ROOT, 'electron', 'preload.js'),    placeholder: PLACEHOLDER_B, half: 'b' },
];

function die(msg) {
  process.stderr.write(`[embed-kek] ${msg}\n`);
  process.exit(2);
}

function readFile(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch (e) { die(`cannot read ${p}: ${e.message}`); }
}

function writeFile(p, s) {
  fs.writeFileSync(p, s, 'utf8');
}

function readKek() {
  // 1. Environment variable (explicit — highest priority)
  const envVal = (process.env.NEBULA_CLI_KEK || '').trim();
  if (envVal) return envVal;

  // 2. backend/.env (source of truth for this project)
  const dotEnvPaths = [
    path.join(REPO_ROOT, 'backend', '.env'),
    path.join(REPO_ROOT, '.env'),
    path.join(REPO_ROOT, 'frontend', '.env'),
  ];
  for (const p of dotEnvPaths) {
    try {
      const raw = fs.readFileSync(p, 'utf8');
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim();
        if (key === 'NEBULA_CLI_KEK' && val) return val;
      }
    } catch (_) {}
  }

  die('NEBULA_CLI_KEK not found. Set it as an env var or add it to backend/.env.');
}

function embed() {
  const kek = readKek();
  if (!/^[0-9a-fA-F]{64}$/.test(kek)) die('NEBULA_CLI_KEK must be 64 hex chars (32 bytes).');

  const partA = kek.slice(0, 32);
  const partB = kek.slice(32);

  for (const t of TARGETS) {
    const src = readFile(t.file);
    const value = t.half === 'a' ? partA : partB;
    if (!src.includes(t.placeholder) && !src.includes(PLACEHOLDER_DEFAULT)) {
      die(`${t.file}: neither placeholder nor default constant found — file may already be embedded or modified.`);
    }
    let out = src;
    if (out.includes(t.placeholder)) {
      out = out.split(t.placeholder).join(value);
    } else {
      // Replace exactly one default-zeros occurrence inside a string literal next to the comment marker.
      // We use a contextual replace to avoid hitting unrelated zero strings.
      out = out.replace(`'${PLACEHOLDER_DEFAULT}'`, `'${value}'`);
    }
    writeFile(t.file, out);
    process.stdout.write(`[embed-kek] embedded part ${t.half.toUpperCase()} into ${path.relative(REPO_ROOT, t.file)}\n`);
  }

  // Post-embed verification: the exact value must now be present, and the
  // default zeros must NOT appear adjacent to the marker. If either check
  // fails, abort so we never ship an installer with a non-decryptable bundle.
  for (const t of TARGETS) {
    const src = readFile(t.file);
    const value = t.half === 'a' ? partA : partB;
    const re = new RegExp(`'([0-9a-fA-F]{32})'\\s*\\/\\*\\s*NEBULA_KEK_PART_${t.half.toUpperCase()}\\s*\\*\\/`);
    const m = src.match(re);
    if (!m) die(`${t.file}: post-embed verify could not find marker for part ${t.half.toUpperCase()} — check the placeholder comment was not removed.`);
    if (m[1].toLowerCase() !== value.toLowerCase()) die(`${t.file}: post-embed verify mismatch for part ${t.half.toUpperCase()}.`);
    if (m[1] === PLACEHOLDER_DEFAULT) die(`${t.file}: post-embed verify still shows zero placeholder for part ${t.half.toUpperCase()} — embed failed.`);
  }
  process.stdout.write('[embed-kek] post-embed verify passed for both halves\n');
}

function restore() {
  for (const t of TARGETS) {
    const src = readFile(t.file);
    // Look for a string literal of exactly 32 hex chars right before the marker
    // comment ` /* NEBULA_KEK_PART_<X> */`. If we placed the placeholder via embed(),
    // it will have been replaced; we restore the default zeros constant.
    const re = new RegExp(`'([0-9a-fA-F]{32})'(\\s*\\/\\*\\s*NEBULA_KEK_PART_${t.half.toUpperCase()}\\s*\\*\\/)`);
    const m = src.match(re);
    if (!m) {
      // Already restored or never embedded — make idempotent.
      process.stdout.write(`[embed-kek] no embedded part ${t.half.toUpperCase()} found in ${path.relative(REPO_ROOT, t.file)} (skipping)\n`);
      continue;
    }
    const out = src.replace(re, `'${PLACEHOLDER_DEFAULT}'$2`);
    writeFile(t.file, out);
    process.stdout.write(`[embed-kek] restored part ${t.half.toUpperCase()} placeholder in ${path.relative(REPO_ROOT, t.file)}\n`);
  }
}

function main() {
  const cmd = process.argv[2];
  if (cmd === 'embed') return embed();
  if (cmd === 'restore') return restore();
  die('usage: embed-kek.mjs embed|restore');
}

main();

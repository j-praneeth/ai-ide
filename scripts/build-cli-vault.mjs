#!/usr/bin/env node
// Reads the master-account Claude/Codex creds from the build machine,
// wraps + encrypts them with K_build (HKDF), writes:
//   build/creds.bundle.enc        encrypted bundle
//   build/creds.bundle.meta.json  non-secret meta (sha + iv + version)
//
// Usage:
//   NEBULA_CLI_KEK=<64-hex> node scripts/build-cli-vault.mjs
//
// The KEK never lands in any committed file. Set it via CI secret or shell env
// on the build operator's machine. See .env.build.example.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const BUILD_DIR = path.join(REPO_ROOT, 'build');
const PKG_PATH = path.join(REPO_ROOT, 'package.json');

const SCHEMA_VERSION = 1;
const HKDF_INFO_BUILD = Buffer.from('build', 'utf8');
const HKDF_SALT_BUILD = Buffer.from('nebula-cli-bundle-v1', 'utf8');

// Required-key manifests are resolved at build time based on what's actually
// in the master account's credential files. The unpacker validates against
// whatever the build script picks. This keeps us forward-compatible if
// Anthropic / OpenAI rename or rearrange auth fields.
const REQUIRED_KEYS = {
  'claude.credentials_json': null, // resolved at build time
  'codex.auth_json': null,         // resolved at build time
};

function die(code, msg) {
  process.stderr.write(`[build-cli-vault] ${msg}\n`);
  process.exit(code);
}

function readKek() {
  const raw = (process.env.NEBULA_CLI_KEK || '').trim();
  if (!raw) die(2, 'NEBULA_CLI_KEK env var is required (32-byte hex). See .env.build.example.');
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) die(2, 'NEBULA_CLI_KEK must be 64 hex chars (32 bytes).');
  return Buffer.from(raw, 'hex');
}

function readJsonIfExists(p) {
  try {
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, 'utf8');
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch (e) {
    die(3, `Failed to read JSON at ${p}: ${e.message}`);
  }
}

function readTextIfExists(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return fs.readFileSync(p, 'utf8');
  } catch (e) {
    die(3, `Failed to read text at ${p}: ${e.message}`);
  }
}

function detectClaudeRequiredKeys(credentials) {
  if (!credentials || typeof credentials !== 'object') {
    die(4, '~/.claude/.credentials.json is missing or not an object — log in on the build machine first.');
  }
  if (credentials.claudeAiOauth && typeof credentials.claudeAiOauth === 'object') {
    return ['claudeAiOauth'];
  }
  if (typeof credentials.primaryApiKey === 'string' && credentials.primaryApiKey.length > 0) {
    return ['primaryApiKey'];
  }
  die(4, '~/.claude/.credentials.json contains neither claudeAiOauth nor primaryApiKey — re-run claude login on the build machine.');
}

function detectCodexRequiredKeys(auth) {
  if (!auth || typeof auth !== 'object') {
    die(4, '~/.codex/auth.json is missing or not an object — log in on the build machine first.');
  }
  // Codex CLI may use any of: OPENAI_API_KEY (env-style), tokens.{access_token,...} (OAuth), or apiKey.
  // Pick whichever non-empty fields are present so the unpacker validates against actual content.
  const candidates = [
    'OPENAI_API_KEY', 'openai_api_key',
    'tokens', 'access_token', 'refresh_token',
    'apiKey', 'api_key',
  ];
  const present = candidates.filter((k) => auth[k] != null && auth[k] !== '');
  if (present.length === 0) {
    die(4, '~/.codex/auth.json contains no recognizable auth field — re-run codex login on the build machine.');
  }
  return present;
}

function validateBundle(envelope) {
  if (envelope.schema_version !== SCHEMA_VERSION) die(5, 'schema mismatch');

  const claudeReq = envelope.required_keys['claude.credentials_json'];
  for (const k of claudeReq) {
    if (envelope.claude.credentials_json[k] == null) {
      die(5, `claude.credentials_json missing required key: ${k}`);
    }
  }
  const codexReq = envelope.required_keys['codex.auth_json'];
  for (const k of codexReq) {
    if (envelope.codex.auth_json[k] == null) {
      die(5, `codex.auth_json missing required key: ${k}`);
    }
  }
}

function aesGcmEncrypt(key, plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: ciphertext || authTag(16). IV stored separately in meta.
  return { iv, payload: Buffer.concat([ct, tag]) };
}

function deriveKBuild(kek) {
  return crypto.hkdfSync('sha256', kek, HKDF_SALT_BUILD, HKDF_INFO_BUILD, 32);
}

function main() {
  const kek = readKek();
  const home = os.homedir();
  const claudeDir = path.join(home, '.claude');
  const codexDir = path.join(home, '.codex');

  const claudeCreds = readJsonIfExists(path.join(claudeDir, '.credentials.json'));
  const claudeSettings = readJsonIfExists(path.join(claudeDir, 'settings.json')) || {};
  // Claude Code stores onboarding/user state in ~/.claude.json (in the home
  // dir, NOT in ~/.claude/). Without this file, the CLI re-runs the login
  // flow even when ~/.claude/.credentials.json is valid.
  const claudeHomeJson = readJsonIfExists(path.join(home, '.claude.json')) || null;
  const codexAuth = readJsonIfExists(path.join(codexDir, 'auth.json'));
  const codexConfigToml = readTextIfExists(path.join(codexDir, 'config.toml')) || '';

  if (!claudeCreds) die(4, `~/.claude/.credentials.json not found — log in with the master account first.`);
  if (!codexAuth) die(4, `~/.codex/auth.json not found — log in with the master account first.`);
  if (!claudeHomeJson) {
    process.stderr.write(`[build-cli-vault] WARNING: ~/.claude.json not found on build machine. Generating a minimal one to suppress the login flow on target machines.\n`);
    claudeHomeJson = { hasCompletedOnboarding: true, onboardingComplete: true };
  }

  // Resolve required keys based on what's actually in the file.
  REQUIRED_KEYS['claude.credentials_json'] = detectClaudeRequiredKeys(claudeCreds);
  REQUIRED_KEYS['codex.auth_json'] = detectCodexRequiredKeys(codexAuth);

  const pkg = readJsonIfExists(PKG_PATH) || {};
  const nebulaVersion = pkg.version || '0.0.0';

  const envelope = {
    schema_version: SCHEMA_VERSION,
    bundled_at: new Date().toISOString(),
    nebula_version: nebulaVersion,
    claude_cli_version_seen: claudeSettings.cliVersion || claudeCreds.version || null,
    codex_cli_version_seen: codexAuth.version || null,
    claude: {
      credentials_json: claudeCreds,
      settings_json: claudeSettings,
      // home_json may be null on a brand-new build machine that has never
      // launched Claude Code; the unpacker tolerates that and skips writing.
      home_json: claudeHomeJson,
    },
    codex: {
      auth_json: codexAuth,
      config_toml: codexConfigToml,
    },
    required_keys: { ...REQUIRED_KEYS },
  };

  validateBundle(envelope);

  const kBuild = Buffer.from(deriveKBuild(kek));
  const plaintext = Buffer.from(JSON.stringify(envelope), 'utf8');
  const { iv, payload } = aesGcmEncrypt(kBuild, plaintext);
  kBuild.fill(0); // best-effort wipe

  fs.mkdirSync(BUILD_DIR, { recursive: true });
  const encPath = path.join(BUILD_DIR, 'creds.bundle.enc');
  const metaPath = path.join(BUILD_DIR, 'creds.bundle.meta.json');

  fs.writeFileSync(encPath, payload);
  const bundleSha = crypto.createHash('sha256').update(payload).digest('hex');

  const meta = {
    schema_version: SCHEMA_VERSION,
    bundleSha,
    iv: iv.toString('base64'),
    bundled_at: envelope.bundled_at,
    nebula_version: nebulaVersion,
    required_keys: envelope.required_keys,
  };
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

  process.stdout.write(`[build-cli-vault] wrote ${encPath} (${payload.length} bytes, sha256=${bundleSha.slice(0, 16)}…)\n`);
  process.stdout.write(`[build-cli-vault] wrote ${metaPath}\n`);
}

main();

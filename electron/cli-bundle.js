// Nebula CLI auth bundle: decrypts the shipped credential bundle (encrypted at
// build time with K_build) and writes ~/.claude and ~/.codex on first run.
// On subsequent runs, prefers a per-machine re-wrapped local copy.
//
// Threat model (keep this honest, see plan): the encryption is reversible by
// any motivated user with a debugger. It only defends against casual file
// browsing, screenshots, support uploads, and grep over installer images.
//
// Lifecycle is documented in the approved plan
// (~/.claude/plans/we-want-to-design-buzzing-hanrahan.md).

'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');

// ── Key material (placeholder; replaced by scripts/embed-kek.mjs at build time) ──
//
// _a holds the first half (16 bytes / 32 hex chars) of the build IKM.
// _b holds the second half — kept in electron/preload.js so a binary string
// dump won't surface a single 64-char key constant adjacent to the decrypt
// code. It's loaded lazily so this module can be required in dev without
// preload.js being importable in every context.
const _a = 'f7a3254fa722910e976fa56b72b18458' /* NEBULA_KEK_PART_A */;

function getPartB() {
  try {
    // Lazy require: preload.js exports `_b` from module.exports.
    // Renderer-only Electron code in preload.js is guarded so this require is safe in main.
    const preload = require('./preload');
    if (preload && typeof preload._b === 'string' && /^[0-9a-fA-F]{32}$/.test(preload._b)) {
      return preload._b;
    }
  } catch (_) {}
  return '00000000000000000000000000000000';
}

// ── Constants ───────────────────────────────────────────────────────────────
const SCHEMA_VERSION = 1;
const HKDF_SALT_BUILD_PREFIX = 'nebula-cli-bundle-v1';
const SHIPPED_BUNDLE_RESOURCE_DIR = 'cli-vault'; // matches package.json extraResources `to`
const LOCK_BACKOFF_MAX_MS = 5 * 60 * 1000; // 5 minutes
const LOCK_STUCK_MS = 30 * 60 * 1000; // 30 minutes
const LOG_ROTATE_BYTES = 1024 * 1024; // 1 MB

const ERR = Object.freeze({
  LOCK_BUSY: 'BUNDLE_LOCK_BUSY',
  LOCK_STUCK: 'BUNDLE_LOCK_STUCK',
  LOCK_FORCE_OVERRIDE: 'BUNDLE_LOCK_FORCE_OVERRIDE',
  META_MISSING: 'BUNDLE_META_MISSING',
  SCHEMA_UNSUPPORTED: 'BUNDLE_SCHEMA_UNSUPPORTED',
  CORRUPT: 'BUNDLE_CORRUPT',
  AUTH_FAIL: 'BUNDLE_AUTH_FAIL',
  VALIDATION_FAIL: 'BUNDLE_VALIDATION_FAIL',
  WRITE_FAIL: 'BUNDLE_WRITE_FAIL',
  WRITE_RENAME_FAIL: 'BUNDLE_WRITE_RENAME_FAIL',
  VERIFY_FAIL: 'BUNDLE_VERIFY_FAIL',
  ACL_TIGHTEN_FAIL: 'BUNDLE_ACL_TIGHTEN_FAIL',
  LOCAL_CORRUPT: 'BUNDLE_LOCAL_CORRUPT',
  LOCAL_AUTH_FAIL: 'BUNDLE_LOCAL_AUTH_FAIL',
  LOCAL_SCHEMA_FAIL: 'BUNDLE_LOCAL_SCHEMA_FAIL',
  MACHINE_ID_CHANGED: 'BUNDLE_MACHINE_ID_CHANGED',
  SYSTEM_CONTEXT: 'BUNDLE_SYSTEM_CONTEXT_REFUSED',
});

class BundleError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

// ── Paths (all derived from the Electron `app` passed at init) ──────────────
let _ctx = null;

function init(app) {
  if (_ctx) return _ctx;
  const userData = app.getPath('userData');
  const home = app.getPath('home');
  _ctx = {
    appName: app.getName ? app.getName() : 'NebulaIDE',
    appVersion: app.getVersion ? app.getVersion() : '0.0.0',
    userData,
    home,
    logPath: path.join(userData, 'logs', 'cli-bundle.log'),
    machineIdCachePath: path.join(userData, 'machine-id.cache'),
    lockPath: path.join(userData, 'cli-bundle.lock'),
    markerPath: path.join(userData, 'cli-bundle-installed.json'),
    localEncPath: path.join(userData, 'creds.bundle.local.enc'),
    localMetaPath: path.join(userData, 'creds.bundle.local.meta.json'),
    claudeDir: path.join(home, '.claude'),
    codexDir: path.join(home, '.codex'),
    files: {
      claudeCreds: path.join(home, '.claude', '.credentials.json'),
      claudeSettings: path.join(home, '.claude', 'settings.json'),
      // ~/.claude.json (in home, NOT in ~/.claude/) holds Claude Code's
      // onboarding state — without it the CLI re-prompts for login even
      // when .credentials.json is valid.
      claudeHomeJson: path.join(home, '.claude.json'),
      codexAuth: path.join(home, '.codex', 'auth.json'),
      codexConfig: path.join(home, '.codex', 'config.toml'),
    },
  };
  try { fs.mkdirSync(path.dirname(_ctx.logPath), { recursive: true }); } catch (_) {}
  return _ctx;
}

function ctx() {
  if (!_ctx) throw new Error('cli-bundle: init(app) must be called before use');
  return _ctx;
}

// ── Logger (structured, rotated, redacted) ─────────────────────────────────
let _lastError = null;

function rotateIfNeeded(p) {
  try {
    const st = fs.statSync(p);
    if (st.size > LOG_ROTATE_BYTES) {
      fs.renameSync(p, p + '.1');
    }
  } catch (_) { /* file may not exist yet */ }
}

function log(level, code, message, details) {
  const c = _ctx;
  if (!c) return;
  rotateIfNeeded(c.logPath);
  const entry = {
    ts: new Date().toISOString(),
    level,
    code: code || null,
    message: message || '',
    details: details || {},
    pid: process.pid,
  };
  try {
    fs.appendFileSync(c.logPath, JSON.stringify(entry) + '\n');
  } catch (_) {}
  if (level === 'error' || level === 'warn') {
    _lastError = { code, message, ts: entry.ts };
  }
}

const logInfo  = (code, msg, details) => log('info',  code, msg, details);
const logWarn  = (code, msg, details) => log('warn',  code, msg, details);
const logError = (code, msg, details) => log('error', code, msg, details);

// ── Machine ID ──────────────────────────────────────────────────────────────
let _machineIdCached = null;

async function readMachineIdFromOs() {
  if (process.platform === 'win32') {
    return await new Promise((resolve) => {
      execFile('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], { timeout: 4000 }, (err, stdout) => {
        if (err) return resolve(null);
        const m = (stdout || '').match(/MachineGuid\s+REG_SZ\s+([A-Fa-f0-9-]+)/);
        resolve(m ? m[1].trim() : null);
      });
    });
  }
  if (process.platform === 'darwin') {
    return await new Promise((resolve) => {
      execFile('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { timeout: 4000 }, (err, stdout) => {
        if (err) return resolve(null);
        const m = (stdout || '').match(/"IOPlatformUUID"\s*=\s*"([A-Fa-f0-9-]+)"/);
        resolve(m ? m[1].trim() : null);
      });
    });
  }
  // Linux + others
  try {
    const v = fs.readFileSync('/etc/machine-id', 'utf8').trim();
    if (v) return v;
  } catch (_) {}
  try {
    const v = fs.readFileSync('/var/lib/dbus/machine-id', 'utf8').trim();
    if (v) return v;
  } catch (_) {}
  return null;
}

async function getMachineId() {
  if (_machineIdCached) return _machineIdCached;
  const c = ctx();
  // Try cache first; trust but verify by re-reading the OS source on every boot.
  let cached = null;
  try { cached = fs.readFileSync(c.machineIdCachePath, 'utf8').trim(); } catch (_) {}

  let osValue = await readMachineIdFromOs();
  if (!osValue) {
    logWarn(null, 'machine-id source unavailable, falling back to hostname', { platform: process.platform });
    osValue = `hostname:${os.hostname()}`;
  }

  if (cached && cached !== osValue) {
    logWarn(null, 'machine-id changed since last cache', {});
  }
  try { fs.writeFileSync(c.machineIdCachePath, osValue); } catch (_) {}

  _machineIdCached = osValue;
  return osValue;
}

function machineIdFingerprint(machineId) {
  return crypto.createHash('sha256').update(machineId).digest('hex').slice(0, 16);
}

// ── Key derivation ──────────────────────────────────────────────────────────
function ikm() {
  const partA = _a;
  const partB = getPartB();
  if (!/^[0-9a-fA-F]{32}$/.test(partA) || !/^[0-9a-fA-F]{32}$/.test(partB)) {
    throw new BundleError('BUNDLE_META_MISSING', 'Key parts not embedded — running unbuilt code? Set NEBULA_CLI_KEK and run scripts/embed-kek.mjs embed.');
  }
  return Buffer.concat([Buffer.from(partA, 'hex'), Buffer.from(partB, 'hex')]);
}

function deriveKBuild() {
  const k = crypto.hkdfSync('sha256', ikm(), Buffer.from(HKDF_SALT_BUILD_PREFIX), Buffer.from('build'), 32);
  return Buffer.from(k);
}

function deriveKMachine(machineId) {
  const salt = crypto.createHash('sha256').update(`${HKDF_SALT_BUILD_PREFIX}|${machineId}`).digest();
  const k = crypto.hkdfSync('sha256', ikm(), salt, Buffer.from('machine'), 32);
  return Buffer.from(k);
}

// ── AES-256-GCM helpers ─────────────────────────────────────────────────────
// Format: payload = ciphertext || authTag(16). IV passed separately.
function aesGcmDecrypt(key, iv, payload) {
  if (payload.length < 16) throw new BundleError(ERR.AUTH_FAIL, 'payload too short');
  const ct = payload.subarray(0, payload.length - 16);
  const tag = payload.subarray(payload.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch (e) {
    throw new BundleError(ERR.AUTH_FAIL, 'AES-GCM auth tag failed', { cause: e.message });
  }
}

function aesGcmEncrypt(key, plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv, payload: Buffer.concat([ct, tag]) };
}

// ── Lock ────────────────────────────────────────────────────────────────────
function readLockSafe(p) {
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const obj = JSON.parse(raw);
    if (typeof obj.pid === 'number' && typeof obj.ts === 'number') return obj;
  } catch (_) {}
  return null;
}

function isPidAlive(pid) {
  if (!pid || pid === process.pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; } // EPERM = exists but we can't signal it
}

async function writeLockAtomic(p, payload) {
  const tmp = `${p}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  await fsp.writeFile(tmp, JSON.stringify(payload));
  await fsp.rename(tmp, p);
}

async function acquireLock({ override = false } = {}) {
  const c = ctx();
  const start = Date.now();
  let attempt = 0;
  while (true) {
    try {
      // Atomic create-and-write so readers never observe an empty lock file.
      const tmp = `${c.lockPath}.acq.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
      const payload = { pid: process.pid, hostname: os.hostname(), ts: Date.now() };
      fs.writeFileSync(tmp, JSON.stringify(payload));
      try {
        // 'wx'-equivalent semantics on rename: most platforms allow rename-over,
        // so we use link()+unlink() pattern: link is atomic and fails if dest exists.
        fs.linkSync(tmp, c.lockPath);
        fs.unlinkSync(tmp);
        return;
      } catch (linkErr) {
        try { fs.unlinkSync(tmp); } catch (_) {}
        if (linkErr.code !== 'EEXIST') {
          // Some filesystems don't support hardlinks (FAT/exFAT on some Windows installs).
          // Fallback: open exclusive, write, close.
          if (linkErr.code === 'EPERM' || linkErr.code === 'ENOSYS') {
            const fd = fs.openSync(c.lockPath, 'wx');
            try { fs.writeSync(fd, JSON.stringify(payload)); } finally { fs.closeSync(fd); }
            return;
          }
          throw linkErr;
        }
        // EEXIST → handle below
      }

      const existing = readLockSafe(c.lockPath);

      if (override) {
        logWarn(ERR.LOCK_FORCE_OVERRIDE, 'Force-overriding existing lock', { displaced: existing });
        await writeLockAtomic(c.lockPath, { pid: process.pid, hostname: os.hostname(), ts: Date.now() });
        return;
      }

      // Unparseable lock = freshly opened by another process between its create and write.
      // Don't reclaim; just wait.
      if (existing) {
        const sameHost = existing.hostname === os.hostname();
        const alive = sameHost && isPidAlive(existing.pid);
        const age = Date.now() - existing.ts;

        if ((!alive || !sameHost) && age > 5 * 60 * 1000) {
          logInfo(null, 'Reclaiming stale lock', { existing, age });
          await writeLockAtomic(c.lockPath, { pid: process.pid, hostname: os.hostname(), ts: Date.now() });
          return;
        }

        if (alive && age > LOCK_STUCK_MS) {
          throw new BundleError(ERR.LOCK_STUCK, 'Another instance has held the install lock too long', { existing });
        }
      }

      if ((Date.now() - start) > LOCK_BACKOFF_MAX_MS) {
        throw new BundleError(ERR.LOCK_BUSY, 'Timed out waiting for install lock', { existing });
      }
      attempt++;
      const delay = Math.min(2000, 100 * Math.pow(2, attempt));
      await new Promise((r) => setTimeout(r, delay));
    } catch (outer) {
      if (outer instanceof BundleError) throw outer;
      throw outer;
    }
  }
}

function releaseLock() {
  const c = ctx();
  try {
    const existing = readLockSafe(c.lockPath);
    if (!existing || existing.pid !== process.pid) return; // someone else owns it
    fs.unlinkSync(c.lockPath);
  } catch (_) {}
}

// ── Atomic file write with retry ────────────────────────────────────────────
async function atomicWrite(target, contents, mode) {
  const tmp = `${target}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  await fsp.writeFile(tmp, contents);
  try {
    const fd = await fsp.open(tmp, 'r+');
    try { await fd.sync(); } finally { await fd.close(); }
  } catch (_) {}

  try {
    await fsp.rename(tmp, target);
  } catch (e1) {
    // AV / indexer race — wait and retry once.
    await new Promise((r) => setTimeout(r, 250));
    try {
      await fsp.rename(tmp, target);
      logWarn(ERR.WRITE_RENAME_FAIL, 'rename retry succeeded', { target, code: e1.code });
    } catch (e2) {
      try { await fsp.unlink(tmp); } catch (_) {}
      logError(ERR.WRITE_RENAME_FAIL, 'rename failed twice', { target, code: e2.code });
      throw new BundleError(ERR.WRITE_FAIL, `rename failed for ${target}: ${e2.code || e2.message}`);
    }
  }

  if (mode != null && process.platform !== 'win32') {
    try { await fsp.chmod(target, mode); } catch (e) {
      logWarn(null, 'chmod failed', { target, code: e.code });
    }
  }
}

// ── Windows ACL tightening (best-effort, non-fatal) ─────────────────────────
function tightenWindowsAcl(target) {
  if (process.platform !== 'win32') return;
  // Refuse to write under SYSTEM context.
  let username = '';
  try { username = (os.userInfo().username || '').trim(); } catch (_) {}
  if (!username || username.toUpperCase() === 'SYSTEM' || username.toUpperCase() === 'LOCAL SERVICE' || username.toUpperCase() === 'NETWORK SERVICE') {
    logWarn(ERR.SYSTEM_CONTEXT, 'Refusing icacls under system account', { username });
    return;
  }
  const domain = (process.env.USERDOMAIN || '').trim();
  const principal = (domain && domain.toUpperCase() !== os.hostname().toUpperCase()) ? `${domain}\\${username}` : username;
  return new Promise((resolve) => {
    execFile('icacls', [target, '/inheritance:r', '/grant:r', `${principal}:F`], { timeout: 5000 }, (err, _stdout, stderr) => {
      if (err) {
        logWarn(ERR.ACL_TIGHTEN_FAIL, 'icacls failed', { target, principal, code: err.code, stderr: (stderr || '').slice(0, 500) });
      }
      resolve();
    });
  });
}

// ── Bundle envelope helpers ─────────────────────────────────────────────────
function getResourceBundlePaths() {
  // In packaged builds, electron-builder copies extraResources to process.resourcesPath.
  // In dev (npm start), resources live at <repo>/build/.
  const fromResources = process.resourcesPath
    ? path.join(process.resourcesPath, SHIPPED_BUNDLE_RESOURCE_DIR)
    : null;
  const fromDev = path.join(__dirname, '..', 'build');
  for (const dir of [fromResources, fromDev]) {
    if (!dir) continue;
    const enc = path.join(dir, 'creds.bundle.enc');
    const meta = path.join(dir, 'creds.bundle.meta.json');
    if (fs.existsSync(enc) && fs.existsSync(meta)) return { enc, meta };
  }
  throw new BundleError(ERR.META_MISSING, 'creds.bundle.{enc,meta.json} not found in resources or build/');
}

function loadShippedMeta() {
  const { meta } = getResourceBundlePaths();
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(meta, 'utf8')); }
  catch (e) { throw new BundleError(ERR.META_MISSING, `Cannot parse meta: ${e.message}`); }
  if (parsed.schema_version !== SCHEMA_VERSION) {
    throw new BundleError(ERR.SCHEMA_UNSUPPORTED, `Unsupported schema_version=${parsed.schema_version}`);
  }
  if (!parsed.bundleSha || !parsed.iv) {
    throw new BundleError(ERR.META_MISSING, 'Meta missing bundleSha or iv');
  }
  return parsed;
}

function loadShippedCiphertext(meta) {
  const { enc } = getResourceBundlePaths();
  const buf = fs.readFileSync(enc);
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  if (sha !== meta.bundleSha) {
    throw new BundleError(ERR.CORRUPT, 'Shipped bundle SHA mismatch');
  }
  return buf;
}

function decodeEnvelope(plaintext) {
  let envelope;
  try { envelope = JSON.parse(plaintext.toString('utf8')); }
  catch (e) { throw new BundleError(ERR.VALIDATION_FAIL, `Bundle JSON parse failed: ${e.message}`); }
  return envelope;
}

function validateEnvelope(envelope, errCode = ERR.VALIDATION_FAIL) {
  if (!envelope || envelope.schema_version !== SCHEMA_VERSION) {
    throw new BundleError(ERR.SCHEMA_UNSUPPORTED, `envelope schema_version=${envelope && envelope.schema_version}`);
  }
  if (!envelope.required_keys || typeof envelope.required_keys !== 'object') {
    throw new BundleError(errCode, 'missing required_keys manifest');
  }

  const claudeReq = envelope.required_keys['claude.credentials_json'];
  if (!Array.isArray(claudeReq) || claudeReq.length === 0) {
    throw new BundleError(errCode, 'no required keys declared for claude.credentials_json');
  }
  const claudeCreds = envelope.claude && envelope.claude.credentials_json;
  if (!claudeCreds || typeof claudeCreds !== 'object') {
    throw new BundleError(errCode, 'claude.credentials_json missing');
  }
  for (const k of claudeReq) {
    if (claudeCreds[k] == null) throw new BundleError(errCode, `claude.credentials_json missing required key: ${k}`);
  }
  // home_json is optional; if present it must be an object.
  if (envelope.claude && envelope.claude.home_json != null && typeof envelope.claude.home_json !== 'object') {
    throw new BundleError(errCode, 'claude.home_json present but not an object');
  }

  const codexReq = envelope.required_keys['codex.auth_json'];
  if (!Array.isArray(codexReq) || codexReq.length === 0) {
    throw new BundleError(errCode, 'no required keys declared for codex.auth_json');
  }
  const codexAuth = envelope.codex && envelope.codex.auth_json;
  if (!codexAuth || typeof codexAuth !== 'object') {
    throw new BundleError(errCode, 'codex.auth_json missing');
  }
  for (const k of codexReq) {
    if (codexAuth[k] == null) throw new BundleError(errCode, `codex.auth_json missing required key: ${k}`);
  }

  // Lenient on extras: log unknown top-level keys.
  const known = new Set(['schema_version', 'bundled_at', 'nebula_version', 'claude_cli_version_seen', 'codex_cli_version_seen', 'claude', 'codex', 'required_keys']);
  for (const k of Object.keys(envelope)) {
    if (!known.has(k)) logInfo(null, 'envelope: unknown top-level key', { key: k });
  }
}

// ── Install bundle to disk ─────────────────────────────────────────────────
function mergeClaudeSettings(bundleSettings, existingSettings) {
  // Default: full overwrite from bundle.
  // Exception: preserve user's apiKeyHelper if set (lets a user with a personal token override).
  const out = { ...(bundleSettings || {}) };
  if (existingSettings && typeof existingSettings.apiKeyHelper === 'string' && existingSettings.apiKeyHelper.trim()) {
    out.apiKeyHelper = existingSettings.apiKeyHelper;
  }
  return out;
}

function readJsonIfExists(p) {
  try {
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, 'utf8');
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch (_) { return null; }
}

async function installBundleToDisk(envelope) {
  const c = ctx();
  // Ensure parent dirs exist.
  for (const dir of [c.claudeDir, c.codexDir]) {
    try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch (e) {
      throw new BundleError(ERR.WRITE_FAIL, `mkdir ${dir} failed: ${e.code || e.message}`);
    }
  }

  // 1. ~/.claude/.credentials.json — full overwrite, mode 0600.
  const claudeCreds = JSON.stringify(envelope.claude.credentials_json, null, 2);
  await atomicWrite(c.files.claudeCreds, claudeCreds, 0o600);
  await tightenWindowsAcl(c.files.claudeCreds);

  // 2. ~/.claude/settings.json — merge: preserve apiKeyHelper.
  const existingSettings = readJsonIfExists(c.files.claudeSettings);
  const mergedSettings = mergeClaudeSettings(envelope.claude.settings_json, existingSettings);
  await atomicWrite(c.files.claudeSettings, JSON.stringify(mergedSettings, null, 2), 0o600);
  await tightenWindowsAcl(c.files.claudeSettings);

  // 2b. ~/.claude.json — Claude Code's onboarding/state file. Lives in $HOME
  // (not ~/.claude/). Without it the CLI re-prompts for login even when
  // .credentials.json is valid. Use the bundled value, or a minimal fallback
  // so the user never sees the onboarding/login flow.
  const homeJson = (envelope.claude && envelope.claude.home_json && typeof envelope.claude.home_json === 'object')
    ? envelope.claude.home_json
    : { hasCompletedOnboarding: true, onboardingComplete: true };
  await atomicWrite(c.files.claudeHomeJson, JSON.stringify(homeJson, null, 2), 0o600);
  await tightenWindowsAcl(c.files.claudeHomeJson);

  // 3. ~/.codex/auth.json — full overwrite.
  const codexAuth = JSON.stringify(envelope.codex.auth_json, null, 2);
  await atomicWrite(c.files.codexAuth, codexAuth, 0o600);
  await tightenWindowsAcl(c.files.codexAuth);

  // 4. ~/.codex/config.toml — full overwrite (TOML parsing skipped intentionally;
  // user preferences in this file persist across normal launches because the
  // marker check skips reinstall when the bundle hash hasn't changed).
  const codexConfig = typeof envelope.codex.config_toml === 'string' ? envelope.codex.config_toml : '';
  await atomicWrite(c.files.codexConfig, codexConfig, 0o600);
  await tightenWindowsAcl(c.files.codexConfig);
}

// ── Marker-based "already installed?" check ─────────────────────────────────
function readMarker() {
  const c = ctx();
  return readJsonIfExists(c.markerPath);
}

async function writeMarker(meta, envelope) {
  const c = ctx();
  const marker = {
    schema_version: SCHEMA_VERSION,
    bundleSha: meta.bundleSha,
    installed_at: new Date().toISOString(),
    nebula_version: meta.nebula_version || null,
    required_keys: envelope.required_keys,
    validated_files: Object.keys(c.files),
  };
  await atomicWrite(c.markerPath, JSON.stringify(marker, null, 2));
}

function fileLooksOk(p, requiredKeys, kind /* 'json' | 'toml' */) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile() || st.size === 0) return false;
    const raw = fs.readFileSync(p, 'utf8');
    if (!raw.trim()) return false;
    if (kind === 'json') {
      const parsed = JSON.parse(raw);
      if (Array.isArray(requiredKeys)) {
        for (const k of requiredKeys) if (parsed[k] == null) return false;
      }
    }
    // TOML kind: only verify non-empty (no parser dep).
    return true;
  } catch (_) {
    return false;
  }
}

function alreadyInstalled(meta) {
  const c = ctx();

  // ── Standard marker-based check ──
  const marker = readMarker();
  if (!marker) return false;
  if (marker.schema_version !== SCHEMA_VERSION) return false;
  if (marker.bundleSha !== meta.bundleSha) return false;

  const reqs = marker.required_keys || {};
  if (!fileLooksOk(c.files.claudeCreds, reqs['claude.credentials_json'], 'json')) return false;
  if (!fileLooksOk(c.files.claudeSettings, null, 'json')) return false;
  if (!fileLooksOk(c.files.codexAuth, reqs['codex.auth_json'], 'json')) return false;
  if (!fileLooksOk(c.files.codexConfig, null, 'toml')) return false;

  return true;
}

// ── Per-machine local bundle (re-wrap) ──────────────────────────────────────
function readLocalMeta() {
  const c = ctx();
  return readJsonIfExists(c.localMetaPath);
}

function deleteLocalBundle() {
  const c = ctx();
  for (const p of [c.localEncPath, c.localMetaPath]) {
    try { fs.unlinkSync(p); } catch (_) {}
  }
}

async function tryDecryptLocal(machineId) {
  const c = ctx();
  if (!fs.existsSync(c.localEncPath)) return null;
  const localMeta = readLocalMeta();
  if (!localMeta) {
    deleteLocalBundle();
    return null;
  }

  // Machine-id fingerprint check (explicit log line for support).
  const expected = machineIdFingerprint(machineId);
  if (localMeta.machine_id_fingerprint && localMeta.machine_id_fingerprint !== expected) {
    logWarn(ERR.MACHINE_ID_CHANGED, 'machine-id fingerprint changed', {
      old: localMeta.machine_id_fingerprint,
      new: expected,
    });
    deleteLocalBundle();
    return null;
  }

  // SHA check.
  const ct = fs.readFileSync(c.localEncPath);
  const sha = crypto.createHash('sha256').update(ct).digest('hex');
  if (sha !== localMeta.localBundleSha) {
    logError(ERR.LOCAL_CORRUPT, 'local bundle SHA mismatch', { expected: localMeta.localBundleSha, got: sha });
    deleteLocalBundle();
    return null;
  }

  // Decrypt + schema validate.
  let plaintext;
  try {
    const kMachine = deriveKMachine(machineId);
    try {
      plaintext = aesGcmDecrypt(kMachine, Buffer.from(localMeta.iv, 'base64'), ct);
    } finally {
      kMachine.fill(0);
    }
  } catch (e) {
    logError(ERR.LOCAL_AUTH_FAIL, 'local bundle decrypt failed', { cause: e.message });
    deleteLocalBundle();
    return null;
  }

  let envelope;
  try {
    envelope = decodeEnvelope(plaintext);
    validateEnvelope(envelope, ERR.LOCAL_SCHEMA_FAIL);
  } catch (e) {
    logError(e.code || ERR.LOCAL_SCHEMA_FAIL, 'local bundle validation failed', { cause: e.message });
    deleteLocalBundle();
    return null;
  }

  return { envelope, meta: localMeta };
}

async function writeLocalBundle(envelope, machineId, shippedMeta) {
  const c = ctx();
  const plaintext = Buffer.from(JSON.stringify(envelope), 'utf8');
  const kMachine = deriveKMachine(machineId);
  let payload, iv;
  try {
    ({ iv, payload } = aesGcmEncrypt(kMachine, plaintext));
  } finally {
    kMachine.fill(0);
  }
  await atomicWrite(c.localEncPath, payload, 0o600);
  const localMeta = {
    schema_version: SCHEMA_VERSION,
    localBundleSha: crypto.createHash('sha256').update(payload).digest('hex'),
    iv: iv.toString('base64'),
    written_at: new Date().toISOString(),
    machine_id_fingerprint: machineIdFingerprint(machineId),
    nebula_version: shippedMeta.nebula_version || null,
    shipped_bundle_sha: shippedMeta.bundleSha,
  };
  await atomicWrite(c.localMetaPath, JSON.stringify(localMeta, null, 2));
}

// ── Orchestration ──────────────────────────────────────────────────────────
async function _doInstall({ ignoreMarker = false, override = false } = {}) {
  const c = ctx();

  await acquireLock({ override });
  try {
    // 1. Load shipped meta + integrity-check ciphertext.
    const meta = loadShippedMeta();
    const shippedCt = loadShippedCiphertext(meta);

    // Discard stale marker so credentials are always written to disk.
    // Previously this had an early return when marker matched, which meant
    // existing ~/.claude/.credentials.json was never overwritten on reinstall.
    try { fs.unlinkSync(c.markerPath); } catch (_) {}

    // 2. Try local re-wrapped bundle first.
    const machineId = await getMachineId();
    let envelope = null;
    const local = await tryDecryptLocal(machineId);
    if (local && local.envelope.required_keys && local.meta.shipped_bundle_sha === meta.bundleSha) {
      envelope = local.envelope;
      logInfo(null, 'using local re-wrapped bundle', {});
    }

    if (!envelope) {
      // Shipped bundle SHA changed or local cache was invalid — discard stale local cache.
      deleteLocalBundle();

      // Decrypt shipped bundle with K_build.
      const kBuild = deriveKBuild();
      let plaintext;
      try {
        plaintext = aesGcmDecrypt(kBuild, Buffer.from(meta.iv, 'base64'), shippedCt);
      } finally {
        kBuild.fill(0);
      }
      envelope = decodeEnvelope(plaintext);
      validateEnvelope(envelope);
      // Re-wrap for next time.
      try { await writeLocalBundle(envelope, machineId, meta); }
      catch (e) { logWarn(null, 'local re-wrap failed (non-fatal)', { cause: e.message }); }
    }

    // 4. Install to disk + write marker.
    await installBundleToDisk(envelope);

    // 5. Post-write verify (parse-back).
    if (!fileLooksOk(c.files.claudeCreds, envelope.required_keys['claude.credentials_json'], 'json')) {
      throw new BundleError(ERR.VERIFY_FAIL, 'post-write verify: claude credentials_json invalid');
    }
    if (!fileLooksOk(c.files.codexAuth, envelope.required_keys['codex.auth_json'], 'json')) {
      throw new BundleError(ERR.VERIFY_FAIL, 'post-write verify: codex auth_json invalid');
    }

    await writeMarker(meta, envelope);
    logInfo(null, 'cli-bundle installed', { bundleSha: meta.bundleSha.slice(0, 16) });
    return { ok: true, status: 'installed', bundleSha: meta.bundleSha };
  } finally {
    releaseLock();
  }
}

async function ensureInstalled() {
  try {
    return await _doInstall({ ignoreMarker: false, override: false });
  } catch (e) {
    if (e instanceof BundleError) {
      logError(e.code, e.message, e.details);
      return { ok: false, errorCode: e.code, message: e.message };
    }
    logError(null, 'unexpected error in ensureInstalled', { cause: e.message, stack: e.stack });
    return { ok: false, errorCode: 'BUNDLE_UNKNOWN', message: e.message };
  }
}

async function forceReinstall(opts = {}) {
  const override = opts.override === true;
  try {
    return await _doInstall({ ignoreMarker: true, override });
  } catch (e) {
    if (e instanceof BundleError) {
      logError(e.code, e.message, e.details);
      return { ok: false, errorCode: e.code, message: e.message };
    }
    logError(null, 'unexpected error in forceReinstall', { cause: e.message, stack: e.stack });
    return { ok: false, errorCode: 'BUNDLE_UNKNOWN', message: e.message };
  }
}

function getStatus() {
  const c = _ctx;
  if (!c) return { ok: false, errorCode: 'BUNDLE_NOT_INITIALIZED' };
  let marker = null;
  try { marker = readMarker(); } catch (_) {}
  return {
    ok: true,
    marker,
    lastError: _lastError,
    files: {
      claudeCreds: fs.existsSync(c.files.claudeCreds),
      claudeSettings: fs.existsSync(c.files.claudeSettings),
      claudeHomeJson: fs.existsSync(c.files.claudeHomeJson),
      codexAuth: fs.existsSync(c.files.codexAuth),
      codexConfig: fs.existsSync(c.files.codexConfig),
    },
  };
}

// ── Credential freshness check ─────────────────────────────────────────────
// Reads ~/.claude/.credentials.json and reports how long until the access
// token expires.  The access token renews automatically via Claude CLI's
// built-in refresh — this is only for detecting when the refresh token itself
// may have been invalidated (credentials file not updated in >2 h after expiry).
function checkTokenFreshness() {
  const c = _ctx;
  if (!c) return { ok: false, reason: 'not-initialized' };

  try {
    const raw = fs.readFileSync(c.files.claudeCreds, 'utf8');
    const creds = JSON.parse(raw);
    const oauth = creds.claudeAiOauth || creds.oauth || creds;

    const expiresAt = oauth.expiresAt || oauth.expires_at || oauth.accessTokenExpiry;
    if (!expiresAt) return { ok: true, reason: 'no-expiry-field' };

    // Handle both millisecond and second timestamps
    const expiresMs = typeof expiresAt === 'number'
      ? (expiresAt > 1e12 ? expiresAt : expiresAt * 1000)
      : Date.now() + 3600000;

    const msLeft = expiresMs - Date.now();
    const hoursLeft = msLeft / 3600000;

    if (msLeft > 0) {
      // Access token still valid (Claude CLI refreshes it automatically)
      return { ok: true, reason: 'valid', hoursLeft: Math.round(hoursLeft * 10) / 10 };
    }

    // Access token expired — check if Claude CLI has refreshed it recently
    const stat = fs.statSync(c.files.claudeCreds);
    const hoursSinceModified = (Date.now() - stat.mtimeMs) / 3600000;

    if (hoursSinceModified < 2) {
      // File was updated recently — Claude CLI is actively refreshing
      return { ok: true, reason: 'recently-refreshed' };
    }

    // File is stale: access token expired AND not refreshed in >2 h
    // This likely means the refresh token itself may be invalid
    logWarn(null, 'Claude credential file stale — refresh token may be expired', {
      hoursSinceExpiry: Math.round(-hoursLeft * 10) / 10,
      hoursSinceModified: Math.round(hoursSinceModified * 10) / 10,
    });
    return {
      ok: false,
      reason: 'stale',
      hoursSinceExpiry: Math.round(-hoursLeft * 10) / 10,
      hoursSinceModified: Math.round(hoursSinceModified * 10) / 10,
      message: 'Claude credentials are stale. The refresh token may have expired. Claude will show a login prompt on next use.',
    };
  } catch (e) {
    return { ok: false, reason: 'read-error', message: e.message };
  }
}

// ── Access-token patch ─────────────────────────────────────────────────────
// Overwrites only the accessToken + expiresAt fields inside claudeAiOauth in the
// on-disk credentials file. Called by main.js after fetching a fresh token from
// the backend so Claude CLI always starts with a non-expired access token.
// Also works when the file doesn't exist yet (creates it from scratch).
function patchAccessToken(accessToken, expiresAtMs, refreshToken, extraFields) {
  const c = _ctx;
  if (!c) {
    console.warn('[cli-bundle:patchAccessToken] Not initialized');
    return false;
  }
  try {
    let creds;
    try {
      const raw = fs.readFileSync(c.files.claudeCreds, 'utf8');
      creds = JSON.parse(raw);
      console.log(`[cli-bundle:patchAccessToken] Read existing creds, has claudeAiOauth=${!!creds.claudeAiOauth}`);
    } catch (_) {
      creds = {};
      console.log('[cli-bundle:patchAccessToken] No existing creds, creating new.');
    }
    try { fs.mkdirSync(c.claudeDir, { recursive: true }); } catch (_) {}
    const oauthBase = { ...(extraFields || {}) };
    const tokenPreview = accessToken ? accessToken.slice(0, 8) + '...' : 'null';
    if (creds.claudeAiOauth && typeof creds.claudeAiOauth === 'object') {
      const hadRefresh = !!creds.claudeAiOauth.refreshToken;
      Object.assign(creds.claudeAiOauth, oauthBase, { accessToken, expiresAt: expiresAtMs }, refreshToken ? { refreshToken } : {});
      console.log(`[cli-bundle:patchAccessToken] Updated existing claudeAiOauth: token=${tokenPreview}, expiresAt=${expiresAtMs}, refreshToken=${hadRefresh}->${!!refreshToken}`);
    } else {
      creds.claudeAiOauth = { ...oauthBase, accessToken, expiresAt: expiresAtMs, ...(refreshToken ? { refreshToken } : {}) };
      console.log(`[cli-bundle:patchAccessToken] Created new claudeAiOauth: token=${tokenPreview}, expiresAt=${expiresAtMs}, hasRefresh=${!!refreshToken}`);
    }
    fs.writeFileSync(c.files.claudeCreds, JSON.stringify(creds, null, 2), { mode: 0o600 });
    console.log(`[cli-bundle:patchAccessToken] Written to ${c.files.claudeCreds}`);
    // Ensure ~/.claude.json exists (Claude Code's onboarding state). Without it
    // the CLI shows the login flow even when credentials are valid.
    if (!fs.existsSync(c.files.claudeHomeJson)) {
      const homeJson = { hasCompletedOnboarding: true, onboardingComplete: true };
      fs.writeFileSync(c.files.claudeHomeJson, JSON.stringify(homeJson, null, 2), { mode: 0o600 });
      console.log(`[cli-bundle:patchAccessToken] Created missing ${c.files.claudeHomeJson}`);
    }
    log('info', null, 'Claude credentials patched on disk', { tokenPreview });
    return true;
  } catch (e) {
    log('warn', null, 'patchAccessToken failed', { error: e.message });
    console.warn('[cli-bundle:patchAccessToken] Failed:', e.message);
    return false;
  }
}

// Returns true if the on-disk access token has expired, ignoring file mtime.
// checkTokenFreshness() uses mtime to detect Claude CLI's own refreshes, which
// produces false "recently-refreshed" results right after a bundle install.
// This function checks only the token expiry timestamp.
function isAccessTokenExpired() {
  const c = _ctx;
  if (!c) return true;
  try {
    const raw = fs.readFileSync(c.files.claudeCreds, 'utf8');
    const creds = JSON.parse(raw);
    const oauth = creds.claudeAiOauth || creds.oauth || creds;
    const expiresAt = oauth.expiresAt || oauth.expires_at || oauth.accessTokenExpiry;
    if (!expiresAt) return false;
    const expiresMs = typeof expiresAt === 'number'
      ? (expiresAt > 1e12 ? expiresAt : expiresAt * 1000)
      : Date.now() + 3600000;
    return expiresMs <= Date.now();
  } catch (_) {
    return true;
  }
}

module.exports = {
  init,
  ensureInstalled,
  forceReinstall,
  getStatus,
  checkTokenFreshness,
  isAccessTokenExpired,
  patchAccessToken,
  ERR,
  // Exposed for tests only:
  _internal: { aesGcmDecrypt, aesGcmEncrypt, deriveKBuild, deriveKMachine, validateEnvelope, mergeClaudeSettings },
};

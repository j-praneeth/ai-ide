/**
 * gitService — single source of truth for every git operation issued by the
 * renderer.
 *
 * Why a service module rather than ad-hoc axios calls in components?
 *
 *   1. **Backend-readiness gating.** The packaged Electron app launches the
 *      Python backend in parallel with React, so the very first git call
 *      typically lands while uvicorn is still starting. Each method here
 *      awaits a single shared `backendReady` promise before issuing the
 *      request, which collapses what would otherwise be an N×retry storm
 *      across the SCM panel.
 *
 *   2. **Universal transport retry.** Axios's default error message is the
 *      string "Network Error" with no response object. We also see
 *      `ECONNREFUSED` directly during boot, plus the usual timeouts. All of
 *      these are retried with backoff. HTTP-level errors (4xx/5xx) are NOT
 *      retried — those represent real backend responses and need to surface.
 *
 *   3. **One place to add features.** Branches, remotes, tags, clone, init,
 *      merge, rebase, etc. all live here so the panel stays a thin view.
 */

import axios from 'axios';
import { API_URL as API } from '../config';

// ─── Backend readiness ──────────────────────────────────────────────────────
//
// Resolves when ANY of the following becomes true:
//   - The Electron main process emits `backend:ready` (preload re-broadcasts
//     via electronAPI.onBackendReady)
//   - A probe to GET /health returns 200
//   - A best-effort 30s safety timeout expires (we give up gating and let the
//     normal retry layer drive subsequent calls)
//
// The promise is created lazily on the first call so test environments that
// stub axios don't pay the probe cost.

let _readyPromise = null;
let _consecutiveFailures = 0;
// Allow up to 15 consecutive failures (~9s at 600ms intervals) before giving up.
// Python backend startup on Windows regularly takes 3–8s so 3 was too low and
// released the gate before the backend was actually ready.
const MAX_CONSECUTIVE_FAILURES = 15;

function _probeHealth() {
  return axios
    .get(`${API}/health`, { timeout: 1500 })
    .then((res) => {
      _consecutiveFailures = 0;
      return res.status === 200;
    })
    .catch(() => {
      _consecutiveFailures++;
      return false;
    });
}

export function waitForBackendReady() {
  if (_readyPromise) return _readyPromise;

  // If we've had too many consecutive failures, don't block - let the retry layer handle it
  if (_consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    _readyPromise = Promise.resolve();
    return _readyPromise;
  }

  _readyPromise = new Promise((resolve) => {
    let settled = false;
    const finish = () => { if (!settled) { settled = true; resolve(); } };

    // 1. Hot path — backend was already up by the time the renderer mounted.
    _probeHealth().then((ok) => { if (ok) finish(); });

    // 2. Electron event path.
    try {
      const cleanup = window.electronAPI?.onBackendReady?.(() => finish());
      // We never unsubscribe — backend:ready fires exactly once per session.
      // Guard against tests that might call this multiple times.
      if (typeof cleanup === 'function') {
        // eslint-disable-next-line no-unused-vars
        const _ = cleanup;
      }
    } catch (_) { /* non-Electron renderer */ }

    // 3. Poll-fallback path — retry the health probe every 600ms so we recover
    //    automatically when backend:ready was emitted BEFORE we registered the
    //    listener (a common startup-timing footgun in Electron). Stops once
    //    the promise is settled.
    const pollId = setInterval(() => {
      if (settled) { clearInterval(pollId); return; }
      // Skip polling if we have too many consecutive failures
      if (_consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        clearInterval(pollId);
        finish();
        return;
      }
      _probeHealth().then((ok) => {
        if (ok && !settled) { clearInterval(pollId); finish(); }
      });
    }, 600);

    // 4. Safety cap — never block forever. The retry layer below will keep
    //    trying once we stop gating.
    setTimeout(() => { clearInterval(pollId); finish(); }, 30000);
  });

  return _readyPromise;
}

/**
 * Force-reset the readiness gate. Used after a workspace change so a fresh
 * health probe runs against the (possibly restarted) backend. Most callers
 * do NOT need this — it exists for the App.js project-root-change handler.
 */
export function resetBackendReadiness() {
  _readyPromise = null;
}

// ─── Transport-level retry ──────────────────────────────────────────────────
//
// `Network Error` is what axios returns whenever the request never produced a
// response object — ECONNREFUSED, DNS failure, abort, or the browser/Electron
// killing the request before headers came back. None of those represent a
// considered backend response, so retrying is safe.
//
// We deliberately do NOT retry on `response` being present, even if the status
// is 5xx, because that means the backend replied and a retry would just hide
// real server bugs.

const RETRY_ERRORS = /Network Error|ECONNREFUSED|ECONNRESET|ECONNABORTED|ETIMEDOUT|socket hang up|timeout/i;

function _isRetryable(err) {
  if (!err) return false;
  if (err.response) return false;        // backend answered — not a transport bug
  const msg = String(err.message || err.code || '');
  return RETRY_ERRORS.test(msg);
}

/**
 * Run `fn` (which returns an axios promise) with exponential backoff on
 * transport-level errors. Total wall-clock cap ≈ 30s by default; individual
 * calls keep their own per-request axios timeout.
 */
export async function withGitRetry(fn, { maxTries = 8, baseDelay = 500 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < maxTries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!_isRetryable(err) || attempt === maxTries - 1) throw err;
      const delay = Math.min(baseDelay * Math.pow(1.7, attempt), 5000);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr; // unreachable, satisfies linter
}

/**
 * Combined helper: wait for the backend to become ready (first call only),
 * then run `fn` through `withGitRetry`. Every git call in this module funnels
 * through here so the retry/gate behaviour is consistent.
 */
async function gated(fn, retryOpts) {
  await waitForBackendReady();
  return withGitRetry(fn, retryOpts);
}

// ─── Low-level git runners ──────────────────────────────────────────────────

/**
 * Shell-string runner (read-only operations only — diff/log/show). Sent to the
 * Python backend's /terminal/run which executes via the system shell. NEVER
 * use this for user-supplied paths or branch names; use `runGit` for those.
 */
export async function runCommand(command, { timeout = 180000 } = {}) {
  const res = await gated(() =>
    axios.post(`${API}/terminal/run`, { command }, { timeout })
  );
  return { output: res.data?.output ?? '', exit_code: res.data?.exit_code ?? 0 };
}

/**
 * Argument-list git runner — bypasses shell quoting entirely. Use this for
 * every write operation so commands work identically on Windows (PowerShell)
 * and macOS/Linux.
 */
export async function runGit(args, { timeout = 60000 } = {}) {
  const res = await gated(() =>
    axios.post(
      `${API}/files/git-run`,
      { args, timeout: Math.floor(timeout / 1000) },
      { timeout: timeout + 5000 },
    )
  );
  return {
    output: res.data?.output ?? '',
    exit_code: res.data?.exit_code ?? 0,
    ok: !!res.data?.ok,
  };
}

// ─── Status / diff / show ──────────────────────────────────────────────────

export async function fetchStatusBundle() {
  try {
    const res = await gated(() =>
      axios.get(`${API}/files/git-status-bundle`, { timeout: 60000 })
    );
    return res.data;
  } catch (err) {
    // If backend is not ready, return a graceful fallback instead of throwing
    // This prevents the UI from showing errors every 15 seconds
    const msg = String(err.message || '');
    if (msg.includes('ECONNREFUSED') || msg.includes('Network Error') || msg.includes('timeout')) {
      return { ok: false, error: 'Backend not ready', isRetryable: true };
    }
    throw err;
  }
}

export async function gitShow(path, ref = 'HEAD') {
  const res = await gated(() =>
    axios.get(`${API}/files/git-show`, {
      params: { path, ref },
      timeout: 30000,
    })
  );
  return res.data;
}

// ─── Branches ──────────────────────────────────────────────────────────────

export async function listBranches() {
  const res = await gated(() =>
    axios.get(`${API}/files/git-branches`, { timeout: 30000 })
  );
  return res.data;
}

export const createBranch  = (name)          => runGit(['branch', name]);
export const switchBranch  = (name)          => runGit(['checkout', name]);
export const createAndSwitchBranch = (name)  => runGit(['checkout', '-b', name]);
export const deleteBranch  = (name, force)   => runGit(['branch', force ? '-D' : '-d', name]);
export const renameBranch  = (oldName, name) => runGit(['branch', '-m', oldName, name]);
export const checkoutRemoteBranch = (remoteRef) => {
  // remoteRef looks like "origin/feature-x" — create a local tracking branch
  // named "feature-x" pointing at it. This mirrors `git switch <name>`'s
  // auto-tracking behaviour but works on older git too.
  const local = remoteRef.split('/').slice(1).join('/') || remoteRef;
  return runGit(['checkout', '-b', local, '--track', remoteRef]);
};

// ─── Remotes ───────────────────────────────────────────────────────────────

export async function listRemotes() {
  const res = await gated(() =>
    axios.get(`${API}/files/git-remotes`, { timeout: 15000 })
  );
  return res.data;
}

export const addRemote    = (name, url)        => runGit(['remote', 'add', name, url]);
export const removeRemote = (name)             => runGit(['remote', 'remove', name]);
export const renameRemote = (oldName, name)    => runGit(['remote', 'rename', oldName, name]);
export const setRemoteUrl = (name, url)        => runGit(['remote', 'set-url', name, url]);

// ─── Tags ──────────────────────────────────────────────────────────────────

export async function listTags() {
  const res = await gated(() =>
    axios.get(`${API}/files/git-tags`, { timeout: 15000 })
  );
  return res.data;
}

export const createTag = (name, message) =>
  message
    ? runGit(['tag', '-a', name, '-m', message])
    : runGit(['tag', name]);
export const deleteTag    = (name)               => runGit(['tag', '-d', name]);
export const pushTag      = (name, remote = 'origin') =>
  runGit(['push', remote, name], { timeout: 120000 });
export const pushAllTags  = (remote = 'origin')  =>
  runGit(['push', remote, '--tags'], { timeout: 120000 });

// ─── Merge / Rebase ────────────────────────────────────────────────────────

export const mergeBranch       = (branch, noFF) =>
  runGit(['merge', ...(noFF ? ['--no-ff'] : []), branch], { timeout: 120000 });
export const abortMerge        = ()        => runGit(['merge', '--abort']);
export const continueMerge     = ()        => runGit(['merge', '--continue']);

export const rebaseOnto        = (branch)  => runGit(['rebase', branch], { timeout: 120000 });
export const abortRebase       = ()        => runGit(['rebase', '--abort']);
export const continueRebase    = ()        => runGit(['rebase', '--continue']);
export const skipRebase        = ()        => runGit(['rebase', '--skip']);

export const abortCherryPick   = ()        => runGit(['cherry-pick', '--abort']);
export const continueCherryPick = ()       => runGit(['cherry-pick', '--continue']);

// ─── In-progress detection ────────────────────────────────────────────────

export async function gitProgress() {
  const res = await gated(() =>
    axios.get(`${API}/files/git-progress`, { timeout: 5000 })
  );
  return res.data;
}

// ─── Clone / Init ──────────────────────────────────────────────────────────

export async function gitClone({ url, targetDir, depth, branch, timeoutMs = 600000 }) {
  // Wait for backend ready ONCE, then issue the call with the user's chosen
  // timeout (default 10 minutes). Clone never retries — partial clones can
  // leave junk on disk and re-running might create a "nested git repo" error.
  await waitForBackendReady();
  const res = await axios.post(
    `${API}/files/git-clone`,
    { url, target_dir: targetDir, depth, branch, timeout: Math.floor(timeoutMs / 1000) },
    { timeout: timeoutMs + 5000 },
  );
  return res.data;
}

export async function gitInit({ targetDir, initialBranch = 'main' } = {}) {
  await waitForBackendReady();
  const res = await axios.post(
    `${API}/files/git-init`,
    { target_dir: targetDir, initial_branch: initialBranch },
    { timeout: 30000 },
  );
  return res.data;
}

// ─── Error translation ─────────────────────────────────────────────────────
//
// Same helpers the panel was using inline — exported so any caller can render
// a consistent message. New error patterns can be added here without touching
// the UI.

export function friendlyGitError(output = '') {
  if (/nothing to commit|nothing added to commit|no changes added/i.test(output))
    return 'Nothing to commit. Stage your changes first.';
  if (/please tell me who you are|user\.email|user\.name/i.test(output))
    return 'Git identity not configured. Run: git config --global user.email "you@example.com"';
  if (/authentication failed|could not read username|permission denied \(publickey\)/i.test(output))
    return 'Authentication required. Check your credentials or SSH key.';
  if (/rejected.*non-fast-forward|rejected.*fetch first/i.test(output))
    return 'Push rejected: remote has new commits. Pull first, then push.';
  if (/no upstream branch|set-upstream/i.test(output))
    return 'No upstream branch. Use "Publish Branch" to push for the first time.';
  if (/not a git repository/i.test(output))
    return 'Not a git repository.';
  if (/already exists.*and is not an empty directory/i.test(output))
    return 'Target directory already exists and is not empty.';
  if (/repository .* does not exist|repository not found/i.test(output))
    return 'Repository not found. Check the URL.';
  if (/git not found in PATH/i.test(output))
    return 'Git is not installed or not in PATH. Install git and restart the app.';
  const firstLine = String(output || '').trim().split('\n').find((l) => l.trim()) || String(output || '').trim();
  return firstLine.length > 200 ? firstLine.slice(0, 200) + '…' : firstLine;
}

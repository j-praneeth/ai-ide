from __future__ import annotations

import json
import logging
import os
import threading
import time
from typing import Optional

import requests

from db.mongo import app_config_collection, utcnow

logger = logging.getLogger("security.claude_token")

_CREDS_DOC_ID = "claude_master_creds"
_CACHE_MARGIN_SECONDS = 5 * 60  # Refresh 5 min before expiry

_cache_lock = threading.Lock()
_cached_access_token: Optional[str] = None
_cached_refresh_token: Optional[str] = None
_cached_expires_at: float = 0.0  # unix seconds


_DEFAULT_TOKEN_URL = "https://platform.claude.com/v1/oauth/token"
# Public client — no secret. client_id is the metadata URL per OAuth 2.0 Dynamic Registration.
_DEFAULT_CLIENT_ID = "https://claude.ai/oauth/claude-code-client-metadata"


def _token_url() -> str:
    return (os.environ.get("CLAUDE_TOKEN_URL") or _DEFAULT_TOKEN_URL).strip()


def _client_id() -> str:
    return (os.environ.get("CLAUDE_OAUTH_CLIENT_ID") or _DEFAULT_CLIENT_ID).strip()


def get_stored_oauth() -> Optional[dict]:
    try:
        doc = app_config_collection().find_one({"_id": _CREDS_DOC_ID})
        return (doc or {}).get("oauth") or None
    except Exception as e:
        logger.error("Failed to read claude creds from DB: %s", e)
        return None


def save_oauth(oauth: dict) -> None:
    try:
        app_config_collection().update_one(
            {"_id": _CREDS_DOC_ID},
            {"$set": {"oauth": oauth, "updated_at": utcnow()}},
            upsert=True,
        )
    except Exception as e:
        logger.error("Failed to save claude creds to DB: %s", e)


def seed_from_env() -> None:
    """
    Called at startup. If CLAUDE_INITIAL_REFRESH_TOKEN is set and no creds exist in DB,
    seeds MongoDB so the system can start refreshing tokens immediately.
    """
    refresh_token = (os.environ.get("CLAUDE_INITIAL_REFRESH_TOKEN") or "").strip()
    if not refresh_token:
        return
    existing = get_stored_oauth()
    if existing and existing.get("refreshToken"):
        logger.info("Claude master creds already in DB, skipping env seed.")
        return
    logger.info("Seeding Claude master credentials from CLAUDE_INITIAL_REFRESH_TOKEN env var.")
    save_oauth({"refreshToken": refresh_token})


def _do_refresh(refresh_token: str) -> dict:
    """POST to the Claude OAuth token endpoint with a refresh_token grant."""
    url = _token_url()
    payload = {
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
        "client_id": _client_id(),
    }
    logger.info("Calling Claude token endpoint: %s", url)
    resp = requests.post(url, json=payload, timeout=15)
    if not resp.ok:
        logger.error("Token refresh failed %s: %s", resp.status_code, resp.text)
    resp.raise_for_status()
    return resp.json()


def get_fresh_access_token() -> dict:
    """
    Returns { accessToken, refreshToken, expiresAt }.

    The refreshToken is included so the Electron app can write it to disk,
    keeping the on-disk refresh token in sync with the DB.  Without this,
    a running Claude CLI process that falls back to its in-memory refresh
    token (from the stale bundle) would get a 401 after the access token expires.

    Flow:
      1. Hit in-memory cache (avoids DB round-trip within 50-min window).
      2. Read full OAuth object from MongoDB.
      3. If access token is still fresh enough, cache and return it.
      4. Otherwise call Anthropic with the stored refresh token.
      5. Save the new OAuth (new accessToken + possibly rotated refreshToken) back to DB.
      6. Update cache and return.
    """
    global _cached_access_token, _cached_refresh_token, _cached_expires_at

    now = time.time()

    # 1. In-memory cache hit
    with _cache_lock:
        if _cached_access_token and _cached_refresh_token and _cached_expires_at > now + _CACHE_MARGIN_SECONDS:
            return {
                "accessToken": _cached_access_token,
                "refreshToken": _cached_refresh_token,
                "expiresAt": int(_cached_expires_at * 1000),
            }

    # 2. Load from DB
    oauth = get_stored_oauth()
    if not oauth:
        raise RuntimeError(
            "No Claude credentials in database. "
            "POST { oauth: { refreshToken } } to /auth/claude-credentials first."
        )

    access_token = (oauth.get("accessToken") or "").strip()
    expires_at_ms = oauth.get("expiresAt") or 0
    refresh_token = (oauth.get("refreshToken") or "").strip()

    # expiresAt may be stored as ms or s
    expires_at_s = (expires_at_ms / 1000) if expires_at_ms > 1e9 else float(expires_at_ms)

    # 3. Access token still valid
    if access_token and expires_at_s > now + _CACHE_MARGIN_SECONDS:
        with _cache_lock:
            _cached_access_token = access_token
            _cached_refresh_token = refresh_token
            _cached_expires_at = expires_at_s
        return {"accessToken": access_token, "refreshToken": refresh_token, "expiresAt": int(expires_at_s * 1000)}

    # 4. Refresh
    if not refresh_token:
        raise RuntimeError(
            "Access token expired and no refresh token stored. "
            "Re-seed via POST /auth/claude-credentials."
        )

    result = _do_refresh(refresh_token)

    new_access = (result.get("access_token") or result.get("accessToken") or "").strip()
    # Use new refresh token if Anthropic rotated it; otherwise keep the existing one
    new_refresh = (result.get("refresh_token") or result.get("refreshToken") or "").strip() or refresh_token
    expires_in = int(result.get("expires_in") or 3600)
    new_expires_at_s = now + expires_in

    if not new_access:
        raise RuntimeError(f"Token refresh call succeeded but returned no access_token. Response: {result}")

    # 5. Persist (handles rotation: new refresh token saved automatically)
    updated_oauth = {**oauth, "accessToken": new_access, "refreshToken": new_refresh, "expiresAt": int(new_expires_at_s * 1000)}
    save_oauth(updated_oauth)

    # 6. Update cache
    with _cache_lock:
        _cached_access_token = new_access
        _cached_refresh_token = new_refresh
        _cached_expires_at = new_expires_at_s

    logger.info("Claude access token refreshed successfully. Expires in %ss.", expires_in)
    return {"accessToken": new_access, "refreshToken": new_refresh, "expiresAt": int(new_expires_at_s * 1000)}


def clear_cache() -> None:
    """Invalidate the in-memory token cache (call after externally updating stored credentials)."""
    global _cached_access_token, _cached_refresh_token, _cached_expires_at
    with _cache_lock:
        _cached_access_token = None
        _cached_refresh_token = None
        _cached_expires_at = 0.0


_disk_watcher_thread: Optional[threading.Thread] = None
_disk_watcher_last_refresh: Optional[str] = None
_disk_watcher_lock = threading.Lock()


def _read_disk_oauth() -> tuple[str, str, int]:
    """Returns (refresh_token, access_token, expires_at_raw) from disk, or ('','',0) on any failure."""
    creds_path = os.path.expanduser("~/.claude/.credentials.json")
    try:
        if not os.path.exists(creds_path):
            return "", "", 0
        with open(creds_path, "r", encoding="utf-8") as f:
            raw = json.load(f)
        oauth = raw.get("claudeAiOauth") or raw.get("oauth") or raw
        refresh = (oauth.get("refreshToken") or oauth.get("refresh_token") or "").strip()
        access = (oauth.get("accessToken") or oauth.get("access_token") or "").strip()
        expires = int(oauth.get("expiresAt") or oauth.get("expires_at") or 0)
        return refresh, access, expires
    except Exception:
        return "", "", 0


def _disk_watcher_loop(interval_seconds: int) -> None:
    global _disk_watcher_last_refresh

    # Seed the last-known refresh token so the first tick doesn't trigger a
    # spurious sync when disk and MongoDB are already in sync.
    disk_refresh, _, _ = _read_disk_oauth()
    with _disk_watcher_lock:
        _disk_watcher_last_refresh = disk_refresh

    logger.info("Backend credential watcher started (interval=%ss).", interval_seconds)

    while True:
        time.sleep(interval_seconds)
        try:
            disk_refresh, disk_access, disk_expires = _read_disk_oauth()
            if not disk_refresh:
                continue

            with _disk_watcher_lock:
                if disk_refresh == _disk_watcher_last_refresh:
                    continue  # nothing changed since last tick

            # Something changed on disk — compare with MongoDB
            stored = get_stored_oauth()
            stored_refresh = (stored or {}).get("refreshToken", "").strip()

            if disk_refresh == stored_refresh:
                with _disk_watcher_lock:
                    _disk_watcher_last_refresh = disk_refresh
                continue  # disk and MongoDB already agree

            logger.info(
                "Backend credential watcher: refresh token rotated on disk, syncing to MongoDB."
            )
            save_oauth({
                "accessToken": disk_access,
                "refreshToken": disk_refresh,
                "expiresAt": disk_expires,
            })
            clear_cache()

            with _disk_watcher_lock:
                _disk_watcher_last_refresh = disk_refresh

        except Exception as exc:
            logger.warning("Backend credential watcher tick error: %s", exc)


def start_disk_credential_watcher(interval_seconds: int = 60) -> None:
    """
    Starts a background daemon thread that polls ~/.claude/.credentials.json
    every `interval_seconds` seconds and syncs the refresh token to MongoDB
    whenever it changes.

    WHY this lives in the backend (not Electron):
      The master host runs the backend 24/7 on a server but does NOT keep the
      Electron UI open. The Electron fs.watch is therefore never running on the
      host machine. This backend watcher is the only process that is always
      alive and can detect token rotation caused by the host running `claude`
      directly in a terminal.
    """
    global _disk_watcher_thread
    if _disk_watcher_thread and _disk_watcher_thread.is_alive():
        logger.info("Backend credential watcher already running, skipping.")
        return
    _disk_watcher_thread = threading.Thread(
        target=_disk_watcher_loop,
        args=(interval_seconds,),
        daemon=True,
        name="claude-cred-watcher",
    )
    _disk_watcher_thread.start()


def reconcile_disk_credentials() -> None:
    """
    Called at every backend startup. Compares ~/.claude/.credentials.json with
    MongoDB and syncs whichever has the more recently refreshed token (decided
    by expiresAt timestamp).

    WHY this is needed:
      - App is not running 24/7 (Windows dev machine).
      - While app was closed, someone ran `claude` in a separate terminal.
      - Anthropic rotated the refresh token → disk has new token, MongoDB has dead one.
      - Without this reconciliation, the next startup hits a 401 on token refresh.

    Decision rule (uses expiresAt as a freshness proxy):
      - disk.expiresAt >= mongodb.expiresAt  →  disk wins, sync disk → MongoDB
      - mongodb.expiresAt >  disk.expiresAt  →  MongoDB wins, Electron will patch disk
        via _applyFreshClaudeToken() after backend is ready (no action needed here).
    """
    creds_path = os.path.expanduser("~/.claude/.credentials.json")
    if not os.path.exists(creds_path):
        logger.info("Startup reconcile: credentials file not on disk, skipping.")
        return

    try:
        with open(creds_path, "r", encoding="utf-8") as f:
            raw = json.load(f)

        disk_oauth = raw.get("claudeAiOauth") or raw.get("oauth") or raw
        disk_refresh = (disk_oauth.get("refreshToken") or disk_oauth.get("refresh_token") or "").strip()
        disk_access = (disk_oauth.get("accessToken") or disk_oauth.get("access_token") or "").strip()
        disk_expires_raw = disk_oauth.get("expiresAt") or disk_oauth.get("expires_at") or 0

        if not disk_refresh:
            logger.info("Startup reconcile: disk file has no refresh token, skipping.")
            return

        stored = get_stored_oauth()
        stored_refresh = (stored or {}).get("refreshToken", "").strip()
        stored_expires_raw = (stored or {}).get("expiresAt", 0)

        if disk_refresh == stored_refresh:
            logger.info("Startup reconcile: disk and MongoDB tokens match — no action needed.")
            return

        # Tokens differ — compare freshness via expiresAt
        def _to_seconds(v: object) -> float:
            try:
                v = float(v or 0)
                return v / 1000.0 if v > 1e10 else v
            except Exception:
                return 0.0

        disk_exp_s = _to_seconds(disk_expires_raw)
        stored_exp_s = _to_seconds(stored_expires_raw)

        if disk_exp_s >= stored_exp_s:
            logger.info(
                "Startup reconcile: disk token is newer (disk expiresAt=%s, db expiresAt=%s). "
                "Syncing disk → MongoDB.",
                disk_exp_s, stored_exp_s,
            )
            save_oauth({
                "accessToken": disk_access,
                "refreshToken": disk_refresh,
                "expiresAt": int(disk_expires_raw),
            })
            clear_cache()
        else:
            logger.info(
                "Startup reconcile: MongoDB token is newer (db expiresAt=%s, disk expiresAt=%s). "
                "Electron will patch disk via _applyFreshClaudeToken after startup.",
                stored_exp_s, disk_exp_s,
            )

    except Exception as exc:
        logger.warning("Startup reconcile failed (non-fatal): %s", exc)

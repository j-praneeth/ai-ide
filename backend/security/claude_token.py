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

_cache_lock = threading.RLock()  # Reentrant lock for read-modify-write patterns
_cached_access_token: Optional[str] = None
_cached_refresh_token: Optional[str] = None
_cached_expires_at: float = 0.0  # unix seconds
_cached_oauth: Optional[dict] = None  # full OAuth object for building responses
_cache_valid: bool = False  # Explicit validity flag — invalidated by clear_cache()


_DEFAULT_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token"


def _token_url() -> str:
    return (os.environ.get("CLAUDE_TOKEN_URL") or _DEFAULT_TOKEN_URL).strip()


def _client_id() -> str:
    client_id = os.environ.get("CLAUDE_OAUTH_CLIENT_ID", "").strip()
    if not client_id:
        raise RuntimeError(
            "CLAUDE_OAUTH_CLIENT_ID environment variable is required. "
            "Add it to backend/.env."
        )
    return client_id


def get_stored_oauth() -> Optional[dict]:
    try:
        doc = app_config_collection().find_one({"_id": _CREDS_DOC_ID})
        return (doc or {}).get("oauth") or None
    except Exception as e:
        logger.error("Failed to read claude creds from DB: %s", e)
        return None


def save_oauth(oauth: dict, reason: str = "manual") -> None:
    try:
        app_config_collection().update_one(
            {"_id": _CREDS_DOC_ID},
            {"$set": {"oauth": oauth, "updated_at": utcnow()}},
            upsert=True,
        )
        logger.info("Claude OAuth saved to DB [reason=%s] refreshToken=%s..., accessToken=%s..., expiresAt=%s",
            reason,
            (oauth or {}).get("refreshToken", "")[:8] or "none",
            (oauth or {}).get("accessToken", "")[:8] or "none",
            (oauth or {}).get("expiresAt", 0),
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
    save_oauth({"refreshToken": refresh_token}, reason="seed_from_env")


def _do_refresh(refresh_token: str) -> dict:
    """POST to the Claude OAuth token endpoint with a refresh_token grant."""
    url = _token_url()
    payload = {
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
        "client_id": _client_id(),
    }
    logger.info(
        "Calling Claude token endpoint: %s (client_id=%s, refresh_token=%s...)",
        url, _client_id(), refresh_token[:10],
    )
    try:
        resp = requests.post(url, json=payload, timeout=15)
    except requests.exceptions.ConnectTimeout:
        raise RuntimeError("TOKEN_REFRESH_NETWORK_ERROR: Connection timed out connecting to Claude auth server.")
    except requests.exceptions.ConnectionError as e:
        raise RuntimeError(f"TOKEN_REFRESH_NETWORK_ERROR: Could not connect to Claude auth server: {e}")
    except requests.exceptions.Timeout:
        raise RuntimeError("TOKEN_REFRESH_NETWORK_ERROR: Request timed out during Claude token refresh.")
    except requests.exceptions.RequestException as e:
        raise RuntimeError(f"TOKEN_REFRESH_NETWORK_ERROR: {e}")

    # Parse the response body once so we can inspect OAuth error codes.
    body: dict = {}
    try:
        body = resp.json() if resp.content else {}
    except Exception:
        body = {}
    error_code = (body.get("error") or "").strip().lower() if isinstance(body, dict) else ""
    error_detail = (
        (body.get("error_description") if isinstance(body, dict) else None)
        or (body.get("error") if isinstance(body, dict) else None)
        or resp.text[:200]
    )

    # 401, or 400 with invalid_grant/invalid_client, means the refresh token is dead.
    # Per RFC 6749 §5.2, the OAuth server returns HTTP 400 with error="invalid_grant"
    # when the refresh token is expired, revoked, or doesn't belong to this client.
    auth_failure_codes = {"invalid_grant", "invalid_client", "unauthorized_client"}
    if resp.status_code == 401 or (resp.status_code == 400 and error_code in auth_failure_codes):
        logger.error(
            "Token refresh FAILED (%s, oauth_error=%s) — refresh token is expired or revoked. "
            "Detail: %s. User must re-authenticate.",
            resp.status_code, error_code or "n/a", error_detail,
        )
        raise RuntimeError(
            f"TOKEN_REFRESH_AUTH_FAILED: Claude refresh token is invalid or expired. "
            f"Re-paste ~/.claude/.credentials.json in the admin panel. ({error_detail})"
        )

    if not resp.ok:
        logger.error("Token refresh failed %s: %s", resp.status_code, resp.text)
        raise RuntimeError(f"TOKEN_REFRESH_HTTP_ERROR: HTTP {resp.status_code}: {resp.text[:200]}")

    return body if body else resp.json()


def _build_oauth_response(oauth: dict, access_token: str, refresh_token: str, expires_at_s: float) -> dict:
    """Build the full OAuth response including all stored fields (scopes, subscriptionType, etc.)."""
    return {
        **oauth,
        "accessToken": access_token,
        "refreshToken": refresh_token,
        "expiresAt": int(expires_at_s * 1000),
    }

def _ms_or_s_to_seconds(value: object) -> float:
    """
    Convert a stored expiresAt value to seconds since epoch.
    Heuristic:
      - value > 1e11 → milliseconds (since 1e11 ms ≈ 1970+3 years, which is unlikely for a valid timestamp)
      - value <= 1e11 → seconds
    Returns 0.0 on any failure.
    """
    try:
        v = float(value or 0)
        if v <= 0:
            return 0.0
        if v > 1e11:
            return v / 1000.0
        return v
    except (ValueError, TypeError):
        return 0.0


def get_fresh_access_token() -> dict:
    """
    Returns the full OAuth object with updated accessToken, refreshToken, expiresAt,
    plus all stored fields (scopes, subscriptionType, rateLimitTier, etc.).

    The refreshToken is included so the Electron app can write it to disk,
    keeping the on-disk refresh token in sync with the DB.  Without this,
    a running Claude CLI process that falls back to its in-memory refresh
    token (from the stale bundle) would get a 401 after the access token expires.

    Flow:
      1. Hit in-memory cache (avoids DB round-trip within ~55-min window).
      2. Read full OAuth object from MongoDB.
      3. If access token is still fresh enough, cache and return it.
      4. Otherwise call Anthropic with the stored refresh token.
      5. Save the new OAuth (new accessToken + possibly rotated refreshToken) back to DB.
      6. Update cache and return.
    """
    global _cached_access_token, _cached_refresh_token, _cached_expires_at, _cached_oauth, _cache_valid

    now = time.time()

    # 1. In-memory cache hit (with validity check — cache may have been cleared)
    with _cache_lock:
        if _cache_valid and _cached_access_token and _cached_refresh_token and _cached_expires_at > now + _CACHE_MARGIN_SECONDS:
            return _build_oauth_response(
                _cached_oauth or {},
                _cached_access_token, _cached_refresh_token, _cached_expires_at,
            )

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

    # expiresAt may be stored as ms or s — use the robust helper
    expires_at_s = _ms_or_s_to_seconds(expires_at_ms)

    # 3. Access token still valid
    if access_token and expires_at_s > now + _CACHE_MARGIN_SECONDS:
        with _cache_lock:
            _cached_oauth = oauth
            _cached_access_token = access_token
            _cached_refresh_token = refresh_token
            _cached_expires_at = expires_at_s
            _cache_valid = True
        return _build_oauth_response(oauth, access_token, refresh_token, expires_at_s)

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

    # 5. Persist (handles rotation: new refresh token saved automatically).
    #    Also capture the "scope" field from the Anthropic response (a space-
    #    separated string of OAuth scopes) if present.
    scope = (result.get("scope") or "").strip()
    updated_oauth = {
        **oauth,
        "accessToken": new_access,
        "refreshToken": new_refresh,
        "expiresAt": int(new_expires_at_s * 1000),
        "scope": scope,
        "subscriptionType": result.get("subscriptionType") or "free",
        "rateLimitTier": result.get("rateLimitTier") or "default_claude_free_1x",
    }
    if scope:
        updated_oauth["scope"] = scope
    save_oauth(updated_oauth, reason="oauth_refresh")

    # 6. Update cache (atomically within the lock)
    with _cache_lock:
        _cached_oauth = updated_oauth
        _cached_access_token = new_access
        _cached_refresh_token = new_refresh
        _cached_expires_at = new_expires_at_s
        _cache_valid = True

    logger.info("Claude access token refreshed successfully. Expires in %ss.", expires_in)
    return _build_oauth_response(updated_oauth, new_access, new_refresh, new_expires_at_s)


def clear_cache() -> None:
    """Invalidate the in-memory token cache (call after externally updating stored credentials)."""
    global _cached_access_token, _cached_refresh_token, _cached_expires_at, _cached_oauth, _cache_valid
    with _cache_lock:
        _cached_access_token = None
        _cached_refresh_token = None
        _cached_expires_at = 0.0
        _cached_oauth = None
        _cache_valid = False
    logger.debug("Claude token cache cleared.")


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

            # Use a local snapshot to minimize lock hold time
            with _disk_watcher_lock:
                last_refresh = _disk_watcher_last_refresh

            if disk_refresh == last_refresh:
                continue  # nothing changed since last tick

            # Something changed on disk — compare with MongoDB
            stored = get_stored_oauth()
            stored_refresh = (stored or {}).get("refreshToken", "").strip()

            if disk_refresh == stored_refresh:
                with _disk_watcher_lock:
                    _disk_watcher_last_refresh = disk_refresh
                continue  # disk and MongoDB already agree

            logger.info(
                "Backend credential watcher: refresh token rotated on disk (disk=%s..., stored=%s...), syncing to MongoDB.",
                disk_refresh[:8] if disk_refresh else 'none',
                stored_refresh[:8] if stored_refresh else 'none',
            )
            # Use a single atomic save + cache clear
            expires_at_s = _ms_or_s_to_seconds(disk_expires)
            save_oauth({
                "accessToken": disk_access,
                "refreshToken": disk_refresh,
                "expiresAt": int(expires_at_s * 1000) if expires_at_s > 0 else 0,
            }, reason="disk_watcher")
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

        # Tokens differ — compare freshness via expiresAt using the robust helper
        disk_exp_s = _ms_or_s_to_seconds(disk_expires_raw)
        stored_exp_s = _ms_or_s_to_seconds(stored_expires_raw)

        if disk_exp_s >= stored_exp_s:
            logger.info(
                "Startup reconcile: disk token is newer (disk expiresAt=%s, db expiresAt=%s). "
                "Syncing disk → MongoDB.",
                disk_exp_s, stored_exp_s,
            )
            save_oauth({
                "accessToken": disk_access,
                "refreshToken": disk_refresh,
                "expiresAt": int(disk_exp_s * 1000) if disk_exp_s > 0 else 0,
            }, reason="startup_reconcile")
            clear_cache()
        else:
            logger.info(
                "Startup reconcile: MongoDB token is newer (db expiresAt=%s, disk expiresAt=%s). "
                "Electron will patch disk via _applyFreshClaudeToken after startup.",
                stored_exp_s, disk_exp_s,
            )

    except Exception as exc:
        logger.warning("Startup reconcile failed (non-fatal): %s", exc)

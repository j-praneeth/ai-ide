from __future__ import annotations

import json
import logging
import os
import threading
import time
from typing import Optional

import requests

from db.mongo import app_config_collection, utcnow, is_mongo_available, mark_mongo_unreachable

logger = logging.getLogger("security.claude_token")

_CREDS_DOC_ID = "claude_master_creds"
_CACHE_MARGIN_SECONDS = 5 * 60  # Refresh 5 min before expiry

_cache_lock = threading.RLock()  # Reentrant lock for read-modify-write patterns
_cached_access_token: Optional[str] = None
_cached_refresh_token: Optional[str] = None
_cached_expires_at: float = 0.0  # unix seconds
_cached_oauth: Optional[dict] = None  # full OAuth object for building responses
_cache_valid: bool = False  # Explicit validity flag — invalidated by clear_cache()


def is_master_device() -> bool:
    """Check if this device is configured as the master device that handles token refresh.
    Defaults to False - only master laptop should have CLAUDE_MASTER_MODE=true."""
    return os.environ.get("CLAUDE_MASTER_MODE", "false").strip().lower() == "true"


def get_token_for_sync() -> dict:
    """
    Returns the current stored OAuth token from database without any refresh attempt.
    Used by user devices to sync tokens to their local disk.
    """
    oauth = get_stored_oauth()
    if not oauth:
        raise RuntimeError(
            "No Claude credentials in database. "
            "POST { oauth: { refreshToken } } to /auth/claude-credentials first."
        )

    access_token = (oauth.get("accessToken") or "").strip()
    refresh_token = (oauth.get("refreshToken") or "").strip()
    expires_at_ms = oauth.get("expiresAt") or 0
    expires_at_s = _ms_or_s_to_seconds(expires_at_ms)

    return _build_oauth_response(oauth, access_token, refresh_token, expires_at_s)


def write_token_to_disk(oauth: dict, reason: str = "sync") -> None:
    """
    Write the OAuth token to the local disk at ~/.claude/.credentials.json.
    This is used by user devices to sync their local credentials with the database.
    """
    creds_path = os.path.expanduser("~/.claude/.credentials.json")
    try:
        os.makedirs(os.path.dirname(creds_path), exist_ok=True)
        with open(creds_path, "w", encoding="utf-8") as f:
            json.dump({"claudeAiOauth": oauth}, f, indent=2)
        logger.info("Claude credentials written to disk [reason=%s]", reason)
    except Exception as e:
        logger.error("Failed to write credentials to disk: %s", e)


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
    """Read OAuth credentials — MongoDB first, disk as fallback when DB is unreachable."""
    if is_mongo_available():
        try:
            doc = app_config_collection().find_one({"_id": _CREDS_DOC_ID})
            return (doc or {}).get("oauth") or None
        except Exception as e:
            err_str = str(e)
            # DNS/network failures → mark unreachable and fall through to disk
            if any(kw in err_str for kw in ("nodename nor servname", "Name or service not known",
                                             "ENOTFOUND", "getaddrinfo", "Timeout", "ServerSelectionTimeoutError")):
                logger.warning("MongoDB unreachable, switching to disk fallback for %ds: %s",
                               30, err_str[:120])
                mark_mongo_unreachable()
            else:
                logger.error("Failed to read claude creds from DB: %s", e)
                return None
    else:
        logger.debug("MongoDB in cooldown — using disk credentials fallback.")

    # Disk fallback: read from ~/.claude/.credentials.json
    refresh, access, expires = _read_disk_oauth()
    if refresh:
        logger.info("Returning disk credentials as MongoDB fallback (refresh=%s...)", refresh[:8])
        return {
            "refreshToken": refresh,
            "accessToken": access,
            "expiresAt": expires,
        }
    return None


def save_oauth(oauth: dict, reason: str = "manual") -> None:
    if not is_mongo_available():
        logger.debug("save_oauth skipped — MongoDB unreachable [reason=%s]", reason)
        return
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
        err_str = str(e)
        if any(kw in err_str for kw in ("nodename nor servname", "Name or service not known",
                                         "ENOTFOUND", "getaddrinfo", "Timeout")):
            logger.warning("MongoDB unreachable during save_oauth [reason=%s], marking cooldown.", reason)
            mark_mongo_unreachable()
        else:
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
    Returns a fresh OAuth token.

    Master device flow:
      1. Read ~/.claude/.credentials.json (primary source).
      2. If token is expiring → refresh with Anthropic → write back to disk → save to MongoDB → return.
      3. If token is fresh → sync disk → MongoDB (only when refresh token changed) → return.

    User device flow:
      1. Read from MongoDB (master keeps it fresh) → return.
    """
    global _cached_access_token, _cached_refresh_token, _cached_expires_at, _cached_oauth, _cache_valid

    now = time.time()

    if is_master_device():
        # --- Master: disk is primary source ---
        disk_refresh, disk_access, disk_expires_raw = _read_disk_oauth()
        disk_expires_s = _ms_or_s_to_seconds(disk_expires_raw)

        if not disk_refresh:
            logger.warning("[TOKEN-READ] Master device has no disk credentials — falling back to MongoDB.")
        else:
            needs_refresh = disk_expires_s <= now + _CACHE_MARGIN_SECONDS

            if needs_refresh:
                logger.warning("[TOKEN-READ] Disk token expired/expiring — refreshing with Anthropic...")
                try:
                    result = _do_refresh(disk_refresh)
                    new_access = (result.get("access_token") or result.get("accessToken") or "").strip()
                    new_refresh = (result.get("refresh_token") or result.get("refreshToken") or "").strip() or disk_refresh
                    expires_in = int(result.get("expires_in") or 3600)
                    new_expires_s = now + expires_in

                    updated = {
                        "accessToken": new_access,
                        "refreshToken": new_refresh,
                        "expiresAt": int(new_expires_s * 1000),
                    }
                    write_token_to_disk(updated, reason="refreshed")
                    save_oauth(updated, reason="disk_refreshed")
                    clear_cache()
                    logger.info("[TOKEN-READ] Token refreshed — written to disk and saved to MongoDB.")

                    with _cache_lock:
                        _cached_oauth = updated
                        _cached_access_token = new_access
                        _cached_refresh_token = new_refresh
                        _cached_expires_at = new_expires_s
                        _cache_valid = True

                    return _build_oauth_response(updated, new_access, new_refresh, new_expires_s)
                except Exception as exc:
                    exc_str = str(exc)
                    if "TOKEN_REFRESH_AUTH_FAILED" in exc_str:
                        logger.error("[TOKEN-READ] Token refresh AUTH FAILED — refresh token is dead: %s", exc)
                        raise
                    logger.error("[TOKEN-READ] Token refresh transient failure (%s) — using current disk token.", exc)
                    # Transient error (network, timeout): return existing token but DON'T
                    # sync to MongoDB — avoids overwriting a potentially good stored token
                    # with a dead one.
                    oauth = {"accessToken": disk_access, "refreshToken": disk_refresh, "expiresAt": disk_expires_raw}
                    with _cache_lock:
                        _cached_oauth = oauth
                        _cached_access_token = disk_access
                        _cached_refresh_token = disk_refresh
                        _cached_expires_at = disk_expires_s
                        _cache_valid = True
                    return _build_oauth_response(oauth, disk_access, disk_refresh, disk_expires_s)

            # Token is fresh — sync to MongoDB only when refresh token has changed
            with _cache_lock:
                already_synced = _cache_valid and _cached_refresh_token == disk_refresh

            oauth = {"accessToken": disk_access, "refreshToken": disk_refresh, "expiresAt": disk_expires_raw}
            if not already_synced:
                save_oauth(oauth, reason="disk_synced")
                logger.info("[TOKEN-READ] Disk credentials synced to MongoDB.")
                with _cache_lock:
                    _cached_oauth = oauth
                    _cached_access_token = disk_access
                    _cached_refresh_token = disk_refresh
                    _cached_expires_at = disk_expires_s
                    _cache_valid = True
            else:
                with _cache_lock:
                    oauth = _cached_oauth or oauth

            return _build_oauth_response(oauth, disk_access, disk_refresh, disk_expires_s)

    # --- User device (or master with no disk file): read from MongoDB ---
    logger.debug("[TOKEN-READ] User device — reading token from MongoDB.")
    oauth = get_stored_oauth()
    if not oauth:
        logger.error("[TOKEN-READ] No credentials found in MongoDB!")
        raise RuntimeError(
            "No Claude credentials found in database. "
            "The master device must sync credentials first."
        )

    access_token = (oauth.get("accessToken") or "").strip()
    refresh_token = (oauth.get("refreshToken") or "").strip()
    expires_at_s = _ms_or_s_to_seconds(oauth.get("expiresAt") or 0)

    with _cache_lock:
        _cached_oauth = oauth
        _cached_access_token = access_token
        _cached_refresh_token = refresh_token
        _cached_expires_at = expires_at_s
        _cache_valid = True

    return _build_oauth_response(oauth, access_token, refresh_token, expires_at_s)


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

    if not is_master_device():
        logger.info("Backend credential watcher: not master device, skipping.")
        return

    # Seed the last-known refresh token so the first tick doesn't trigger a
    # spurious sync when disk and MongoDB are already in sync.
    disk_refresh, _, _ = _read_disk_oauth()
    with _disk_watcher_lock:
        _disk_watcher_last_refresh = disk_refresh

    logger.info("Backend credential watcher started (interval=%ss) on master device.", interval_seconds)

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
                "Backend credential watcher: refresh token rotated on disk (disk=%s..., stored=%s...).",
                disk_refresh[:8] if disk_refresh else 'none',
                stored_refresh[:8] if stored_refresh else 'none',
            )

            # Compare freshness before syncing — only overwrite MongoDB if
            # the disk token is actually newer, otherwise claude CLI writing
            # stale creds could corrupt a freshly-refreshed token in MongoDB.
            disk_expires_s = _ms_or_s_to_seconds(disk_expires)
            stored_expires_raw = (stored or {}).get("expiresAt", 0)
            stored_expires_s = _ms_or_s_to_seconds(stored_expires_raw)

            if stored and stored_refresh and stored_expires_s >= disk_expires_s:
                logger.info(
                    "Backend credential watcher: MongoDB token is at least as fresh as disk "
                    "(disk expiresAt=%s, db expiresAt=%s). Skipping sync.",
                    disk_expires_s, stored_expires_s,
                )
                # Update last_refresh so we don't reprocess the same file change
                with _disk_watcher_lock:
                    _disk_watcher_last_refresh = disk_refresh
                continue

            logger.info(
                "Backend credential watcher: disk token is fresher than MongoDB (disk expiresAt=%s, db expiresAt=%s). "
                "Syncing disk → MongoDB.",
                disk_expires_s, stored_expires_s,
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

    Only runs on master device.

    WHY this lives in the backend (not Electron):
      The master host runs the backend 24/7 on a server but does NOT keep the
      Electron UI open. The Electron fs.watch is therefore never running on the
      host machine. This backend watcher is the only process that is always
      alive and can detect token rotation caused by the host running `claude`
      directly in a terminal.
    """
    if not is_master_device():
        logger.info("Disk credential watcher: not master device, skipping.")
        return

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


_master_refresh_thread: Optional[threading.Thread] = None


def _master_refresh_loop(interval_seconds: int = 300) -> None:
    """
    Master-only background loop that proactively refreshes the token
    before it expires. This ensures MongoDB always has a fresh token
    that user devices can read.

    Runs every 5 minutes and only refreshes when token is 5 minutes from expiry.
    Only runs on master device.
    """
    import sys
    print(f"[MASTER-REFRESH] >>> Background loop started (interval={interval_seconds}s, refresh_margin={_CACHE_MARGIN_SECONDS}s)", flush=True, file=sys.stderr)
    logger.info("[MASTER-REFRESH] Background loop started (interval=%ss, refresh_margin=%ss).",
                interval_seconds, _CACHE_MARGIN_SECONDS)

    # Do an immediate first check so that expired tokens are refreshed right away
    # rather than waiting `interval_seconds` before the first check.
    _do_master_refresh_check()

    while True:
        time.sleep(interval_seconds)
        _do_master_refresh_check()


def _do_master_refresh_check() -> None:
    """Performs one iteration of the master refresh check."""
    import sys
    print(f"[MASTER-REFRESH] >>> Checking token expiry status at {time.strftime('%H:%M:%S')}...", flush=True, file=sys.stderr)
    logger.info("[MASTER-REFRESH] Checking token expiry status...")

    if not is_master_device():
        logger.warning("[MASTER-REFRESH] Not master device, stopping loop.")
        return

    try:
        # Step 1: Read from local disk first (primary source), fall back to MongoDB
        disk_refresh, disk_access, disk_expires_raw = _read_disk_oauth()
        if disk_refresh:
            refresh_token = disk_refresh
            expires_at_s = _ms_or_s_to_seconds(disk_expires_raw)
            logger.info("[MASTER-REFRESH] Reading credentials from local disk.")
        else:
            oauth = get_stored_oauth()
            if not oauth:
                logger.warning("[MASTER-REFRESH] No credentials on disk or in DB, skipping.")
                return
            refresh_token = (oauth.get("refreshToken") or "").strip()
            expires_at_s = _ms_or_s_to_seconds(oauth.get("expiresAt") or 0)
            logger.info("[MASTER-REFRESH] No disk credentials — reading from MongoDB.")
        now = time.time()
        time_until_expiry = expires_at_s - now
        refresh_threshold = now + _CACHE_MARGIN_SECONDS
        needs_refresh = expires_at_s <= refresh_threshold

        logger.info("[MASTER-REFRESH] Token expires in %ss (threshold: %ss from now)",
                    time_until_expiry, _CACHE_MARGIN_SECONDS)
        logger.info("[MASTER-REFRESH] Check: expires_at_s (%s) <= threshold (%s) = %s",
                    int(expires_at_s), int(refresh_threshold), needs_refresh)

        # Step 2: Check if token needs refresh (5 minutes before expiry)
        if not needs_refresh:
            logger.info("[MASTER-REFRESH] Token is FRESH (expires at %s > threshold %s), skipping refresh.",
                       int(expires_at_s), int(refresh_threshold))
            return

        # Step 3: Token expired or expiring soon - refresh it
        logger.warning("[MASTER-REFRESH] Token needs REFRESH! (expires at %s <= threshold %s)",
                      int(expires_at_s), int(refresh_threshold))
        logger.warning("[MASTER-REFRESH] Refreshing token now...")

        if not refresh_token:
            logger.error("[MASTER-REFRESH] No refresh token in DB, cannot refresh!")
            return

        logger.info("[MASTER-REFRESH] Calling Anthropic OAuth to refresh token...")
        result = _do_refresh(refresh_token)

        new_access = (result.get("access_token") or result.get("accessToken") or "").strip()
        new_refresh = (result.get("refresh_token") or result.get("refreshToken") or "").strip() or refresh_token
        expires_in = int(result.get("expires_in") or 3600)
        new_expires_at_s = now + expires_in

        if not new_access:
            logger.error("[MASTER-REFRESH] OAuth refresh returned no access token!")
            return

        logger.info("[MASTER-REFRESH] Token refreshed successfully!")
        logger.info("[MASTER-REFRESH] New token expires in %ss", expires_in)

        # Step 4: Build updated oauth, merging any extra fields from MongoDB if available
        scope = (result.get("scope") or "").strip()
        base = locals().get("oauth") or {}
        updated_oauth = {
            **base,
            "accessToken": new_access,
            "refreshToken": new_refresh,
            "expiresAt": int(new_expires_at_s * 1000),
            "subscriptionType": result.get("subscriptionType") or "free",
            "rateLimitTier": result.get("rateLimitTier") or "default_claude_free_1x",
        }
        if scope:
            updated_oauth["scope"] = scope

        logger.info("[MASTER-REFRESH] Writing refreshed token to disk and MongoDB...")
        write_token_to_disk(updated_oauth, reason="master_background_refresh")
        save_oauth(updated_oauth, reason="master_background_refresh")
        clear_cache()
        logger.info("[MASTER-REFRESH] Token refreshed — disk and MongoDB updated.")
        logger.info("[MASTER-REFRESH] New refreshToken: %s..., accessToken: %s...",
                    new_refresh[:10], new_access[:10])

    except Exception as exc:
        logger.error("[MASTER-REFRESH] Error during token refresh: %s", exc)


def start_master_refresh_loop(interval_seconds: int = 5 * 60) -> None:
    """
    Starts the master-only background token refresh loop.
    This ensures MongoDB always has a fresh token for user devices.
    Runs every 5 minutes.
    """
    global _master_refresh_thread

    if not is_master_device():
        logger.info("[MASTER-REFRESH] Not master device, skipping refresh loop.")
        return

    if _master_refresh_thread and _master_refresh_thread.is_alive():
        logger.info("[MASTER-REFRESH] Loop already running, skipping.")
        return

    _master_refresh_thread = threading.Thread(
        target=_master_refresh_loop,
        args=(interval_seconds,),
        daemon=True,
        name="claude-master-refresh",
    )
    _master_refresh_thread.start()
    logger.info("[MASTER-REFRESH] Background refresh loop started (every 5 minutes).")


def reconcile_disk_credentials() -> None:
    """
    Called at every backend startup. Compares ~/.claude/.credentials.json with
    MongoDB and syncs whichever has the more recently refreshed token (decided
    by expiresAt timestamp).

    Only runs on master device - user devices should not reconcile disk with DB.

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
    if not is_master_device():
        logger.info("Startup reconcile: not master device, skipping.")
        return

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
                "Leaving disk unchanged — claude CLI manages its own credentials file.",
                stored_exp_s, disk_exp_s,
            )

    except Exception as exc:
        logger.warning("Startup reconcile failed (non-fatal): %s", exc)

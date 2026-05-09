from __future__ import annotations

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
    Returns { accessToken, expiresAt } with a valid, non-expired access token.

    Flow:
      1. Hit in-memory cache (avoids DB round-trip within 50-min window).
      2. Read full OAuth object from MongoDB.
      3. If access token is still fresh enough, cache and return it.
      4. Otherwise call Anthropic with the stored refresh token.
      5. Save the new OAuth (new accessToken + possibly rotated refreshToken) back to DB.
      6. Update cache and return.
    """
    global _cached_access_token, _cached_expires_at

    now = time.time()

    # 1. In-memory cache hit
    with _cache_lock:
        if _cached_access_token and _cached_expires_at > now + _CACHE_MARGIN_SECONDS:
            return {
                "accessToken": _cached_access_token,
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
            _cached_expires_at = expires_at_s
        return {"accessToken": access_token, "expiresAt": int(expires_at_s * 1000)}

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
        _cached_expires_at = new_expires_at_s

    logger.info("Claude access token refreshed successfully. Expires in %ss.", expires_in)
    return {"accessToken": new_access, "expiresAt": int(new_expires_at_s * 1000)}

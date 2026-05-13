from __future__ import annotations

import os
import logging
import time
import threading

from fastapi import Request
from fastapi.responses import JSONResponse

from .auth import get_user_for_token, has_users

logger = logging.getLogger("security.middleware")

_ALLOWLIST_PREFIXES: tuple[str, ...] = (
    "/favicon.ico",
    "/health",
    "/auth/status",
    "/auth/login",
    "/auth/claude-token",
    "/auth/claude-credentials-internal",
    "/auth/sso",
    "/download",
    "/docs",
    "/openapi.json",
    "/mobile",
    "/terminal/cli/data",
)

def _is_allowlisted(path: str) -> bool:
    return any(path.startswith(p) for p in _ALLOWLIST_PREFIXES)

def _extract_bearer_token(request: Request) -> str:
    auth = request.headers.get("authorization") or ""
    if auth.lower().startswith("bearer "):
        return auth.split(" ", 1)[-1].strip()
    return request.headers.get("x-auth-token", "").strip()

# Cache whether users exist to avoid a MongoDB round-trip on every request.
# Refreshed every 30 seconds in the background.
_users_exist_cache: bool | None = None
_users_exist_lock = threading.Lock()
_users_exist_last_checked: float = 0.0
_USERS_CACHE_TTL = 30.0  # seconds

def _get_users_exist() -> bool:
    global _users_exist_cache, _users_exist_last_checked
    now = time.monotonic()
    with _users_exist_lock:
        if _users_exist_cache is not None and (now - _users_exist_last_checked) < _USERS_CACHE_TTL:
            return _users_exist_cache
    try:
        result = has_users()
        with _users_exist_lock:
            _users_exist_cache = result
            _users_exist_last_checked = now
        return result
    except Exception as e:
        logger.warning("has_users() failed, allowing access: %s", e)
        return False  # DB down → allow through

class AuthMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return

        method = scope.get("method")
        path = scope.get("path") or ""

        if method == "OPTIONS":
            await self.app(scope, receive, send)
            return
        if _is_allowlisted(path):
            await self.app(scope, receive, send)
            return

        auth_required = os.environ.get("NEBULA_AUTH_REQUIRED", "true").lower() == "true"
        if not auth_required:
            await self.app(scope, receive, send)
            return

        # Cached check — no MongoDB round-trip on every request
        if not _get_users_exist():
            await self.app(scope, receive, send)
            return

        request = Request(scope, receive=receive)
        token = _extract_bearer_token(request)
        user = get_user_for_token(token)
        if not user:
            res = JSONResponse({"error": "Unauthorized"}, status_code=401)
            await res(scope, receive, send)
            return

        scope.setdefault("state", {})["user"] = user
        await self.app(scope, receive, send)


def get_request_user(request: Request):
    return getattr(request.state, "user", None)

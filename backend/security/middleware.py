from __future__ import annotations

import logging
from typing import Callable, Iterable, Optional

from fastapi import Request
from fastapi.responses import JSONResponse

from .auth import get_user_for_token, has_users

# Define logger at module level
logger = logging.getLogger("security.middleware")


_ALLOWLIST_PREFIXES: tuple[str, ...] = (
    "/favicon.ico",
    "/health",
    "/auth/status",
    "/auth/login",
    "/download",
    "/docs",
    "/openapi.json",
    "/mobile",  # mobile companion uses its own session token
    "/terminal/cli/data",  # Electron relays PTY data without auth headers
)


def _is_allowlisted(path: str) -> bool:
    return any(path.startswith(p) for p in _ALLOWLIST_PREFIXES)


def _extract_bearer_token(request: Request) -> str:
    auth = request.headers.get("authorization") or ""
    if auth.lower().startswith("bearer "):
        return auth.split(" ", 1)[-1].strip()
    return request.headers.get("x-auth-token", "").strip()


class AuthMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return

        method = scope.get("method")
        path = scope.get("path") or ""
        print(f"DEBUG: AuthMiddleware processing {method} {path}")

        if method == "OPTIONS":
            await self.app(scope, receive, send)
            return
        if _is_allowlisted(path):
            await self.app(scope, receive, send)
            return

        try:
            import os
            auth_required = os.environ.get("NEBULA_AUTH_REQUIRED", "true").lower() == "true"
            if not auth_required:
                await self.app(scope, receive, send)
                return

            # Check if users exist. If this fails (DB down), we fallback to allowing access
            # so the frontend doesn't get a 503 and block the whole IDE.
            try:
                users_exist = has_users()
            except Exception as e:
                try:
                    logger.warning("Auth check failed (DB likely down): %s. Allowing access.", e)
                except NameError:
                    print(f"WARNING: Auth check failed (DB likely down): {e}. Allowing access.")
                await self.app(scope, receive, send)
                return

            if not users_exist:
                # If no users exist, we still allow access so the user can use the IDE
                # or reach the admin setup page.
                await self.app(scope, receive, send)
                return
        except Exception as e:
            try:
                logger.error("Middleware error: %s", e)
            except NameError:
                print(f"CRITICAL: Middleware error (logger not defined): {e}")
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

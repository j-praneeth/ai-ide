import logging
import secrets
import time
import html as _html
from urllib.parse import urlencode
from fastapi import APIRouter, Request
from fastapi import Form
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse

logger = logging.getLogger("security.routes")

from .auth import (
    ROLE_SUPER_ADMIN,
    ROLE_USER,
    User,
    authenticate,
    create_user,
    get_user_for_token,
    has_users,
    issue_jwt,
    list_users,
    record_login_audit,
)
from .middleware import get_request_user

router = APIRouter(prefix="/auth", tags=["auth"])


# ── Claude token distribution ──────────────────────────────────────────────────

@router.get("/claude-token")
def get_claude_token(request: Request):
    """
    Returns a guaranteed-fresh Claude access token.
    No auth required — called by the Electron app before spawning Claude CLI.
    The backend holds the master refresh token and handles rotation automatically.

    Token refresh is performed on every request to ensure valid tokens.
    Only the master device (CLAUDE_MASTER_MODE=true) saves the refreshed token to DB.
    User devices get fresh tokens but don't persist to DB (DB stays synced via master).
    """
    from .claude_token import get_fresh_access_token

    try:
        data = get_fresh_access_token()
        return {"ok": True, **data}
    except Exception as e:
        err_str = str(e)
        logger.warning("Claude token fetch failed: %s", err_str)
        if "TOKEN_REFRESH_AUTH_FAILED" in err_str:
            return JSONResponse({"ok": False, "error": err_str, "authFailure": True}, status_code=502)
        if "TOKEN_REFRESH_NETWORK_ERROR" in err_str:
            return JSONResponse({"ok": False, "error": err_str, "authFailure": False}, status_code=502)
        return JSONResponse({"ok": False, "error": err_str}, status_code=503)


@router.get("/claude-token-sync")
def get_claude_token_for_sync():
    """
    Returns the current stored token from database (no refresh attempt).
    Used by user devices to sync their local .credentials.json with the database.
    """
    from .claude_token import get_token_for_sync
    try:
        data = get_token_for_sync()
        return {"ok": True, **data}
    except Exception as e:
        err_str = str(e)
        logger.warning("Claude token sync failed: %s", err_str)
        return JSONResponse({"ok": False, "error": err_str}, status_code=503)


@router.get("/is-master-device")
def check_is_master_device():
    """
    Returns whether this backend is running on the master device.
    Electron uses this to decide whether to run credential watcher.
    """
    from .claude_token import is_master_device
    return {"isMaster": is_master_device()}


@router.post("/claude-credentials")
async def seed_claude_credentials(request: Request):
    """
    Admin-only. POST the full claudeAiOauth object (from ~/.claude/.credentials.json)
    to seed or update the master credentials in MongoDB.

    Body: { "oauth": { "refreshToken": "...", "accessToken": "...", "expiresAt": 123... } }
    """
    from .claude_token import save_oauth, clear_cache, get_fresh_access_token
    from .middleware import get_request_user

    user = get_request_user(request)
    if not user or user.role != ROLE_SUPER_ADMIN:
        return JSONResponse({"error": "Forbidden"}, status_code=403)

    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "Invalid JSON"}, status_code=400)

    oauth = body.get("oauth") if isinstance(body, dict) else None
    if not isinstance(oauth, dict) or not oauth.get("refreshToken"):
        return JSONResponse({"error": "Body must be { oauth: { refreshToken, ... } }"}, status_code=400)

    save_oauth(oauth, reason="admin_paste")
    clear_cache()

    # Validate by performing an immediate refresh — gives the admin one-click feedback
    # instead of "save succeeded → check creds → 401". A side effect is that Anthropic
    # may rotate the refresh token now; get_fresh_access_token() already persists the
    # rotated token to MongoDB, so the DB always ends up holding the live token.
    try:
        fresh = get_fresh_access_token()
        return {
            "ok": True,
            "message": "Claude master credentials updated and validated.",
            "expiresAt": fresh.get("expiresAt"),
        }
    except Exception as exc:
        err = str(exc)
        if "TOKEN_REFRESH_AUTH_FAILED" in err:
            return JSONResponse(
                {
                    "ok": False,
                    "error": err,
                    "authFailure": True,
                    "hint": (
                        "Anthropic rejected this refresh token. Re-run `claude` on a "
                        "logged-in machine, then immediately copy ~/.claude/.credentials.json "
                        "(refresh tokens rotate on every use)."
                    ),
                },
                status_code=400,
            )
        if "TOKEN_REFRESH_NETWORK_ERROR" in err:
            return JSONResponse({"ok": False, "error": err}, status_code=502)
        return JSONResponse({"ok": False, "error": err}, status_code=500)

@router.post("/claude-credentials-internal")
async def sync_claude_credentials_internal(request: Request):
    """
    Localhost-only (no JWT needed). Called by Electron when Claude CLI rotates the
    refresh token on disk, so the new token is synced back to MongoDB before it expires.

    Only accepted from master device - user devices should not sync credentials to DB.
    """
    from .claude_token import save_oauth, clear_cache, get_stored_oauth, is_master_device

    client_host = (request.client.host if request.client else "") or ""
    if client_host not in ("127.0.0.1", "::1", "localhost", ""):
        logger.warning("claude-credentials-internal rejected from %s", client_host)
        return JSONResponse({"error": "Forbidden"}, status_code=403)

    if not is_master_device():
        logger.warning("claude-credentials-internal rejected: not master device")
        return JSONResponse({"error": "Credential sync only allowed on master device"}, status_code=403)

    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "Invalid JSON"}, status_code=400)

    oauth = body.get("oauth") if isinstance(body, dict) else None
    if not isinstance(oauth, dict) or not oauth.get("refreshToken"):
        return JSONResponse({"error": "Body must be { oauth: { refreshToken, ... } }"}, status_code=400)

    # Merge with existing DB entry to preserve enriched fields (scopes,
    # subscriptionType, rateLimitTier) that the Electron file watcher may
    # not include in its partial POST body.
    existing = get_stored_oauth()
    if existing:
        oauth = {**existing, **oauth}

    save_oauth(oauth, reason="admin_paste")
    clear_cache()
    logger.info("Claude credentials synced via internal endpoint (refresh token rotation).")
    return {"ok": True}


_SSO_CODE_TTL_SECONDS = 180
_sso_codes: dict[str, dict] = {}


def _sso_prune() -> None:
    now = time.time()
    expired = [k for k, v in list(_sso_codes.items()) if (v or {}).get("exp", 0) <= now]
    for k in expired:
        _sso_codes.pop(k, None)


def _safe_redirect_uri(value: str) -> str:
    """
    Only allow redirects to our custom protocol (desktop deep link).
    """
    v = (value or "").strip()
    if v.startswith("nebula://"):
        return v
    return "nebula://auth"


@router.get("/sso/start")
def sso_start(redirect_uri: str = "nebula://auth", state: str = "", error: str = ""):
    redirect_uri = _safe_redirect_uri(redirect_uri)
    state = (state or "").strip()[:200]
    show_error = (error or "").strip() == "1"
    redirect_uri_esc = _html.escape(redirect_uri, quote=True)
    state_esc = _html.escape(state, quote=True)
    html = f"""
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Nebula IDE – Sign In</title>
    <style>
      :root {{ color-scheme: dark; }}
      body {{ margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; background: #0b0c10; color: #e5e7eb; }}
      .wrap {{ min-height: 100vh; display: grid; place-items: center; padding: 24px; }}
      .card {{ width: 420px; max-width: 95vw; background: #0f1118; border: 1px solid #232634; border-radius: 14px; padding: 18px; box-shadow: 0 18px 60px rgba(0,0,0,0.55); }}
      .title {{ font-weight: 900; font-size: 16px; }}
      .sub {{ margin-top: 6px; font-size: 12px; color: #9aa3b2; line-height: 1.4; }}
      label {{ display: block; margin-top: 12px; font-size: 12px; color: #9aa3b2; }}
      input {{ width: 100%; margin-top: 6px; background: #0b0c10; color: #e5e7eb; border: 1px solid #232634; border-radius: 10px; padding: 10px 12px; outline: none; }}
      button {{ margin-top: 14px; width: 100%; background: #f59e0b; color: #071018; border: none; border-radius: 10px; padding: 10px 12px; font-weight: 900; cursor: pointer; }}
      .hint {{ margin-top: 10px; font-size: 11px; color: #778199; }}
      .err {{ margin-top: 10px; font-size: 12px; color: #f87171; font-weight: 700; }}
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="card">
        <div class="title">Sign in to Nebula IDE</div>
        <div class="sub">This will open the desktop app automatically after sign-in.</div>
        <form method="post" action="/auth/sso/login">
          <input type="hidden" name="redirect_uri" value="{redirect_uri_esc}" />
          <input type="hidden" name="state" value="{state_esc}" />
          <label>Email</label>
          <input name="email" autocomplete="username" autofocus />
          <label>Password</label>
          <input name="password" type="password" autocomplete="current-password" />
          <button type="submit">Sign In</button>
        </form>
        {('<div class="err">Invalid email or password.</div>' if show_error else '')}
        <div class="hint">If the app does not open, make sure Nebula IDE is installed.</div>
      </div>
    </div>
  </body>
</html>
"""
    return HTMLResponse(content=html, headers={"Cache-Control": "no-store"})


@router.post("/sso/login")
def sso_login(
    email: str = Form(default=""),
    password: str = Form(default=""),
    redirect_uri: str = Form(default="nebula://auth"),
    state: str = Form(default=""),
):
    redirect_uri = _safe_redirect_uri(redirect_uri)
    state = (state or "").strip()[:200]

    _sso_prune()
    user = authenticate((email or "").strip(), (password or "").strip())
    if not user:
        # Redirect back to start with a simple error flag (keeps this flow lightweight).
        qs = urlencode({"redirect_uri": redirect_uri, "state": state, "error": "1"})
        return RedirectResponse(url=f"/auth/sso/start?{qs}", status_code=302)

    code = secrets.token_urlsafe(24)
    _sso_codes[code] = {"user_id": user.id, "exp": time.time() + _SSO_CODE_TTL_SECONDS}

    sep = "&" if "?" in redirect_uri else "?"
    qs = urlencode({"code": code, "state": state})
    return RedirectResponse(url=f"{redirect_uri}{sep}{qs}", status_code=302)


@router.post("/sso/exchange")
async def sso_exchange(request: Request):
    try:
        body = await request.json()
    except Exception:
        body = {}

    code = ""
    if isinstance(body, dict):
        code = (body.get("code") or "").strip()

    _sso_prune()
    record = _sso_codes.pop(code, None) if code else None
    if not record:
        return JSONResponse({"error": "Invalid or expired code"}, status_code=400)

    from db.mongo import users_collection
    doc = users_collection().find_one({"_id": record.get("user_id")})
    if not doc:
        return JSONResponse({"error": "User not found"}, status_code=404)

    user_obj = User(id=str(doc.get("_id")), email=doc.get("email") or "", role=doc.get("role") or ROLE_USER)
    token = issue_jwt(user_obj)
    return {"token": token, "user": {"id": user_obj.id, "email": user_obj.email, "role": user_obj.role}}


@router.get("/status")
def status():
    try:
        h = has_users()
        return {
            "has_users": h, 
            "auth_required": h,
            "db_connected": True
        }
    except Exception as e:
        from db.mongo import _get_mongodb_uri
        uri = _get_mongodb_uri()
        print(f"DEBUG: Status check failed (DB down): {e}")
        return {
            "has_users": False, 
            "auth_required": True, 
            "db_connected": False,
            "error": f"Database connection failed. Please ensure MongoDB is running at {uri}. Error: {str(e)}"
        }


@router.post("/login")
async def login(request: Request):
    print(f"DEBUG: Login request received")
    try:
        try:
            body = await request.json()
        except Exception as e:
            print(f"DEBUG: Failed to parse JSON body: {e}")
            return JSONResponse({"error": "Invalid JSON body"}, status_code=400)

        email = (body.get("email") or "").strip()
        password = (body.get("password") or "").strip()
        print(f"DEBUG: Login attempt for email: {email}")
        
        try:
            user = authenticate(email, password)
        except Exception as e:
            # Database might be down
            print(f"DEBUG: Authenticate failed: {e}")
            logger.error("Login failed (auth backend error): %s", e)
            return JSONResponse(
                status_code=503,
                content={"error": "Authentication service is currently unavailable. Please check if the database is running."}
            )

        if not user:
            print(f"DEBUG: User not found or password incorrect")
            try:
                record_login_audit(None, ok=False, ip=request.client.host if request.client else "", user_agent=request.headers.get("user-agent", ""))
            except Exception:
                pass # Audit failure shouldn't block login failure response
            return JSONResponse(
                status_code=401,
                content={"error": "Invalid email or password"}
            )
            
        print(f"DEBUG: User authenticated: {user.email}")
        try:
            token = issue_jwt(user)
        except Exception as e:
            print(f"DEBUG: issue_jwt failed: {e}")
            return JSONResponse(
                status_code=500,
                content={"error": f"Failed to issue token: {str(e)}"}
            )
            
        try:
            record_login_audit(user, ok=True, ip=request.client.host if request.client else "", user_agent=request.headers.get("user-agent", ""))
        except Exception as e:
            print(f"DEBUG: record_login_audit failed: {e}")
            pass # Audit failure shouldn't block successful login
            
        print(f"DEBUG: Login successful for {user.email}")
        return {"token": token, "user": {"id": user.id, "email": user.email, "role": user.role}}
    except Exception as e:
        print(f"DEBUG: Unexpected error in login route: {e}")
        logger.error("Unexpected error in login route: %s", e)
        return JSONResponse(
            status_code=500,
            content={"error": f"An unexpected error occurred: {str(e)}"}
        )


@router.post("/logout")
def logout(request: Request):
    return {"status": "ok"}


@router.get("/me")
def me(request: Request):
    user = get_request_user(request)
    if not user:
        return {"user": None}
    return {"user": {"id": user.id, "email": user.email, "role": user.role}}


@router.post("/users")
async def create_user_route(request: Request):
    current = get_request_user(request)
    if not current or current.role != ROLE_SUPER_ADMIN:
        return {"error": "Forbidden"}

    body = await request.json()
    email = (body.get("email") or "").strip()
    password = (body.get("password") or "").strip()
    role = (body.get("role") or ROLE_USER).strip()
    if role not in (ROLE_SUPER_ADMIN, ROLE_USER):
        return {"error": "Invalid role"}
    if not email or not password:
        return {"error": "email and password are required"}

    try:
        user = create_user(email=email, password=password, role=role)
        return {"user": {"id": user.id, "email": user.email, "role": user.role}}
    except Exception as e:
        return {"error": str(e)}


@router.get("/users")
def list_users_route(request: Request):
    current = get_request_user(request)
    if not current or current.role != ROLE_SUPER_ADMIN:
        return {"error": "Forbidden"}
    try:
        return {"users": list_users()}
    except Exception as e:
        return {"error": str(e)}

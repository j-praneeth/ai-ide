from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from admin_config import clear_claude_cli_config, get_claude_cli_config_summary, set_claude_cli_config
from db.mongo import users_collection, utcnow
from security.middleware import get_request_user


router = APIRouter(prefix="/admin", tags=["admin"])


@router.get("/config/claude-cli")
def get_claude_cli_config_route(request: Request):
    user = get_request_user(request)
    if not user or user.role != "super_admin":
        return JSONResponse({"error": "Forbidden"}, status_code=403)
    return {"claude_cli": get_claude_cli_config_summary()}


@router.post("/config/claude-cli")
async def set_claude_cli_config_route(request: Request):
    user = get_request_user(request)
    if not user or user.role != "super_admin":
        return JSONResponse({"error": "Forbidden"}, status_code=403)

    body = await request.json()
    if not isinstance(body, dict):
        return JSONResponse({"error": "Invalid body"}, status_code=400)

    api_key = (body.get("api_key") or "").strip()
    oauth_token = (body.get("oauth_token") or "").strip()
    if not api_key and not oauth_token:
        return JSONResponse({"error": "Provide api_key or oauth_token"}, status_code=400)

    summary = set_claude_cli_config(api_key=api_key, oauth_token=oauth_token)

    # Provision all existing users (no user-side config required).
    res = users_collection().update_many(
        {},
        {
            "$set": {
                "claude_cli_provisioned": True,
                "claude_cli_provisioned_at": utcnow(),
            }
        },
    )

    return {"ok": True, "claude_cli": summary, "provisioned_users": int(res.modified_count)}


@router.post("/config/claude-cli/clear")
def clear_claude_cli_config_route(request: Request):
    user = get_request_user(request)
    if not user or user.role != "super_admin":
        return JSONResponse({"error": "Forbidden"}, status_code=403)

    clear_claude_cli_config()
    users_collection().update_many(
        {},
        {
            "$unset": {
                "claude_cli_provisioned": "",
                "claude_cli_provisioned_at": "",
            }
        },
    )
    return {"ok": True}


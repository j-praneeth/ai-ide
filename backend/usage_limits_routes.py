from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from datetime import datetime, timezone
from security.middleware import get_request_user
from db.mongo import get_db, is_mongo_available

router = APIRouter(prefix="/usage-limits", tags=["usage-limits"])

# Per-user session/token limits enforced by the Electron cli:start pre-flight check.
MAX_SESSIONS_STORED = 500

_UNLIMITED = {"allowed": True, "reason": "", "usage": {}, "limit": {}}


def _limits_col():
    return get_db()["usage_limits"]


def _stats_col():
    return get_db()["token_stats"]


def _is_admin(user) -> bool:
    return user is not None and user.role == "super_admin"


def _fmt_limit(doc: dict) -> dict:
    doc.pop("_id", None)
    return doc


@router.get("/all")
def get_all_limits(request: Request):
    user = get_request_user(request)
    if not _is_admin(user):
        return JSONResponse({"error": "Forbidden"}, status_code=403)
    if not is_mongo_available():
        return {"ok": True, "data": []}
    docs = list(_limits_col().find({}, {"_id": 0}).sort("email", 1).limit(MAX_SESSIONS_STORED))
    return {"ok": True, "data": docs}


@router.put("/users/{user_id}")
async def upsert_limit(user_id: str, request: Request):
    admin = get_request_user(request)
    if not _is_admin(admin):
        return JSONResponse({"error": "Forbidden"}, status_code=403)
    if not is_mongo_available():
        return {"ok": True, "stored": False}
    body = await request.json()
    sessions_per_day = body.get("sessions_per_day")
    tokens_per_month = body.get("tokens_per_month")
    enabled = bool(body.get("enabled", True))
    email = body.get("email", "")
    _limits_col().update_one(
        {"user_id": user_id},
        {"$set": {
            "user_id": user_id,
            "email": email,
            "sessions_per_day": sessions_per_day,
            "tokens_per_month": tokens_per_month,
            "enabled": enabled,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }},
        upsert=True,
    )
    return {"ok": True, "stored": True}


@router.delete("/users/{user_id}")
def delete_limit(user_id: str, request: Request):
    admin = get_request_user(request)
    if not _is_admin(admin):
        return JSONResponse({"error": "Forbidden"}, status_code=403)
    if not is_mongo_available():
        return {"ok": True, "deleted": False}
    _limits_col().delete_one({"user_id": user_id})
    return {"ok": True, "deleted": True}


@router.get("/check")
def check_limit(request: Request):
    user = get_request_user(request)
    if not user:
        return JSONResponse({"error": "Unauthorized"}, status_code=401)
    if not is_mongo_available():
        return {"ok": True, **_UNLIMITED}

    limit_doc = _limits_col().find_one({"user_id": str(user.id)}, {"_id": 0})
    if not limit_doc or not limit_doc.get("enabled", False):
        return {"ok": True, **_UNLIMITED}

    stats_doc = _stats_col().find_one({"user_id": str(user.id)}, {"_id": 0}) or {}
    usage: dict = {}

    sessions_limit = limit_doc.get("sessions_per_day")
    if sessions_limit is not None:
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        daily = stats_doc.get("recent_daily") or []
        today_entry = next((d for d in daily if d.get("date") == today), None)
        sessions_today = today_entry.get("session_count", 0) if today_entry else 0
        usage["sessions_today"] = sessions_today
        if sessions_today >= sessions_limit:
            return {
                "ok": True,
                "allowed": False,
                "reason": f"Daily session limit reached ({sessions_today}/{sessions_limit} sessions today).",
                "usage": usage,
                "limit": {"sessions_per_day": sessions_limit},
            }

    tokens_limit = limit_doc.get("tokens_per_month")
    if tokens_limit is not None:
        total_input = (stats_doc.get("stats") or {}).get("total_input", 0) or 0
        usage["total_input"] = total_input
        if total_input >= tokens_limit:
            return {
                "ok": True,
                "allowed": False,
                "reason": f"Monthly token limit reached ({total_input:,}/{tokens_limit:,} tokens).",
                "usage": usage,
                "limit": {"tokens_per_month": tokens_limit},
            }

    return {"ok": True, "allowed": True, "reason": "", "usage": usage, "limit": limit_doc}

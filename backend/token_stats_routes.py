from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from datetime import datetime
from security.middleware import get_request_user
from db.mongo import get_db, is_mongo_available

router = APIRouter(prefix="/token-stats", tags=["token-stats"])


def _col():
    return get_db()["token_stats"]


@router.post("/sync")
async def sync_token_stats(request: Request):
    user = get_request_user(request)
    if not user:
        return JSONResponse({"error": "Unauthorized"}, status_code=401)
    if not is_mongo_available():
        return {"ok": True, "stored": False}
    body = await request.json()
    _col().update_one(
        {"user_id": str(user.id)},
        {"$set": {
            "user_id": str(user.id),
            "email": user.email,
            "last_sync": datetime.utcnow().isoformat(),
            "stats": body.get("stats", {}),
            "recent_daily": body.get("recent_daily", []),
        }},
        upsert=True,
    )
    return {"ok": True, "stored": True}


@router.get("/me")
def get_my_stats(request: Request):
    user = get_request_user(request)
    if not user:
        return JSONResponse({"error": "Unauthorized"}, status_code=401)
    if not is_mongo_available():
        return {"ok": True, "data": None}
    doc = _col().find_one({"user_id": str(user.id)}, {"_id": 0})
    return {"ok": True, "data": doc}


@router.get("/all")
def get_all_stats(request: Request):
    user = get_request_user(request)
    if not user or user.role != "super_admin":
        return JSONResponse({"error": "Forbidden"}, status_code=403)
    if not is_mongo_available():
        return {"ok": True, "data": []}
    docs = list(_col().find({}, {"_id": 0}).sort("last_sync", -1).limit(500))
    return {"ok": True, "data": docs}

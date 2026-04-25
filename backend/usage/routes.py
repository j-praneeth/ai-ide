import os
from datetime import datetime, timedelta
from typing import Any, Dict, List

from fastapi import APIRouter, Request

from db.mongo import usage_events_collection, users_collection
from security.middleware import get_request_user

router = APIRouter(prefix="/usage", tags=["usage"])


def _cost_usd_from_tokens(tokens: int) -> float:
    try:
        per_1k = float(os.environ.get("NEBULA_COST_PER_1K_TOKENS_USD", "0") or 0)
    except Exception:
        per_1k = 0.0
    if per_1k <= 0:
        return 0.0
    return round((tokens / 1000.0) * per_1k, 6)


def _since_days(days: int) -> datetime:
    try:
        d = max(1, int(days))
    except Exception:
        d = 30
    return datetime.utcnow() - timedelta(days=d)


def _daily_series(match: Dict[str, Any], days: int) -> List[Dict[str, Any]]:
    since = _since_days(days)
    pipeline = [
        {"$match": {**(match or {}), "ts": {"$gte": since}}},
        {
            "$group": {
                "_id": {"$dateToString": {"format": "%Y-%m-%d", "date": "$ts"}},
                "total_tokens": {"$sum": {"$ifNull": ["$total_tokens", 0]}},
                "tokens_saved": {"$sum": {"$ifNull": ["$est_tokens_saved", 0]}},
            }
        },
        {"$sort": {"_id": 1}},
    ]
    rows = list(usage_events_collection().aggregate(pipeline))
    return [
        {
            "day": r.get("_id"),
            "total_tokens": int(r.get("total_tokens") or 0),
            "tokens_saved": int(r.get("tokens_saved") or 0),
        }
        for r in rows
    ]


@router.get("/me/overview")
def me_overview(request: Request, days: int = 30):
    user = get_request_user(request)
    if not user:
        return {"error": "Unauthorized"}

    pipeline = [
        {"$match": {"user_id": user.id}},
        {
            "$group": {
                "_id": None,
                "total_tokens": {"$sum": {"$ifNull": ["$total_tokens", 0]}},
                "tokens_saved": {"$sum": {"$ifNull": ["$est_tokens_saved", 0]}},
                "calls": {"$sum": 1},
            }
        },
    ]
    rows = list(usage_events_collection().aggregate(pipeline))
    totals = rows[0] if rows else {}
    total_tokens = int(totals.get("total_tokens") or 0)
    tokens_saved = int(totals.get("tokens_saved") or 0)
    calls = int(totals.get("calls") or 0)
    daily = _daily_series({"user_id": user.id}, days=int(days))

    return {
        "user": {"id": user.id, "email": user.email, "role": user.role},
        "totals": {
            "calls": calls,
            "total_tokens": total_tokens,
            "tokens_saved": tokens_saved,
            "estimated_cost_usd": _cost_usd_from_tokens(total_tokens),
        },
        "daily": daily,
    }


@router.get("/me/sessions")
def me_sessions(request: Request, limit: int = 50):
    user = get_request_user(request)
    if not user:
        return {"error": "Unauthorized"}

    pipeline = [
        {"$match": {"user_id": user.id, "session_id": {"$ne": None}}},
        {
            "$group": {
                "_id": "$session_id",
                "last_ts": {"$max": "$ts"},
                "total_tokens": {"$sum": {"$ifNull": ["$total_tokens", 0]}},
                "tokens_saved": {"$sum": {"$ifNull": ["$est_tokens_saved", 0]}},
                "calls": {"$sum": 1},
            }
        },
        {"$sort": {"last_ts": -1}},
        {"$limit": max(1, int(limit))},
    ]
    rows = list(usage_events_collection().aggregate(pipeline))
    return {
        "sessions": [
            {
                "session_id": r.get("_id"),
                "last_ts": r.get("last_ts").timestamp() if r.get("last_ts") else 0,
                "calls": int(r.get("calls") or 0),
                "total_tokens": int(r.get("total_tokens") or 0),
                "tokens_saved": int(r.get("tokens_saved") or 0),
            }
            for r in rows
        ]
    }


@router.get("/admin/overview")
def admin_overview(request: Request, days: int = 30):
    user = get_request_user(request)
    if not user or user.role != "super_admin":
        return {"error": "Forbidden"}

    pipeline = [
        {
            "$group": {
                "_id": None,
                "total_tokens": {"$sum": {"$ifNull": ["$total_tokens", 0]}},
                "tokens_saved": {"$sum": {"$ifNull": ["$est_tokens_saved", 0]}},
                "calls": {"$sum": 1},
            }
        }
    ]
    rows = list(usage_events_collection().aggregate(pipeline))
    totals = rows[0] if rows else {}
    total_tokens = int(totals.get("total_tokens") or 0)
    tokens_saved = int(totals.get("tokens_saved") or 0)
    calls = int(totals.get("calls") or 0)
    daily = _daily_series({}, days=int(days))

    per_user_pipeline = [
        {"$match": {"user_id": {"$ne": None}}},
        {
            "$group": {
                "_id": "$user_id",
                "total_tokens": {"$sum": {"$ifNull": ["$total_tokens", 0]}},
                "tokens_saved": {"$sum": {"$ifNull": ["$est_tokens_saved", 0]}},
                "calls": {"$sum": 1},
            }
        },
        {"$sort": {"total_tokens": -1}},
    ]
    per_user = list(usage_events_collection().aggregate(per_user_pipeline))
    user_ids = [r.get("_id") for r in per_user if r.get("_id")]
    users = {
        str(u.get("_id")): {"email": u.get("email") or "", "role": u.get("role") or "user"}
        for u in users_collection().find({"_id": {"$in": user_ids}}, {"_id": 1, "email": 1, "role": 1})
    }

    return {
        "totals": {
            "calls": calls,
            "total_tokens": total_tokens,
            "tokens_saved": tokens_saved,
            "estimated_cost_usd": _cost_usd_from_tokens(total_tokens),
        },
        "daily": daily,
        "per_user": [
            {
                "user_id": str(r.get("_id")),
                "email": users.get(str(r.get("_id")), {}).get("email", ""),
                "role": users.get(str(r.get("_id")), {}).get("role", ""),
                "calls": int(r.get("calls") or 0),
                "total_tokens": int(r.get("total_tokens") or 0),
                "tokens_saved": int(r.get("tokens_saved") or 0),
            }
            for r in per_user
        ],
    }


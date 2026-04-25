import json
from typing import Any, Dict, Optional

from db.mongo import usage_events_collection, utcnow


def _as_int(value: Any) -> Optional[int]:
    try:
        if value is None:
            return None
        return int(value)
    except Exception:
        return None


def record_usage_event(
    *,
    user_id: Optional[str],
    session_id: Optional[str],
    model: Optional[str],
    provider_usage: Optional[Dict[str, Any]],
    token_optimization: Optional[Dict[str, Any]],
    skills: Optional[list],
    kind: str = "planner",
    error: Optional[str] = None,
) -> None:
    prompt_tokens = _as_int((provider_usage or {}).get("prompt_tokens"))
    completion_tokens = _as_int((provider_usage or {}).get("completion_tokens"))
    total_tokens = _as_int((provider_usage or {}).get("total_tokens"))

    provider = "unknown"
    if model:
        m = model.lower()
        if m.startswith("openai/"):
            provider = "openai"
        elif m.startswith("moonshotai/") or "kimi" in m:
            provider = "nvidia"
        else:
            provider = "ollama"

    est_before = _as_int((token_optimization or {}).get("estimated_input_tokens_before"))
    est_after = _as_int((token_optimization or {}).get("estimated_input_tokens_after"))
    est_saved = _as_int((token_optimization or {}).get("estimated_tokens_saved"))

    doc = {
        "ts": utcnow(),
        "user_id": user_id,
        "session_id": session_id,
        "model": model,
        "provider": provider,
        "prompt_tokens": prompt_tokens,
        "completion_tokens": completion_tokens,
        "total_tokens": total_tokens,
        "est_input_tokens_before": est_before,
        "est_input_tokens_after": est_after,
        "est_tokens_saved": est_saved,
        "skills": list(skills) if isinstance(skills, list) else None,
        "kind": kind,
        "error": error,
    }
    # Remove null-ish fields to keep docs compact.
    doc = {k: v for k, v in doc.items() if v is not None and v != ""}

    try:
        usage_events_collection().insert_one(doc)
    except Exception:
        # Never break the agent loop for usage tracking failures.
        pass


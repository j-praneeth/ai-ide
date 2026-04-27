from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from db.mongo import app_config_collection, utcnow


CLAUDE_CLI_CONFIG_ID = "claude_cli"
OPENAI_CLI_CONFIG_ID = "openai_cli"


@dataclass(frozen=True)
class ClaudeCliConfig:
    api_key: str
    oauth_token: str


@dataclass(frozen=True)
class OpenAiCliConfig:
    api_key: str


def _mask_secret(value: str) -> str:
    v = (value or "").strip()
    if not v:
        return ""
    if len(v) <= 8:
        return "*" * len(v)
    return f"{v[:3]}***{v[-4:]}"


def get_claude_cli_config() -> Optional[ClaudeCliConfig]:
    doc = app_config_collection().find_one({"_id": CLAUDE_CLI_CONFIG_ID}) or {}
    api_key = (doc.get("api_key") or "").strip()
    oauth_token = (doc.get("oauth_token") or "").strip()
    if not api_key and not oauth_token:
        return None
    return ClaudeCliConfig(api_key=api_key, oauth_token=oauth_token)


def get_claude_cli_config_summary() -> dict:
    cfg = get_claude_cli_config()
    if not cfg:
        return {
            "configured": False,
            "api_key_masked": "",
            "oauth_token_masked": "",
        }
    return {
        "configured": True,
        "api_key_masked": _mask_secret(cfg.api_key),
        "oauth_token_masked": _mask_secret(cfg.oauth_token),
    }


def set_claude_cli_config(api_key: str = "", oauth_token: str = "") -> dict:
    api_key = (api_key or "").strip()
    oauth_token = (oauth_token or "").strip()
    app_config_collection().update_one(
        {"_id": CLAUDE_CLI_CONFIG_ID},
        {
            "$set": {
                "api_key": api_key,
                "oauth_token": oauth_token,
                "updated_at": utcnow(),
            }
        },
        upsert=True,
    )
    return get_claude_cli_config_summary()


def clear_claude_cli_config() -> None:
    app_config_collection().delete_one({"_id": CLAUDE_CLI_CONFIG_ID})


def get_openai_cli_config() -> Optional[OpenAiCliConfig]:
    doc = app_config_collection().find_one({"_id": OPENAI_CLI_CONFIG_ID}) or {}
    api_key = (doc.get("api_key") or "").strip()
    if not api_key:
        return None
    return OpenAiCliConfig(api_key=api_key)


def get_openai_cli_config_summary() -> dict:
    cfg = get_openai_cli_config()
    if not cfg:
        return {"configured": False, "api_key_masked": ""}
    return {"configured": True, "api_key_masked": _mask_secret(cfg.api_key)}


def set_openai_cli_config(api_key: str = "") -> dict:
    api_key = (api_key or "").strip()
    app_config_collection().update_one(
        {"_id": OPENAI_CLI_CONFIG_ID},
        {"$set": {"api_key": api_key, "updated_at": utcnow()}},
        upsert=True,
    )
    return get_openai_cli_config_summary()


def clear_openai_cli_config() -> None:
    app_config_collection().delete_one({"_id": OPENAI_CLI_CONFIG_ID})

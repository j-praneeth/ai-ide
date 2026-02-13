"""
Relay Configuration
-------------------
Admin-only config for the cloud relay. These values are baked into
the app at build time. Users never see or interact with these values.

Configure by ONE of these methods (checked in order):
  1. Environment variables: RELAY_URL, RELAY_SECRET
  2. A relay_config.json file next to this script
  3. Hardcode the defaults below before building
"""

import os
import json
import logging

logger = logging.getLogger("nebula.relay_config")

# ── Defaults (admin can hardcode before packaging) ────────────────────
_DEFAULT_RELAY_URL = ""
_DEFAULT_RELAY_SECRET = ""

# ── Load from relay_config.json if it exists ──────────────────────────
_json_config = {}
_config_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "relay_config.json")
if os.path.exists(_config_path):
    try:
        with open(_config_path) as f:
            _json_config = json.load(f)
        logger.info("Loaded relay config from %s", _config_path)
    except Exception as e:
        logger.warning("Failed to load relay_config.json: %s", e)

# ── Final values (env vars > json file > hardcoded defaults) ──────────

RELAY_URL = (
    os.environ.get("RELAY_URL")
    or _json_config.get("relay_url")
    or _DEFAULT_RELAY_URL
)

RELAY_API_KEY = (
    os.environ.get("RELAY_SECRET")
    or _json_config.get("relay_secret")
    or _DEFAULT_RELAY_SECRET
)

RELAY_AUTO_CONNECT = (
    os.environ.get("RELAY_AUTO_CONNECT", "").lower() == "true"
    if os.environ.get("RELAY_AUTO_CONNECT")
    else _json_config.get("auto_connect", True)
)

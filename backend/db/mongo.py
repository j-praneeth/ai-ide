import os
import threading
import time
from datetime import datetime
from typing import Optional

from pymongo import ASCENDING, DESCENDING, MongoClient
from pymongo.collection import Collection
from pymongo.database import Database
from pymongo.uri_parser import parse_uri


_lock = threading.Lock()
_client: Optional[MongoClient] = None
_db: Optional[Database] = None
_initialized: bool = False
_last_init_attempt: float = 0
_INIT_RETRY_INTERVAL = 30

# Track whether MongoDB is currently unreachable so callers can avoid
# hammering a dead connection (each attempt blocks for connectTimeoutMS).
_mongo_unreachable: bool = False
_mongo_unreachable_until: float = 0.0
_UNREACHABLE_COOLDOWN = 30.0  # seconds before retrying after a DNS/connect failure


def is_mongo_available() -> bool:
    """Returns False during the cooldown period after a connection failure."""
    global _mongo_unreachable, _mongo_unreachable_until
    if not _mongo_unreachable:
        return True
    if time.time() >= _mongo_unreachable_until:
        _mongo_unreachable = False  # cooldown expired — allow one retry
        return True
    return False


def mark_mongo_unreachable() -> None:
    """Call when a MongoDB operation fails with a network/DNS error."""
    global _mongo_unreachable, _mongo_unreachable_until, _client, _db
    _mongo_unreachable = True
    _mongo_unreachable_until = time.time() + _UNREACHABLE_COOLDOWN
    # Reset cached client/db so the next retry creates a fresh connection.
    _client = None
    _db = None


def _get_mongodb_uri() -> str:
    uri = (os.environ.get("MONGODB_URI") or "").strip()
    if not uri:
        # Fallback to local MongoDB for development if not set in environment
        # Using localhost instead of 127.0.0.1 can sometimes resolve IPv4/IPv6 binding issues
        return "mongodb://localhost:27017/nebula"
    return uri


def _get_db_name_from_uri(uri: str) -> str:
    try:
        parsed = parse_uri(uri)
        db = (parsed.get("database") or "").strip()
        if db:
            return db
    except Exception:
        pass
    return "nebula"


def get_client() -> MongoClient:
    global _client
    if _client is None:
        uri = _get_mongodb_uri()
        # Short connect/selection timeout — fail fast so startup tasks don't block.
        # socketTimeoutMS is kept at 10 s for in-flight operations (inserts, queries).
        _client = MongoClient(
            uri,
            serverSelectionTimeoutMS=3000,
            connectTimeoutMS=3000,
            socketTimeoutMS=10000,
        )
    return _client

def get_db() -> Database:
    global _db
    if _db is None:
        uri = _get_mongodb_uri()
        db_name = (os.environ.get("NEBULA_MONGODB_DB") or "").strip() or _get_db_name_from_uri(uri)
        _db = get_client()[db_name]
    return _db


def users_collection() -> Collection:
    return get_db()["users"]


def usage_events_collection() -> Collection:
    return get_db()["usage_events"]


def audit_events_collection() -> Collection:
    return get_db()["audit_events"]


def app_config_collection() -> Collection:
    return get_db()["app_config"]


def token_stats_collection() -> Collection:
    return get_db()["token_stats"]


def init_mongo() -> None:
    """
    Attempt to initialize the database connection.
    """
    global _initialized, _last_init_attempt
    with _lock:
        if _initialized:
            return
        
        # Rate limit initialization attempts if it keeps failing
        now = time.time()
        if now - _last_init_attempt < _INIT_RETRY_INTERVAL:
            return
            
        _last_init_attempt = now
        _initialized = True

    try:
        print("DEBUG: Attempting to connect to MongoDB...")
        db = get_db()
        # Test connection with a simple command
        db.command("ping")

        users = db["users"]
        users.create_index([("email", ASCENDING)], unique=True, name="uniq_email")
        users.create_index([("role", ASCENDING)], name="idx_role")

        usage = db["usage_events"]
        usage.create_index([("ts", DESCENDING)], name="idx_ts")
        usage.create_index([("user_id", ASCENDING), ("ts", DESCENDING)], name="idx_user_ts")
        usage.create_index([("session_id", ASCENDING), ("ts", DESCENDING)], name="idx_session_ts")

        audit = db["audit_events"]
        audit.create_index([("ts", DESCENDING)], name="idx_audit_ts")
        audit.create_index([("user_id", ASCENDING), ("ts", DESCENDING)], name="idx_audit_user_ts")

        print("DEBUG: MongoDB connected successfully.")
    except Exception as e:
        err_str = str(e)
        print(f"DEBUG: MongoDB connection failed: {err_str[:200]}")
        with _lock:
            _initialized = False
        # Mark unreachable so callers don't hammer a dead connection
        if any(kw in err_str for kw in ("nodename nor servname", "Name or service not known",
                                         "ENOTFOUND", "getaddrinfo", "Timeout", "ServerSelectionTimeoutError")):
            mark_mongo_unreachable()
        raise e


def utcnow() -> datetime:
    return datetime.utcnow()

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
        # Increased timeouts to 5 seconds to be more resilient to slow startups
        _client = MongoClient(uri, serverSelectionTimeoutMS=5000, connectTimeoutMS=5000, socketTimeoutMS=5000)
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
        print(f"DEBUG: MongoDB connection failed: {e}")
        with _lock:
            _initialized = False
        raise e


def utcnow() -> datetime:
    return datetime.utcnow()

import base64
import hashlib
import os
import secrets
import time
import uuid
from dataclasses import dataclass
from typing import Optional

import jwt

from db.mongo import audit_events_collection, init_mongo, users_collection, utcnow


ROLE_SUPER_ADMIN = "super_admin"
ROLE_USER = "user"

PBKDF2_ITERS = 240_000


@dataclass(frozen=True)
class User:
    id: str
    email: str
    role: str


def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode("utf-8").rstrip("=")


def _b64d(s: str) -> bytes:
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode((s or "") + pad)


def hash_password(password: str) -> tuple[str, str, int]:
    salt = secrets.token_bytes(16)
    iters = PBKDF2_ITERS
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iters)
    return _b64(salt), _b64(dk), iters


def verify_password(password: str, salt_b64: str, hash_b64: str, iters: int) -> bool:
    try:
        salt = _b64d(salt_b64)
        expected = _b64d(hash_b64)
        dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, int(iters))
        return secrets.compare_digest(dk, expected)
    except Exception:
        return False


def ensure_initialized() -> None:
    init_mongo()


def has_users() -> bool:
    ensure_initialized()
    return users_collection().count_documents({}) > 0


def create_user(email: str, password: str, role: str) -> User:
    ensure_initialized()
    user_id = str(uuid.uuid4())
    salt, pw_hash, iters = hash_password(password)
    now = utcnow()
    users_collection().insert_one(
        {
            "_id": user_id,
            "email": (email or "").strip().lower(),
            "password_salt": salt,
            "password_hash": pw_hash,
            "password_iters": int(iters),
            "role": role,
            "created_at": now,
        }
    )
    return User(id=user_id, email=(email or "").strip().lower(), role=role)


def authenticate(email: str, password: str) -> Optional[User]:
    ensure_initialized()
    doc = users_collection().find_one({"email": (email or "").strip().lower()})
    if not doc:
        return None
    if not verify_password(password, doc.get("password_salt", ""), doc.get("password_hash", ""), doc.get("password_iters", 0)):
        return None
    return User(id=str(doc.get("_id")), email=doc.get("email") or "", role=doc.get("role") or ROLE_USER)


def _jwt_secret() -> str:
    secret = (os.environ.get("JWT_SECRET") or "").strip()
    if not secret:
        # Fallback for development
        return "nebula-dev-secret-key-change-this-in-production"
    return secret


def _jwt_expires_seconds() -> int:
    try:
        return max(300, int(os.environ.get("JWT_EXPIRES_SECONDS", "604800")))
    except Exception:
        return 604800


def issue_jwt(user: User) -> str:
    ensure_initialized()
    now = int(time.time())
    exp = now + _jwt_expires_seconds()
    payload = {
        "sub": user.id,
        "email": user.email,
        "role": user.role,
        "iat": now,
        "exp": exp,
        "iss": "nebula-ide",
    }
    return jwt.encode(payload, _jwt_secret(), algorithm="HS256")


def get_user_for_token(token: str) -> Optional[User]:
    ensure_initialized()
    if not token:
        return None
    try:
        claims = jwt.decode(token, _jwt_secret(), algorithms=["HS256"], options={"require": ["exp", "sub"]})
    except Exception:
        return None
    user_id = str(claims.get("sub") or "")
    if not user_id:
        return None
    doc = users_collection().find_one({"_id": user_id})
    if not doc:
        return None
    return User(id=user_id, email=doc.get("email") or "", role=doc.get("role") or ROLE_USER)


def record_login_audit(user: User, ok: bool, ip: str = "", user_agent: str = "") -> None:
    try:
        audit_events_collection().insert_one(
            {
                "ts": utcnow(),
                "type": "auth.login",
                "ok": bool(ok),
                "user_id": user.id if user else None,
                "email": user.email if user else None,
                "role": user.role if user else None,
                "ip": ip,
                "user_agent": user_agent[:300] if user_agent else "",
            }
        )
    except Exception:
        pass


def seed_initial_super_admin_from_env() -> Optional[User]:
    """
    One-time seeding: when DB is empty, create the first Super Admin using env vars.
    """
    ensure_initialized()
    if has_users():
        return None
    email = (os.environ.get("NEBULA_BOOTSTRAP_SUPERADMIN_EMAIL") or "").strip().lower()
    password = (os.environ.get("NEBULA_BOOTSTRAP_SUPERADMIN_PASSWORD") or "").strip()
    if not email or not password:
        return None
    try:
        return create_user(email=email, password=password, role=ROLE_SUPER_ADMIN)
    except Exception:
        return None


def list_users() -> list[dict]:
    ensure_initialized()
    out = []
    for doc in users_collection().find({}, {"_id": 1, "email": 1, "role": 1, "created_at": 1}).sort("created_at", -1):
        out.append(
            {
                "id": str(doc.get("_id")),
                "email": doc.get("email") or "",
                "role": doc.get("role") or ROLE_USER,
                "created_at": doc.get("created_at"),
            }
        )
    return out

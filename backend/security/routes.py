import logging
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

logger = logging.getLogger("security.routes")

from .auth import (
    ROLE_SUPER_ADMIN,
    ROLE_USER,
    authenticate,
    create_user,
    get_user_for_token,
    has_users,
    issue_jwt,
    list_users,
    record_login_audit,
)
from .middleware import get_request_user

router = APIRouter(prefix="/auth", tags=["auth"])


@router.get("/status")
def status():
    try:
        h = has_users()
        return {
            "has_users": h, 
            "auth_required": h,
            "db_connected": True
        }
    except Exception as e:
        from db.mongo import _get_mongodb_uri
        uri = _get_mongodb_uri()
        print(f"DEBUG: Status check failed (DB down): {e}")
        return {
            "has_users": False, 
            "auth_required": True, 
            "db_connected": False,
            "error": f"Database connection failed. Please ensure MongoDB is running at {uri}. Error: {str(e)}"
        }


@router.post("/login")
async def login(request: Request):
    print(f"DEBUG: Login request received")
    try:
        try:
            body = await request.json()
        except Exception as e:
            print(f"DEBUG: Failed to parse JSON body: {e}")
            return JSONResponse({"error": "Invalid JSON body"}, status_code=400)

        email = (body.get("email") or "").strip()
        password = (body.get("password") or "").strip()
        print(f"DEBUG: Login attempt for email: {email}")
        
        try:
            user = authenticate(email, password)
        except Exception as e:
            # Database might be down
            print(f"DEBUG: Authenticate failed: {e}")
            logger.error("Login failed (auth backend error): %s", e)
            return JSONResponse(
                status_code=503,
                content={"error": "Authentication service is currently unavailable. Please check if the database is running."}
            )

        if not user:
            print(f"DEBUG: User not found or password incorrect")
            try:
                record_login_audit(None, ok=False, ip=request.client.host if request.client else "", user_agent=request.headers.get("user-agent", ""))
            except Exception:
                pass # Audit failure shouldn't block login failure response
            return JSONResponse(
                status_code=401,
                content={"error": "Invalid email or password"}
            )
            
        print(f"DEBUG: User authenticated: {user.email}")
        try:
            token = issue_jwt(user)
        except Exception as e:
            print(f"DEBUG: issue_jwt failed: {e}")
            return JSONResponse(
                status_code=500,
                content={"error": f"Failed to issue token: {str(e)}"}
            )
            
        try:
            record_login_audit(user, ok=True, ip=request.client.host if request.client else "", user_agent=request.headers.get("user-agent", ""))
        except Exception as e:
            print(f"DEBUG: record_login_audit failed: {e}")
            pass # Audit failure shouldn't block successful login
            
        print(f"DEBUG: Login successful for {user.email}")
        return {"token": token, "user": {"id": user.id, "email": user.email, "role": user.role}}
    except Exception as e:
        print(f"DEBUG: Unexpected error in login route: {e}")
        logger.error("Unexpected error in login route: %s", e)
        return JSONResponse(
            status_code=500,
            content={"error": f"An unexpected error occurred: {str(e)}"}
        )


@router.post("/logout")
def logout(request: Request):
    return {"status": "ok"}


@router.get("/me")
def me(request: Request):
    user = get_request_user(request)
    if not user:
        return {"user": None}
    return {"user": {"id": user.id, "email": user.email, "role": user.role}}


@router.post("/users")
async def create_user_route(request: Request):
    current = get_request_user(request)
    if not current or current.role != ROLE_SUPER_ADMIN:
        return {"error": "Forbidden"}

    body = await request.json()
    email = (body.get("email") or "").strip()
    password = (body.get("password") or "").strip()
    role = (body.get("role") or ROLE_USER).strip()
    if role not in (ROLE_SUPER_ADMIN, ROLE_USER):
        return {"error": "Invalid role"}
    if not email or not password:
        return {"error": "email and password are required"}

    try:
        user = create_user(email=email, password=password, role=role)
        return {"user": {"id": user.id, "email": user.email, "role": user.role}}
    except Exception as e:
        return {"error": str(e)}


@router.get("/users")
def list_users_route(request: Request):
    current = get_request_user(request)
    if not current or current.role != ROLE_SUPER_ADMIN:
        return {"error": "Forbidden"}
    try:
        return {"users": list_users()}
    except Exception as e:
        return {"error": str(e)}

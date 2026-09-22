from __future__ import annotations

import secrets

from fastapi import HTTPException, Request

from . import config

SESSION_USER_KEY = "user"


def credentials_configured() -> bool:
    return bool(config.AUTH_USERNAME and config.AUTH_PASSWORD)


def verify_credentials(username: str, password: str) -> bool:
    if not credentials_configured():
        return False
    # compare_digest on both fields so a wrong username and a wrong password
    # take the same time to reject
    username_ok = secrets.compare_digest(username, config.AUTH_USERNAME)
    password_ok = secrets.compare_digest(password, config.AUTH_PASSWORD)
    return username_ok and password_ok


def is_authenticated(request: Request) -> bool:
    return request.session.get(SESSION_USER_KEY) == config.AUTH_USERNAME


def sign_in(request: Request) -> None:
    request.session[SESSION_USER_KEY] = config.AUTH_USERNAME


def sign_out(request: Request) -> None:
    request.session.clear()


def require_auth(request: Request) -> None:
    """Dependency for the API routers — returns JSON 401 rather than a redirect
    so fetch() callers get a parseable error instead of a login page."""
    if not is_authenticated(request):
        raise HTTPException(401, "Not authenticated")

"""
API versioning and how a request says who it is.

Routes live under /api/v1. Plain /api/... (what older clients call) is rewritten to
/api/v1/... before routing, so both work. A breaking change goes in /api/v2 next to it.

A device proves itself with its secret, either as the ks_device cookie (the web app)
or as `Authorization: Bearer <secret>` (native apps, scripts).
"""
import re

from starlette.requests import HTTPConnection
from starlette.types import ASGIApp, Receive, Scope, Send

VERSION = 1
API = f"/api/v{VERSION}"
COOKIE = "ks_device"
VERSIONED = re.compile(r"^/api/v\d+/")
# a client sends this on sign-in to get its secret in the response body instead of a cookie
TOKEN_HEADER = "x-kiks-auth"
OLD_TOKEN_HEADER = "x-kicksnap-auth"  # before the rename; still accepted


def device_token(request: HTTPConnection) -> str | None:
    """The device secret from the Authorization header, else the cookie."""
    scheme, _, token = request.headers.get("authorization", "").partition(" ")
    if scheme.lower() == "bearer" and token.strip():
        return token.strip()
    return request.cookies.get(COOKIE)


def wants_token(request: HTTPConnection) -> bool:
    asked = request.headers.get(TOKEN_HEADER) or request.headers.get(OLD_TOKEN_HEADER) or ""
    return asked.lower() == "bearer"


class Unversioned:
    """ASGI middleware: /api/x -> /api/v1/x, and /ws -> /api/v1/ws."""

    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send):
        if scope["type"] in ("http", "websocket"):
            path = scope["path"]
            if path == "/ws":
                path = f"{API}/ws"
            elif path.startswith("/api/") and not VERSIONED.match(path):
                path = API + path[4:]
            if path != scope["path"]:
                scope = {**scope, "path": path, "raw_path": path.encode()}
        await self.app(scope, receive, send)

"""
API versioning and how a request says who it is.

Routes live under /api/v1. Plain /api/... (what older clients call) is rewritten to
/api/v1/... before routing, so both work. A breaking change goes in /api/v2 next to it.

A device proves itself with its secret, either as the ks_device cookie (the web app)
or as `Authorization: Bearer <secret>` (native apps, scripts).
"""
import os
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


# The web app's own origin(s). Unset: whatever host the request came in on (behind a proxy that
# keeps the Host header, that's right). Set it (comma-separated) when the proxy rewrites Host.
ORIGINS = {o.strip().rstrip("/") for o in os.getenv("ORIGIN", "").split(",") if o.strip()}


def own_origin(request: HTTPConnection, origin: str | None) -> bool:
    """Is `origin` (a browser's Origin header) this server's web app?"""
    if not origin:
        return False
    if ORIGINS:
        return origin.rstrip("/") in ORIGINS
    scheme = {"ws": "http", "wss": "https"}.get(request.url.scheme, request.url.scheme)
    host = request.headers.get("host", "")
    return origin.rstrip("/") == f"{scheme}://{host}"


def poll_secret(request: HTTPConnection, secret: str | None) -> str:
    """A link poll's secret: the X-Kiks-Secret header (kept out of access logs), or ?secret= from older clients."""
    return request.headers.get("x-kiks-secret") or secret or ""


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

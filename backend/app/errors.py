"""
Server-side error log. Everything goes to stderr (so `docker compose logs`), and the
last hour's count of unhandled errors shows up in /api/v1/health.
"""
import logging
import os
import time
from collections import deque

from fastapi import Request
from fastapi.responses import JSONResponse

log = logging.getLogger("kicksnap")
_recent: deque[float] = deque(maxlen=1000)


def setup() -> None:
    logging.basicConfig(
        level=os.getenv("LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )


def record() -> None:
    _recent.append(time.time())


def summary() -> dict:
    hour_ago = time.time() - 3600
    return {
        "errors_last_hour": sum(1 for t in _recent if t > hour_ago),
        "last_error_at": int(_recent[-1]) if _recent else None,
    }


async def unhandled(request: Request, exc: Exception) -> JSONResponse:
    """Any exception a route didn't turn into an HTTP error. uvicorn logs the traceback after this."""
    record()
    log.error("%s %s failed: %s: %s", request.method, request.url.path, type(exc).__name__, exc)
    return JSONResponse({"detail": "something broke"}, status_code=500)

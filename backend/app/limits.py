"""
Simple in-memory rate limits (one process). Keyed by device when the request carries a
real device secret (cookie or bearer), otherwise by client IP. A made-up secret counts as
none, or every request could bring a fresh one and never be limited (uvicorn runs with --proxy-headers, so that's the
real IP behind a reverse proxy).
"""
import hashlib
import time
from collections import defaultdict, deque

from fastapi import HTTPException, Request

from .api import device_token
from .db import db

_hits: dict[str, deque] = defaultdict(deque)


def _caller(request: Request) -> str:
    token = device_token(request)
    if token:
        token_hash = hashlib.sha256(token.encode()).hexdigest()
        with db() as conn:
            if conn.execute("SELECT 1 FROM devices WHERE token_hash = ?", (token_hash,)).fetchone():
                return "d:" + token_hash
    return "ip:" + (request.client.host if request.client else "?")


def limit(name: str, times: int, per: int):
    """Dependency: allow `times` calls per `per` seconds for each caller."""

    def check(request: Request):
        key = f"{name}:{_caller(request)}"
        q = _hits[key]
        t = time.monotonic()
        while q and q[0] <= t - per:
            q.popleft()
        if len(q) >= times:
            raise HTTPException(429, "slow down a sec")
        q.append(t)
        if len(_hits) > 50_000:  # forget idle callers
            for k in [k for k, v in _hits.items() if not v or v[-1] <= t - 3600]:
                del _hits[k]

    return check

"""
Simple in-memory rate limits (one process). Keyed by device cookie when there is
one, otherwise by client IP (uvicorn runs with --proxy-headers, so that's the
real IP behind a reverse proxy).
"""
import time
from collections import defaultdict, deque

from fastapi import HTTPException, Request

_hits: dict[str, deque] = defaultdict(deque)


def limit(name: str, times: int, per: int):
    """Dependency: allow `times` calls per `per` seconds for each caller."""

    def check(request: Request):
        who = request.cookies.get("ks_device") or (request.client.host if request.client else "?")
        key = f"{name}:{who}"
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

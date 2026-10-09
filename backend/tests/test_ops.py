import asyncio
import base64
import time

import httpx
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

from app import push
from app.db import db


def _keys():
    key = ec.generate_private_key(ec.SECP256R1())
    raw = key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    b64 = lambda b: base64.urlsafe_b64encode(b).rstrip(b"=").decode()  # noqa: E731
    return b64(raw), b64(b"0123456789abcdef")


def _subscribe(user, endpoint):
    p256dh, auth = _keys()
    r = user.post("/api/v1/push/subscribe", json={"endpoint": endpoint, "keys": {"p256dh": p256dh, "auth": auth}})
    assert r.status_code == 200, r.text


def _endpoints(user_id):
    with db() as conn:
        return {r[0] for r in conn.execute("SELECT endpoint FROM push_subs WHERE user_id = ?", (user_id,))}


def test_parallel_push_prunes_dead_and_survives_slow(new_user, monkeypatch):
    u = new_user()
    ok, gone, slow, slow2 = (f"https://fcm.googleapis.com/fcm/send/{n}" for n in ("ok", "gone", "slow", "slow2"))
    for e in (ok, gone, slow, slow2):
        _subscribe(u, e)
    with db() as conn:
        uid = conn.execute("SELECT user_id FROM push_subs WHERE endpoint = ?", (ok,)).fetchone()[0]

    hits = []

    async def handler(request: httpx.Request):
        hits.append(str(request.url))
        assert request.headers["content-encoding"] == "aes128gcm"
        assert request.headers["authorization"].startswith("vapid t=")
        if "/slow" in request.url.path:
            await asyncio.sleep(0.3)
            raise httpx.ReadTimeout("too slow", request=request)
        return httpx.Response(410 if request.url.path.endswith("/gone") else 201)

    async def run():
        monkeypatch.setattr(push, "_client", httpx.AsyncClient(transport=httpx.MockTransport(handler)))
        start = time.monotonic()
        await push.notify(uid, {"title": "Kiks", "body": "hi", "tag": "t"})
        return time.monotonic() - start

    took = asyncio.run(run())
    assert set(hits) == {ok, gone, slow, slow2}
    assert took < 0.5  # both slow ones waited at the same time, not one after the other
    # 410 is pruned, a timeout keeps the subscription for next time
    assert _endpoints(uid) == {ok, slow, slow2}


def test_health_details(client):
    body = client.get("/api/v1/health").json()
    assert body["db"] == "ok"
    assert body["errors_last_hour"] >= 0


def test_unhandled_error_is_counted(client):
    from fastapi.testclient import TestClient

    from app.main import app

    @app.get("/api/v1/_boom", include_in_schema=False)
    def boom():
        raise RuntimeError("boom")

    before = client.get("/api/v1/health").json()["errors_last_hour"]
    r = TestClient(app, raise_server_exceptions=False).get("/api/v1/_boom")
    assert r.status_code == 500 and r.json() == {"detail": "something broke"}
    assert client.get("/api/v1/health").json()["errors_last_hour"] == before + 1

"""
Web Push (RFC 8030) with VAPID (RFC 8292) and aes128gcm payloads (RFC 8291),
done with `cryptography` (already here for passkeys) and httpx.

Payloads never contain snap content, only "new snap from @name".
"""
import asyncio
import base64
import hashlib
import hmac
import json
import logging
import os
import struct
from urllib.parse import urlparse

import httpx
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .api import API, device_token
from .auth import current_user, now
from .db import DATA_DIR, db

log = logging.getLogger("kiks.push")
router = APIRouter(prefix=f"{API}/push")

VAPID_SUBJECT = os.getenv("VAPID_SUBJECT", "https://github.com/robotman4/kicksnap")
# Only ever POST to real push services; endpoints come from the browser, so this
# stops a signed-in user from making the server call arbitrary URLs.
PUSH_HOSTS = (
    "fcm.googleapis.com", "android.googleapis.com", "push.services.mozilla.com",
    "web.push.apple.com", "notify.windows.com", "push.apple.com",
)


def b64u(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def unb64u(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _raw_public(key: ec.EllipticCurvePrivateKey) -> bytes:
    return key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)


def _load_vapid() -> ec.EllipticCurvePrivateKey:
    """Generated on first start and kept next to the database."""
    path = DATA_DIR / "vapid.pem"
    if path.exists():
        return serialization.load_pem_private_key(path.read_bytes(), password=None)
    key = ec.generate_private_key(ec.SECP256R1())
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    path.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    path.chmod(0o600)
    return key


_vapid: ec.EllipticCurvePrivateKey | None = None


def vapid() -> ec.EllipticCurvePrivateKey:
    global _vapid
    if _vapid is None:
        _vapid = _load_vapid()
    return _vapid


def _jwt(audience: str) -> str:
    header = b64u(json.dumps({"typ": "JWT", "alg": "ES256"}).encode())
    claims = b64u(json.dumps({"aud": audience, "exp": now() + 12 * 3600, "sub": VAPID_SUBJECT}).encode())
    signing_input = f"{header}.{claims}".encode()
    r, s = decode_dss_signature(vapid().sign(signing_input, ec.ECDSA(hashes.SHA256())))
    return f"{header}.{claims}.{b64u(r.to_bytes(32, 'big') + s.to_bytes(32, 'big'))}"


def _hmac(key: bytes, msg: bytes) -> bytes:
    return hmac.new(key, msg, hashlib.sha256).digest()


def encrypt(payload: bytes, p256dh: str, auth: str) -> bytes:
    """RFC 8291 aes128gcm, single record."""
    ua_public = unb64u(p256dh)
    auth_secret = unb64u(auth)
    as_key = ec.generate_private_key(ec.SECP256R1())
    as_public = _raw_public(as_key)
    shared = as_key.exchange(ec.ECDH(), ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), ua_public))

    prk_key = _hmac(auth_secret, shared)
    ikm = _hmac(prk_key, b"WebPush: info\x00" + ua_public + as_public + b"\x01")
    salt = os.urandom(16)
    prk = _hmac(salt, ikm)
    cek = _hmac(prk, b"Content-Encoding: aes128gcm\x00\x01")[:16]
    nonce = _hmac(prk, b"Content-Encoding: nonce\x00\x01")[:12]

    ciphertext = AESGCM(cek).encrypt(nonce, payload + b"\x02", None)
    header = salt + struct.pack(">I", 4096) + bytes([len(as_public)]) + as_public
    return header + ciphertext


def allowed(endpoint: str) -> bool:
    u = urlparse(endpoint)
    host = u.hostname or ""
    return u.scheme == "https" and any(host == h or host.endswith("." + h) for h in PUSH_HOSTS)


_client: httpx.AsyncClient | None = None


def client() -> httpx.AsyncClient:
    """One pooled client for all push services, made on first use."""
    global _client
    if _client is None:
        _client = httpx.AsyncClient(timeout=10, limits=httpx.Limits(max_connections=100))
    return _client


async def _send_one(endpoint: str, p256dh: str, auth: str, payload: dict) -> int:
    u = urlparse(endpoint)
    body = encrypt(json.dumps(payload).encode(), p256dh, auth)
    headers = {
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        "TTL": str(24 * 3600),
        "Urgency": "high",
        "Topic": payload.get("tag", "kiks")[:32].replace(".", "-") or "kiks",
        "Authorization": f"vapid t={_jwt(f'{u.scheme}://{u.netloc}')}, k={b64u(_raw_public(vapid()))}",
    }
    try:
        res = await client().post(endpoint, content=body, headers=headers)
        return res.status_code
    except Exception as e:  # network trouble or timeout: keep the subscription, try next time
        log.warning("push to %s failed: %s", u.netloc, e or type(e).__name__)
        return 0


async def notify(user_id: int, payload: dict) -> None:
    """Fire-and-forget push to every device of a user that subscribed, all at once."""
    try:
        with db() as conn:
            subs = conn.execute("SELECT endpoint, p256dh, auth FROM push_subs WHERE user_id = ?", (user_id,)).fetchall()
        statuses = await asyncio.gather(*(_send_one(s["endpoint"], s["p256dh"], s["auth"], payload) for s in subs))
        gone = [s["endpoint"] for s, status in zip(subs, statuses) if status in (404, 410)]  # unsubscribed or expired
        if gone:
            with db() as conn:
                conn.executemany("DELETE FROM push_subs WHERE endpoint = ?", [(e,) for e in gone])
        for status in statuses:
            if status >= 400 and status not in (404, 410):
                log.warning("push rejected with %s", status)
    except Exception:  # runs as a background task: nobody else would see this
        log.exception("push to user %s failed", user_id)


# --- api --------------------------------------------------------------------

@router.get("/key")
def public_key():
    return {"key": b64u(_raw_public(vapid()))}


class Subscription(BaseModel):
    endpoint: str
    keys: dict


@router.post("/subscribe")
def subscribe(body: Subscription, ks_device: str | None = Depends(device_token)):
    user = current_user(ks_device)
    if not allowed(body.endpoint):
        raise HTTPException(400, "unknown push service")
    p256dh, auth = body.keys.get("p256dh"), body.keys.get("auth")
    if not p256dh or not auth:
        raise HTTPException(400, "missing keys")
    with db() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO push_subs (endpoint, user_id, device_id, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            (body.endpoint, user["id"], user["device_id"], p256dh, auth, now()),
        )
    return {"ok": True}


class Unsubscribe(BaseModel):
    endpoint: str


@router.post("/unsubscribe")
def unsubscribe(body: Unsubscribe, ks_device: str | None = Depends(device_token)):
    user = current_user(ks_device)
    with db() as conn:
        conn.execute("DELETE FROM push_subs WHERE endpoint = ? AND user_id = ?", (body.endpoint, user["id"]))
    return {"ok": True}

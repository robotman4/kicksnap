"""
Key directory for end-to-end encryption (docs/e2e.md).

The server only ever holds public keys and ciphertext. It checks signatures on device
lists so a buggy client can't publish garbage, and on report proofs so admins can tell a
real text from a made-up one, but clients never rely on the server for either.
"""
import base64
import binascii
import hashlib
import secrets

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .api import API
from .auth import LINK_TTL, current_user, now
from .chat import are_friends, blocked, member_ids
from .db import db
from .hub import hub
from .limits import limit

router = APIRouter(prefix=f"{API}/keys")

LIST_HEADER = "kicksnap/1 devices"
MAX_WRAP = 256  # a wrap is 32 + 12 + 96 + 16 bytes, ~210 chars of base64


def unb64(s: str, size: int | None = None) -> bytes:
    try:
        out = base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))
    except (binascii.Error, ValueError, TypeError):
        raise HTTPException(400, "bad key encoding")
    if size is not None and len(out) != size:
        raise HTTPException(400, "bad key length")
    return out


def b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def sha(b: bytes) -> str:
    return b64(hashlib.sha256(b).digest())


def signed_by(identity_key: str | None, sig: str, text: str) -> bool:
    if not identity_key:
        return False
    try:
        Ed25519PublicKey.from_public_bytes(unb64(identity_key, 32)).verify(unb64(sig, 64), text.encode())
        return True
    except (InvalidSignature, HTTPException, ValueError):
        return False


def parse_list(payload: str) -> tuple[str, int, dict[int, str]]:
    lines = payload.split("\n")
    if len(lines) < 3 or lines[0] != LIST_HEADER or not lines[2].isdigit():
        raise HTTPException(400, "bad device list")
    devices: dict[int, str] = {}
    for line in lines[3:]:
        ident, _, key = line.partition(" ")
        if not ident.isdigit() or int(ident) in devices or (devices and int(ident) < max(devices)):
            raise HTTPException(400, "bad device list")
        unb64(key, 32)
        devices[int(ident)] = key
    return lines[1], int(lines[2]), devices


def bundle(conn, user_id: int) -> dict:
    u = conn.execute("SELECT identity_key, device_list, device_list_sig, device_list_version FROM users WHERE id = ?", (user_id,)).fetchone()
    devices = conn.execute(
        "SELECT id, enc_key FROM devices WHERE user_id = ? AND enc_key IS NOT NULL ORDER BY id", (user_id,)
    ).fetchall()
    return {
        "identity_key": u["identity_key"],
        "device_list": {"payload": u["device_list"], "sig": u["device_list_sig"], "version": u["device_list_version"]} if u["device_list"] else None,
        "devices": [dict(d) for d in devices],
    }


async def tell_peers(user_id: int, username: str):
    """Friends and group co-members refetch, so their clients notice the change."""
    with db() as conn:
        peers = {r[0] for r in conn.execute(
            """SELECT friend_id FROM friendships WHERE user_id = :me
               UNION SELECT m.user_id FROM group_members m JOIN group_members mine ON mine.group_id = m.group_id
               WHERE mine.user_id = :me AND m.user_id != :me""",
            {"me": user_id},
        )}
    for p in peers | {user_id}:
        await hub.push(p, {"type": "keys", "user": username})


# --- my keys ------------------------------------------------------------------

@router.get("/me")
def my_keys(user=Depends(current_user)):
    with db() as conn:
        return {"device_id": user["device_id"], **bundle(conn, user["id"])}


class Identity(BaseModel):
    identity_key: str
    replace: bool = False


@router.put("/identity", dependencies=[Depends(limit("identity", 10, 3600))])
async def set_identity(body: Identity, user=Depends(current_user)):
    """First identity for the account, or (replace) a fresh one: friends will see 'key changed'."""
    unb64(body.identity_key, 32)
    with db() as conn:
        if user["identity_key"] and not body.replace:
            if user["identity_key"] == body.identity_key:
                return {"ok": True}
            raise HTTPException(409, "this account already has a key")
        conn.execute(
            "UPDATE users SET identity_key = ?, device_list = NULL, device_list_sig = NULL, device_list_version = 0 WHERE id = ?",
            (body.identity_key, user["id"]),
        )
    await tell_peers(user["id"], user["username"])
    return {"ok": True}


class DeviceKey(BaseModel):
    enc_key: str


@router.put("/device")
def set_device_key(body: DeviceKey, user=Depends(current_user)):
    unb64(body.enc_key, 32)
    with db() as conn:
        conn.execute("UPDATE devices SET enc_key = ? WHERE id = ?", (body.enc_key, user["device_id"]))
    return {"ok": True}


class DeviceList(BaseModel):
    payload: str
    sig: str


@router.put("/devices", dependencies=[Depends(limit("device-list", 30, 60))])
async def set_device_list(body: DeviceList, user=Depends(current_user)):
    if len(body.payload) > 20_000:
        raise HTTPException(400, "too many devices")
    name, version, _ = parse_list(body.payload)
    if name != user["username"]:
        raise HTTPException(400, "that list is for someone else")
    if not signed_by(user["identity_key"], body.sig, body.payload):
        raise HTTPException(400, "not signed by this account's key")
    with db() as conn:
        cur = conn.execute(
            "UPDATE users SET device_list = ?, device_list_sig = ?, device_list_version = ? WHERE id = ? AND device_list_version < ?",
            (body.payload, body.sig, version, user["id"], version),
        )
        if not cur.rowcount:
            raise HTTPException(409, "someone published a newer list, fetch and retry")
    await tell_peers(user["id"], user["username"])
    return {"ok": True}


# --- other people's keys ------------------------------------------------------

@router.get("")
def keys(users: str = "", groups: str = "", user=Depends(current_user)):
    """Key bundles for you, your friends and people in your groups (to encrypt to them)."""
    me = user["id"]
    names = {n.strip().lower() for n in users.split(",") if n.strip()}
    out: dict[str, dict] = {}
    with db() as conn:
        for n in names:
            u = conn.execute("SELECT id, username FROM users WHERE username = ?", (n,)).fetchone()
            if u and (u["id"] == me or are_friends(conn, me, u["id"])):
                out[u["username"]] = bundle(conn, u["id"])
        for g in {int(g) for g in groups.split(",") if g.strip().isdigit()}:
            members = member_ids(conn, g)
            if me not in members:
                continue
            for m in members:
                if m != me and blocked(conn, me, m):
                    continue
                u = conn.execute("SELECT username FROM users WHERE id = ?", (m,)).fetchone()
                out[u["username"]] = bundle(conn, m)
    return {"users": out}


# --- approve a signed-in device that has no keys (passkey sign-in, cleared storage) --

_requests: dict[str, dict] = {}  # code -> {secret, created, user_id, link_key, key_blob}
_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def _prune():
    for code in [c for c, v in _requests.items() if v["created"] < now() - LINK_TTL]:
        _requests.pop(code, None)


class LinkKey(BaseModel):
    link_key: str


class KeyBlob(BaseModel):
    key_blob: str


@router.post("/requests", dependencies=[Depends(limit("key-request", 10, 60))])
def key_request(body: LinkKey, user=Depends(current_user)):
    _prune()
    unb64(body.link_key, 32)
    code = "".join(secrets.choice(_ALPHABET) for _ in range(6))
    secret = secrets.token_urlsafe(24)
    _requests[code] = {"secret": secret, "created": now(), "user_id": user["id"], "link_key": body.link_key, "key_blob": None}
    return {"code": code, "secret": secret, "expires_in": LINK_TTL}


def _mine(code: str, user) -> dict:
    _prune()
    req = _requests.get(code.strip().upper().removeprefix("KICKSNAP-KEYS:"))
    if not req or req["user_id"] != user["id"]:
        raise HTTPException(410, "that code expired, make a new one")
    return req


@router.get("/requests/{code}")
def key_request_info(code: str, user=Depends(current_user)):
    return {"link_key": _mine(code, user)["link_key"]}


@router.post("/requests/{code}/approve", dependencies=[Depends(limit("approve", 10, 60))])
def key_request_approve(code: str, body: KeyBlob, user=Depends(current_user)):
    req = _mine(code, user)
    if len(body.key_blob) > MAX_WRAP:
        raise HTTPException(400, "bad key")
    unb64(body.key_blob)
    req["key_blob"] = body.key_blob
    return {"ok": True}


@router.get("/requests/{code}/poll")
def key_request_poll(code: str, secret: str, user=Depends(current_user)):
    req = _mine(code, user)
    if not secrets.compare_digest(req["secret"], secret):
        raise HTTPException(410, "expired")
    if req["key_blob"]:
        _requests.pop(code.upper(), None)
    return {"key_blob": req["key_blob"]}


# --- checking what a reporter says they saw ----------------------------------------

def snap_signed_text(sender: str, to: str, p: dict, media_hash: str) -> str:
    return "\n".join([
        "kicksnap/1 snap", sender, to, str(p["sent_at"]), str(p["nonce"]), str(p["kind"]), str(p["mime"]),
        str(p["seconds"]), media_hash, p.get("overlay") or "-",
    ])


def text_signed_text(sender: str, to: str, p: dict) -> str:
    return "\n".join(["kicksnap/1 text", sender, to, str(p["sent_at"]), str(p["nonce"]), sha(str(p["body"]).encode())])


def wraps_for(conn, keys: dict, allowed_users: set[int]) -> list[tuple[int, str]]:
    """{device_id: wrap} -> rows, keeping only devices of the given users."""
    out = []
    for dev, wrap in (keys or {}).items():
        if not str(dev).isdigit() or not isinstance(wrap, str) or len(wrap) > MAX_WRAP:
            raise HTTPException(400, "bad keys")
        out.append((int(dev), wrap))
    if not out:
        return []
    owners = dict(conn.execute(
        f"SELECT id, user_id FROM devices WHERE id IN ({','.join('?' * len(out))})", [d for d, _ in out]
    ).fetchall())
    return [(d, w) for d, w in out if owners.get(d) in allowed_users]

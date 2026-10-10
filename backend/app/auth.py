"""
Passwordless auth. Every browser is a "device" holding a long-lived secret in an
httpOnly cookie (or, for native apps, sent as a bearer token; see api.py). A new device either starts a fresh account, gets approved by an
already signed-in device (QR / short code), or signs in with a passkey.
"""
import hashlib
import os
import re
import secrets
import time
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel
from webauthn import (
    generate_authentication_options, generate_registration_options, options_to_json,
    verify_authentication_response, verify_registration_response,
)
from webauthn.helpers import base64url_to_bytes, bytes_to_base64url
from webauthn.helpers.structs import (
    PublicKeyCredentialDescriptor, ResidentKeyRequirement, UserVerificationRequirement,
    AuthenticatorSelectionCriteria,
)

from .api import API, COOKIE, device_token, own_origin, poll_secret, wants_token
from .limits import limit
from .db import db
from .hub import hub

COOKIE_MAX_AGE = 400 * 24 * 3600  # browsers cap at ~400 days; refreshed on use
LINK_TTL = 300
SEEN_EVERY = 600  # seconds between "last active" updates per device
USERNAME_RE = re.compile(r"^[a-z0-9_.]{3,20}$")
RP_NAME = "Kiks"

router = APIRouter(prefix=API)


def now() -> int:
    return int(time.time())


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _label(request: Request) -> str:
    ua = request.headers.get("user-agent", "")
    for needle, name in [("iPhone", "iPhone"), ("iPad", "iPad"), ("Android", "Android"),
                         ("Mac OS", "Mac"), ("Windows", "Windows"), ("Linux", "Linux")]:
        if needle in ua:
            return name
    return "device"


def _set_cookie(response: Response, request: Request, token: str):
    response.set_cookie(
        COOKIE, token, max_age=COOKIE_MAX_AGE, httponly=True, samesite="lax",
        secure=request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https",
    )


def new_device(conn, user_id: int, request: Request, response: Response) -> None:
    token = secrets.token_urlsafe(32)
    conn.execute(
        "INSERT INTO devices (user_id, token_hash, label, created_at, seen_at) VALUES (?, ?, ?, ?, ?)",
        (user_id, _hash(token), _label(request), now(), now()),
    )
    request.state.token = token
    if not wants_token(request):
        _set_cookie(response, request, token)


def issued(request: Request) -> dict:
    """Hands the new device secret back in the body, only to clients that asked for it."""
    token = getattr(request.state, "token", None)
    return {"token": token} if token and wants_token(request) else {}


def user_for_token(token: str | None):
    if not token:
        return None
    with db() as conn:
        row = conn.execute(
            "SELECT u.*, d.id AS device_id, d.seen_at AS seen_at FROM devices d JOIN users u ON u.id = d.user_id WHERE d.token_hash = ?",
            (_hash(token),),
        ).fetchone()
        # "active" only needs to be roughly right; writing on every request makes every
        # read wait on SQLite's single writer
        if row and now() - row["seen_at"] > SEEN_EVERY:
            conn.execute("UPDATE devices SET seen_at = ? WHERE id = ?", (now(), row["device_id"]))
        return row


def any_user(ks_device: str | None = Depends(device_token)):
    user = user_for_token(ks_device)
    if not user:
        raise HTTPException(401, "not signed in")
    return user


def suspended(user) -> bool:
    return bool(user["suspended_at"]) and (user["suspended_until"] is None or user["suspended_until"] > now())


def current_user(ks_device: str | None = Depends(device_token)):
    """Signed in, has picked a username, and isn't suspended."""
    user = any_user(ks_device)
    if not user["username"]:
        raise HTTPException(409, "pick a name first")
    if suspended(user):
        raise HTTPException(403, "your account is suspended")
    return user


def public(user) -> dict:
    return {"username": user["username"], "color": user["color"]}


def name_reserved(conn, name: str) -> bool:
    return conn.execute(
        "SELECT 1 FROM reserved_usernames WHERE name = ? AND (expires_at IS NULL OR expires_at > ?)", (name, now())
    ).fetchone() is not None


# --- new account ------------------------------------------------------------

@router.post("/devices/new", dependencies=[Depends(limit("new-device", 10, 3600))])
def start_fresh(request: Request, response: Response):
    """'I'm new': make an account for this device. Name comes next."""
    with db() as conn:
        cur = conn.execute("INSERT INTO users (created_at) VALUES (?)", (now(),))
        new_device(conn, cur.lastrowid, request, response)
    return {"username": None, "color": "#C6FF3D", **issued(request)}


class Name(BaseModel):
    username: str


@router.post("/me/name", dependencies=[Depends(limit("name", 20, 60))])
def pick_name(body: Name, ks_device: str | None = Depends(device_token)):
    user = any_user(ks_device)
    name = body.username.strip().lower()
    if not USERNAME_RE.match(name):
        raise HTTPException(400, "3-20 letters, numbers, _ or .")
    with db() as conn:
        taken = conn.execute("SELECT 1 FROM users WHERE username = ? AND id != ?", (name, user["id"])).fetchone()
        if taken or name_reserved(conn, name):
            raise HTTPException(409, "taken, try another")
        conn.execute("UPDATE users SET username = ? WHERE id = ?", (name, user["id"]))
    return {"username": name, "color": user["color"]}


@router.get("/names/{name}", dependencies=[Depends(limit("names", 60, 60))])
def name_free(name: str):
    name = name.strip().lower()
    if not USERNAME_RE.match(name):
        return {"free": False, "valid": False}
    with db() as conn:
        taken = conn.execute("SELECT 1 FROM users WHERE username = ?", (name,)).fetchone() or name_reserved(conn, name)
    return {"free": not taken, "valid": True}


@router.get("/me")
def me(ks_device: str | None = Depends(device_token)):
    """Returns the user even before a name is picked, so the client knows where to go."""
    user = any_user(ks_device)
    out = {**public(user), "admin": bool(user["is_admin"])}
    if user["username"] and suspended(user):
        out["suspended_until"] = user["suspended_until"] or 0  # 0 = until an admin lifts it
    return out


@router.post("/auth/logout")
async def logout(response: Response, ks_device: str | None = Depends(device_token)):
    if ks_device:
        with db() as conn:
            gone = conn.execute("SELECT id, user_id FROM devices WHERE token_hash = ?", (_hash(ks_device),)).fetchone()
            conn.execute("DELETE FROM devices WHERE token_hash = ?", (_hash(ks_device),))
        if gone:
            await hub.drop_device(gone["user_id"], gone["id"])
    response.delete_cookie(COOKIE)
    return {"ok": True}


@router.get("/devices")
def devices(ks_device: str | None = Depends(device_token)):
    user = any_user(ks_device)
    with db() as conn:
        rows = conn.execute(
            "SELECT id, label, created_at, seen_at FROM devices WHERE user_id = ? ORDER BY seen_at DESC", (user["id"],)
        ).fetchall()
        keys = conn.execute("SELECT COUNT(*) FROM passkeys WHERE user_id = ?", (user["id"],)).fetchone()[0]
    return {
        "devices": [{**dict(r), "this": r["id"] == user["device_id"]} for r in rows],
        "passkeys": keys,
    }


@router.delete("/devices/{device_id}")
async def remove_device(device_id: int, ks_device: str | None = Depends(device_token)):
    user = any_user(ks_device)
    with db() as conn:
        conn.execute("DELETE FROM devices WHERE id = ? AND user_id = ?", (device_id, user["id"]))
    # a removed (lost, stolen) device stops getting live updates now, not when its socket next drops
    await hub.drop_device(user["id"], device_id)
    return {"ok": True}


# --- link a new device from a signed-in one ---------------------------------

# code -> {secret, created, user_id}; in memory is fine, codes live 5 minutes
_links: dict[str, dict] = {}
_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no 0/O/1/I


def _prune():
    for code in [c for c, v in _links.items() if v["created"] < now() - LINK_TTL]:
        _links.pop(code, None)


class LinkStart(BaseModel):
    link_key: str | None = None  # one-time X25519 key; the identity key comes back sealed to it (docs/e2e.md)


class LinkApprove(BaseModel):
    key_blob: str | None = None


@router.post("/link/start", dependencies=[Depends(limit("link", 10, 60))])
def link_start(body: LinkStart | None = None):
    """New device asks to join. Shows the code as a QR for the other device to scan."""
    _prune()
    link_key = body.link_key if body else None
    if link_key and len(link_key) != 43:
        raise HTTPException(400, "bad link key")
    code = "".join(secrets.choice(_ALPHABET) for _ in range(6))
    secret = secrets.token_urlsafe(24)
    _links[code] = {"secret": secret, "created": now(), "user_id": None, "link_key": link_key, "key_blob": None}
    return {"code": code, "secret": secret, "expires_in": LINK_TTL}


@router.get("/link/{code}")
def link_poll(code: str, request: Request, response: Response, secret: str | None = None):
    _prune()
    link = _links.get(code.upper())
    if not link or not secrets.compare_digest(link["secret"].encode(), poll_secret(request, secret).encode()):
        raise HTTPException(410, "expired")
    if not link["user_id"]:
        return {"approved": False}
    _links.pop(code.upper(), None)
    with db() as conn:
        new_device(conn, link["user_id"], request, response)
        user = conn.execute("SELECT * FROM users WHERE id = ?", (link["user_id"],)).fetchone()
    return {"approved": True, "user": public(user), "key_blob": link["key_blob"], **issued(request)}


def _link_code(code: str) -> str:
    return code.strip().upper().removeprefix("KIKS-LINK:").removeprefix("KICKSNAP-LINK:").split("#")[0]


@router.get("/link/{code}/key")
def link_key(code: str, ks_device: str | None = Depends(device_token)):
    """For an approver who typed the code instead of scanning it: compare the check number first."""
    current_user(ks_device)
    _prune()
    link = _links.get(_link_code(code))
    if not link or link["user_id"]:
        raise HTTPException(410, "that code expired, make a new one")
    return {"link_key": link["link_key"]}


@router.post("/link/{code}/approve", dependencies=[Depends(limit("approve", 10, 60))])
def link_approve(code: str, body: LinkApprove | None = None, ks_device: str | None = Depends(device_token)):
    user = current_user(ks_device)
    _prune()
    link = _links.get(_link_code(code))
    if not link or link["user_id"]:
        raise HTTPException(410, "that code expired, make a new one")
    blob = body.key_blob if body else None
    if blob and len(blob) > 256:
        raise HTTPException(400, "bad key")
    link["user_id"] = user["id"]
    link["key_blob"] = blob
    return {"ok": True}


# --- passkeys ---------------------------------------------------------------

_challenges: dict[str, tuple[bytes, int, int | None]] = {}  # id -> (challenge, created, user_id)

# The native apps. Android signs a passkey request as "android:apk-key-hash:<sha256 of the app's signing
# cert>" and only lets an app do that for a site whose /.well-known/assetlinks.json names it (main.py serves
# it from these). iOS uses the site's own https origin, gated by apple-app-site-association.
# The default cert is the public dev key test builds are signed with: set ANDROID_CERTS to the release key's
# fingerprint (and drop the dev one) before handing the app to people.
DEV_CERT = "5D:AB:F8:F4:0C:CF:9D:68:BC:30:02:2B:D3:D4:7A:3F:7F:B4:66:85:C4:86:B9:B3:42:06:75:3A:CC:1D:15:9E"
ANDROID_APP_ID = os.getenv("ANDROID_APP_ID", "com.getkiks.app")
ANDROID_CERTS = [c.strip().upper() for c in os.getenv("ANDROID_CERTS", DEV_CERT).split(",") if c.strip()]
IOS_APP_IDS = [a.strip() for a in os.getenv("IOS_APP_IDS", "").split(",") if a.strip()]  # TEAMID.com.getkiks.app


def android_origins() -> list[str]:
    return ["android:apk-key-hash:" + bytes_to_base64url(bytes.fromhex(c.replace(":", ""))) for c in ANDROID_CERTS]


def _rp(request: Request) -> tuple[str, list[str]]:
    """RP ID and the origins a passkey may have signed for, never one the request names.

    Browsers always send Origin: it has to be our own web app. The native app sends none; then only our
    Android app's own origin is accepted, which nothing but an app signed with ANDROID_CERTS can produce
    (Android puts it in the signed client data). That doesn't depend on how the proxy forwards the scheme."""
    origin = request.headers.get("origin")
    if origin is None:
        host = urlparse("//" + request.headers.get("host", "")).hostname or ""
        rp_id = os.getenv("RP_ID") or host
        if not rp_id or (host != rp_id and not host.endswith("." + rp_id)):
            raise HTTPException(400, "passkey failed: this address doesn't match RP_ID")
        return rp_id, android_origins()
    if not own_origin(request, origin):
        raise HTTPException(400, "passkey failed: open Kiks on its own address")
    host = urlparse(origin).hostname or ""
    rp_id = os.getenv("RP_ID") or host
    if host != rp_id and not host.endswith("." + rp_id):
        raise HTTPException(400, "passkey failed: this address doesn't match RP_ID")
    return rp_id, [origin]


def _stash(challenge: bytes, user_id: int | None) -> str:
    for k in [k for k, v in _challenges.items() if v[1] < now() - LINK_TTL]:
        _challenges.pop(k, None)
    cid = secrets.token_urlsafe(16)
    _challenges[cid] = (challenge, now(), user_id)
    return cid


@router.post("/passkeys/register/begin", dependencies=[Depends(limit("passkey-reg", 10, 60))])
def passkey_register_begin(request: Request, ks_device: str | None = Depends(device_token)):
    user = current_user(ks_device)
    rp_id, _ = _rp(request)
    with db() as conn:
        existing = [r["id"] for r in conn.execute("SELECT id FROM passkeys WHERE user_id = ?", (user["id"],))]
    opts = generate_registration_options(
        rp_id=rp_id,
        rp_name=RP_NAME,
        user_id=str(user["id"]).encode(),
        user_name=user["username"],
        authenticator_selection=AuthenticatorSelectionCriteria(
            resident_key=ResidentKeyRequirement.REQUIRED,
            user_verification=UserVerificationRequirement.PREFERRED,
        ),
        exclude_credentials=[PublicKeyCredentialDescriptor(id=base64url_to_bytes(c)) for c in existing],
    )
    return {"challenge_id": _stash(opts.challenge, user["id"]), "options": options_to_json(opts)}


class Finish(BaseModel):
    challenge_id: str
    credential: dict


@router.post("/passkeys/register/finish")
def passkey_register_finish(body: Finish, request: Request, ks_device: str | None = Depends(device_token)):
    user = current_user(ks_device)
    stashed = _challenges.pop(body.challenge_id, None)
    if not stashed or stashed[2] != user["id"]:
        raise HTTPException(400, "try again")
    rp_id, origin = _rp(request)
    try:
        v = verify_registration_response(
            credential=body.credential, expected_challenge=stashed[0], expected_rp_id=rp_id, expected_origin=origin,
        )
    except Exception as e:
        raise HTTPException(400, f"passkey failed: {e}")
    cred_id = bytes_to_base64url(v.credential_id)
    with db() as conn:
        # credential ids are picked by the authenticator: never let one take over someone else's row
        owner = conn.execute("SELECT user_id FROM passkeys WHERE id = ?", (cred_id,)).fetchone()
        if owner and owner["user_id"] != user["id"]:
            raise HTTPException(400, "passkey failed: already in use")
        conn.execute(
            "INSERT OR REPLACE INTO passkeys VALUES (?, ?, ?, ?, ?)",
            (cred_id, user["id"], v.credential_public_key, v.sign_count, now()),
        )
    return {"ok": True}


@router.post("/passkeys/login/begin", dependencies=[Depends(limit("passkey", 20, 60))])
def passkey_login_begin(request: Request):
    rp_id, _ = _rp(request)
    opts = generate_authentication_options(rp_id=rp_id, user_verification=UserVerificationRequirement.PREFERRED)
    return {"challenge_id": _stash(opts.challenge, None), "options": options_to_json(opts)}


@router.post("/passkeys/login/finish")
def passkey_login_finish(body: Finish, request: Request, response: Response):
    stashed = _challenges.pop(body.challenge_id, None)
    if not stashed:
        raise HTTPException(400, "try again")
    rp_id, origin = _rp(request)
    with db() as conn:
        key = conn.execute("SELECT * FROM passkeys WHERE id = ?", (body.credential.get("id"),)).fetchone()
        if not key:
            raise HTTPException(404, "don't know that passkey")
        try:
            v = verify_authentication_response(
                credential=body.credential, expected_challenge=stashed[0], expected_rp_id=rp_id,
                expected_origin=origin, credential_public_key=key["public_key"],
                credential_current_sign_count=key["sign_count"],
            )
        except Exception as e:
            raise HTTPException(400, f"passkey failed: {e}")
        conn.execute("UPDATE passkeys SET sign_count = ? WHERE id = ?", (v.new_sign_count, key["id"]))
        new_device(conn, key["user_id"], request, response)
        user = conn.execute("SELECT * FROM users WHERE id = ?", (key["user_id"],)).fetchone()
    return {**public(user), **issued(request)}

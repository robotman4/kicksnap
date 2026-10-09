import asyncio
import os
import re
import secrets
import shutil
import time
from pathlib import Path

from fastapi import (
    Depends, FastAPI, File, Form, HTTPException, UploadFile, WebSocket, WebSocketDisconnect,
)
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import __version__, db as store, errors
from .api import API, Unversioned, device_token
from .auth import current_user, public, router as auth_router, suspended, user_for_token
from .limits import limit
from .db import db
from .chat import are_friends, blocked, member_ids, router as chat_router
from .hub import hub
from .media import burn, media_path, overlay_path, save_upload
from .push import notify, router as push_router
from .moderation import router as moderation_router
from .safety import router as safety_router

SNAP_TTL_HOURS = int(os.getenv("SNAP_TTL_HOURS", "24"))
MAX_UPLOAD_MB = int(os.getenv("MAX_UPLOAD_MB", "50"))
STATIC_DIR = Path(os.getenv("STATIC_DIR", "../frontend/dist"))
VIEW_SECONDS = {0, 3, 5, 10}

errors.setup()
app = FastAPI(title="Kiks", version=__version__, docs_url=f"{API}/docs", openapi_url=f"{API}/openapi.json")
app.add_exception_handler(Exception, errors.unhandled)
app.add_middleware(Unversioned)
app.include_router(auth_router)
app.include_router(push_router)
app.include_router(chat_router)
app.include_router(safety_router)
app.include_router(moderation_router)


def now() -> int:
    return int(time.time())


class Profile(BaseModel):
    color: str


@app.patch(API + "/me")
def update_me(body: Profile, user=Depends(current_user)):
    if not re.match(r"^#[0-9a-fA-F]{6}$", body.color):
        raise HTTPException(400, "bad color")
    with db() as conn:
        conn.execute("UPDATE users SET color = ? WHERE id = ?", (body.color, user["id"]))
    return {**public(user), "color": body.color}


# --- realtime ---------------------------------------------------------------

@app.websocket(API + "/ws")
async def socket(ws: WebSocket):
    user = user_for_token(device_token(ws))
    if not user or not user["username"] or suspended(user):
        await ws.close(code=4401)
        return
    await ws.accept()
    hub.sockets[user["id"]].add(ws)
    try:
        while True:
            await ws.receive_text()  # client pings keep the socket alive
    except WebSocketDisconnect:
        pass
    finally:
        hub.sockets[user["id"]].discard(ws)


# --- friends ----------------------------------------------------------------

@app.get(API + "/friends")
def friends(user=Depends(current_user)):
    with db() as conn:
        rows = conn.execute(
            """
            SELECT u.username, u.color,
                   EXISTS(SELECT 1 FROM friendships f WHERE f.user_id = :me AND f.friend_id = u.id) AS out,
                   EXISTS(SELECT 1 FROM friendships f WHERE f.user_id = u.id AND f.friend_id = :me) AS inc
            FROM users u
            WHERE u.id IN (SELECT friend_id FROM friendships WHERE user_id = :me
                           UNION SELECT user_id FROM friendships WHERE friend_id = :me)
            ORDER BY u.username
            """,
            {"me": user["id"]},
        ).fetchall()
    result = {"friends": [], "incoming": [], "outgoing": []}
    for r in rows:
        key = "friends" if r["out"] and r["inc"] else "outgoing" if r["out"] else "incoming"
        result[key].append({"username": r["username"], "color": r["color"]})
    return result


class AddFriend(BaseModel):
    username: str


@app.post(API + "/friends", dependencies=[Depends(limit("friend", 30, 60))])
async def add_friend(body: AddFriend, user=Depends(current_user)):
    """Send a request, or accept one if they already added you."""
    name = body.username.strip().lower().removeprefix("kiks:").removeprefix("kicksnap:")
    with db() as conn:
        other = conn.execute("SELECT * FROM users WHERE username = ?", (name,)).fetchone()
        # a block looks the same as no such person, from both sides
        if not other or blocked(conn, user["id"], other["id"]):
            raise HTTPException(404, "no one by that name")
        if other["id"] == user["id"]:
            raise HTTPException(400, "that's you")
        conn.execute(
            "INSERT OR IGNORE INTO friendships VALUES (?, ?, ?)", (user["id"], other["id"], now())
        )
        mutual = conn.execute(
            "SELECT 1 FROM friendships WHERE user_id = ? AND friend_id = ?", (other["id"], user["id"])
        ).fetchone()
    await hub.push(other["id"], {"type": "friends"})
    body = f"@{user['username']} accepted you 🙌" if mutual else f"@{user['username']} added you"
    asyncio.create_task(notify(other["id"], {"title": "Kiks", "body": body, "tag": f"friend-{user['username']}"}))
    return {"username": other["username"], "status": "friends" if mutual else "requested"}


@app.delete(API + "/friends/{username}")
async def remove_friend(username: str, user=Depends(current_user)):
    with db() as conn:
        other = conn.execute("SELECT id FROM users WHERE username = ?", (username,)).fetchone()
        if other:
            conn.execute(
                "DELETE FROM friendships WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)",
                (user["id"], other["id"], other["id"], user["id"]),
            )
    if other:
        await hub.push(other["id"], {"type": "friends"})
    return {"ok": True}


# --- snaps ------------------------------------------------------------------

@app.post(API + "/snaps", dependencies=[Depends(limit("snap", 30, 60))])
async def send_snap(
    file: UploadFile = File(...),
    overlay: UploadFile | None = File(None),
    to: str = Form(""),
    groups: str = Form(""),
    seconds: int = Form(5),
    user=Depends(current_user),
):
    names = {n.strip().lower() for n in to.split(",") if n.strip()}
    group_ids = {int(g) for g in groups.split(",") if g.strip().isdigit()}
    if not names and not group_ids:
        raise HTTPException(400, "pick someone")
    if seconds not in VIEW_SECONDS:
        raise HTTPException(400, "bad timer")
    mime = file.content_type or "application/octet-stream"
    kind = "video" if mime.startswith("video/") else "photo" if mime.startswith("image/") else None
    if not kind:
        raise HTTPException(400, "photos and videos only")

    snap_id = secrets.token_urlsafe(16)
    await save_upload(file, media_path(snap_id), MAX_UPLOAD_MB * 1024 * 1024)
    has_overlay = bool(overlay and overlay.filename)
    if has_overlay:
        if overlay.content_type != "image/png":
            burn(snap_id)
            raise HTTPException(400, "overlay must be png")
        await save_upload(overlay, overlay_path(snap_id), 5 * 1024 * 1024)

    me = user["id"]
    # one snap row per conversation: direct friends share one, each group gets its own
    # copy of the file, so each burns on its own schedule.
    sent: list[tuple[str, int | None, list]] = []
    with db() as conn:
        direct = [
            r for r in conn.execute(
                f"SELECT id, username, suspended_at, suspended_until FROM users WHERE username IN ({','.join('?' * len(names))})", tuple(names)
            ).fetchall()
            if are_friends(conn, me, r["id"]) and not suspended(r)
        ] if names else []
        targets: list[tuple[int | None, list, str]] = [(None, direct, "")] if direct else []
        for gid in group_ids:
            g = conn.execute("SELECT name FROM groups WHERE id = ?", (gid,)).fetchone()
            members = member_ids(conn, gid)
            if g and me in members:
                others = [{"id": m, "username": None} for m in members if m != me and not blocked(conn, me, m)]
                targets.append((gid, others, g["name"]))
        if not targets:
            burn(snap_id)
            raise HTTPException(400, "you can only snap friends")
        for n, (gid, recipients, _) in enumerate(targets):
            sid = snap_id if n == 0 else secrets.token_urlsafe(16)
            if n:
                shutil.copyfile(media_path(snap_id), media_path(sid))
                if has_overlay:
                    shutil.copyfile(overlay_path(snap_id), overlay_path(sid))
            conn.execute(
                "INSERT INTO snaps (id, sender_id, kind, mime, seconds, has_overlay, created_at, group_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (sid, me, kind, mime, seconds, int(has_overlay), now(), gid),
            )
            conn.executemany(
                "INSERT INTO deliveries (snap_id, recipient_id) VALUES (?, ?)", [(sid, r["id"]) for r in recipients]
            )
            sent.append((sid, gid, recipients))
    for _, gid, recipients in sent:
        for r in recipients:
            await hub.push(r["id"], {"type": "snap", "from": user["username"]})
            where = next((t[2] for t in targets if t[0] == gid), "") if gid else ""
            body = f"new snap from @{user['username']} in {where} 📸" if gid else f"new snap from @{user['username']} 📸"
            asyncio.create_task(notify(r["id"], {"title": "Kiks", "body": body, "tag": f"g:{gid}" if gid else user["username"]}))
    sent_to = [r["username"] for r in direct] + [t[2] for t in targets if t[0]]
    return {"id": snap_id, "sent_to": sent_to}


def _delivery(conn, snap_id: str, user_id: int):
    row = conn.execute(
        """SELECT s.*, d.opened_at FROM snaps s JOIN deliveries d ON d.snap_id = s.id
           WHERE s.id = ? AND d.recipient_id = ?""",
        (snap_id, user_id),
    ).fetchone()
    if not row or row["opened_at"] or not media_path(snap_id).exists():
        raise HTTPException(404, "gone")
    return row


@app.get(API + "/snaps/{snap_id}/media")
def snap_media(snap_id: str, user=Depends(current_user)):
    with db() as conn:
        row = _delivery(conn, snap_id, user["id"])
    return FileResponse(media_path(snap_id), media_type=row["mime"], headers={"Cache-Control": "no-store"})


@app.get(API + "/snaps/{snap_id}/overlay")
def snap_overlay(snap_id: str, user=Depends(current_user)):
    with db() as conn:
        _delivery(conn, snap_id, user["id"])
    if not overlay_path(snap_id).exists():
        raise HTTPException(404, "no overlay")
    return FileResponse(overlay_path(snap_id), media_type="image/png", headers={"Cache-Control": "no-store"})


@app.post(API + "/snaps/{snap_id}/open")
async def open_snap(snap_id: str, user=Depends(current_user)):
    """Burn it for this viewer. Media is deleted once every recipient has opened it."""
    with db() as conn:
        row = _delivery(conn, snap_id, user["id"])
        conn.execute(
            "UPDATE deliveries SET opened_at = ? WHERE snap_id = ? AND recipient_id = ?",
            (now(), snap_id, user["id"]),
        )
        left = conn.execute(
            "SELECT COUNT(*) FROM deliveries WHERE snap_id = ? AND opened_at IS NULL", (snap_id,)
        ).fetchone()[0]
    if not left:
        burn(snap_id)
    await hub.push(row["sender_id"], {"type": "opened", "by": user["username"]})
    return {"ok": True}


# --- burn loop --------------------------------------------------------------

def burn_expired() -> int:
    cutoff = now() - SNAP_TTL_HOURS * 3600
    with db() as conn:
        old = [r["id"] for r in conn.execute("SELECT id FROM snaps WHERE created_at < ?", (cutoff,))]
        for snap_id in old:
            burn(snap_id)
        conn.execute("DELETE FROM snaps WHERE created_at < ?", (cutoff,))
        conn.execute("DELETE FROM messages WHERE created_at < ?", (cutoff,))
        conn.execute("DELETE FROM reserved_usernames WHERE expires_at IS NOT NULL AND expires_at < ?", (now(),))
        # accounts that never picked a name
        conn.execute("DELETE FROM users WHERE username IS NULL AND created_at < ?", (now() - 86400,))
    return len(old)


async def burn_loop():
    while True:
        try:
            burn_expired()
        except Exception:  # keep burning next minute; a dead loop would keep snaps forever
            errors.record()
            errors.log.exception("burn loop failed")
        await asyncio.sleep(60)


@app.on_event("startup")
async def startup():
    store.init()
    asyncio.create_task(burn_loop())


@app.get(API + "/health")
def health():
    """For Docker's HEALTHCHECK and uptime monitors: 503 if the database can't be read."""
    out = {"ok": True, "api": API, "version": __version__, "db": "ok", **errors.summary()}
    try:
        with db() as conn:
            conn.execute("SELECT COUNT(*) FROM users").fetchone()
    except Exception as e:
        errors.log.error("health: database check failed: %s", e)
        return JSONResponse({**out, "ok": False, "db": "error"}, status_code=503)
    return out


# --- frontend ---------------------------------------------------------------

if STATIC_DIR.exists():
    app.mount("/assets", StaticFiles(directory=STATIC_DIR / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str):
        target = (STATIC_DIR / path).resolve()
        if path and target.is_file() and STATIC_DIR.resolve() in target.parents:
            return FileResponse(target)
        return FileResponse(STATIC_DIR / "index.html")

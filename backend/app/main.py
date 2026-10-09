import asyncio
import os
import re
import secrets
import time
from collections import defaultdict
from pathlib import Path

from fastapi import (
    Depends, FastAPI, File, Form, HTTPException, UploadFile, WebSocket, WebSocketDisconnect,
)
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import db as store
from .auth import COOKIE, current_user, public, router as auth_router, user_for_token
from .db import MEDIA_DIR, db
from .push import notify, router as push_router

SNAP_TTL_HOURS = int(os.getenv("SNAP_TTL_HOURS", "24"))
MAX_UPLOAD_MB = int(os.getenv("MAX_UPLOAD_MB", "50"))
STATIC_DIR = Path(os.getenv("STATIC_DIR", "../frontend/dist"))
VIEW_SECONDS = {0, 3, 5, 10}

app = FastAPI(title="Kicksnap", docs_url="/api/docs", openapi_url="/api/openapi.json")
app.include_router(auth_router)
app.include_router(push_router)


def now() -> int:
    return int(time.time())


class Profile(BaseModel):
    color: str


@app.patch("/api/me")
def update_me(body: Profile, user=Depends(current_user)):
    if not re.match(r"^#[0-9a-fA-F]{6}$", body.color):
        raise HTTPException(400, "bad color")
    with db() as conn:
        conn.execute("UPDATE users SET color = ? WHERE id = ?", (body.color, user["id"]))
    return {**public(user), "color": body.color}


# --- realtime ---------------------------------------------------------------

class Hub:
    def __init__(self):
        self.sockets: dict[int, set[WebSocket]] = defaultdict(set)

    async def push(self, user_id: int, event: dict):
        for ws in list(self.sockets.get(user_id, ())):
            try:
                await ws.send_json(event)
            except Exception:
                self.sockets[user_id].discard(ws)


hub = Hub()


@app.websocket("/ws")
async def socket(ws: WebSocket):
    user = user_for_token(ws.cookies.get(COOKIE))
    if not user or not user["username"]:
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

@app.get("/api/friends")
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


@app.post("/api/friends")
async def add_friend(body: AddFriend, user=Depends(current_user)):
    """Send a request, or accept one if they already added you."""
    name = body.username.strip().lower().removeprefix("kicksnap:")
    with db() as conn:
        other = conn.execute("SELECT * FROM users WHERE username = ?", (name,)).fetchone()
        if not other:
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
    asyncio.create_task(notify(other["id"], {"title": "kicksnap", "body": body, "tag": f"friend-{user['username']}"}))
    return {"username": other["username"], "status": "friends" if mutual else "requested"}


@app.delete("/api/friends/{username}")
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


def are_friends(conn, a: int, b: int) -> bool:
    return conn.execute(
        "SELECT COUNT(*) FROM friendships WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)",
        (a, b, b, a),
    ).fetchone()[0] == 2


# --- snaps ------------------------------------------------------------------

def media_path(snap_id: str) -> Path:
    return MEDIA_DIR / snap_id


def overlay_path(snap_id: str) -> Path:
    return MEDIA_DIR / f"{snap_id}.overlay.png"


def burn(snap_id: str):
    media_path(snap_id).unlink(missing_ok=True)
    overlay_path(snap_id).unlink(missing_ok=True)


async def save_upload(upload: UploadFile, dest: Path, limit: int) -> None:
    size = 0
    with dest.open("wb") as out:
        while chunk := await upload.read(1024 * 1024):
            size += len(chunk)
            if size > limit:
                out.close()
                dest.unlink(missing_ok=True)
                raise HTTPException(413, "too big")
            out.write(chunk)


@app.post("/api/snaps")
async def send_snap(
    file: UploadFile = File(...),
    overlay: UploadFile | None = File(None),
    to: str = Form(...),
    seconds: int = Form(5),
    user=Depends(current_user),
):
    names = {n.strip().lower() for n in to.split(",") if n.strip()}
    if not names:
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

    with db() as conn:
        recipients = [
            r for r in conn.execute(
                f"SELECT id, username FROM users WHERE username IN ({','.join('?' * len(names))})",
                tuple(names),
            ).fetchall()
            if are_friends(conn, user["id"], r["id"])
        ]
        if not recipients:
            burn(snap_id)
            raise HTTPException(400, "you can only snap friends")
        conn.execute(
            "INSERT INTO snaps VALUES (?, ?, ?, ?, ?, ?, ?)",
            (snap_id, user["id"], kind, mime, seconds, int(has_overlay), now()),
        )
        conn.executemany(
            "INSERT INTO deliveries (snap_id, recipient_id) VALUES (?, ?)",
            [(snap_id, r["id"]) for r in recipients],
        )
    for r in recipients:
        await hub.push(r["id"], {"type": "snap", "from": user["username"]})
        asyncio.create_task(notify(r["id"], {"title": "kicksnap", "body": f"new snap from @{user['username']} 📸", "tag": user["username"]}))
    return {"id": snap_id, "sent_to": [r["username"] for r in recipients]}


@app.get("/api/chats")
def chats(user=Depends(current_user)):
    """One row per friend with Snapchat-style state: new / received / delivered / opened."""
    me = user["id"]
    with db() as conn:
        friends_ = conn.execute(
            """
            SELECT u.id, u.username, u.color FROM friendships a
            JOIN friendships b ON b.user_id = a.friend_id AND b.friend_id = a.user_id
            JOIN users u ON u.id = a.friend_id WHERE a.user_id = ?
            """,
            (me,),
        ).fetchall()
        out = []
        for f in friends_:
            new = conn.execute(
                """SELECT s.id, s.kind, s.seconds, s.has_overlay, s.created_at FROM snaps s
                   JOIN deliveries d ON d.snap_id = s.id
                   WHERE s.sender_id = ? AND d.recipient_id = ? AND d.opened_at IS NULL
                   ORDER BY s.created_at""",
                (f["id"], me),
            ).fetchall()
            last = conn.execute(
                """SELECT s.sender_id, s.created_at, d.opened_at FROM snaps s
                   JOIN deliveries d ON d.snap_id = s.id
                   WHERE (s.sender_id = :me AND d.recipient_id = :f) OR (s.sender_id = :f AND d.recipient_id = :me)
                   ORDER BY s.created_at DESC LIMIT 1""",
                {"me": me, "f": f["id"]},
            ).fetchone()
            if new:
                state, at = "new", new[-1]["created_at"]
            elif last is None:
                state, at = "none", 0
            elif last["sender_id"] == me:
                state = "opened" if last["opened_at"] else "delivered"
                at = last["opened_at"] or last["created_at"]
            else:
                state, at = "received", last["opened_at"] or last["created_at"]
            out.append({
                "username": f["username"], "color": f["color"], "state": state, "at": at,
                "snaps": [dict(s) for s in new],
            })
    out.sort(key=lambda c: (c["state"] != "new", -c["at"], c["username"]))
    return out


def _delivery(conn, snap_id: str, user_id: int):
    row = conn.execute(
        """SELECT s.*, d.opened_at FROM snaps s JOIN deliveries d ON d.snap_id = s.id
           WHERE s.id = ? AND d.recipient_id = ?""",
        (snap_id, user_id),
    ).fetchone()
    if not row or row["opened_at"] or not media_path(snap_id).exists():
        raise HTTPException(404, "gone")
    return row


@app.get("/api/snaps/{snap_id}/media")
def snap_media(snap_id: str, user=Depends(current_user)):
    with db() as conn:
        row = _delivery(conn, snap_id, user["id"])
    return FileResponse(media_path(snap_id), media_type=row["mime"], headers={"Cache-Control": "no-store"})


@app.get("/api/snaps/{snap_id}/overlay")
def snap_overlay(snap_id: str, user=Depends(current_user)):
    with db() as conn:
        _delivery(conn, snap_id, user["id"])
    if not overlay_path(snap_id).exists():
        raise HTTPException(404, "no overlay")
    return FileResponse(overlay_path(snap_id), media_type="image/png", headers={"Cache-Control": "no-store"})


@app.post("/api/snaps/{snap_id}/open")
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
        # accounts that never picked a name
        conn.execute("DELETE FROM users WHERE username IS NULL AND created_at < ?", (now() - 86400,))
    return len(old)


async def burn_loop():
    while True:
        burn_expired()
        await asyncio.sleep(60)


@app.on_event("startup")
async def startup():
    store.init()
    asyncio.create_task(burn_loop())


@app.get("/api/health")
def health():
    return {"ok": True}


# --- frontend ---------------------------------------------------------------

if STATIC_DIR.exists():
    app.mount("/assets", StaticFiles(directory=STATIC_DIR / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str):
        target = (STATIC_DIR / path).resolve()
        if path and target.is_file() and STATIC_DIR.resolve() in target.parents:
            return FileResponse(target)
        return FileResponse(STATIC_DIR / "index.html")

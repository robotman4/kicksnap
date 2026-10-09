"""
Reports and the admin side: a queue in the database, no email, no scores.

Admins are flagged from the server shell (python -m app.admin grant <name>).
Every admin action lands in admin_log.
"""
import asyncio
import secrets
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from .api import API
from .auth import USERNAME_RE, current_user, now, suspended
from .chat import are_friends
from .db import MEDIA_DIR, db
from .hub import hub
from .limits import limit
from .media import save_upload
from .push import notify
from .safety import tell_gone, wipe

router = APIRouter(prefix=API)

REASONS = {"spam", "nudity", "harassment", "violence", "other"}
REPORT_DIR = MEDIA_DIR / "reports"
MAX_REPORT_MB = 50
MAX_TEXTS = 10
MAX_SHOTS = 3
MAX_SHOT_MB = 10


def report_file(name: str) -> Path:
    return REPORT_DIR / name


def drop_media(conn, where: str, args: tuple):
    """Deletes attached snaps and screenshots from disk. Copied texts stay with the closed report."""
    for r in conn.execute(f"SELECT media FROM reports WHERE media IS NOT NULL AND {where}", args).fetchall():
        report_file(r[0]).unlink(missing_ok=True)
    conn.execute(f"UPDATE reports SET media = NULL, media_mime = NULL WHERE {where}", args)
    ids = f"SELECT id FROM reports WHERE {where}"
    for r in conn.execute(f"SELECT file FROM report_items WHERE file IS NOT NULL AND report_id IN ({ids})", args).fetchall():
        report_file(r[0]).unlink(missing_ok=True)
    conn.execute(f"DELETE FROM report_items WHERE kind = 'image' AND report_id IN ({ids})", args)


def their_texts(conn, me: int, them: int, ids: list[int] | None = None, limit: int = 30):
    """Texts `them` sent that `me` could see: to me directly, or in a group I'm in."""
    pick = f"AND m.id IN ({','.join('?' * len(ids))})" if ids else ""
    return conn.execute(
        f"""SELECT m.id, m.body, m.created_at, g.name AS group_name
            FROM messages m LEFT JOIN groups g ON g.id = m.group_id
            WHERE m.sender_id = ?
              AND (m.to_user = ? OR m.group_id IN (SELECT group_id FROM group_members WHERE user_id = ?))
              {pick}
            ORDER BY m.created_at DESC, m.id DESC LIMIT ?""",
        (them, me, me, *(ids or []), limit),
    ).fetchall()


def _named(conn, username: str, me: int):
    other = conn.execute("SELECT id, username FROM users WHERE username = ?", (username.strip().lower().lstrip("@"),)).fetchone()
    if not other or other["id"] == me:
        raise HTTPException(404, "no one by that name")
    return other


def log(conn, admin: str, action: str, target: str, detail: str = ""):
    conn.execute(
        "INSERT INTO admin_log (admin, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?)",
        (admin, action, target, detail, now()),
    )


# --- reporting (everyone) -----------------------------------------------------

@router.get("/reports/texts/{username}")
def report_texts(username: str, user=Depends(current_user)):
    """Their recent texts you can pick as proof (texts burn after 24h, so this is what's left)."""
    with db() as conn:
        other = _named(conn, username, user["id"])
        rows = their_texts(conn, user["id"], other["id"])
    return [{"id": r["id"], "body": r["body"], "at": r["created_at"], "group": r["group_name"]} for r in rows]


@router.post("/reports", dependencies=[Depends(limit("report", 10, 3600))])
async def report(
    username: str = Form(...),
    reason: str = Form(...),
    note: str = Form(""),
    block: bool = Form(True),
    file: UploadFile | None = File(None),
    message_ids: list[int] = Form([]),
    shots: list[UploadFile] = File([]),
    user=Depends(current_user),
):
    """Report someone. Proof is optional: the snap you were looking at, texts of theirs you could
    see (copied now, since texts burn), and up to 3 screenshots. Blocks them too by default."""
    me = user["id"]
    if reason not in REASONS:
        raise HTTPException(400, "pick a reason")
    note = note.strip()[:500]
    shots = [f for f in shots if f and f.filename]
    if len(message_ids) > MAX_TEXTS:
        raise HTTPException(400, f"pick up to {MAX_TEXTS} texts")
    if len(shots) > MAX_SHOTS:
        raise HTTPException(400, f"up to {MAX_SHOTS} screenshots")
    if any(not (f.content_type or "").startswith("image/") for f in shots):
        raise HTTPException(400, "screenshots must be images")
    with db() as conn:
        other = _named(conn, username, me)
        texts = their_texts(conn, me, other["id"], list(dict.fromkeys(message_ids)), MAX_TEXTS) if message_ids else []
        if len(texts) != len(set(message_ids)):
            raise HTTPException(400, "some of those texts are gone, pick again")
        was_friend = are_friends(conn, me, other["id"])
        queue_was_empty = not conn.execute("SELECT 1 FROM reports WHERE closed_at IS NULL").fetchone()

    media = mime = None
    if file and file.filename:
        mime = file.content_type or ""
        if not (mime.startswith("image/") or mime.startswith("video/")):
            raise HTTPException(400, "photos and videos only")
        REPORT_DIR.mkdir(parents=True, exist_ok=True)
        media = secrets.token_urlsafe(16)
        await save_upload(file, report_file(media), MAX_REPORT_MB * 1024 * 1024)
    saved = []
    try:
        for f in shots:
            REPORT_DIR.mkdir(parents=True, exist_ok=True)
            name = secrets.token_urlsafe(16)
            await save_upload(f, report_file(name), MAX_SHOT_MB * 1024 * 1024)
            saved.append((name, f.content_type))
    except HTTPException:
        for name in [n for n, _ in saved] + ([media] if media else []):
            report_file(name).unlink(missing_ok=True)
        raise

    with db() as conn:
        rid = conn.execute(
            """INSERT INTO reports (reporter_id, reporter_name, reported_id, reported_name, reason, note, media, media_mime, was_friend, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (me, user["username"], other["id"], other["username"], reason, note, media, mime, int(was_friend), now()),
        ).lastrowid
        for t in sorted(texts, key=lambda t: (t["created_at"], t["id"])):
            conn.execute(
                "INSERT INTO report_items (report_id, kind, body, place, at) VALUES (?, 'text', ?, ?, ?)",
                (rid, t["body"], t["group_name"] or "direct", t["created_at"]),
            )
        for name, shot_mime in saved:
            conn.execute(
                "INSERT INTO report_items (report_id, kind, file, mime, at) VALUES (?, 'image', ?, ?, ?)",
                (rid, name, shot_mime, now()),
            )
        admins = [r[0] for r in conn.execute("SELECT id FROM users WHERE is_admin = 1")]
    if block:
        from .safety import Who, block as do_block

        await do_block(Who(username=other["username"]), user)
    # the only notification there is: the queue just stopped being empty
    if queue_was_empty:
        for a in admins:
            asyncio.create_task(notify(a, {"title": "kicksnap", "body": "there's a report to look at", "tag": "admin-reports"}))
    for a in admins:
        await hub.push(a, {"type": "reports"})
    return {"ok": True}


# --- admin --------------------------------------------------------------------

def admin_user(user=Depends(current_user)):
    if not user["is_admin"]:
        raise HTTPException(404, "not found")
    return user


def _target(conn, name: str, actor):
    u = conn.execute("SELECT * FROM users WHERE username = ?", (name.lower(),)).fetchone()
    if not u:
        raise HTTPException(404, "no one by that name")
    if u["is_admin"] or u["id"] == actor["id"]:
        raise HTTPException(400, "admins can't act on admins; revoke from the server shell first")
    return u


def _close_reports(conn, reported_id: int, admin: str, outcome: str, only: int | None = None):
    where, args = ("id = ? AND closed_at IS NULL", (only,)) if only else ("reported_id = ? AND closed_at IS NULL", (reported_id,))
    drop_media(conn, where, args)
    conn.execute(f"UPDATE reports SET closed_at = ?, closed_by = ?, outcome = ? WHERE {where}", (now(), admin, outcome, *args))


@router.get("/admin/reports")
def open_reports(admin=Depends(admin_user)):
    with db() as conn:
        rows = conn.execute(
            """SELECT r.*,
                      (SELECT COUNT(DISTINCT r2.reporter_id) FROM reports r2
                       WHERE r2.reported_id = r.reported_id AND r2.was_friend = 1) AS friend_reporters,
                      u.suspended_at, u.suspended_until
               FROM reports r LEFT JOIN users u ON u.id = r.reported_id
               WHERE r.closed_at IS NULL""",
        ).fetchall()
        items: dict[int, list] = {}
        for i in conn.execute(
            "SELECT * FROM report_items WHERE report_id IN (SELECT id FROM reports WHERE closed_at IS NULL) ORDER BY at, id"
        ):
            items.setdefault(i["report_id"], []).append(i)
    out = [
        {
            "id": r["id"],
            "reported": r["reported_name"],
            "reported_gone": r["reported_id"] is None,
            "reported_suspended": bool(r["reported_id"]) and suspended(r),
            "reporter": r["reporter_name"],
            "reason": r["reason"],
            "note": r["note"],
            "media": f"{API}/admin/reports/{r['id']}/media" if r["media"] else None,
            "media_kind": ("video" if (r["media_mime"] or "").startswith("video/") else "photo") if r["media"] else None,
            "texts": [{"body": i["body"], "at": i["at"], "group": None if i["place"] == "direct" else i["place"]}
                      for i in items.get(r["id"], []) if i["kind"] == "text"],
            "shots": [f"{API}/admin/reports/{r['id']}/shots/{i['id']}" for i in items.get(r["id"], []) if i["kind"] == "image"],
            "was_friend": bool(r["was_friend"]),
            "friend_reporters": r["friend_reporters"],
            "at": r["created_at"],
        }
        for r in rows
    ]
    # the count only sorts the queue; it never acts on its own
    out.sort(key=lambda r: (-r["friend_reporters"], r["at"]))
    return out


@router.get("/admin/reports/{report_id}/media")
def report_media(report_id: int, admin=Depends(admin_user)):
    with db() as conn:
        r = conn.execute("SELECT media, media_mime FROM reports WHERE id = ?", (report_id,)).fetchone()
    if not r or not r["media"] or not report_file(r["media"]).exists():
        raise HTTPException(404, "gone")
    return FileResponse(report_file(r["media"]), media_type=r["media_mime"], headers={"Cache-Control": "no-store"})


@router.get("/admin/reports/{report_id}/shots/{item_id}")
def report_shot(report_id: int, item_id: int, admin=Depends(admin_user)):
    with db() as conn:
        i = conn.execute("SELECT file, mime FROM report_items WHERE id = ? AND report_id = ?", (item_id, report_id)).fetchone()
    if not i or not i["file"] or not report_file(i["file"]).exists():
        raise HTTPException(404, "gone")
    return FileResponse(report_file(i["file"]), media_type=i["mime"], headers={"Cache-Control": "no-store"})


@router.post("/admin/reports/{report_id}/dismiss")
def dismiss(report_id: int, admin=Depends(admin_user)):
    with db() as conn:
        r = conn.execute("SELECT reported_name FROM reports WHERE id = ? AND closed_at IS NULL", (report_id,)).fetchone()
        if not r:
            raise HTTPException(404, "already handled")
        _close_reports(conn, 0, admin["username"], "dismissed", only=report_id)
        log(conn, admin["username"], "dismiss", r["reported_name"], f"report {report_id}")
    return {"ok": True}


class Suspend(BaseModel):
    days: int | None = None  # None = until lifted
    report_id: int | None = None


@router.post("/admin/users/{username}/suspend")
async def suspend(username: str, body: Suspend, admin=Depends(admin_user)):
    with db() as conn:
        u = _target(conn, username, admin)
        until = now() + body.days * 86400 if body.days else None
        conn.execute("UPDATE users SET suspended_at = ?, suspended_until = ? WHERE id = ?", (now(), until, u["id"]))
        _close_reports(conn, u["id"], admin["username"], "suspended")
        log(conn, admin["username"], "suspend", u["username"], f"{body.days} days" if body.days else "until lifted")
        friends = [r[0] for r in conn.execute("SELECT friend_id FROM friendships WHERE user_id = ?", (u["id"],))]
    # kick their open app; friends refresh and see them as unavailable
    for ws in list(hub.sockets.pop(u["id"], ())):
        try:
            await ws.close(code=4403)
        except Exception:
            pass
    for f in friends:
        await hub.push(f, {"type": "friends"})
    return {"ok": True}


@router.post("/admin/users/{username}/unsuspend")
async def unsuspend(username: str, admin=Depends(admin_user)):
    with db() as conn:
        u = _target(conn, username, admin)
        conn.execute("UPDATE users SET suspended_at = NULL, suspended_until = NULL WHERE id = ?", (u["id"],))
        log(conn, admin["username"], "unsuspend", u["username"])
        friends = [r[0] for r in conn.execute("SELECT friend_id FROM friendships WHERE user_id = ?", (u["id"],))]
    for f in friends:
        await hub.push(f, {"type": "friends"})
    return {"ok": True}


class Delete(BaseModel):
    reserve: bool = True  # on by default, so nobody grabs the name and poses as them
    report_id: int | None = None


def delete_user(conn, admin_name: str, u, reserve: bool):
    _close_reports(conn, u["id"], admin_name, "deleted")
    friends, peers = wipe(conn, u["id"])
    if reserve:
        conn.execute(
            """INSERT INTO reserved_usernames (name, reason, created_at, created_by) VALUES (?, 'deleted by admin', ?, ?)
               ON CONFLICT (name) DO UPDATE SET expires_at = NULL, reason = excluded.reason, created_by = excluded.created_by""",
            (u["username"], now(), admin_name),
        )
    log(conn, admin_name, "delete", u["username"], "name reserved" if reserve else "name freed")
    return friends, peers


@router.post("/admin/users/{username}/delete")
async def delete(username: str, body: Delete, admin=Depends(admin_user)):
    with db() as conn:
        u = _target(conn, username, admin)
        friends, peers = delete_user(conn, admin["username"], u, body.reserve)
    await tell_gone(u["id"], friends, peers)
    return {"ok": True}


@router.get("/admin/users")
def users(q: str = "", admin=Depends(admin_user)):
    with db() as conn:
        rows = conn.execute(
            """SELECT u.*, (SELECT COUNT(*) FROM devices d WHERE d.user_id = u.id) AS devices,
                      (SELECT COUNT(*) FROM reports r WHERE r.reported_id = u.id AND r.closed_at IS NULL) AS open_reports
               FROM users u WHERE u.username IS NOT NULL AND u.username LIKE ? ESCAPE '\\'
               ORDER BY u.username LIMIT 50""",
            ("%" + q.strip().lower().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%",),
        ).fetchall()
    return [
        {
            "username": r["username"],
            "color": r["color"],
            "created_at": r["created_at"],
            "devices": r["devices"],
            "admin": bool(r["is_admin"]),
            "suspended": suspended(r),
            "suspended_until": r["suspended_until"] if suspended(r) else None,
            "open_reports": r["open_reports"],
        }
        for r in rows
    ]


class Reserve(BaseModel):
    name: str
    reason: str = ""


@router.get("/admin/reserved")
def reserved(admin=Depends(admin_user)):
    with db() as conn:
        rows = conn.execute(
            "SELECT * FROM reserved_usernames WHERE expires_at IS NULL OR expires_at > ? ORDER BY name", (now(),)
        ).fetchall()
    return [{"name": r["name"], "reason": r["reason"], "by": r["created_by"], "at": r["created_at"], "expires_at": r["expires_at"]} for r in rows]


@router.post("/admin/reserved")
def add_reserved(body: Reserve, admin=Depends(admin_user)):
    name = body.name.strip().lower().lstrip("@")
    if not USERNAME_RE.match(name):
        raise HTTPException(400, "3-20 letters, numbers, _ or .")
    with db() as conn:
        conn.execute(
            """INSERT INTO reserved_usernames (name, reason, created_at, created_by) VALUES (?, ?, ?, ?)
               ON CONFLICT (name) DO UPDATE SET expires_at = NULL, reason = excluded.reason""",
            (name, body.reason.strip()[:100], now(), admin["username"]),
        )
        log(conn, admin["username"], "reserve", name, body.reason.strip()[:100])
    return {"ok": True}


@router.delete("/admin/reserved/{name}")
def remove_reserved(name: str, admin=Depends(admin_user)):
    with db() as conn:
        conn.execute("DELETE FROM reserved_usernames WHERE name = ?", (name.lower(),))
        log(conn, admin["username"], "release", name.lower())
    return {"ok": True}


@router.get("/admin/log")
def admin_log(admin=Depends(admin_user)):
    with db() as conn:
        rows = conn.execute("SELECT * FROM admin_log ORDER BY id DESC LIMIT 100").fetchall()
    return [{"admin": r["admin"], "action": r["action"], "target": r["target"], "detail": r["detail"], "at": r["created_at"]} for r in rows]

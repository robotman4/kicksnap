"""
Reports and the admin side: a queue in the database, no email, no scores.

Admins are flagged from the server shell (python -m app.admin grant <name>).
Every admin action lands in admin_log.
"""
import asyncio
import json
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
from .keys import sha, signed_by, snap_signed_text, text_signed_text
from .media import save_upload
from .push import notify
from .safety import any_named_user, tell_gone, wipe

router = APIRouter(prefix=API)

REASONS = {"spam", "nudity", "harassment", "violence", "other"}
REASON_TEXT = {"spam": "spam or scams", "nudity": "nudity or sexual content", "harassment": "bullying or harassment",
               "violence": "violence or threats", "other": "breaking this server's rules"}
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
    conn.execute(f"DELETE FROM report_items WHERE kind IN ('image', 'overlay') AND report_id IN ({ids})", args)


def queue_empty(conn) -> bool:
    """Nothing open for admins: no reports, no appeals."""
    return not conn.execute(
        "SELECT 1 FROM reports WHERE closed_at IS NULL UNION ALL SELECT 1 FROM appeals WHERE closed_at IS NULL LIMIT 1"
    ).fetchone()


async def tell_admins(queue_was_empty: bool, what: str):
    """Live refresh for open admin views; a push only when the queue just stopped being empty."""
    with db() as conn:
        admins = [r[0] for r in conn.execute("SELECT id FROM users WHERE is_admin = 1")]
    if queue_was_empty:
        for a in admins:
            asyncio.create_task(notify(a, {"title": "Kiks", "body": f"there's {what} to look at", "tag": "admin-reports"}))
    for a in admins:
        await hub.push(a, {"type": "reports"})


def their_texts(conn, me: int, them: int, ids: list[int] | None = None, limit: int = 30, device: int = 0):
    """Texts `them` sent that `me` could see: to me directly, or in a group I'm in.
    E2E texts come with the wrapped key for `device`, so the reporter can decrypt and pick."""
    pick = f"AND m.id IN ({','.join('?' * len(ids))})" if ids else ""
    return conn.execute(
        f"""SELECT m.id, m.body, m.created_at, m.e2e, m.group_id, g.name AS group_name, k.key
            FROM messages m LEFT JOIN groups g ON g.id = m.group_id
            LEFT JOIN message_keys k ON k.message_id = m.id AND k.device_id = ?
            WHERE m.sender_id = ?
              AND (m.to_user = ? OR m.group_id IN (SELECT group_id FROM group_members WHERE user_id = ?))
              {pick}
            ORDER BY m.created_at DESC, m.id DESC LIMIT ?""",
        (device, them, me, me, *(ids or []), limit),
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
        rows = their_texts(conn, user["id"], other["id"], device=user["device_id"])
    return [
        {"id": r["id"], "body": r["body"], "at": r["created_at"], "group": r["group_name"], "e2e": bool(r["e2e"]), "key": r["key"],
         "to": f"g:{r['group_id']}" if r["group_id"] else f"u:{user['username']}"}
        for r in rows
    ]


def _json_form(raw: str, kind: type):
    if not raw:
        return None
    try:
        out = json.loads(raw)
    except ValueError:
        raise HTTPException(400, "bad proof")
    if not isinstance(out, kind):
        raise HTTPException(400, "bad proof")
    return out


@router.post("/reports", dependencies=[Depends(limit("report", 10, 3600))])
async def report(
    username: str = Form(...),
    reason: str = Form(...),
    note: str = Form(""),
    block: bool = Form(True),
    file: UploadFile | None = File(None),
    overlay: UploadFile | None = File(None),
    snap_proof: str = Form(""),
    message_ids: list[int] = Form([]),
    text_proofs: str = Form(""),
    shots: list[UploadFile] = File([]),
    user=Depends(current_user),
):
    """Report someone. Proof is optional: the snap you were looking at, texts of theirs you could
    see (copied now, since texts burn), and up to 3 screenshots. Blocks them too by default.

    Snaps and texts are end-to-end encrypted, so the reporter's app sends what it decrypted
    plus the sender's signature (docs/e2e.md). We check it, so admins can see whether the
    proof is really from them."""
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
    proofs = {int(p.get("id", 0)): p for p in (_json_form(text_proofs, list) or []) if isinstance(p, dict)}
    sproof = _json_form(snap_proof, dict)
    with db() as conn:
        other = _named(conn, username, me)
        identity = conn.execute("SELECT identity_key FROM users WHERE id = ?", (other["id"],)).fetchone()["identity_key"]
        texts = their_texts(conn, me, other["id"], list(dict.fromkeys(message_ids)), MAX_TEXTS) if message_ids else []
        if len(texts) != len(set(message_ids)):
            raise HTTPException(400, "some of those texts are gone, pick again")
        # (body, place, at, verified) per text; E2E ones carry what the reporter decrypted
        copies = []
        for t in sorted(texts, key=lambda t: (t["created_at"], t["id"])):
            if not t["e2e"]:
                copies.append((t["body"], t["group_name"] or "direct", t["created_at"], None))
                continue
            p = proofs.get(t["id"])
            if not p or not isinstance(p.get("body"), str):
                raise HTTPException(400, "some of those texts couldn't be read, pick again")
            to = f"g:{t['group_id']}" if t["group_id"] else f"u:{user['username']}"
            ok = signed_by(identity, str(p.get("sig", "")), text_signed_text(other["username"], to, p))
            copies.append((p["body"][:2000], t["group_name"] or "direct", t["created_at"], int(ok)))
        snap_row = None
        if sproof:
            snap_row = conn.execute(
                """SELECT s.id, s.group_id, s.sender_id FROM snaps s JOIN deliveries d ON d.snap_id = s.id
                   WHERE s.id = ? AND d.recipient_id = ? AND s.e2e = 1""",
                (str(sproof.get("snap_id", "")), me),
            ).fetchone()
        was_friend = are_friends(conn, me, other["id"])
        queue_was_empty = queue_empty(conn)

    media = mime = None
    if file and file.filename:
        mime = file.content_type or ""
        if not (mime.startswith("image/") or mime.startswith("video/")):
            raise HTTPException(400, "photos and videos only")
        REPORT_DIR.mkdir(parents=True, exist_ok=True)
        media = secrets.token_urlsafe(16)
        await save_upload(file, report_file(media), MAX_REPORT_MB * 1024 * 1024)
    media_verified = None
    overlay_name = None
    if media and sproof:
        media_verified = 0
        if overlay and overlay.filename:
            overlay_name = secrets.token_urlsafe(16)
            await save_upload(overlay, report_file(overlay_name), 5 * 1024 * 1024)
        if snap_row and snap_row["sender_id"] == other["id"]:
            to = f"g:{snap_row['group_id']}" if snap_row["group_id"] else f"u:{user['username']}"
            media_hash = sha(report_file(media).read_bytes())
            overlay_ok = (sproof.get("overlay") or None) == (sha(report_file(overlay_name).read_bytes()) if overlay_name else None)
            signed = signed_by(identity, str(sproof.get("sig", "")), snap_signed_text(other["username"], to, sproof, media_hash))
            media_verified = int(signed and overlay_ok)
    saved = []
    try:
        for f in shots:
            REPORT_DIR.mkdir(parents=True, exist_ok=True)
            name = secrets.token_urlsafe(16)
            await save_upload(f, report_file(name), MAX_SHOT_MB * 1024 * 1024)
            saved.append((name, f.content_type))
    except HTTPException:
        for name in [n for n, _ in saved] + [n for n in (media, overlay_name) if n]:
            report_file(name).unlink(missing_ok=True)
        raise

    with db() as conn:
        rid = conn.execute(
            """INSERT INTO reports (reporter_id, reporter_name, reported_id, reported_name, reason, note, media, media_mime, was_friend, created_at, media_verified)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (me, user["username"], other["id"], other["username"], reason, note, media, mime, int(was_friend), now(), media_verified),
        ).lastrowid
        conn.executemany(
            "INSERT INTO report_items (report_id, kind, body, place, at, verified) VALUES (?, 'text', ?, ?, ?, ?)",
            [(rid, *c) for c in copies],
        )
        if overlay_name:
            conn.execute(
                "INSERT INTO report_items (report_id, kind, file, mime, at) VALUES (?, 'overlay', ?, 'image/png', ?)",
                (rid, overlay_name, now()),
            )
        for name, shot_mime in saved:
            conn.execute(
                "INSERT INTO report_items (report_id, kind, file, mime, at) VALUES (?, 'image', ?, ?, ?)",
                (rid, name, shot_mime, now()),
            )
    if block:
        from .safety import Who, block as do_block

        await do_block(Who(username=other["username"]), user)
    await tell_admins(queue_was_empty, "a report")
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
            # None: sent before E2E (the server copied it itself); True/False: the sender's signature checked out or not
            "media_verified": None if r["media_verified"] is None else bool(r["media_verified"]),
            "overlay": next((f"{API}/admin/reports/{r['id']}/shots/{i['id']}" for i in items.get(r["id"], []) if i["kind"] == "overlay"), None),
            "texts": [{"body": i["body"], "at": i["at"], "group": None if i["place"] == "direct" else i["place"],
                       "verified": None if i["verified"] is None else bool(i["verified"])}
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
    reason: str = ""  # shown to them; defaults to what they were reported for
    report_id: int | None = None


def suspend_user(conn, admin_name: str, u, days: int | None, reason: str = ""):
    until = now() + days * 86400 if days else None
    reported = [r[0] for r in conn.execute(
        "SELECT DISTINCT reason FROM reports WHERE reported_id = ? AND closed_at IS NULL ORDER BY reason", (u["id"],))]
    why = reason.strip()[:200] or ", ".join(REASON_TEXT.get(r, r) for r in reported)
    # suspended_at names the suspension an appeal belongs to, so it must be new each time
    last = conn.execute("SELECT MAX(suspended_at) FROM appeals WHERE user_id = ?", (u["id"],)).fetchone()[0] or 0
    conn.execute(
        "UPDATE users SET suspended_at = ?, suspended_until = ?, suspend_reason = ? WHERE id = ?",
        (max(now(), last + 1), until, why, u["id"]),
    )
    _close_reports(conn, u["id"], admin_name, "suspended")
    log(conn, admin_name, "suspend", u["username"], (f"{days} days" if days else "until lifted") + (f": {why}" if why else ""))


@router.post("/admin/users/{username}/suspend")
async def suspend(username: str, body: Suspend, admin=Depends(admin_user)):
    with db() as conn:
        u = _target(conn, username, admin)
        suspend_user(conn, admin["username"], u, body.days, body.reason)
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
        lift(conn, u["id"], admin["username"])
        log(conn, admin["username"], "unsuspend", u["username"])
        friends = [r[0] for r in conn.execute("SELECT friend_id FROM friendships WHERE user_id = ?", (u["id"],))]
    for f in friends:
        await hub.push(f, {"type": "friends"})
    return {"ok": True}


def lift(conn, user_id: int, admin_name: str, reply: str = ""):
    """Ends a suspension; an open appeal counts as granted."""
    conn.execute("UPDATE users SET suspended_at = NULL, suspended_until = NULL, suspend_reason = NULL WHERE id = ?", (user_id,))
    conn.execute(
        "UPDATE appeals SET closed_at = ?, closed_by = ?, outcome = 'lifted', reply = ? WHERE user_id = ? AND closed_at IS NULL",
        (now(), admin_name, reply, user_id),
    )


# --- appeals --------------------------------------------------------------------

class AppealIn(BaseModel):
    body: str


def _appeal_of(conn, user):
    return conn.execute(
        "SELECT * FROM appeals WHERE user_id = ? AND suspended_at = ?", (user["id"], user["suspended_at"])
    ).fetchone()


@router.get("/appeal")
def my_suspension(user=Depends(any_named_user)):
    """What a suspended person sees: why, until when, and their appeal if they sent one."""
    if not suspended(user):
        return {"suspended": False}
    with db() as conn:
        a = _appeal_of(conn, user)
    return {
        "suspended": True,
        "until": user["suspended_until"] or 0,
        "reason": user["suspend_reason"] or "",
        "appeal": a and {"body": a["body"], "at": a["created_at"], "outcome": a["outcome"], "reply": a["reply"]},
    }


@router.post("/appeal", dependencies=[Depends(limit("appeal", 5, 3600))])
async def appeal(body: AppealIn, user=Depends(any_named_user)):
    if not suspended(user):
        raise HTTPException(400, "you're not suspended")
    text = body.body.strip()[:1000]
    if not text:
        raise HTTPException(400, "say why they should lift it")
    with db() as conn:
        if _appeal_of(conn, user):
            raise HTTPException(409, "you already appealed this one")
        queue_was_empty = queue_empty(conn)
        conn.execute(
            "INSERT INTO appeals (user_id, suspended_at, body, created_at) VALUES (?, ?, ?, ?)",
            (user["id"], user["suspended_at"], text, now()),
        )
    await tell_admins(queue_was_empty, "an appeal")
    return {"ok": True}


@router.get("/admin/appeals")
def open_appeals(admin=Depends(admin_user)):
    with db() as conn:
        rows = conn.execute(
            """SELECT a.*, u.username, u.suspended_until, u.suspend_reason FROM appeals a JOIN users u ON u.id = a.user_id
               WHERE a.closed_at IS NULL ORDER BY a.created_at"""
        ).fetchall()
    return [
        {"id": r["id"], "username": r["username"], "body": r["body"], "at": r["created_at"],
         "until": r["suspended_until"] or 0, "reason": r["suspend_reason"] or ""}
        for r in rows
    ]


class Decide(BaseModel):
    lift: bool
    reply: str = ""


@router.post("/admin/appeals/{appeal_id}")
async def decide(appeal_id: int, body: Decide, admin=Depends(admin_user)):
    reply = body.reply.strip()[:500]
    with db() as conn:
        a = conn.execute(
            "SELECT a.*, u.username FROM appeals a JOIN users u ON u.id = a.user_id WHERE a.id = ? AND a.closed_at IS NULL",
            (appeal_id,),
        ).fetchone()
        if not a:
            raise HTTPException(404, "already handled")
        if body.lift:
            lift(conn, a["user_id"], admin["username"], reply)
            friends = [r[0] for r in conn.execute("SELECT friend_id FROM friendships WHERE user_id = ?", (a["user_id"],))]
        else:
            conn.execute(
                "UPDATE appeals SET closed_at = ?, closed_by = ?, outcome = 'rejected', reply = ? WHERE id = ?",
                (now(), admin["username"], reply, appeal_id),
            )
            friends = []
        log(conn, admin["username"], "appeal lifted" if body.lift else "appeal rejected", a["username"], reply)
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

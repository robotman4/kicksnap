"""
Chats: the list (friends and groups), short text messages, and groups.

A chat is addressed by a key: "u:<username>" for a friend, "g:<group id>" for a group.
"""
import asyncio
import random
import secrets
import unicodedata

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .auth import current_user, now
from .db import db
from .hub import hub
from .media import burn
from .push import notify

router = APIRouter(prefix="/api")

MAX_CHARS = 160
INVITE_MODES = {"open", "members", "admin"}
GROUP_COLORS = ["#3DC9FF", "#FF5C8A", "#FFD93D", "#7C5CFF", "#3DFFB0", "#FF8A3D"]


def graphemes(text: str) -> int:
    """What a person counts as characters: an emoji (even 👨‍👩‍👧 or 🇸🇪) is one."""
    n, joined, flags = 0, False, 0
    for ch in text:
        cp = ord(ch)
        if joined:  # the part after a zero-width joiner belongs to the previous emoji
            joined = False
            continue
        if cp == 0x200D:
            joined = True
            continue
        if (
            unicodedata.category(ch) in ("Mn", "Me")
            or 0xFE00 <= cp <= 0xFE0F  # variation selectors
            or 0x1F3FB <= cp <= 0x1F3FF  # skin tones
            or 0xE0020 <= cp <= 0xE007F  # tag sequences (subdivision flags)
        ):
            continue
        if 0x1F1E6 <= cp <= 0x1F1FF:  # regional indicators pair up into one flag
            flags += 1
            if flags % 2 == 0:
                continue
        else:
            flags = 0
        n += 1
    return n


def are_friends(conn, a: int, b: int) -> bool:
    return conn.execute(
        "SELECT COUNT(*) FROM friendships WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)",
        (a, b, b, a),
    ).fetchone()[0] == 2


# SQL condition: no block either way between :me and the row's sender
NOT_BLOCKED = """NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.user_id = :me AND b.blocked_id = {col})
                                                  OR (b.user_id = {col} AND b.blocked_id = :me))"""


def blocked(conn, a: int, b: int) -> bool:
    return conn.execute(
        "SELECT 1 FROM blocks WHERE (user_id = ? AND blocked_id = ?) OR (user_id = ? AND blocked_id = ?)", (a, b, b, a)
    ).fetchone() is not None


def member_ids(conn, group_id: int) -> list[int]:
    return [r[0] for r in conn.execute("SELECT user_id FROM group_members WHERE group_id = ? ORDER BY joined_at", (group_id,))]


def read_at(conn, user_id: int, chat: str) -> int:
    row = conn.execute("SELECT read_at FROM reads WHERE user_id = ? AND chat = ?", (user_id, chat)).fetchone()
    return row[0] if row else 0


def resolve(conn, me: int, key: str):
    """key -> ("u", friend row) or ("g", group row); 404 unless it's a friend or a group you're in."""
    kind, _, ident = key.partition(":")
    if kind == "u":
        other = conn.execute("SELECT id, username, color FROM users WHERE username = ?", (ident.lower(),)).fetchone()
        if not other or not are_friends(conn, me, other["id"]):
            raise HTTPException(404, "not your friend")
        return "u", other
    if kind == "g" and ident.isdigit():
        g = conn.execute(
            "SELECT g.* FROM groups g JOIN group_members m ON m.group_id = g.id WHERE g.id = ? AND m.user_id = ?",
            (int(ident), me),
        ).fetchone()
        if not g:
            raise HTTPException(404, "not in that group")
        return "g", g
    raise HTTPException(404, "no such chat")


# --- chat list --------------------------------------------------------------

SNAP_COLS = "s.id, s.kind, s.seconds, s.has_overlay, s.created_at, u.username AS sender"


def _row(state, at, kind, snaps, unread):
    return {"state": state, "at": at, "kind": kind, "snaps": [dict(s) for s in snaps], "unread": unread}


def _friend_row(conn, me: int, f) -> dict:
    new = conn.execute(
        f"""SELECT {SNAP_COLS} FROM snaps s JOIN deliveries d ON d.snap_id = s.id JOIN users u ON u.id = s.sender_id
           WHERE s.sender_id = ? AND d.recipient_id = ? AND d.opened_at IS NULL AND s.group_id IS NULL
           ORDER BY s.created_at""",
        (f["id"], me),
    ).fetchall()
    mine_read = read_at(conn, me, f"u:{f['id']}")
    theirs_read = read_at(conn, f["id"], f"u:{me}")
    unread = conn.execute(
        "SELECT COUNT(*), MAX(created_at) FROM messages WHERE sender_id = ? AND to_user = ? AND created_at > ?",
        (f["id"], me, mine_read),
    ).fetchone()
    if new:
        return _row("new", new[-1]["created_at"], "snap", new, unread[0])
    if unread[0]:
        return _row("new", unread[1], "chat", [], unread[0])

    snap = conn.execute(
        """SELECT s.sender_id, s.created_at, d.opened_at FROM snaps s JOIN deliveries d ON d.snap_id = s.id
           WHERE s.group_id IS NULL AND ((s.sender_id = :me AND d.recipient_id = :f) OR (s.sender_id = :f AND d.recipient_id = :me))
           ORDER BY s.created_at DESC LIMIT 1""",
        {"me": me, "f": f["id"]},
    ).fetchone()
    msg = conn.execute(
        """SELECT sender_id, created_at FROM messages
           WHERE (sender_id = :me AND to_user = :f) OR (sender_id = :f AND to_user = :me)
           ORDER BY id DESC LIMIT 1""",
        {"me": me, "f": f["id"]},
    ).fetchone()
    if msg and (not snap or msg["created_at"] >= snap["created_at"]):
        if msg["sender_id"] == me:
            seen = theirs_read >= msg["created_at"]
            return _row("opened" if seen else "delivered", msg["created_at"], "chat", [], 0)
        return _row("received", msg["created_at"], "chat", [], 0)
    if snap is None:
        return _row("none", 0, "snap", [], 0)
    if snap["sender_id"] == me:
        return _row("opened" if snap["opened_at"] else "delivered", snap["opened_at"] or snap["created_at"], "snap", [], 0)
    return _row("received", snap["opened_at"] or snap["created_at"], "snap", [], 0)


def _group_row(conn, me: int, g) -> dict:
    new = conn.execute(
        f"""SELECT {SNAP_COLS} FROM snaps s JOIN deliveries d ON d.snap_id = s.id JOIN users u ON u.id = s.sender_id
           WHERE s.group_id = :g AND d.recipient_id = :me AND d.opened_at IS NULL ORDER BY s.created_at""",
        {"g": g["id"], "me": me},
    ).fetchall()
    unread = conn.execute(
        f"""SELECT COUNT(*), MAX(created_at) FROM messages m
           WHERE group_id = :g AND sender_id != :me AND created_at > :since AND {NOT_BLOCKED.format(col="m.sender_id")}""",
        {"g": g["id"], "me": me, "since": read_at(conn, me, f"g:{g['id']}")},
    ).fetchone()
    if new:
        return _row("new", new[-1]["created_at"], "snap", new, unread[0])
    if unread[0]:
        return _row("new", unread[1], "chat", [], unread[0])
    last = conn.execute(
        """SELECT sender_id, created_at, 'chat' AS kind FROM messages WHERE group_id = :g
           UNION ALL SELECT sender_id, created_at, 'snap' FROM snaps WHERE group_id = :g
           ORDER BY created_at DESC LIMIT 1""",
        {"g": g["id"]},
    ).fetchone()
    if not last:
        return _row("none", g["created_at"], "snap", [], 0)
    return _row("delivered" if last["sender_id"] == me else "received", last["created_at"], last["kind"], [], 0)


@router.get("/chats")
def chats(user=Depends(current_user)):
    """Friends and groups, Snapchat-style: new / received / delivered / opened, for snaps or chat."""
    me = user["id"]
    out = []
    with db() as conn:
        friends = conn.execute(
            """SELECT u.id, u.username, u.color FROM friendships a
               JOIN friendships b ON b.user_id = a.friend_id AND b.friend_id = a.user_id
               JOIN users u ON u.id = a.friend_id WHERE a.user_id = ?""",
            (me,),
        ).fetchall()
        for f in friends:
            out.append({"key": f"u:{f['username']}", "name": f["username"], "color": f["color"], "group": False, **_friend_row(conn, me, f)})
        groups = conn.execute(
            "SELECT g.* FROM groups g JOIN group_members m ON m.group_id = g.id WHERE m.user_id = ?", (me,)
        ).fetchall()
        for g in groups:
            out.append({"key": f"g:{g['id']}", "name": g["name"], "color": g["color"], "group": True, **_group_row(conn, me, g)})
    out.sort(key=lambda c: (c["state"] != "new", -c["at"], c["name"]))
    return out


# --- messages ---------------------------------------------------------------

@router.get("/chats/{key}/messages")
def messages(key: str, user=Depends(current_user)):
    me = user["id"]
    with db() as conn:
        kind, target = resolve(conn, me, key)
        if kind == "u":
            rows = conn.execute(
                """SELECT m.id, m.body, m.created_at, u.username, u.color FROM messages m JOIN users u ON u.id = m.sender_id
                   WHERE (m.sender_id = :me AND m.to_user = :f) OR (m.sender_id = :f AND m.to_user = :me)
                   ORDER BY m.id DESC LIMIT 100""",
                {"me": me, "f": target["id"]},
            ).fetchall()
            seen = read_at(conn, target["id"], f"u:{me}")
        else:
            rows = conn.execute(
                f"""SELECT m.id, m.body, m.created_at, u.username, u.color FROM messages m JOIN users u ON u.id = m.sender_id
                   WHERE m.group_id = :g AND {NOT_BLOCKED.format(col="m.sender_id")} ORDER BY m.id DESC LIMIT 100""",
                {"g": target["id"], "me": me},
            ).fetchall()
            seen = 0
    return {
        "messages": [
            {"id": r["id"], "body": r["body"], "at": r["created_at"], "from": r["username"], "color": r["color"], "mine": r["username"] == user["username"]}
            for r in reversed(rows)
        ],
        "seen_at": seen,  # 1:1 only: when they last read this chat
    }


@router.post("/chats/{key}/read")
async def mark_read(key: str, user=Depends(current_user)):
    me = user["id"]
    with db() as conn:
        kind, target = resolve(conn, me, key)
        chat = f"{kind}:{target['id']}"
        conn.execute(
            "INSERT INTO reads (user_id, chat, read_at) VALUES (?, ?, ?) ON CONFLICT (user_id, chat) DO UPDATE SET read_at = excluded.read_at",
            (me, chat, now()),
        )
    if kind == "u":
        await hub.push(target["id"], {"type": "read", "chat": f"u:{user['username']}"})
    return {"ok": True}


class NewMessage(BaseModel):
    body: str


@router.post("/chats/{key}/messages")
async def send_message(key: str, msg: NewMessage, user=Depends(current_user)):
    body = msg.body.strip()
    if not body:
        raise HTTPException(400, "say something")
    if graphemes(body) > MAX_CHARS or len(body) > MAX_CHARS * 12:
        raise HTTPException(400, f"keep it under {MAX_CHARS}")
    me = user["id"]
    with db() as conn:
        kind, target = resolve(conn, me, key)
        if kind == "u":
            conn.execute("INSERT INTO messages (sender_id, to_user, body, created_at) VALUES (?, ?, ?, ?)", (me, target["id"], body, now()))
            recipients = [(target["id"], f"u:{user['username']}")]
            title = "kicksnap"
        else:
            conn.execute("INSERT INTO messages (sender_id, group_id, body, created_at) VALUES (?, ?, ?, ?)", (me, target["id"], body, now()))
            recipients = [(m, key) for m in member_ids(conn, target["id"]) if m != me and not blocked(conn, me, m)]
            title = target["name"]
        # sending is reading: your own chat shouldn't show as unread
        chat = f"{kind}:{target['id']}"
        conn.execute(
            "INSERT INTO reads (user_id, chat, read_at) VALUES (?, ?, ?) ON CONFLICT (user_id, chat) DO UPDATE SET read_at = excluded.read_at",
            (me, chat, now()),
        )
    for uid, their_key in recipients:
        await hub.push(uid, {"type": "message", "chat": their_key})
        asyncio.create_task(notify(uid, {"title": title, "body": f"new chat from @{user['username']} 💬", "tag": their_key}))
    return {"ok": True}


# --- groups -----------------------------------------------------------------

class NewGroup(BaseModel):
    name: str
    members: list[str] = []


class GroupPatch(BaseModel):
    name: str | None = None
    invite_mode: str | None = None
    admin: str | None = None  # hand the admin role to this member


class Invite(BaseModel):
    usernames: list[str]


class Join(BaseModel):
    code: str


def _clean_name(name: str) -> str:
    name = " ".join(name.split())
    if not name or graphemes(name) > 30:
        raise HTTPException(400, "group names are 1 to 30 characters")
    return name


def _group(conn, me: int, group_id: int):
    g = conn.execute("SELECT * FROM groups WHERE id = ?", (group_id,)).fetchone()
    if not g or me not in member_ids(conn, group_id):
        raise HTTPException(404, "not in that group")
    return g


def _can_invite(g, me: int) -> bool:
    return g["admin_id"] == me or g["invite_mode"] in ("open", "members")


def _friends_by_name(conn, me: int, names: list[str]):
    rows = []
    for n in {n.strip().lower().lstrip("@") for n in names if n.strip()}:
        u = conn.execute("SELECT id, username FROM users WHERE username = ?", (n,)).fetchone()
        if not u or not are_friends(conn, me, u["id"]):
            raise HTTPException(400, f"@{n} isn't your friend")
        rows.append(u)
    return rows


async def _tell(conn_members: list[int], event: dict):
    for uid in conn_members:
        await hub.push(uid, event)


def _details(conn, g, me: int) -> dict:
    members = conn.execute(
        """SELECT u.username, u.color, m.user_id FROM group_members m JOIN users u ON u.id = m.user_id
           WHERE m.group_id = ? ORDER BY m.joined_at""",
        (g["id"],),
    ).fetchall()
    return {
        "id": g["id"],
        "key": f"g:{g['id']}",
        "name": g["name"],
        "color": g["color"],
        "invite_mode": g["invite_mode"],
        "admin": g["admin_id"] == me,
        "can_invite": _can_invite(g, me),
        # the join code only works in open mode, so only show it then
        "code": g["code"] if g["invite_mode"] == "open" else None,
        "members": [{"username": m["username"], "color": m["color"], "admin": m["user_id"] == g["admin_id"]} for m in members],
    }


@router.post("/groups")
async def create_group(body: NewGroup, user=Depends(current_user)):
    me = user["id"]
    name = _clean_name(body.name)
    with db() as conn:
        invitees = _friends_by_name(conn, me, body.members)
        cur = conn.execute(
            "INSERT INTO groups (name, color, admin_id, invite_mode, code, created_at) VALUES (?, ?, ?, 'members', ?, ?)",
            (name, random.choice(GROUP_COLORS), me, secrets.token_urlsafe(9), now()),
        )
        gid = cur.lastrowid
        conn.executemany(
            "INSERT INTO group_members VALUES (?, ?, ?)", [(gid, me, now())] + [(gid, u["id"], now()) for u in invitees]
        )
        g = conn.execute("SELECT * FROM groups WHERE id = ?", (gid,)).fetchone()
        result = _details(conn, g, me)
    for u in invitees:
        await hub.push(u["id"], {"type": "group"})
        asyncio.create_task(notify(u["id"], {"title": name, "body": f"@{user['username']} added you to {name}", "tag": f"g:{gid}"}))
    return result


@router.get("/groups/{group_id}")
def group(group_id: int, user=Depends(current_user)):
    with db() as conn:
        return _details(conn, _group(conn, user["id"], group_id), user["id"])


@router.patch("/groups/{group_id}")
async def update_group(group_id: int, body: GroupPatch, user=Depends(current_user)):
    me = user["id"]
    with db() as conn:
        g = _group(conn, me, group_id)
        if g["admin_id"] != me:
            raise HTTPException(403, "only the admin can change that")
        if body.name is not None:
            conn.execute("UPDATE groups SET name = ? WHERE id = ?", (_clean_name(body.name), group_id))
        if body.invite_mode is not None:
            if body.invite_mode not in INVITE_MODES:
                raise HTTPException(400, "bad invite mode")
            conn.execute("UPDATE groups SET invite_mode = ? WHERE id = ?", (body.invite_mode, group_id))
        if body.admin is not None:
            new = conn.execute("SELECT id FROM users WHERE username = ?", (body.admin.lower(),)).fetchone()
            if not new or new["id"] not in member_ids(conn, group_id):
                raise HTTPException(400, "they're not in the group")
            conn.execute("UPDATE groups SET admin_id = ? WHERE id = ?", (new["id"], group_id))
        g = conn.execute("SELECT * FROM groups WHERE id = ?", (group_id,)).fetchone()
        result = _details(conn, g, me)
        members = member_ids(conn, group_id)
    await _tell(members, {"type": "group"})
    return result


@router.post("/groups/{group_id}/members")
async def invite(group_id: int, body: Invite, user=Depends(current_user)):
    me = user["id"]
    with db() as conn:
        g = _group(conn, me, group_id)
        if not _can_invite(g, me):
            raise HTTPException(403, "only the admin can add people here")
        invitees = [u for u in _friends_by_name(conn, me, body.usernames) if u["id"] not in member_ids(conn, group_id)]
        conn.executemany("INSERT OR IGNORE INTO group_members VALUES (?, ?, ?)", [(group_id, u["id"], now()) for u in invitees])
        result = _details(conn, g, me)
        members = member_ids(conn, group_id)
    await _tell(members, {"type": "group"})
    for u in invitees:
        asyncio.create_task(notify(u["id"], {"title": g["name"], "body": f"@{user['username']} added you to {g['name']}", "tag": f"g:{group_id}"}))
    return result


@router.post("/groups/join")
async def join(body: Join, user=Depends(current_user)):
    code = body.code.strip().removeprefix("kicksnap-group:")
    with db() as conn:
        g = conn.execute("SELECT * FROM groups WHERE code = ?", (code,)).fetchone()
        if not g or g["invite_mode"] != "open":
            raise HTTPException(404, "that group isn't open to join")
        conn.execute("INSERT OR IGNORE INTO group_members VALUES (?, ?, ?)", (g["id"], user["id"], now()))
        result = _details(conn, g, user["id"])
        members = member_ids(conn, g["id"])
    await _tell(members, {"type": "group"})
    return result


@router.delete("/groups/{group_id}/members/{username}")
async def remove_member(group_id: int, username: str, user=Depends(current_user)):
    """Leave (your own name) or, as admin, remove someone. The admin leaving hands over to the longest member."""
    me = user["id"]
    with db() as conn:
        g = _group(conn, me, group_id)
        target = conn.execute("SELECT id FROM users WHERE username = ?", (username.lower(),)).fetchone()
        if not target or target["id"] not in member_ids(conn, group_id):
            raise HTTPException(404, "not in the group")
        if target["id"] != me and g["admin_id"] != me:
            raise HTTPException(403, "only the admin can remove people")
        before = member_ids(conn, group_id)
        conn.execute("DELETE FROM group_members WHERE group_id = ? AND user_id = ?", (group_id, target["id"]))
        left = member_ids(conn, group_id)
        if not left:
            conn.execute("DELETE FROM groups WHERE id = ?", (group_id,))
        elif target["id"] == g["admin_id"]:
            conn.execute("UPDATE groups SET admin_id = ? WHERE id = ?", (left[0], group_id))
    await _tell(before, {"type": "group"})
    return {"ok": True}


@router.delete("/groups/{group_id}")
async def close_group(group_id: int, user=Depends(current_user)):
    """Admin only: ends the group for everyone, with its chat and snaps."""
    me = user["id"]
    with db() as conn:
        g = _group(conn, me, group_id)
        if g["admin_id"] != me:
            raise HTTPException(403, "only the admin can close the group")
        members = member_ids(conn, group_id)
        snap_ids = [r[0] for r in conn.execute("SELECT id FROM snaps WHERE group_id = ?", (group_id,))]
        conn.execute("DELETE FROM groups WHERE id = ?", (group_id,))
    for s in snap_ids:
        burn(s)
    await _tell(members, {"type": "group", "closed": f"g:{group_id}"})
    return {"ok": True}

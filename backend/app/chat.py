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

from .api import API
from .auth import current_user, now, suspended
from .limits import limit
from .db import db
from .hub import hub
from .media import burn
from .push import notify

router = APIRouter(prefix=API)

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
        other = conn.execute("SELECT id, username, color, suspended_at, suspended_until FROM users WHERE username = ?", (ident.lower(),)).fetchone()
        if not other or not are_friends(conn, me, other["id"]):
            raise HTTPException(404, "not your friend")
        if suspended(other):
            raise HTTPException(404, "they're unavailable right now")
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

SNAP_COLS = "s.id, s.kind, s.seconds, s.has_overlay, s.created_at, s.e2e, u.username AS sender"


def _row(state, at, kind, snaps, unread):
    return {"state": state, "at": at, "kind": kind, "snaps": [dict(s) for s in snaps], "unread": unread}


def _friend_state(me, snaps, unread, last_snap, last_msg, their_read) -> dict:
    if snaps:
        return _row("new", snaps[-1]["created_at"], "snap", snaps, unread[0])
    if unread[0]:
        return _row("new", unread[1], "chat", [], unread[0])
    if last_msg and (not last_snap or last_msg["created_at"] >= last_snap["created_at"]):
        if last_msg["sender_id"] == me:
            seen = their_read >= last_msg["created_at"]
            return _row("opened" if seen else "delivered", last_msg["created_at"], "chat", [], 0)
        return _row("received", last_msg["created_at"], "chat", [], 0)
    if last_snap is None:
        return _row("none", 0, "snap", [], 0)
    if last_snap["sender_id"] == me:
        return _row("opened" if last_snap["opened_at"] else "delivered", last_snap["opened_at"] or last_snap["created_at"], "snap", [], 0)
    return _row("received", last_snap["opened_at"] or last_snap["created_at"], "snap", [], 0)


def _group_state(me, g, snaps, unread, last) -> dict:
    if snaps:
        return _row("new", snaps[-1]["created_at"], "snap", snaps, unread[0])
    if unread[0]:
        return _row("new", unread[1], "chat", [], unread[0])
    if not last:
        return _row("none", g["created_at"], "snap", [], 0)
    return _row("delivered" if last["sender_id"] == me else "received", last["created_at"], last["kind"], [], 0)


def _by(rows, key) -> dict:
    out: dict = {}
    for r in rows:
        out.setdefault(r[key], []).append(r)
    return out


@router.get("/chats")
def chats(user=Depends(current_user)):
    """
    Friends and groups, Snapchat-style: new / received / delivered / opened, for snaps or chat.
    A fixed handful of queries however many friends you have (this runs on every refresh).
    """
    me = user["id"]
    p = {"me": me}
    with db() as conn:
        friends = conn.execute(
            """SELECT u.id, u.username, u.color, u.suspended_at, u.suspended_until FROM friendships a
               JOIN friendships b ON b.user_id = a.friend_id AND b.friend_id = a.user_id
               JOIN users u ON u.id = a.friend_id WHERE a.user_id = :me""",
            p,
        ).fetchall()
        new_direct = _by(conn.execute(
            f"""SELECT {SNAP_COLS}, s.sender_id FROM snaps s JOIN deliveries d ON d.snap_id = s.id JOIN users u ON u.id = s.sender_id
               WHERE d.recipient_id = :me AND d.opened_at IS NULL AND s.group_id IS NULL ORDER BY s.created_at""",
            p,
        ).fetchall(), "sender_id")
        unread_direct = {r["sender_id"]: (r["n"], r["at"]) for r in conn.execute(
            """SELECT m.sender_id, COUNT(*) AS n, MAX(m.created_at) AS at FROM messages m
               LEFT JOIN reads r ON r.user_id = :me AND r.chat = 'u:' || m.sender_id
               WHERE m.to_user = :me AND m.created_at > COALESCE(r.read_at, 0) GROUP BY m.sender_id""",
            p,
        )}
        # how far each friend has read their chat with me
        their_reads = {r["user_id"]: r["read_at"] for r in conn.execute("SELECT user_id, read_at FROM reads WHERE chat = 'u:' || :me", p)}
        last_snap = {r["peer"]: r for r in conn.execute(
            """SELECT peer, sender_id, created_at, opened_at FROM (
                 SELECT CASE WHEN s.sender_id = :me THEN d.recipient_id ELSE s.sender_id END AS peer,
                        s.sender_id, s.created_at, d.opened_at,
                        ROW_NUMBER() OVER (PARTITION BY CASE WHEN s.sender_id = :me THEN d.recipient_id ELSE s.sender_id END
                                           ORDER BY s.created_at DESC) AS rn
                 FROM snaps s JOIN deliveries d ON d.snap_id = s.id
                 WHERE s.group_id IS NULL AND (s.sender_id = :me OR d.recipient_id = :me))
               WHERE rn = 1""",
            p,
        )}
        last_msg = {r["peer"]: r for r in conn.execute(
            """SELECT peer, sender_id, created_at FROM (
                 SELECT CASE WHEN sender_id = :me THEN to_user ELSE sender_id END AS peer, sender_id, created_at,
                        ROW_NUMBER() OVER (PARTITION BY CASE WHEN sender_id = :me THEN to_user ELSE sender_id END
                                           ORDER BY id DESC) AS rn
                 FROM messages WHERE sender_id = :me OR to_user = :me)
               WHERE rn = 1""",
            p,
        )}

        groups = conn.execute(
            "SELECT g.* FROM groups g JOIN group_members m ON m.group_id = g.id WHERE m.user_id = :me", p
        ).fetchall()
        new_group = _by(conn.execute(
            f"""SELECT {SNAP_COLS}, s.group_id FROM snaps s JOIN deliveries d ON d.snap_id = s.id JOIN users u ON u.id = s.sender_id
               WHERE d.recipient_id = :me AND d.opened_at IS NULL AND s.group_id IS NOT NULL ORDER BY s.created_at""",
            p,
        ).fetchall(), "group_id")
        unread_group = {r["group_id"]: (r["n"], r["at"]) for r in conn.execute(
            f"""SELECT m.group_id, COUNT(*) AS n, MAX(m.created_at) AS at FROM messages m
               JOIN group_members gm ON gm.group_id = m.group_id AND gm.user_id = :me
               LEFT JOIN reads r ON r.user_id = :me AND r.chat = 'g:' || m.group_id
               WHERE m.sender_id != :me AND m.created_at > COALESCE(r.read_at, 0) AND {NOT_BLOCKED.format(col="m.sender_id")}
               GROUP BY m.group_id""",
            p,
        )}
        last_group = {r["group_id"]: r for r in conn.execute(
            """SELECT group_id, sender_id, created_at, kind FROM (
                 SELECT group_id, sender_id, created_at, kind,
                        ROW_NUMBER() OVER (PARTITION BY group_id ORDER BY created_at DESC) AS rn FROM (
                   SELECT group_id, sender_id, created_at, 'chat' AS kind FROM messages
                   WHERE group_id IN (SELECT group_id FROM group_members WHERE user_id = :me)
                   UNION ALL
                   SELECT group_id, sender_id, created_at, 'snap' FROM snaps
                   WHERE group_id IN (SELECT group_id FROM group_members WHERE user_id = :me)))
               WHERE rn = 1""",
            p,
        )}

    out = []
    for f in friends:
        snaps = [{k: r[k] for k in r.keys() if k != "sender_id"} for r in new_direct.get(f["id"], [])]
        state = _friend_state(me, snaps, unread_direct.get(f["id"], (0, None)), last_snap.get(f["id"]), last_msg.get(f["id"]), their_reads.get(f["id"], 0))
        out.append({"key": f"u:{f['username']}", "name": f["username"], "color": f["color"], "group": False, "away": suspended(f), **state})
    for g in groups:
        snaps = [{k: r[k] for k in r.keys() if k != "group_id"} for r in new_group.get(g["id"], [])]
        state = _group_state(me, g, snaps, unread_group.get(g["id"], (0, None)), last_group.get(g["id"]))
        out.append({"key": f"g:{g['id']}", "name": g["name"], "color": g["color"], "group": True, "away": False, **state})
    out.sort(key=lambda c: (c["state"] != "new", -c["at"], c["name"]))
    return out


# --- messages ---------------------------------------------------------------

MSG_COLS = "m.id, m.body, m.created_at, m.e2e, k.key, u.username, u.color"


@router.get("/chats/{key}/messages")
def messages(key: str, user=Depends(current_user)):
    me = user["id"]
    with db() as conn:
        kind, target = resolve(conn, me, key)
        if kind == "u":
            rows = conn.execute(
                f"""SELECT {MSG_COLS} FROM messages m JOIN users u ON u.id = m.sender_id
                   LEFT JOIN message_keys k ON k.message_id = m.id AND k.device_id = :dev
                   WHERE (m.sender_id = :me AND m.to_user = :f) OR (m.sender_id = :f AND m.to_user = :me)
                   ORDER BY m.id DESC LIMIT 100""",
                {"me": me, "f": target["id"], "dev": user["device_id"]},
            ).fetchall()
            seen = read_at(conn, target["id"], f"u:{me}")
        else:
            rows = conn.execute(
                f"""SELECT {MSG_COLS} FROM messages m JOIN users u ON u.id = m.sender_id
                   LEFT JOIN message_keys k ON k.message_id = m.id AND k.device_id = :dev
                   WHERE m.group_id = :g AND {NOT_BLOCKED.format(col="m.sender_id")} ORDER BY m.id DESC LIMIT 100""",
                {"g": target["id"], "me": me, "dev": user["device_id"]},
            ).fetchall()
            seen = 0
    return {
        "messages": [
            {"id": r["id"], "body": r["body"], "at": r["created_at"], "from": r["username"], "color": r["color"],
             "mine": r["username"] == user["username"], "e2e": bool(r["e2e"]), "key": r["key"]}
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
    body: str  # the encrypted envelope (docs/e2e.md)
    keys: dict[str, str] | None = None  # device id -> wrapped content key


@router.post("/chats/{key}/messages", dependencies=[Depends(limit("text", 60, 60))])
async def send_message(key: str, msg: NewMessage, user=Depends(current_user)):
    """The 160-character limit is the client's job now: the server only sees ciphertext."""
    body = msg.body.strip()
    if msg.keys is None:
        raise HTTPException(426, "update kicksnap to send chats (refresh the app)")
    if not body:
        raise HTTPException(400, "say something")
    if len(body) > 4096:
        raise HTTPException(400, f"keep it under {MAX_CHARS}")
    me = user["id"]
    with db() as conn:
        kind, target = resolve(conn, me, key)
        if kind == "u":
            mid = conn.execute(
                "INSERT INTO messages (sender_id, to_user, body, created_at, e2e) VALUES (?, ?, ?, ?, 1)", (me, target["id"], body, now())
            ).lastrowid
            recipients = [(target["id"], f"u:{user['username']}")]
            title = "Kiks"
        else:
            mid = conn.execute(
                "INSERT INTO messages (sender_id, group_id, body, created_at, e2e) VALUES (?, ?, ?, ?, 1)", (me, target["id"], body, now())
            ).lastrowid
            recipients = [(m, key) for m in member_ids(conn, target["id"]) if m != me and not blocked(conn, me, m)]
            title = target["name"]
        from .keys import wraps_for

        conn.executemany(
            "INSERT OR REPLACE INTO message_keys (message_id, device_id, key) VALUES (?, ?, ?)",
            [(mid, d, w) for d, w in wraps_for(conn, msg.keys, {me} | {uid for uid, _ in recipients})],
        )
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
        """SELECT u.username, u.color, u.identity_key, m.user_id FROM group_members m JOIN users u ON u.id = m.user_id
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
        "members": [
            {"username": m["username"], "color": m["color"], "admin": m["user_id"] == g["admin_id"], "key": m["identity_key"]}
            for m in members
        ],
    }


@router.post("/groups", dependencies=[Depends(limit("group", 10, 60))])
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


@router.post("/groups/{group_id}/members", dependencies=[Depends(limit("invite", 30, 60))])
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


@router.post("/groups/join", dependencies=[Depends(limit("join", 10, 60))])
async def join(body: Join, user=Depends(current_user)):
    code = body.code.strip().removeprefix("kiks-group:").removeprefix("kicksnap-group:")
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
    """Leave (your own name) or, as admin, remove someone. The admin can't leave; they hand over or close."""
    me = user["id"]
    with db() as conn:
        g = _group(conn, me, group_id)
        target = conn.execute("SELECT id FROM users WHERE username = ?", (username.lower(),)).fetchone()
        if not target or target["id"] not in member_ids(conn, group_id):
            raise HTTPException(404, "not in the group")
        if target["id"] != me and g["admin_id"] != me:
            raise HTTPException(403, "only the admin can remove people")
        if target["id"] == me == g["admin_id"]:
            raise HTTPException(400, "make someone else admin before you leave")
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

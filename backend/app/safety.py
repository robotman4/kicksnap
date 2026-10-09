"""Blocking people and deleting your account."""
from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel

from .auth import COOKIE, current_user, now
from .limits import limit
from .db import db
from .hub import hub
from .media import burn

router = APIRouter(prefix="/api")


class Who(BaseModel):
    username: str


@router.get("/blocks")
def blocks(user=Depends(current_user)):
    with db() as conn:
        rows = conn.execute(
            """SELECT u.username, u.color FROM blocks b JOIN users u ON u.id = b.blocked_id
               WHERE b.user_id = ? ORDER BY b.created_at DESC""",
            (user["id"],),
        ).fetchall()
    return [dict(r) for r in rows]


@router.post("/blocks", dependencies=[Depends(limit("block", 30, 60))])
async def block(body: Who, user=Depends(current_user)):
    """Unfriends both ways, drops pending requests, and keeps them from finding you again."""
    me = user["id"]
    with db() as conn:
        other = conn.execute("SELECT id FROM users WHERE username = ?", (body.username.strip().lower().lstrip("@"),)).fetchone()
        if not other or other["id"] == me:
            raise HTTPException(404, "no one by that name")
        conn.execute(
            "DELETE FROM friendships WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)",
            (me, other["id"], other["id"], me),
        )
        conn.execute("INSERT OR IGNORE INTO blocks VALUES (?, ?, ?)", (me, other["id"], now()))
    # they just see you gone from their list, same as being unfriended
    await hub.push(other["id"], {"type": "friends"})
    return {"ok": True}


@router.delete("/blocks/{username}")
def unblock(username: str, user=Depends(current_user)):
    with db() as conn:
        conn.execute(
            "DELETE FROM blocks WHERE user_id = ? AND blocked_id = (SELECT id FROM users WHERE username = ?)",
            (user["id"], username.lower()),
        )
    return {"ok": True}


class Confirm(BaseModel):
    username: str  # typed back as a confirmation


@router.delete("/me")
async def delete_account(body: Confirm, response: Response, user=Depends(current_user)):
    """
    Removes the account and everything tied to it on the server, and frees the
    username. Groups you run go to their longest member, or close if you were alone.
    """
    me = user["id"]
    if body.username.strip().lower().lstrip("@") != user["username"]:
        raise HTTPException(400, "type your name to confirm")
    with db() as conn:
        friends = [r[0] for r in conn.execute(
            "SELECT friend_id FROM friendships WHERE user_id = ? UNION SELECT user_id FROM friendships WHERE friend_id = ?", (me, me)
        )]
        group_peers: set[int] = set()
        for g in conn.execute("SELECT group_id FROM group_members WHERE user_id = ?", (me,)).fetchall():
            gid = g[0]
            others = [r[0] for r in conn.execute(
                "SELECT user_id FROM group_members WHERE group_id = ? AND user_id != ? ORDER BY joined_at", (gid, me)
            )]
            group_peers.update(others)
            if not others:
                for s in conn.execute("SELECT id FROM snaps WHERE group_id = ?", (gid,)).fetchall():
                    burn(s[0])
                conn.execute("DELETE FROM groups WHERE id = ?", (gid,))
            else:
                conn.execute("UPDATE groups SET admin_id = ? WHERE id = ? AND admin_id = ?", (others[0], gid, me))
        waiting = [r[0] for r in conn.execute("SELECT snap_id FROM deliveries WHERE recipient_id = ? AND opened_at IS NULL", (me,))]
        # snaps you sent: their files go with them
        for s in conn.execute("SELECT id FROM snaps WHERE sender_id = ?", (me,)).fetchall():
            burn(s[0])
        # everything else (devices, passkeys, push, friendships, texts, reads, blocks,
        # memberships, deliveries) cascades from the user row
        conn.execute("DELETE FROM users WHERE id = ?", (me,))
        conn.execute("DELETE FROM reads WHERE chat = ?", (f"u:{me}",))
        # snaps that were waiting on you: burn the file if nobody else still is
        for sid in waiting:
            left = conn.execute("SELECT COUNT(*), SUM(opened_at IS NULL) FROM deliveries WHERE snap_id = ?", (sid,)).fetchone()
            if not left[1]:
                burn(sid)
            if not left[0]:
                conn.execute("DELETE FROM snaps WHERE id = ?", (sid,))
    for uid in set(friends):
        await hub.push(uid, {"type": "friends"})
    for uid in group_peers:
        await hub.push(uid, {"type": "group"})
    for ws in list(hub.sockets.pop(me, ())):
        try:
            await ws.close(code=4401)
        except Exception:
            pass
    response.delete_cookie(COOKIE)
    return {"ok": True}

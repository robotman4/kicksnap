"""
Server-shell admin tool. Shell access is what proves you run the server.

    python -m app.admin grant <name>          make someone admin
    python -m app.admin revoke <name>
    python -m app.admin list                  admins
    python -m app.admin reports               open reports
    python -m app.admin suspend <name> [--days N] [--reason TEXT]
    python -m app.admin unsuspend <name>
    python -m app.admin appeals               open appeals
    python -m app.admin delete <name> [--free-name]
    python -m app.admin reserve <name> [reason]
    python -m app.admin release <name>
    python -m app.admin backup [dir] [--keep N]   database + vapid.pem, safe while running
    python -m app.admin version

In Docker: docker compose exec kicksnap python -m app.admin grant kim
"""
import argparse
import shutil
import sys
import time
from pathlib import Path

from . import __version__, db as store
from .auth import suspended
from .db import DATA_DIR, db
from .moderation import delete_user, lift, log, suspend_user

ACTOR = "shell"


def _user(conn, name: str):
    u = conn.execute("SELECT * FROM users WHERE username = ?", (name.lower().lstrip("@"),)).fetchone()
    if not u:
        sys.exit(f"no one called {name}")
    return u


def main(argv=None):
    p = argparse.ArgumentParser(prog="python -m app.admin", description="kicksnap admin")
    sub = p.add_subparsers(dest="cmd", required=True)
    for c in ("grant", "revoke", "unsuspend", "release"):
        sub.add_parser(c).add_argument("name")
    sub.add_parser("list")
    sub.add_parser("reports")
    sub.add_parser("appeals")
    s = sub.add_parser("suspend")
    s.add_argument("name")
    s.add_argument("--days", type=int, default=None, help="leave out to suspend until lifted")
    s.add_argument("--reason", default="", help="shown to them; defaults to what they were reported for")
    d = sub.add_parser("delete")
    d.add_argument("name")
    d.add_argument("--free-name", action="store_true", help="don't reserve the name afterwards")
    r = sub.add_parser("reserve")
    r.add_argument("name")
    r.add_argument("reason", nargs="?", default="")
    b = sub.add_parser("backup")
    b.add_argument("dir", nargs="?", default=str(DATA_DIR / "backups"))
    b.add_argument("--keep", type=int, default=0, help="delete all but the newest N backups")
    sub.add_parser("version")
    a = p.parse_args(argv)

    store.init()
    if a.cmd == "version":
        with db() as conn:
            print(f"kicksnap {__version__}, schema {store.schema_version(conn)}")
        return
    if a.cmd == "backup":
        backup(Path(a.dir), a.keep)
        return
    now = int(time.time())
    with db() as conn:
        if a.cmd in ("grant", "revoke"):
            u = _user(conn, a.name)
            conn.execute("UPDATE users SET is_admin = ? WHERE id = ?", (int(a.cmd == "grant"), u["id"]))
            log(conn, ACTOR, a.cmd, u["username"])
            print(f"@{u['username']} is {'now' if a.cmd == 'grant' else 'no longer'} an admin")
        elif a.cmd == "list":
            for r in conn.execute("SELECT username FROM users WHERE is_admin = 1 ORDER BY username"):
                print(f"@{r[0]}")
        elif a.cmd == "reports":
            rows = conn.execute("SELECT * FROM reports WHERE closed_at IS NULL ORDER BY created_at").fetchall()
            for r in rows:
                media = " [snap attached]" if r["media"] else ""
                print(f"#{r['id']}  @{r['reported_name']}  by @{r['reporter_name']}  {r['reason']}{media}  {r['note']}")
            print(f"{len(rows)} open")
        elif a.cmd == "appeals":
            rows = conn.execute(
                "SELECT a.*, u.username FROM appeals a JOIN users u ON u.id = a.user_id WHERE a.closed_at IS NULL ORDER BY a.created_at"
            ).fetchall()
            for r in rows:
                print(f"@{r['username']}: {r['body']}")
            print(f"{len(rows)} open (lift with: unsuspend <name>)")
        elif a.cmd == "suspend":
            u = _user(conn, a.name)
            suspend_user(conn, ACTOR, u, a.days, a.reason)
            print(f"@{u['username']} suspended" + (f" for {a.days} days" if a.days else " until lifted"))
        elif a.cmd == "unsuspend":
            u = _user(conn, a.name)
            lift(conn, u["id"], ACTOR)
            log(conn, ACTOR, "unsuspend", u["username"])
            print(f"@{u['username']} unsuspended" if suspended(u) else f"@{u['username']} wasn't suspended")
        elif a.cmd == "delete":
            u = _user(conn, a.name)
            delete_user(conn, ACTOR, u, reserve=not a.free_name)
            print(f"@{u['username']} deleted" + ("" if a.free_name else ", name reserved"))
        elif a.cmd == "reserve":
            name = a.name.lower().lstrip("@")
            conn.execute(
                """INSERT INTO reserved_usernames (name, reason, created_at, created_by) VALUES (?, ?, ?, ?)
                   ON CONFLICT (name) DO UPDATE SET expires_at = NULL, reason = excluded.reason""",
                (name, a.reason, now, ACTOR),
            )
            log(conn, ACTOR, "reserve", name, a.reason)
            print(f"{name} reserved")
        elif a.cmd == "release":
            conn.execute("DELETE FROM reserved_usernames WHERE name = ?", (a.name.lower().lstrip("@"),))
            log(conn, ACTOR, "release", a.name.lower())
            print(f"{a.name} released")


def backup(folder: Path, keep: int = 0) -> Path:
    """<folder>/kicksnap-<UTC time>/ with kicksnap.db and vapid.pem. Media isn't kept: it burns anyway."""
    dest = folder / time.strftime("kicksnap-%Y%m%d-%H%M%S", time.gmtime())
    store.backup(dest / "kicksnap.db")
    vapid = DATA_DIR / "vapid.pem"
    if vapid.exists():
        shutil.copy2(vapid, dest / "vapid.pem")
    print(dest)
    if keep > 0:
        old = sorted(p for p in folder.glob("kicksnap-*") if p.is_dir())[:-keep]
        for p in old:
            shutil.rmtree(p)
            print(f"removed {p}")
    return dest


if __name__ == "__main__":
    main()

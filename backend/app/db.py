import os
import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path

DATA_DIR = Path(os.getenv("DATA_DIR", "./data"))
MEDIA_DIR = DATA_DIR / "media"
DB_PATH = DATA_DIR / "kicksnap.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY,
    username    TEXT UNIQUE COLLATE NOCASE,   -- NULL until picked right after sign-up
    color       TEXT NOT NULL DEFAULT '#C6FF3D',
    created_at  INTEGER NOT NULL,
    is_admin    INTEGER NOT NULL DEFAULT 0,       -- set from the server shell: python -m app.admin grant
    suspended_at    INTEGER,                      -- set = suspended
    suspended_until INTEGER                       -- NULL with suspended_at set = until lifted
);
-- every browser/phone is a device; its secret lives in an httpOnly cookie
CREATE TABLE IF NOT EXISTS devices (
    id          INTEGER PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  TEXT NOT NULL UNIQUE,
    label       TEXT NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL,
    seen_at     INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS passkeys (
    id          TEXT PRIMARY KEY,           -- base64url credential id
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    public_key  BLOB NOT NULL,
    sign_count  INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL
);
-- web push subscriptions, one per device that turned notifications on
CREATE TABLE IF NOT EXISTS push_subs (
    endpoint    TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id   INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    p256dh      TEXT NOT NULL,
    auth        TEXT NOT NULL,
    created_at  INTEGER NOT NULL
);
-- one row per direction; accepted friendships have both rows
CREATE TABLE IF NOT EXISTS friendships (
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    friend_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (user_id, friend_id)
);
CREATE TABLE IF NOT EXISTS snaps (
    id          TEXT PRIMARY KEY,
    sender_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL,          -- photo | video
    mime        TEXT NOT NULL,
    seconds     INTEGER NOT NULL,       -- view time, 0 = loop until closed
    has_overlay INTEGER NOT NULL DEFAULT 0, -- drawing/text layer on top of a video
    created_at  INTEGER NOT NULL,
    group_id    INTEGER REFERENCES groups(id) ON DELETE CASCADE  -- NULL = sent to people directly
);
CREATE TABLE IF NOT EXISTS deliveries (
    snap_id     TEXT NOT NULL REFERENCES snaps(id) ON DELETE CASCADE,
    recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    opened_at   INTEGER,
    PRIMARY KEY (snap_id, recipient_id)
);
CREATE INDEX IF NOT EXISTS deliveries_recipient ON deliveries(recipient_id, opened_at);
CREATE INDEX IF NOT EXISTS snaps_sender ON snaps(sender_id, created_at);
CREATE INDEX IF NOT EXISTS snaps_created ON snaps(created_at);
CREATE TABLE IF NOT EXISTS groups (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    color       TEXT NOT NULL,
    admin_id    INTEGER NOT NULL REFERENCES users(id),
    invite_mode TEXT NOT NULL DEFAULT 'members',  -- open (anyone with the code) | members | admin
    code        TEXT NOT NULL UNIQUE,             -- join code, only usable in open mode
    created_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS group_members (
    group_id    INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at   INTEGER NOT NULL,
    PRIMARY KEY (group_id, user_id)
);
-- short texts; either to_user (1:1) or group_id is set
CREATE TABLE IF NOT EXISTS messages (
    id          INTEGER PRIMARY KEY,
    sender_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    to_user     INTEGER REFERENCES users(id) ON DELETE CASCADE,
    group_id    INTEGER REFERENCES groups(id) ON DELETE CASCADE,
    body        TEXT NOT NULL,
    created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_direct ON messages(sender_id, to_user, created_at);
CREATE INDEX IF NOT EXISTS messages_group ON messages(group_id, created_at);
CREATE INDEX IF NOT EXISTS messages_to ON messages(to_user, created_at);
CREATE INDEX IF NOT EXISTS messages_created ON messages(created_at);
CREATE INDEX IF NOT EXISTS snaps_group ON snaps(group_id, created_at);
CREATE INDEX IF NOT EXISTS group_members_user ON group_members(user_id);
-- blocking hides both people from each other: no friending, snaps or texts
CREATE TABLE IF NOT EXISTS blocks (
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (user_id, blocked_id)
);
-- how far each user has read each chat ("u:<user id>" or "g:<group id>")
CREATE TABLE IF NOT EXISTS reads (
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    chat        TEXT NOT NULL,
    read_at     INTEGER NOT NULL,
    PRIMARY KEY (user_id, chat)
);
CREATE INDEX IF NOT EXISTS reads_chat ON reads(chat);
-- reports go to the admins of this server; no email, no scores
CREATE TABLE IF NOT EXISTS reports (
    id            INTEGER PRIMARY KEY,
    reporter_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    reporter_name TEXT NOT NULL,
    reported_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    reported_name TEXT NOT NULL,
    reason        TEXT NOT NULL,
    note          TEXT NOT NULL DEFAULT '',
    media         TEXT,            -- file in MEDIA_DIR/reports, only if the reporter attached the snap
    media_mime    TEXT,
    was_friend    INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL,
    closed_at     INTEGER,
    closed_by     TEXT,
    outcome       TEXT              -- dismissed | suspended | deleted
);
CREATE INDEX IF NOT EXISTS reports_open ON reports(closed_at, reported_id);
-- names nobody can register; expires_at set = a cooldown after someone deleted their account
CREATE TABLE IF NOT EXISTS reserved_usernames (
    name        TEXT PRIMARY KEY COLLATE NOCASE,
    reason      TEXT NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL,
    created_by  TEXT NOT NULL,
    expires_at  INTEGER
);
CREATE TABLE IF NOT EXISTS admin_log (
    id          INTEGER PRIMARY KEY,
    admin       TEXT NOT NULL,
    action      TEXT NOT NULL,
    target      TEXT NOT NULL,
    detail      TEXT NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL
);
"""


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


def init() -> None:
    MEDIA_DIR.mkdir(parents=True, exist_ok=True)
    with connect() as conn:
        # databases from before groups: add the column before the schema (and its FK) runs
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(snaps)")}
        if cols and "group_id" not in cols:
            conn.execute("ALTER TABLE snaps ADD COLUMN group_id INTEGER REFERENCES groups(id) ON DELETE CASCADE")
        ucols = {r["name"] for r in conn.execute("PRAGMA table_info(users)")}
        for col, ddl in [("is_admin", "INTEGER NOT NULL DEFAULT 0"), ("suspended_at", "INTEGER"), ("suspended_until", "INTEGER")]:
            if ucols and col not in ucols:
                conn.execute(f"ALTER TABLE users ADD COLUMN {col} {ddl}")
        fresh_reserved = not conn.execute("SELECT 1 FROM sqlite_master WHERE name = 'reserved_usernames'").fetchone()
        conn.executescript(SCHEMA)
        if fresh_reserved:  # seeded once; admins can remove them later
            conn.executemany(
                "INSERT OR IGNORE INTO reserved_usernames (name, reason, created_at, created_by) VALUES (?, 'reserved', strftime('%s','now'), 'system')",
                [(n,) for n in ("admin", "root", "support", "kicksnap", "moderator", "mod", "help", "system")],
            )


_local = threading.local()


@contextmanager
def db():
    """One connection per thread, reused. Autocommit, so nothing is left open between uses."""
    conn = getattr(_local, "conn", None)
    if conn is None or getattr(_local, "path", None) != DB_PATH:
        conn = _local.conn = connect()
        _local.path = DB_PATH
    yield conn

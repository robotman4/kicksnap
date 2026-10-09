import os
import sqlite3
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
    created_at  INTEGER NOT NULL
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
-- how far each user has read each chat ("u:<user id>" or "g:<group id>")
CREATE TABLE IF NOT EXISTS reads (
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    chat        TEXT NOT NULL,
    read_at     INTEGER NOT NULL,
    PRIMARY KEY (user_id, chat)
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
        conn.executescript(SCHEMA)


@contextmanager
def db():
    conn = connect()
    try:
        yield conn
    finally:
        conn.close()

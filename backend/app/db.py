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
    username    TEXT NOT NULL UNIQUE COLLATE NOCASE,
    pin_hash    TEXT NOT NULL,
    color       TEXT NOT NULL DEFAULT '#C6FF3D',
    created_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
    token       TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
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
    caption     TEXT NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS deliveries (
    snap_id     TEXT NOT NULL REFERENCES snaps(id) ON DELETE CASCADE,
    recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    opened_at   INTEGER,
    PRIMARY KEY (snap_id, recipient_id)
);
CREATE INDEX IF NOT EXISTS deliveries_recipient ON deliveries(recipient_id, opened_at);
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
        conn.executescript(SCHEMA)


@contextmanager
def db():
    conn = connect()
    try:
        yield conn
    finally:
        conn.close()

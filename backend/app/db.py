import os
import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path

DATA_DIR = Path(os.getenv("DATA_DIR", "./data"))
MEDIA_DIR = DATA_DIR / "media"
DB_PATH = DATA_DIR / "kicksnap.db"  # kept from before the rename to Kiks, so upgrades find their data

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY,
    username    TEXT UNIQUE COLLATE NOCASE,   -- NULL until picked right after sign-up
    color       TEXT NOT NULL DEFAULT '#C6FF3D',
    created_at  INTEGER NOT NULL,
    is_admin    INTEGER NOT NULL DEFAULT 0,       -- set from the server shell: python -m app.admin grant
    suspended_at    INTEGER,                      -- set = suspended
    suspended_until INTEGER,                      -- NULL with suspended_at set = until lifted
    suspend_reason  TEXT,                         -- shown to them on the suspended screen
    -- end-to-end encryption (docs/e2e.md): Ed25519 identity key and the device list it signed
    identity_key        TEXT,
    device_list         TEXT,
    device_list_sig     TEXT,
    device_list_version INTEGER NOT NULL DEFAULT 0
);
-- every browser/phone is a device; its secret lives in an httpOnly cookie
CREATE TABLE IF NOT EXISTS devices (
    id          INTEGER PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  TEXT NOT NULL UNIQUE,
    label       TEXT NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL,
    seen_at     INTEGER NOT NULL,
    enc_key     TEXT                       -- X25519 public key; the private half never leaves the device
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
    group_id    INTEGER REFERENCES groups(id) ON DELETE CASCADE,  -- NULL = sent to people directly
    e2e         INTEGER NOT NULL DEFAULT 0, -- 1 = file is ciphertext, envelope set (docs/e2e.md)
    envelope    TEXT
);
-- the snap's content key, wrapped for each device that may open it
CREATE TABLE IF NOT EXISTS snap_keys (
    snap_id     TEXT NOT NULL REFERENCES snaps(id) ON DELETE CASCADE,
    device_id   INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    key         TEXT NOT NULL,
    PRIMARY KEY (snap_id, device_id)
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
    body        TEXT NOT NULL,              -- the encrypted envelope when e2e = 1
    created_at  INTEGER NOT NULL,
    e2e         INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS message_keys (
    message_id  INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    device_id   INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    key         TEXT NOT NULL,
    PRIMARY KEY (message_id, device_id)
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
    media_verified INTEGER,         -- E2E snaps: 1 = the sender's signature checks out, 0 = it doesn't
    created_at    INTEGER NOT NULL,
    closed_at     INTEGER,
    closed_by     TEXT,
    outcome       TEXT              -- dismissed | suspended | deleted
);
CREATE INDEX IF NOT EXISTS reports_open ON reports(closed_at, reported_id);
-- a suspended person asking to be let back in: one per suspension
CREATE TABLE IF NOT EXISTS appeals (
    id            INTEGER PRIMARY KEY,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    suspended_at  INTEGER NOT NULL,   -- which suspension this is about
    body          TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    closed_at     INTEGER,
    closed_by     TEXT,
    outcome       TEXT,               -- lifted | rejected
    reply         TEXT NOT NULL DEFAULT '',
    UNIQUE (user_id, suspended_at)
);
-- proof attached to a report: copies of texts (they'd burn after 24h) and screenshots
CREATE TABLE IF NOT EXISTS report_items (
    id         INTEGER PRIMARY KEY,
    report_id  INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL,      -- text | image
    body       TEXT,               -- the text, copied when reported
    place      TEXT,               -- "direct" or the group's name
    file       TEXT,               -- image in MEDIA_DIR/reports
    mime       TEXT,
    at         INTEGER NOT NULL,   -- when the text was sent / the image was added
    verified   INTEGER             -- E2E texts: 1 = signed by the sender, 0 = not
);
CREATE INDEX IF NOT EXISTS report_items_report ON report_items(report_id);
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


# --- migrations ---------------------------------------------------------------
#
# SCHEMA above is the current shape and is safe to re-run (IF NOT EXISTS), so new tables
# and indexes only need adding there. Anything SCHEMA can't do to an existing database
# (new columns, data fixes) goes here as a numbered step: append, never edit or reorder.
# PRAGMA user_version records how many have run. A fresh database gets SCHEMA and skips them.


def _columns(conn, table: str) -> set[str]:
    return {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}


def _m1_groups_and_admin(conn) -> None:
    """Columns added before migrations existed: snaps.group_id, users admin/suspension/reason."""
    if "group_id" not in _columns(conn, "snaps"):
        conn.execute("ALTER TABLE snaps ADD COLUMN group_id INTEGER REFERENCES groups(id) ON DELETE CASCADE")
    ucols = _columns(conn, "users")
    for col, ddl in [("is_admin", "INTEGER NOT NULL DEFAULT 0"), ("suspended_at", "INTEGER"), ("suspended_until", "INTEGER"), ("suspend_reason", "TEXT")]:
        if col not in ucols:
            conn.execute(f"ALTER TABLE users ADD COLUMN {col} {ddl}")


def _m2_reserve_kiks(conn) -> None:
    """The app is called Kiks now: keep the new name from being registered (if nobody has it)."""
    if conn.execute("SELECT 1 FROM sqlite_master WHERE name = 'reserved_usernames'").fetchone() and not conn.execute(
        "SELECT 1 FROM users WHERE username = 'kiks'"
    ).fetchone():
        conn.execute(
            "INSERT OR IGNORE INTO reserved_usernames (name, reason, created_at, created_by) VALUES ('kiks', 'reserved', strftime('%s','now'), 'system')"
        )


def _m3_e2e(conn) -> None:
    """End-to-end encryption: keys on users and devices, flags on snaps/messages/reports."""
    for table, col, ddl in [
        ("users", "identity_key", "TEXT"), ("users", "device_list", "TEXT"), ("users", "device_list_sig", "TEXT"),
        ("users", "device_list_version", "INTEGER NOT NULL DEFAULT 0"), ("devices", "enc_key", "TEXT"),
        ("snaps", "e2e", "INTEGER NOT NULL DEFAULT 0"), ("snaps", "envelope", "TEXT"),
        ("messages", "e2e", "INTEGER NOT NULL DEFAULT 0"), ("reports", "media_verified", "INTEGER"),
        ("report_items", "verified", "INTEGER"),
    ]:
        cols = _columns(conn, table)
        if cols and col not in cols:  # a missing table gets the column from SCHEMA
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} {ddl}")


MIGRATIONS = [_m1_groups_and_admin, _m2_reserve_kiks, _m3_e2e]
RESERVED = ("admin", "root", "support", "kiks", "kicksnap", "moderator", "mod", "help", "system")


def schema_version(conn) -> int:
    return conn.execute("PRAGMA user_version").fetchone()[0]


def init() -> None:
    MEDIA_DIR.mkdir(parents=True, exist_ok=True)
    with connect() as conn:
        fresh = not conn.execute("SELECT 1 FROM sqlite_master WHERE name = 'users'").fetchone()
        fresh_reserved = not conn.execute("SELECT 1 FROM sqlite_master WHERE name = 'reserved_usernames'").fetchone()
        if not fresh:
            # migrations run before SCHEMA, whose indexes may need their columns
            for n in range(schema_version(conn), len(MIGRATIONS)):
                conn.execute("BEGIN IMMEDIATE")
                try:
                    MIGRATIONS[n](conn)
                    conn.execute(f"PRAGMA user_version = {n + 1}")
                    conn.execute("COMMIT")
                except BaseException:
                    conn.execute("ROLLBACK")
                    raise
        conn.executescript(SCHEMA)
        if fresh:
            conn.execute(f"PRAGMA user_version = {len(MIGRATIONS)}")
        if fresh_reserved:  # seeded once; admins can remove them later
            conn.executemany(
                "INSERT OR IGNORE INTO reserved_usernames (name, reason, created_at, created_by) VALUES (?, 'reserved', strftime('%s','now'), 'system')",
                [(n,) for n in RESERVED],
            )


def backup(dest: Path) -> None:
    """Consistent copy of the live database (safe while the app runs, unlike cp with WAL)."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    src = connect()
    out = sqlite3.connect(dest)
    try:
        src.backup(out)
    finally:
        out.close()
        src.close()


_local = threading.local()


@contextmanager
def db():
    """One connection per thread, reused. Autocommit, so nothing is left open between uses."""
    conn = getattr(_local, "conn", None)
    if conn is None or getattr(_local, "path", None) != DB_PATH:
        conn = _local.conn = connect()
        _local.path = DB_PATH
    yield conn

import sqlite3

from app import db as store

LEGACY = """
CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT UNIQUE COLLATE NOCASE,
                    color TEXT NOT NULL DEFAULT '#C6FF3D', created_at INTEGER NOT NULL);
CREATE TABLE snaps (id TEXT PRIMARY KEY, sender_id INTEGER NOT NULL, kind TEXT NOT NULL, mime TEXT NOT NULL,
                    seconds INTEGER NOT NULL, has_overlay INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
INSERT INTO users (username, created_at) VALUES ('old', 1);
"""


def _at(monkeypatch, tmp_path):
    monkeypatch.setattr(store, "DATA_DIR", tmp_path)
    monkeypatch.setattr(store, "MEDIA_DIR", tmp_path / "media")
    monkeypatch.setattr(store, "DB_PATH", tmp_path / "kicksnap.db")
    return tmp_path / "kicksnap.db"


def test_fresh_database_is_at_latest_version(monkeypatch, tmp_path):
    path = _at(monkeypatch, tmp_path)
    store.init()
    conn = sqlite3.connect(path)
    assert conn.execute("PRAGMA user_version").fetchone()[0] == len(store.MIGRATIONS)
    assert conn.execute("SELECT COUNT(*) FROM reserved_usernames").fetchone()[0] == len(store.RESERVED)


def test_pre_migration_database_upgrades_and_keeps_data(monkeypatch, tmp_path):
    path = _at(monkeypatch, tmp_path)
    conn = sqlite3.connect(path)
    conn.executescript(LEGACY)
    conn.close()
    store.init()
    store.init()  # running again is a no-op
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    assert conn.execute("PRAGMA user_version").fetchone()[0] == len(store.MIGRATIONS)
    assert {"is_admin", "suspended_at", "suspended_until", "suspend_reason"} <= {r["name"] for r in conn.execute("PRAGMA table_info(users)")}
    assert "group_id" in {r["name"] for r in conn.execute("PRAGMA table_info(snaps)")}
    assert conn.execute("SELECT username FROM users").fetchone()[0] == "old"


def test_backup_is_a_readable_copy(monkeypatch, tmp_path):
    _at(monkeypatch, tmp_path)
    store.init()
    out = tmp_path / "copy" / "kicksnap.db"
    store.backup(out)
    conn = sqlite3.connect(out)
    assert conn.execute("SELECT COUNT(*) FROM reserved_usernames").fetchone()[0] > 0


def test_upgrade_reserves_new_app_name(monkeypatch, tmp_path):
    path = _at(monkeypatch, tmp_path)
    store.init()
    conn = sqlite3.connect(path)
    conn.execute("DELETE FROM reserved_usernames WHERE name = 'kiks'")
    conn.execute("PRAGMA user_version = 1")  # as before the rename
    conn.commit()
    conn.close()
    store.init()
    conn = sqlite3.connect(path)
    assert conn.execute("SELECT 1 FROM reserved_usernames WHERE name = 'kiks'").fetchone()

from __future__ import annotations

import sqlite3
import time

import auth

LIMIT = 200


def _conn() -> sqlite3.Connection:
    auth.DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(auth.DB_PATH, timeout=10)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA journal_mode=WAL")
    return c


def init_db() -> None:
    auth.init_db()
    with _conn() as c:
        c.execute("""CREATE TABLE IF NOT EXISTS audit (
            id     INTEGER PRIMARY KEY AUTOINCREMENT,
            at     REAL NOT NULL,
            who    TEXT NOT NULL,
            what   TEXT NOT NULL,
            detail TEXT NOT NULL DEFAULT '')""")
        c.execute("CREATE INDEX IF NOT EXISTS audit_at ON audit(at DESC)")


def note(who: str, what: str, detail: str = "") -> None:
    try:
        init_db()
        with _conn() as c:
            c.execute("INSERT INTO audit(at, who, what, detail) VALUES (?,?,?,?)",
                      (time.time(), (who or "?").strip(), what.strip(), (detail or "").strip()[:300]))
    except Exception:
        pass


def entries(limit: int = LIMIT) -> list[dict]:
    init_db()
    with _conn() as c:
        rows = c.execute("SELECT at, who, what, detail FROM audit ORDER BY at DESC LIMIT ?",
                         (limit,)).fetchall()
    return [dict(r) for r in rows]

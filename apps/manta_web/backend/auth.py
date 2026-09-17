from __future__ import annotations

import asyncio
import hashlib
import os
import sqlite3
import secrets
import sys
import time
from dataclasses import dataclass
from pathlib import Path

from fastapi import Depends, HTTPException, Request, Response

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "manta_mcp"))
import access

DB_PATH = Path(os.environ.get(
    "MANTA_AUTH_DB", str(Path(__file__).resolve().parent / "manta_auth.db")))

COOKIE_NAME = "manta_session"
SESSION_DAYS = int(os.environ.get("MANTA_SESSION_DAYS", "30"))
ROLES = ("admin", "viewer")

MIN_PASSWORD_LEN = int(os.environ.get("MANTA_MIN_PASSWORD_LEN", "8"))

_SCRYPT = dict(n=2 ** 14, r=8, p=1, dklen=32)

_FAILS: dict[str, list[float]] = {}
MAX_FAILS = 8
FAIL_WINDOW = 300.0


@dataclass(frozen=True)
class User:
    username: str
    role: str

    @property
    def is_admin(self) -> bool:
        return self.role == "admin"



def _conn() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(DB_PATH, timeout=10)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA journal_mode=WAL")
    c.execute("PRAGMA foreign_keys=ON")
    return c


def init_db() -> None:
    with _conn() as c:
        c.execute("""CREATE TABLE IF NOT EXISTS users (
            username   TEXT PRIMARY KEY,
            pw_hash    TEXT NOT NULL,
            role       TEXT NOT NULL,
            created_at REAL NOT NULL,
            disabled   INTEGER NOT NULL DEFAULT 0)""")
        c.execute("""CREATE TABLE IF NOT EXISTS sessions (
            token_hash TEXT PRIMARY KEY,
            username   TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
            created_at REAL NOT NULL,
            expires_at REAL NOT NULL)""")
        c.execute("CREATE INDEX IF NOT EXISTS sessions_user ON sessions(username)")



def _hash(password: str) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.scrypt(password.encode(), salt=salt, **_SCRYPT)
    return f"scrypt${_SCRYPT['n']}${_SCRYPT['r']}${_SCRYPT['p']}${salt.hex()}${dk.hex()}"


def _verify(password: str, stored: str) -> bool:
    try:
        kind, n, r, p, salt_hex, hash_hex = stored.split("$")
        if kind != "scrypt":
            return False
        dk = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt_hex),
                            n=int(n), r=int(r), p=int(p), dklen=len(hash_hex) // 2)
    except (ValueError, TypeError):
        return False
    return secrets.compare_digest(dk.hex(), hash_hex)


_DUMMY_HASH: str | None = None


def _dummy_hash() -> str:
    global _DUMMY_HASH
    if _DUMMY_HASH is None:
        _DUMMY_HASH = _hash(secrets.token_hex(16))
    return _DUMMY_HASH



def create_user(username: str, password: str, role: str = "viewer") -> User:
    username = username.strip().lower()
    if not username:
        raise ValueError("Benutzername darf nicht leer sein")
    if role not in ROLES:
        raise ValueError(f"unbekannte Rolle {role!r}, erlaubt: {list(ROLES)}")
    if len(password) < MIN_PASSWORD_LEN:
        raise ValueError(f"Passwort muss mindestens {MIN_PASSWORD_LEN} Zeichen haben")
    init_db()
    with _conn() as c:
        if c.execute("SELECT 1 FROM users WHERE username=?", (username,)).fetchone():
            raise ValueError(f"Benutzer {username!r} existiert bereits")
        c.execute("INSERT INTO users(username,pw_hash,role,created_at) VALUES (?,?,?,?)",
                  (username, _hash(password), role, time.time()))
    return User(username, role)


def set_password(username: str, password: str) -> None:
    if len(password) < MIN_PASSWORD_LEN:
        raise ValueError(f"Passwort muss mindestens {MIN_PASSWORD_LEN} Zeichen haben")
    with _conn() as c:
        n = c.execute("UPDATE users SET pw_hash=? WHERE username=?",
                      (_hash(password), username.strip().lower())).rowcount
    if not n:
        raise ValueError(f"unbekannter Benutzer {username!r}")
    revoke_all(username)


def set_role(username: str, role: str) -> None:
    if role not in ROLES:
        raise ValueError(f"unbekannte Rolle {role!r}")
    with _conn() as c:
        n = c.execute("UPDATE users SET role=? WHERE username=?",
                      (role, username.strip().lower())).rowcount
    if not n:
        raise ValueError(f"unbekannter Benutzer {username!r}")


def set_disabled(username: str, disabled: bool) -> None:
    with _conn() as c:
        n = c.execute("UPDATE users SET disabled=? WHERE username=?",
                      (1 if disabled else 0, username.strip().lower())).rowcount
    if not n:
        raise ValueError(f"unbekannter Benutzer {username!r}")
    if disabled:
        revoke_all(username)


def delete_user(username: str) -> None:
    with _conn() as c:
        n = c.execute("DELETE FROM users WHERE username=?", (username.strip().lower(),)).rowcount
    if not n:
        raise ValueError(f"unbekannter Benutzer {username!r}")


def list_users() -> list[dict]:
    init_db()
    with _conn() as c:
        rows = c.execute(
            "SELECT u.username, u.role, u.created_at, u.disabled, "
            "(SELECT COUNT(*) FROM sessions s WHERE s.username=u.username AND s.expires_at>?) "
            "AS sessions FROM users u ORDER BY u.username", (time.time(),)).fetchall()
    return [dict(r) for r in rows]


def count_admins() -> int:
    init_db()
    with _conn() as c:
        return c.execute("SELECT COUNT(*) FROM users WHERE role='admin' AND disabled=0").fetchone()[0]



def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def login(username: str, password: str) -> str:
    username = (username or "").strip().lower()
    init_db()
    now = time.time()
    recent = [t for t in _FAILS.get(username, []) if now - t < FAIL_WINDOW]
    _FAILS[username] = recent
    if len(recent) >= MAX_FAILS:
        raise PermissionError("zu viele Fehlversuche, bitte spaeter erneut versuchen")

    with _conn() as c:
        row = c.execute("SELECT pw_hash, role, disabled FROM users WHERE username=?",
                        (username,)).fetchone()
    stored = row["pw_hash"] if row else _dummy_hash()
    ok = _verify(password or "", stored) and row is not None and not row["disabled"]
    if not ok:
        _FAILS.setdefault(username, []).append(now)
        raise PermissionError("Benutzername oder Passwort falsch")

    _FAILS.pop(username, None)
    token = secrets.token_urlsafe(32)
    with _conn() as c:
        c.execute("INSERT INTO sessions(token_hash,username,created_at,expires_at) VALUES (?,?,?,?)",
                  (_token_hash(token), username, now, now + SESSION_DAYS * 86400))
        c.execute("DELETE FROM sessions WHERE expires_at < ?", (now,))
    return token


def resolve(token: str | None) -> User | None:
    if not token:
        return None
    if not DB_PATH.exists():
        return None
    with _conn() as c:
        row = c.execute(
            "SELECT u.username, u.role FROM sessions s JOIN users u ON u.username=s.username "
            "WHERE s.token_hash=? AND s.expires_at > ? AND u.disabled=0",
            (_token_hash(token), time.time())).fetchone()
    return User(row["username"], row["role"]) if row else None


def revoke(token: str) -> None:
    with _conn() as c:
        c.execute("DELETE FROM sessions WHERE token_hash=?", (_token_hash(token),))


def revoke_all(username: str) -> int:
    with _conn() as c:
        return c.execute("DELETE FROM sessions WHERE username=?",
                         (username.strip().lower(),)).rowcount



def set_cookie(response: Response, token: str, secure: bool) -> None:
    response.set_cookie(
        COOKIE_NAME, token, httponly=True, samesite="lax", secure=secure,
        max_age=SESSION_DAYS * 86400, path="/")


def clear_cookie(response: Response, secure: bool) -> None:
    response.delete_cookie(COOKIE_NAME, path="/", httponly=True, samesite="lax", secure=secure)


def cookie_secure(request: Request) -> bool:
    proto = request.headers.get("x-forwarded-proto", "").split(",")[0].strip()
    return (proto or request.url.scheme) == "https"



async def anyone(request: Request) -> User | None:
    user = await asyncio.to_thread(resolve, request.cookies.get(COOKIE_NAME))
    access.set_scope(access.Scope(can_see_internal=user is not None,
                                  username=user.username if user else None))
    return user


async def user(u: User | None = Depends(anyone)) -> User:
    if u is None:
        raise HTTPException(401, "Anmeldung erforderlich")
    return u


async def admin(u: User = Depends(user)) -> User:
    if not u.is_admin:
        raise HTTPException(403, "nur fuer Administratoren")
    return u

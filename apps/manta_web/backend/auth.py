from __future__ import annotations

import asyncio
import hashlib
import os
import re
import sqlite3
import secrets
import sys
import threading
import time
from collections import OrderedDict
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

_FAILS: "OrderedDict[str, list[float]]" = OrderedDict()
_IP_FAILS: "OrderedDict[str, list[float]]" = OrderedDict()
_FAILS_LOCK = threading.Lock()
MAX_FAILS = 8
MAX_FAILS_PER_IP = int(os.environ.get("MANTA_MAX_FAILS_PER_IP", "30"))
FAIL_WINDOW = 300.0
MAX_TRACKED = 10_000
MAX_USERNAME_LEN = 64
MAX_PASSWORD_LEN = 1024
_SCRYPT_SLOTS = threading.BoundedSemaphore(int(os.environ.get("MANTA_SCRYPT_SLOTS", "2")))
SCRYPT_WAIT = 10.0
_calls = 0


class TooManyAttempts(PermissionError):
    pass


def _recent(store: OrderedDict, key: str, now: float) -> list[float]:
    return [t for t in store.get(key, []) if now - t < FAIL_WINDOW]


def _note_fail(store: OrderedDict, key: str, now: float) -> None:
    liste = _recent(store, key, now) + [now]
    store.pop(key, None)
    store[key] = liste
    while len(store) > MAX_TRACKED:
        store.popitem(last=False)


def _sweep(now: float) -> None:
    for store in (_FAILS, _IP_FAILS):
        for key in [k for k, v in store.items() if not v or now - v[-1] >= FAIL_WINDOW]:
            del store[key]


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



USERNAME_RE = re.compile(r"[a-z0-9][a-z0-9._-]{1,59}")


def valid_username(name: str) -> bool:
    return bool(USERNAME_RE.fullmatch(name or ""))


def create_user(username: str, password: str, role: str = "viewer") -> User:
    username = username.strip().lower()
    if not username:
        raise ValueError("The username must not be empty.")
    if not valid_username(username):
        raise ValueError("Usernames use letters, digits, dot, hyphen and underscore, start with "
                         "a letter or digit and have 2 to 60 characters.")
    if role not in ROLES:
        raise ValueError(f"Unknown role {role!r}; allowed: {list(ROLES)}.")
    if len(password) < MIN_PASSWORD_LEN:
        raise ValueError(f"The password must have at least {MIN_PASSWORD_LEN} characters.")
    init_db()
    with _conn() as c:
        if c.execute("SELECT 1 FROM users WHERE username=?", (username,)).fetchone():
            raise ValueError(f"User {username!r} already exists.")
        c.execute("INSERT INTO users(username,pw_hash,role,created_at) VALUES (?,?,?,?)",
                  (username, _hash(password), role, time.time()))
    return User(username, role)


def set_password(username: str, password: str) -> None:
    if len(password) < MIN_PASSWORD_LEN:
        raise ValueError(f"The password must have at least {MIN_PASSWORD_LEN} characters.")
    with _conn() as c:
        n = c.execute("UPDATE users SET pw_hash=? WHERE username=?",
                      (_hash(password), username.strip().lower())).rowcount
    if not n:
        raise ValueError(f"Unknown user {username!r}.")
    revoke_all(username)


def set_role(username: str, role: str) -> None:
    if role not in ROLES:
        raise ValueError(f"Unknown role {role!r}.")
    with _conn() as c:
        n = c.execute("UPDATE users SET role=? WHERE username=?",
                      (role, username.strip().lower())).rowcount
    if not n:
        raise ValueError(f"Unknown user {username!r}.")


def set_disabled(username: str, disabled: bool) -> None:
    with _conn() as c:
        n = c.execute("UPDATE users SET disabled=? WHERE username=?",
                      (1 if disabled else 0, username.strip().lower())).rowcount
    if not n:
        raise ValueError(f"Unknown user {username!r}.")
    if disabled:
        revoke_all(username)


def delete_user(username: str) -> None:
    username = username.strip().lower()
    c = _immediate()
    try:
        row = c.execute("SELECT role, disabled FROM users WHERE username=?",
                        (username,)).fetchone()
        if row is None:
            raise UnknownUser(f"Unknown user {username!r}.")
        if row["role"] == "admin" and not row["disabled"]:
            _require_other_admin(c, username)
        c.execute("DELETE FROM users WHERE username=?", (username,))
        c.execute("COMMIT")
    except BaseException:
        c.execute("ROLLBACK")
        raise
    finally:
        c.close()


class UnknownUser(ValueError):
    pass


def _immediate() -> sqlite3.Connection:
    init_db()
    c = sqlite3.connect(DB_PATH, timeout=10, isolation_level=None)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA foreign_keys=ON")
    c.execute("BEGIN IMMEDIATE")
    return c


def _require_other_admin(c: sqlite3.Connection, username: str) -> None:
    andere = c.execute("SELECT COUNT(*) FROM users WHERE role='admin' AND disabled=0 "
                       "AND username<>?", (username,)).fetchone()[0]
    if andere == 0:
        raise ValueError("At least one active administrator must remain.")


def update_user(username: str, password: str | None = None, role: str | None = None,
                disabled: bool | None = None) -> None:
    username = username.strip().lower()
    if role is not None and role not in ROLES:
        raise ValueError(f"Unknown role {role!r}; allowed: {list(ROLES)}.")
    if password is not None and len(password) < MIN_PASSWORD_LEN:
        raise ValueError(f"The password must have at least {MIN_PASSWORD_LEN} characters.")
    pw_hash = _hash(password) if password is not None else None
    c = _immediate()
    try:
        row = c.execute("SELECT role, disabled FROM users WHERE username=?",
                        (username,)).fetchone()
        if row is None:
            raise UnknownUser(f"Unknown user {username!r}.")
        ist_admin = row["role"] == "admin" and not row["disabled"]
        bleibt_admin = ((role or row["role"]) == "admin"
                        and not (row["disabled"] if disabled is None else disabled))
        if ist_admin and not bleibt_admin:
            _require_other_admin(c, username)
        if pw_hash is not None:
            c.execute("UPDATE users SET pw_hash=? WHERE username=?", (pw_hash, username))
        if role is not None:
            c.execute("UPDATE users SET role=? WHERE username=?", (role, username))
        if disabled is not None:
            c.execute("UPDATE users SET disabled=? WHERE username=?",
                      (1 if disabled else 0, username))
        c.execute("COMMIT")
    except BaseException:
        c.execute("ROLLBACK")
        raise
    finally:
        c.close()
    if password is not None or disabled:
        revoke_all(username)


def list_users() -> list[dict]:
    init_db()
    with _conn() as c:
        rows = c.execute(
            "SELECT u.username, u.role, u.created_at, u.disabled, "
            "(SELECT COUNT(*) FROM sessions s WHERE s.username=u.username AND s.expires_at>?) "
            "AS sessions FROM users u ORDER BY u.username", (time.time(),)).fetchall()
    return [dict(r) for r in rows]


def account_since(username: str) -> float | None:
    init_db()
    with _conn() as c:
        row = c.execute("SELECT created_at FROM users WHERE username=?",
                        ((username or "").strip().lower(),)).fetchone()
    return row["created_at"] if row else None


def count_admins() -> int:
    init_db()
    with _conn() as c:
        return c.execute("SELECT COUNT(*) FROM users WHERE role='admin' AND disabled=0").fetchone()[0]



def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def login(username: str, password: str, ip: str = "") -> str:
    global _calls
    username = (username or "").strip().lower()
    if len(username) > MAX_USERNAME_LEN or len(password or "") > MAX_PASSWORD_LEN:
        raise PermissionError("Wrong username or password.")
    ip = (ip or "")[:64]
    init_db()
    now = time.time()
    with _FAILS_LOCK:
        _calls += 1
        if _calls % 256 == 0:
            _sweep(now)
        if (len(_recent(_FAILS, username, now)) >= MAX_FAILS
                or (ip and len(_recent(_IP_FAILS, ip, now)) >= MAX_FAILS_PER_IP)):
            raise TooManyAttempts("Too many failed attempts. Please try again later.")

    with _conn() as c:
        row = c.execute("SELECT pw_hash, role, disabled FROM users WHERE username=?",
                        (username,)).fetchone()
    stored = row["pw_hash"] if row else _dummy_hash()
    if not _SCRYPT_SLOTS.acquire(timeout=SCRYPT_WAIT):
        raise TooManyAttempts("The server is busy with sign-ins. Please try again shortly.")
    try:
        ok = _verify(password or "", stored) and row is not None and not row["disabled"]
    finally:
        _SCRYPT_SLOTS.release()
    if not ok:
        with _FAILS_LOCK:
            _note_fail(_FAILS, username, now)
            if ip:
                _note_fail(_IP_FAILS, ip, now)
        raise PermissionError("Wrong username or password.")

    with _FAILS_LOCK:
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
        raise HTTPException(401, "Sign-in required.")
    return u


async def admin(u: User = Depends(user)) -> User:
    if not u.is_admin:
        raise HTTPException(403, "Administrators only.")
    return u

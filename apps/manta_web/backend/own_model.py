from __future__ import annotations

import os
import sqlite3
import time
from pathlib import Path

from cryptography.fernet import Fernet, InvalidToken

import agent
import auth

# The key is encrypted with MANTA_SECRET_KEY, or with a key file created next to the database.
# A copy of the database alone does not reveal any user's provider key.


def _fernet() -> Fernet:
    schluessel = (os.environ.get("MANTA_SECRET_KEY") or "").strip()
    if not schluessel:
        datei = Path(os.environ.get("MANTA_SECRET_KEY_FILE",
                                    str(auth.DB_PATH.parent / "manta_secret.key")))
        if not datei.exists():
            datei.parent.mkdir(parents=True, exist_ok=True)
            fd = os.open(datei, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "wb") as f:
                f.write(Fernet.generate_key())
        schluessel = datei.read_text().strip()
    return Fernet(schluessel.encode())


def _conn() -> sqlite3.Connection:
    c = auth._conn()
    c.execute("""CREATE TABLE IF NOT EXISTS own_models (
        username   TEXT PRIMARY KEY REFERENCES users(username) ON DELETE CASCADE,
        base_url   TEXT NOT NULL,
        model      TEXT NOT NULL,
        key_enc    BLOB NOT NULL,
        updated_at REAL NOT NULL)""")
    return c


def view(username: str) -> dict:
    with _conn() as c:
        row = c.execute("SELECT base_url, model, updated_at FROM own_models WHERE username=?",
                        (username,)).fetchone()
    if row is None:
        return {"set": False}
    return {"set": True, "base_url": row["base_url"], "model": row["model"],
            "updated_at": row["updated_at"]}


def save(username: str, base_url: str, model: str, key: str | None) -> dict:
    """key None keeps the stored key, but only for the same address."""
    with _conn() as c:
        row = c.execute("SELECT base_url, key_enc FROM own_models WHERE username=?",
                        (username,)).fetchone()
    if not (key or "").strip():
        if row is None:
            raise ValueError("Enter the API key.")
        if row["base_url"] != (base_url or "").strip().rstrip("/"):
            raise ValueError("The address changed: enter the API key again — the stored one is "
                             "never sent to a new address.")
        key = _fernet().decrypt(row["key_enc"]).decode()
    try:
        p = agent.SessionProvider(base_url, key, model)
    except agent.AgentError as e:
        raise ValueError(str(e)) from e
    with _conn() as c:
        c.execute("INSERT INTO own_models(username, base_url, model, key_enc, updated_at) "
                  "VALUES (?,?,?,?,?) ON CONFLICT(username) DO UPDATE SET "
                  "base_url=excluded.base_url, model=excluded.model, key_enc=excluded.key_enc, "
                  "updated_at=excluded.updated_at",
                  (username, p.base_url, p.model, _fernet().encrypt(p.api_key.encode()),
                   time.time()))
    return view(username)


def remove(username: str) -> None:
    with _conn() as c:
        c.execute("DELETE FROM own_models WHERE username=?", (username,))


def provider(username: str) -> agent.SessionProvider | None:
    with _conn() as c:
        row = c.execute("SELECT base_url, model, key_enc FROM own_models WHERE username=?",
                        (username,)).fetchone()
    if row is None:
        return None
    try:
        key = _fernet().decrypt(row["key_enc"]).decode()
    except InvalidToken as e:
        raise agent.AgentError("Your stored key can no longer be read (the server key changed). "
                               "Enter it again under settings → Own model.", "auth") from e
    return agent.SessionProvider(row["base_url"], key, row["model"])

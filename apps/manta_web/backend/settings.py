from __future__ import annotations

import os
import re
import sqlite3
import time
from urllib.parse import urlsplit

import auth
import mailer

MAIL_KEYS: dict[str, str] = {
    "smtp_host": "MANTA_SMTP_HOST",
    "smtp_port": "MANTA_SMTP_PORT",
    "smtp_tls": "MANTA_SMTP_TLS",
    "smtp_user": "MANTA_SMTP_USER",
    "smtp_password": "MANTA_SMTP_PASSWORD",
    "mail_from": "MANTA_MAIL_FROM",
    "request_mailto": "MANTA_REQUEST_MAILTO",
    "public_url": "MANTA_PUBLIC_URL",
}
ALL_KEYS: dict[str, str] = MAIL_KEYS
ENV_TO_KEY: dict[str, str] = {env: key for key, env in ALL_KEYS.items()}
SECRET_KEYS = frozenset({"smtp_password"})
TLS_MODES = ("starttls", "ssl", "none")


def _conn() -> sqlite3.Connection:
    auth.DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(auth.DB_PATH, timeout=10)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA journal_mode=WAL")
    return c


def init_db() -> None:
    auth.init_db()
    with _conn() as c:
        c.execute("""CREATE TABLE IF NOT EXISTS settings (
            key        TEXT PRIMARY KEY,
            value      TEXT NOT NULL,
            updated_at REAL NOT NULL,
            updated_by TEXT NOT NULL)""")


def _row(key: str) -> sqlite3.Row | None:
    init_db()
    with _conn() as c:
        return c.execute("SELECT * FROM settings WHERE key=?", (key,)).fetchone()


def get(key: str, default: str = "") -> str:
    row = _row(key)
    if row is not None:
        return row["value"]
    env = ALL_KEYS.get(key)
    return (os.environ.get(env) or default).strip() if env else default


def source(key: str) -> str:
    if _row(key) is not None:
        return "panel"
    env = ALL_KEYS.get(key)
    return "env" if env and (os.environ.get(env) or "").strip() else "unset"



def host_entry(eintrag: str) -> tuple[str, int | None] | None:
    e = (eintrag or "").strip().lower()
    if not e or not re.fullmatch(r"[a-z0-9.\-:\[\]]+", e):
        return None
    if e.count(":") > 1 and not e.startswith("["):
        return (e, None) if re.fullmatch(r"[0-9a-f:.]+", e) else None
    if e.endswith(":"):
        return None
    try:
        teile = urlsplit("//" + e)
        host, port = (teile.hostname or ""), teile.port
    except ValueError:
        return None
    if not host or teile.path or port == 0:
        return None
    return host, port


def _valid_recipients(raw: str) -> bool:
    teile = [t.strip() for t in re.split(r"[,;]", raw) if t.strip()]
    return all(mailer.valid_email(t) for t in teile)


def validate(values: dict[str, str]) -> None:
    unknown = set(values) - set(ALL_KEYS)
    if unknown:
        raise ValueError(f"unknown setting: {', '.join(sorted(unknown))}")
    port = (values.get("smtp_port") or "").strip()
    if port and (not port.isdigit() or not 1 <= int(port) <= 65535):
        raise ValueError("smtp_port must be a number between 1 and 65535")
    tls = (values.get("smtp_tls") or "").strip().lower()
    if tls and tls not in TLS_MODES:
        raise ValueError(f"smtp_tls must be {' | '.join(TLS_MODES)}")
    absender = (values.get("mail_from") or "").strip()
    if absender and not mailer.valid_email(absender):
        raise ValueError(f"mail_from is not an address: {absender}")
    empfaenger = (values.get("request_mailto") or "").strip()
    if empfaenger and not _valid_recipients(empfaenger):
        raise ValueError("request_mailto: separate with commas, one address per entry")
    url = (values.get("public_url") or "").strip()
    if url and not re.match(r"^https?://", url):
        raise ValueError("public_url must start with http:// or https://")


SECRET_TARGETS: dict[str, tuple[str, ...]] = {
    "smtp_password": ("smtp_host", "smtp_port", "smtp_tls"),
}


def _ziel(key: str, value: str) -> str:
    v = (value or "").strip()
    if key == "smtp_tls":
        return (v or "starttls").lower()
    if key == "smtp_port":
        return v or "587"
    return v.lower()


def _check_secret_targets(values: dict[str, str]) -> None:
    for geheim, ziele in SECRET_TARGETS.items():
        if geheim in values or not get(geheim):
            continue
        neu = [z for z in ziele if z in values and _ziel(z, values[z]) != _ziel(z, get(z))]
        if neu:
            raise ValueError(f"{', '.join(neu)} changes where the stored {geheim} is sent — "
                             f"enter {geheim} again in the same save")


def set_many(values: dict[str, str], by: str) -> dict:
    validate(values)
    _check_secret_targets(values)
    init_db()
    now = time.time()
    with _conn() as c:
        for key, value in values.items():
            wert = (value or "").strip()
            if key == "smtp_tls":
                wert = wert.lower()
            c.execute("INSERT INTO settings(key, value, updated_at, updated_by) VALUES (?,?,?,?) "
                      "ON CONFLICT(key) DO UPDATE SET value=excluded.value, "
                      "updated_at=excluded.updated_at, updated_by=excluded.updated_by",
                      (key, wert, now, by))
    return view()


def reset(keys: list[str], by: str) -> dict:
    del by
    unknown = set(keys) - set(ALL_KEYS)
    if unknown:
        raise ValueError(f"unknown setting: {', '.join(sorted(unknown))}")
    init_db()
    with _conn() as c:
        for key in keys:
            c.execute("DELETE FROM settings WHERE key=?", (key,))
    return view()


def view() -> dict:
    werte, herkunft = {}, {}
    for key in ALL_KEYS:
        herkunft[key] = source(key)
        if key not in SECRET_KEYS:
            werte[key] = get(key)
    for geheim in SECRET_KEYS:
        werte[f"{geheim}_set"] = bool(get(geheim))
    row = _row("smtp_host")
    return {"values": werte, "source": herkunft,
            "updated_at": row["updated_at"] if row else None,
            "updated_by": row["updated_by"] if row else None,
            "mail": mailer.status_summary()}

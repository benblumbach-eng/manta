from __future__ import annotations

import os
import re
import sqlite3
import time

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
AGENT_KEYS: dict[str, str] = {
    "ollama_model": "OLLAMA_MODEL",
    "grounding": "MANTA_GROUNDING",
    "openai_base_url": "MANTA_OPENAI_BASE_URL",
    "openai_api_key": "MANTA_OPENAI_API_KEY",
    "openai_models": "MANTA_OPENAI_MODELS",
    "openai_timeout": "MANTA_OPENAI_TIMEOUT",
}
ALL_KEYS: dict[str, str] = {**MAIL_KEYS, **AGENT_KEYS}
ENV_TO_KEY: dict[str, str] = {env: key for key, env in ALL_KEYS.items()}
SECRET_KEYS = frozenset({"smtp_password", "openai_api_key"})
TLS_MODES = ("starttls", "ssl", "none")
GROUNDING_MODES = ("off", "mark", "refuse")


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



def _valid_recipients(raw: str) -> bool:
    teile = [t.strip() for t in re.split(r"[,;]", raw) if t.strip()]
    return all(mailer.valid_email(t) for t in teile)


def validate(values: dict[str, str]) -> None:
    unbekannt = set(values) - set(ALL_KEYS)
    if unbekannt:
        raise ValueError(f"unbekannte Einstellung: {', '.join(sorted(unbekannt))}")
    port = (values.get("smtp_port") or "").strip()
    if port and (not port.isdigit() or not 1 <= int(port) <= 65535):
        raise ValueError("smtp_port muss eine Zahl zwischen 1 und 65535 sein")
    tls = (values.get("smtp_tls") or "").strip().lower()
    if tls and tls not in TLS_MODES:
        raise ValueError(f"smtp_tls muss {' | '.join(TLS_MODES)} sein")
    absender = (values.get("mail_from") or "").strip()
    if absender and not mailer.valid_email(absender):
        raise ValueError(f"mail_from ist keine Adresse: {absender}")
    empfaenger = (values.get("request_mailto") or "").strip()
    if empfaenger and not _valid_recipients(empfaenger):
        raise ValueError("request_mailto: mit Komma trennen, jede Angabe eine Adresse")
    url = (values.get("public_url") or "").strip()
    if url and not re.match(r"^https?://", url):
        raise ValueError("public_url muss mit http:// oder https:// beginnen")
    belegpflicht = (values.get("grounding") or "").strip().lower()
    if belegpflicht and belegpflicht not in GROUNDING_MODES:
        raise ValueError(f"grounding muss {' | '.join(GROUNDING_MODES)} sein")
    basis = (values.get("openai_base_url") or "").strip()
    if basis and not re.match(r"^https?://", basis):
        raise ValueError("openai_base_url muss mit http:// oder https:// beginnen")
    zeit = (values.get("openai_timeout") or "").strip()
    if zeit:
        try:
            if float(zeit) <= 0:
                raise ValueError
        except ValueError:
            raise ValueError("openai_timeout muss eine Zahl groesser als 0 sein") from None


def set_many(values: dict[str, str], by: str) -> dict:
    validate(values)
    init_db()
    now = time.time()
    with _conn() as c:
        for key, value in values.items():
            wert = (value or "").strip()
            if key in ("smtp_tls", "grounding"):
                wert = wert.lower()
            c.execute("INSERT INTO settings(key, value, updated_at, updated_by) VALUES (?,?,?,?) "
                      "ON CONFLICT(key) DO UPDATE SET value=excluded.value, "
                      "updated_at=excluded.updated_at, updated_by=excluded.updated_by",
                      (key, wert, now, by))
    return view()


def reset(keys: list[str], by: str) -> dict:
    del by
    unbekannt = set(keys) - set(ALL_KEYS)
    if unbekannt:
        raise ValueError(f"unbekannte Einstellung: {', '.join(sorted(unbekannt))}")
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

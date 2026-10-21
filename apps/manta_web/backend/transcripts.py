from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import re
import secrets
import sqlite3
import time
from urllib.parse import urlsplit

import auth

_log = logging.getLogger("manta.transcripts")

MAX_OUTPUT_CHARS = 1_000_000
MAX_TITLE_CHARS = 120
LIST_LIMIT = 100
MIN_SECRET_CHARS = 6
REDACTED = "[redacted]"
_KEY_SHAPES = re.compile(r"\b(?:sk|pk|rk)-[A-Za-z0-9_\-]{12,}|(?i:bearer)\s+[A-Za-z0-9._~+/=\-]{12,}")
STATUSES = ("answered", "step_limit", "error")


class UnknownConversation(LookupError):
    pass


class OtherDataset(ValueError):
    pass



def _conn() -> sqlite3.Connection:
    auth.DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(auth.DB_PATH, timeout=10)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA journal_mode=WAL")
    c.execute("PRAGMA foreign_keys=ON")
    return c


def init_db() -> None:
    auth.init_db()
    with _conn() as c:
        c.execute("""CREATE TABLE IF NOT EXISTS conversations (
            id            TEXT PRIMARY KEY,
            username      TEXT NOT NULL,
            account_since REAL,
            dataset_id    TEXT NOT NULL DEFAULT '',
            title         TEXT NOT NULL DEFAULT '',
            created_at    REAL NOT NULL,
            updated_at    REAL NOT NULL,
            n_turns       INTEGER NOT NULL DEFAULT 0)""")
        c.execute("CREATE INDEX IF NOT EXISTS conversations_owner "
                  "ON conversations(username, updated_at DESC)")
        c.execute("CREATE INDEX IF NOT EXISTS conversations_updated "
                  "ON conversations(updated_at DESC)")
        c.execute("""CREATE TABLE IF NOT EXISTS conversation_turns (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
            seq             INTEGER NOT NULL,
            asked_at        REAL NOT NULL,
            finished_at     REAL NOT NULL,
            question        TEXT NOT NULL,
            answer          TEXT NOT NULL DEFAULT '',
            status          TEXT NOT NULL,
            error           TEXT NOT NULL DEFAULT '',
            model           TEXT NOT NULL DEFAULT '',
            provider        TEXT NOT NULL DEFAULT '',
            provider_host   TEXT NOT NULL DEFAULT '',
            grounding_mode  TEXT NOT NULL DEFAULT '',
            ungrounded      TEXT NOT NULL DEFAULT '[]',
            record          TEXT NOT NULL DEFAULT '{}')""")
        c.execute("CREATE INDEX IF NOT EXISTS conversation_turns_seq "
                  "ON conversation_turns(conversation_id, seq)")
        c.execute("""CREATE TABLE IF NOT EXISTS prompt_texts (
            sha256 TEXT PRIMARY KEY,
            text   TEXT NOT NULL)""")



def admins_can_read() -> bool:
    try:
        import settings
        wert = settings.get("admins_read_transcripts")
    except Exception:
        wert = os.environ.get("MANTA_ADMINS_READ_TRANSCRIPTS") or ""
    return (wert or "on").strip().lower() != "off"


def _is_owner(user: auth.User, row: sqlite3.Row | dict) -> bool:
    if user is None or row["username"] != user.username:
        return False
    seit = auth.account_since(user.username)
    return seit is not None and row["account_since"] == seit


def can_read(user: auth.User, row: sqlite3.Row | dict) -> bool:
    return _is_owner(user, row) or (user is not None and user.is_admin and admins_can_read())


def _conversation_row(conversation_id: str) -> sqlite3.Row | None:
    init_db()
    with _conn() as c:
        return c.execute("SELECT * FROM conversations WHERE id=?",
                         (conversation_id,)).fetchone()


def check_conversation(user: auth.User, conversation_id: str | None,
                       dataset_id: str | None) -> str | None:
    if not conversation_id:
        return None
    row = _conversation_row(conversation_id)
    if row is None or not _is_owner(user, row):
        raise UnknownConversation(conversation_id)
    if row["dataset_id"] != (dataset_id or ""):
        raise OtherDataset(row["dataset_id"])
    return conversation_id



def known_secrets(*extra: str | None) -> list[str]:
    werte = list(extra)
    try:
        import settings
        werte += [settings.get(k) for k in settings.SECRET_KEYS]
    except Exception:
        werte += [os.environ.get("MANTA_OPENAI_API_KEY"), os.environ.get("MANTA_SMTP_PASSWORD")]
    werte.append(os.environ.get("NEO4J_PASSWORD"))
    sauber = {(w or "").strip() for w in werte}
    return sorted((w for w in sauber if len(w) >= MIN_SECRET_CHARS), key=len, reverse=True)


def redact(obj, geheim: list[str]):
    if isinstance(obj, str):
        for g in geheim:
            if g in obj:
                obj = obj.replace(g, REDACTED)
        return _KEY_SHAPES.sub(REDACTED, obj)
    if isinstance(obj, dict):
        return {redact(str(k), geheim): redact(v, geheim) for k, v in obj.items()}
    if isinstance(obj, (list, tuple, set)):
        return [redact(v, geheim) for v in obj]
    if isinstance(obj, float) and not math.isfinite(obj):
        return str(obj)
    if obj is None or isinstance(obj, (bool, int, float)):
        return obj
    return redact(str(obj), geheim)



def provider_info(kind: str, url: str | None) -> dict:
    try:
        host = (urlsplit(url or "").hostname or "") if url else ""
    except ValueError:
        host = ""
    return {"kind": kind, "host": host}


def _kapp(output) -> tuple[object, bool]:
    text = json.dumps(output, default=str, ensure_ascii=False)
    if len(text) <= MAX_OUTPUT_CHARS:
        return output, False
    return ({"_stored_truncated": f"{len(text)} characters; the first {MAX_OUTPUT_CHARS} are "
                                  f"kept below as text",
             "head": text[:MAX_OUTPUT_CHARS]}, True)


def _events_for_storage(events: list[dict]) -> tuple[list[dict], str | None, str | None]:
    out: list[dict] = []
    sha, text = None, None
    for e in events or []:
        e = dict(e)
        if e.get("kind") == "prompt" and isinstance(e.get("system_prompt"), str):
            text = e.pop("system_prompt")
            sha = hashlib.sha256(text.encode("utf-8")).hexdigest()
            e["system_prompt_sha256"] = sha
            e["system_prompt_chars"] = len(text)
        if e.get("kind") == "tool" and "output" in e:
            e["output"], e["stored_truncated"] = _kapp(e["output"])
        out.append(e)
    return out, sha, text


def record_turn(*, user: auth.User, conversation_id: str | None, dataset_id: str | None,
                question: str, asked_at: float, finished_at: float, status: str,
                result: dict | None = None, events: list[dict] | None = None,
                error: str = "", provider: dict | None = None, model: str = "",
                request: dict | None = None, extra_secrets: tuple = ()) -> dict:
    leer = {"conversation_id": conversation_id, "turn_id": None}
    try:
        return _record_turn(user=user, conversation_id=conversation_id, dataset_id=dataset_id,
                            question=question, asked_at=asked_at, finished_at=finished_at,
                            status=status, result=result or {}, events=events or [],
                            error=error, provider=provider or {}, model=model,
                            request=request or {}, extra_secrets=extra_secrets)
    except Exception:
        _log.warning("transcript not saved", exc_info=True)
        return leer


def _record_turn(*, user, conversation_id, dataset_id, question, asked_at, finished_at, status,
                 result, events, error, provider, model, request, extra_secrets) -> dict:
    if status not in STATUSES:
        raise ValueError(f"unknown status {status!r}")
    geheim = known_secrets(*extra_secrets)
    ereignisse, sha, systemtext = _events_for_storage(events)
    gesehen = next((e for e in events if e.get("kind") == "prompt"), None)
    pruefung = [e for e in events if e.get("kind") == "grounding"]
    record = {
        "version": 1,
        "context": (gesehen or {}).get("context") or {"dataset_id": dataset_id},
        "request": request,
        "provider": provider,
        "result": {k: result.get(k) for k in ("model", "steps", "truncated", "grounding",
                                              "corrected", "own_key", "question_kind", "check")},
        "findings": result.get("findings") or [],
        "grounding": pruefung[-1] if pruefung else None,
        "evidence": result.get("evidence") or [],
        "events": ereignisse,
        "stored_truncated": any(e.get("stored_truncated") for e in ereignisse),
    }
    record = redact(record, geheim)
    frage = redact(question or "", geheim)
    antwort = redact(result.get("answer") or "", geheim)
    fehler = redact(error or "", geheim)
    modell = redact(model or result.get("model") or (gesehen or {}).get("model") or "", geheim)
    ungrounded = redact(list(result.get("ungrounded") or []), geheim)

    seit = auth.account_since(user.username)
    init_db()
    now = time.time()
    with _conn() as c:
        cid = conversation_id
        if cid is None:
            cid = secrets.token_hex(8)
            titel = " ".join(frage.split())
            if len(titel) > MAX_TITLE_CHARS:
                titel = titel[:MAX_TITLE_CHARS].rstrip() + " …"
            c.execute("INSERT INTO conversations(id, username, account_since, dataset_id, title, "
                      "created_at, updated_at, n_turns) VALUES (?,?,?,?,?,?,?,0)",
                      (cid, user.username, seit, dataset_id or "", titel, asked_at, now))
        seq = c.execute("SELECT COALESCE(MAX(seq), 0) + 1 FROM conversation_turns "
                        "WHERE conversation_id=?", (cid,)).fetchone()[0]
        cur = c.execute(
            "INSERT INTO conversation_turns(conversation_id, seq, asked_at, finished_at, question, "
            "answer, status, error, model, provider, provider_host, grounding_mode, ungrounded, "
            "record) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (cid, seq, asked_at, finished_at, frage, antwort, status, fehler, modell,
             str(provider.get("kind") or ""), str(provider.get("host") or ""),
             str(result.get("grounding") or ""), json.dumps(ungrounded, ensure_ascii=False),
             json.dumps(record, default=str, ensure_ascii=False)))
        c.execute("UPDATE conversations SET updated_at=?, n_turns=n_turns+1 WHERE id=?",
                  (now, cid))
        if sha and systemtext is not None:
            c.execute("INSERT OR IGNORE INTO prompt_texts(sha256, text) VALUES (?,?)",
                      (sha, redact(systemtext, geheim)))
    return {"conversation_id": cid, "turn_id": cur.lastrowid}



_CONV_FIELDS = "c.id, c.username, c.dataset_id, c.title, c.created_at, c.updated_at, c.n_turns"


def _like(q: str) -> str:
    return "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


def _search(q: str | None) -> tuple[str, list]:
    q = (q or "").strip()
    if not q:
        return "", []
    m = _like(q)
    return (" AND (c.title LIKE ? ESCAPE '\\' OR c.username LIKE ? ESCAPE '\\' "
            "OR c.dataset_id LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM conversation_turns t "
            "WHERE t.conversation_id=c.id AND (t.question LIKE ? ESCAPE '\\' "
            "OR t.answer LIKE ? ESCAPE '\\')))", [m, m, m, m, m])


def list_own(user: auth.User, q: str | None = None, dataset_id: str | None = None,
             limit: int = LIST_LIMIT) -> list[dict]:
    init_db()
    seit = auth.account_since(user.username)
    if seit is None:
        return []
    wo, args = _search(q)
    if dataset_id is not None:
        wo += " AND c.dataset_id=?"
        args.append(dataset_id)
    with _conn() as c:
        rows = c.execute(f"SELECT {_CONV_FIELDS} FROM conversations c WHERE c.username=? "
                         f"AND c.account_since=?{wo} ORDER BY c.updated_at DESC LIMIT ?",
                         [user.username, seit, *args, max(1, min(limit, LIST_LIMIT))]).fetchall()
    return [dict(r) for r in rows]


def list_all(q: str | None = None, username: str | None = None,
             limit: int = LIST_LIMIT) -> list[dict]:
    init_db()
    wo, args = _search(q)
    if username:
        wo += " AND c.username=?"
        args.append(username.strip().lower())
    with _conn() as c:
        rows = c.execute(
            f"SELECT {_CONV_FIELDS}, (u.created_at IS NULL OR u.created_at IS NOT c.account_since) "
            f"AS earlier_account FROM conversations c LEFT JOIN users u ON u.username=c.username "
            f"WHERE 1=1{wo} ORDER BY c.updated_at DESC LIMIT ?",
            [*args, max(1, min(limit, LIST_LIMIT))]).fetchall()
    return [{**dict(r), "earlier_account": bool(r["earlier_account"])} for r in rows]


def _turn_summary(row: sqlite3.Row) -> dict:
    rec = json.loads(row["record"] or "{}")
    res = rec.get("result") or {}
    return {"id": row["id"], "seq": row["seq"], "asked_at": row["asked_at"],
            "finished_at": row["finished_at"], "question": row["question"],
            "answer": row["answer"], "status": row["status"], "error": row["error"],
            "model": row["model"], "provider": row["provider"],
            "provider_host": row["provider_host"], "grounding": row["grounding_mode"],
            "ungrounded": json.loads(row["ungrounded"] or "[]"),
            "corrected": bool(res.get("corrected")), "own_key": bool(res.get("own_key")),
            "steps": res.get("steps"), "evidence": rec.get("evidence") or [],
            "check": res.get("check"), "findings": rec.get("findings") or []}


def conversation(conversation_id: str) -> dict | None:
    row = _conversation_row(conversation_id)
    if row is None:
        return None
    with _conn() as c:
        turns = c.execute("SELECT * FROM conversation_turns WHERE conversation_id=? ORDER BY seq",
                          (conversation_id,)).fetchall()
    return {"conversation": {k: row[k] for k in ("id", "username", "dataset_id", "title",
                                                  "created_at", "updated_at", "n_turns")},
            "owner_row": dict(row),
            "turns": [_turn_summary(t) for t in turns]}


def turn(turn_id: int) -> dict | None:
    init_db()
    with _conn() as c:
        t = c.execute("SELECT * FROM conversation_turns WHERE id=?", (turn_id,)).fetchone()
        if t is None:
            return None
        conv = c.execute("SELECT * FROM conversations WHERE id=?",
                         (t["conversation_id"],)).fetchone()
        rec = json.loads(t["record"] or "{}")
        for e in rec.get("events") or []:
            if e.get("kind") == "prompt" and e.get("system_prompt_sha256"):
                p = c.execute("SELECT text FROM prompt_texts WHERE sha256=?",
                              (e["system_prompt_sha256"],)).fetchone()
                e["system_prompt"] = p["text"] if p else None
    out = _turn_summary(t)
    out.update({"conversation_id": t["conversation_id"], "record": rec,
                "conversation": {k: conv[k] for k in ("id", "username", "dataset_id", "title")}})
    return {"turn": out, "owner_row": dict(conv)}

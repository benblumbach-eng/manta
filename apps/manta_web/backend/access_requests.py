from __future__ import annotations

import re
import sqlite3
import time

import auth

STATUS = ("open", "approved", "rejected")

LIMITS = {"full_name": 120, "email": 200, "institution": 160, "topic": 60,
          "wanted_username": 60, "reason": 2000}

MAX_PER_IP = 3
MAX_TOTAL = 20
RATE_WINDOW = 3600.0
MAX_OPEN = 100

_HITS: dict[str, list[float]] = {}


class RateLimited(Exception):
    pass



def _conn() -> sqlite3.Connection:
    auth.DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(auth.DB_PATH, timeout=10)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA journal_mode=WAL")
    return c


def init_db() -> None:
    auth.init_db()
    with _conn() as c:
        c.execute("""CREATE TABLE IF NOT EXISTS access_requests (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at      REAL NOT NULL,
            full_name       TEXT NOT NULL,
            email           TEXT NOT NULL,
            institution     TEXT NOT NULL DEFAULT '',
            topic           TEXT NOT NULL DEFAULT '',
            wanted_username TEXT NOT NULL DEFAULT '',
            reason          TEXT NOT NULL DEFAULT '',
            status          TEXT NOT NULL DEFAULT 'open',
            decided_at      REAL,
            decided_by      TEXT,
            note            TEXT NOT NULL DEFAULT '',
            created_user    TEXT,
            mail_status     TEXT NOT NULL DEFAULT '',
            mail_to         TEXT NOT NULL DEFAULT '')""")
        c.execute("CREATE INDEX IF NOT EXISTS ar_status ON access_requests(status, created_at)")
        c.execute("""CREATE TABLE IF NOT EXISTS request_routes (
            topic  TEXT PRIMARY KEY,
            label  TEXT NOT NULL DEFAULT '',
            email  TEXT NOT NULL,
            sort   INTEGER NOT NULL DEFAULT 0)""")



def list_routes() -> list[dict]:
    init_db()
    with _conn() as c:
        return [dict(r) for r in c.execute(
            "SELECT topic,label,email,sort FROM request_routes ORDER BY sort, topic")]


def public_topics() -> list[dict]:
    return [{"key": r["topic"], "label": r["label"] or r["topic"]} for r in list_routes()]


def set_routes(routes: list[dict]) -> list[dict]:
    import mailer
    sauber = []
    for i, r in enumerate(routes or []):
        topic = _clean(r.get("topic"), LIMITS["topic"])
        email = _clean(r.get("email"), LIMITS["email"]).lower()
        if not topic:
            raise ValueError("jede Zuordnung braucht ein Thema")
        if not mailer.valid_email(email):
            raise ValueError(f"keine gueltige Adresse fuer {topic!r}: {email!r}")
        sauber.append((topic, _clean(r.get("label"), LIMITS["topic"]) or topic, email, i))
    if len({t for t, *_ in sauber}) != len(sauber):
        raise ValueError("dasselbe Thema kommt mehrfach vor")
    init_db()
    with _conn() as c:
        c.execute("DELETE FROM request_routes")
        c.executemany("INSERT INTO request_routes(topic,label,email,sort) VALUES (?,?,?,?)", sauber)
    return list_routes()


def recipients_for(topic: str) -> tuple[list[str], str]:
    import mailer
    sammel = mailer.default_recipients()
    zugeordnet = [r["email"] for r in list_routes() if r["topic"] == (topic or "").strip()]
    alle = list(dict.fromkeys(zugeordnet + sammel))
    herkunft = ("Thema + Sammeladresse" if zugeordnet and sammel else
                "Thema" if zugeordnet else "Sammeladresse" if sammel else "keine")
    return alle, herkunft



def _clean(value, limit: int) -> str:
    return re.sub(r"[\x00-\x1f\x7f]", " ", str(value or "")).strip()[:limit]


def _clean_text(value, limit: int) -> str:
    text = re.sub(r"\r\n?", "\n", str(value or ""))
    text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()[:limit]


def _rate_check(ip: str) -> None:
    now = time.time()
    for key in list(_HITS):
        _HITS[key] = [t for t in _HITS[key] if now - t < RATE_WINDOW]
        if not _HITS[key]:
            del _HITS[key]
    if len(_HITS.get(ip or "-", [])) >= MAX_PER_IP:
        raise RateLimited("zu viele Antraege von dieser Adresse, bitte spaeter erneut versuchen")
    if sum(len(v) for v in _HITS.values()) >= MAX_TOTAL:
        raise RateLimited("zu viele Antraege in kurzer Zeit, bitte spaeter erneut versuchen")


def _rate_note(ip: str) -> None:
    _HITS.setdefault(ip or "-", []).append(time.time())


def create(data: dict, ip: str = "") -> dict:
    import mailer
    _rate_check(ip)

    name = _clean(data.get("full_name"), LIMITS["full_name"])
    email = _clean(data.get("email"), LIMITS["email"]).lower()
    reason = _clean_text(data.get("reason"), LIMITS["reason"])
    if not name:
        raise ValueError("Bitte einen Namen angeben")
    if not mailer.valid_email(email):
        raise ValueError("Bitte eine gueltige E-Mail-Adresse angeben")
    if len(reason) < 10:
        raise ValueError("Bitte kurz begruenden, wofuer der Zugang gebraucht wird")

    wunsch = _clean(data.get("wanted_username"), LIMITS["wanted_username"]).lower()
    if wunsch and not re.fullmatch(r"[a-z0-9._-]{2,}", wunsch):
        raise ValueError("Wunsch-Benutzername: nur Buchstaben, Ziffern, Punkt, Strich, Unterstrich")

    topic = _clean(data.get("topic"), LIMITS["topic"])
    if topic and topic not in {r["topic"] for r in list_routes()}:
        raise ValueError("unbekanntes Thema")

    init_db()
    with _conn() as c:
        if c.execute("SELECT COUNT(*) FROM access_requests WHERE status='open'").fetchone()[0] >= MAX_OPEN:
            raise RateLimited("es liegen zu viele unbearbeitete Antraege vor")
        if c.execute("SELECT 1 FROM access_requests WHERE email=? AND status='open'",
                     (email,)).fetchone():
            raise ValueError("Fuer diese Adresse liegt bereits ein unbearbeiteter Antrag vor")
        cur = c.execute(
            "INSERT INTO access_requests(created_at,full_name,email,institution,topic,"
            "wanted_username,reason) VALUES (?,?,?,?,?,?,?)",
            (time.time(), name, email, _clean(data.get("institution"), LIMITS["institution"]),
             topic, wunsch, reason))
        rid = cur.lastrowid
    _rate_note(ip)
    return get(rid)


def set_mail_result(request_id: int, status: str, to: list[str]) -> None:
    with _conn() as c:
        c.execute("UPDATE access_requests SET mail_status=?, mail_to=? WHERE id=?",
                  (status[:300], ", ".join(to), request_id))


def get(request_id: int) -> dict | None:
    with _conn() as c:
        row = c.execute("SELECT * FROM access_requests WHERE id=?", (request_id,)).fetchone()
    return dict(row) if row else None


def list_requests(status: str | None = None) -> list[dict]:
    init_db()
    q = "SELECT * FROM access_requests"
    args: tuple = ()
    if status:
        q += " WHERE status=?"
        args = (status,)
    q += " ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, created_at ASC"
    with _conn() as c:
        return [dict(r) for r in c.execute(q, args)]


def count_open() -> int:
    init_db()
    with _conn() as c:
        return c.execute("SELECT COUNT(*) FROM access_requests WHERE status='open'").fetchone()[0]


def approve(request_id: int, username: str, password: str, role: str, by: str) -> dict:
    req = get(request_id)
    if not req:
        raise ValueError(f"unbekannter Antrag {request_id}")
    if req["status"] != "open":
        raise ValueError(f"Antrag {request_id} ist bereits {req['status']}")
    u = auth.create_user(username, password, role)
    with _conn() as c:
        c.execute("UPDATE access_requests SET status='approved', decided_at=?, decided_by=?, "
                  "created_user=? WHERE id=?", (time.time(), by, u.username, request_id))
    return get(request_id)


def reject(request_id: int, note: str, by: str) -> dict:
    req = get(request_id)
    if not req:
        raise ValueError(f"unbekannter Antrag {request_id}")
    if req["status"] != "open":
        raise ValueError(f"Antrag {request_id} ist bereits {req['status']}")
    with _conn() as c:
        c.execute("UPDATE access_requests SET status='rejected', decided_at=?, decided_by=?, "
                  "note=? WHERE id=?", (time.time(), by, _clean_text(note, 500), request_id))
    return get(request_id)


def delete(request_id: int) -> None:
    with _conn() as c:
        n = c.execute("DELETE FROM access_requests WHERE id=?", (request_id,)).rowcount
    if not n:
        raise ValueError(f"unbekannter Antrag {request_id}")



def notification(req: dict, base_url: str = "") -> tuple[str, str]:
    zeilen = [
        "Ein neuer Zugangsantrag fuer MANTA liegt vor.",
        "",
        f"Name:        {req['full_name']}",
        f"E-Mail:      {req['email']}",
    ]
    if req["institution"]:
        zeilen.append(f"Einrichtung: {req['institution']}")
    if req["topic"]:
        zeilen.append(f"Thema:       {req['topic']}")
    if req["wanted_username"]:
        zeilen.append(f"Wunschname:  {req['wanted_username']}")
    zeilen += ["", "Begruendung:", req["reason"], ""]
    if base_url:
        zeilen += [f"Direkt zum Antrag: {link(base_url, req['id'])}", ""]
    zeilen += ["Diese Mail ist nur die Benachrichtigung; der Antrag selbst liegt in der "
               "Datenbank und geht nicht verloren."]
    return (f"[MANTA] Zugangsantrag von {req['full_name']}", "\n".join(zeilen))


def link(base_url: str, request_id: int) -> str:
    return f"{(base_url or '').rstrip('/')}/?request={request_id}"


def decision_note(req: dict, approved: bool) -> tuple[str, str]:
    if approved:
        text = ["Ihr Zugang zu MANTA wurde eingerichtet.", "",
                f"Benutzername: {req['created_user']}", "",
                "Das Passwort erhalten Sie auf einem anderen Weg — per Mail wird es "
                "grundsaetzlich nicht verschickt."]
        return ("[MANTA] Ihr Zugang wurde eingerichtet", "\n".join(text))
    text = ["Ihr Zugangsantrag fuer MANTA wurde abgelehnt."]
    if req["note"]:
        text += ["", f"Begruendung: {req['note']}"]
    return ("[MANTA] Ihr Zugangsantrag", "\n".join(text))

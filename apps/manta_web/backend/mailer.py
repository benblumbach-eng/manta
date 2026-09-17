from __future__ import annotations

import os
import re
import smtplib
import ssl
from email.message import EmailMessage
from email.utils import formatdate

EMAIL_RE = re.compile(r"^[^@\s,;<>\"]+@[^@\s,;<>\"]+\.[A-Za-z]{2,}$")

TIMEOUT = float(os.environ.get("MANTA_SMTP_TIMEOUT", "10"))


def valid_email(addr: str) -> bool:
    return bool(EMAIL_RE.match((addr or "").strip()))


def _env(name: str, default: str = "") -> str:
    try:
        import settings
        key = settings.ENV_TO_KEY.get(name)
        if key is not None:
            return (settings.get(key) or default).strip()
    except Exception:
        pass
    return (os.environ.get(name) or default).strip()


def configured() -> bool:
    return bool(_env("MANTA_SMTP_HOST"))


def default_recipients() -> list[str]:
    raw = _env("MANTA_REQUEST_MAILTO")
    return [a for a in (p.strip() for p in re.split(r"[,;]", raw)) if valid_email(a)]


def sender() -> str:
    return _env("MANTA_MAIL_FROM") or "manta@localhost"


def status_summary() -> dict:
    return {"configured": configured(), "sender": sender() if configured() else None,
            "collect_to": default_recipients()}


def _header(value: str) -> str:
    return re.sub(r"[\r\n]+", " ", (value or "").strip())[:200]


def send(subject: str, body: str, to: list[str], reply_to: str | None = None) -> str:
    if not configured():
        return "disabled"
    empfaenger = [a for a in dict.fromkeys(a.strip() for a in to) if valid_email(a)]
    if not empfaenger:
        return "error: keine gueltige Empfaengeradresse konfiguriert"

    msg = EmailMessage()
    msg["Subject"] = _header(subject)
    msg["From"] = sender()
    msg["To"] = ", ".join(empfaenger)
    msg["Date"] = formatdate(localtime=True)
    if reply_to and valid_email(reply_to):
        msg["Reply-To"] = _header(reply_to)
    msg.set_content(body)

    host = _env("MANTA_SMTP_HOST")
    mode = (_env("MANTA_SMTP_TLS", "starttls") or "starttls").lower()
    user, password = _env("MANTA_SMTP_USER"), os.environ.get("MANTA_SMTP_PASSWORD") or ""
    try:
        port = int(_env("MANTA_SMTP_PORT", "587") or 587)
        if mode == "ssl":
            srv = smtplib.SMTP_SSL(host, port, timeout=TIMEOUT, context=ssl.create_default_context())
        else:
            srv = smtplib.SMTP(host, port, timeout=TIMEOUT)
        with srv:
            srv.ehlo()
            if mode == "starttls":
                srv.starttls(context=ssl.create_default_context())
                srv.ehlo()
            if user:
                srv.login(user, password)
            srv.send_message(msg)
    except Exception as e:
        return f"error: {type(e).__name__}: {e}"[:300]
    return "sent"

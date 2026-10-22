from __future__ import annotations

import math
import os
import re
import shutil
import statistics
import sys
import tempfile
import time
from contextlib import asynccontextmanager, contextmanager
from datetime import datetime, timezone
from pathlib import Path

from fastapi import (Depends, FastAPI, File, Form, Header, HTTPException, Query, Request,
                     Response, UploadFile)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool
from neo4j import GraphDatabase, unit_of_work
from neo4j.exceptions import Neo4jError
from pydantic import BaseModel, Field, field_validator

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "manta_mcp"))

import access
import anwendbarkeit
import access_requests
import agent
import audit
import auth
import import_job
import mailer
import otter_estimate
import settings
import semantics
import transcripts

NEO4J_URI = os.environ.get("NEO4J_URI", "bolt://localhost:7687")
NEO4J_USER = os.environ.get("NEO4J_USER", "neo4j")
NEO4J_PASSWORD = os.environ.get("NEO4J_PASSWORD", "")
QUERY_TIMEOUT_S = float(os.environ.get("MANTA_QUERY_TIMEOUT", "120"))

STATION_COORDS = {"F4": [6.9648, 79.0118], "MVCO": [-70.5667, 41.325]}

_driver = None


def driver():
    global _driver
    if _driver is None:
        if not NEO4J_PASSWORD:
            raise RuntimeError("NEO4J_PASSWORD is not set.")
        _driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD),
                                       notifications_disabled_categories=["UNRECOGNIZED", "DEPRECATION"],
                                       max_transaction_retry_time=5)
    return _driver


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield
    global _driver
    if _driver is not None:
        _driver.close()
        _driver = None


app = FastAPI(title="MANTA Web API", version="0.1", lifespan=lifespan)
_ORIGINS = [o.strip() for o in os.environ.get(
    "MANTA_ALLOWED_ORIGINS", "http://localhost:5173,http://localhost:8080").split(",") if o.strip()]
app.add_middleware(CORSMiddleware, allow_origins=_ORIGINS,
                   allow_methods=["*"], allow_headers=["*"], allow_credentials=True)

TAXONOMY = semantics.TAXONOMY_RANKS
CENTRALITIES = ["ccm_betweenness", "ccm_closeness", "con_betweenness", "con_closeness"]

OTTER_DEFAULTS = semantics.OTTER_DEFAULTS
PRODUCTION_DEFAULTS = semantics.PRODUCTION_DEFAULTS
THRESHOLD_KEYS = semantics.THRESHOLD_KEYS


SAMPLE_ORDER = "date, same_day_index, ordinal_index, sample_id"


def _q(query, **params):
    @unit_of_work(timeout=QUERY_TIMEOUT_S)
    def _read_rows(tx):
        return [r.data() for r in tx.run(query, params)]

    try:
        with driver().session(default_access_mode="READ") as s:
            return s.execute_read(_read_rows)
    except Neo4jError as e:
        if "TransactionTimedOut" in (e.code or ""):
            raise HTTPException(503, f"The database query ran longer than {QUERY_TIMEOUT_S:g} s "
                                     f"and was stopped by the database.") from e
        raise


def _w(query, **params):
    with driver().session(default_access_mode="WRITE") as s:
        return [r.data() for r in s.run(query, **params)]


@app.get("/health")
def health():
    try:
        driver().verify_connectivity()
        return {"ok": True}
    except Exception as e:
        raise HTTPException(503, f"neo4j unreachable: {e}")



PUBLIC_PATHS = {"/health", "/auth/login", "/auth/logout", "/auth/me", "/agent/status", "/datasets",
                "/signup", "/signup/options",
                "/agent/tools",
                "/concepts"}


def visible_dataset(dataset_id: str, user: auth.User | None = Depends(auth.anyone)) -> str:
    rows = _q("MATCH (d:Dataset {dataset_id:$d}) WHERE " + access.cypher_condition("d") +
              " RETURN d.dataset_id AS id", d=dataset_id)
    if not rows:
        raise HTTPException(404, f"unknown dataset_id {dataset_id!r}")
    return dataset_id


class LoginRequest(BaseModel):
    username: str = Field(max_length=auth.MAX_USERNAME_LEN)
    password: str = Field(max_length=auth.MAX_PASSWORD_LEN)


@app.post("/auth/login")
def auth_login(req: LoginRequest, request: Request, response: Response):
    try:
        token = auth.login(req.username, req.password, ip=_client_ip(request))
    except auth.TooManyAttempts as e:
        raise HTTPException(429, str(e)) from e
    except PermissionError as e:
        raise HTTPException(401, str(e)) from e
    auth.set_cookie(response, token, auth.cookie_secure(request))
    u = auth.resolve(token)
    return {"username": u.username, "role": u.role}


@app.post("/auth/logout")
def auth_logout(request: Request, response: Response):
    tok = request.cookies.get(auth.COOKIE_NAME)
    if tok:
        auth.revoke(tok)
    auth.clear_cookie(response, auth.cookie_secure(request))
    return {"ok": True}


@app.get("/auth/me")
async def auth_me(user: auth.User | None = Depends(auth.anyone)):
    if user is None:
        return {"username": None, "role": "guest", "can_see_internal": False}
    return {"username": user.username, "role": user.role, "can_see_internal": True}



class NewUser(BaseModel):
    username: str
    password: str
    role: str = "viewer"


class UserPatch(BaseModel):
    password: str | None = None
    role: str | None = None
    disabled: bool | None = None


@app.get("/admin/users", dependencies=[Depends(auth.admin)])
def admin_users():
    return {"users": auth.list_users(), "roles": list(auth.ROLES),
            "visibilities": list(access.VISIBILITIES),
            "min_password_len": auth.MIN_PASSWORD_LEN}


@app.post("/admin/users", dependencies=[Depends(auth.admin)])
def admin_create_user(req: NewUser):
    try:
        u = auth.create_user(req.username, req.password, req.role)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return {"username": u.username, "role": u.role}


@app.patch("/admin/users/{username}")
def admin_patch_user(username: str, patch: UserPatch, me: auth.User = Depends(auth.admin)):
    username = username.strip().lower()
    entzug = (patch.role is not None and patch.role != "admin") or patch.disabled is True
    if entzug and username == me.username:
        raise HTTPException(400, "You cannot take away your own rights here.")
    try:
        auth.update_user(username, password=patch.password, role=patch.role,
                         disabled=patch.disabled)
    except auth.UnknownUser as e:
        raise HTTPException(404, str(e)) from e
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return {"ok": True, "username": username}


@app.delete("/admin/users/{username}")
def admin_delete_user(username: str, me: auth.User = Depends(auth.admin)):
    username = username.strip().lower()
    if username == me.username:
        raise HTTPException(400, "You cannot delete your own account here.")
    try:
        auth.delete_user(username)
    except auth.UnknownUser as e:
        raise HTTPException(404, str(e)) from e
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    try:
        _w("MATCH (s:Star {username:$u}) DELETE s", u=username)
        _w("MATCH (n:Note {username:$u}) DELETE n", u=username)
        aufgeraeumt = True
    except Exception:
        aufgeraeumt = False
    audit.note(me.username, "account deleted", username)
    return {"deleted": username, "stars_and_notes_removed": aufgeraeumt}


@app.post("/admin/users/{username}/revoke", dependencies=[Depends(auth.admin)])
def admin_revoke_sessions(username: str):
    return {"revoked": auth.revoke_all(username)}



class MailSettings(BaseModel):
    smtp_host: str | None = None
    smtp_port: str | None = None
    smtp_tls: str | None = None
    smtp_user: str | None = None
    smtp_password: str | None = None
    mail_from: str | None = None
    request_mailto: str | None = None
    public_url: str | None = None


class SettingKeys(BaseModel):
    keys: list[str]


class MailTest(BaseModel):
    to: str


@app.get("/admin/status", dependencies=[Depends(auth.admin)])
def admin_status():
    try:
        driver().verify_connectivity()
        db = {"ok": True, "detail": "reachable"}
    except Exception as e:
        db = {"ok": False, "detail": f"{type(e).__name__}: {e}"[:200]}

    post = mailer.status_summary()
    empfaenger = post.get("collect_to") or []
    mail = {"ok": bool(post.get("configured") and empfaenger),
            "detail": ("sending as " + str(post.get("sender")) + " to " + ", ".join(empfaenger))
                      if post.get("configured") and empfaenger
                      else "configured, but no recipient" if post.get("configured")
                      else "no mail server configured"}

    try:
        modell = agent.available()
        assistent = {"ok": bool(modell.get("ok")),
                     "detail": modell.get("detail") or modell.get("error") or
                               ("model ready" if modell.get("ok") else "no usable model")}
        if not assistent["ok"] and modell.get("setup_hint"):
            assistent["detail"] += " " + modell["setup_hint"]
    except Exception as e:
        assistent = {"ok": False, "detail": f"{type(e).__name__}: {e}"[:200]}

    werkzeuge = import_job.tool_status()
    fehlend = sorted({w for eintrag in werkzeuge["entries"].values() for w in eintrag["missing"]})
    analyse = {"ok": not fehlend,
               "detail": "all present" if not fehlend else "missing: " + ", ".join(fehlend)}

    zeilen = {"database": db, "mail": mail, "assistant": assistent, "analysis_tools": analyse}
    return {"checks": zeilen, "ok": all(z["ok"] for z in zeilen.values())}


@app.get("/admin/settings/mail", dependencies=[Depends(auth.admin)])
def admin_mail_settings():
    return settings.view()


@app.put("/admin/settings/mail")
def admin_set_mail_settings(patch: MailSettings, me: auth.User = Depends(auth.admin)):
    werte = {k: v for k, v in patch.model_dump().items() if v is not None}
    if not werte:
        raise HTTPException(400, "nothing to save")
    try:
        antwort = settings.set_many(werte, by=me.username)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    audit.note(me.username, "mail settings changed", ", ".join(sorted(werte)))
    return antwort


@app.post("/admin/settings/mail/reset")
def admin_reset_mail_settings(body: SettingKeys, me: auth.User = Depends(auth.admin)):
    try:
        antwort = settings.reset(body.keys, by=me.username)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    audit.note(me.username, "mail settings reset", ", ".join(sorted(body.keys)))
    return antwort


class AgentSettings(BaseModel):
    ollama_model: str | None = None
    grounding: str | None = None
    openai_base_url: str | None = None
    openai_api_key: str | None = None
    openai_models: str | None = None
    openai_timeout: str | None = None
    provider_hosts: str | None = None
    admins_read_transcripts: str | None = None


@app.get("/admin/settings/agent", dependencies=[Depends(auth.admin)])
def admin_agent_settings():
    return settings.view()


@app.put("/admin/settings/agent")
def admin_set_agent_settings(patch: AgentSettings, me: auth.User = Depends(auth.admin)):
    werte = {k: v for k, v in patch.model_dump().items() if v is not None}
    if not werte:
        raise HTTPException(400, "nothing to save")
    try:
        antwort = settings.set_many(werte, by=me.username)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    audit.note(me.username, "assistant settings changed", ", ".join(sorted(werte)))
    return antwort


@app.post("/admin/settings/agent/reset")
def admin_reset_agent_settings(body: SettingKeys, me: auth.User = Depends(auth.admin)):
    try:
        antwort = settings.reset(body.keys, by=me.username)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    audit.note(me.username, "assistant settings reset", ", ".join(sorted(body.keys)))
    return antwort


@app.get("/admin/audit", dependencies=[Depends(auth.admin)])
def admin_audit():
    return {"entries": audit.entries()}


@app.post("/admin/settings/mail/test", dependencies=[Depends(auth.admin)])
def admin_test_mail(body: MailTest):
    ziel = (body.to or "").strip()
    if not mailer.valid_email(ziel):
        raise HTTPException(400, f"not a valid address: {ziel or '(empty)'}")
    status = mailer.send("MANTA: test message",
                         "This is a test message from the MANTA admin panel.\n"
                         "If you received it, the mail settings work.\n", [ziel])
    return {"status": status, "to": ziel}



class SignupRequest(BaseModel):
    full_name: str
    email: str
    reason: str
    institution: str = ""
    topic: str = ""
    wanted_username: str = ""
    website: str = ""


class ApproveRequest(BaseModel):
    username: str
    password: str
    role: str = "viewer"
    notify: bool = True


class RejectRequest(BaseModel):
    note: str = ""
    notify: bool = False


class RouteList(BaseModel):
    routes: list[dict]


def _public_base(request: Request) -> str:
    del request
    return (settings.get("public_url") or "").strip().rstrip("/")


def _client_ip(request: Request) -> str:
    xff = request.headers.get("x-forwarded-for", "")
    if xff:
        return xff.split(",")[0].strip()[:64]
    return (request.client.host if request.client else "")[:64]


@app.get("/signup/options")
def signup_options():
    empfaenger, _ = access_requests.recipients_for("")
    return {"topics": access_requests.public_topics(),
            "mail_configured": mailer.configured() and bool(empfaenger)}


@app.post("/signup")
def signup(req: SignupRequest, request: Request):
    if req.website.strip():
        return {"ok": True, "id": None}
    try:
        antrag = access_requests.create(req.model_dump(exclude={"website"}), _client_ip(request))
    except access_requests.RateLimited as e:
        raise HTTPException(429, str(e)) from e
    except ValueError as e:
        raise HTTPException(400, str(e)) from e

    empfaenger, herkunft = access_requests.recipients_for(antrag["topic"])
    try:
        betreff, text = access_requests.notification(antrag, _public_base(request))
        status = mailer.send(betreff, text, empfaenger, reply_to=antrag["email"])
    except Exception as e:
        status = f"error: {type(e).__name__}: {e}"[:300]
    access_requests.set_mail_result(antrag["id"], status, empfaenger)
    return {"ok": True, "id": antrag["id"], "routed": herkunft}


@app.get("/admin/requests", dependencies=[Depends(auth.admin)])
def admin_requests():
    return {"requests": access_requests.list_requests(),
            "routes": access_requests.list_routes(),
            "roles": list(auth.ROLES),
            "mail": mailer.status_summary()}


@app.post("/admin/requests/{request_id}/approve")
def admin_approve_request(request_id: int, req: ApproveRequest,
                          me: auth.User = Depends(auth.admin)):
    try:
        antrag = access_requests.approve(request_id, req.username, req.password, req.role,
                                         me.username)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    mail = "skipped"
    if req.notify:
        betreff, text = access_requests.decision_note(antrag, approved=True)
        mail = mailer.send(betreff, text, [antrag["email"]])
    return {"request": antrag, "mail": mail}


@app.post("/admin/requests/{request_id}/reject")
def admin_reject_request(request_id: int, req: RejectRequest,
                         me: auth.User = Depends(auth.admin)):
    try:
        antrag = access_requests.reject(request_id, req.note, me.username)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    mail = "skipped"
    if req.notify:
        betreff, text = access_requests.decision_note(antrag, approved=False)
        mail = mailer.send(betreff, text, [antrag["email"]])
    return {"request": antrag, "mail": mail}


@app.delete("/admin/requests/{request_id}", dependencies=[Depends(auth.admin)])
def admin_delete_request(request_id: int):
    try:
        access_requests.delete(request_id)
    except ValueError as e:
        raise HTTPException(404, str(e)) from e
    return {"deleted": request_id}


@app.put("/admin/request-routes", dependencies=[Depends(auth.admin)])
def admin_set_routes(body: RouteList):
    try:
        return {"routes": access_requests.set_routes(body.routes)}
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


class VisibilityPatch(BaseModel):
    visibility: str


@app.put("/datasets/{dataset_id}/visibility",
         dependencies=[Depends(auth.admin), Depends(visible_dataset)])
def set_visibility(dataset_id: str, patch: VisibilityPatch, me: auth.User = Depends(auth.admin)):
    v = access.normalise(patch.visibility)
    if v != patch.visibility.strip().lower():
        raise HTTPException(400, f"unknown visibility {patch.visibility!r}, "
                                 f"allowed: {list(access.VISIBILITIES)}")
    with _exclusive(dataset_id, "a visibility change"):
        rows = _w("MATCH (d:Dataset {dataset_id:$d}) SET d.visibility=$v "
                  "RETURN d.dataset_id AS dataset_id, d.visibility AS visibility",
                  d=dataset_id, v=v)
    if not rows:
        raise HTTPException(404, f"unknown dataset_id {dataset_id!r}")
    audit.note(me.username, "visibility changed", f"{dataset_id} -> {v}")
    return rows[0]


class ImportRequest(BaseModel):
    dataset_id: str
    marker: str = "18S"
    region: str = "Imported dataset"
    station: str | None = None
    lat: float | None = None
    lon: float | None = None



def _require_free_dataset_id(dataset_id: str, replace: bool) -> None:
    if not dataset_id or not dataset_id.strip():
        raise HTTPException(422, "dataset_id must not be empty")
    rows = _q("MATCH (d:Dataset {dataset_id:$d}) RETURN d.region AS region", d=dataset_id)
    if rows and not replace:
        raise HTTPException(409, f"The name {dataset_id!r} is already taken "
                                 f"({rows[0]['region']!r}). Choose another name or delete the "
                                 f"existing dataset first.")


DATASET_ID_RE = re.compile(r"[a-z0-9_]{3,64}")


def _check_new_dataset(dataset_id: str, region: str | None, marker: str | None) -> None:
    if not DATASET_ID_RE.fullmatch(dataset_id or ""):
        raise HTTPException(422, "dataset_id: 3 to 64 characters, lower-case letters, digits "
                                 "and underscore only")
    region = (region or "").strip()
    if not region or len(region) > MAX_REGION_CHARS or any(ch < " " for ch in region):
        raise HTTPException(422, f"region must be 1 to {MAX_REGION_CHARS} characters without "
                                 f"line breaks")
    if not (marker or "").strip() or len(marker) > 20 or any(ch < " " for ch in marker):
        raise HTTPException(422, "marker must be a short name such as 18S or 16S")


def _reserve(dataset_id: str, what: str) -> None:
    try:
        import_job.reserve(dataset_id, what)
    except import_job.DatasetBusy as e:
        raise HTTPException(409, str(e)) from e


@contextmanager
def _exclusive(dataset_id: str, what: str):
    _reserve(dataset_id, what)
    try:
        yield
    finally:
        import_job.release(dataset_id)


def _replace_hook(dataset_id: str, replace: bool, who: str):
    if not replace:
        return None

    def wipe():
        alt = _q("MATCH (d:Dataset {dataset_id:$d}) RETURN d.visibility AS visibility",
                 d=dataset_id)
        _w("MATCH (n {dataset_id:$d}) DETACH DELETE n", d=dataset_id)
        if not alt:
            return None
        audit.note(who, "dataset replaced (old data deleted)", dataset_id)
        sichtbar = alt[0]["visibility"]

        def zurueck():
            if sichtbar:
                _w("MATCH (d:Dataset {dataset_id:$d}) SET d.visibility = $v",
                   d=dataset_id, v=sichtbar)
        return zurueck
    return wipe


MIN_SAMPLES_FOR_NETWORK = 8

MAX_REGION_CHARS = 200
MAX_NOTE_CHARS = 20_000

LIMITS = {"ncores_max": 64, "fft_coeffs_max": 64,
          "num_permutations_max": 10_000, "num_samples_max": 10_000,
          "note_max_chars": MAX_NOTE_CHARS, "region_max_chars": MAX_REGION_CHARS}

DEFAULT_PRIMERS = {
    "18S": ("GCGGTAATTCCAGCTCCAA", "ACTTTCGTTCTTGATYRR"),
    "16S": ("CCTACGGGNGGCWGCAG", "GACTACHVGGGTATCTAATCC"),
}


@app.post("/import", dependencies=[Depends(auth.admin)])
def start_import(req: ImportRequest, replace: bool = Query(False),
                 me: auth.User = Depends(auth.admin)):
    if (req.lat is None) != (req.lon is None):
        raise HTTPException(400, "lat and lon must be given together")
    if req.lat is not None and not (-90 <= req.lat <= 90 and -180 <= req.lon <= 180):
        raise HTTPException(400, f"implausible coordinate lat={req.lat}, lon={req.lon}")
    _check_new_dataset(req.dataset_id, req.region, req.marker)
    _reserve(req.dataset_id, "an import request")
    try:
        _require_free_dataset_id(req.dataset_id, replace)
        _require_tools("dada2")
        if not import_job.ensure_fixture():
            raise HTTPException(400, import_job.NO_INPUT)
        try:
            job_id = import_job.start_import(
                req.dataset_id, marker=req.marker, region=req.region, station=req.station,
                lat=req.lat, lon=req.lon, reserved=True,
                replace_wipe=_replace_hook(req.dataset_id, replace, me.username))
        except ValueError as e:
            raise HTTPException(400, str(e)) from e
    except BaseException:
        import_job.release(req.dataset_id)
        raise
    audit.note(me.username, "dataset import started",
               f"{req.dataset_id} (demo fixture){' replace' if replace else ''} job={job_id}")
    return {"job_id": job_id, "dataset_id": req.dataset_id}


RDATA_SUFFIXE = {".rdata", ".rda"}
FASTA_SUFFIXE = {".fa", ".fasta", ".fna"}


def _sieht_nach_dada2_aus(names: set[str]) -> bool:
    endungen = [Path(n).suffix.lower() for n in names]
    return (sum(e in RDATA_SUFFIXE or e == ".csv" for e in endungen) >= 2
            and any(e in FASTA_SUFFIXE for e in endungen))

REQUIRED_UPLOAD_TABLES = {"abundance.csv", "taxa_info.csv", "environment_info.csv"}

REQUIRED_UPLOAD_OTTER_OUT = {"abundance.csv", "environment_info.csv"}
OTTER_OUT_MANIFEST = "manta_manifest.json"
OTTER_OUT_FALLBACK_TABLES = {
    "enriched": "PyTest_Hellinger_False_14_Enriched_Hellinger_14_complete_network_table_meta_CON_CCM.csv",
    "con": "PyTest_Hellinger_False_14_Pearson_FFT__complete_network_table_0.7_0.05.csv",
    "pruned": "PyTest_Hellinger_False_14_Pruned_CCM_CON_MAP_Network.csv",
}


def _upload_rows(tmp: Path, name: str) -> list[list[str]]:
    import csv as _csv
    try:
        with (tmp / name).open(newline="", encoding="utf-8-sig") as fh:
            return [r for r in _csv.reader(fh, delimiter=";") if r]
    except UnicodeDecodeError:
        raise HTTPException(400, f"{name} is not UTF-8 encoded — save it again as "
                                 f"'CSV UTF-8' and upload it once more") from None


FASTQ_PAIR_RE = re.compile(r"^(.+)_R([12])_001\.fastq\.gz$")

_BAD_UPLOAD_NAMES = {"", ".", ".."}


def _upload_name(filename: str | None) -> str | None:
    name = Path(filename or "").name
    if name in _BAD_UPLOAD_NAMES or "\\" in name:
        if not (filename or "").strip():
            return None
        raise HTTPException(400, f"unusable file name in the upload: {filename!r}")
    if name.startswith("."):
        return None
    return name


def _save_upload(src, ziel: Path) -> None:
    src.seek(0)
    with open(ziel, "wb") as out:
        shutil.copyfileobj(src, out, 1 << 20)


def _abundance_labels(tmp: Path) -> list[str]:
    ab = _upload_rows(tmp, "abundance.csv")
    if len(ab) < 2 or len(ab[0]) < 2:
        raise HTTPException(400, "abundance.csv is empty or not ';'-separated")
    return [r[0] for r in ab[1:]]


def _check_env_has_date(tmp: Path) -> None:
    env = _upload_rows(tmp, "environment_info.csv")
    if not env or (env[0][0] or "").strip() != "date":
        raise HTTPException(400, "environment_info.csv must start with a 'date' column")


_axis_from_labels = import_job.axis_from_labels


def _upload_axis(tmp: Path, labels: list[str]) -> str:
    unmoeglich = import_job.impossible_dates(labels)
    echte = sum(1 for s in labels if import_job.calendar_day(s))
    if unmoeglich and len(unmoeglich) + echte == len(labels):
        raise HTTPException(400, f"abundance.csv: {unmoeglich[0]!r} looks like a date but is "
                                 f"not a real calendar day"
                                 + (f" (and {len(unmoeglich) - 1} more)" if len(unmoeglich) > 1
                                    else ""))
    return "ordinal" if import_job.synthetic_dates(tmp) else _axis_from_labels(labels)


def _validate_tables_upload(tmp: Path) -> str:
    labels = _abundance_labels(tmp)
    if len(labels) < MIN_SAMPLES_FOR_NETWORK:
        raise HTTPException(400, f"abundance.csv has only {len(labels)} time points — a network "
                                 f"needs at least {MIN_SAMPLES_FOR_NETWORK}")
    asvs = [c for c in _upload_rows(tmp, "abundance.csv")[0][1:] if c]
    taxa_ids = {r[0] for r in _upload_rows(tmp, "taxa_info.csv")[1:]}
    if taxa_ids != set(asvs):
        raise HTTPException(400, "taxa_info.csv does not match abundance.csv: both must list "
                                 "exactly the same ASVs (OTTER contract)")
    _check_env_has_date(tmp)
    return _upload_axis(tmp, labels)


def _validate_otter_out_upload(tmp: Path) -> str:
    import json as _json
    names = {p.name for p in tmp.iterdir()}
    manifest_path = tmp / OTTER_OUT_MANIFEST
    if manifest_path.exists():
        try:
            manifest = _json.loads(manifest_path.read_text(encoding="utf-8-sig"))
        except ValueError:
            raise HTTPException(400, f"{OTTER_OUT_MANIFEST} is not valid JSON")
        if not isinstance(manifest, dict):
            raise HTTPException(400, f"{manifest_path.name} must be a JSON object that names "
                                     f"the network tables")
        for kind, fallback in OTTER_OUT_FALLBACK_TABLES.items():
            base = Path(str(manifest.get(kind) or fallback)).name
            if base not in names:
                raise HTTPException(400, f"network table '{kind}' is missing from the upload: {base} "
                                         f"(named in this run's {OTTER_OUT_MANIFEST})")
            manifest[kind] = str(tmp / base)
        manifest_path.write_text(_json.dumps(manifest, indent=2), encoding="utf-8")
    else:
        missing = [n for n in OTTER_OUT_FALLBACK_TABLES.values() if n not in names]
        if missing:
            raise HTTPException(400, f"without {OTTER_OUT_MANIFEST} the network tables must carry "
                                     f"their standard names; missing: {missing}")
    labels = _abundance_labels(tmp)
    _check_env_has_date(tmp)
    return _upload_axis(tmp, labels)


@app.post("/import/upload", dependencies=[Depends(auth.admin)])
async def start_import_upload(
    dataset_id: str = Form(...),
    region: str = Form("Uploaded dataset"),
    marker: str = Form("18S"),
    station: str | None = Form(None),
    lat: float | None = Form(None),
    lon: float | None = Form(None),
    replace: bool = Form(False),
    con_tr: float | None = Form(None),
    con_alpha: float | None = Form(None),
    ccmn_tr: float | None = Form(None),
    louvain_res: float | None = Form(None),
    fft_coeffs: int | None = Form(None),
    num_permutations: int | None = Form(None),
    num_samples: int | None = Form(None),
    files: list[UploadFile] = File(...),
    me: auth.User = Depends(auth.admin),
):
    _check_new_dataset(dataset_id, region, marker)
    _reserve(dataset_id, "an upload request")
    tmp: Path | None = None
    try:
        await run_in_threadpool(_require_free_dataset_id, dataset_id, replace)
        tmp = Path(tempfile.mkdtemp(prefix="manta_upload_"))
        for f in files:
            name = _upload_name(f.filename)
            if name:
                await run_in_threadpool(_save_upload, f.file, tmp / name)
        names = {p.name for p in tmp.iterdir()}
        has_otter_out = (OTTER_OUT_MANIFEST in names or
                         any(n in names for n in OTTER_OUT_FALLBACK_TABLES.values()))
        has_tables = not has_otter_out and REQUIRED_UPLOAD_TABLES <= names
        has_dada2 = _sieht_nach_dada2_aus(names)
        if has_tables and has_dada2:
            raise HTTPException(400, "both kinds of input uploaded at once — upload EITHER the "
                                     "DADA2 output (5 files) OR the OTTER tables (3 CSVs)")
        if not (has_otter_out or has_tables or has_dada2):
            raise HTTPException(400, f"required files are missing. Upload either DADA2 output "
                                     f"(abundance matrix and taxonomy as .Rdata or .csv, one FASTA, "
                                     f"optionally a sample;date .csv), "
                                     f"OTTER input "
                                     f"{sorted(REQUIRED_UPLOAD_TABLES)} or an OTTER result "
                                     f"(network tables + {sorted(REQUIRED_UPLOAD_OTTER_OUT)}, "
                                     f"ideally with {OTTER_OUT_MANIFEST}); "
                                     f"uploaded: {sorted(names)}")
        if (lat is None) != (lon is None):
            raise HTTPException(400, "lat and lon must be given together")
        if lat is not None and not (-90 <= lat <= 90 and -180 <= lon <= 180):
            raise HTTPException(400, f"implausible coordinate lat={lat}, lon={lon}")
        thresholds = {k: v for k, v in {
            "con_tr": con_tr, "con_alpha": con_alpha, "ccmn_tr": ccmn_tr,
            "louvain_res": louvain_res, "fft_coeffs": fft_coeffs,
            "num_permutations": num_permutations, "num_samples": num_samples}.items()
            if v is not None}
        if thresholds:
            _validate_thresholds({**PRODUCTION_DEFAULTS, **thresholds})
        if has_otter_out:
            if thresholds:
                raise HTTPException(400, "nothing is computed for an OTTER result — the run's "
                                         "thresholds are in its manta_manifest.json and cannot "
                                         "be changed here")
            missing = REQUIRED_UPLOAD_OTTER_OUT - names
            if missing:
                raise HTTPException(400, f"OTTER result recognised, but these files are missing: {sorted(missing)}")
            _require_tools("otterout")
            time_axis = await run_in_threadpool(_validate_otter_out_upload, tmp)
            job_id = import_job.start_import(dataset_id, marker=marker, region=region,
                                             otter_out_dir=tmp, station=station, lat=lat, lon=lon,
                                             time_axis=time_axis, reserved=True,
                                             replace_wipe=_replace_hook(dataset_id, replace,
                                                                        me.username))
        elif has_tables:
            _require_tools("tables")
            time_axis = await run_in_threadpool(_validate_tables_upload, tmp)
            _require_memory(*import_job.abundance_size(tmp), thresholds)
            job_id = import_job.start_import(dataset_id, marker=marker, region=region,
                                             tables_dir=tmp, station=station, lat=lat, lon=lon,
                                             time_axis=time_axis, thresholds=thresholds or None,
                                             reserved=True,
                                             replace_wipe=_replace_hook(dataset_id, replace,
                                                                        me.username))
        else:
            _require_tools("dada2")
            job_id = import_job.start_import(dataset_id, marker=marker, region=region, rdata_dir=tmp,
                                             station=station, lat=lat, lon=lon,
                                             thresholds=thresholds or None, reserved=True,
                                             replace_wipe=_replace_hook(dataset_id, replace,
                                                                        me.username))
    except BaseException:
        import_job.release(dataset_id)
        if tmp is not None:
            shutil.rmtree(tmp, ignore_errors=True)
        raise
    audit.note(me.username, "dataset import started",
               f"{dataset_id} (upload){' replace' if replace else ''} job={job_id}")
    return {"job_id": job_id, "dataset_id": dataset_id}


IMPORT_TOOLS_HINT = ("This MANTA instance contains only the interface and the API (as the Docker "
                     "installation does). Importing and recomputing need the local installation "
                     "described in the README.")


@app.get("/import/tools", dependencies=[Depends(auth.admin)])
def import_tools():
    return {**import_job.tool_status(), "hint": IMPORT_TOOLS_HINT, "limits": LIMITS}


def _require_memory(n_asv: int, n_samples: int, thresholds: dict | None) -> dict:
    t = thresholds or {}
    est = otter_estimate.estimate(n_asv, n_samples, t.get("num_permutations"),
                                  t.get("num_samples"))
    if not est["fits"]:
        raise HTTPException(422, est["refusal"])
    return est


def _require_tools(entry: str) -> None:
    st = import_job.tool_status()["entries"][entry]
    if not st["ok"]:
        raise HTTPException(503, f"Not possible on this instance — missing analysis tools: "
                                 f"{', '.join(st['missing'])}. {IMPORT_TOOLS_HINT}")


@app.get("/import/fastq/preflight", dependencies=[Depends(auth.admin)])
def fastq_preflight():
    import shutil as _sh
    import subprocess as _sp
    out = {"rscript": bool(_sh.which("Rscript")), "cutadapt": bool(_sh.which("cutadapt")),
           "dada2": False, "dada2_version": None}
    if out["rscript"]:
        try:
            r = _sp.run(["Rscript", "-e", 'cat(as.character(packageVersion("dada2")))'],
                        capture_output=True, text=True, timeout=90)
            if r.returncode == 0 and r.stdout.strip():
                out["dada2"] = True
                out["dada2_version"] = r.stdout.strip()
        except Exception:
            pass
    out["ok"] = out["rscript"] and out["cutadapt"] and out["dada2"]
    if not out["ok"]:
        missing = [k for k in ("rscript", "cutadapt", "dada2") if not out[k]]
        out["error"] = f"missing on this machine: {', '.join(missing)}"
    out["hinweis"] = ("DADA2 takes minutes to hours (24 samples ~20 min on a laptop) and "
                      "needs a lot of memory. On 8 GB, Neo4j can die meanwhile — so switch on "
                      "taxonomy only with a reference AND enough RAM.")
    return out


@app.post("/import/fastq", dependencies=[Depends(auth.admin)])
async def start_import_fastq(
    dataset_id: str = Form(...),
    region: str = Form("Uploaded FASTQ dataset"),
    marker: str = Form("18S"),
    station: str | None = Form(None),
    lat: float | None = Form(None),
    lon: float | None = Form(None),
    fwd_primer: str | None = Form(None),
    rev_primer: str | None = Form(None),
    trunc_f: int = Form(260),
    trunc_r: int = Form(210),
    maxee_f: float = Form(2.60),
    maxee_r: float = Form(2.10),
    min_overlap: int = Form(15),
    ncores: int = Form(4),
    taxonomy_ref: str | None = Form(None),
    con_tr: float = Form(PRODUCTION_DEFAULTS["con_tr"]),
    con_alpha: float = Form(PRODUCTION_DEFAULTS["con_alpha"]),
    ccmn_tr: float = Form(PRODUCTION_DEFAULTS["ccmn_tr"]),
    louvain_res: float = Form(PRODUCTION_DEFAULTS["louvain_res"]),
    fft_coeffs: int = Form(PRODUCTION_DEFAULTS["fft_coeffs"]),
    num_permutations: int = Form(PRODUCTION_DEFAULTS["num_permutations"]),
    num_samples: int = Form(PRODUCTION_DEFAULTS["num_samples"]),
    replace: bool = Form(False),
    files: list[UploadFile] = File(...),
    metadata: UploadFile | None = File(None),
    me: auth.User = Depends(auth.admin),
):
    _check_new_dataset(dataset_id, region, marker)
    if not 1 <= ncores <= LIMITS["ncores_max"]:
        raise HTTPException(422, f"ncores must be between 1 and {LIMITS['ncores_max']}.")
    if min(trunc_f, trunc_r, min_overlap) < 0 or min(maxee_f, maxee_r) <= 0:
        raise HTTPException(422, "trunc_f, trunc_r and min_overlap must not be negative, "
                                 "maxee_f and maxee_r must be greater than 0.")
    _reserve(dataset_id, "a FASTQ upload request")
    tmp: Path | None = None
    try:
        await run_in_threadpool(_require_free_dataset_id, dataset_id, replace)
        _require_tools("fastq")
        pre = await run_in_threadpool(fastq_preflight)
        if not pre["ok"]:
            raise HTTPException(503, f"FASTQ import is not possible on this machine — {pre['error']}")

        tmp = Path(tempfile.mkdtemp(prefix="manta_fastq_"))
        fq = tmp / "fastq"
        fq.mkdir()
        paare: dict[str, set[str]] = {}
        gewaehlt: list[tuple[UploadFile, str]] = []
        for f in files:
            name = _upload_name(f.filename)
            if not name:
                continue
            m = FASTQ_PAIR_RE.match(name)
            if m is None:
                if name.lower().endswith((".gz", ".fastq", ".fq")):
                    raise HTTPException(400, f"{name!r} does not follow the read-file pattern "
                                             f"<sample>_R1_001.fastq.gz / "
                                             f"<sample>_R2_001.fastq.gz that the DADA2 stage "
                                             f"reads")
                continue
            paare.setdefault(m.group(1), set()).add(m.group(2))
            gewaehlt.append((f, name))
        ohne_partner = sorted(k for k, v in paare.items() if v != {"1", "2"})
        if not paare or ohne_partner:
            raise HTTPException(400, "paired <sample>_R1_001.fastq.gz / _R2_001.fastq.gz files "
                                     "expected" + (f"; without partner: {ohne_partner[:10]}"
                                                   if ohne_partner else ""))
        n_r1 = len(paare)
        if n_r1 < MIN_SAMPLES_FOR_NETWORK:
            raise HTTPException(400, f"{n_r1} samples are not enough for a network. OTTER "
                                     f"correlates time series; at least {MIN_SAMPLES_FOR_NETWORK} "
                                     f"time points are needed, and the default parametrisation "
                                     f"is designed for about 100.")

        for f, name in gewaehlt:
            await run_in_threadpool(_save_upload, f.file, fq / name)

        time_axis = "ordinal"
        meta_path = None
        if metadata is not None and metadata.filename:
            meta_path = tmp / "metadata.csv"
            await run_in_threadpool(_save_upload, metadata.file, meta_path)
            time_axis = "dates"

        if (lat is None) != (lon is None):
            raise HTTPException(400, "lat and lon must be given together")
        if lat is not None and not (-90 <= lat <= 90 and -180 <= lon <= 180):
            raise HTTPException(400, f"implausible coordinate lat={lat}, lon={lon}")
        if taxonomy_ref and not Path(taxonomy_ref).exists():
            raise HTTPException(400, f"taxonomy reference not found: {taxonomy_ref}")

        if not fwd_primer or not rev_primer:
            if marker not in DEFAULT_PRIMERS:
                raise HTTPException(400, f"There are no default primers for marker {marker!r} — "
                                         f"please give fwd_primer and rev_primer.")
            fwd_primer, rev_primer = DEFAULT_PRIMERS[marker]

        dada2_env = {
            "MANTA_NCORES": str(max(1, ncores)),
            "MANTA_FWD_PRIMER": fwd_primer, "MANTA_REV_PRIMER": rev_primer,
            "MANTA_TRUNC_F": str(trunc_f), "MANTA_TRUNC_R": str(trunc_r),
            "MANTA_MAXEE_F": str(maxee_f), "MANTA_MAXEE_R": str(maxee_r),
            "MANTA_MIN_OVERLAP": str(min_overlap),
            **({"MANTA_PR2": taxonomy_ref} if taxonomy_ref else {}),
            "MANTA_ASV_PREFIX": "euk" if marker == "18S" else ("prok" if marker == "16S" else "asv"),
            "MANTA_KINGDOM": "Eukaryota" if marker == "18S" else "unassigned",
            "MANTA_METADATA": str(meta_path) if meta_path else "",
        }
        thresholds = {"con_tr": con_tr, "con_alpha": con_alpha, "ccmn_tr": ccmn_tr,
                      "louvain_res": louvain_res, "fft_coeffs": fft_coeffs,
                      "num_permutations": num_permutations, "num_samples": num_samples}
        _validate_thresholds(thresholds)
        job_id = import_job.start_import(dataset_id, marker=marker, region=region,
                                         station=station, lat=lat, lon=lon,
                                         fastq_dir=fq, dada2_env=dada2_env, time_axis=time_axis,
                                         thresholds=thresholds, reserved=True,
                                         replace_wipe=_replace_hook(dataset_id, replace,
                                                                    me.username))
    except BaseException:
        import_job.release(dataset_id)
        if tmp is not None:
            shutil.rmtree(tmp, ignore_errors=True)
        raise
    audit.note(me.username, "dataset import started",
               f"{dataset_id} (FASTQ){' replace' if replace else ''} job={job_id}")
    return {"job_id": job_id, "dataset_id": dataset_id, "n_samples": n_r1,
            "time_axis": time_axis, "taxonomy": bool(taxonomy_ref), "thresholds": thresholds}


class RecomputeRequest(BaseModel):
    con_tr: float = PRODUCTION_DEFAULTS["con_tr"]
    con_alpha: float = PRODUCTION_DEFAULTS["con_alpha"]
    ccmn_tr: float = PRODUCTION_DEFAULTS["ccmn_tr"]
    louvain_res: float = PRODUCTION_DEFAULTS["louvain_res"]
    fft_coeffs: int = PRODUCTION_DEFAULTS["fft_coeffs"]
    num_permutations: int = PRODUCTION_DEFAULTS["num_permutations"]
    num_samples: int = PRODUCTION_DEFAULTS["num_samples"]
    run_id: str | None = None


def _validate_thresholds(t: dict) -> None:
    if not 0.0 <= t["con_tr"] < 1.0:
        raise HTTPException(422, "con_tr must be in [0, 1) — it is a correlation.")
    if not 0.0 < t["con_alpha"] <= 1.0:
        raise HTTPException(422, "con_alpha must be in (0, 1].")
    if not 0.0 <= t["ccmn_tr"] < 1.0:
        raise HTTPException(422, "ccmn_tr must be in [0, 1).")
    if not 2 <= t["fft_coeffs"] <= LIMITS["fft_coeffs_max"]:
        raise HTTPException(422, f"fft_coeffs must be between 2 and {LIMITS['fft_coeffs_max']}.")
    if t["num_permutations"] < 1 or t["num_samples"] < 1:
        raise HTTPException(422, "num_permutations and num_samples must be at least 1.")
    if t["num_permutations"] > LIMITS["num_permutations_max"]:
        raise HTTPException(422, f"num_permutations is limited to "
                                 f"{LIMITS['num_permutations_max']}.")
    if t["num_samples"] > LIMITS["num_samples_max"]:
        raise HTTPException(422, f"num_samples is limited to {LIMITS['num_samples_max']}.")
    if not t["louvain_res"] > 0:
        raise HTTPException(422, "louvain_res must be greater than 0.")


RECOMPUTED_TAG = "_recomputed_"


def _recompute_target(dataset_id: str, now: datetime) -> str:
    tag = now.strftime("%Y%m%d")
    for n in range(1, 100):
        suffix = f"{RECOMPUTED_TAG}{tag}" + (f"_{n}" if n > 1 else "")
        kandidat = dataset_id[:64 - len(suffix)] + suffix
        if import_job.busy(kandidat) is None and not _q(
                "MATCH (n {dataset_id:$d}) RETURN 1 AS x LIMIT 1", d=kandidat):
            return kandidat
    raise HTTPException(409, f"{dataset_id!r} was recomputed too often today — delete older "
                             f"recomputations or try again tomorrow.")


def _recompute_label(region: str | None, dataset_id: str, now: datetime) -> str:
    zusatz = f" · recomputed {now.strftime('%Y-%m-%d')}"
    basis = (region or dataset_id).strip()
    return basis[:MAX_REGION_CHARS - len(zusatz)] + zusatz


def _recompute_source(dataset_id: str) -> dict:
    ds = _q("MATCH (d:Dataset {dataset_id:$d}) RETURN d.region AS region, "
            "coalesce(d.time_axis,'ordinal') AS time_axis, "
            "COUNT { MATCH (a:ASV {dataset_id: d.dataset_id}) } AS n_asv, "
            "COUNT { MATCH (s:Sample {dataset_id: d.dataset_id}) } AS n_sample", d=dataset_id)
    if not ds:
        raise HTTPException(404, f"unknown dataset_id {dataset_id!r}")
    d = ds[0]
    if d["n_sample"] < MIN_SAMPLES_FOR_NETWORK:
        raise HTTPException(400, f"{d['n_sample']} samples are not enough for a network "
                                 f"(at least {MIN_SAMPLES_FOR_NETWORK}).")
    return d


@app.get("/datasets/{dataset_id}/recompute/estimate",
         dependencies=[Depends(auth.admin), Depends(visible_dataset)])
def recompute_estimate(dataset_id: str, num_permutations: int = Query(
                           PRODUCTION_DEFAULTS["num_permutations"]),
                       num_samples: int = Query(PRODUCTION_DEFAULTS["num_samples"])):
    d = _recompute_source(dataset_id)
    now = datetime.now(timezone.utc)
    est = otter_estimate.estimate(d["n_asv"], d["n_sample"], num_permutations, num_samples)
    return {"dataset_id": dataset_id, "new_dataset_id": _recompute_target(dataset_id, now),
            "new_label": _recompute_label(d["region"], dataset_id, now), "estimate": est}


@app.post("/datasets/{dataset_id}/recompute", dependencies=[Depends(auth.admin), Depends(visible_dataset)])
def recompute(dataset_id: str, req: RecomputeRequest, me: auth.User = Depends(auth.admin)):
    t = req.model_dump()
    run_id = t.pop("run_id") or f"thr_{req.con_tr}_{req.con_alpha}_p{req.num_permutations}"
    _validate_thresholds(t)
    _reserve(dataset_id, "a recompute request")
    neu: str | None = None
    try:
        d = _recompute_source(dataset_id)
        est = _require_memory(d["n_asv"], d["n_sample"], t)
        _require_tools("recompute")
        now = datetime.now(timezone.utc)
        neu = _recompute_target(dataset_id, now)
        _reserve(neu, "a recompute request")
        label = _recompute_label(d["region"], dataset_id, now)
        job_id = import_job.start_recompute(
            dataset_id, neu, label, run_id=run_id, thresholds=t, time_axis=d["time_axis"],
            at=now.isoformat(timespec="seconds"), reserved=True, estimate=est,
            discard_new=_discard_dataset(neu))
    except BaseException:
        import_job.release(dataset_id)
        if neu is not None:
            import_job.release(neu)
        raise
    audit.note(me.username, "network recomputed",
               f"{dataset_id} -> new dataset {neu} run={run_id} job={job_id}")
    return {"job_id": job_id, "dataset_id": dataset_id, "new_dataset_id": neu,
            "new_label": label, "run_id": run_id, "thresholds": t,
            "n_asv": d["n_asv"], "n_samples": d["n_sample"], "estimate": est,
            "note": "A new dataset is computed; the original stays as it is — samples, network, "
                    "module names, notes and stars."}


def _discard_dataset(dataset_id: str):
    def weg():
        _w("MATCH (n {dataset_id:$d}) DETACH DELETE n", d=dataset_id)
    return weg


@app.get("/imports", dependencies=[Depends(auth.admin)])
def import_jobs():
    return {"jobs": import_job.list_jobs(),
            "hinweis": ("The list only covers jobs since the last backend start; a restart "
                        "cancels running imports.")}


@app.get("/import/{job_id}", dependencies=[Depends(auth.admin)])
def import_status(job_id: str):
    st = import_job.get_status(job_id)
    if not st:
        raise HTTPException(404, f"unknown job_id {job_id!r}")
    return st


@app.delete("/datasets/{dataset_id}",
            dependencies=[Depends(auth.admin), Depends(visible_dataset)])
def delete_dataset(dataset_id: str, me: auth.User = Depends(auth.admin)):
    with _exclusive(dataset_id, "a delete request"):
        if not _q("MATCH (d:Dataset {dataset_id:$d}) RETURN d.dataset_id AS id", d=dataset_id):
            raise HTTPException(404, f"unknown dataset_id {dataset_id!r} — nothing deleted")
        abgeleitet = [r["id"] for r in _q(
            "MATCH (n:Dataset) WHERE n.recomputed_from = $d RETURN n.dataset_id AS id "
            "ORDER BY id", d=dataset_id)]
        _w("MATCH (n {dataset_id:$d}) DETACH DELETE n", d=dataset_id)
    audit.note(me.username, "dataset deleted", dataset_id)
    return {"deleted": dataset_id, "kept_derived": abgeleitet}


MAX_QUESTION_CHARS = 4000
MAX_HISTORY_TURNS = 80
MAX_HISTORY_CONTENT_CHARS = 20_000


class HistoryTurn(BaseModel):
    role: str
    content: str = ""
    tools: list[dict] | None = None

    @field_validator("content")
    @classmethod
    def _kappen(cls, v: str) -> str:
        return v[:MAX_HISTORY_CONTENT_CHARS]


class AgentAsk(BaseModel):
    question: str = Field(max_length=MAX_QUESTION_CHARS)
    dataset_id: str | None = None
    model: str | None = None
    asv_id: str | None = None
    cluster: int | None = None
    provider_url: str | None = None
    history: list[HistoryTurn] | None = Field(None, max_length=MAX_HISTORY_TURNS)
    concept: str | None = None
    conversation_id: str | None = Field(None, max_length=64)
    question_kind: str | None = Field(None, max_length=64)


@app.get("/agent/status")
def agent_status():
    return {**agent.available(),
            "limits": {"question_chars": MAX_QUESTION_CHARS, "history_turns": MAX_HISTORY_TURNS}}


@app.get("/agent/tools")
def agent_tools():
    tools = agent.tool_help()
    return {"n": len(tools), "tools": tools}


class ToolRun(BaseModel):
    arguments: dict = {}


@app.post("/agent/tools/{name}", dependencies=[Depends(auth.user)])
def agent_tool_run(name: str, req: ToolRun):
    if name not in {t["name"] for t in agent.tool_help()}:
        raise HTTPException(404, f"unknown tool {name!r}")
    result = agent.registry.call(name, dict(req.arguments))
    return {"tool": name, "arguments": req.arguments, "result": result,
            "provenance": result.get("provenance") if isinstance(result, dict) else None,
            "error": result.get("error") if isinstance(result, dict) else None}


@app.post("/agent/ask")
def agent_ask(req: AgentAsk, me: auth.User = Depends(auth.user),
              provider_key: str | None = Header(default=None, alias="X-MANTA-Provider-Key")):
    if not req.question.strip():
        raise HTTPException(422, "question must not be empty")
    try:
        weiter = transcripts.check_conversation(me, req.conversation_id, req.dataset_id)
    except transcripts.UnknownConversation as e:
        raise HTTPException(404, "unknown conversation") from e
    except transcripts.OtherDataset as e:
        raise HTTPException(409, "This conversation belongs to another dataset. "
                                 "Start a new conversation here.") from e
    provider = None
    if req.provider_url or provider_key:
        if not req.provider_url:
            raise HTTPException(400, "Own key without a provider address (provider_url).")
        if not provider_key:
            raise HTTPException(400, "Provider address without a key "
                                     "(the X-MANTA-Provider-Key header is missing).")
        if not req.model:
            raise HTTPException(400, "Own provider without a model name (model).")
        try:
            provider = agent.SessionProvider(req.provider_url, provider_key, req.model)
        except agent.AgentError as e:
            raise HTTPException(400, str(e)) from e
    elif req.model:
        installed = agent.available().get("models_available") or []
        if req.model not in installed:
            raise HTTPException(400, f"Model {req.model!r} is not installed. "
                                     f"Available: {installed}")
    verlauf = [t.model_dump() for t in req.history] if req.history else None
    ereignisse: list[dict] = []
    gefragt = time.time()

    def protokolliere(status: str, ergebnis: dict | None = None, fehler: str = "") -> dict:
        modell = ((ergebnis or {}).get("model")
                  or next((e.get("model") for e in ereignisse if e.get("kind") == "prompt"), None)
                  or req.model or "")
        if provider is not None:
            wer = transcripts.provider_info("own", provider.base_url)
        elif agent.is_remote(modell):
            wer = transcripts.provider_info("operator", agent.remote_base_url())
        else:
            wer = transcripts.provider_info("local", agent.ollama_url())
        return transcripts.record_turn(
            user=me, conversation_id=weiter, dataset_id=req.dataset_id,
            question=req.question.strip(), asked_at=gefragt, finished_at=time.time(),
            status=status, result=ergebnis, events=ereignisse, error=fehler, provider=wer,
            model=modell,
            request={"model_requested": req.model, "dataset_id": req.dataset_id,
                     "asv_id": req.asv_id, "cluster": req.cluster, "concept": req.concept,
                     "question_kind": req.question_kind,
                     "history_turns": len(verlauf or []), "own_key": provider is not None},
            extra_secrets=(provider_key,))

    try:
        antwort = agent.run(req.question.strip(), req.dataset_id, model=req.model,
                            asv_id=req.asv_id, cluster=req.cluster, provider=provider,
                            history=verlauf, concept=req.concept, trace=ereignisse,
                            question_kind=req.question_kind)
    except agent.AgentError as e:
        kennung = protokolliere("error", fehler=str(e))
        return _agent_failure(e, kennung)
    except Exception as e:
        protokolliere("error", fehler=f"internal error ({type(e).__name__})")
        raise
    kennung = protokolliere("step_limit" if antwort.get("truncated") else "answered", antwort)
    return {**antwort, **kennung, "admins_can_read": transcripts.admins_can_read()}



@app.get("/agent/conversations")
def agent_conversations(q: str | None = Query(None, max_length=200),
                        dataset_id: str | None = Query(None, max_length=200),
                        me: auth.User = Depends(auth.user)):
    return {"admins_can_read": transcripts.admins_can_read(),
            "conversations": transcripts.list_own(me, q=q, dataset_id=dataset_id)}


@app.get("/agent/conversations/{conversation_id}")
def agent_conversation(conversation_id: str, me: auth.User = Depends(auth.user)):
    gespraech = transcripts.conversation(conversation_id)
    if gespraech is None or not transcripts.can_read(me, gespraech.pop("owner_row")):
        raise HTTPException(404, "unknown conversation")
    gespraech["own"] = gespraech["conversation"]["username"] == me.username
    return gespraech


@app.get("/agent/turns/{turn_id}")
def agent_turn(turn_id: int, me: auth.User = Depends(auth.user)):
    zug = transcripts.turn(turn_id)
    if zug is None or not transcripts.can_read(me, zug.pop("owner_row")):
        raise HTTPException(404, "unknown turn")
    return zug["turn"]


@app.get("/admin/transcripts", dependencies=[Depends(auth.admin)])
def admin_transcripts(q: str | None = Query(None, max_length=200),
                      user: str | None = Query(None, max_length=64)):
    if not transcripts.admins_can_read():
        return {"enabled": False, "conversations": []}
    return {"enabled": True, "conversations": transcripts.list_all(q=q, username=user)}


def _agent_failure(e: agent.AgentError, kennung: dict | None = None) -> JSONResponse:
    return JSONResponse(status_code=503,
                        content={"detail": str(e), "kind": getattr(e, "kind", "assistant"),
                                 **(kennung or {})})


class DatasetPatch(BaseModel):
    region: str | None = None
    lat: float | None = None
    lon: float | None = None
    move_station: bool = False


def _station_of(dataset_id: str) -> tuple[str | None, list[str]]:
    rows = _q("MATCH (d:Dataset {dataset_id:$d}) "
              "OPTIONAL MATCH (:Sample {dataset_id:$d})-[:AT_STATION]->(st:Station) "
              "RETURN d.station AS name, collect(DISTINCT st.station_id) AS sids", d=dataset_id)
    if not rows:
        return None, []
    sids = sorted(rows[0]["sids"])
    if len(sids) > 1:
        raise HTTPException(409, f"the samples of {dataset_id!r} are linked to several stations "
                                 f"({', '.join(sids)}) — this needs a repair, not an edit")
    sid = sids[0] if sids else ((rows[0]["name"] or "").strip() or None)
    if sid is None:
        return None, []
    andere = sorted({r["d"] for r in _q(
        "MATCH (s:Sample)-[:AT_STATION]->(:Station {station_id:$sid}) "
        "WHERE s.dataset_id <> $d RETURN DISTINCT s.dataset_id AS d", sid=sid, d=dataset_id)})
    return sid, andere


def _move_station(dataset_id: str, sid: str, lat: float, lon: float) -> list[str]:
    def tx(t):
        t.run("MERGE (st:Station {station_id:$sid}) ON CREATE SET st.name = $sid "
              "SET st.location = point({latitude:$lat, longitude:$lon, crs:'WGS-84'})",
              sid=sid, lat=lat, lon=lon).consume()
        t.run("MATCH (st:Station {station_id:$sid}) MATCH (s:Sample {dataset_id:$d}) "
              "MERGE (s)-[:AT_STATION]->(st)", sid=sid, d=dataset_id).consume()
        return [r["moved"] for r in t.run(
            "MATCH (s:Sample)-[:AT_STATION]->(:Station {station_id:$sid}) "
            "WITH DISTINCT s.dataset_id AS ds "
            "MATCH (d:Dataset {dataset_id:ds}) SET d.lat = $lat, d.lon = $lon, d.station = $sid "
            "RETURN d.dataset_id AS moved ORDER BY d.dataset_id", sid=sid, lat=lat, lon=lon)]
    with driver().session(default_access_mode="WRITE") as sess:
        return sess.execute_write(tx)


@app.patch("/datasets/{dataset_id}", dependencies=[Depends(auth.admin), Depends(visible_dataset)])
def rename_dataset(dataset_id: str, patch: DatasetPatch, me: auth.User = Depends(auth.admin)):
    felder, params = [], {"d": dataset_id}
    if patch.region is not None:
        region = patch.region.strip()
        if not region:
            raise HTTPException(422, "region must not be empty")
        if len(region) > MAX_REGION_CHARS:
            raise HTTPException(422, f"region is limited to {MAX_REGION_CHARS} characters "
                                     f"(given: {len(region)})")
        if any(ch < " " for ch in region):
            raise HTTPException(422, "region must not contain line breaks or control characters")
        felder.append("d.region = $r"); params["r"] = region
    if (patch.lat is None) != (patch.lon is None):
        raise HTTPException(422, "lat and lon must be given together")
    if patch.lat is not None:
        if not (-90 <= patch.lat <= 90 and -180 <= patch.lon <= 180):
            raise HTTPException(422, f"implausible coordinate lat={patch.lat}, lon={patch.lon}")
        felder.append("d.lat = $lat, d.lon = $lon")
        params["lat"] = round(patch.lat, 4); params["lon"] = round(patch.lon, 4)
    if not felder:
        raise HTTPException(422, "nothing to change: give region or lat/lon")
    verschoben: list[str] = []
    with _exclusive(dataset_id, "an edit request"):
        if patch.lat is not None:
            sid, andere = _station_of(dataset_id)
            if sid is not None:
                if andere and not patch.move_station:
                    raise HTTPException(409, (
                        f"station {sid!r} is shared with {len(andere)} other dataset(s) "
                        f"({', '.join(andere)}); moving it moves them too. Send the same "
                        f"request with move_station: true to move all of them."))
                verschoben = _move_station(dataset_id, sid, params["lat"], params["lon"])
        rows = _w(f"MATCH (d:Dataset {{dataset_id:$d}}) SET {', '.join(felder)} "
                  "RETURN d.dataset_id AS dataset_id, d.region AS region, d.lat AS lat, "
                  "d.lon AS lon", **params)
    if not rows:
        raise HTTPException(404, f"unknown dataset_id {dataset_id!r}")
    was = " and ".join(n for n, ja in (("region", patch.region is not None),
                                       ("coordinate", patch.lat is not None)) if ja)
    andere_mit = [d for d in verschoben if d != dataset_id]
    audit.note(me.username, "dataset edited", f"{dataset_id}: {was}"
               + (f"; station moved, {len(andere_mit)} other dataset(s) with it"
                  if andere_mit else ""))
    return {**rows[0], "moved_with_station": verschoben}


class NotePatch(BaseModel):
    note: str = Field(max_length=MAX_NOTE_CHARS)


def _check_note(text: str) -> None:
    if len(text) > MAX_NOTE_CHARS:
        raise HTTPException(422, f"note is limited to {MAX_NOTE_CHARS} characters "
                                 f"(given: {len(text)})")


@app.get("/datasets/{dataset_id}/cluster/{louvain_label}/at/{sample_id}", dependencies=[Depends(visible_dataset)])
def cluster_at_sample(dataset_id: str, louvain_label: int, sample_id: str):
    rows = _q(
        """
        MATCH (s:Sample {sample_id:$s, dataset_id:$d})
        OPTIONAL MATCH (s)-[all:HAS_ABUNDANCE]->(:ASV {dataset_id:$d})
        WITH s, sum(all.count) AS live_total, collect(all.count) AS all_counts
        WITH s, coalesce(s.analysed_reads_total, live_total) AS sample_total, all_counts
        MATCH (s)-[r:HAS_ABUNDANCE]->(a:ASV {dataset_id:$d}) WHERE a.louvain_label = $l
        WITH s, sample_total, a, r,
             size([x IN all_counts WHERE x > r.count]) + 1 AS rank
        OPTIONAL MATCH (:Sample {dataset_id:$d})-[ha:HAS_ABUNDANCE]->(a)
        WITH s, sample_total, a, r, rank, count(ha) AS n_samples_present
        RETURN a.id AS id, a.genus AS genus, r.count AS count, sample_total AS sample_total,
               rank AS rank, n_samples_present AS n_samples_present
        ORDER BY r.count DESC, a.id
        """,
        d=dataset_id, l=louvain_label, s=sample_id)
    n_samples_total = _q("MATCH (x:Sample {dataset_id:$d}) RETURN count(x) AS n",
                         d=dataset_id)[0]["n"]
    if not rows:
        if not _q("MATCH (s:Sample {sample_id:$s, dataset_id:$d}) RETURN s", d=dataset_id, s=sample_id):
            raise HTTPException(404, f"sample {sample_id!r} not in dataset_id={dataset_id!r}")
        if not _q("MATCH (a:ASV {dataset_id:$d}) WHERE a.louvain_label = $l RETURN a.id LIMIT 1",
                  d=dataset_id, l=louvain_label):
            raise HTTPException(404, f"no cluster {louvain_label} in dataset_id={dataset_id!r}")
        return {"dataset_id": dataset_id, "louvain_label": louvain_label, "sample": sample_id,
                "members": [], "cluster_total": 0.0, "caveat": _sum_caveat(dataset_id),
                "note": "No member of this cluster was detected in this sample."}
    total = sum(r["count"] or 0.0 for r in rows)
    st = rows[0]["sample_total"] or 0.0
    return {
        "dataset_id": dataset_id, "louvain_label": louvain_label, "sample": sample_id,
        "cluster_total": total,
        "sample_total": st,
        "quantity": semantics.quantity(_q, dataset_id),
        "caveat": _sum_caveat(dataset_id),
        "members": [{"id": r["id"], "genus": r["genus"], "count": r["count"],
                     "rank": r["rank"],
                     "n_samples_present": r["n_samples_present"],
                     "n_samples_total": n_samples_total,
                     "share_of_sample": (r["count"] / st) if st > 0 else None,
                     "share_of_cluster": (r["count"] / total) if total > 0 else None}
                    for r in rows],
        "note": None,
    }


@app.get("/datasets/{dataset_id}/samples", dependencies=[Depends(visible_dataset)])
def samples(dataset_id: str):
    rows = _q("MATCH (s:Sample {dataset_id:$d}) "
              "RETURN s.sample_id AS sample, toString(s.date) AS date "
              "ORDER BY s.date, s.same_day_index, s.ordinal_index, s.sample_id", d=dataset_id)
    return {"dataset_id": dataset_id, "time_axis": _time_axis(dataset_id), "samples": rows}


def _asv_rel_abundance(dataset_id: str) -> dict[str, float]:
    return {r["id"]: r["rel"] for r in _q(
        """
        MATCH (s:Sample {dataset_id:$d})
        OPTIONAL MATCH (s)-[all:HAS_ABUNDANCE]->(:ASV {dataset_id:$d})
        WITH s, sum(all.count) AS live_total
        WITH s, coalesce(s.analysed_reads_total, live_total) AS tot
        WITH collect({s: s, tot: tot}) AS proben, count(s) AS n
        UNWIND proben AS p
        WITH p.s AS s, p.tot AS tot, n WHERE tot > 0
        MATCH (s)-[h:HAS_ABUNDANCE]->(a:ASV {dataset_id:$d})
        WITH a, n, sum(toFloat(h.count) / tot) AS summe
        RETURN a.id AS id, summe / n AS rel
        """,
        d=dataset_id,
    )}


@app.get("/datasets/{dataset_id}/asvs", dependencies=[Depends(visible_dataset)])
def asv_list(dataset_id: str):
    rows = _q(
        f"""
        MATCH (a:ASV {{dataset_id:$d}})
        RETURN a.id AS id, a.louvain_label AS cluster, a.read_count_total AS total,
               {", ".join(f"a.{t} AS {t}" for t in TAXONOMY)}
        ORDER BY coalesce(a.read_count_total, 0) DESC, a.id
        """,
        d=dataset_id)
    rel = _asv_rel_abundance(dataset_id)
    asvs = [{"id": r["id"], "cluster": r["cluster"], "share": rel.get(r["id"], 0.0),
             "label": semantics.taxon_label({t: r[t] for t in TAXONOMY})} for r in rows]
    asvs.sort(key=lambda a: (-a["share"], a["id"]))
    return {"dataset_id": dataset_id, "asvs": asvs}


@app.get("/datasets/{dataset_id}/sample/{sample_id}", dependencies=[Depends(visible_dataset)])
def sample_detail(dataset_id: str, sample_id: str):
    s = _q("MATCH (s:Sample {sample_id:$s, dataset_id:$d}) "
           "RETURN toString(s.date) AS date, s.analysed_reads_total AS total",
           d=dataset_id, s=sample_id)
    if not s:
        raise HTTPException(404, f"sample {sample_id!r} not in dataset_id={dataset_id!r}")
    rows = _q(
        f"""
        MATCH (:Sample {{sample_id:$s, dataset_id:$d}})-[r:HAS_ABUNDANCE]->(a:ASV {{dataset_id:$d}})
        WHERE r.count > 0
        RETURN a.id AS id, a.louvain_label AS cluster, r.count AS count,
               {", ".join(f"a.{t} AS {t}" for t in TAXONOMY)}
        ORDER BY r.count DESC, a.id
        """,
        d=dataset_id, s=sample_id)
    total = s[0]["total"] or sum(r["count"] or 0.0 for r in rows)
    share = lambda c: (c / total) if total > 0 else None  # noqa: E731
    mods: dict[int, dict] = {}
    asvs = []
    for i, r in enumerate(rows):
        path = {t: r[t] for t in TAXONOMY}
        asvs.append({"id": r["id"], "cluster": r["cluster"], "count": r["count"],
                     "share": share(r["count"]), "rank": i + 1,
                     "label": semantics.taxon_label(path),
                     "taxa": [v for t in TAXONOMY if (v := path.get(t))
                              and v not in semantics.TAXONOMY_PLACEHOLDERS]})
        if r["cluster"] is not None:
            m = mods.setdefault(r["cluster"], {"cluster": r["cluster"], "count": 0.0, "n_asv": 0})
            m["count"] += r["count"] or 0.0
            m["n_asv"] += 1
    for m in mods.values():
        m["share"] = share(m["count"])
    return {"dataset_id": dataset_id, "sample": sample_id, "date": s[0]["date"],
            "sample_total": total, "quantity": semantics.quantity(_q, dataset_id),
            "asvs": asvs,
            "modules": sorted(mods.values(), key=lambda m: (-m["count"], m["cluster"]))}


def _sum_caveat(dataset_id: str) -> str | None:
    return None if _value_kind(dataset_id) == "reads" else semantics.CLUSTER_TIMESERIES_CAVEAT


class StarPatch(BaseModel):
    starred: bool


def _user_star_keys(dataset_id: str, kind: str) -> set[str]:
    u = access.current().username
    if u is None:
        return set()
    return {r["k"] for r in _q("MATCH (s:Star {dataset_id:$d, username:$u, kind:$kind}) "
                               "RETURN s.key AS k", d=dataset_id, u=u, kind=kind)}


def _set_star(dataset_id: str, username: str, kind: str, key: str, starred: bool) -> dict:
    if starred:
        t = datetime.now(timezone.utc).isoformat(timespec="seconds")
        rows = _w("MERGE (s:Star {dataset_id:$d, username:$u, kind:$kind, key:$k}) "
                  "SET s.at = $t RETURN true AS starred, s.at AS starred_at",
                  d=dataset_id, u=username, kind=kind, k=key, t=t)
        return rows[0]
    _w("MATCH (s:Star {dataset_id:$d, username:$u, kind:$kind, key:$k}) DELETE s",
       d=dataset_id, u=username, kind=kind, k=key)
    return {"starred": False, "starred_at": None}


@app.put("/datasets/{dataset_id}/asv/{asv_id}/star", dependencies=[Depends(visible_dataset)])
def set_asv_star(dataset_id: str, asv_id: str, patch: StarPatch,
                 u: auth.User = Depends(auth.user)):
    if not _q("MATCH (a:ASV {id:$id, dataset_id:$d}) RETURN a.id", d=dataset_id, id=asv_id):
        raise HTTPException(404, f"ASV {asv_id!r} not in dataset_id={dataset_id!r}")
    return _set_star(dataset_id, u.username, "asv", asv_id, patch.starred)


@app.put("/datasets/{dataset_id}/cluster/{louvain_label}/star", dependencies=[Depends(visible_dataset)])
def set_cluster_star(dataset_id: str, louvain_label: int, patch: StarPatch,
                     u: auth.User = Depends(auth.user)):
    if not _q("MATCH (c:Cluster {louvain_label:$l, dataset_id:$d}) RETURN c.louvain_label",
              d=dataset_id, l=louvain_label):
        raise HTTPException(404, f"cluster {louvain_label} not in dataset_id={dataset_id!r}")
    return _set_star(dataset_id, u.username, "cluster", str(louvain_label), patch.starred)


@app.get("/datasets/{dataset_id}/starred", dependencies=[Depends(visible_dataset)])
def starred(dataset_id: str):
    u = access.current().username
    if u is None:
        return {"dataset_id": dataset_id, "asvs": [], "clusters": [], "n": 0,
                "note": "Stars belong to an account — sign in to mark and find things."}
    asvs = _q("MATCH (s:Star {dataset_id:$d, username:$u, kind:'asv'}) "
              "MATCH (a:ASV {dataset_id:$d, id:s.key}) "
              "RETURN a.id AS id, a.genus AS genus, a.louvain_label AS cluster, s.at AS at "
              "ORDER BY coalesce(s.at,'') DESC, a.id", d=dataset_id, u=u)
    cls = _q("MATCH (s:Star {dataset_id:$d, username:$u, kind:'cluster'}) "
             "WHERE EXISTS { MATCH (c:Cluster {dataset_id:$d}) "
             "WHERE c.louvain_label = toInteger(s.key) } "
             "RETURN toInteger(s.key) AS louvain_label, s.at AS at "
             "ORDER BY coalesce(s.at,'') DESC, louvain_label", d=dataset_id, u=u)
    return {"dataset_id": dataset_id, "asvs": asvs, "clusters": cls,
            "n": len(asvs) + len(cls), "note": None}



def _note_for(dataset_id: str, kind: str, key: str, run_id: str | None = None) -> dict:
    u = access.current().username
    if u is None:
        return {"text": None, "at": None}
    rows = _q("MATCH (n:Note {dataset_id:$d, username:$u, kind:$kind, key:$k}) "
              "WHERE $run IS NULL OR n.run_id = $run "
              "RETURN n.text AS text, n.at AS at LIMIT 1",
              d=dataset_id, u=u, kind=kind, k=key, run=run_id)
    return rows[0] if rows else {"text": None, "at": None}


def _set_note(dataset_id: str, username: str, kind: str, key: str, text: str,
              run_id: str | None = None) -> dict:
    text = text.strip()
    if not text:
        _w("MATCH (n:Note {dataset_id:$d, username:$u, kind:$kind, key:$k}) DELETE n",
           d=dataset_id, u=username, kind=kind, k=key)
        return {"note": None, "note_at": None}
    t = datetime.now(timezone.utc).isoformat(timespec="seconds")
    rows = _w("MERGE (n:Note {dataset_id:$d, username:$u, kind:$kind, key:$k}) "
              "SET n.text = $text, n.at = $t, n.run_id = $run "
              "RETURN n.text AS note, n.at AS note_at",
              d=dataset_id, u=username, kind=kind, k=key, text=text, t=t, run=run_id)
    return rows[0]


@app.put("/datasets/{dataset_id}/asv/{asv_id}/note", dependencies=[Depends(auth.user), Depends(visible_dataset)])
def set_asv_note(dataset_id: str, asv_id: str, patch: NotePatch,
                 u: auth.User = Depends(auth.user)):
    _check_note(patch.note)
    if not _q("MATCH (a:ASV {id:$id, dataset_id:$d}) RETURN a.id", d=dataset_id, id=asv_id):
        raise HTTPException(404, f"ASV {asv_id!r} not in dataset_id={dataset_id!r}")
    return _set_note(dataset_id, u.username, "asv", asv_id, patch.note)


@app.put("/datasets/{dataset_id}/cluster/{louvain_label}/note", dependencies=[Depends(auth.user), Depends(visible_dataset)])
def set_cluster_note(dataset_id: str, louvain_label: int, patch: NotePatch,
                     u: auth.User = Depends(auth.user)):
    _check_note(patch.note)
    rows = _q("MATCH (c:Cluster {louvain_label:$l, dataset_id:$d}) "
              "RETURN c.run_id AS run_id ORDER BY c.run_id DESC LIMIT 1",
              d=dataset_id, l=louvain_label)
    if not rows:
        raise HTTPException(404, f"no cluster {louvain_label} in dataset_id={dataset_id!r}")
    return _set_note(dataset_id, u.username, "cluster", str(louvain_label), patch.note,
                     run_id=rows[0]["run_id"])



class ClusterLabelPatch(BaseModel):
    name: str | None = None
    color: str | None = None


_HEX_COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")


@app.put("/datasets/{dataset_id}/cluster/{louvain_label}/label",
         dependencies=[Depends(auth.admin), Depends(visible_dataset)])
def set_cluster_label(dataset_id: str, louvain_label: int, patch: ClusterLabelPatch):
    gesetzt = patch.model_fields_set
    sets, params = [], {"d": dataset_id, "l": louvain_label}
    if "name" in gesetzt:
        params["name"] = semantics.clean_module_name(patch.name)
        sets.append("c.name = $name")
    if "color" in gesetzt:
        farbe = (patch.color or "").strip().lower()
        if farbe and not _HEX_COLOR.match(farbe):
            raise HTTPException(422, f"color must be #rrggbb — given: {patch.color!r}")
        params["color"] = farbe or None
        sets.append("c.color = $color")
    if not sets:
        raise HTTPException(422, "neither name nor color given")

    rows = _w(f"MATCH (c:Cluster {{louvain_label:$l, dataset_id:$d}}) SET {', '.join(sets)} "
              f"RETURN c.louvain_label AS louvain_label, c.name AS name, c.color AS color",
              **params)
    if not rows:
        raise HTTPException(404, f"no cluster {louvain_label} in dataset_id={dataset_id!r}")
    r = rows[0]
    return {**r, "display": semantics.module_display(r["louvain_label"], r["name"])}



@app.get("/datasets/{dataset_id}/taxon", dependencies=[Depends(visible_dataset)])
def taxon(dataset_id: str, asv: str = Query(..., min_length=1)):
    gruppe = semantics.taxon_group(_q, dataset_id, asv)
    if gruppe is None:
        raise HTTPException(404, f"ASV {asv!r} not in dataset_id={dataset_id!r}")
    reihe = semantics.taxon_series(_q, dataset_id, [m["id"] for m in gruppe["members"]])
    return {
        "dataset_id": dataset_id,
        **gruppe,
        "series": reihe["rows"],
        "series_absent_reason": reihe["absent_reason"],
        "value_declaration": {
            **semantics.value_declaration(_q, dataset_id, "within one sample"),
            "applies_to": "series[].share",
        },
        "time_axis": _time_axis(dataset_id),
        "note": ("The sum runs across DIFFERENT sequence variants that share a name — the name "
                 "only says which reference entry is closest, it does not make them one "
                 "organism."),
    }



SEARCH_MIN_TAXON_CHARS = 2
SEARCH_MAX_LIMIT = 100
SEARCH_MAX_TAXA = 8


def _search_row(r: dict) -> dict:
    path = r["path"]
    genus = path.get("genus")
    return {"id": r["id"], "label": semantics.taxon_label(path), "share": r["share"],
            "genus": genus if genus not in semantics.TAXONOMY_PLACEHOLDERS else None,
            "cluster": r["cluster"], "n_samples_present": r["n_samples_present"],
            "id_match": r["id_hit"], "matched_ranks": r["hit_ranks"]}


@app.get("/datasets/{dataset_id}/search", dependencies=[Depends(visible_dataset)])
def search(dataset_id: str, q: str = Query(..., min_length=1, max_length=200),
           limit: int = Query(25, ge=1, le=SEARCH_MAX_LIMIT)):
    text = q.strip()
    if not text:
        raise HTTPException(422, "The search text must not be empty.")
    ql = text.lower()
    taxon_ok = len(ql) >= SEARCH_MIN_TAXON_CHARS
    ranks = list(TAXONOMY)
    path_proj = ", ".join(f".`{r}`" for r in ranks)
    rows = _q(
        "MATCH (a:ASV {dataset_id:$d}) "
        "WITH a, toLower(a.id) CONTAINS $ql AS id_hit, "
        "     [r IN $ranks WHERE $taxon_ok AND NOT coalesce(a[r], '') IN $ph "
        "        AND toLower(coalesce(a[r], '')) CONTAINS $ql | r] AS hit_ranks "
        "WHERE id_hit OR size(hit_ranks) > 0 "
        f"RETURN a.id AS id, a.louvain_label AS cluster, id_hit, hit_ranks, a {{{path_proj}}} AS path, "
        "       COUNT { (a)<-[h:HAS_ABUNDANCE]-(:Sample {dataset_id:$d}) WHERE h.count > 0 } "
        "         AS n_samples_present "
        "ORDER BY a.id",
        d=dataset_id, ql=ql, ranks=ranks, taxon_ok=taxon_ok,
        ph=list(semantics.TAXONOMY_PLACEHOLDERS))
    n_samples = _q("MATCH (s:Sample {dataset_id:$d}) RETURN count(s) AS n", d=dataset_id)[0]["n"]
    rel = _asv_rel_abundance(dataset_id) if rows else {}
    for r in rows:
        r["share"] = rel.get(r["id"], 0.0)

    def nach_anteil(x: dict):
        return (-x["share"], x["id"])

    im_netz = sorted((r for r in rows if r["cluster"] is not None), key=nach_anteil)
    draussen = sorted((r for r in rows if r["cluster"] is None), key=nach_anteil)

    gruppen: dict[tuple[str, str], list[dict]] = {}
    for r in draussen:
        for rank in r["hit_ranks"]:
            gruppen.setdefault((rank, r["path"][rank]), []).append(r)
    taxa = sorted(gruppen.items(), key=lambda kv: (-len(kv[1]), kv[0][1].lower(), kv[0][0]))

    sentence = None
    if not rows:
        sentence = (f"Nothing in this dataset matches “{text}”: no ASV id contains it"
                    + (", and no taxon name at any rank." if taxon_ok else
                       f" (taxon names are searched from {SEARCH_MIN_TAXON_CHARS} characters on)."))
    return {
        "dataset_id": dataset_id,
        "query": text,
        "n_samples": n_samples,
        "taxon_searched": taxon_ok,
        "min_taxon_chars": SEARCH_MIN_TAXON_CHARS,
        "limit": limit,
        "in_network": {"n_asv": len(im_netz), "asvs": [_search_row(r) for r in im_netz[:limit]]},
        "outside_network": {
            "n_asv": len(draussen),
            "asvs": [_search_row(r) for r in draussen[:limit]],
            "n_taxa": len(taxa),
            "taxa": [{"rank": rank, "value": value, "n_asv": len(mitglieder),
                      "asvs": [_search_row(r) for r in mitglieder[:limit]]}
                     for (rank, value), mitglieder in taxa[:SEARCH_MAX_TAXA]],
        },
        "sentence": sentence,
    }


@app.get("/datasets/{dataset_id}/modules", dependencies=[Depends(visible_dataset)])
def modules(dataset_id: str):
    return {"modules": list(semantics.module_labels(_q, dataset_id).values())}


@app.get("/datasets", dependencies=[Depends(auth.anyone)])
def datasets():
    rows = _q(
        """
        MATCH (d:Dataset)
        WHERE """ + access.cypher_condition("d") + """
        RETURN d.dataset_id AS dataset_id, d.region AS region, d.marker AS marker,
               coalesce(d.visibility, '""" + access.DEFAULT_VISIBILITY + """') AS visibility,
               d.station AS ds_station, d.lat AS lat, d.lon AS lon,
               coalesce(d.time_axis, 'ordinal') AS time_axis,
               coalesce(d.value_kind, 'unknown') AS value_kind,
               COUNT { MATCH (a:ASV {dataset_id: d.dataset_id}) } AS n_asv,
               COUNT { MATCH (a:ASV {dataset_id: d.dataset_id}) WHERE a.louvain_label IS NOT NULL } AS n_network,
               COUNT { MATCH (s:Sample {dataset_id: d.dataset_id}) } AS n_sample,
               d.recomputed_from AS recomputed_from, d.recomputed_at AS recomputed_at
        ORDER BY d.dataset_id
        """
    )
    sichtbar = {r["dataset_id"] for r in rows}
    for r in rows:
        r["derived"] = _derived(r["dataset_id"], r.pop("recomputed_from"),
                                r.pop("recomputed_at"), sichtbar)
        station = r.pop("ds_station", None)
        if not station:
            st = _q("MATCH (s:Sample {dataset_id:$d}) WHERE s.station IS NOT NULL "
                    "RETURN s.station AS station LIMIT 1", d=r["dataset_id"])
            station = st[0]["station"] if st else None
        lat, lon = r.pop("lat", None), r.pop("lon", None)
        r["station"] = station
        if lat is not None and lon is not None:
            r["coords"] = [lon, lat]
            r["coords_source"] = "dataset"
        elif STATION_COORDS.get(station):
            r["coords"] = STATION_COORDS[station]
            r["coords_source"] = "station_table"
        else:
            r["coords"] = None
            r["coords_source"] = None
    return {"datasets": rows}


def _derived(dataset_id: str, von: str | None, at: str | None, sichtbar: set[str]) -> dict | None:
    if not von:
        return None
    runs = _q("MATCH (r:Run {dataset_id:$d}) RETURN r.con_tr AS con_tr, r.con_alpha AS con_alpha, "
              "r.num_permutations AS num_permutations, r.n_asv_in_network_run AS n_asv "
              "ORDER BY coalesce(r.computed_at, '') DESC, r.run_id LIMIT 1", d=dataset_id)
    return {"from": von if von in sichtbar else None, "from_available": von in sichtbar,
            "at": at, "params": runs[0] if runs else None}


def _thresholds(dataset_id: str) -> dict:
    return semantics.thresholds(_q, dataset_id)


def _network_scope(dataset_id: str) -> dict:
    rows = _q("MATCH (r:Run {dataset_id:$d}) WHERE r.n_asv_in_network_run IS NOT NULL "
              "RETURN r.n_asv_in_network_run AS n_in, "
              "r.n_asv_available_to_network_run AS n_available, r.run_id AS run_id "
              "ORDER BY coalesce(r.computed_at, '') DESC, r.run_id LIMIT 1", d=dataset_id)
    n_asv = _q("MATCH (a:ASV {dataset_id:$d}) RETURN count(a) AS n", d=dataset_id)
    total = n_asv[0]["n"] if n_asv else 0
    basis = "run_record"
    if not rows:
        fft = _q("MATCH (r:Run {dataset_id:$d}) WHERE r.fft_harmonics IS NOT NULL "
                 "RETURN r.run_id AS run_id, "
                 "COUNT { MATCH (a:ASV {dataset_id:$d}) WHERE a.fft_amplitudes IS NOT NULL } "
                 "AS n_in ORDER BY r.run_id LIMIT 1", d=dataset_id)
        if fft and fft[0]["n_in"]:
            rows, basis = fft, "fft_table"
    if not rows:
        return {"recorded": False, "n_in_run": None, "n_dataset": total, "subset": None,
                "basis": None,
                "note": ("It is not recorded how many ASVs went into the network run for this "
                         "dataset. So it cannot be said whether an ASV outside the network was "
                         "tested and failed the threshold, or was never part of the run.")}
    n_in = rows[0]["n_in"]
    subset = n_in < total
    return {
        "recorded": True, "n_in_run": n_in, "n_dataset": total, "subset": subset,
        "run_id": rows[0]["run_id"], "basis": basis,
        "note": (f"The network was computed on {n_in} of the {total} ASVs of this dataset. The "
                 f"other {total - n_in} were not part of the run and were therefore never tested "
                 f"for a correlation." if subset else
                 f"All {total} ASVs of this dataset were part of the network run."),
    }


@app.get("/datasets/{dataset_id}/params", dependencies=[Depends(visible_dataset)])
def dataset_params(dataset_id: str):
    rows = _q("MATCH (d:Dataset {dataset_id:$d}) "
              "RETURN COUNT { MATCH (a:ASV {dataset_id: d.dataset_id}) } AS n_asv, "
              "COUNT { MATCH (s:Sample {dataset_id: d.dataset_id}) } AS n_sample", d=dataset_id)
    if not rows:
        raise HTTPException(404, f"unknown dataset_id {dataset_id!r}")
    return {"dataset_id": dataset_id, "thresholds": _thresholds(dataset_id),
            "defaults": OTTER_DEFAULTS,
            "counts": {"n_asv": rows[0]["n_asv"], "n_sample": rows[0]["n_sample"]},
            "retrieved_at": datetime.now(timezone.utc).isoformat(timespec="seconds")}



TAXONOMY_PLACEHOLDERS = semantics.TAXONOMY_PLACEHOLDERS

ENV_PROPS = semantics.ENVIRONMENT_KEYS
_ENV_LABEL = {v["key"]: v["label"] for v in semantics.ENVIRONMENT_VARS}

_DELIVERED_ENTRIES = ("dada2_output", "otter_input", "otter_output")


def _reads_origin(entry_point: str | None, dada2_provenance: str | None) -> str:
    if entry_point == "fastq":
        return ("Whole numbers from MANTA's own DADA2 run on the uploaded FASTQ files"
                + (", parameters recorded" if dada2_provenance == "recorded" else "") + ".")
    if entry_point in _DELIVERED_ENTRIES:
        return ("All values are whole numbers, consistent with read counts, as delivered in the "
                "uploaded files; MANTA did not process the reads behind them.")
    if dada2_provenance == "recorded":
        return ("All values are whole numbers, consistent with read counts from a DADA2 run "
                "whose parameters are recorded; how they entered MANTA was not recorded.")
    if dada2_provenance == "absent":
        return ("All values are whole numbers, consistent with read counts from a DADA2 run "
                "whose parameters were not recorded; how they entered MANTA was not recorded.")
    return ("All values are whole numbers, consistent with read counts; their origin was not "
            "recorded.")


def _transformed_detail(dataset_id: str) -> str:
    rows = _q("""
        MATCH (s:Sample {dataset_id:$d})-[r:HAS_ABUNDANCE]->()
        WITH s, sum(CASE WHEN r.count <> round(r.count) THEN 1 ELSE 0 END) AS frac_s,
             count(r) AS n_s
        RETURN sum(frac_s) AS frac, sum(n_s) AS n,
               sum(CASE WHEN frac_s > 0 THEN 1 ELSE 0 END) AS samples_frac, count(s) AS samples
        """, d=dataset_id)
    r = rows[0] if rows else {}
    frac, n = r.get("frac") or 0, r.get("n") or 0
    if n and frac == n:
        return ("Not one value in this dataset is a whole number, so something converted them "
                "before we received them. Shares are still comparable within a sample; calling "
                "them reads would be a guess.")
    return (f"{frac:,} of {n:,} values (in {r.get('samples_frac') or 0} of "
            f"{r.get('samples') or 0} samples) are not whole numbers; the rest look like read "
            f"counts. Something converted at least part of the values before we received them, "
            f"so the values as a whole cannot be called reads. Shares are still comparable "
            f"within a sample.")


def _capabilities(dataset_id: str) -> dict:
    ds = _q("MATCH (d:Dataset {dataset_id:$d}) RETURN coalesce(d.time_axis,'ordinal') AS time_axis, "
            "coalesce(d.value_kind,'unknown') AS value_kind, "
            "d.env_ignored_columns AS env_ignored, "
            "d.entry_point AS entry_point, d.dada2_provenance AS dada2_provenance, "
            "d.source_doi AS source_doi, d.citation AS citation, "
            "d.taxonomy_scope AS taxonomy_scope", d=dataset_id)
    if not ds:
        raise HTTPException(404, f"unknown dataset_id {dataset_id!r}")
    axis, kind = ds[0]["time_axis"], ds[0]["value_kind"]
    doi, cite = ds[0]["source_doi"], ds[0]["citation"]
    env_ignored = ds[0]["env_ignored"]
    nicht_erfasst = env_ignored is None

    counts = _q(
        """
        MATCH (a:ASV {dataset_id:$d})
        RETURN count(a) AS n_asv,
               sum(CASE WHEN a.sequence IS NOT NULL THEN 1 ELSE 0 END) AS n_sequence,
               sum(CASE WHEN a.louvain_label IS NOT NULL THEN 1 ELSE 0 END) AS n_network,
               sum(CASE WHEN a.kingdom IS NULL THEN 1 ELSE 0 END) AS n_no_lineage,
               sum(CASE WHEN a.kingdom IS NULL AND a.louvain_label IS NULL THEN 1 ELSE 0 END)
                   AS n_no_lineage_off_network
        """, d=dataset_id)[0]
    werte = _q("MATCH (a:ASV {dataset_id:$d}) RETURN "
               + ", ".join(f"a.{t} AS {t}" for t in TAXONOMY), d=dataset_id)
    for t in TAXONOMY:
        vorhanden = [w[t] for w in werte if w[t] is not None and str(w[t]).strip()]
        counts[t] = sum(1 for v in vorhanden if not semantics.is_taxon_placeholder(v))
        counts[f"{t}_placeholder"] = len(vorhanden) - counts[t]

    env_sel = ", ".join(f"sum(CASE WHEN s.`{p}` IS NOT NULL THEN 1 ELSE 0 END) AS `{p}`"
                        for p in ENV_PROPS)
    env = _q(f"MATCH (s:Sample {{dataset_id:$d}}) RETURN count(s) AS n_sample, {env_sel}",
             d=dataset_id)[0]
    env_have = [p for p in ENV_PROPS if (env.get(p) or 0) > 0]

    n_asv = counts["n_asv"] or 0
    deepest = [t for t in TAXONOMY if (counts[t] or 0) > 0]
    nur_netz = (bool(deepest) and (counts["n_no_lineage"] or 0) > 0
                and counts["n_no_lineage"] == counts["n_no_lineage_off_network"]
                and ds[0]["taxonomy_scope"] != "all_asvs")
    tiefster = deepest[-1] if deepest else None
    items = [
        {
            "key": "time_axis",
            "label": "Sampling dates",
            "available": axis == TIME_AXIS_DATES,
            "value": ("real calendar dates" if axis == TIME_AXIS_DATES
                      else "sample order only"),
            "detail": ("Month, year and season statements are possible."
                       if axis == TIME_AXIS_DATES else
                       "No metadata with sampling dates was supplied at import, so the samples "
                       "carry only their order. Month, year and season statements are hidden "
                       "because they would be invented, not measured."),
        },
        {
            "key": "value_kind",
            "label": "Values",
            "available": kind == "reads",
            "value": ("sequencing reads" if kind == "reads"
                      else "converted, method undocumented" if kind == "transformed"
                      else "unknown"),
            "detail": (_reads_origin(ds[0]["entry_point"], ds[0]["dada2_provenance"])
                       if kind == "reads" else
                       _transformed_detail(dataset_id) if kind == "transformed" else
                       "The kind of values was not determined at import."),
        },
        {
            "key": "taxonomy",
            "label": "Taxonomy",
            "available": bool(deepest),
            "value": (f"down to {deepest[-1]}" if deepest else "none"),
            "n": counts[deepest[-1]] if deepest else 0,
            "total": n_asv,
            "per_rank": {t: counts[t] or 0 for t in TAXONOMY},
            "per_rank_placeholder": {t: counts[f"{t}_placeholder"] for t in TAXONOMY},
            "lineage_network_only": nur_netz,
            "detail": ("No reference database was used in the run for this dataset, so the ASVs "
                       "carry no names — only their sequence identifies them."
                       if not deepest else
                       ("Assigned against a reference database. "
                        + (f"Of the {tiefster} entries, {counts[f'{tiefster}_placeholder']} are "
                           f"placeholders (uc, _X, _sp.) rather than names and are not counted. "
                           if counts[f"{tiefster}_placeholder"] else "")
                        + (f"{counts['n_no_lineage']} ASVs outside the network carry no lineage "
                           f"at all: for this dataset the lineage was loaded for the network ASVs "
                           f"only. That is a gap of the import, not of the reference database."
                           if nur_netz else
                           "Ranks left empty were not resolvable, which is normal for many "
                           "marine eukaryotes."))),
        },
        {
            "key": "sequence",
            "label": "Sequences",
            "available": (counts["n_sequence"] or 0) > 0,
            "value": f"{counts['n_sequence']} of {n_asv} ASVs",
            "n": counts["n_sequence"] or 0, "total": n_asv,
            "detail": ("The sequence is what an ASV actually is; it can be copied and BLASTed."
                       if (counts["n_sequence"] or 0) > 0 else
                       "This dataset came from a derived table rather than through our own "
                       "conversion step, which is where the sequences travel along. The ASV "
                       "identifiers therefore mean nothing outside this dataset."),
        },
        {
            "key": "network",
            "label": "CON network",
            "available": (counts["n_network"] or 0) > 0,
            "value": f"{counts['n_network'] or 0} ASVs",
            "n": counts["n_network"] or 0, "total": n_asv,
            "detail": ("ASVs outside the network have no link in it; their time series, taxonomy "
                       "and detail page are complete either way."),
        },
        {
            "key": "environment",
            "label": "Environmental data",
            "available": bool(env_have),
            "value": (f"{len(env_have)} of {len(ENV_PROPS)} variables" if env_have else "none"),
            "n": len(env_have), "total": len(ENV_PROPS),
            "n_sample": env["n_sample"],
            "detail": ((", ".join(f"{_ENV_LABEL[p]} ({env[p]}/{env['n_sample']} samples)"
                                  for p in env_have)
                        + ". Measured alongside the samples; shown as context, never derived "
                        "from the sequences. Samples without a value stay empty — nothing is "
                        "interpolated."
                        if env_have else
                        ("This dataset carries no environmental values. Whether its import "
                         "supplied other columns was not recorded (it predates that record), so "
                         "it cannot be said whether any were left out."
                         if nicht_erfasst else
                         "No environmental columns were supplied with this dataset, so there is "
                         "nothing to plot and nothing to overlay on the diversity curve. The "
                         "chain carries environmental data end to end; this import brought "
                         "none."))
                       + (f" Columns supplied but not taken over, because they are not "
                          f"environmental variables MANTA knows: {', '.join(env_ignored)}. "
                          f"Recognised names are: {', '.join(ENV_PROPS)}." if env_ignored else "")
                       + (" Columns supplied but not taken over were not recorded for this "
                          "import." if nicht_erfasst and env_have else "")),
            "ignored_columns": env_ignored,
        },
        {
            "key": "source",
            "label": "Source publication",
            "available": bool(cite or doi),
            "value": (cite or doi) if (cite or doi) else "not recorded",
            "detail": ((f"The raw data of this dataset come from: {cite or ''}"
                     + (f" DOI {doi}." if doi else "")
                     + " Recorded at import; MANTA does not derive it from the data.")
                    if (cite or doi) else
                    "No source publication is recorded for this dataset. That is not the same "
                    "as 'unpublished' — it means nobody stated one at import. MANTA does not "
                    "guess a source from the data, and the citation shown next to cluster and "
                    "edge definitions is the source of the METHOD, not of these data."),
            "doi": doi,
        },
    ]
    return {"dataset_id": dataset_id, "time_axis": axis, "value_kind": kind, "items": items}


@app.get("/datasets/{dataset_id}/capabilities", dependencies=[Depends(visible_dataset)])
def dataset_capabilities(dataset_id: str):
    return _capabilities(dataset_id)


@app.get("/datasets/{dataset_id}/environment", dependencies=[Depends(visible_dataset)])
def environment(dataset_id: str):
    if not _q("MATCH (d:Dataset {dataset_id:$d}) RETURN d.dataset_id", d=dataset_id):
        raise HTTPException(404, f"unknown dataset_id {dataset_id!r}")
    return semantics.environment(_q, dataset_id)


@app.get("/concepts")
def concepts(kind: str | None = None):
    import begriffe as _b
    try:
        eintraege = _b.alle(kind)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return {"concepts_version": _b.VERSION, "kinds": list(_b.KINDS), "kind": kind,
            "n": len(eintraege), "concepts": eintraege,
            **({"note": _b.TERMS_NOTE} if _b.TERMS_NOTE else {})}


@app.get("/datasets/{dataset_id}/applicability", dependencies=[Depends(visible_dataset)])
def applicability(dataset_id: str):
    if not _q("MATCH (d:Dataset {dataset_id:$d}) RETURN d.dataset_id", d=dataset_id):
        raise HTTPException(404, f"unknown dataset_id {dataset_id!r}")
    import anwendbarkeit as _anw
    import registry as _reg
    return {"dataset_id": dataset_id,
            "tools": _anw.applicability(_q, dataset_id, _reg.TOOL_SPECS),
            "conditions": {n: dict(zip(("met", "reason"), p(_q, dataset_id)))
                           for n, p in sorted(_anw.BEDINGUNGEN.items())},
            "time_structure": _anw.zeitstruktur(_q, dataset_id),
            "states": {"yes": "the dataset meets every precondition",
                       "no": "a precondition is not met; `reason` is the sentence the tool "
                             "itself gives",
                       "subject": "the dataset qualifies, but the answer still depends on the "
                                  "individual ASV or cluster — see `subject_condition`"}}


@app.get("/datasets/{dataset_id}/provenance-chain", dependencies=[Depends(visible_dataset)])
def provenance_chain(dataset_id: str):
    if not _q("MATCH (d:Dataset {dataset_id:$d}) RETURN d.dataset_id", d=dataset_id):
        raise HTTPException(404, f"unknown dataset_id {dataset_id!r}")
    return semantics.provenance_chain(_q, dataset_id)


@app.get("/datasets/{dataset_id}/seasons", dependencies=[Depends(visible_dataset)])
def seasons(dataset_id: str):
    if not _q("MATCH (d:Dataset {dataset_id:$d}) RETURN d.dataset_id", d=dataset_id):
        raise HTTPException(404, f"unknown dataset_id {dataset_id!r}")
    return semantics.seasons(_q, dataset_id)


@app.get("/datasets/{dataset_id}/light", dependencies=[Depends(visible_dataset)])
def light(dataset_id: str):
    if not _q("MATCH (d:Dataset {dataset_id:$d}) RETURN d.dataset_id", d=dataset_id):
        raise HTTPException(404, f"unknown dataset_id {dataset_id!r}")
    return semantics.light_bands(_q, dataset_id)


def _network_nodes(dataset_id):
    rows = _q(
        f"""
        MATCH (a:ASV {{dataset_id:$d}}) WHERE a.louvain_label IS NOT NULL
        RETURN a.id AS id, {", ".join(f"a.{t} AS {t}" for t in TAXONOMY)},
               a.louvain_label AS cluster, a.louvain_label_color AS color,
               a.read_count_total AS size, a.max_abundance_month AS peak_month,
               COUNT {{ (a)<-[h:HAS_ABUNDANCE]-(:Sample {{dataset_id:$d}}) WHERE h.count > 0 }}
                 AS n_samples_present,
               a.trait_function AS trait_function, a.trait_rank AS trait_rank,
               {", ".join(f"a.{c} AS {c}" for c in CENTRALITIES)}
        ORDER BY a.id
        """,
        d=dataset_id,
    )
    rel = _asv_rel_abundance(dataset_id)
    stars = _user_star_keys(dataset_id, "asv")
    for r in rows:
        r["rel_abundance"] = rel.get(r["id"], 0.0) if r["size"] is not None else None
        r["starred"] = r["id"] in stars
        r["trait_group"] = (semantics.trait_group_label(r["trait_function"])
                            if r.get("trait_function") else None)
    return rows


def _env_links(dataset_id: str) -> dict:
    run = semantics.env_link_run(_q, dataset_id)
    variables = _q("MATCH (v:EnvVariable {dataset_id:$d}) "
                   "RETURN v.name AS name, v.label AS label, v.unit AS unit, v.n_values AS n_values, "
                   "COUNT { (v)-[:COVARIES_WITH {dataset_id:$d}]->(:ASV {dataset_id:$d}) } AS n_links, "
                   "COUNT { (v)-[:COVARIES_WITH {dataset_id:$d}]->(a:ASV {dataset_id:$d}) WHERE a.louvain_label IS NOT NULL } AS n_links_network "
                   "ORDER BY v.name", d=dataset_id)
    edges = _q("MATCH (v:EnvVariable {dataset_id:$d})-[c:COVARIES_WITH {dataset_id:$d}]->(a:ASV {dataset_id:$d}) "
               "WHERE a.louvain_label IS NOT NULL "
               "RETURN v.name AS variable, a.id AS target, c.lag AS lag, c.r AS r, c.r0 AS r0, "
               "c.p_adj AS p_adj, c.n AS n ORDER BY v.name, a.id", d=dataset_id)
    return {"run": run, "variables": variables, "edges": edges,
            "n_links_network": len(edges),
            "n_asv_network": len({e["target"] for e in edges})}


def _layers(dataset_id: str) -> dict:
    r = _q(
        """
        MATCH (a:ASV {dataset_id:$d})-[c:CO_OCCURS_WITH {dataset_id:$d}]->(b:ASV {dataset_id:$d})
        WITH size([(a)-[f:INFLUENCES {dataset_id:$d}]->(b) | f])
           + size([(b)-[k:INFLUENCES {dataset_id:$d}]->(a) | k]) AS dirs
        RETURN count(*) AS n_con,
               sum(CASE WHEN dirs > 0 THEN 1 ELSE 0 END) AS n_con_with_ccm,
               sum(dirs) AS n_ccm_directions,
               sum(CASE WHEN dirs = 2 THEN 1 ELSE 0 END) AS n_con_both_directions
        """,
        d=dataset_id,
    )
    n_asv_con = _q(
        "MATCH (a:ASV {dataset_id:$d})-[:CO_OCCURS_WITH {dataset_id:$d}]-(:ASV {dataset_id:$d}) "
        "RETURN count(DISTINCT a) AS n", d=dataset_id)
    n_asv_ccm = _q(
        "MATCH (a:ASV {dataset_id:$d})-[:CO_OCCURS_WITH {dataset_id:$d}]-(b:ASV {dataset_id:$d}) "
        "WHERE size([(a)-[f:INFLUENCES {dataset_id:$d}]->(b) | f]) "
        "    + size([(b)-[k:INFLUENCES {dataset_id:$d}]->(a) | k]) > 0 "
        "RETURN count(DISTINCT a) AS n", d=dataset_id)
    out = dict(r[0]) if r else {"n_con": 0, "n_con_with_ccm": 0, "n_ccm_directions": 0,
                                "n_con_both_directions": 0}
    out["n_asv_con"] = n_asv_con[0]["n"] if n_asv_con else 0
    out["n_asv_ccm"] = n_asv_ccm[0]["n"] if n_asv_ccm else 0
    rej = _q(
        """
        MATCH (a:ASV {dataset_id:$d})-[c:CO_OCCURS_WITH {dataset_id:$d}]->(b:ASV {dataset_id:$d})
        WITH size([(a)-[f:CCM_REJECTED {dataset_id:$d}]->(b) | f])
           + size([(b)-[k:CCM_REJECTED {dataset_id:$d}]->(a) | k]) AS rejected
        RETURN sum(rejected) AS n_ccm_rejected,
               sum(CASE WHEN rejected > 0 THEN 1 ELSE 0 END) AS n_con_with_rejected
        """, d=dataset_id)
    n_asv_rej = _q(
        "MATCH (a:ASV {dataset_id:$d})-[:CO_OCCURS_WITH {dataset_id:$d}]-(b:ASV {dataset_id:$d}) "
        "WHERE size([(a)-[f:CCM_REJECTED {dataset_id:$d}]->(b) | f]) "
        "    + size([(b)-[k:CCM_REJECTED {dataset_id:$d}]->(a) | k]) > 0 "
        "RETURN count(DISTINCT a) AS n", d=dataset_id)
    tested = _q("MATCH (r:Run {dataset_id:$d}) WHERE r.ccm_tested_directions IS NOT NULL "
                "RETURN r.ccm_tested_directions AS n "
                "ORDER BY coalesce(r.computed_at, '') DESC, r.run_id LIMIT 1", d=dataset_id)
    out["n_ccm_rejected"] = (rej[0]["n_ccm_rejected"] or 0) if rej else 0
    out["n_con_with_rejected"] = (rej[0]["n_con_with_rejected"] or 0) if rej else 0
    out["n_asv_rejected"] = n_asv_rej[0]["n"] if n_asv_rej else 0
    out["n_ccm_tested"] = tested[0]["n"] if tested else None
    out["ccm_tested_recorded"] = bool(tested)
    return out


@app.get("/datasets/{dataset_id}/network", dependencies=[Depends(visible_dataset)])
def network(dataset_id: str, edge: str = Query("con", pattern="^(con|ccm)$"), marker: str | None = None):
    if marker is not None:
        ds = _q("MATCH (d:Dataset {dataset_id:$d}) RETURN d.marker AS m", d=dataset_id)
        if not ds or ds[0]["m"] != marker:
            raise HTTPException(404, f"no {marker!r} network for dataset_id={dataset_id!r}")
    nodes = _network_nodes(dataset_id)
    if not nodes:
        raise HTTPException(404, f"no network for dataset_id={dataset_id!r}")
    if edge == "con":
        edges = _q(
            """
            MATCH (a:ASV {dataset_id:$d})-[r:CO_OCCURS_WITH {dataset_id:$d}]->(b:ASV {dataset_id:$d})
            RETURN a.id AS source, b.id AS target, r.corr AS corr, r.p_value AS p_value,
                   r.p_adj_fdr AS p_adj_fdr,
                   size([(a)-[f:INFLUENCES {dataset_id:$d}]->(b) | f]) AS ccm_forward,
                   size([(b)-[k:INFLUENCES {dataset_id:$d}]->(a) | k]) AS ccm_backward,
                   reduce(m = null, x IN [(a)-[f:INFLUENCES {dataset_id:$d}]->(b) | f.nmi] |
                          CASE WHEN m IS NULL OR x > m THEN x ELSE m END) AS nmi_forward,
                   reduce(m = null, x IN [(b)-[k:INFLUENCES {dataset_id:$d}]->(a) | k.nmi] |
                          CASE WHEN m IS NULL OR x > m THEN x ELSE m END) AS nmi_backward,
                   size([(a)-[f:CCM_REJECTED {dataset_id:$d}]->(b) | f]) AS rejected_forward,
                   size([(b)-[k:CCM_REJECTED {dataset_id:$d}]->(a) | k]) AS rejected_backward,
                   reduce(m = null, x IN [(a)-[f:CCM_REJECTED {dataset_id:$d}]->(b) | f.nmi] |
                          CASE WHEN m IS NULL OR x > m THEN x ELSE m END) AS nmi_rejected_forward,
                   reduce(m = null, x IN [(b)-[k:CCM_REJECTED {dataset_id:$d}]->(a) | k.nmi] |
                          CASE WHEN m IS NULL OR x > m THEN x ELSE m END) AS nmi_rejected_backward
            ORDER BY source, target
            """,
            d=dataset_id,
        )
        for e in edges:
            e["ccm_dirs"] = (e["ccm_forward"] or 0) + (e["ccm_backward"] or 0)
            e["ccm_forward"] = bool(e["ccm_forward"])
            e["ccm_backward"] = bool(e["ccm_backward"])
            e["rejected_dirs"] = (e["rejected_forward"] or 0) + (e["rejected_backward"] or 0)
            e["rejected_forward"] = bool(e["rejected_forward"])
            e["rejected_backward"] = bool(e["rejected_backward"])
        directed = False
    else:
        edges = _q(
            """
            MATCH (a:ASV {dataset_id:$d})-[r:INFLUENCES {dataset_id:$d}]->(b:ASV {dataset_id:$d})
            RETURN a.id AS source, b.id AS target, r.nmi AS nmi, r.p_value AS p_value,
                   r.from_clu AS from_clu, r.to_clu AS to_clu
            ORDER BY source, target
            """,
            d=dataset_id,
        )
        directed = True
    _lab = {n["id"]: n["cluster"] for n in nodes if n.get("cluster") is not None}
    _parent = {n: n for n in _lab}

    def _find(x):
        while _parent[x] != x:
            _parent[x] = _parent[_parent[x]]
            x = _parent[x]
        return x

    for _e in edges:
        _a, _b = _e["source"], _e["target"]
        if _a in _parent and _b in _parent:
            _ra, _rb = _find(_a), _find(_b)
            if _ra != _rb:
                _parent[_ra] = _rb
    _n_comp = len({_find(n) for n in _lab})
    _crossing = sum(1 for _e in edges
                    if _lab.get(_e["source"]) is not None
                    and _lab.get(_e["target"]) is not None
                    and _lab[_e["source"]] != _lab[_e["target"]])
    partition = {
        "n_clusters": len(set(_lab.values())),
        "n_components": _n_comp,
        "n_crossing_edges": _crossing,
        "clusters_are_components": _crossing == 0,
    }

    n_samples = _q("MATCH (s:Sample {dataset_id:$d}) RETURN count(s) AS n", d=dataset_id)
    thr = _thresholds(dataset_id)
    c2 = semantics.criterion2(_q, dataset_id)
    for n in nodes:
        n["criterion2"] = c2["nodes"].get(n["id"])
    return {"dataset_id": dataset_id, "marker": marker, "edge": edge, "directed": directed,
            "partition": partition,
            "n_samples": n_samples[0]["n"] if n_samples else 0,
            "criterion2": semantics.criterion2_summary(c2),
            "edge_width_legend": semantics.EDGE_WIDTH_LEGEND,
            "edge_width_scale": semantics.edge_width_scale(thr),
            "thresholds": thr, "layers": _layers(dataset_id),
            "traits": semantics.trait_run(_q, dataset_id),
            "env_links": _env_links(dataset_id),
            "value_declaration": {
                **semantics.value_declaration(_q, dataset_id, semantics.frame_summed(_q, dataset_id)),
                "applies_to": "nodes[].size",
            },
            "nodes": nodes, "edges": edges}


def _asv_brief(dataset_id: str, asv_id: str) -> dict | None:
    rows = _q(
        f"""
        MATCH (a:ASV {{id:$id, dataset_id:$d}})
        RETURN a.id AS id, {", ".join(f"a.{t} AS {t}" for t in TAXONOMY)},
               a.louvain_label AS cluster,
               a.sequence IS NOT NULL AS has_sequence
        """,
        d=dataset_id, id=asv_id,
    )
    if not rows:
        return None
    n = rows[0]
    freq = semantics.frequency(_q, dataset_id, semantics.series(_q, dataset_id, asv_id),
                               with_rank=True)
    return {"id": n["id"], "lineage": {t: n[t] for t in TAXONOMY}, "cluster": n["cluster"],
            "has_sequence": n["has_sequence"], "summary": freq["summary"]}


@app.get("/datasets/{dataset_id}/cluster-timeseries", dependencies=[Depends(visible_dataset)])
def cluster_timeseries(dataset_id: str):
    data = semantics.cluster_timeseries(_q, dataset_id)
    if data is None:
        if not _q("MATCH (d:Dataset {dataset_id:$d}) RETURN d", d=dataset_id):
            raise HTTPException(404, f"unknown dataset_id {dataset_id!r}")
        raise HTTPException(404, f"no network for dataset_id={dataset_id!r}")
    return data


@app.get("/datasets/{dataset_id}/asv/{asv_id}/spectrum", dependencies=[Depends(visible_dataset)])
def asv_spectrum(dataset_id: str, asv_id: str):
    sp = semantics.spectrum(_q, dataset_id, asv_id)
    if sp is None:
        raise HTTPException(404, f"ASV {asv_id!r} not in dataset_id={dataset_id!r}")
    return {"dataset_id": dataset_id, "asv_id": asv_id, "spectrum": sp,
            "value_declaration": {**semantics.value_declaration(_q, dataset_id, "the whole series, in sample order"),
                                  "applies_to": "spectrum.amplitudes (input scale of the run)"}}


@app.get("/datasets/{dataset_id}/edge", dependencies=[Depends(visible_dataset)])
def edge_detail(dataset_id: str, source: str, target: str,
                type: str = Query("con", pattern="^(con|ccm)$")):
    rel, directed = ("CO_OCCURS_WITH", False) if type == "con" else ("INFLUENCES", True)
    extra = ("r.p_adj_fdr AS p_adj_fdr" if type == "con"
             else "r.from_clu AS from_clu, r.to_clu AS to_clu")
    val = "corr" if type == "con" else "nmi"
    arrow = "->" if directed else "-"
    rows = _q(
        f"""
        MATCH (a:ASV {{id:$s, dataset_id:$d}})-[r:{rel} {{dataset_id:$d}}]{arrow}(b:ASV {{id:$t, dataset_id:$d}})
        RETURN r.{val} AS {val}, r.p_value AS p_value, r.run_id AS run_id, {extra}
        """,
        d=dataset_id, s=source, t=target,
    )
    if not rows:
        raise HTTPException(404, f"no {type.upper()} edge {source!r} -> {target!r} "
                                 f"in dataset_id={dataset_id!r}")
    e = rows[0]

    a, b = _asv_brief(dataset_id, source), _asv_brief(dataset_id, target)
    if a is None or b is None:
        raise HTTPException(404, "an endpoint of this edge no longer exists")

    reverse = None
    if directed:
        rev = _q("MATCH (:ASV {id:$t, dataset_id:$d})-[r:INFLUENCES {dataset_id:$d}]->(:ASV {id:$s, dataset_id:$d}) "
                 "RETURN r.nmi AS nmi, r.p_value AS p_value", d=dataset_id, s=source, t=target)
        reverse = rev[0] if rev else None

    directions = {"forward": semantics.ccm_direction(_q, dataset_id, source, target),
                  "backward": semantics.ccm_direction(_q, dataset_id, target, source)}

    dist = _q(f"MATCH (:ASV {{dataset_id:$d}})-[r:{rel} {{dataset_id:$d}}]->(:ASV {{dataset_id:$d}}) "
              f"RETURN count(r) AS n, min(r.{val}) AS lo, max(r.{val}) AS hi, "
              f"sum(CASE WHEN r.{val} > $c THEN 1 ELSE 0 END) AS n_stronger",
              d=dataset_id, c=e[val])[0]

    pattern = None
    if type == "con":
        thr_p = _thresholds(dataset_id)
        fc = int(thr_p.get("fft_coeffs") or 14)
        sa = semantics.series(_q, dataset_id, source)
        sb = semantics.series(_q, dataset_id, target)
        axis_p = _time_axis(dataset_id)
        pattern = {
            "n_rhythms": fc - 1,
            "fft_coeffs": fc,
            "recorded": thr_p["recorded"],
            "time_axis": axis_p,
            "samples": [{"sample": r["sample"],
                         "date": r["date"] if axis_p == TIME_AXIS_DATES else None} for r in sa],
            "source_raw": [r["count"] for r in sa],
            "target_raw": [r["count"] for r in sb],
            "source_pattern": semantics.fourier_pattern([r["count"] for r in sa], fc),
            "target_pattern": semantics.fourier_pattern([r["count"] for r in sb], fc),
            "method": (f"CON correlates the Fourier coefficients 1–{fc - 1} of the two "
                       f"series (real and imaginary part, {2 * (fc - 1)} numbers per ASV; the "
                       f"constant offset is excluded) with Pearson. The bold curves are the "
                       f"series rebuilt from exactly those coefficients — the pattern the "
                       f"correlation could see."),
            "caveat": ("The FFT runs on the sample ORDER and assumes equal spacing; the real "
                       "gaps between samples are uneven. Curves are drawn scaled to their own "
                       "maximum — Pearson is scale-invariant, magnitudes are not compared."),
        }

    both = _q("MATCH (s:Sample {dataset_id:$d})-[x:HAS_ABUNDANCE]->(:ASV {id:$s, dataset_id:$d}) "
              "MATCH (s)-[y:HAS_ABUNDANCE]->(:ASV {id:$t, dataset_id:$d}) "
              "WHERE x.count > 0 AND y.count > 0 RETURN count(DISTINCT s) AS n",
              d=dataset_id, s=source, t=target)
    n_samples = _q("MATCH (s:Sample {dataset_id:$d}) RETURN count(s) AS n", d=dataset_id)

    return {
        "dataset_id": dataset_id, "type": type, "directed": directed,
        "value_declaration": {
            **semantics.value_declaration(_q, dataset_id, "within one sample"),
            "applies_to": "source_raw/target_raw",
        },
        "source": a, "target": b,
        "edge": {k: v for k, v in e.items() if k != "run_id"},
        "run_id": e.get("run_id"),
        "reverse": reverse,
        "directions": directions,
        "ccm_tested_recorded": semantics.ccm_tested_recorded(_q, dataset_id),
        "decision_note": semantics.CCM_DECISION_NOTE,
        "cross_cluster": a["cluster"] is not None and a["cluster"] != b["cluster"],
        "strength_context": {"n_edges": dist["n"], "min_strength": dist["lo"],
                             "max_strength": dist["hi"], "n_stronger": dist["n_stronger"],
                             "rank": (dist["n_stronger"] or 0) + 1},
        "co_detected_in": (both[0]["n"] if both else 0),
        "n_samples": (n_samples[0]["n"] if n_samples else 0),
        "pattern": pattern,
        "ccm_p_resolution": semantics.ccm_p_resolution(_q, dataset_id),
        "thresholds": _thresholds(dataset_id),
        "source_publication": {"citation": semantics.SOURCE_PUBLICATION,
                               "doi": semantics.SOURCE_PUBLICATION_DOI},
    }


TIME_AXIS_DATES = semantics.TIME_AXIS_DATES
TIME_AXIS_ORDINAL = semantics.TIME_AXIS_ORDINAL
MONTHS = semantics.MONTHS

_ym = semantics.ym
_seasonal_stats = semantics.seasonal_stats
_climatology = semantics.climatology


def _quantity(dataset_id: str) -> dict:
    return semantics.quantity(_q, dataset_id)


def _value_kind(dataset_id: str) -> str:
    return semantics.value_kind(_q, dataset_id)


def _time_axis(dataset_id: str) -> str:
    return semantics.time_axis(_q, dataset_id)


def _series(dataset_id, asv_id):
    return semantics.series(_q, dataset_id, asv_id)




@app.get("/datasets/{dataset_id}/asv/{asv_id}", dependencies=[Depends(visible_dataset)])
def asv_detail(dataset_id: str, asv_id: str):
    node = _q(
        f"""
        MATCH (a:ASV {{id:$id, dataset_id:$d}})
        RETURN a.id AS id, {", ".join(f"a.{t} AS {t}" for t in TAXONOMY)},
               a.louvain_label AS cluster, a.louvain_label_color AS color,
               a.read_count_total AS read_count_total, a.max_abundance_month AS peak_month,
               a.sequence AS sequence, a.seq_hash AS seq_hash,
               a.fft_amplitudes IS NOT NULL AS has_fft,
               {", ".join(f"a.{c} AS {c}" for c in CENTRALITIES)}
        """,
        d=dataset_id, id=asv_id,
    )
    if not node:
        raise HTTPException(404, f"ASV {asv_id!r} not in dataset_id={dataset_id!r}")
    node = node[0]

    series = _series(dataset_id, asv_id)
    axis = _time_axis(dataset_id)
    if axis == TIME_AXIS_DATES:
        seasonal = {"seasonal": _seasonal_stats(series, "share")}
        seasonal.update(_climatology(series, "count"))
        sh = _climatology(series, "share")
        seasonal["climatology_share"] = sh["climatology"]
        seasonal["by_year_share"] = sh["by_year"]
        seasonal["annual_mean_share"] = sh["annual_mean"]
        seasonal["trend_per_year_share"] = sh["trend_per_year"]
    else:
        seasonal = {"climatology": None, "by_year": None, "annual_mean": None, "trend_per_year": None,
                    "climatology_share": None, "by_year_share": None,
                    "annual_mean_share": None, "trend_per_year_share": None, "seasonal": None}
    counts = [row["count"] for row in series]
    by_year: dict[str, list[float]] = {}
    for row in series:
        by_year.setdefault((row["date"] or "")[:4], []).append(row["count"])
    n = len(counts) or 1
    mean = sum(counts) / n
    xs = list(range(len(counts)))
    if len(counts) >= 2:
        mx = sum(xs) / len(xs)
        my = mean
        denom = sum((x - mx) ** 2 for x in xs) or 1.0
        slope = sum((x - mx) * (c - my) for x, c in zip(xs, counts)) / denom
    else:
        slope = 0.0

    con_n = _q("MATCH (:ASV {id:$id, dataset_id:$d})-[r:CO_OCCURS_WITH {dataset_id:$d}]-(b:ASV) "
               "RETURN b.id AS id, b.genus AS genus, b.louvain_label AS cluster, "
               "max(r.corr) AS corr, min(r.p_value) AS p_value ORDER BY id", d=dataset_id, id=asv_id)
    ccm_n = _q("MATCH (a:ASV {id:$id, dataset_id:$d})-[r:INFLUENCES {dataset_id:$d}]-(b:ASV) "
               "RETURN b.id AS id, b.genus AS genus, b.louvain_label AS cluster, "
               "max(r.nmi) AS nmi, min(r.p_value) AS p_value, "
               "sum(CASE WHEN startNode(r) = a THEN 1 ELSE 0 END) AS raus, "
               "sum(CASE WHEN endNode(r) = a THEN 1 ELSE 0 END) AS rein "
               "ORDER BY id", d=dataset_id, id=asv_id)
    for n in ccm_n:
        raus, rein = n.pop("raus"), n.pop("rein")
        n["direction"] = ("both" if raus and rein else "out" if raus else "in" if rein else None)
    meine_notiz = _note_for(dataset_id, "asv", asv_id)

    return {
        "id": node["id"], "dataset_id": dataset_id,
        "starred": asv_id in _user_star_keys(dataset_id, "asv"),
        "network_scope": (scope := _network_scope(dataset_id)),
        "in_network_run": (True if node["cluster"] is not None or node["has_fft"] else
                           False if scope.get("basis") == "fft_table" else
                           True if scope.get("recorded") and scope.get("subset") is False else
                           None),
        "frequency": semantics.frequency(_q, dataset_id, series, with_rank=True),
        "capabilities": _capabilities(dataset_id),
        "lineage": {t: node[t] for t in TAXONOMY},
        "cluster": node["cluster"], "color": node["color"],
        "sequence": node["sequence"],
        "seq_length": len(node["sequence"]) if node["sequence"] else None,
        "seq_hash": node["seq_hash"],
        "note": meine_notiz["text"], "note_at": meine_notiz["at"],
        "centralities": {c: node[c] for c in CENTRALITIES},
        "environment_profile": semantics.environment_profile(_q, dataset_id, asv_id),
        "spectrum": semantics.spectrum(_q, dataset_id, asv_id),
        "abundance": {
            "series": series,
            "mean": mean,
            "read_count_total": node["read_count_total"],
            "peak_month": node["peak_month"] if axis == TIME_AXIS_DATES else None,
            "per_year": {y: (sum(v) / len(v)) for y, v in sorted(by_year.items()) if y}
                        if axis == TIME_AXIS_DATES else {},
            "variability_std": statistics.pstdev(counts) if len(counts) > 1 else 0.0,
            "trend_slope_per_sample": slope,
            "time_axis": axis,
            "quantity": _quantity(dataset_id),
            **seasonal,
        },
        "neighbors": {"con": con_n, "ccm": ccm_n},
        "criterion2": semantics.criterion2_asv(semantics.criterion2(_q, dataset_id), asv_id),
        "funktion": "Not derivable from amplicon data.",
        "trait": semantics.asv_trait(_q, dataset_id, asv_id),
        "trait_run": semantics.trait_run(_q, dataset_id),
        "drivers": semantics.asv_drivers(_q, dataset_id, asv_id),
        "bild": None,
    }


@app.get("/datasets/{dataset_id}/network.fasta", dependencies=[Depends(visible_dataset)])
def network_fasta(dataset_id: str):
    rows = _q("MATCH (a:ASV {dataset_id:$d}) WHERE a.louvain_label IS NOT NULL "
              "AND a.sequence IS NOT NULL "
              "RETURN a.id AS id, a.genus AS genus, a.sequence AS seq ORDER BY a.id", d=dataset_id)
    if not rows:
        raise HTTPException(404, f"no sequences stored for dataset_id={dataset_id!r} "
                                 f"(only datasets with an id_map.csv from convert.py have them)")
    body = "".join(f">{r['id']} {r['genus'] or 'unassigned'}\n{r['seq']}\n" for r in rows)
    return Response(content=body, media_type="text/plain",
                    headers={"Content-Disposition": f'attachment; filename="{dataset_id}_network.fasta"'})


@app.get("/datasets/{dataset_id}/cluster-network", dependencies=[Depends(visible_dataset)])
def cluster_network(dataset_id: str):
    if not _q("MATCH (d:Dataset {dataset_id:$d}) RETURN d", d=dataset_id):
        raise HTTPException(404, f"unknown dataset_id {dataset_id!r}")
    return {"dataset_id": dataset_id, **semantics.cluster_network(_q, dataset_id)}


@app.get("/datasets/{dataset_id}/interannual", dependencies=[Depends(visible_dataset)])
def interannual(dataset_id: str, metric: str = "jaccard"):
    if metric not in semantics.INTERANNUAL_METRICS:
        raise HTTPException(400, f"metric must be one of {sorted(semantics.INTERANNUAL_METRICS)}")
    if not _q("MATCH (d:Dataset {dataset_id:$d}) RETURN d", d=dataset_id):
        raise HTTPException(404, f"unknown dataset_id {dataset_id!r}")
    return {"dataset_id": dataset_id, **semantics.interannual_variability(_q, dataset_id, metric)}


@app.get("/datasets/{dataset_id}/cluster-year", dependencies=[Depends(visible_dataset)])
def cluster_year(dataset_id: str, metric: str = "jaccard"):
    if metric not in semantics.INTERANNUAL_METRICS:
        raise HTTPException(400, f"metric must be one of {sorted(semantics.INTERANNUAL_METRICS)}")
    if not _q("MATCH (d:Dataset {dataset_id:$d}) RETURN d", d=dataset_id):
        raise HTTPException(404, f"unknown dataset_id {dataset_id!r}")
    return {"dataset_id": dataset_id, **semantics.cluster_year_overview(_q, dataset_id, metric)}


@app.get("/datasets/{dataset_id}/cluster/{louvain_label}", dependencies=[Depends(visible_dataset)])
def cluster(dataset_id: str, louvain_label: int):
    members = _q(
        """
        MATCH (a:ASV {dataset_id:$d}) WHERE a.louvain_label = $l
        RETURN a.id AS id, a.genus AS genus, a.family AS family,
               a.read_count_total AS read_count_total,
               COUNT { (a)<-[:HAS_ABUNDANCE]-(:Sample) } AS n_samples_present,
               a.max_abundance_month AS peak_month
        ORDER BY a.id
        """,
        d=dataset_id, l=louvain_label,
    )
    if not members:
        raise HTTPException(404, f"no cluster {louvain_label} in dataset_id={dataset_id!r}")

    collective = _q(
        """
        MATCH (s:Sample {dataset_id:$d})
        OPTIONAL MATCH (s)-[all:HAS_ABUNDANCE]->(:ASV {dataset_id:$d})
        WITH s, sum(all.count) AS live_total
        WITH s, coalesce(s.analysed_reads_total, live_total) AS sample_total
        OPTIONAL MATCH (s)-[r:HAS_ABUNDANCE]->(a:ASV {dataset_id:$d}) WHERE a.louvain_label = $l
        WITH s, sample_total, sum(coalesce(r.count, 0.0)) AS sum_count
        RETURN s.sample_id AS sample, toString(s.date) AS date,
               sum_count, coalesce(sample_total, 0.0) AS sample_total
        ORDER BY s.date, s.same_day_index, s.ordinal_index, s.sample_id
        """,
        d=dataset_id, l=louvain_label,
    )
    for r in collective:
        tot = r["sample_total"] or 0.0
        r["share"] = (r["sum_count"] / tot) if tot > 0 else None

    ids = [m["id"] for m in members]
    coh = _q("""
        MATCH (a:ASV {dataset_id:$d})-[r:CO_OCCURS_WITH {dataset_id:$d}]->(b:ASV {dataset_id:$d})
        WHERE a.louvain_label = $l OR b.louvain_label = $l
        RETURN sum(CASE WHEN a.louvain_label = $l AND b.louvain_label = $l THEN 1 ELSE 0 END) AS innen,
               sum(CASE WHEN a.louvain_label = $l AND b.louvain_label = $l THEN 0 ELSE 1 END) AS aussen,
               avg(CASE WHEN a.louvain_label = $l AND b.louvain_label = $l THEN r.corr END) AS corr_innen,
               avg(CASE WHEN a.louvain_label = $l AND b.louvain_label = $l THEN null ELSE r.corr END) AS corr_aussen
        """, d=dataset_id, l=louvain_label)
    cohesion = coh[0] if coh else {"innen": 0, "aussen": 0, "corr_innen": None, "corr_aussen": None}

    partners = _q("""
        MATCH (a:ASV {dataset_id:$d})-[r:CO_OCCURS_WITH {dataset_id:$d}]->(b:ASV {dataset_id:$d})
        WHERE (a.louvain_label = $l) <> (b.louvain_label = $l)
        WITH CASE WHEN a.louvain_label = $l THEN b.louvain_label ELSE a.louvain_label END AS partner,
             count(*) AS kanten
        RETURN partner, kanten ORDER BY kanten DESC, partner
        """, d=dataset_id, l=louvain_label)
    gerichtet = {r["partner"]: r for r in _q("""
        MATCH (a:ASV {dataset_id:$d})-[r:INFLUENCES {dataset_id:$d}]->(b:ASV {dataset_id:$d})
        WHERE (a.louvain_label = $l) <> (b.louvain_label = $l)
        WITH CASE WHEN a.louvain_label = $l THEN b.louvain_label ELSE a.louvain_label END AS partner,
             sum(CASE WHEN a.louvain_label = $l THEN 1 ELSE 0 END) AS raus,
             sum(CASE WHEN a.louvain_label = $l THEN 0 ELSE 1 END) AS rein
        RETURN partner, raus, rein ORDER BY partner
        """, d=dataset_id, l=louvain_label)}
    for p in partners:
        g = gerichtet.get(p["partner"]) or {}
        p["gerichtet_raus"] = int(g.get("raus") or 0)
        p["gerichtet_rein"] = int(g.get("rein") or 0)
    bridge_edges = _q("""
        MATCH (a:ASV {dataset_id:$d})-[r:CO_OCCURS_WITH {dataset_id:$d}]->(b:ASV {dataset_id:$d})
        WHERE (a.louvain_label = $l) <> (b.louvain_label = $l)
        WITH CASE WHEN a.louvain_label = $l THEN a ELSE b END AS mine,
             CASE WHEN a.louvain_label = $l THEN b ELSE a END AS other, r
        RETURN mine.id AS mine, mine.genus AS mine_genus,
               other.id AS other, other.genus AS other_genus,
               other.louvain_label AS other_cluster, r.corr AS corr
        ORDER BY r.corr DESC, mine, other LIMIT 50
        """, d=dataset_id, l=louvain_label)

    genus_b: dict[str, int] = {}
    family_b: dict[str, int] = {}
    month_h: dict[str, int] = {}
    for m in members:
        genus_b[m["genus"]] = genus_b.get(m["genus"], 0) + 1
        family_b[m["family"]] = family_b.get(m["family"], 0) + 1
        if m["peak_month"] is not None:
            month_h[str(m["peak_month"])] = month_h.get(str(m["peak_month"]), 0) + 1

    axis = _time_axis(dataset_id)
    c2 = semantics.criterion2(_q, dataset_id)
    for m in members:
        m["criterion2"] = c2["nodes"].get(m["id"])
    return {
        "dataset_id": dataset_id, "louvain_label": louvain_label,
        "criterion2": semantics.criterion2_module(c2, louvain_label),
        "starred": str(louvain_label) in _user_star_keys(dataset_id, "cluster"),
        "frequency": semantics.frequency(_q, dataset_id, collective, with_rank=False),
        "environment_profile": semantics.cluster_environment_profile(_q, dataset_id, louvain_label),
        "members": members,
        "taxa_breakdown": {"genus": genus_b, "family": family_b},
        "function_breakdown": semantics.cluster_functions(_q, dataset_id, louvain_label),
        "trait_run": semantics.trait_run(_q, dataset_id),
        "env_links": semantics.cluster_env_links(_q, dataset_id, louvain_label),
        "collective_series": collective,
        "peak_month_hist": month_h,
        "quantity": _quantity(dataset_id),
        "time_axis": axis,
        "bridge_edges": bridge_edges,
        "activity": semantics.activity(semantics.frequency(_q, dataset_id, collective, with_rank=False)),
        "source_publication": {"citation": semantics.SOURCE_PUBLICATION,
                               "doi": semantics.SOURCE_PUBLICATION_DOI},
        "seasonal": _seasonal_stats(collective, "share") if axis == TIME_AXIS_DATES else None,
        "note": _cluster_note(dataset_id, louvain_label),
        "cohesion": cohesion,
        "bridge_partners": partners,
    }


def _cluster_note(dataset_id: str, louvain_label: int) -> dict:
    lauf = _q("MATCH (c:Cluster {louvain_label:$l, dataset_id:$d}) "
              "RETURN c.run_id AS run_id ORDER BY c.run_id DESC LIMIT 1",
              d=dataset_id, l=louvain_label)
    run_id = lauf[0]["run_id"] if lauf else None
    if run_id is None:
        return {"n": None, "t": None, "run_id": None}
    n = _note_for(dataset_id, "cluster", str(louvain_label), run_id=run_id)
    return {"n": n["text"], "t": n["at"], "run_id": run_id}




@app.get("/datasets/{dataset_id}/wheel", dependencies=[Depends(visible_dataset)])
def wheel(dataset_id: str, year: str | None = Query(None)):
    labels = [r["l"] for r in _q(
        "MATCH (a:ASV {dataset_id:$d}) WHERE a.louvain_label IS NOT NULL "
        "RETURN DISTINCT a.louvain_label AS l ORDER BY l", d=dataset_id)]
    if not labels:
        raise HTTPException(404, f"no network for dataset_id={dataset_id!r}")
    axis = _time_axis(dataset_id)

    base = {"dataset_id": dataset_id, "time_axis": axis, "months": semantics.MONTHS,
            "quantity": semantics.quantity(_q, dataset_id),
            "source_publication": {"citation": semantics.SOURCE_PUBLICATION,
                                   "doi": semantics.SOURCE_PUBLICATION_DOI}}
    if axis != semantics.TIME_AXIS_DATES:
        return {**base, "clusters": [], "environment": None,
                "absent_reason": ("This dataset has no calendar dates — the samples are ordered, "
                                  "not dated. A year wheel would place its clusters into months "
                                  "nobody measured, so there is none.")}

    years = semantics.sample_years(_q, dataset_id)
    base["years"] = years
    base["year"] = None
    if year is not None:
        sel = next((y for y in years if y["year"] == year), None)
        if sel is None:
            raise HTTPException(422, f"unknown year {year!r} for dataset_id={dataset_id!r} "
                                     f"— available: {[y['year'] for y in years]}")
        base["year"] = sel

    samples = _q(
        """
        MATCH (s:Sample {dataset_id:$d})
        OPTIONAL MATCH (s)-[all:HAS_ABUNDANCE]->(:ASV {dataset_id:$d})
        WITH s, coalesce(sum(all.count), 0.0) AS live_total
        RETURN s.sample_id AS sample, toString(s.date) AS date,
               coalesce(s.analysed_reads_total, live_total) AS total
        ORDER BY s.date, s.same_day_index, s.ordinal_index, s.sample_id
        """, d=dataset_id)
    if year is not None:
        samples = [s for s in samples if str(s["date"]).startswith(year)]
    sums = _q(
        """
        MATCH (s:Sample {dataset_id:$d})-[r:HAS_ABUNDANCE]->(a:ASV {dataset_id:$d})
        WHERE a.louvain_label IS NOT NULL
        RETURN a.louvain_label AS l, s.sample_id AS sample, sum(r.count) AS sum_count
        """, d=dataset_id)
    n_members = {r["l"]: r["n"] for r in _q(
        "MATCH (a:ASV {dataset_id:$d}) WHERE a.louvain_label IS NOT NULL "
        "RETURN a.louvain_label AS l, count(*) AS n", d=dataset_id)}
    per = {(r["l"], r["sample"]): r["sum_count"] for r in sums}

    month_no = {m: i + 1 for i, m in enumerate(semantics.MONTHS)}
    clusters = []
    for l in labels:
        series = []
        for s in samples:
            cnt = per.get((l, s["sample"]), 0.0)
            tot = s["total"] or 0.0
            series.append({"sample": s["sample"], "date": s["date"], "sum_count": cnt,
                           "share": (cnt / tot) if tot > 0 else None})
        freq = semantics.frequency(_q, dataset_id, series, with_rank=False)
        act = semantics.activity(freq)
        climo = [c for c in ((freq.get("seasonal") or {}).get("climatology") or [])
                 if c.get("mean") is not None]
        clusters.append({
            "louvain_label": l, "n_members": n_members.get(l, 0),
            "window": act["window"],
            "window_months": [month_no[m] for m in act["window"]],
            "windows": act["windows"],
            "windows_months": [[month_no[m] for m in r] for r in act["windows"]],
            "peak": act["peak"],
            "peak_month": month_no.get(act["peak"]),
            "by_month": [{"month": c["month"], "mean": c["mean"], "n": c["n"]} for c in climo],
            "n_min": act["n_min"], "statement": act["statement"],
        })
    clusters.sort(key=lambda c: (not c["window_months"], c["window_months"][0]
                                 if c["window_months"] else 99, c["louvain_label"]))

    env_rows = _q(
        "MATCH (s:Sample {dataset_id:$d}) RETURN toString(s.date) AS date, "
        + ", ".join(f"s.{v['key']} AS {v['key']}" for v in semantics.ENVIRONMENT_VARS)
        + " ORDER BY s.date, s.same_day_index, s.ordinal_index, s.sample_id", d=dataset_id)
    if year is not None:
        env_rows = [r for r in env_rows if str(r["date"]).startswith(year)]
    env_vars, env_monthly = [], {}
    for v in semantics.environment_vars(_q, dataset_id):
        vals: dict[int, list[float]] = {}
        for r in env_rows:
            if r[v["key"]] is None or not r["date"]:
                continue
            m = int(str(r["date"])[5:7])
            vals.setdefault(m, []).append(float(r[v["key"]]))
        if not vals:
            continue
        env_vars.append({k: v[k] for k in ("key", "label", "unit", "unit_note")})
        env_monthly[v["key"]] = [
            {"month": m, "mean": (sum(vals[m]) / len(vals[m])) if m in vals else None,
             "n": len(vals.get(m, []))}
            for m in range(1, 13)]
    return {**base, "clusters": clusters,
            "environment": {"variables": env_vars, "monthly": env_monthly,
                            "units_note": semantics.environment_units_note(_q, dataset_id)}
            if env_vars else None,
            "absent_reason": None}

from __future__ import annotations

import math
import os
import re
import shutil
import statistics
import sys
import tempfile
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

from fastapi import (Depends, FastAPI, File, Form, Header, HTTPException, Query, Request,
                     Response, UploadFile)
from fastapi.middleware.cors import CORSMiddleware
from starlette.concurrency import run_in_threadpool
from neo4j import GraphDatabase
from pydantic import BaseModel

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "manta_mcp"))

import access
import access_requests
import agent
import audit
import auth
import import_job
import mailer
import settings
import semantics

NEO4J_URI = os.environ.get("NEO4J_URI", "bolt://localhost:7687")
NEO4J_USER = os.environ.get("NEO4J_USER", "neo4j")
NEO4J_PASSWORD = os.environ.get("NEO4J_PASSWORD", "")

STATION_COORDS = {"F4": [6.9648, 79.0118], "MVCO": [-70.5667, 41.325]}

_driver = None


def driver():
    global _driver
    if _driver is None:
        if not NEO4J_PASSWORD:
            raise RuntimeError("NEO4J_PASSWORD ist nicht gesetzt.")
        _driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
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


def _q(query, **params):
    with driver().session(default_access_mode="READ") as s:
        return [r.data() for r in s.run(query, **params)]


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
                "/agent/tools"}


def visible_dataset(dataset_id: str, user: auth.User | None = Depends(auth.anyone)) -> str:
    rows = _q("MATCH (d:Dataset {dataset_id:$d}) WHERE " + access.cypher_condition("d") +
              " RETURN d.dataset_id AS id", d=dataset_id)
    if not rows:
        raise HTTPException(404, f"unbekannter dataset_id {dataset_id!r}")
    return dataset_id


class LoginRequest(BaseModel):
    username: str
    password: str


@app.post("/auth/login")
def auth_login(req: LoginRequest, request: Request, response: Response):
    try:
        token = auth.login(req.username, req.password)
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
            "visibilities": list(access.VISIBILITIES)}


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
        raise HTTPException(400, "die eigenen Rechte kann man hier nicht entziehen")
    try:
        if patch.password is not None:
            auth.set_password(username, patch.password)
        if patch.role is not None:
            auth.set_role(username, patch.role)
        if patch.disabled is not None:
            auth.set_disabled(username, patch.disabled)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return {"ok": True, "username": username}


@app.delete("/admin/users/{username}")
def admin_delete_user(username: str, me: auth.User = Depends(auth.admin)):
    username = username.strip().lower()
    if username == me.username:
        raise HTTPException(400, "das eigene Konto kann man hier nicht loeschen")
    try:
        auth.delete_user(username)
    except ValueError as e:
        raise HTTPException(404, str(e)) from e
    return {"deleted": username}


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
        raise HTTPException(400, "nichts zu speichern")
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


@app.get("/admin/settings/agent", dependencies=[Depends(auth.admin)])
def admin_agent_settings():
    return settings.view()


@app.put("/admin/settings/agent")
def admin_set_agent_settings(patch: AgentSettings, me: auth.User = Depends(auth.admin)):
    werte = {k: v for k, v in patch.model_dump().items() if v is not None}
    if not werte:
        raise HTTPException(400, "nichts zu speichern")
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
        raise HTTPException(400, f"keine gueltige Adresse: {ziel or '(leer)'}")
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


PUBLIC_URL = (os.environ.get("MANTA_PUBLIC_URL") or "").strip().rstrip("/")


def _public_base(request: Request) -> str:
    if PUBLIC_URL:
        return PUBLIC_URL
    proto = (request.headers.get("x-forwarded-proto", "").split(",")[0].strip()
             or request.url.scheme)
    host = (request.headers.get("x-forwarded-host", "").split(",")[0].strip()
            or request.headers.get("host", "").strip())
    return f"{proto}://{host}" if host else str(request.base_url).rstrip("/")


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
    betreff, text = access_requests.notification(antrag, _public_base(request))
    status = mailer.send(betreff, text, empfaenger, reply_to=antrag["email"])
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
        raise HTTPException(400, f"unbekannte Sichtbarkeit {patch.visibility!r}, "
                                 f"erlaubt: {list(access.VISIBILITIES)}")
    rows = _w("MATCH (d:Dataset {dataset_id:$d}) SET d.visibility=$v "
              "RETURN d.dataset_id AS dataset_id, d.visibility AS visibility", d=dataset_id, v=v)
    if not rows:
        raise HTTPException(404, f"unbekannter dataset_id {dataset_id!r}")
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
        raise HTTPException(422, "dataset_id darf nicht leer sein")
    rows = _q("MATCH (d:Dataset {dataset_id:$d}) RETURN d.region AS region", d=dataset_id)
    if rows and not replace:
        raise HTTPException(409, f"Der Name {dataset_id!r} ist bereits vergeben "
                                 f"({rows[0]['region']!r}). Bitte einen anderen Namen waehlen "
                                 f"oder den vorhandenen Datensatz vorher loeschen.")


def _wipe_for_replace(dataset_id: str, replace: bool) -> None:
    if replace:
        _w("MATCH (n {dataset_id:$d}) DETACH DELETE n", d=dataset_id)


MIN_SAMPLES_FOR_NETWORK = 8

MAX_REGION_CHARS = 200
MAX_NOTE_CHARS = 20_000

DEFAULT_PRIMERS = {
    "18S": ("GCGGTAATTCCAGCTCCAA", "ACTTTCGTTCTTGATYRR"),
    "16S": ("CCTACGGGNGGCWGCAG", "GACTACHVGGGTATCTAATCC"),
}


@app.post("/import", dependencies=[Depends(auth.admin)])
def start_import(req: ImportRequest, replace: bool = Query(False)):
    _require_free_dataset_id(req.dataset_id, replace)
    _require_tools("dada2")
    job_id = import_job.start_import(req.dataset_id, marker=req.marker,
                                     region=req.region, station=req.station,
                                     lat=req.lat, lon=req.lon)
    return {"job_id": job_id, "dataset_id": req.dataset_id}


RDATA_SUFFIXE = {".rdata", ".rda"}
FASTA_SUFFIXE = {".fa", ".fasta", ".fna"}


def _sieht_nach_dada2_aus(names: set[str]) -> bool:
    endungen = [Path(n).suffix.lower() for n in names]
    return (sum(e in RDATA_SUFFIXE for e in endungen) >= 2
            and any(e in FASTA_SUFFIXE for e in endungen)
            and any(e == ".csv" for e in endungen))

REQUIRED_UPLOAD_TABLES = {"abundance.csv", "taxa_info.csv", "environment_info.csv"}

REQUIRED_UPLOAD_OTTER_OUT = {"abundance.csv", "environment_info.csv"}
OTTER_OUT_MANIFEST = "manta_manifest.json"
OTTER_OUT_MANIFEST_ALT = "orca_manifest.json"
OTTER_OUT_FALLBACK_TABLES = {
    "enriched": "PyTest_Hellinger_False_14_Enriched_Hellinger_14_complete_network_table_meta_CON_CCM.csv",
    "con": "PyTest_Hellinger_False_14_Pearson_FFT__complete_network_table_0.7_0.05.csv",
    "pruned": "PyTest_Hellinger_False_14_Pruned_CCM_CON_MAP_Network.csv",
}


def _upload_rows(tmp: Path, name: str) -> list[list[str]]:
    import csv as _csv
    with (tmp / name).open(newline="") as fh:
        return [r for r in _csv.reader(fh, delimiter=";") if r]


def _abundance_labels(tmp: Path) -> list[str]:
    ab = _upload_rows(tmp, "abundance.csv")
    if len(ab) < 2 or len(ab[0]) < 2:
        raise HTTPException(400, "abundance.csv ist leer oder nicht ';'-getrennt")
    return [r[0] for r in ab[1:]]


def _check_env_has_date(tmp: Path) -> None:
    env = _upload_rows(tmp, "environment_info.csv")
    if not env or (env[0][0] or "").strip() != "date":
        raise HTTPException(400, "environment_info.csv muss mit einer 'date'-Spalte beginnen")


def _axis_from_labels(labels: list[str]) -> str:
    import re as _re
    iso = _re.compile(r"\d{4}-\d{2}-\d{2}$")
    return "dates" if all(iso.match(s or "") for s in labels) else "ordinal"


def _validate_tables_upload(tmp: Path) -> str:
    labels = _abundance_labels(tmp)
    if len(labels) < MIN_SAMPLES_FOR_NETWORK:
        raise HTTPException(400, f"abundance.csv hat nur {len(labels)} Zeitpunkte — fuer ein "
                                 f"Netzwerk braucht es mindestens {MIN_SAMPLES_FOR_NETWORK}")
    asvs = [c for c in _upload_rows(tmp, "abundance.csv")[0][1:] if c]
    taxa_ids = {r[0] for r in _upload_rows(tmp, "taxa_info.csv")[1:]}
    if taxa_ids != set(asvs):
        raise HTTPException(400, "taxa_info.csv passt nicht zur abundance.csv: die ASV-Mengen "
                                 "muessen exakt uebereinstimmen (OTTER-Kontrakt)")
    _check_env_has_date(tmp)
    return _axis_from_labels(labels)


def _validate_otter_out_upload(tmp: Path) -> str:
    import json as _json
    names = {p.name for p in tmp.iterdir()}
    manifest_path = tmp / OTTER_OUT_MANIFEST
    if not manifest_path.exists():
        manifest_path = tmp / OTTER_OUT_MANIFEST_ALT
    if manifest_path.exists():
        try:
            manifest = _json.loads(manifest_path.read_text(encoding="utf-8"))
        except ValueError:
            raise HTTPException(400, f"{OTTER_OUT_MANIFEST} ist kein gueltiges JSON")
        for kind, fallback in OTTER_OUT_FALLBACK_TABLES.items():
            base = Path(str(manifest.get(kind) or fallback)).name
            if base not in names:
                raise HTTPException(400, f"Netzwerk-Tabelle '{kind}' fehlt im Upload: {base} "
                                         f"(laut {OTTER_OUT_MANIFEST} dieses Laufs)")
            manifest[kind] = str(tmp / base)
        manifest_path.write_text(_json.dumps(manifest, indent=2), encoding="utf-8")
    else:
        missing = [n for n in OTTER_OUT_FALLBACK_TABLES.values() if n not in names]
        if missing:
            raise HTTPException(400, f"ohne {OTTER_OUT_MANIFEST} muessen die Netzwerk-Tabellen "
                                     f"unter ihren Standardnamen vorliegen; es fehlen: {missing}")
    labels = _abundance_labels(tmp)
    _check_env_has_date(tmp)
    return _axis_from_labels(labels)


@app.post("/import/upload", dependencies=[Depends(auth.admin)])
async def start_import_upload(
    dataset_id: str = Form(...),
    region: str = Form("Hochgeladener Datensatz"),
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
):
    await run_in_threadpool(_require_free_dataset_id, dataset_id, replace)
    tmp = Path(tempfile.mkdtemp(prefix="manta_upload_"))
    for f in files:
        name = Path(f.filename or "").name
        if name:
            (tmp / name).write_bytes(await f.read())
    try:
        names = {p.name for p in tmp.iterdir()}
        has_otter_out = (OTTER_OUT_MANIFEST in names or OTTER_OUT_MANIFEST_ALT in names or
                         any(n in names for n in OTTER_OUT_FALLBACK_TABLES.values()))
        has_tables = not has_otter_out and REQUIRED_UPLOAD_TABLES <= names
        has_dada2 = _sieht_nach_dada2_aus(names)
        if has_tables and has_dada2:
            raise HTTPException(400, "beide Kontrakte auf einmal hochgeladen — bitte ENTWEDER die "
                                     "DADA2-Ausgabe (5 Dateien) ODER die OTTER-Tabellen (3 CSVs)")
        if not (has_otter_out or has_tables or has_dada2):
            raise HTTPException(400, f"fehlende Pflichtdateien. Entweder DADA2-Ausgabe "
                                     f"(mindestens zwei .Rdata, eine FASTA und eine .csv), "
                                     f"OTTER-Eingabe "
                                     f"{sorted(REQUIRED_UPLOAD_TABLES)} oder ein OTTER-Ergebnis "
                                     f"(Netzwerk-Tabellen + {sorted(REQUIRED_UPLOAD_OTTER_OUT)}, "
                                     f"idealerweise mit {OTTER_OUT_MANIFEST}); "
                                     f"hochgeladen: {sorted(names)}")
        if (lat is None) != (lon is None):
            raise HTTPException(400, "lat und lon muessen zusammen angegeben werden")
        if lat is not None and not (-90 <= lat <= 90 and -180 <= lon <= 180):
            raise HTTPException(400, f"unplausible Koordinate lat={lat}, lon={lon}")
        thresholds = {k: v for k, v in {
            "con_tr": con_tr, "con_alpha": con_alpha, "ccmn_tr": ccmn_tr,
            "louvain_res": louvain_res, "fft_coeffs": fft_coeffs,
            "num_permutations": num_permutations, "num_samples": num_samples}.items()
            if v is not None}
        if thresholds:
            _validate_thresholds({**PRODUCTION_DEFAULTS, **thresholds})
        if has_otter_out:
            if thresholds:
                raise HTTPException(400, "bei einem OTTER-Ergebnis wird nichts gerechnet — die "
                                         "Schwellen des Laufs stehen in seinem manta_manifest.json "
                                         "und koennen hier nicht veraendert werden")
            missing = REQUIRED_UPLOAD_OTTER_OUT - names
            if missing:
                raise HTTPException(400, f"OTTER-Ergebnis erkannt, aber es fehlen: {sorted(missing)}")
            _require_tools("otterout")
            time_axis = _validate_otter_out_upload(tmp)
            _wipe_for_replace(dataset_id, replace)
            job_id = import_job.start_import(dataset_id, marker=marker, region=region,
                                             otter_out_dir=tmp, station=station, lat=lat, lon=lon,
                                             time_axis=time_axis)
        elif has_tables:
            _require_tools("tables")
            time_axis = _validate_tables_upload(tmp)
            _wipe_for_replace(dataset_id, replace)
            job_id = import_job.start_import(dataset_id, marker=marker, region=region,
                                             tables_dir=tmp, station=station, lat=lat, lon=lon,
                                             time_axis=time_axis, thresholds=thresholds or None)
        else:
            _require_tools("dada2")
            _wipe_for_replace(dataset_id, replace)
            job_id = import_job.start_import(dataset_id, marker=marker, region=region, rdata_dir=tmp,
                                             station=station, lat=lat, lon=lon,
                                             thresholds=thresholds or None)
    except HTTPException:
        shutil.rmtree(tmp, ignore_errors=True)
        raise
    return {"job_id": job_id, "dataset_id": dataset_id}


IMPORT_TOOLS_HINT = ("This MANTA instance contains only the interface and the API (as the Docker "
                     "installation does). Importing and recomputing need the local installation "
                     "described in the README.")


@app.get("/import/tools", dependencies=[Depends(auth.admin)])
def import_tools():
    return {**import_job.tool_status(), "hint": IMPORT_TOOLS_HINT}


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
        out["error"] = f"fehlt auf dieser Maschine: {', '.join(missing)}"
    out["hinweis"] = ("DADA2 rechnet Minuten bis Stunden (24 Samples ~20 min auf einem Laptop) "
                      "und braucht viel Speicher. Auf 8 GB kann Neo4j waehrenddessen sterben — "
                      "Taxonomie deshalb nur mit Referenz UND genug RAM einschalten.")
    return out


@app.post("/import/fastq", dependencies=[Depends(auth.admin)])
async def start_import_fastq(
    dataset_id: str = Form(...),
    region: str = Form("Hochgeladener FASTQ-Datensatz"),
    marker: str = Form("18S"),
    station: str | None = Form(None),
    lat: float | None = Form(None),
    lon: float | None = Form(None),
    top_n: int = Form(500),
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
):
    await run_in_threadpool(_require_free_dataset_id, dataset_id, replace)
    _require_tools("fastq")
    pre = await run_in_threadpool(fastq_preflight)
    if not pre["ok"]:
        raise HTTPException(503, f"FASTQ-Import auf dieser Maschine nicht moeglich — {pre['error']}")

    tmp = Path(tempfile.mkdtemp(prefix="manta_fastq_"))
    fq = tmp / "fastq"
    fq.mkdir()
    try:
        n_r1 = n_r2 = 0
        for f in files:
            name = Path(f.filename or "").name
            if not name.endswith((".fastq.gz", ".fq.gz")):
                continue
            (fq / name).write_bytes(await f.read())
            n_r1 += "_R1_" in name
            n_r2 += "_R2_" in name
        if n_r1 == 0 or n_r1 != n_r2:
            raise HTTPException(400, f"paarweise _R1_/_R2_-Dateien erwartet, gefunden: "
                                     f"{n_r1}x R1 und {n_r2}x R2")
        if n_r1 < MIN_SAMPLES_FOR_NETWORK:
            raise HTTPException(400, f"{n_r1} Proben reichen fuer kein Netzwerk. OTTER korreliert "
                                     f"Zeitreihen; mindestens {MIN_SAMPLES_FOR_NETWORK} Zeitpunkte "
                                     f"sind noetig; die Standard-Parametrisierung ist auf rund "
                                     f"100 ausgelegt.")

        time_axis = "ordinal"
        meta_path = None
        if metadata is not None and metadata.filename:
            meta_path = tmp / "metadata.csv"
            meta_path.write_bytes(await metadata.read())
            time_axis = "dates"

        if (lat is None) != (lon is None):
            raise HTTPException(400, "lat und lon muessen zusammen angegeben werden")
        if lat is not None and not (-90 <= lat <= 90 and -180 <= lon <= 180):
            raise HTTPException(400, f"unplausible Koordinate lat={lat}, lon={lon}")
        if taxonomy_ref and not Path(taxonomy_ref).exists():
            raise HTTPException(400, f"Taxonomie-Referenz nicht gefunden: {taxonomy_ref}")

        if not fwd_primer or not rev_primer:
            if marker not in DEFAULT_PRIMERS:
                raise HTTPException(400, f"Fuer Marker {marker!r} sind keine Standard-Primer "
                                         f"hinterlegt — bitte fwd_primer und rev_primer angeben.")
            fwd_primer, rev_primer = DEFAULT_PRIMERS[marker]

        dada2_env = {
            "MANTA_TOP_N": str(top_n), "MANTA_NCORES": str(max(1, ncores)),
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
        _wipe_for_replace(dataset_id, replace)
        job_id = import_job.start_import(dataset_id, marker=marker, region=region,
                                         station=station, lat=lat, lon=lon,
                                         fastq_dir=fq, dada2_env=dada2_env, time_axis=time_axis,
                                         thresholds=thresholds)
    except HTTPException:
        shutil.rmtree(tmp, ignore_errors=True)
        raise
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
        raise HTTPException(422, "con_tr muss in [0, 1) liegen — es ist eine Korrelation.")
    if not 0.0 < t["con_alpha"] <= 1.0:
        raise HTTPException(422, "con_alpha muss in (0, 1] liegen.")
    if not 0.0 <= t["ccmn_tr"] < 1.0:
        raise HTTPException(422, "ccmn_tr muss in [0, 1) liegen.")
    if t["fft_coeffs"] < 2:
        raise HTTPException(422, "fft_coeffs muss mindestens 2 sein.")
    if t["num_permutations"] < 1 or t["num_samples"] < 1:
        raise HTTPException(422, "num_permutations und num_samples muessen mindestens 1 sein.")


@app.post("/datasets/{dataset_id}/recompute", dependencies=[Depends(auth.admin), Depends(visible_dataset)])
def recompute(dataset_id: str, req: RecomputeRequest):
    ds = _q("MATCH (d:Dataset {dataset_id:$d}) RETURN d.marker AS marker, d.region AS region, "
            "d.station AS station, d.lat AS lat, d.lon AS lon, "
            "coalesce(d.time_axis,'ordinal') AS time_axis, "
            "COUNT { MATCH (a:ASV {dataset_id: d.dataset_id}) } AS n_asv, "
            "COUNT { MATCH (s:Sample {dataset_id: d.dataset_id}) } AS n_sample", d=dataset_id)
    if not ds:
        raise HTTPException(404, f"unbekannter dataset_id {dataset_id!r}")
    d = ds[0]
    if d["n_sample"] < MIN_SAMPLES_FOR_NETWORK:
        raise HTTPException(400, f"{d['n_sample']} Proben reichen fuer kein Netzwerk "
                                 f"(mindestens {MIN_SAMPLES_FOR_NETWORK}).")

    t = req.model_dump()
    run_id = t.pop("run_id") or f"thr_{req.con_tr}_{req.con_alpha}_p{req.num_permutations}"
    _validate_thresholds(t)
    _require_tools("recompute")

    job_id = import_job.start_recompute(
        dataset_id, run_id=run_id, thresholds=t, marker=d["marker"], region=d["region"],
        station=d["station"], lat=d["lat"], lon=d["lon"], time_axis=d["time_axis"])
    n = d["n_asv"] or 0
    minutes = round(n * (n - 1) / 2 * 0.011 / 60)
    return {"job_id": job_id, "dataset_id": dataset_id, "run_id": run_id, "thresholds": t,
            "n_asv": n, "estimated_minutes": minutes,
            "warning": "Das bisherige Netz dieses Datensatzes wird ersetzt. "
                       "Proben und Zeitreihen bleiben unveraendert."}


@app.get("/imports", dependencies=[Depends(auth.admin)])
def import_jobs():
    return {"jobs": import_job.list_jobs(),
            "hinweis": ("Liste umfasst nur Jobs seit dem letzten Backend-Start; ein Neustart "
                        "bricht laufende Importe ab.")}


@app.get("/import/{job_id}", dependencies=[Depends(auth.admin)])
def import_status(job_id: str):
    st = import_job.get_status(job_id)
    if not st:
        raise HTTPException(404, f"unbekannter job_id {job_id!r}")
    return st


@app.delete("/datasets/{dataset_id}",
            dependencies=[Depends(auth.admin), Depends(visible_dataset)])
def delete_dataset(dataset_id: str, me: auth.User = Depends(auth.admin)):
    if not _q("MATCH (d:Dataset {dataset_id:$d}) RETURN d.dataset_id AS id", d=dataset_id):
        raise HTTPException(404, f"unbekannter dataset_id {dataset_id!r} — nichts geloescht")
    _w("MATCH (n {dataset_id:$d}) DETACH DELETE n", d=dataset_id)
    audit.note(me.username, "dataset deleted", dataset_id)
    return {"deleted": dataset_id}


class AgentAsk(BaseModel):
    question: str
    dataset_id: str | None = None
    model: str | None = None
    asv_id: str | None = None
    cluster: int | None = None
    provider_url: str | None = None
    history: list[dict] | None = None


@app.get("/agent/status")
def agent_status():
    return agent.available()


@app.get("/agent/tools")
def agent_tools():
    tools = agent.tool_help()
    return {"n": len(tools), "tools": tools}


class ToolRun(BaseModel):
    arguments: dict = {}


@app.post("/agent/tools/{name}", dependencies=[Depends(auth.user)])
def agent_tool_run(name: str, req: ToolRun):
    if name not in {t["name"] for t in agent.tool_help()}:
        raise HTTPException(404, f"unbekanntes Werkzeug {name!r}")
    result = agent.registry.call(name, dict(req.arguments))
    return {"tool": name, "arguments": req.arguments, "result": result,
            "provenance": result.get("provenance") if isinstance(result, dict) else None,
            "error": result.get("error") if isinstance(result, dict) else None}


@app.post("/agent/ask", dependencies=[Depends(auth.user)])
def agent_ask(req: AgentAsk,
              provider_key: str | None = Header(default=None, alias="X-MANTA-Provider-Key")):
    if not req.question.strip():
        raise HTTPException(422, "question darf nicht leer sein")
    provider = None
    if req.provider_url or provider_key:
        if not req.provider_url:
            raise HTTPException(400, "Eigener Schluessel ohne Anbieter-Adresse (provider_url).")
        if not provider_key:
            raise HTTPException(400, "Anbieter-Adresse ohne Schluessel "
                                     "(Kopfzeile X-MANTA-Provider-Key fehlt).")
        if not req.model:
            raise HTTPException(400, "Eigener Anbieter ohne Modellnamen (model).")
        try:
            provider = agent.SessionProvider(req.provider_url, provider_key, req.model)
        except agent.AgentError as e:
            raise HTTPException(400, str(e)) from e
    elif req.model:
        installed = agent.available().get("models_available") or []
        if req.model not in installed:
            raise HTTPException(400, f"Modell {req.model!r} ist nicht installiert. "
                                     f"Verfuegbar: {installed}")
    try:
        return agent.run(req.question.strip(), req.dataset_id, model=req.model,
                         asv_id=req.asv_id, cluster=req.cluster, provider=provider,
                         history=req.history)
    except agent.AgentError as e:
        raise HTTPException(503, str(e)) from e


class DatasetPatch(BaseModel):
    region: str | None = None
    lat: float | None = None
    lon: float | None = None


@app.patch("/datasets/{dataset_id}", dependencies=[Depends(auth.admin), Depends(visible_dataset)])
def rename_dataset(dataset_id: str, patch: DatasetPatch, me: auth.User = Depends(auth.admin)):
    felder, params = [], {"d": dataset_id}
    if patch.region is not None:
        region = patch.region.strip()
        if not region:
            raise HTTPException(422, "region darf nicht leer sein")
        if len(region) > MAX_REGION_CHARS:
            raise HTTPException(422, f"region ist auf {MAX_REGION_CHARS} Zeichen begrenzt "
                                     f"(uebergeben: {len(region)})")
        if any(ch < " " for ch in region):
            raise HTTPException(422, "region darf keine Zeilenumbrueche oder Steuerzeichen enthalten")
        felder.append("d.region = $r"); params["r"] = region
    if (patch.lat is None) != (patch.lon is None):
        raise HTTPException(422, "lat und lon muessen zusammen angegeben werden")
    if patch.lat is not None:
        if not (-90 <= patch.lat <= 90 and -180 <= patch.lon <= 180):
            raise HTTPException(422, f"unplausible Koordinate lat={patch.lat}, lon={patch.lon}")
        felder.append("d.lat = $lat, d.lon = $lon")
        params["lat"] = round(patch.lat, 4); params["lon"] = round(patch.lon, 4)
    if not felder:
        raise HTTPException(422, "nichts zu aendern: region oder lat/lon angeben")
    rows = _w(f"MATCH (d:Dataset {{dataset_id:$d}}) SET {', '.join(felder)} "
              "RETURN d.dataset_id AS dataset_id, d.region AS region, d.lat AS lat, d.lon AS lon",
              **params)
    if not rows:
        raise HTTPException(404, f"unbekannter dataset_id {dataset_id!r}")
    audit.note(me.username, "dataset edited", f"{dataset_id}: {', '.join(felder)}")
    return rows[0]


class NotePatch(BaseModel):
    note: str


def _check_note(text: str) -> None:
    if len(text) > MAX_NOTE_CHARS:
        raise HTTPException(422, f"note ist auf {MAX_NOTE_CHARS} Zeichen begrenzt "
                                 f"(uebergeben: {len(text)})")


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
            raise HTTPException(404, f"Probe {sample_id!r} nicht in dataset_id={dataset_id!r}")
        return {"dataset_id": dataset_id, "louvain_label": louvain_label, "sample": sample_id,
                "members": [], "cluster_total": 0.0,
                "note": "No member of this cluster was detected in this sample."}
    total = sum(r["count"] or 0.0 for r in rows)
    st = rows[0]["sample_total"] or 0.0
    return {
        "dataset_id": dataset_id, "louvain_label": louvain_label, "sample": sample_id,
        "cluster_total": total,
        "sample_total": st,
        "quantity": semantics.quantity(_q, dataset_id),
        "members": [{"id": r["id"], "genus": r["genus"], "count": r["count"],
                     "rank": r["rank"],
                     "n_samples_present": r["n_samples_present"],
                     "n_samples_total": n_samples_total,
                     "share_of_sample": (r["count"] / st) if st > 0 else None,
                     "share_of_cluster": (r["count"] / total) if total > 0 else None}
                    for r in rows],
        "note": None,
    }


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
        raise HTTPException(404, f"ASV {asv_id!r} nicht in dataset_id={dataset_id!r}")
    return _set_star(dataset_id, u.username, "asv", asv_id, patch.starred)


@app.put("/datasets/{dataset_id}/cluster/{louvain_label}/star", dependencies=[Depends(visible_dataset)])
def set_cluster_star(dataset_id: str, louvain_label: int, patch: StarPatch,
                     u: auth.User = Depends(auth.user)):
    if not _q("MATCH (c:Cluster {louvain_label:$l, dataset_id:$d}) RETURN c.louvain_label",
              d=dataset_id, l=louvain_label):
        raise HTTPException(404, f"Cluster {louvain_label} nicht in dataset_id={dataset_id!r}")
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
             "RETURN toInteger(s.key) AS louvain_label, s.at AS at "
             "ORDER BY coalesce(s.at,'') DESC, louvain_label", d=dataset_id, u=u)
    return {"dataset_id": dataset_id, "asvs": asvs, "clusters": cls,
            "n": len(asvs) + len(cls), "note": None}


@app.put("/datasets/{dataset_id}/asv/{asv_id}/note", dependencies=[Depends(auth.user), Depends(visible_dataset)])
def set_asv_note(dataset_id: str, asv_id: str, patch: NotePatch):
    _check_note(patch.note)
    rows = _w("MATCH (a:ASV {id:$id, dataset_id:$d}) SET a.note = $n, a.note_at = $t "
              "RETURN a.note AS note, a.note_at AS note_at",
              d=dataset_id, id=asv_id, n=patch.note.strip(),
              t=datetime.now(timezone.utc).isoformat(timespec="seconds"))
    if not rows:
        raise HTTPException(404, f"ASV {asv_id!r} nicht in dataset_id={dataset_id!r}")
    return rows[0]


@app.put("/datasets/{dataset_id}/cluster/{louvain_label}/note", dependencies=[Depends(auth.user), Depends(visible_dataset)])
def set_cluster_note(dataset_id: str, louvain_label: int, patch: NotePatch):
    _check_note(patch.note)
    rows = _w("MATCH (c:Cluster {louvain_label:$l, dataset_id:$d}) SET c.note = $n, c.note_at = $t "
              "RETURN c.note AS note, c.note_at AS note_at",
              d=dataset_id, l=louvain_label, n=patch.note.strip(),
              t=datetime.now(timezone.utc).isoformat(timespec="seconds"))
    if not rows:
        raise HTTPException(404, f"kein Cluster {louvain_label} in dataset_id={dataset_id!r}")
    return rows[0]



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
            raise HTTPException(422, f"Farbe muss #rrggbb sein — uebergeben: {patch.color!r}")
        params["color"] = farbe or None
        sets.append("c.color = $color")
    if not sets:
        raise HTTPException(422, "weder name noch color uebergeben")

    rows = _w(f"MATCH (c:Cluster {{louvain_label:$l, dataset_id:$d}}) SET {', '.join(sets)} "
              f"RETURN c.louvain_label AS louvain_label, c.name AS name, c.color AS color",
              **params)
    if not rows:
        raise HTTPException(404, f"kein Cluster {louvain_label} in dataset_id={dataset_id!r}")
    r = rows[0]
    return {**r, "display": semantics.module_display(r["louvain_label"], r["name"])}



@app.get("/datasets/{dataset_id}/taxon", dependencies=[Depends(visible_dataset)])
def taxon(dataset_id: str, asv: str = Query(..., min_length=1)):
    gruppe = semantics.taxon_group(_q, dataset_id, asv)
    if gruppe is None:
        raise HTTPException(404, f"ASV {asv!r} nicht in dataset_id={dataset_id!r}")
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
               COUNT { MATCH (s:Sample {dataset_id: d.dataset_id}) } AS n_sample
        ORDER BY d.dataset_id
        """
    )
    for r in rows:
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


def _thresholds(dataset_id: str) -> dict:
    return semantics.thresholds(_q, dataset_id)


def _network_scope(dataset_id: str) -> dict:
    rows = _q("MATCH (r:Run {dataset_id:$d}) WHERE r.n_asv_in_network_run IS NOT NULL "
              "RETURN r.n_asv_in_network_run AS n_in, "
              "r.n_asv_available_to_network_run AS n_available, r.run_id AS run_id "
              "ORDER BY coalesce(r.computed_at, '') DESC, r.run_id LIMIT 1", d=dataset_id)
    n_asv = _q("MATCH (a:ASV {dataset_id:$d}) RETURN count(a) AS n", d=dataset_id)
    total = n_asv[0]["n"] if n_asv else 0
    if not rows:
        return {"recorded": False, "n_in_run": None, "n_dataset": total, "subset": None,
                "note": ("It is not recorded how many ASVs went into the network run for this "
                         "dataset. So it cannot be said whether an ASV outside the network was "
                         "tested and failed the threshold, or was never part of the run.")}
    n_in = rows[0]["n_in"]
    subset = n_in < total
    return {
        "recorded": True, "n_in_run": n_in, "n_dataset": total, "subset": subset,
        "run_id": rows[0]["run_id"],
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
        raise HTTPException(404, f"unbekannter dataset_id {dataset_id!r}")
    return {"dataset_id": dataset_id, "thresholds": _thresholds(dataset_id),
            "defaults": OTTER_DEFAULTS,
            "counts": {"n_asv": rows[0]["n_asv"], "n_sample": rows[0]["n_sample"]},
            "retrieved_at": datetime.now(timezone.utc).isoformat(timespec="seconds")}



TAXONOMY_PLACEHOLDERS = semantics.TAXONOMY_PLACEHOLDERS

ENV_PROPS = semantics.ENVIRONMENT_KEYS
_ENV_LABEL = {v["key"]: v["label"] for v in semantics.ENVIRONMENT_VARS}


def _capabilities(dataset_id: str) -> dict:
    ds = _q("MATCH (d:Dataset {dataset_id:$d}) RETURN coalesce(d.time_axis,'ordinal') AS time_axis, "
            "coalesce(d.value_kind,'unknown') AS value_kind, "
            "coalesce(d.env_ignored_columns, []) AS env_ignored, "
            "d.source_doi AS source_doi, d.citation AS citation", d=dataset_id)
    if not ds:
        raise HTTPException(404, f"unknown dataset_id {dataset_id!r}")
    axis, kind = ds[0]["time_axis"], ds[0]["value_kind"]
    doi, cite = ds[0]["source_doi"], ds[0]["citation"]
    env_ignored = ds[0]["env_ignored"]

    ranks = ", ".join(
        f"sum(CASE WHEN a.{t} IS NOT NULL AND NOT a.{t} IN $ph THEN 1 ELSE 0 END) AS {t}"
        for t in TAXONOMY)
    counts = _q(
        f"""
        MATCH (a:ASV {{dataset_id:$d}})
        RETURN count(a) AS n_asv,
               sum(CASE WHEN a.sequence IS NOT NULL THEN 1 ELSE 0 END) AS n_sequence,
               sum(CASE WHEN a.louvain_label IS NOT NULL THEN 1 ELSE 0 END) AS n_network,
               {ranks}
        """, d=dataset_id, ph=TAXONOMY_PLACEHOLDERS)[0]

    env_sel = ", ".join(f"sum(CASE WHEN s.`{p}` IS NOT NULL THEN 1 ELSE 0 END) AS `{p}`"
                        for p in ENV_PROPS)
    env = _q(f"MATCH (s:Sample {{dataset_id:$d}}) RETURN count(s) AS n_sample, {env_sel}",
             d=dataset_id)[0]
    env_have = [p for p in ENV_PROPS if (env.get(p) or 0) > 0]

    n_asv = counts["n_asv"] or 0
    deepest = [t for t in TAXONOMY if (counts[t] or 0) > 0]
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
            "detail": ("Whole numbers out of our own DADA2 chain, traceable back to the FASTQ."
                       if kind == "reads" else
                       "Not one value in this dataset is a whole number, so something converted "
                       "them before we received them. Shares are still comparable within a "
                       "sample; calling them reads would be a guess."),
        },
        {
            "key": "taxonomy",
            "label": "Taxonomy",
            "available": bool(deepest),
            "value": (f"down to {deepest[-1]}" if deepest else "none"),
            "n": counts[deepest[-1]] if deepest else 0,
            "total": n_asv,
            "per_rank": {t: counts[t] or 0 for t in TAXONOMY},
            "detail": ("No reference database was used in the run for this dataset, so the ASVs "
                       "carry no names — only their sequence identifies them."
                       if not deepest else
                       "Assigned against a reference database; ranks left empty were not "
                       "resolvable, which is normal for many marine eukaryotes."),
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
            "value": f"{counts['n_network']} of {n_asv} ASVs",
            "n": counts["n_network"] or 0, "total": n_asv,
            "detail": (_network_scope(dataset_id)["note"]
                       + " ASVs outside the network keep their time series either way."),
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
                        "No environmental columns were supplied with this dataset, so there is "
                        "nothing to plot and nothing to overlay on the diversity curve. The chain "
                        "carries environmental data end to end; this import brought none.")
                       + (f" Columns supplied but not taken over, because they are not "
                          f"environmental variables MANTA knows: {', '.join(env_ignored)}. "
                          f"Recognised names are: {', '.join(ENV_PROPS)}." if env_ignored else "")),
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


def _network_nodes(dataset_id):
    rows = _q(
        f"""
        MATCH (a:ASV {{dataset_id:$d}}) WHERE a.louvain_label IS NOT NULL
        RETURN a.id AS id, {", ".join(f"a.{t} AS {t}" for t in TAXONOMY)},
               a.louvain_label AS cluster, a.louvain_label_color AS color,
               a.read_count_total AS size, a.max_abundance_month AS peak_month,
               COUNT {{ (a)<-[:HAS_ABUNDANCE]-(:Sample) }} AS n_samples_present,
               a.trait_function AS trait_function, a.trait_rank AS trait_rank,
               {", ".join(f"a.{c} AS {c}" for c in CENTRALITIES)}
        ORDER BY a.id
        """,
        d=dataset_id,
    )
    stars = _user_star_keys(dataset_id, "asv")
    for r in rows:
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
            raise HTTPException(404, f"kein {marker!r}-Netzwerk für dataset_id={dataset_id!r}")
    nodes = _network_nodes(dataset_id)
    if not nodes:
        raise HTTPException(404, f"kein Netzwerk für dataset_id={dataset_id!r}")
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

    return {"dataset_id": dataset_id, "marker": marker, "edge": edge, "directed": directed,
            "partition": partition,
            "hubs": semantics.hub_set(_q, dataset_id),
            "edge_width_legend": semantics.EDGE_WIDTH_LEGEND,
            "thresholds": _thresholds(dataset_id), "layers": _layers(dataset_id),
            "traits": semantics.trait_run(_q, dataset_id),
            "env_links": _env_links(dataset_id),
            "value_declaration": {
                **semantics.value_declaration(_q, dataset_id, semantics.frame_summed(_q, dataset_id)),
                "applies_to": "nodes[].size",
            },
            "nodes": nodes, "edges": edges}


@app.get("/datasets/{dataset_id}/hub-criterion", dependencies=[Depends(visible_dataset)])
def hub_criterion(dataset_id: str,
                  measure: str = Query(semantics.HUB_MEASURE_DEFAULT),
                  k: float = Query(semantics.HUB_K_DEFAULT)):
    try:
        return semantics.hub_set(_q, dataset_id, measure=measure, k=k)
    except ValueError as e:
        raise HTTPException(422, str(e)) from e


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
            raise HTTPException(404, f"unbekannter dataset_id {dataset_id!r}")
        raise HTTPException(404, f"kein Netzwerk für dataset_id={dataset_id!r}")
    return data


@app.get("/datasets/{dataset_id}/asv/{asv_id}/spectrum", dependencies=[Depends(visible_dataset)])
def asv_spectrum(dataset_id: str, asv_id: str):
    sp = semantics.spectrum(_q, dataset_id, asv_id)
    if sp is None:
        raise HTTPException(404, f"ASV {asv_id!r} nicht in dataset_id={dataset_id!r}")
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
        raise HTTPException(404, f"keine {type.upper()}-Kante {source!r} -> {target!r} "
                                 f"in dataset_id={dataset_id!r}")
    e = rows[0]

    a, b = _asv_brief(dataset_id, source), _asv_brief(dataset_id, target)
    if a is None or b is None:
        raise HTTPException(404, "ein Endpunkt der Kante existiert nicht mehr")

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


def _peak_environment(node: dict, series: list[dict], axis: str) -> dict:
    items = [{"key": v["key"], "label": v["label"], "unit": v["unit"],
              "unit_note": v.get("unit_note"),
              "value": node[f"peak_{v['key']}"]}
             for v in semantics.ENVIRONMENT_VARS if node.get(f"peak_{v['key']}") is not None]
    at = max(series, key=lambda r: (r.get("count") or 0.0), default=None) if series else None
    return {
        "items": items,
        "at_date": ((at or {}).get("date") if items and axis == TIME_AXIS_DATES else None),
        "caveat": ("Measured in the single sample where this ASV reached its largest value — a "
                   "snapshot, not a preferred range and not an optimum. One sample out of "
                   "all of them, picked because it is the largest."),
    }


@app.get("/datasets/{dataset_id}/asv/{asv_id}", dependencies=[Depends(visible_dataset)])
def asv_detail(dataset_id: str, asv_id: str):
    node = _q(
        f"""
        MATCH (a:ASV {{id:$id, dataset_id:$d}})
        RETURN a.id AS id, {", ".join(f"a.{t} AS {t}" for t in TAXONOMY)},
               a.louvain_label AS cluster, a.louvain_label_color AS color,
               a.read_count_total AS read_count_total, a.max_abundance_month AS peak_month,
               a.sequence AS sequence, a.seq_hash AS seq_hash,
               a.note AS note, a.note_at AS note_at,
               {", ".join(f"a.peak_{p} AS peak_{p}" for p in ENV_PROPS)},
               {", ".join(f"a.{c} AS {c}" for c in CENTRALITIES)}
        """,
        d=dataset_id, id=asv_id,
    )
    if not node:
        raise HTTPException(404, f"ASV {asv_id!r} nicht in dataset_id={dataset_id!r}")
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
    ccm_n = _q("MATCH (:ASV {id:$id, dataset_id:$d})-[r:INFLUENCES {dataset_id:$d}]-(b:ASV) "
               "RETURN b.id AS id, b.genus AS genus, b.louvain_label AS cluster, "
               "max(r.nmi) AS nmi, min(r.p_value) AS p_value ORDER BY id", d=dataset_id, id=asv_id)

    return {
        "id": node["id"], "dataset_id": dataset_id,
        "starred": asv_id in _user_star_keys(dataset_id, "asv"),
        "network_scope": _network_scope(dataset_id),
        "frequency": semantics.frequency(_q, dataset_id, series, with_rank=True),
        "capabilities": _capabilities(dataset_id),
        "lineage": {t: node[t] for t in TAXONOMY},
        "cluster": node["cluster"], "color": node["color"],
        "sequence": node["sequence"],
        "seq_length": len(node["sequence"]) if node["sequence"] else None,
        "seq_hash": node["seq_hash"],
        "note": node["note"], "note_at": node["note_at"],
        "centralities": {c: node[c] for c in CENTRALITIES},
        "peak_environment": _peak_environment(node, series, axis),
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
        "hub_glow": asv_id in set(semantics.hub_set(_q, dataset_id)["ids"]),
        "hub_tooltip": semantics.HUB_NODE_TOOLTIP,
        "funktion": "Nicht aus Amplicon-Daten ableitbar.",
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
        raise HTTPException(404, f"keine Sequenzen fuer dataset_id={dataset_id!r} gespeichert "
                                 f"(nur Datensaetze mit id_map.csv aus convert.py haben welche)")
    body = "".join(f">{r['id']} {r['genus'] or 'unassigned'}\n{r['seq']}\n" for r in rows)
    return Response(content=body, media_type="text/plain",
                    headers={"Content-Disposition": f'attachment; filename="{dataset_id}_network.fasta"'})


@app.get("/datasets/{dataset_id}/cluster-network", dependencies=[Depends(visible_dataset)])
def cluster_network(dataset_id: str):
    if not _q("MATCH (d:Dataset {dataset_id:$d}) RETURN d", d=dataset_id):
        raise HTTPException(404, f"unbekannter dataset_id {dataset_id!r}")
    return {"dataset_id": dataset_id, **semantics.cluster_network(_q, dataset_id)}


@app.get("/datasets/{dataset_id}/interannual", dependencies=[Depends(visible_dataset)])
def interannual(dataset_id: str, metric: str = "jaccard"):
    if metric not in semantics.INTERANNUAL_METRICS:
        raise HTTPException(400, f"metric muss eines von {sorted(semantics.INTERANNUAL_METRICS)} sein")
    if not _q("MATCH (d:Dataset {dataset_id:$d}) RETURN d", d=dataset_id):
        raise HTTPException(404, f"unbekannter dataset_id {dataset_id!r}")
    return {"dataset_id": dataset_id, **semantics.interannual_variability(_q, dataset_id, metric)}


@app.get("/datasets/{dataset_id}/cluster-year", dependencies=[Depends(visible_dataset)])
def cluster_year(dataset_id: str, metric: str = "jaccard"):
    if metric not in semantics.INTERANNUAL_METRICS:
        raise HTTPException(400, f"metric muss eines von {sorted(semantics.INTERANNUAL_METRICS)} sein")
    if not _q("MATCH (d:Dataset {dataset_id:$d}) RETURN d", d=dataset_id):
        raise HTTPException(404, f"unbekannter dataset_id {dataset_id!r}")
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
        raise HTTPException(404, f"kein Cluster {louvain_label} in dataset_id={dataset_id!r}")

    collective = _q(
        """
        MATCH (s:Sample {dataset_id:$d})
        OPTIONAL MATCH (s)-[all:HAS_ABUNDANCE]->(:ASV {dataset_id:$d})
        WITH s, sum(all.count) AS live_total
        WITH s, coalesce(s.analysed_reads_total, live_total) AS sample_total
        OPTIONAL MATCH (s)-[r:HAS_ABUNDANCE]->(a:ASV {dataset_id:$d}) WHERE a.louvain_label = $l
        RETURN s.sample_id AS sample, s.date AS date,
               sum(coalesce(r.count, 0.0)) AS sum_count, coalesce(sample_total, 0.0) AS sample_total
        ORDER BY s.date, s.sample_id
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
        RETURN partner, kanten ORDER BY kanten DESC, partner LIMIT 10
        """, d=dataset_id, l=louvain_label)
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
    hub_ids = set(semantics.hub_set(_q, dataset_id)["ids"])
    for m in members:
        m["hub"] = m["id"] in hub_ids
    return {
        "dataset_id": dataset_id, "louvain_label": louvain_label,
        "hub_tooltip": semantics.HUB_NODE_TOOLTIP,
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
        "note": (_q("MATCH (c:Cluster {louvain_label:$l, dataset_id:$d}) "
                    "RETURN c.note AS n, c.note_at AS t, c.run_id AS run_id "
                    "ORDER BY c.run_id DESC LIMIT 1",
                    d=dataset_id, l=louvain_label) or [{"n": None, "t": None, "run_id": None}])[0],
        "cohesion": cohesion,
        "bridge_partners": partners,
    }


def _ela_single_linkage(states, tippings):
    ids = [s["state_id"] for s in states]
    energy = {s["state_id"]: s["energy"] for s in states}
    pas: dict[frozenset, float] = {}
    for t in tippings:
        k = frozenset((t["ss1"], t["ss2"]))
        if len(k) == 2:
            pas[k] = min(pas.get(k, t["energy"]), t["energy"])
    if len(ids) < 2:
        return ({"state_id": ids[0]} if ids else None), {}
    if any(frozenset((a, b)) not in pas
           for i, a in enumerate(ids) for b in ids[i + 1:]):
        return None, {}
    barrier = {a: min(pas[frozenset((a, b))] for b in ids if b != a) - energy[a]
               for a in ids}
    nodes = {a: {"state_id": a} for a in ids}
    members = {a: {a} for a in ids}
    roots = sorted(ids)
    while len(roots) > 1:
        best = None
        for i, a in enumerate(roots):
            for b in roots[i + 1:]:
                d = min(pas[frozenset((x, y))] for x in members[a] for y in members[b])
                if best is None or (d, a, b) < best:
                    best = (d, a, b)
        d, a, b = best
        first, second = sorted((a, b), key=lambda r: (min(energy[m] for m in members[r]), r))
        nodes[a] = {"energy": d, "children": [nodes[first], nodes[second]]}
        members[a] = members[a] | members[b]
        roots.remove(b)
    return nodes[roots[0]], barrier


@app.get("/datasets/{dataset_id}/ela", dependencies=[Depends(visible_dataset)])
def ela(dataset_id: str):
    run = _q(
        "MATCH (e:ElaRun {dataset_id:$d}) RETURN e.ela_run_id AS ela_run_id, "
        "e.seed AS seed, e.ath AS ath, e.minoc AS minoc, e.maxoc AS maxoc, "
        "e.nmax AS nmax, e.rep AS rep, e.totalit AS totalit, e.boot AS boot, "
        "e.n_species_model AS n_species_model, e.tool AS tool, "
        "e.reference AS reference, e.model AS model "
        "ORDER BY e.ela_run_id LIMIT 1", d=dataset_id)
    if not run:
        return {"dataset_id": dataset_id, "run": None, "states": [], "tipping_points": [],
                "disconnectivity": None, "observed": None,
                "value_declaration": None, "caveats": [],
                "absent_reason": (
                    "No energy-landscape run has been ingested for this dataset. The "
                    "landscape is computed offline (tools/ela, rELA pinned) and written "
                    "to the graph explicitly — nothing here is computed on the fly, so "
                    "an absent run stays visibly absent instead of being invented.")}
    r0 = run[0]
    ela_run = r0["ela_run_id"]
    states = _q(
        """
        MATCH (x:StableState {dataset_id:$d, ela_run_id:$run})
        OPTIONAL MATCH (x)-[:HAS_ACTIVE]->(a:ASV {dataset_id:$d})
        WITH x, a ORDER BY a.id
        WITH x, [m IN collect(a) | {id: m.id, genus: m.genus, cluster: m.louvain_label}] AS act
        RETURN x.state_id AS state_id, x.energy AS energy, x.recurrence AS recurrence,
               x.n_active AS n_active, act AS active
        ORDER BY x.energy, x.state_id
        """, d=dataset_id, run=ela_run)
    tippings = _q(
        "MATCH (a:StableState {dataset_id:$d, ela_run_id:$run})-[t:TIPPING]->"
        "(b:StableState {dataset_id:$d, ela_run_id:$run}) "
        "RETURN a.state_id AS ss1, b.state_id AS ss2, t.energy AS energy, "
        "a.state_id + '|' + b.state_id AS pair_id "
        "ORDER BY t.energy, pair_id", d=dataset_id, run=ela_run)
    tree, barrier = _ela_single_linkage(states, tippings)
    for st in states:
        st["barrier"] = barrier.get(st["state_id"])
        counts: dict = {}
        for a in st["active"]:
            if a["cluster"] is not None:
                counts[a["cluster"]] = counts.get(a["cluster"], 0) + 1
        st["cluster_counts"] = {str(k): v for k, v in sorted(counts.items())}
        st["majority_cluster"] = (max(sorted(counts), key=lambda c: counts[c])
                                  if counts else None)
    observed_samples = _q(
        "MATCH (x:Sample {dataset_id:$d})-[r:HAS_ELA_ENERGY]->"
        "(:ElaRun {dataset_id:$d, ela_run_id:$run}) "
        "RETURN x.sample_id AS sample, x.date AS date, r.energy AS energy, "
        "r.basin AS basin ORDER BY coalesce(x.date, x.sample_id), sample",
        d=dataset_id, run=ela_run)
    observed = {
        "samples": observed_samples,
        "method": ("each sample's energy is the fitted base model evaluated at that "
                   "sample's binarised composition (rELA Energy); its basin is the "
                   "stable state reached by steepest descent (rELA Bi)."),
        "reference": "figure style after Oldenburg et al. 2024, Commun Earth Environ 5:643, Fig. 5",
        "absent_reason": (None if observed_samples else
                          "this run was ingested without per-sample energies — "
                          "re-run tools/ela/ingest_ela.py with a result that carries "
                          "observed_communities."),
    }
    return {
        "dataset_id": dataset_id,
        "run": r0,
        "states": states,
        "tipping_points": tippings,
        "disconnectivity": tree,
        "observed": observed,
        "value_declaration": {
            **semantics.value_declaration(_q, dataset_id,
                f"presence/absence per sample (relative value >= {r0['ath']}), "
                f"pairwise maximum-entropy model over {r0['n_species_model']} model taxa"),
            "applies_to": "states[].energy, states[].barrier, tipping_points[].energy, "
                          "observed.samples[].energy and disconnectivity merge energies",
        },
        "caveats": [
            "The model sees only the binarised co-occurrence of the model taxa — no "
            "abundance heights, no time order, no environmental covariates (base model).",
            "recurrence is the share of bootstrap refits reproducing a state; it measures "
            "fitting uncertainty, not sampling uncertainty.",
            "A deep state is a finding about the model, not proof of an ecological "
            "attractor — the interpretation belongs to the cited reference.",
            "The disconnectivity graph and the barriers are a lossless re-arrangement of "
            "the passes listed above (single linkage over pass energies) — no new "
            "measurement enters the figure.",
            "Observed-community energies are model evaluations, not measurements — lower "
            "means more stable IN THE FITTED MODEL; a state's cluster label names the "
            "majority Louvain cluster of its active taxa, and mixed states stay visible "
            "as mixed.",
        ],
        "absent_reason": None,
    }


@app.get("/datasets/{dataset_id}/wheel", dependencies=[Depends(visible_dataset)])
def wheel(dataset_id: str, year: str | None = Query(None)):
    labels = [r["l"] for r in _q(
        "MATCH (a:ASV {dataset_id:$d}) WHERE a.louvain_label IS NOT NULL "
        "RETURN DISTINCT a.louvain_label AS l ORDER BY l", d=dataset_id)]
    if not labels:
        raise HTTPException(404, f"kein Netzwerk für dataset_id={dataset_id!r}")
    axis = _time_axis(dataset_id)

    pairs = _q(
        """
        MATCH (a:ASV {dataset_id:$d})-[r:CO_OCCURS_WITH {dataset_id:$d}]->(b:ASV {dataset_id:$d})
        WHERE a.louvain_label IS NOT NULL AND b.louvain_label IS NOT NULL
          AND a.louvain_label <> b.louvain_label
        WITH CASE WHEN a.louvain_label < b.louvain_label THEN a.louvain_label
             ELSE b.louvain_label END AS ca,
             CASE WHEN a.louvain_label < b.louvain_label THEN b.louvain_label
             ELSE a.louvain_label END AS cb,
             size([(a)-[f:INFLUENCES {dataset_id:$d}]->(b) | f])
           + size([(b)-[k:INFLUENCES {dataset_id:$d}]->(a) | k]) AS dirs
        RETURN ca, cb, count(*) AS n_con,
               sum(CASE WHEN dirs > 0 THEN 1 ELSE 0 END) AS n_with_ccm,
               sum(dirs) AS n_ccm_directions
        ORDER BY n_con DESC, ca, cb
        """, d=dataset_id)
    nmi_rows = _q(
        """
        MATCH (a:ASV {dataset_id:$d})-[f:INFLUENCES {dataset_id:$d}]->(b:ASV {dataset_id:$d})
        WHERE a.louvain_label IS NOT NULL AND b.louvain_label IS NOT NULL
          AND a.louvain_label <> b.louvain_label
        WITH CASE WHEN a.louvain_label < b.louvain_label THEN a.louvain_label
             ELSE b.louvain_label END AS ca,
             CASE WHEN a.louvain_label < b.louvain_label THEN b.louvain_label
             ELSE a.louvain_label END AS cb, f.nmi AS c
        RETURN ca, cb, avg(c) AS mean_nmi
        """, d=dataset_id)
    nmi_mean = {(r["ca"], r["cb"]): r["mean_nmi"] for r in nmi_rows}
    for p in pairs:
        p["mean_nmi"] = nmi_mean.get((p["ca"], p["cb"]))

    base = {"dataset_id": dataset_id, "time_axis": axis, "months": semantics.MONTHS,
            "pairs": pairs,
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
            raise HTTPException(422, f"unbekanntes Jahr {year!r} fuer dataset_id={dataset_id!r} "
                                     f"— vorhanden: {[y['year'] for y in years]}")
        base["year"] = sel

    samples = _q(
        """
        MATCH (s:Sample {dataset_id:$d})
        OPTIONAL MATCH (s)-[all:HAS_ABUNDANCE]->(:ASV {dataset_id:$d})
        WITH s, coalesce(sum(all.count), 0.0) AS live_total
        RETURN s.sample_id AS sample, s.date AS date,
               coalesce(s.analysed_reads_total, live_total) AS total
        ORDER BY s.date, s.sample_id
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
        act = semantics.activity(semantics.frequency(_q, dataset_id, series, with_rank=False))
        clusters.append({
            "louvain_label": l, "n_members": n_members.get(l, 0),
            "window": act["window"],
            "window_months": [month_no[m] for m in act["window"]],
            "peak": act["peak"],
            "peak_month": month_no.get(act["peak"]),
            "n_min": act["n_min"], "statement": act["statement"],
        })
    clusters.sort(key=lambda c: (not c["window_months"], c["window_months"][0]
                                 if c["window_months"] else 99, c["louvain_label"]))

    env_rows = _q(
        "MATCH (s:Sample {dataset_id:$d}) RETURN s.date AS date, "
        + ", ".join(f"s.{v['key']} AS {v['key']}" for v in semantics.ENVIRONMENT_VARS)
        + " ORDER BY s.date, s.sample_id", d=dataset_id)
    if year is not None:
        env_rows = [r for r in env_rows if str(r["date"]).startswith(year)]
    env_vars, env_monthly = [], {}
    for v in semantics.ENVIRONMENT_VARS:
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
                            "units_note": semantics.ENVIRONMENT_UNITS_NOTE} if env_vars else None,
            "absent_reason": None}

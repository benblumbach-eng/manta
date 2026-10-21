from __future__ import annotations

import csv
import datetime
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from collections import deque
from contextlib import contextmanager
from pathlib import Path
from typing import Callable

import otter_estimate

BACKEND = Path(__file__).resolve().parent
REPO = BACKEND.parents[2]
CONVERT_DIR = REPO / "tools" / "dada2_to_otter"
OTTER = REPO / "submodules" / "otter"
OTTER_RUNNER = REPO / "tools" / "otter_runner" / "run_otter.py"
INGEST_DIR = REPO / "tools" / "neo4j_ingest"
FIXTURE = BACKEND / "import_fixture"
FIXTURE_SCRIPT = BACKEND / "make_import_fixture.R"
DADA2_MANIFEST = "dada2_manifest.json"
PLACEHOLDER_DATES = "placeholder_dates.txt"
CONVERT_NOTES = "convert_notes.txt"

NO_INPUT = ("No input given: the bundled demo dataset is not available on this installation. "
            "Upload your own files instead (DADA2 output, OTTER input tables or an OTTER result).")


def ensure_fixture() -> bool:
    if (FIXTURE / "metadata.csv").exists():
        return True
    if FIXTURE_SCRIPT.exists() and shutil.which("Rscript"):
        try:
            subprocess.run(["Rscript", str(FIXTURE_SCRIPT)],
                           capture_output=True, text=True, check=False)
        except OSError:
            return False
    return (FIXTURE / "metadata.csv").exists()



_ISO_SHAPE = re.compile(r"\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2})?$")


def calendar_day(label: str | None) -> str | None:
    s = (label or "").strip()
    if not _ISO_SHAPE.match(s):
        return None
    try:
        datetime.date.fromisoformat(s[:10])
    except ValueError:
        return None
    return s[:10]


def impossible_dates(labels: list[str]) -> list[str]:
    return [s for s in labels if _ISO_SHAPE.match((s or "").strip()) and calendar_day(s) is None]


def axis_from_labels(labels: list[str]) -> str:
    return "dates" if labels and all(calendar_day(s) for s in labels) else "ordinal"


def _abundance_axis(csv_dir: Path) -> str:
    try:
        with (csv_dir / "abundance.csv").open(newline="", encoding="utf-8") as fh:
            labels = [r[0] for r in list(csv.reader(fh, delimiter=";"))[1:] if r]
    except OSError:
        return "ordinal"
    return axis_from_labels(labels) if labels else "ordinal"


def _truthy(v) -> bool:
    if isinstance(v, str):
        return v.strip().lower() not in ("", "false", "no", "0", "none", "null")
    return bool(v)


def _says_synthetic(obj) -> bool:
    if isinstance(obj, dict):
        for k, v in obj.items():
            key = str(k).lower()
            if "synth" in key and _truthy(v):
                return True
            if key == "time_axis" and v == "ordinal":
                return True
            if isinstance(v, str) and v.strip().lower() in ("synthetic", "synthesised",
                                                             "synthesized", "placeholder"):
                return True
            if _says_synthetic(v):
                return True
    elif isinstance(obj, list):
        return any(_says_synthetic(x) for x in obj)
    return False


def synthetic_dates(*dirs: Path | None) -> bool:
    for d in dirs:
        if d is None or not Path(d).is_dir():
            continue
        if (Path(d) / PLACEHOLDER_DATES).exists():
            return True
        if any(tag in p.name.lower() for p in Path(d).iterdir()
               for tag in ("placeholder_dates", "synthetic_dates", "synthetic_order")):
            return True
        manifest = Path(d) / DADA2_MANIFEST
        if manifest.is_file():
            try:
                if _says_synthetic(json.loads(manifest.read_text(encoding="utf-8"))):
                    return True
            except (OSError, ValueError):
                continue
    return False


def tool_status() -> dict:
    have = {
        "convert": (CONVERT_DIR / ".venv/bin/python").exists(),
        "otter": (OTTER / ".venv/bin/python").exists() and OTTER_RUNNER.exists(),
        "ingest": (INGEST_DIR / ".venv/bin/python").exists(),
    }
    needs = {
        "fastq": ("convert", "otter", "ingest"),
        "dada2": ("convert", "otter", "ingest"),
        "tables": ("otter", "ingest"),
        "otterout": ("ingest",),
        "recompute": ("otter", "ingest"),
    }
    entries = {}
    for entry, tools in needs.items():
        missing = [t for t in tools if not have[t]]
        entries[entry] = {"ok": not missing, "missing": missing}
    return {"tools": have, "entries": entries}

POST_STAGE = "annotate"
STAGES = ("convert", "otter", "ingest", POST_STAGE)
STAGES_FASTQ = ("dada2",) + STAGES
STAGES_TABLES = ("otter", "ingest", POST_STAGE)
STAGES_INGEST = ("ingest", POST_STAGE)
TRAITS_SCRIPT = REPO / "tools" / "traits" / "annotate.py"
ENV_LINKS_SCRIPT = REPO / "tools" / "env_links" / "compute.py"
POST_STAGE_AT = 0.98
NOTE_NO_READ_TRACKING = ("Read tracking not provided: the per-sample read-retention check "
                         "was skipped.")
NOTE_TRAITS_MISSING = ("No function annotation: run bash tools/traits/fetch_sources.sh — "
                       "imports after that are annotated.")
DADA2_SCRIPT = CONVERT_DIR / "run_dada2.R"
OTTER_BACKUP = Path.home() / "otter_sicherung"

_jobs: dict[str, dict] = {}
_lock = threading.Lock()


_active: dict[str, str] = {}


class DatasetBusy(Exception):
    pass


def reserve(dataset_id: str, holder: str) -> None:
    with _lock:
        if dataset_id in _active:
            raise DatasetBusy(
                f"{dataset_id!r} is busy: {_active[dataset_id]} is still running on it. "
                f"Wait until it has finished, then try again.")
        _active[dataset_id] = holder


def release(dataset_id: str) -> None:
    with _lock:
        _active.pop(dataset_id, None)


def busy(dataset_id: str) -> str | None:
    with _lock:
        return _active.get(dataset_id)


@contextmanager
def hold(dataset_id: str, holder: str):
    reserve(dataset_id, holder)
    try:
        yield
    finally:
        release(dataset_id)


def _set(job_id: str, **kw) -> None:
    if "stage" in kw:
        kw.setdefault("stage_started_at", time.time())
    if kw.get("status") in ("done", "error"):
        kw.setdefault("finished_at", time.time())
    with _lock:
        _jobs[job_id].update(kw)


def get_status(job_id: str) -> dict | None:
    with _lock:
        j = _jobs.get(job_id)
        return dict(j) if j else None


def list_jobs(limit: int = 20) -> list[dict]:
    with _lock:
        jobs = [dict(j) for j in _jobs.values()]
    jobs.sort(key=lambda j: j.get("started_at") or 0, reverse=True)
    return jobs[:limit]


_KNOWN_FAILURES = [
    ("ZeroDivisionError", "otter",
     "The network has no edges at all — with so few time points no correlation can be "
     "computed. A network needs a real time series."),
    ("ServiceUnavailable", "ingest",
     "The database did not answer. It may not be running, or the machine was still too busy "
     "after the computation."),
    ("no such file", "convert",
     "The DADA2 run did not produce all expected files."),
]


def _explain(name: str, tail: str) -> str:
    for needle, stage, msg in _KNOWN_FAILURES:
        if stage == name and needle.lower() in tail.lower():
            return msg
    return ""


def _run_sub(name: str, cmd: list[str], cwd: Path | None = None, env: dict | None = None,
             on_line=None) -> None:
    proc = subprocess.Popen(cmd, cwd=str(cwd) if cwd else None, env=env,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    tail: deque[str] = deque(maxlen=80)
    assert proc.stdout is not None
    for line in proc.stdout:
        line = line.rstrip()
        if line:
            tail.append(line)
            if on_line:
                on_line(line)
    proc.wait()
    if proc.returncode != 0:
        txt = "\n".join(tail).strip()[-800:]
        hint = _explain(name, txt)
        raise RuntimeError(f"{hint} [stage '{name}', details: {txt[-300:]}]" if hint
                           else f"Stage '{name}' exit {proc.returncode}: {txt}")


# Share of the import bar per stage, by running time: DADA2 and OTTER take hours, the rest minutes.
_STAGE_WEIGHTS = {"dada2": 20, "convert": 1, "otter": 20, "ingest": 1}
_OTTER_STEPS = ["CON", "CCMN", "Louvain", "Mapping", "PVAL + Enrich"]
_TQDM_PCT = re.compile(r"(\d{1,3})%\|")


def _otter_spans(csv_dir: Path, thresholds: dict | None) -> list:
    try:
        n_asv, n_samples = abundance_size(csv_dir)
    except OSError:
        n_asv, n_samples = 0, 0
    t = thresholds or {}
    sek = otter_estimate.stage_seconds(n_asv, n_samples, t.get("num_permutations"),
                                       t.get("num_samples"))
    klein = 0.01 * (sum(sek.values()) or 1)
    dauer = [sek.get(schritt, klein) or klein for schritt in _OTTER_STEPS]
    gesamt = sum(dauer)
    spans, lo = [], 0.0
    for schritt, d in zip(_OTTER_STEPS, dauer):
        spans.append(((f"[otter] {schritt}",), lo, lo + d / gesamt, schritt))
        lo += d / gesamt
    spans.append((("[otter] done",), 1.0, 1.0, "done"))
    return spans


def _rest(sekunden: float) -> str:
    minuten = max(1, round(sekunden / 60))
    return f"about {minuten} min left" if minuten < 60 else \
        f"about {minuten // 60} h {minuten % 60:02d} min left"


def _otter_progress_cb(job_id: str, base: float, span: float, spans: list):
    state = {"lo": 0.0, "hi": 0.0, "label": "otter", "best": 0.0, "start": time.monotonic()}

    def _push(frac: float, label: str) -> None:
        if frac > state["best"]:
            state["best"] = frac
            vergangen = time.monotonic() - state["start"]
            if 0.02 <= frac < 1.0 and vergangen >= 60:
                label += f" · {_rest(vergangen * (1 - frac) / frac)}"
            _set(job_id, progress=round(base + frac * span, 4), stage_detail=label)

    def cb(line: str) -> None:
        for marks, lo, hi, label in spans:
            if line.startswith(marks):
                state.update(lo=lo, hi=hi, label=label)
                _push(lo, state["label"])
                return
        m = _TQDM_PCT.search(line)
        if m:
            f = min(100, int(m.group(1))) / 100.0
            _push(state["lo"] + f * (state["hi"] - state["lo"]),
                  f"{state['label']} {m.group(1)} %")
    return cb


def _run(job_id: str, rdata_dir: Path, dataset_id: str, run_id: str,
         marker: str, region: str, station: str | None,
         lat: float | None = None, lon: float | None = None,
         fastq_dir: Path | None = None, dada2_env: dict | None = None,
         time_axis: str | None = None, thresholds: dict | None = None,
         tables_dir: Path | None = None, otter_out_dir: Path | None = None,
         source_doi: str | None = None, citation: str | None = None,
         replace_wipe: "Callable[[], Callable[[], None] | None] | None" = None,
         keep_otter: bool = False) -> None:
    work = Path(tempfile.mkdtemp(prefix=f"manta_import_{job_id}_"))
    alt_geloescht = False
    csv_dir, otter_out = work / "csv", work / "otter"
    stages_list = (get_status(job_id) or {}).get("stages") or list(STAGES)
    stages_main = [s for s in stages_list if s != POST_STAGE]
    gewicht = {s: _STAGE_WEIGHTS.get(s, 1) for s in stages_main}
    summe = sum(gewicht.values()) or 1

    def _stage_base(name: str) -> float:
        if name not in stages_main:
            return 0.0
        return sum(gewicht[s] for s in stages_main[:stages_main.index(name)]) / summe

    entry_point = ("otter_output" if otter_out_dir is not None else
                   "otter_input" if tables_dir is not None else
                   "fastq" if fastq_dir is not None else "dada2_output")
    notes: list[str] = []
    try:
        if otter_out_dir is not None:
            csv_dir = otter_out = otter_out_dir
        elif tables_dir is not None:
            csv_dir = tables_dir
        else:
            if fastq_dir is not None:
                _set(job_id, stage="dada2", progress=round(_stage_base("dada2"), 4), stage_detail="DADA2 run")
                rdata_dir = work / "dada2"
                rdata_dir.mkdir(parents=True, exist_ok=True)
                env = dict(os.environ, **(dada2_env or {}))
                _run_sub("dada2", ["Rscript", str(DADA2_SCRIPT), str(fastq_dir), str(rdata_dir)], env=env)
                echte_daten = bool(env.get("MANTA_METADATA"))
            else:
                echte_daten = Path(rdata_dir).resolve() != FIXTURE.resolve()
            _set(job_id, stage="convert", progress=round(_stage_base("convert"), 4), stage_detail="format conversion")
            _run_sub("convert", [str(CONVERT_DIR / ".venv/bin/python"), str(CONVERT_DIR / "convert.py"),
                                 "--in", str(rdata_dir), "--out", str(csv_dir)])
            if not (csv_dir / "read_tracking_report.csv").exists():
                notes.append(NOTE_NO_READ_TRACKING)
            if (csv_dir / CONVERT_NOTES).exists():
                notes += (csv_dir / CONVERT_NOTES).read_text(encoding="utf-8").splitlines()
            if time_axis is None:
                time_axis = ("dates" if echte_daten and not synthetic_dates(rdata_dir, csv_dir)
                             and _abundance_axis(csv_dir) == "dates" else "ordinal")

        if otter_out_dir is None:
            _otter_check(job_id, csv_dir, thresholds)
            _set(job_id, stage="otter", progress=round(_stage_base("otter"), 4))
            otter_cmd = [str(OTTER / ".venv/bin/python"), str(OTTER_RUNNER),
                         "--otter-root", str(OTTER),
                         "--abundance", str(csv_dir / "abundance.csv"),
                         "--taxa", str(csv_dir / "taxa_info.csv"),
                         "--environment", str(csv_dir / "environment_info.csv"),
                         "--out", str(otter_out), "--run-id", run_id]
            for key in THRESHOLD_ARGS:
                if (thresholds or {}).get(key) is not None:
                    otter_cmd += [f"--{key.replace('_', '-')}", str(thresholds[key])]
            _run_sub("otter", otter_cmd, cwd=OTTER,
                     on_line=_otter_progress_cb(job_id, _stage_base("otter"),
                                                gewicht.get("otter", 1) / summe,
                                                _otter_spans(csv_dir, thresholds)))
            if keep_otter:
                ziel = OTTER_BACKUP / f"{dataset_id}_{datetime.datetime.now():%Y-%m-%d_%H%M%S}"
                shutil.copytree(csv_dir, ziel / "input")
                shutil.copytree(otter_out, ziel / "otter")
                notes.append(f"OTTER input and output saved to {ziel}")

        _set(job_id, stage="ingest", progress=round(_stage_base("ingest"), 4),
             stage_detail="loading the graph")
        env = _ingest_env(otter_out, csv_dir)
        ingest_cmd = [str(INGEST_DIR / ".venv/bin/python"), str(INGEST_DIR / "ingest.py"),
                      "--dataset-id", dataset_id, "--run-id", run_id,
                      "--marker", marker, "--region", region,
                      "--time-axis", time_axis or "ordinal",
                      "--entry-point", entry_point]
        if station:
            ingest_cmd += ["--station", station]
        if lat is not None and lon is not None:
            ingest_cmd += ["--lat", str(lat), "--lon", str(lon)]
        if source_doi:
            ingest_cmd += ["--source-doi", source_doi]
        if citation:
            ingest_cmd += ["--citation", citation]
        zurueck = None
        if replace_wipe is not None:
            _set(job_id, stage_detail="replacing the old dataset")
            zurueck = replace_wipe()
            alt_geloescht = True
            _set(job_id, old_dataset_deleted=True, stage_detail="loading the graph")
        _run_sub("ingest", ingest_cmd, env=env)
        if zurueck is not None:
            zurueck()

        notes += _post_stage(job_id, dataset_id)
        _set(job_id, status="done", stage="done", progress=1.0, notes=notes)
    except Exception as e:
        fehler = str(e)
        if alt_geloescht:
            fehler += (" The old dataset under this name had already been deleted when the "
                       "import failed — import it again.")
        _set(job_id, status="error", error=fehler)
    finally:
        release(dataset_id)
        shutil.rmtree(work, ignore_errors=True)
        for d in (rdata_dir, tables_dir, otter_out_dir,
                  fastq_dir.parent if fastq_dir is not None else None):
            if d is not None and _is_own_upload_dir(Path(d)):
                shutil.rmtree(d, ignore_errors=True)


def abundance_size(csv_dir: Path) -> tuple[int, int]:
    with (Path(csv_dir) / "abundance.csv").open(newline="", encoding="utf-8") as fh:
        rows = csv.reader(fh, delimiter=";")
        kopf = next(rows, [])
        n_samples = sum(1 for r in rows if r and r[0].strip())
    return len([c for c in kopf[1:] if c.strip()]), n_samples


def _otter_check(job_id: str, csv_dir: Path, thresholds: dict | None) -> dict | None:
    if not (Path(csv_dir) / "abundance.csv").is_file():
        return None
    n_asv, n_samples = abundance_size(csv_dir)
    t = thresholds or {}
    est = otter_estimate.estimate(n_asv, n_samples, t.get("num_permutations"),
                                  t.get("num_samples"))
    _set(job_id, estimate=est)
    if not est["fits"]:
        raise RuntimeError(est["refusal"])
    return est


def _tail(e: Exception, limit: int = 160) -> str:
    zeilen = [z.strip() for z in str(e).splitlines() if z.strip()]
    return (zeilen[-1] if zeilen else str(e))[-limit:]


def _post_stage(job_id: str, dataset_id: str) -> list[str]:
    notes: list[str] = []
    _set(job_id, stage=POST_STAGE, progress=POST_STAGE_AT, stage_detail="function annotation")
    try:
        _run_sub("traits", [str(INGEST_DIR / ".venv/bin/python"), str(TRAITS_SCRIPT), dataset_id])
    except Exception as e:
        notes.append(NOTE_TRAITS_MISSING if "fetch_sources.sh" in str(e)
                     else f"Function annotation failed: {_tail(e)}")
    _set(job_id, stage_detail="environment links")
    try:
        _run_sub("envlinks", [sys.executable, str(ENV_LINKS_SCRIPT), dataset_id])
    except Exception as e:
        notes.append(f"Environment links failed: {_tail(e)}")
    return notes


def _ingest_env(otter_out: Path, csv_dir: Path) -> dict:
    return dict(os.environ, OTTER_OUT_DIR=str(otter_out), OTTER_INPUT_DIR=str(csv_dir))


def _is_own_upload_dir(d: Path) -> bool:
    try:
        tmp = Path(tempfile.gettempdir()).resolve()
        return (d.resolve().parent == tmp
                and d.name.startswith(("manta_upload_", "manta_fastq_")))
    except OSError:
        return False


RECOMPUTE_STAGES = ("export", "otter", "copy", "ingest", POST_STAGE)
COPY_SCRIPT = INGEST_DIR / "copy_dataset.py"

THRESHOLD_ARGS = ("con_tr", "con_alpha", "ccmn_tr", "louvain_res", "fft_coeffs",
                  "num_permutations", "num_samples")


def _recompute(job_id: str, dataset_id: str, new_dataset_id: str, label: str, at: str,
               run_id: str, thresholds: dict, time_axis: str,
               discard_new: "Callable[[], None] | None" = None) -> None:
    work = Path(tempfile.mkdtemp(prefix=f"manta_recompute_{job_id}_"))
    csv_dir, otter_out = work / "csv", work / "otter"
    kopiert = False
    try:
        _set(job_id, stage="export", progress=0.0, stage_detail="reading the samples back")
        _run_sub("export", [str(INGEST_DIR / ".venv/bin/python"),
                            str(INGEST_DIR / "export_otter_csv.py"),
                            "--dataset-id", dataset_id, "--out", str(csv_dir)],
                 cwd=INGEST_DIR)

        _otter_check(job_id, csv_dir, thresholds)
        _set(job_id, stage="otter", progress=RECOMPUTE_OTTER_SPAN[0], stage_detail="otter")
        cmd = [str(OTTER / ".venv/bin/python"), str(OTTER_RUNNER),
               "--otter-root", str(OTTER),
               "--abundance", str(csv_dir / "abundance.csv"),
               "--taxa", str(csv_dir / "taxa_info.csv"),
               "--environment", str(csv_dir / "environment_info.csv"),
               "--out", str(otter_out), "--run-id", run_id]
        for key in THRESHOLD_ARGS:
            if thresholds.get(key) is not None:
                cmd += [f"--{key.replace('_', '-')}", str(thresholds[key])]
        lo, hi = RECOMPUTE_OTTER_SPAN
        _run_sub("otter", cmd, cwd=OTTER, on_line=_otter_progress_cb(
            job_id, lo, hi - lo, _otter_spans(csv_dir, thresholds)))

        _set(job_id, stage="copy", progress=hi, stage_detail="copying samples into the new dataset")
        kopiert = True
        _run_sub("copy", [str(INGEST_DIR / ".venv/bin/python"), str(COPY_SCRIPT),
                          "--from", dataset_id, "--to", new_dataset_id, "--label", label,
                          "--at", at, "--params", json.dumps(thresholds)],
                 cwd=INGEST_DIR)

        _set(job_id, stage="ingest", progress=RECOMPUTE_INGEST_AT, stage_detail="loading the graph")
        env = _ingest_env(otter_out, csv_dir)
        ingest_cmd = [str(INGEST_DIR / ".venv/bin/python"), str(INGEST_DIR / "ingest.py"),
                      "--dataset-id", new_dataset_id, "--run-id", run_id,
                      "--time-axis", time_axis or "ordinal", "--network-only"]
        _run_sub("ingest", ingest_cmd, env=env)

        notes = _post_stage(job_id, new_dataset_id)
        _set(job_id, status="done", stage="done", progress=1.0, notes=notes)
    except Exception as e:
        fehler = str(e)
        if kopiert and discard_new is not None:
            try:
                discard_new()
                fehler += (f" The half-built dataset {new_dataset_id!r} was removed again; "
                           f"the original is unchanged.")
            except Exception as weg:
                fehler += (f" Removing the half-built dataset {new_dataset_id!r} failed too "
                           f"({weg}); delete it from the list. The original is unchanged.")
        _set(job_id, status="error", error=fehler)
    finally:
        release(dataset_id)
        release(new_dataset_id)
        shutil.rmtree(work, ignore_errors=True)


RECOMPUTE_OTTER_SPAN = (0.05, 0.90)
RECOMPUTE_INGEST_AT = 0.95


def _start(target, args: tuple, job_id: str, dataset_id: str, reserved: bool,
           background: bool) -> str:
    try:
        if background:
            threading.Thread(target=target, args=args, daemon=True).start()
        else:
            target(*args)
    except BaseException:
        if not background:
            raise
        _set(job_id, status="error", error="the job could not be started")
        if not reserved:
            release(dataset_id)
        raise
    return job_id


def start_recompute(dataset_id: str, new_dataset_id: str, label: str, run_id: str,
                    thresholds: dict, time_axis: str = "ordinal", at: str | None = None,
                    background: bool = True, reserved: bool = False,
                    estimate: dict | None = None,
                    discard_new: "Callable[[], None] | None" = None) -> str:
    job_id = uuid.uuid4().hex[:12]
    holder = f"recompute job {job_id}"
    if reserved:
        with _lock:
            _active[dataset_id] = holder
            _active[new_dataset_id] = holder
    else:
        reserve(dataset_id, holder)
        try:
            reserve(new_dataset_id, holder)
        except DatasetBusy:
            release(dataset_id)
            raise
    at = at or datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
    with _lock:
        _jobs[job_id] = {"job_id": job_id, "status": "running", "stage": "queued",
                         "kind": "recompute", "dataset_id": new_dataset_id,
                         "source_dataset_id": dataset_id, "label": label,
                         "stages": list(RECOMPUTE_STAGES), "progress": 0.0,
                         "estimate": estimate,
                         "started_at": time.time(), "stage_started_at": time.time()}
    args = (job_id, dataset_id, new_dataset_id, label, at, run_id, thresholds, time_axis,
            discard_new)
    try:
        return _start(_recompute, args, job_id, dataset_id, reserved, background)
    except BaseException:
        if background and not reserved:
            release(new_dataset_id)
        raise


def start_import(dataset_id: str, marker: str = "18S",
                 region: str = "Imported dataset", station: str | None = None,
                 run_id: str = "PyTest", rdata_dir: Path | None = None,
                 background: bool = True,
                 lat: float | None = None, lon: float | None = None,
                 fastq_dir: Path | None = None, dada2_env: dict | None = None,
                 time_axis: str | None = None, thresholds: dict | None = None,
                 tables_dir: Path | None = None, otter_out_dir: Path | None = None,
                 source_doi: str | None = None, citation: str | None = None,
                 reserved: bool = False,
                 replace_wipe: "Callable[[], Callable[[], None] | None] | None" = None,
                 keep_otter: bool = False) -> str:
    rdata_dir = (Path(rdata_dir) if rdata_dir
                 else (None if (fastq_dir or tables_dir or otter_out_dir) else FIXTURE))
    if rdata_dir == FIXTURE and not ensure_fixture():
        raise ValueError(NO_INPUT)
    job_id = uuid.uuid4().hex[:12]
    if reserved:
        with _lock:
            _active[dataset_id] = f"import job {job_id}"
    else:
        reserve(dataset_id, f"import job {job_id}")
    stages = (STAGES_INGEST if otter_out_dir else
              STAGES_TABLES if tables_dir else
              STAGES_FASTQ if fastq_dir else STAGES)
    with _lock:
        _jobs[job_id] = {"job_id": job_id, "status": "running", "stage": "queued",
                         "kind": "import", "dataset_id": dataset_id, "stages": list(stages),
                         "replace": replace_wipe is not None,
                         "started_at": time.time(), "stage_started_at": time.time()}
    args = (job_id, rdata_dir, dataset_id, run_id, marker, region, station, lat, lon,
            fastq_dir, dada2_env, time_axis, thresholds, tables_dir, otter_out_dir,
            source_doi, citation, replace_wipe, keep_otter)
    return _start(_run, args, job_id, dataset_id, reserved, background)

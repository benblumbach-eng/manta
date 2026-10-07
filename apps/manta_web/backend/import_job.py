from __future__ import annotations

import csv
import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
from collections import deque
from pathlib import Path

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



_ISO_DATE = re.compile(r"\d{4}-\d{2}-\d{2}$")


def axis_from_labels(labels: list[str]) -> str:
    return "dates" if all(_ISO_DATE.match(s or "") for s in labels) else "ordinal"


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

STAGES = ("convert", "otter", "ingest")
STAGES_FASTQ = ("dada2",) + STAGES
STAGES_TABLES = ("otter", "ingest")
STAGES_INGEST = ("ingest",)
DADA2_SCRIPT = CONVERT_DIR / "run_dada2.R"

_jobs: dict[str, dict] = {}
_lock = threading.Lock()


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


_OTTER_SPANS = [(("[otter] CON",), 0.02, 0.05, "CON"), (("[otter] CCMN",), 0.05, 0.40, "CCMN"),
                (("[otter] Louvain",), 0.40, 0.42, "Louvain"),
                (("[otter] Mapping",), 0.42, 0.44, "Mapping"),
                (("[otter] PVAL + Enrich",), 0.44, 0.99, "PVAL + Enrich"),
                (("[otter] done",), 1.0, 1.0, "done")]
_TQDM_PCT = re.compile(r"(\d{1,3})%\|")


def _otter_progress_cb(job_id: str, base: float, span: float):
    state = {"lo": 0.0, "hi": 0.02, "label": "otter", "best": 0.0}

    def _push(frac: float, label: str) -> None:
        if frac > state["best"]:
            state["best"] = frac
            _set(job_id, progress=round(base + frac * span, 4), stage_detail=label)

    def cb(line: str) -> None:
        for marks, lo, hi, label in _OTTER_SPANS:
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
         source_doi: str | None = None, citation: str | None = None) -> None:
    work = Path(tempfile.mkdtemp(prefix=f"manta_import_{job_id}_"))
    csv_dir, otter_out = work / "csv", work / "otter"
    stages_list = (get_status(job_id) or {}).get("stages") or list(STAGES)
    n_stages = max(1, len(stages_list))

    def _stage_base(name: str) -> float:
        return stages_list.index(name) / n_stages if name in stages_list else 0.0

    entry_point = ("otter_output" if otter_out_dir is not None else
                   "otter_input" if tables_dir is not None else
                   "fastq" if fastq_dir is not None else "dada2_output")
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
            if time_axis is None:
                time_axis = ("dates" if echte_daten and not synthetic_dates(rdata_dir, csv_dir)
                             and _abundance_axis(csv_dir) == "dates" else "ordinal")

        if otter_out_dir is None:
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
                     on_line=_otter_progress_cb(job_id, _stage_base("otter"), 1.0 / n_stages))

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
        _run_sub("ingest", ingest_cmd, env=env)

        _set(job_id, status="done", stage="done", progress=1.0)
    except Exception as e:
        _set(job_id, status="error", error=str(e))
    finally:
        shutil.rmtree(work, ignore_errors=True)
        for d in (rdata_dir, tables_dir, otter_out_dir,
                  fastq_dir.parent if fastq_dir is not None else None):
            if d is not None and _is_own_upload_dir(Path(d)):
                shutil.rmtree(d, ignore_errors=True)


def _ingest_env(otter_out: Path, csv_dir: Path) -> dict:
    return dict(os.environ, OTTER_OUT_DIR=str(otter_out), OTTER_INPUT_DIR=str(csv_dir))


def _is_own_upload_dir(d: Path) -> bool:
    try:
        tmp = Path(tempfile.gettempdir()).resolve()
        return (d.resolve().parent == tmp
                and d.name.startswith(("manta_upload_", "manta_fastq_")))
    except OSError:
        return False


RECOMPUTE_STAGES = ("export", "otter", "ingest")

THRESHOLD_ARGS = ("con_tr", "con_alpha", "ccmn_tr", "louvain_res", "fft_coeffs",
                  "num_permutations", "num_samples")


def _recompute(job_id: str, dataset_id: str, run_id: str, thresholds: dict,
               marker: str | None, region: str | None, station: str | None,
               lat: float | None, lon: float | None, time_axis: str) -> None:
    work = Path(tempfile.mkdtemp(prefix=f"manta_recompute_{job_id}_"))
    csv_dir, otter_out = work / "csv", work / "otter"
    try:
        _set(job_id, stage="export")
        _run_sub("export", [str(INGEST_DIR / ".venv/bin/python"),
                            str(INGEST_DIR / "export_otter_csv.py"),
                            "--dataset-id", dataset_id, "--out", str(csv_dir)],
                 cwd=INGEST_DIR)

        _set(job_id, stage="otter")
        cmd = [str(OTTER / ".venv/bin/python"), str(OTTER_RUNNER),
               "--otter-root", str(OTTER),
               "--abundance", str(csv_dir / "abundance.csv"),
               "--taxa", str(csv_dir / "taxa_info.csv"),
               "--environment", str(csv_dir / "environment_info.csv"),
               "--out", str(otter_out), "--run-id", run_id]
        for key in THRESHOLD_ARGS:
            if thresholds.get(key) is not None:
                cmd += [f"--{key.replace('_', '-')}", str(thresholds[key])]
        _run_sub("otter", cmd, cwd=OTTER)

        _set(job_id, stage="ingest")
        env = _ingest_env(otter_out, csv_dir)
        ingest_cmd = [str(INGEST_DIR / ".venv/bin/python"), str(INGEST_DIR / "ingest.py"),
                      "--dataset-id", dataset_id, "--run-id", run_id,
                      "--time-axis", time_axis or "ordinal",
                      "--network-only", "--wipe-network-first"]
        if marker:
            ingest_cmd += ["--marker", marker]
        if region:
            ingest_cmd += ["--region", region]
        if station:
            ingest_cmd += ["--station", station]
        if lat is not None and lon is not None:
            ingest_cmd += ["--lat", str(lat), "--lon", str(lon)]
        _run_sub("ingest", ingest_cmd, env=env)

        _set(job_id, status="done", stage="done")
    except Exception as e:
        _set(job_id, status="error", error=str(e))
    finally:
        shutil.rmtree(work, ignore_errors=True)


def start_recompute(dataset_id: str, run_id: str, thresholds: dict,
                    marker: str | None = None, region: str | None = None,
                    station: str | None = None, lat: float | None = None,
                    lon: float | None = None, time_axis: str = "ordinal",
                    background: bool = True) -> str:
    job_id = uuid.uuid4().hex[:12]
    with _lock:
        _jobs[job_id] = {"job_id": job_id, "status": "running", "stage": "queued",
                         "dataset_id": dataset_id, "stages": list(RECOMPUTE_STAGES),
                         "started_at": time.time(), "stage_started_at": time.time()}
    args = (job_id, dataset_id, run_id, thresholds, marker, region, station, lat, lon, time_axis)
    if background:
        threading.Thread(target=_recompute, args=args, daemon=True).start()
    else:
        _recompute(*args)
    return job_id


def start_import(dataset_id: str, marker: str = "18S",
                 region: str = "Imported dataset", station: str | None = None,
                 run_id: str = "PyTest", rdata_dir: Path | None = None,
                 background: bool = True,
                 lat: float | None = None, lon: float | None = None,
                 fastq_dir: Path | None = None, dada2_env: dict | None = None,
                 time_axis: str | None = None, thresholds: dict | None = None,
                 tables_dir: Path | None = None, otter_out_dir: Path | None = None,
                 source_doi: str | None = None, citation: str | None = None) -> str:
    rdata_dir = (Path(rdata_dir) if rdata_dir
                 else (None if (fastq_dir or tables_dir or otter_out_dir) else FIXTURE))
    if rdata_dir == FIXTURE and not ensure_fixture():
        raise ValueError(NO_INPUT)
    job_id = uuid.uuid4().hex[:12]
    stages = (STAGES_INGEST if otter_out_dir else
              STAGES_TABLES if tables_dir else
              STAGES_FASTQ if fastq_dir else STAGES)
    with _lock:
        _jobs[job_id] = {"job_id": job_id, "status": "running", "stage": "queued",
                         "dataset_id": dataset_id, "stages": list(stages),
                         "started_at": time.time(), "stage_started_at": time.time()}
    args = (job_id, rdata_dir, dataset_id, run_id, marker, region, station, lat, lon,
            fastq_dir, dada2_env, time_axis, thresholds, tables_dir, otter_out_dir,
            source_doi, citation)
    if background:
        threading.Thread(target=_run, args=args, daemon=True).start()
    else:
        _run(*args)
    return job_id

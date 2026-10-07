from __future__ import annotations

import argparse
import hashlib
import sys
from pathlib import Path

import pandas as pd
import pyreadr

SEP = ";"
DADA2_MANIFEST = "dada2_manifest.json"
PLACEHOLDER_DATES = "placeholder_dates.txt"


class InputError(Exception):
    pass


def _read_matrix(path: Path) -> pd.DataFrame:
    if not path.exists():
        raise InputError(f"file not found: {path}")
    result = pyreadr.read_r(str(path))
    if not result:
        raise InputError(f"no R object in {path}")
    return next(iter(result.values()))


RANGSPALTEN = ("kingdom", "phylum", "class", "order", "family", "genus", "species")
TRACKSPALTEN = ("input", "merged", "nonchim")


def _rolle(df: "pd.DataFrame") -> str | None:
    spalten = {str(c).strip().lower() for c in df.columns}
    if len(spalten & set(RANGSPALTEN)) >= 4:
        return "taxa"
    if set(TRACKSPALTEN) <= spalten:
        return "track"
    if len(df.columns) and all(str(t).startswith(("float", "int")) for t in df.dtypes):
        return "abundance"
    return None


def _zuordnen(in_dir: Path) -> dict[str, Path]:
    if not in_dir.is_dir():
        raise InputError(f"not a directory: {in_dir}")
    gefunden: dict[str, list[Path]] = {}
    gesehen: list[str] = []
    for p in sorted(in_dir.iterdir()):
        if not p.is_file() or p.name.startswith(("_", ".")):
            continue
        endung = p.suffix.lower()
        rolle = None
        if endung in (".rdata", ".rda"):
            try:
                rolle = _rolle(_read_matrix(p))
            except Exception:
                rolle = None
        elif endung in (".fa", ".fasta", ".fna"):
            rolle = "fasta" if _parse_fasta(p) else None
        elif endung == ".csv":
            try:
                kopf = pd.read_csv(p, sep=SEP, dtype=str, nrows=1)
                if {"sample", "date"} <= {str(c).strip().lower() for c in kopf.columns}:
                    rolle = "metadata"
            except Exception:
                rolle = None
        gesehen.append(f"{p.name} -> {rolle or 'unknown'}")
        if rolle:
            gefunden.setdefault(rolle, []).append(p)

    liste = "; ".join(gesehen) or "(empty)"
    for rolle, was in (("abundance", "the abundance matrix (all-numeric .Rdata, ASV x sample)"),
                       ("taxa", f"the taxonomy (.Rdata with columns {', '.join(RANGSPALTEN[:4])}, …)"),
                       ("fasta", "the ASV sequences (FASTA: .fa, .fasta or .fna)"),
                       ("metadata", "the sample metadata (';'-separated .csv with columns "
                                    "'sample' and 'date')")):
        if rolle not in gefunden:
            raise InputError(f"the input folder lacks {was}. Found: {liste}")
        if len(gefunden[rolle]) > 1:
            namen = ", ".join(p.name for p in gefunden[rolle])
            raise InputError(f"more than one file looks like {was}: {namen}")
    return {r: ps[0] for r, ps in gefunden.items()}


def _parse_fasta(path: Path) -> dict[str, str]:
    if not path.exists():
        raise InputError(f"file not found: {path}")
    seqs: dict[str, str] = {}
    name = None
    buf: list[str] = []
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        if line.startswith(">"):
            if name is not None:
                seqs[name] = "".join(buf)
            name = line[1:].split()[0]
            buf = []
        else:
            buf.append(line)
    if name is not None:
        seqs[name] = "".join(buf)
    return seqs


def _hash_id(seq: str) -> str:
    return "asv_" + hashlib.sha1(seq.upper().encode()).hexdigest()[:12]


def convert(in_dir: Path, out_dir: Path, track_path: Path, min_retain: float) -> int:
    out_dir.mkdir(parents=True, exist_ok=True)

    src_manifest = in_dir / DADA2_MANIFEST
    if src_manifest.exists():
        (out_dir / DADA2_MANIFEST).write_bytes(src_manifest.read_bytes())
        print(f"  {DADA2_MANIFEST}: passed through")
    else:
        print(f"  {DADA2_MANIFEST}: not in the input - DADA2 provenance stays unknown")

    src_placeholder = in_dir / PLACEHOLDER_DATES
    if src_placeholder.exists():
        (out_dir / PLACEHOLDER_DATES).write_bytes(src_placeholder.read_bytes())
        print(f"WARNING: {PLACEHOLDER_DATES} in the input - the dates in metadata.csv are "
              f"placeholders that only encode the sample order, not sampling dates. Ingest with "
              f"--time-axis ordinal; for real dates rerun run_dada2.R with MANTA_METADATA set.",
              file=sys.stderr)
    else:
        (out_dir / PLACEHOLDER_DATES).unlink(missing_ok=True)

    rollen = _zuordnen(in_dir)
    for rolle, pfad in sorted(rollen.items()):
        print(f"  {rolle:9} <- {pfad.name}")
    abund = _read_matrix(rollen["abundance"])
    taxa = _read_matrix(rollen["taxa"])
    seqs = _parse_fasta(rollen["fasta"])
    meta = pd.read_csv(rollen["metadata"], sep=SEP, dtype=str)
    meta = meta.rename(columns={c: str(c).strip().lower() for c in meta.columns
                                if str(c).strip().lower() in ("sample", "date")})

    if track_path is None:
        if "track" not in rollen:
            raise InputError("the input folder lacks DADA2's read tracking (.Rdata with columns "
                             f"{', '.join(TRACKSPALTEN)}); pass it with --track")
        track_path = rollen["track"]

    asvs = list(abund.index)
    if set(asvs) != set(taxa.index):
        raise InputError("the ASVs in the taxonomy differ from those in the abundance matrix "
                         "(otter needs the same ASVs in both)")
    missing_seq = [a for a in asvs if a not in seqs]
    if missing_seq:
        raise InputError(f"the FASTA lacks sequences for: {missing_seq[:5]}")

    samples = list(abund.columns)
    s2d = dict(zip(meta["sample"], meta["date"]))
    missing_meta = [s for s in samples if s not in s2d]
    if missing_meta:
        raise InputError(f"the metadata has no row for these samples: {missing_meta} "
                         f"(the 'sample' column must match the sample names exactly)")

    ab = abund.T.copy()
    ab.index = [s2d[s] for s in ab.index]
    ab = ab.sort_index()
    ab.index.name = None
    ab.to_csv(out_dir / "abundance.csv", sep=SEP)

    tx = taxa.copy()
    tx.index.name = "ASV"
    tx.to_csv(out_dir / "taxa_info.csv", sep=SEP, na_rep="")

    env_cols = [c for c in meta.columns if c not in ("sample", "date")]
    env = meta[["date"] + env_cols].copy()
    env = env[env["date"].isin(set(s2d[s] for s in samples))]
    env = env.sort_values("date").set_index("date")
    env.to_csv(out_dir / "environment_info.csv", sep=SEP, na_rep="")

    id_rows = [{"ordinal_id": a, "hash_id": _hash_id(seqs[a]), "sequence": seqs[a]} for a in asvs]
    pd.DataFrame(id_rows, columns=["ordinal_id", "hash_id", "sequence"]).to_csv(
        out_dir / "id_map.csv", sep=SEP, index=False)

    rc = _read_tracking_gate(track_path, out_dir, min_retain)
    return rc


def _read_tracking_gate(track_path: Path, out_dir: Path, min_retain: float) -> int:
    track = _read_matrix(track_path)
    for col in ("input", "merged", "nonchim"):
        if col not in track.columns:
            raise InputError(f"the read tracking lacks the column '{col}'")

    rows = []
    failed = []
    for sample, r in track.iterrows():
        inp = float(r["input"])
        nonchim = float(r["nonchim"])
        merged = float(r["merged"])
        frac = (nonchim / inp) if inp > 0 else 0.0
        ok = (frac >= min_retain) and (merged > 0) and (inp > 0)
        if not ok:
            failed.append(str(sample))
        rows.append({**{c: r[c] for c in track.columns},
                     "retained_frac": round(frac, 6), "pass": bool(ok)})

    report = pd.DataFrame(rows, index=list(track.index))
    report.index.name = "sample"
    report.to_csv(out_dir / "read_tracking_report.csv", sep=SEP)

    if failed:
        print(f"READ-TRACKING GATE FAIL: {len(failed)} sample(s) below the threshold "
              f"(min_retain={min_retain}): {', '.join(failed)}", file=sys.stderr)
        return 3
    return 0


def main(argv=None) -> int:
    p = argparse.ArgumentParser(
        description="Convert DADA2 outputs (.Rdata files, a FASTA of the ASVs and metadata.csv) "
                    "into otter's input tables abundance.csv, taxa_info.csv and "
                    "environment_info.csv.",
        epilog="Exit codes: 0 ok, 2 input error, 3 read-tracking gate failed.")
    p.add_argument("--in", dest="in_dir", required=True,
                   help="folder with the DADA2 outputs, e.g. the OUT_DIR of run_dada2.R; files are "
                        "recognized by content and extension, not by name")
    p.add_argument("--out", dest="out_dir", required=True,
                   help="folder for otter's input tables (created if missing)")
    p.add_argument("--track", dest="track", default=None,
                   help="read-tracking .Rdata (default: recognized in --in)")
    p.add_argument("--min-retain", type=float, default=0.2,
                   help="read-tracking gate: minimum nonchim/input fraction per sample "
                        "(default 0.2)")
    args = p.parse_args(argv)

    in_dir = Path(args.in_dir)
    out_dir = Path(args.out_dir)
    track = Path(args.track) if args.track else None

    try:
        return convert(in_dir, out_dir, track, args.min_retain)
    except InputError as e:
        print(f"INPUT ERROR: {e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

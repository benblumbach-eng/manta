from __future__ import annotations

import argparse
import hashlib
import sys
from pathlib import Path

import pandas as pd
import pyreadr

SEP = ";"
DADA2_MANIFEST = "dada2_manifest.json"


class InputError(Exception):
    pass


def _read_matrix(path: Path) -> pd.DataFrame:
    if not path.exists():
        raise InputError(f"fehlt: {path}")
    result = pyreadr.read_r(str(path))
    if not result:
        raise InputError(f"kein Objekt in {path}")
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
        raise InputError(f"kein Verzeichnis: {in_dir}")
    gefunden: dict[str, list[Path]] = {}
    gesehen: list[str] = []
    for p in sorted(in_dir.iterdir()):
        if not p.is_file():
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
        gesehen.append(f"{p.name} -> {rolle or 'unbekannt'}")
        if rolle:
            gefunden.setdefault(rolle, []).append(p)

    liste = "; ".join(gesehen) or "(leer)"
    for rolle, was in (("abundance", "die Abundanzmatrix (rein numerisch, ASV x Probe)"),
                       ("taxa", f"die Taxonomie (Spalten {', '.join(RANGSPALTEN[:4])}, …)"),
                       ("fasta", "die ASV-Sequenzen (FASTA)"),
                       ("metadata", "die Metadaten (CSV mit Spalten 'sample' und 'date')")):
        if rolle not in gefunden:
            raise InputError(f"im Eingang fehlt {was}. Gefunden: {liste}")
        if len(gefunden[rolle]) > 1:
            namen = ", ".join(p.name for p in gefunden[rolle])
            raise InputError(f"mehrere Dateien passen auf {was}: {namen}")
    return {r: ps[0] for r, ps in gefunden.items()}


def _parse_fasta(path: Path) -> dict[str, str]:
    if not path.exists():
        raise InputError(f"fehlt: {path}")
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
        print(f"  {DADA2_MANIFEST}: durchgereicht")
    else:
        print(f"  {DADA2_MANIFEST}: nicht im Eingang — die DADA2-Provenienz bleibt unbekannt")

    rollen = _zuordnen(in_dir)
    for rolle, pfad in sorted(rollen.items()):
        print(f"  {rolle:9} <- {pfad.name}")
    abund = _read_matrix(rollen["abundance"])
    taxa = _read_matrix(rollen["taxa"])
    seqs = _parse_fasta(rollen["fasta"])
    meta = pd.read_csv(rollen["metadata"], sep=SEP, dtype=str)

    if track_path is None:
        if "track" not in rollen:
            raise InputError("im Eingang fehlt das Read-Tracking von DADA2 (Spalten "
                             f"{', '.join(TRACKSPALTEN)}); mit --track laesst es sich angeben")
        track_path = rollen["track"]

    asvs = list(abund.index)
    if set(asvs) != set(taxa.index):
        raise InputError("ASV-Menge in Taxa != Abundanz (OTTER verlangt Taxa-Index == Abundanz-Spalten)")
    missing_seq = [a for a in asvs if a not in seqs]
    if missing_seq:
        raise InputError(f"FASTA fehlt Sequenzen fuer: {missing_seq[:5]}")

    samples = list(abund.columns)
    s2d = dict(zip(meta["sample"], meta["date"]))
    missing_meta = [s for s in samples if s not in s2d]
    if missing_meta:
        raise InputError(f"metadata.csv fehlen Samples: {missing_meta}")

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
            raise InputError(f"track fehlt Spalte '{col}'")

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
        print(f"READ-TRACKING GATE FAIL: {len(failed)} Sample(s) unter Schwelle "
              f"(min_retain={min_retain}): {', '.join(failed)}", file=sys.stderr)
        return 3
    return 0


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="DADA2 .Rdata -> OTTER-CSVs (MANTA Schicht 1).")
    here = Path(__file__).resolve().parent
    p.add_argument("--in", dest="in_dir", default=str(here / "fixture"))
    p.add_argument("--out", dest="out_dir", default=str(here / "out"))
    p.add_argument("--track", dest="track", default=None,
                   help="Pfad zur Read-Tracking-.Rdata (sonst wird sie im Eingang erkannt)")
    p.add_argument("--min-retain", type=float, default=0.2,
                   help="Gate: minimaler Anteil nonchim/input je Sample (Default 0.2)")
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

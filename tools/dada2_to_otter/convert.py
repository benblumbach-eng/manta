from __future__ import annotations

import argparse
import datetime
import hashlib
import re
import sys
from pathlib import Path

import pandas as pd
import pyreadr

SEP = ";"
DADA2_MANIFEST = "dada2_manifest.json"
PLACEHOLDER_DATES = "placeholder_dates.txt"
CONVERT_NOTES = "convert_notes.txt"


class InputError(Exception):
    pass


def _read_matrix(path: Path) -> pd.DataFrame:
    if not path.exists():
        raise InputError(f"file not found: {path}")
    if path.suffix.lower() == ".csv":
        with path.open(encoding="utf-8-sig") as fh:
            kopf = fh.readline()
        sep = SEP if kopf.count(SEP) >= kopf.count(",") else ","
        return pd.read_csv(path, sep=sep, index_col=0, encoding="utf-8-sig")
    result = pyreadr.read_r(str(path))
    if not result:
        raise InputError(f"no R object in {path}")
    return next(iter(result.values()))


RANGSPALTEN = ("kingdom", "phylum", "class", "order", "family", "genus", "species")
PR2_RAENGE = ("Domain", "Supergroup", "Division", "Subdivision", "Class", "Order", "Family",
              "Genus", "Species")
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
                else:
                    rolle = _rolle(_read_matrix(p))
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
            if rolle == "metadata":
                continue
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


DATUM = re.compile(r"^(\d{4})-(\d{1,2})-(\d{1,2})(T\d{2}:\d{2}:\d{2})?$")


def _datum(roh: str) -> "tuple[str, datetime.datetime] | None":
    if not isinstance(roh, str):
        return None
    m = DATUM.match(roh.strip())
    if not m:
        return None
    try:
        tag = datetime.date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    except ValueError:
        return None
    zeit = m.group(4) or ""
    try:
        punkt = datetime.datetime.fromisoformat(tag.isoformat() + zeit)
    except ValueError:
        return None
    return tag.isoformat() + zeit, punkt


NAMENSDATUM = re.compile(r"^(\d{4})[.\-_](\d{1,2})[.\-_](\d{1,2})$")


def _daten_aus_namen(samples: list) -> "dict[str, str] | None":
    daten = {}
    for s in samples:
        m = NAMENSDATUM.match(str(s).strip())
        if not m:
            return None
        daten[s] = f"{int(m.group(1)):04d}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"
    return daten


def _pr2_raenge(taxa: "pd.DataFrame", hinweise: list[str]) -> "pd.DataFrame":
    spalten = [str(c).strip() for c in taxa.columns]
    klein = [c.lower() for c in spalten]
    if "supergroup" not in klein:
        return taxa
    if (len(spalten) == len(PR2_RAENGE) and klein[1] == "supergroup" and "subdivision" not in klein
            and (klein[-1] in ("", "na", "nan", "none") or klein[-1].startswith("unnamed"))):
        taxa = taxa.copy()
        taxa.columns = list(PR2_RAENGE)
        hinweise.append(f"The taxonomy header ({', '.join(spalten)}) does not fit its "
                        f"{len(spalten)} columns of PR2 ranks; the columns were read by position "
                        f"as {', '.join(PR2_RAENGE)}.")
        klein = [r.lower() for r in PR2_RAENGE]
    namen = dict(zip(klein, taxa.columns))
    quelle = {"Kingdom": namen.get("domain", namen.get("kingdom")), "Phylum": namen.get("division"),
              "Class": namen.get("class"), "Order": namen.get("order"),
              "Family": namen.get("family"), "Genus": namen.get("genus"),
              "Species": namen.get("species")}
    if None in quelle.values():
        return taxa
    hinweise.append("PR2 taxonomy: Domain is stored as Kingdom and Division as Phylum; "
                    "Supergroup and Subdivision are not carried over.")
    return pd.DataFrame({ziel: taxa[q] for ziel, q in quelle.items()}, index=taxa.index)


DEZIMALKOMMA = re.compile(r"^-?\d+,\d+$")


def _dezimalkomma(meta: "pd.DataFrame", env_cols: list[str]) -> None:
    for col in env_cols:
        werte = [str(v).strip() for v in meta[col] if isinstance(v, str) and str(v).strip()]
        unlesbar = []
        for v in werte:
            try:
                float(v)
            except ValueError:
                unlesbar.append(v)
        if unlesbar and all(DEZIMALKOMMA.match(v) for v in unlesbar):
            raise InputError(f"the column {col!r} of the metadata uses a decimal comma "
                             f"(e.g. {unlesbar[0]!r} in {len(unlesbar)} of {len(werte)} cells). "
                             f"Write numbers with a decimal point (e.g. "
                             f"{unlesbar[0].replace(',', '.')!r}); decimal commas are not "
                             f"converted, because '1,234' could also be a thousands separator.")


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
    hinweise: list[str] = []
    abund = _read_matrix(rollen["abundance"])
    leer = [s for s in abund.columns if abund[s].sum() == 0]
    if leer:
        abund = abund.drop(columns=leer)
        hinweise.append(f"{len(leer)} sample(s) without any reads were left out: "
                        f"{', '.join(map(str, leer))}")
    taxa = _pr2_raenge(_read_matrix(rollen["taxa"]), hinweise)
    seqs = _parse_fasta(rollen["fasta"])
    if "metadata" in rollen:
        meta = pd.read_csv(rollen["metadata"], sep=SEP, dtype=str)
        meta = meta.rename(columns={c: str(c).strip().lower() for c in meta.columns
                                    if str(c).strip().lower() in ("sample", "date")})
    else:
        aus_namen = _daten_aus_namen(list(abund.columns))
        if aus_namen is None:
            raise InputError("the input folder lacks the sample metadata (';'-separated .csv with "
                             "columns 'sample' and 'date'), and the sample names are not dates "
                             "(YYYY.MM.DD or YYYY-MM-DD) to read them from")
        meta = pd.DataFrame({"sample": list(aus_namen), "date": list(aus_namen.values())})
        hinweise.append("No sample metadata: the sampling dates were read from the sample names "
                        "(YYYY.MM.DD); there are no environmental variables.")

    if track_path is None:
        track_path = rollen.get("track")

    asvs = list(abund.index)
    ohne_taxa = [a for a in asvs if a not in set(taxa.index)]
    if ohne_taxa:
        raise InputError(f"the taxonomy lacks these ASVs of the abundance matrix: {ohne_taxa[:5]} "
                         f"(otter needs the same ASVs in both)")
    if set(taxa.index) != set(asvs):
        n_extra = len(set(taxa.index) - set(asvs))
        taxa = taxa[taxa.index.isin(asvs)]
        hinweise.append(f"The taxonomy lists {n_extra} ASVs that are not in the abundance "
                        f"matrix; they were left out.")
    missing_seq = [a for a in asvs if a not in seqs]
    if missing_seq:
        raise InputError(f"the FASTA lacks sequences for: {missing_seq[:5]}")

    samples = list(abund.columns)
    doppelt = sorted({str(x) for x in meta.loc[meta["sample"].duplicated(keep=False), "sample"]})
    if doppelt:
        raise InputError(f"the metadata has more than one row for these samples: {doppelt[:5]} "
                         f"(one row per sample)")
    s2d = dict(zip(meta["sample"], meta["date"]))
    missing_meta = [s for s in samples if s not in s2d]
    if missing_meta:
        raise InputError(f"the metadata has no row for these samples: {missing_meta} "
                         f"(the 'sample' column must match the sample names exactly)")

    gelesen = {s: _datum(s2d[s]) for s in samples}
    falsch = [s for s in samples if gelesen[s] is None]
    if falsch:
        beispiele = ", ".join(f"{s}={s2d[s]!r}" for s in falsch[:5])
        raise InputError(f"the 'date' of {len(falsch)} sample(s) is not a valid date in the form "
                         f"YYYY-MM-DD (four-digit year, two-digit month and day): {beispiele}. "
                         f"Dates like dd.mm.yyyy or m/d/yyyy are not accepted, because their "
                         f"order cannot be read safely.")
    label = {s: gelesen[s][0] for s in samples}
    je_datum: dict[str, list[str]] = {}
    for s in samples:
        je_datum.setdefault(label[s], []).append(s)
    gleich = {d: ss for d, ss in je_datum.items() if len(ss) > 1}
    if gleich:
        beispiele = "; ".join(f"{d}: {', '.join(map(str, ss))}" for d, ss in list(gleich.items())[:3])
        raise InputError(f"{len(gleich)} date(s) are shared by more than one sample ({beispiele}). "
                         f"Each sample needs its own time point; for a second or third sample on "
                         f"the same day write the date as YYYY-MM-DDT00:00:01, YYYY-MM-DDT00:00:02.")
    zeitfolge = sorted(samples, key=lambda s: (gelesen[s][1], s))

    ab = abund.T.copy()
    ab = ab.loc[zeitfolge]
    ab.index = [label[s] for s in ab.index]
    ab.index.name = None
    ab.to_csv(out_dir / "abundance.csv", sep=SEP)

    tx = taxa.copy()
    tx.index.name = "ASV"
    tx.to_csv(out_dir / "taxa_info.csv", sep=SEP, na_rep="")

    env_cols = [c for c in meta.columns if c not in ("sample", "date")]
    _dezimalkomma(meta[meta["sample"].isin(samples)], env_cols)
    zeile = meta.set_index("sample")
    env = zeile.loc[zeitfolge, env_cols].copy()
    env.index = [label[s] for s in zeitfolge]
    env.index.name = "date"
    env.to_csv(out_dir / "environment_info.csv", sep=SEP, na_rep="")

    id_rows = [{"ordinal_id": a, "hash_id": _hash_id(seqs[a]), "sequence": seqs[a]} for a in asvs]
    pd.DataFrame(id_rows, columns=["ordinal_id", "hash_id", "sequence"]).to_csv(
        out_dir / "id_map.csv", sep=SEP, index=False)

    for h in hinweise:
        print(f"NOTE: {h}")
    if hinweise:
        (out_dir / CONVERT_NOTES).write_text("\n".join(hinweise) + "\n", encoding="utf-8")
    else:
        (out_dir / CONVERT_NOTES).unlink(missing_ok=True)

    if track_path is None:
        (out_dir / "read_tracking_report.csv").unlink(missing_ok=True)
        print("  read tracking: not in the input - read-retention check skipped")
        return 0
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
        description="Convert DADA2 outputs (.Rdata or .csv tables, a FASTA of the ASVs and "
                    "optionally metadata.csv) "
                    "into otter's input tables abundance.csv, taxa_info.csv and "
                    "environment_info.csv.",
        epilog="Exit codes: 0 ok, 2 input error, 3 read-tracking gate failed.")
    p.add_argument("--in", dest="in_dir", required=True,
                   help="folder with the DADA2 outputs, e.g. the OUT_DIR of run_dada2.R; files are "
                        "recognized by content and extension, not by name")
    p.add_argument("--out", dest="out_dir", required=True,
                   help="folder for otter's input tables (created if missing)")
    p.add_argument("--track", dest="track", default=None,
                   help="read-tracking .Rdata (default: recognized in --in; without it the "
                        "read-retention check is skipped)")
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

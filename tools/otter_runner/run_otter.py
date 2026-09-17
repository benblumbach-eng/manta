from __future__ import annotations

import argparse
import json
import multiprocessing as mp
import os
import sys
from pathlib import Path


def _stage_con(pd, Networkz, Transform, cfg, df_spec, df_taxa, con_net, con_meta):
    if cfg["HELLENIGER_NORM"]:
        df_spec = Transform(df_spec).apply_hellinger()
    calc = Networkz(df_spec, None, df_taxa, method=cfg["CON_METHOD"],
                    num_coefficients=cfg["FFT_COEFFS"], num_cores=1)
    calc.calculate_relation_networkz()
    calc.reset_filtering()
    calc.filter_correlations(cfg["CON_TR"])
    calc.remove_high_p_values(cfg["CON_ALPHA"])
    calc.create_meta_data(with_clusters=False)
    calc.save_to_csv(con_net, sym=cfg["CON_SYM"])
    calc.save_to_csv(con_meta, mod="meta")


def _stage_fft(pd, np, CoOccurrence, Transform, cfg, df_spec, fft_path):
    if cfg["HELLENIGER_NORM"]:
        df_spec = Transform(df_spec).apply_hellinger()
    F = int(cfg["FFT_COEFFS"])
    rows, n = {}, None
    for asv in df_spec.columns:
        series = df_spec[asv]
        vec = CoOccurrence(series, series, num_coefficients=F).calculate_fourier_coefficients(list(series))
        vec = np.asarray(vec, dtype=float)
        if n is None:
            n = len(vec) // 2
        rows[asv] = np.sqrt(vec[:n] ** 2 + vec[n:] ** 2)
    df = pd.DataFrame.from_dict(rows, orient="index",
                                columns=[str(k) for k in range(1, (n or 0) + 1)])
    df.index.name = "ASV"
    df.to_csv(fft_path, sep=";")


def _stage_ccmn(pd, Networkz, Transform, cfg, df_spec, df_taxa, ccmn_net, ccmn_meta):
    if cfg["HELLENIGER_NORM"]:
        df_spec = Transform(df_spec).apply_hellinger()
    calc = Networkz(df_spec, None, df_taxa, method=cfg["CCMN_METHOD"], num_cores=1)
    calc.calculate_relation_networkz()
    calc.reset_filtering()
    calc.create_meta_data(with_clusters=False)
    calc.save_to_csv(ccmn_net, sym=cfg["CCMN_SYM"])
    calc.save_to_csv(ccmn_meta, mod="meta")


def main() -> int:
    p = argparse.ArgumentParser(description="MANTA OTTER-Runner (Subprozess).")
    p.add_argument("--otter-root", required=True)
    p.add_argument("--abundance", required=True)
    p.add_argument("--taxa", required=True)
    p.add_argument("--environment", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--run-id", default="PyTest")
    p.add_argument("--head", type=int, default=0, help="nur erste N ASVs (0 = alle)")
    p.add_argument("--con-tr", type=float, default=None,
                   help="Korrelationsschwelle CON (Vorgabe aus config_file.py: 0.70)")
    p.add_argument("--con-alpha", type=float, default=None,
                   help="p-Schwelle CON (Vorgabe 0.05)")
    p.add_argument("--ccmn-tr", type=float, default=None, help="CCM-Schwelle (Vorgabe 0.00)")
    p.add_argument("--louvain-res", type=float, default=None, help="Louvain-Aufloesung (Vorgabe 1)")
    p.add_argument("--fft-coeffs", type=int, default=None, help="Fourier-Koeffizienten (Vorgabe 14)")
    p.add_argument("--num-permutations", type=int, default=None, help="CCM-Permutationen (Vorgabe 2)")
    p.add_argument("--num-samples", type=int, default=None, help="CCM-Stichproben (Vorgabe 10)")
    p.add_argument("--fft-only", action="store_true",
                   help="nur die FFT-Amplituden-Tabelle schreiben (kein Netz)")
    args = p.parse_args()

    otter_root = str(Path(args.otter_root).resolve())
    sys.path.insert(0, otter_root)

    import json
    import numpy as np
    import pandas as pd
    from gui import config_file as C
    from lutra.con import CoOccurrence
    from lutra.networkz import Networkz
    from lutra.transform import Transform
    from lutra.louvain import create_meta_file, filter_threshold, find_fewest_cluster_number
    from lutra.mapping import map_ccm_to_con
    from lutra.enrich import enriched_meta_table
    from lutra.permutation import get_ccm_pvalues

    cfg = {k: getattr(C, k) for k in (
        "HELLENIGER_NORM", "CON_METHOD", "CCMN_METHOD", "FFT_COEFFS", "CON_TR", "CON_ALPHA",
        "CCMN_TR", "CCMN_ALPHA", "LOUVAIN_RES", "CON_SYM", "CCMN_SYM",
        "NUM_PERMUTATIONS", "NUM_SAMPLES")}
    for arg, key in (("con_tr", "CON_TR"), ("con_alpha", "CON_ALPHA"), ("ccmn_tr", "CCMN_TR"),
                     ("louvain_res", "LOUVAIN_RES"), ("fft_coeffs", "FFT_COEFFS"),
                     ("num_permutations", "NUM_PERMUTATIONS"), ("num_samples", "NUM_SAMPLES")):
        val = getattr(args, arg)
        if val is not None:
            cfg[key] = val
    print(f"[otter] Schwellen: CON {cfg['CON_TR']} / p {cfg['CON_ALPHA']} · CCM {cfg['CCMN_TR']} · "
          f"Permutationen {cfg['NUM_PERMUTATIONS']} · FFT {cfg['FFT_COEFFS']} · "
          f"Louvain {cfg['LOUVAIN_RES']}", flush=True)

    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    R = args.run_id
    H = cfg["HELLENIGER_NORM"]
    F = cfg["FFT_COEFFS"]
    con_net = str(out / f"{R}_Hellinger_{H}_{F}_{cfg['CON_METHOD']}__complete_network_table_{cfg['CON_TR']}_{cfg['CON_ALPHA']}.csv")
    con_meta = str(out / f"{R}_Hellinger_{H}_{F}_{cfg['CON_METHOD']}__complete_network_table_meta_{cfg['CON_TR']}_{cfg['CON_ALPHA']}.csv")
    ccmn_net = str(out / f"{R}_Hellinger_{H}_{cfg['CCMN_METHOD']}__complete_network_table_{cfg['CCMN_TR']}_{cfg['CCMN_ALPHA']}.csv")
    ccmn_meta = str(out / f"{R}_Hellinger_{H}_{cfg['CCMN_METHOD']}__complete_network_table_meta_{cfg['CCMN_TR']}_{cfg['CCMN_ALPHA']}.csv")
    lou_net = str(out / f"{R}_Louvain_{cfg['LOUVAIN_RES']}_{cfg['CON_METHOD']}_Hellinger_{H}_{F}__complete_network_table_{cfg['CON_TR']}_{cfg['CON_ALPHA']}.csv")
    lou_meta = str(out / f"{R}_Louvain_{cfg['LOUVAIN_RES']}_{cfg['CON_METHOD']}_Hellinger_{H}_{F}__complete_network_table_meta_{cfg['CON_TR']}_{cfg['CON_ALPHA']}.csv")
    map_path = str(out / f"{R}_Hellinger_{H}_{F}_CCM_CON_MAP_Network.csv")
    pval_path = str(out / f"{R}_Hellinger_{H}_{F}_PV_CCM_CON_MAP_Network.csv")
    pruned_path = str(out / f"{R}_Hellinger_{H}_{F}_Pruned_CCM_CON_MAP_Network.csv")
    enriched_path = str(out / f"{R}_Hellinger_{H}_{F}_Enriched_Hellinger_14_complete_network_table_meta_CON_CCM.csv")
    fft_path = str(out / f"{R}_Hellinger_{H}_{F}_FFT_Amplitudes.csv")

    _scope = {}

    def load_spec():
        df = pd.read_csv(args.abundance, sep=";", index_col=0)
        _scope["n_asv_available"] = int(df.shape[1])
        if args.head and args.head > 0:
            df = df.T.head(args.head).T
        _scope["n_asv_in_network_run"] = int(df.shape[1])
        return df

    df_taxa = pd.read_csv(args.taxa, sep=";", index_col=0)

    if args.fft_only:
        print("[otter] FFT (nur Amplituden) …", flush=True)
        _stage_fft(pd, np, CoOccurrence, Transform, cfg, load_spec(), fft_path)
        man = out / "manta_manifest.json"
        if man.exists():
            try:
                m = json.loads(man.read_text(encoding="utf-8"))
            except ValueError:
                m = None
            if isinstance(m, dict):
                m["fft"] = fft_path
                man.write_text(json.dumps(m, indent=2), encoding="utf-8")
        print(f"[otter] fertig: {fft_path}", flush=True)
        return 0

    print("[otter] CON …", flush=True)
    _stage_con(pd, Networkz, Transform, cfg, load_spec(), df_taxa, con_net, con_meta)
    print("[otter] FFT …", flush=True)
    _stage_fft(pd, np, CoOccurrence, Transform, cfg, load_spec(), fft_path)
    print("[otter] CCMN …", flush=True)
    _stage_ccmn(pd, Networkz, Transform, cfg, load_spec(), df_taxa, ccmn_net, ccmn_meta)

    print("[otter] Louvain …", flush=True)
    df = pd.read_csv(con_net, sep=";")
    df_meta = pd.read_csv(con_meta, sep=";")
    df = filter_threshold(df, cfg["CON_TR"], lou_net)
    ret_dict, _res = find_fewest_cluster_number(df, [cfg["LOUVAIN_RES"]])
    create_meta_file(ret_dict, df_meta, cfg["LOUVAIN_RES"], lou_meta)

    print("[otter] Mapping …", flush=True)
    map_ccm_to_con(pd.read_csv(lou_meta, sep=";"), pd.read_csv(lou_net, sep=";"),
                   pd.read_csv(ccmn_net, sep=";"), map_path)

    print("[otter] PVAL + Enrich …", flush=True)
    df_spec = load_spec()
    df_ccm_con = pd.read_csv(map_path, sep=";")
    df_pvalues, pruned_ccm = get_ccm_pvalues(
        df_spec, df_ccm_con,
        num_permutations=cfg["NUM_PERMUTATIONS"], num_samples=cfg["NUM_SAMPLES"], num_cores=1)
    pruned_ccm.to_csv(pruned_path, sep=";")
    df_pvalues.to_csv(pval_path, sep=";")
    df_env = pd.read_csv(args.environment, sep=";", index_col=0)
    enriched_meta_table(df_spec, pd.read_csv(lou_meta, sep=";"), df_env,
                        pd.read_csv(lou_net, sep=";"), df_ccm_con, enriched_path)

    for req in (enriched_path, con_net, pruned_path):
        if not Path(req).exists():
            print(f"[otter] FEHLER: erwartete Ausgabe fehlt: {req}", file=sys.stderr)
            return 1

    (out / "manta_manifest.json").write_text(json.dumps({
        "enriched": enriched_path, "con": con_net, "pruned": pruned_path,
        "pv": pval_path,
        "fft": fft_path,
        "params": {"con_tr": cfg["CON_TR"], "con_alpha": cfg["CON_ALPHA"],
                   "ccmn_tr": cfg["CCMN_TR"], "ccmn_alpha": str(cfg["CCMN_ALPHA"]),
                   "louvain_res": cfg["LOUVAIN_RES"], "fft_coeffs": cfg["FFT_COEFFS"],
                   "num_permutations": cfg["NUM_PERMUTATIONS"], "num_samples": cfg["NUM_SAMPLES"],
                   "hellinger": bool(cfg["HELLENIGER_NORM"]),
                   "num_cores": 1},
        "network_scope": {**_scope, "head": int(args.head or 0)},
    }, indent=2), encoding="utf-8")
    print("[otter] fertig.", flush=True)
    return 0


if __name__ == "__main__":
    mp.set_start_method("spawn", force=True)
    raise SystemExit(main())

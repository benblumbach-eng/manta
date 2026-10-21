from __future__ import annotations

import math
import os

SECONDS_PER_PAIR_96 = 0.0090
REFERENCE_SAMPLES = 96
SECONDS_PER_PERMUTATION_FIXED = 0.64
SECONDS_PER_PERMUTATION_LOADED = 1.78
BASE_SECONDS = 2.9
RANGE_LOW, RANGE_HIGH, RANGE_HIGH_EXTRAPOLATED = 0.8, 2.0, 3.0
RANGE_HIGH_LOADED = 1.5
MEASURED_UP_TO_ASVS = 400
# OTTER passes over all ASV pairs twice: CON (Pearson_FFT) and CCMN (NMI, both directions).
# Share of the pair time spent in CON: about 0.2 in a measured 150-ASV run (60 s CON, 252 s CCMN).
CON_SHARE_OF_PAIRS = 0.2

MEMORY_BASE_BYTES = 350 * 1024 ** 2
MEMORY_PER_PAIR_BYTES = int(1.5 * 579)
MEMORY_FRACTION = 0.5

OTTER_PERMUTATIONS = 2
OTTER_SAMPLES = 10

BASIS = ("measured on a MacBook Air M2 (8 GB) with OTTER on one core; "
         "another machine or a longer series can take longer")


def machine_memory_bytes() -> int | None:
    try:
        return int(os.sysconf("SC_PAGE_SIZE")) * int(os.sysconf("SC_PHYS_PAGES"))
    except (ValueError, OSError, AttributeError):
        return None


def memory_budget_bytes() -> int | None:
    fest = os.environ.get("MANTA_OTTER_MEMORY_GB", "").strip()
    if fest:
        try:
            return int(float(fest) * 1024 ** 3)
        except ValueError:
            pass
    ram = machine_memory_bytes()
    return int(ram * MEMORY_FRACTION) if ram else None


def stage_seconds(n_asv: int, n_samples: int, num_permutations: int | None = None,
                  num_samples: int | None = None,
                  per_permutation: float = SECONDS_PER_PERMUTATION_FIXED) -> dict:
    n = max(0, int(n_asv))
    pairs = n * (n - 1) / 2
    per_pair = SECONDS_PER_PAIR_96 * max(1, int(n_samples)) / REFERENCE_SAMPLES
    perms = OTTER_PERMUTATIONS if num_permutations is None else max(0, int(num_permutations))
    drawn = min(OTTER_SAMPLES if num_samples is None else max(0, int(num_samples)), pairs)
    return {"CON": pairs * per_pair * CON_SHARE_OF_PAIRS,
            "CCMN": pairs * per_pair * (1 - CON_SHARE_OF_PAIRS),
            "PVAL + Enrich": perms * (per_permutation + drawn * per_pair)}


def seconds(n_asv: int, n_samples: int, num_permutations: int | None = None,
            num_samples: int | None = None,
            per_permutation: float = SECONDS_PER_PERMUTATION_FIXED) -> float:
    return BASE_SECONDS + sum(stage_seconds(n_asv, n_samples, num_permutations, num_samples,
                                            per_permutation).values())


def memory_bytes(n_asv: int) -> int:
    n = max(0, int(n_asv))
    return int(MEMORY_BASE_BYTES + n * (n - 1) * MEMORY_PER_PAIR_BYTES)


def _gb(b: int | None) -> float | None:
    return None if b is None else round(b / 1024 ** 3, 1)


def estimate(n_asv: int, n_samples: int, num_permutations: int | None = None,
             num_samples: int | None = None) -> dict:
    t = seconds(n_asv, n_samples, num_permutations, num_samples)
    t_last = seconds(n_asv, n_samples, num_permutations, num_samples,
                     per_permutation=SECONDS_PER_PERMUTATION_LOADED)
    mem = memory_bytes(n_asv)
    budget = memory_budget_bytes()
    fits = budget is None or mem <= budget
    hoch = int(n_asv) > MEASURED_UP_TO_ASVS or int(n_samples) > REFERENCE_SAMPLES
    oben = max(t * (RANGE_HIGH_EXTRAPOLATED if hoch else RANGE_HIGH), t_last * RANGE_HIGH_LOADED)
    out = {
        "n_asv": int(n_asv), "n_samples": int(n_samples),
        "minutes_low": max(1, math.floor(t * RANGE_LOW / 60)),
        "minutes_high": max(1, math.ceil(oben / 60)),
        "memory_gb": max(0.1, _gb(mem)),
        "memory_budget_gb": _gb(budget),
        "machine_memory_gb": _gb(machine_memory_bytes()),
        "fits": fits,
        "extrapolated": hoch,
        "basis": BASIS,
        "refusal": None,
    }
    if not fits:
        out["refusal"] = (
            f"Not started: computing the network of all {int(n_asv)} ASVs needs about "
            f"{out['memory_gb']} GB of memory, and this machine allows {out['memory_budget_gb']} GB "
            f"for one run. MANTA computes every ASV and does not drop rare ones to make it fit — "
            f"run it on a machine with more memory (the limit is MANTA_OTTER_MEMORY_GB).")
    return out


def describe(est: dict) -> str:
    return (f"{est['minutes_low']}–{est['minutes_high']} min, ~{est['memory_gb']} GB "
            f"for {est['n_asv']} ASVs")

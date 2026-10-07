import { useState } from "react";
import type { EnvironmentProfile, PeakEnvironment } from "../api";


function UnitFlag({ note, k }: { note?: string | null; k: string }) {
  if (!note) return null;
  return (
    <span className="text-amber-400" data-testid={`peak-unit-note-${k}`}>
      {" "}<span title={note} aria-label={note}>!</span>
    </span>
  );
}

type Zeile = {
  key: string; label: string; unit: string | null; unit_note?: string | null;
  weighted_mean: number; weighted_sd?: number | null;
  p10: number; p90: number; n_samples_used: number; n_samples_present: number;
  peak: number | null;
};

function stellen(spanne: number): number {
  if (spanne >= 100) return 0;
  if (spanne >= 10) return 1;
  if (spanne >= 1) return 2;
  return 3;
}

export default function EnvironmentBars({ peak, profile, onPeakSample }: {
  peak?: PeakEnvironment | null;
  profile: EnvironmentProfile;
  onPeakSample?: (sample: string) => void;
}) {
  const [details, setDetails] = useState(false);
  const [aktiv, setAktiv] = useState<{ key: string; teil: "mean" | "range" | "peak" | null } | null>(null);

  const spitze = new Map((peak?.items ?? []).map((i) => [i.key, i]));
  const probe = peak?.at_sample ?? null;
  const zeilen: Zeile[] = profile.items.map((p) => ({ ...p, peak: spitze.get(p.key)?.value ?? null }));
  for (const i of peak?.items ?? []) {
    if (!zeilen.some((z) => z.key === i.key)) {
      zeilen.push({ key: i.key, label: i.label, unit: i.unit, unit_note: i.unit_note,
                    weighted_mean: i.value, weighted_sd: null, p10: i.value, p90: i.value,
                    n_samples_used: 1, n_samples_present: 1, peak: i.value });
    }
  }

  const W = 460, L = 4, R = 4, MITTE = 13, ACHSE = 25;
  const H = 38;

  return (
    <div data-testid="env-bars" data-n={zeilen.length}>
      <div className="space-y-2" data-testid="peak-env-values">
        {zeilen.map((z) => {
          const sd0 = z.weighted_sd ?? null;
          const gemessen = [z.p10, z.p90, z.weighted_mean, ...(z.peak != null ? [z.peak] : [])];
          const bodenNull = Math.min(...gemessen) >= 0;
          let lo = Math.min(...gemessen, ...(sd0 != null ? [z.weighted_mean - sd0] : []));
          const hi = Math.max(...gemessen, ...(sd0 != null ? [z.weighted_mean + sd0] : []));
          if (bodenNull && lo < 0) lo = 0;
          const x = (v: number) => {
            const t = hi === lo ? 0.5 : (v - lo) / (hi - lo);
            return L + Math.max(0, Math.min(1, t)) * (W - L - R);
          };
          const sd = sd0;
          const d = stellen(hi - lo);
          const marken = [lo, (lo + hi) / 2, hi];
          const an = aktiv?.key === z.key;
          const teil = an ? aktiv!.teil : null;
          const zahl = (v: number) => `${v.toFixed(d + 1)}${z.unit ? ` ${z.unit}` : ""}`;
          return (
            <div key={z.key} data-testid="env-bar" data-key={z.key} className="relative"
                 onMouseEnter={() => setAktiv({ key: z.key, teil: null })} onMouseLeave={() => setAktiv(null)}>
              <div className="flex items-baseline justify-between gap-2 text-[11px] min-w-0">
                <span className={`truncate ${an ? "text-slate-200" : "text-slate-400"}`}>{z.label}</span>
                <span className="tabular-nums shrink-0 whitespace-nowrap">
                  {teil === "mean" ? (
                    <span className="text-emerald-300">
                      mean {z.weighted_mean.toFixed(d + 1)}
                      {sd != null && <> ± {sd.toFixed(d + 1)}</>}{z.unit ? ` ${z.unit}` : ""}
                      {sd != null && (z.weighted_mean - sd < lo || z.weighted_mean + sd > hi) && (
                        <span className="text-slate-500" title="the box reaches past the measured range"> · cut</span>
                      )}
                    </span>
                  ) : teil === "range" ? (
                    <span className="text-slate-300">
                      10–90 % {z.p10.toFixed(d + 1)}–{z.p90.toFixed(d + 1)}{z.unit ? ` ${z.unit}` : ""}
                    </span>
                  ) : teil === "peak" && z.peak != null ? (
                    <span className={probe && onPeakSample ? "text-cyan-300 cursor-pointer" : "text-cyan-300"}
                          onClick={() => probe && onPeakSample?.(probe)}>
                      peak sample {zahl(z.peak)}{probe && onPeakSample ? " ↗" : ""}
                    </span>
                  ) : an ? (
                    <span className="text-slate-400">
                      {z.n_samples_used} of {z.n_samples_present} samples
                      {z.unit ? ` · ${z.unit}` : ""}
                    </span>
                  ) : (
                    <span className="text-slate-500">{z.unit ?? ""}</span>
                  )}
                  <UnitFlag note={z.unit_note} k={z.key} />
                </span>
              </div>
              <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img"
                   aria-label={`${z.label}: mean ${z.weighted_mean}, 10 to 90 per cent ${z.p10} to ${z.p90}`}>
                <line x1={L} y1={ACHSE} x2={W - R} y2={ACHSE} stroke="#334155" strokeWidth={1} />
                {marken.map((m, i) => (
                  <g key={i}>
                    <line x1={x(m)} y1={ACHSE} x2={x(m)} y2={ACHSE + 3} stroke="#334155" strokeWidth={1} />
                    <text x={x(m)} y={ACHSE + 12} fontSize={8} fill="#64748b"
                          textAnchor={i === 0 ? "start" : i === 2 ? "end" : "middle"}>
                      {m.toFixed(d)}
                    </text>
                  </g>
                ))}
                <line x1={x(z.p10)} y1={MITTE} x2={x(z.p90)} y2={MITTE} stroke="#94a3b8"
                      strokeWidth={teil === "range" ? 1.8 : 1} />
                {[z.p10, z.p90].map((v, i) => (
                  <line key={i} x1={x(v)} y1={MITTE - 4} x2={x(v)} y2={MITTE + 4}
                        stroke="#94a3b8" strokeWidth={teil === "range" ? 1.8 : 1} />
                ))}
                {sd != null && (
                  <g>
                    <rect x={x(z.weighted_mean - sd)} y={MITTE - 5}
                          width={Math.max(1, x(z.weighted_mean + sd) - x(z.weighted_mean - sd))} height={10}
                          fill="#0f172a" />
                    <rect x={x(z.weighted_mean - sd)} y={MITTE - 5}
                          width={Math.max(1, x(z.weighted_mean + sd) - x(z.weighted_mean - sd))} height={10}
                          fill="#34d399" fillOpacity={teil === "mean" ? 0.3 : 0.18}
                          stroke="#34d399" strokeWidth={teil === "mean" ? 1.4 : 0.8} />
                  </g>
                )}
                <circle cx={x(z.weighted_mean)} cy={MITTE} r={teil === "mean" ? 4 : 3.2} fill="#34d399" />
                {z.peak != null && (
                  <rect x={x(z.peak) - 3} y={MITTE - 3} width={6} height={6}
                        transform={`rotate(45 ${x(z.peak)} ${MITTE})`}
                        fill={teil === "peak" ? "#22d3ee" : "none"} stroke="#22d3ee"
                        strokeWidth={teil === "peak" ? 2 : 1.4} />
                )}
                <rect x={x(z.p10)} y={MITTE - 7} width={Math.max(2, x(z.p90) - x(z.p10))} height={14}
                      fill="transparent" onMouseEnter={() => setAktiv({ key: z.key, teil: "range" })} />
                {sd != null && (
                  <rect x={x(z.weighted_mean - sd)} y={MITTE - 7}
                        width={Math.max(2, x(z.weighted_mean + sd) - x(z.weighted_mean - sd))} height={14}
                        fill="transparent" onMouseEnter={() => setAktiv({ key: z.key, teil: "mean" })} />
                )}
                <circle cx={x(z.weighted_mean)} cy={MITTE} r={8} fill="transparent"
                        onMouseEnter={() => setAktiv({ key: z.key, teil: "mean" })} />
                {z.peak != null && (
                  <circle data-testid="env-bar-peak" data-key={z.key}
                          cx={x(z.peak)} cy={MITTE} r={8} fill="transparent"
                          className={probe && onPeakSample ? "cursor-pointer" : undefined}
                          onMouseEnter={() => setAktiv({ key: z.key, teil: "peak" })}
                          onClick={() => probe && onPeakSample?.(probe)}>
                    {probe && onPeakSample && <title>{`peak sample ${probe} — go to it in the curve`}</title>}
                  </circle>
                )}
              </svg>

            </div>
          );
        })}
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-slate-500">
        <span>
          <svg width="26" height="10" className="inline-block align-middle mr-1">
            <line x1="1" y1="5" x2="25" y2="5" stroke="#94a3b8" strokeWidth="1" />
            <line x1="1" y1="1" x2="1" y2="9" stroke="#94a3b8" strokeWidth="1" />
            <line x1="25" y1="1" x2="25" y2="9" stroke="#94a3b8" strokeWidth="1" />
          </svg>
          10–90 % of the samples with a detection
        </span>
        <span>
          <svg width="22" height="10" className="inline-block align-middle mr-1">
            <rect x="1" y="1" width="20" height="8" fill="#34d399" fillOpacity="0.22"
                  stroke="#34d399" strokeWidth="0.8" />
            <circle cx="11" cy="5" r="2.6" fill="#34d399" />
          </svg>
          weighted mean ± weighted SD
        </span>
        {zeilen.some((z) => z.peak != null) && (
          <span>
            <svg width="12" height="10" className="inline-block align-middle mr-1">
              <rect x="3" y="2" width="6" height="6" transform="rotate(45 6 5)" fill="none"
                    stroke="#22d3ee" strokeWidth="1.4" />
            </svg>
            peak sample (one sample)
          </span>
        )}
        <button data-testid="env-bars-details" onClick={() => setDetails((v) => !v)}
                className="text-cyan-400 hover:underline">
          {details ? "hide details" : "show details"}
        </button>
      </div>

      {details && (
        <div className="mt-1.5 text-[11px]" data-testid="env-bars-table">
          {zeilen.map((z) => {
            const d = stellen(Math.max(1e-9, z.p90 - z.p10)) + 1;
            return (
              <div key={z.key} className="flex justify-between gap-2 border-b border-slate-800 py-0.5">
                <span className="text-slate-400">{z.label}</span>
                <span className="text-slate-200 tabular-nums text-right">
                  {z.peak != null && <>peak {z.peak.toFixed(d)}{z.unit ? ` ${z.unit}` : ""} · </>}
                  mean {z.weighted_mean.toFixed(d)}
                  {z.weighted_sd != null && <> ± {z.weighted_sd.toFixed(d)}</>}
                  {" "}· 10–90 % {z.p10.toFixed(d)}–{z.p90.toFixed(d)}
                  {" "}· {z.n_samples_used} of {z.n_samples_present} samples
                  {z.unit_note ? <span className="text-amber-400"> · {z.unit_note}</span> : null}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

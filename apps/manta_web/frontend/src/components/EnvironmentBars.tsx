import { useState } from "react";
import type { EnvironmentProfile } from "../api";
import { useTokens } from "../design/tokens";
import { envColour } from "../design/dataColours";


function UnitFlag({ note, k }: { note?: string | null; k: string }) {
  if (!note) return null;
  return (
    <span className="text-warn" data-testid={`env-unit-note-${k}`}>
      {" "}<span title={note} aria-label={note}>!</span>
    </span>
  );
}

type Zeile = EnvironmentProfile["items"][number];

function stellen(spanne: number): number {
  if (spanne >= 100) return 0;
  if (spanne >= 10) return 1;
  if (spanne >= 1) return 2;
  return 3;
}

type Teil = "box" | "range" | "mean" | null;

export default function EnvironmentBars({ profile, weightOf = "asv" }: {
  profile: EnvironmentProfile;
  weightOf?: "asv" | "module";
}) {
  const gewicht = weightOf === "module" ? "the module's value" : "this ASV's value";
  const [details, setDetails] = useState(false);
  const ENV = envColour(useTokens().light);
  const [aktiv, setAktiv] = useState<{ key: string; teil: Teil } | null>(null);
  const zeilen: Zeile[] = profile.items;
  const eigeneAchse = zeilen.some((z) => z.dataset_min == null || z.dataset_max == null);

  const W = 460, L = 4, R = 4, MITTE = 13, ACHSE = 25;
  const H = 40;

  return (
    <div data-testid="env-bars" data-n={zeilen.length}>
      <div className="space-y-2" data-testid="env-bar-rows">
        {zeilen.map((z) => {
          const lo = z.dataset_min ?? Math.min(z.p10, z.weighted_mean);
          const hi = z.dataset_max ?? Math.max(z.p90, z.weighted_mean);
          const x = (v: number) => {
            const t = hi === lo ? 0.5 : (v - lo) / (hi - lo);
            return L + Math.max(0, Math.min(1, t)) * (W - L - R);
          };
          const d = stellen(hi - lo);
          const marken = [lo, (lo + hi) / 2, hi];
          const an = aktiv?.key === z.key;
          const teil = an ? aktiv!.teil : null;
          const zahl = (v: number) => v.toFixed(d + 1);
          const einheit = z.unit ? ` ${z.unit}` : "";
          const box = z.p25 != null && z.p75 != null;
          return (
            <div key={z.key} data-testid="env-bar" data-key={z.key} className="relative"
                 data-p10={z.p10} data-p25={z.p25 ?? ""} data-median={z.median ?? ""}
                 data-p75={z.p75 ?? ""} data-p90={z.p90} data-mean={z.weighted_mean}
                 data-axis-min={lo} data-axis-max={hi}
                 onMouseEnter={() => setAktiv({ key: z.key, teil: null })} onMouseLeave={() => setAktiv(null)}>
              <div className="flex items-baseline justify-between gap-2 text-2xs min-w-0">
                <span className={`truncate ${an ? "text-fg" : "text-fg-muted"}`}>{z.label}</span>
                <span className="tabular-nums shrink-0 whitespace-nowrap">
                  {teil === "mean" ? (
                    <span className="text-ok">
                      mean {zahl(z.weighted_mean)}{z.median != null && <> · median {zahl(z.median)}</>}{einheit}
                    </span>
                  ) : teil === "box" && box ? (
                    <span className="text-fg">
                      25–75 % {zahl(z.p25!)}–{zahl(z.p75!)}{einheit}
                    </span>
                  ) : teil === "range" ? (
                    <span className="text-fg">
                      10–90 % {zahl(z.p10)}–{zahl(z.p90)}{einheit}
                    </span>
                  ) : an ? (
                    <span className="text-fg-muted">
                      {z.n_samples_used} of {z.n_samples_present} samples{z.unit ? ` · ${z.unit}` : ""}
                    </span>
                  ) : (
                    <span className="text-fg-muted">{z.unit ?? ""}</span>
                  )}
                  <UnitFlag note={z.unit_note} k={z.key} />
                </span>
              </div>
              <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img"
                   aria-label={`${z.label}: weighted median ${z.median ?? "not reported"}, middle half ${z.p25 ?? "?"} to ${z.p75 ?? "?"}, 10th to 90th percentile ${z.p10} to ${z.p90}, weighted mean ${z.weighted_mean}; axis ${lo} to ${hi}`}>
                <line x1={L} y1={MITTE} x2={W - R} y2={MITTE} stroke="var(--chart-grid)" strokeWidth={6}
                      strokeLinecap="round" />
                <line x1={L} y1={ACHSE} x2={W - R} y2={ACHSE} stroke="var(--chart-axis)" strokeWidth={1} />
                {marken.map((m, i) => (
                  <g key={i}>
                    <line x1={x(m)} y1={ACHSE} x2={x(m)} y2={ACHSE + 3} stroke="var(--chart-axis)" strokeWidth={1} />
                    <text x={x(m)} y={ACHSE + 13} fontSize={11} fill="var(--text-muted)"
                          textAnchor={i === 0 ? "start" : i === 2 ? "end" : "middle"}>
                      {m.toFixed(d)}
                    </text>
                  </g>
                ))}
                <line x1={x(z.p10)} y1={MITTE} x2={x(z.p90)} y2={MITTE} stroke="var(--chart-line)"
                      strokeWidth={teil === "range" ? 1.8 : 1} />
                {[z.p10, z.p90].map((v, i) => (
                  <line key={i} x1={x(v)} y1={MITTE - 4} x2={x(v)} y2={MITTE + 4}
                        stroke="var(--chart-line)" strokeWidth={teil === "range" ? 1.8 : 1} />
                ))}
                {box && (
                  <g data-testid="env-bar-box">
                    <rect x={x(z.p25!)} y={MITTE - 5} width={Math.max(2, x(z.p75!) - x(z.p25!))} height={10}
                          fill="var(--raised)" />
                    <rect x={x(z.p25!)} y={MITTE - 5} width={Math.max(2, x(z.p75!) - x(z.p25!))} height={10}
                          fill={ENV} fillOpacity={teil === "box" ? 0.32 : 0.2}
                          stroke={ENV} strokeWidth={teil === "box" ? 1.4 : 0.8} />
                  </g>
                )}
                {z.median != null && (
                  <line data-testid="env-bar-median" x1={x(z.median)} y1={MITTE - 6} x2={x(z.median)} y2={MITTE + 6}
                        stroke="var(--text)" strokeWidth={1.8} />
                )}
                <circle cx={x(z.weighted_mean)} cy={MITTE} r={teil === "mean" ? 3.6 : 2.8} fill={ENV}
                        stroke="var(--raised)" strokeWidth={1} />
                <rect x={x(z.p10)} y={MITTE - 7} width={Math.max(2, x(z.p90) - x(z.p10))} height={14}
                      fill="transparent" onMouseEnter={() => setAktiv({ key: z.key, teil: "range" })} />
                {box && (
                  <rect x={x(z.p25!)} y={MITTE - 7} width={Math.max(2, x(z.p75!) - x(z.p25!))} height={14}
                        fill="transparent" onMouseEnter={() => setAktiv({ key: z.key, teil: "box" })} />
                )}
                <circle cx={x(z.weighted_mean)} cy={MITTE} r={7} fill="transparent"
                        onMouseEnter={() => setAktiv({ key: z.key, teil: "mean" })} />
              </svg>
            </div>
          );
        })}
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-fg-muted"
           data-testid="env-bars-legend">
        <span>
          <svg width="26" height="10" className="inline-block align-middle mr-1">
            <line x1="1" y1="5" x2="25" y2="5" stroke="var(--chart-line)" strokeWidth="1" />
            <line x1="1" y1="1" x2="1" y2="9" stroke="var(--chart-line)" strokeWidth="1" />
            <line x1="25" y1="1" x2="25" y2="9" stroke="var(--chart-line)" strokeWidth="1" />
          </svg>
          <span data-testid="env-bars-whisker-legend">
            weighted 10th–90th percentile (weighted by {gewicht})
          </span>
        </span>
        <span>
          <svg width="22" height="10" className="inline-block align-middle mr-1">
            <rect x="1" y="1" width="20" height="8" fill={ENV} fillOpacity="0.22"
                  stroke={ENV} strokeWidth="0.8" />
            <line x1="9" y1="0" x2="9" y2="10" stroke="var(--text)" strokeWidth="1.6" />
          </svg>
          25th–75th percentile, line = median
        </span>
        <span>
          <svg width="10" height="10" className="inline-block align-middle mr-1">
            <circle cx="5" cy="5" r="2.8" fill={ENV} />
          </svg>
          weighted mean
        </span>
        <span data-testid="env-bars-axis-legend">
          {eigeneAchse ? "axis: this subject's own range" : "axis: all samples of this dataset"}
        </span>
        <button data-testid="env-bars-details" onClick={() => setDetails((v) => !v)}
                className="text-accent hover:underline">
          {details ? "hide details" : "show details"}
        </button>
      </div>

      {details && (
        <div className="mt-2 text-2xs" data-testid="env-bars-table">
          {zeilen.map((z) => {
            const d = stellen(Math.max(1e-9, z.p90 - z.p10)) + 1;
            const e = z.unit ? ` ${z.unit}` : "";
            return (
              <div key={z.key} className="flex justify-between gap-2 border-b border-line-subtle py-1">
                <span className="text-fg-muted">{z.label}</span>
                <span className="text-fg tabular-nums text-right">
                  mean {z.weighted_mean.toFixed(d)}
                  {z.weighted_sd != null && <> ± {z.weighted_sd.toFixed(d)}</>}{e}
                  {z.median != null && <> · median {z.median.toFixed(d)}</>}
                  {z.p25 != null && z.p75 != null && <> · 25–75 % {z.p25.toFixed(d)}–{z.p75.toFixed(d)}</>}
                  {" "}· 10–90 % {z.p10.toFixed(d)}–{z.p90.toFixed(d)}
                  {" "}· {z.n_samples_used} of {z.n_samples_present} samples
                  {z.dataset_min != null && z.dataset_max != null && (
                    <> · dataset {z.dataset_min.toFixed(d)}–{z.dataset_max.toFixed(d)}</>
                  )}
                  {z.unit_note ? <span className="text-warn"> · {z.unit_note}</span> : null}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

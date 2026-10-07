import { useEffect, useMemo, useState } from "react";
import { getLight, getSeasons, getWheel, type LightYear, type SeasonMark, type Seasons,
         type Wheel } from "../api";
import { Chooser, ChooserGroup, ChooserRow } from "./controls";
import InfoTip from "./InfoTip";
import { useModules } from "../modules";
import ProvenanceFooter from "./ProvenanceFooter";
import ModulesOverTime from "./ModulesOverTime";

function hourColour(h: number): string {
  const stops = [[67, 56, 202], [148, 163, 184], [251, 191, 36]];
  const t = Math.max(0, Math.min(1, h / 24)) * 2;
  const i = t < 1 ? 0 : 1, f = t < 1 ? t : t - 1;
  const c = stops[i].map((v, k) => Math.round(v + (stops[i + 1][k] - v) * f));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

const LICHT_KURZ: Record<"zones" | "hours", string> = {
  zones: "polar night / midnight sun",
  hours: "hours of sun",
};

const SHORT: Record<string, string> = {
  temp: "Temperature", sal: "Salinity", depth: "Sampling depth", mld: "Mixed layer depth",
  chl_sens: "Chlorophyll", par_satellite: "Light (PAR)", pw_frac: "Polar water", o2_conc: "Oxygen",
};

export default function WheelPanel({ datasetId, onClose, onOpenCluster, onOpenEnvironment }: {
  datasetId: string; onClose: () => void; onOpenCluster: (label: number) => void;
  onOpenEnvironment?: (key: string) => void;
}) {
  const [w, setW] = useState<Wheel | null>(null);
  const modules = useModules();
  const [err, setErr] = useState<string | null>(null);
  const [envKey, setEnvKey] = useState<string | null>("temp");
  const [year, setYear] = useState<string | null>(null);
  useEffect(() => { setYear(null); }, [datasetId]);
  const [hover, setHover] = useState<number | null>(null);
  const [held, setHeld] = useState<number | null>(null);
  const front = held ?? hover;
  const setFront = setHover;
  const hold = (l: number) => setHeld((h) => (h === l ? null : l));
  useEffect(() => { setHover(null); setHeld(null); }, [datasetId]);

  const [lightYear, setLightYear] = useState<LightYear | null>(null);
  const [origin, setOrigin] = useState<"jan1" | "solstice" | "sun">("jan1");
  const [lightMode, setLightMode] = useState<"zones" | "hours">("hours");
  const [seasonMode, setSeasonMode] =
    useState<"none" | "astronomical" | "light" | "water">("astronomical");
  const [seasons, setSeasons] = useState<Seasons | null>(null);
  useEffect(() => {
    let live = true;
    setLightYear(null); setOrigin("jan1");
    setSeasons(null); setSeasonMode("astronomical"); setLightMode("hours");
    getLight(datasetId).then((r) => { if (live) setLightYear(r.year); }).catch(() => { if (live) setLightYear(null); });
    getSeasons(datasetId).then((r) => { if (live) setSeasons(r); }).catch(() => { if (live) setSeasons(null); });
    return () => { live = false; };
  }, [datasetId]);
  const originDoy = origin === "solstice" ? (lightYear?.shortest_day_doy ?? 1)
    : origin === "sun" ? (lightYear?.sun_return_doy ?? 1) : 1;
  useEffect(() => {
    setW(null); setErr(null);
    getWheel(datasetId, year).then(setW).catch((e) => setErr(String(e)));
  }, [datasetId, year]);

  const envVars = w?.environment?.variables ?? [];
  const activeEnv = envVars.find((v) => v.key === envKey) ?? null;
  const monthly = (activeEnv && w?.environment?.monthly[activeEnv.key]) || null;

  const CX = 220, CY = 220;
  const R_LABEL = 209;
  const R_ENV_MAX = 190, R_ENV_MIN = 148;
  const R_LIGHT = 196;
  const R_CLUSTER_MAX = 136, R_CLUSTER_MIN = 52;
  const angleOfDoy = (doy: number) =>
    (-90 + (((doy - originDoy) % 365 + 365) % 365) / 365 * 360) * (Math.PI / 180);
  const MONTH_DOY = [1, 32, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335];
  const monthStart = (m: number) => angleOfDoy(MONTH_DOY[m - 1]);
  const monthCenter = (m: number) => angleOfDoy(MONTH_DOY[m - 1] + 15);
  const P = (r: number, a: number) => [CX + r * Math.cos(a), CY + r * Math.sin(a)] as const;

  const arcPath = (r: number, mFirst: number, nMonths: number) => {
    const a0 = monthStart(mFirst);
    const a1 = a0 + nMonths * 30 * (Math.PI / 180);
    const [x0, y0] = P(r, a0);
    const [x1, y1] = P(r, a1);
    return `M ${x0} ${y0} A ${r} ${r} 0 ${nMonths * 30 > 180 ? 1 : 0} 1 ${x1} ${y1}`;
  };

  const seasonMarks: SeasonMark[] = seasonMode === "none" || !seasons ? [] : seasons[seasonMode];
  const dateOfDoy = (doy: number) => {
    const d = new Date(Date.UTC(2019, 0, doy));
    return `${d.getUTCDate()} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()]}`;
  };

  const extremLaeufe = useMemo(() => {
    const dl = lightYear?.day_length_doy ?? [];
    if (dl.length < 12) return [] as { art: "nacht" | "tag"; mitte: number; tage: number }[];
    const art = (h: number) => (h <= 0 ? "nacht" : h >= 24 ? "tag" : null);
    const out: { art: "nacht" | "tag"; mitte: number; tage: number }[] = [];
    const n = dl.length;
    const gesehen = new Array(n).fill(false);
    for (let i = 0; i < n; i++) {
      const a = art(dl[i]);
      if (!a || gesehen[i]) continue;
      let laenge = 0, j = i;
      while (laenge < n && art(dl[j % n]) === a && !gesehen[j % n]) {
        gesehen[j % n] = true; laenge++; j++;
      }
      let k = (i - 1 + n) % n, vorn = 0;
      while (vorn < n && art(dl[k]) === a && !gesehen[k]) {
        gesehen[k] = true; vorn++; k = (k - 1 + n) % n;
      }
      const start = (i - vorn + n) % n;
      const tage = laenge + vorn;
      if (tage >= 10) out.push({ art: a, mitte: ((start + tage / 2) % n) + 1, tage });
    }
    return out;
  }, [lightYear]);

  const lichtDa = !!lightYear?.available && (lightYear.day_length_doy?.length ?? 0) > 0;
  const lichtGrund = "No light: this dataset has no station, so no latitude to compute it from.";
  const lichtGrundLang = lightYear?.absent_reason ?? lichtGrund;

  const clusters = w?.clusters ?? [];
  const ringStep = clusters.length
    ? (R_CLUSTER_MAX - R_CLUSTER_MIN) / Math.max(clusters.length - 1, 1) : 0;
  const ringR = (i: number) =>
    clusters.length === 1 ? (R_CLUSTER_MAX + R_CLUSTER_MIN) / 2 : R_CLUSTER_MIN + i * ringStep;

  const envGeo = useMemo(() => {
    if (!monthly) return null;
    const vals = monthly.filter((p) => p.mean != null) as { month: number; mean: number; n: number }[];
    if (!vals.length) return null;
    const lo = Math.min(...vals.map((p) => p.mean));
    const hi = Math.max(...vals.map((p) => p.mean));
    const rOf = (v: number) =>
      hi === lo ? (R_ENV_MIN + R_ENV_MAX) / 2 : R_ENV_MIN + ((v - lo) / (hi - lo)) * (R_ENV_MAX - R_ENV_MIN);
    const pts = new Map(vals.map((p) => [p.month, { ...p, xy: P(rOf(p.mean), monthCenter(p.month)) }]));
    const segs: [readonly [number, number], readonly [number, number]][] = [];
    for (let m = 1; m <= 12; m++) {
      const a = pts.get(m), b = pts.get((m % 12) + 1);
      if (a && b) segs.push([a.xy, b.xy]);
    }
    return { pts: [...pts.values()], segs, lo, hi };
  }, [monthly]);

  const modulesBlock = w ? (
    <div className="pt-1" data-testid="wheel-modules-over-time">
      <ModulesOverTime datasetId={datasetId} label={front} onFront={setFront} onHold={hold}
        order={clusters.map((c) => c.louvain_label)} />
    </div>
  ) : null;

  return (
    <div className="h-full overflow-auto" data-testid="wheel-panel">
      <div className="flex items-center justify-between px-4 py-2 border-b border-slate-700 sticky top-0 bg-slate-900 z-10">
        <span className="text-slate-100 font-medium flex items-center">
          The year wheel

        </span>
        <button onClick={onClose} data-testid="wheel-close" aria-label="Close" className="text-slate-400 hover:text-white">✕</button>
      </div>

      {err && <div className="p-4 text-red-300" data-testid="error">{err}</div>}
      {!w && !err && <div className="p-4 text-slate-500">loading …</div>}

      {w?.absent_reason && (
        <div className="p-4 pb-0">
          <p className="text-sm text-amber-400/90" data-testid="wheel-absent">{w.absent_reason}</p>
        </div>
      )}

      {w && !w.absent_reason && (
        <div className="p-4 space-y-3 text-sm">

          <div className="flex flex-wrap items-center gap-2" data-testid="wheel-controls">
            {(w.years?.length ?? 0) > 0 && (
              <Chooser label="year" summary={year ?? "average"} closeOnPick
                testid="wheel-year-select">
                <ChooserRow radio checked={year == null} testid="wheel-year-avg"
                  onToggle={() => setYear(null)} label="average year"
                  hint="all samples folded onto the calendar" />
                {w.years!.map((y) => (
                  <ChooserRow key={y.year} radio checked={year === y.year}
                    testid={`wheel-year-${y.year}`} onToggle={() => setYear(y.year)}
                    label={y.year} hint={y.note ?? `${y.n} samples · all 12 months`} />
                ))}
              </Chooser>
            )}

            <Chooser label="light" testid="wheel-light-mode"
              summary={lichtDa ? LICHT_KURZ[lightMode] : "not here"}
              disabled={!lichtDa} reason={lichtGrundLang}>
              <ChooserGroup label="daylight ring" />
              {([["zones", "polar night / midnight sun",
                  "the two bands where the sun stays down or up all day"],
                 ["hours", "hours of sun",
                  "day length, day by day, as a colour from dark to bright"]] as
                ["zones" | "hours", string, string][]).map(([k, label, hint]) => (
                <ChooserRow key={k} radio checked={lightMode === k} testid={`wheel-light-${k}`}
                  onToggle={() => setLightMode(k)} label={label} hint={hint} />
              ))}

              <ChooserGroup label="season starts" />
              {([["none", "off", "no marks"],
                 ["astronomical", "the sun", "equinoxes and solstices, from the declination"],
                 ["light", "the light", "where polar night and midnight sun begin and end"],
                 ["water", "the water", "monthly means of the measured mixed layer depth"]] as
                ["none" | "astronomical" | "light" | "water", string, string][]).map(([k, label, hint]) => {
                const leer = k !== "none" && (seasons?.[k]?.length ?? 0) === 0;
                const grund = seasons?.absent_reason
                  ?? (k === "water" ? seasons?.water_note : undefined);
                return (
                  <ChooserRow key={k} radio checked={seasonMode === k} disabled={leer}
                    testid={`wheel-season-${k}`} onToggle={() => setSeasonMode(k)}
                    label={label} hint={leer ? (grund ?? "not available here") : hint} />
                );
              })}

              <ChooserGroup label="12 o'clock" />
              {([["jan1", "1 January", "the calendar's own start", true],
                 ["solstice", "the shortest day", "the darkest point of the year at the top",
                  lightYear?.shortest_day_doy != null],
                 ["sun", "the sun returns", "the day the sun first clears the horizon again",
                  lightYear?.sun_return_doy != null]] as
                ["jan1" | "solstice" | "sun", string, string, boolean][]).map(([k, label, hint, da]) => (
                <ChooserRow key={k} radio checked={origin === k} disabled={!da}
                  testid={`wheel-origin-${k}`} onToggle={() => setOrigin(k)}
                  label={label} hint={da ? hint : lichtGrund} />
              ))}
            </Chooser>

            {envVars.length > 0 && (
              <Chooser label="environment" testid="wheel-env-select"
                summary={envKey ? (SHORT[envKey] ?? envKey) : "none"} closeOnPick>
                <ChooserRow radio checked={envKey === null} testid="wheel-env-none"
                  onToggle={() => setEnvKey(null)} label="none" />
                {envVars.map((v) => (
                  <ChooserRow key={v.key} radio checked={envKey === v.key}
                    testid={`wheel-env-${v.key}`} onToggle={() => setEnvKey(v.key)}
                    label={SHORT[v.key] ?? v.label} hint={v.unit ?? undefined} />
                ))}
              </Chooser>
            )}
          </div>

          {w.year?.note && (
            <p className="text-[10px] text-amber-400" data-testid="wheel-year-note">
              {w.year.year}: {w.year.note} — windows rest on this year&rsquo;s {w.year.n} samples only.
            </p>
          )}

          <div className="relative">
          <svg viewBox="0 0 440 440" className="w-full" data-testid="wheel-svg" data-origin={origin}>
            <circle cx={CX} cy={CY} r={R_LIGHT} fill="none" stroke="#334155" strokeWidth={9}
                    opacity={0.35} />
            <circle cx={CX} cy={CY} r={R_ENV_MIN} fill="none" stroke="#334155" strokeWidth={0.5} />
            <circle cx={CX} cy={CY} r={R_ENV_MAX} fill="none" stroke="#334155" strokeWidth={0.5} />
            {lightYear?.available && lightMode === "hours" && (lightYear.day_length_doy?.length ?? 0) > 0 && (
              <g data-testid="wheel-light-hours-ring" data-n={lightYear.day_length_doy!.length}>
                {lightYear.day_length_doy!.map((h, i) => {
                  const [x0, y0] = P(R_LIGHT, angleOfDoy(i + 1));
                  const [x1, y1] = P(R_LIGHT, angleOfDoy(i + 2));
                  return <path key={i} d={`M ${x0} ${y0} A ${R_LIGHT} ${R_LIGHT} 0 0 1 ${x1} ${y1}`}
                    stroke={hourColour(h)} strokeWidth={9} fill="none" strokeLinecap="butt" />;
                })}
              </g>
            )}
            {lightYear?.available && lightMode === "zones" && (
              <g data-testid="wheel-light-ring" data-bands={lightYear.bands.length}>
                {lightYear.bands.map((b, i) => {
                  const a0 = angleOfDoy(b.start_doy), a1 = angleOfDoy(b.end_doy + 1);
                  const span = (((b.end_doy + 1 - b.start_doy) % 365 + 365) % 365) / 365 * 360;
                  const [x0, y0] = P(R_LIGHT, a0), [x1, y1] = P(R_LIGHT, a1);
                  const nacht = b.kind === "polar_night";
                  const bogen = `M ${x0} ${y0} A ${R_LIGHT} ${R_LIGHT} 0 ${span > 180 ? 1 : 0} 1 ${x1} ${y1}`;
                  const [tx, ty] = P(R_LIGHT, angleOfDoy(b.start_doy + (((b.end_doy + 1 - b.start_doy) % 365 + 365) % 365) / 2));
                  return (
                    <g key={i}>
                      <path d={bogen} fill="none" stroke={nacht ? "#4338ca" : "#fbbf24"}
                        strokeWidth={8} opacity={nacht ? 0.95 : 0.85}>
                        <title>{nacht ? "polar night: the sun stays below the horizon"
                                      : "midnight sun: the sun stays above the horizon"} · days {b.start_doy}–{b.end_doy}</title>
                      </path>
                      {span >= 45 && (
                        <text x={tx} y={ty + 3} fontSize={8} fill="#0f172a" textAnchor="middle"
                              className="font-medium">{nacht ? "no sun" : "sun all day"}</text>
                      )}
                    </g>
                  );
                })}
              </g>
            )}
            {w.months.map((name, i) => {
              const [tx, ty] = P(R_LABEL, monthCenter(i + 1));
              const [gx0, gy0] = P(R_CLUSTER_MIN - 8, monthStart(i + 1));
              const [gx1, gy1] = P(R_ENV_MAX + 4, monthStart(i + 1));
              return (
                <g key={name}>
                  <line x1={gx0} y1={gy0} x2={gx1} y2={gy1} stroke="#1e293b" strokeWidth={1} />
                  <text x={tx} y={ty} fill="#64748b" fontSize={11} textAnchor="middle"
                        dominantBaseline="middle">{name}</text>
                </g>
              );
            })}

            {envGeo && activeEnv && (
              <g data-testid="wheel-env-band" className={onOpenEnvironment ? "cursor-pointer" : undefined}
                 onClick={() => onOpenEnvironment?.(activeEnv.key)}>
                <circle cx={CX} cy={CY} r={R_ENV_MIN} fill="none" stroke="#334155" strokeWidth={0.5} />
                <circle cx={CX} cy={CY} r={R_ENV_MAX} fill="none" stroke="#334155" strokeWidth={0.5} />
                {envGeo.pts.map((p) => {
                  const rr = Math.max(R_ENV_MIN + 1, Math.hypot(p.xy[0] - CX, p.xy[1] - CY));
                  const a0 = monthStart(p.month) + 0.02, a1 = monthStart(p.month) + 30 * (Math.PI / 180) - 0.02;
                  const [x0, y0] = P(R_ENV_MIN, a0), [x1, y1] = P(R_ENV_MIN, a1);
                  const [x2, y2] = P(rr, a1), [x3, y3] = P(rr, a0);
                  return (
                    <path key={p.month}
                      d={`M ${x0} ${y0} A ${R_ENV_MIN} ${R_ENV_MIN} 0 0 1 ${x1} ${y1} L ${x2} ${y2} A ${rr} ${rr} 0 0 0 ${x3} ${y3} Z`}
                      fill="#34d399" opacity={0.35} stroke="#34d399" strokeWidth={0.5}>
                      <title>{`${w.months[p.month - 1]}: ${p.mean.toFixed(2)}${activeEnv.unit ? ` ${activeEnv.unit}` : ""} (mean of ${p.n})`}</title>
                    </path>
                  );
                })}
              </g>
            )}
            {clusters.map((c, i) => {
              const r = ringR(i);
              const col = modules.color(c.louvain_label);
              const title = `Cluster ${c.louvain_label} · ${c.statement ?? "no window"} · ${c.n_members} ASVs`;
              return (
                <g key={c.louvain_label} data-testid={`wheel-arc-${c.louvain_label}`}
                   className="cursor-pointer"
                   onClick={() => { hold(c.louvain_label); onOpenCluster(c.louvain_label); }}
                   onMouseEnter={() => setFront(c.louvain_label)}>
                  <circle cx={CX} cy={CY} r={r} fill="none" stroke={col} strokeWidth={1} opacity={0.14} />
                  {c.window_months.length > 0 && c.window_months.length < 12 && (
                    <path d={arcPath(r, c.window_months[0], c.window_months.length)}
                          fill="none" stroke={col} strokeWidth={Math.min(ringStep * 0.6, 9)}
                          strokeLinecap="round" opacity={0.9} />
                  )}
                  {c.window_months.length >= 12 && (
                    <circle cx={CX} cy={CY} r={r} fill="none" stroke={col}
                            strokeWidth={Math.min(ringStep * 0.6, 9)} opacity={0.9} />
                  )}
                  {c.peak_month != null && (() => {
                    const [px, py] = P(r, monthCenter(c.peak_month));
                    return <circle cx={px} cy={py} r={4} fill={col} stroke="#0f172a" strokeWidth={1.5} />;
                  })()}
                  <title>{title}</title>
                </g>
              );
            })}
            {seasonMarks.length > 0 && (
              <g data-testid="wheel-season-marks" data-n={seasonMarks.length}>
                {seasonMarks.map((m) => {
                  const a = angleOfDoy(m.doy);
                  const [x0, y0] = P(R_CLUSTER_MIN - 12, a);
                  const [x1, y1] = P(R_LIGHT + 5, a);
                  return (
                    <g key={`${m.label}-${m.doy}`}>
                      <line x1={x0} y1={y0} x2={x1} y2={y1} stroke="#e2e8f0" strokeWidth={1}
                            strokeDasharray="3 3" opacity={0.65} />
                      <circle cx={x1} cy={y1} r={2.5} fill="#e2e8f0" opacity={0.9} />
                    </g>
                  );
                })}
              </g>
            )}
            {lightMode === "hours" && extremLaeufe.map((l) => {
              const [tx, ty] = P(R_LIGHT, angleOfDoy(l.mitte));
              return (
                <text key={`${l.art}-${l.mitte}`} x={tx} y={ty + 3} fontSize={8}
                      textAnchor="middle" className="font-medium"
                      stroke="#0f172a" strokeWidth={2.5} paintOrder="stroke" fill="#e2e8f0">
                  {l.art === "nacht" ? "no sun" : "sun all day"}
                </text>
              );
            })}
          </svg>
          </div>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-slate-400"
               data-testid="wheel-legend">
            {lightYear?.available && lightMode === "zones" && (<>
              <span><span className="inline-block w-3 h-1.5 align-middle mr-1" style={{ background: "#4338ca" }} />no sun (polar night)</span>
              <span><span className="inline-block w-3 h-1.5 align-middle mr-1" style={{ background: "#fbbf24" }} />sun all day (midnight sun)</span>
              <span><span className="inline-block w-3 h-1.5 align-middle mr-1" style={{ background: "#64748b", opacity: 0.6 }} />sun rises and sets</span>
            </>)}
            {lightYear?.available && lightMode === "hours" && (<>
              <span>0 h</span>
              <span className="inline-block h-1.5 w-14 align-middle rounded"
                style={{ background: `linear-gradient(to right, ${hourColour(0)}, ${hourColour(12)}, ${hourColour(24)})` }} />
              <span>24 h of sun</span>
            </>)}
            {activeEnv && <span><span className="inline-block w-3 h-1.5 align-middle mr-1" style={{ background: "#34d399", opacity: 0.5 }} />{SHORT[activeEnv.key] ?? activeEnv.label}, monthly mean</span>}
            <span><span className="inline-block w-3 h-1.5 align-middle mr-1 rounded" style={{ background: "#64748b" }} />module window, dot = its peak</span>
            {seasonMarks.length > 0 && (
              <span data-testid="wheel-season-legend">
                <span className="inline-block w-3 h-px align-middle mr-1" style={{ background: "#e2e8f0" }} />
                {seasonMarks.map((m) => `${m.label} ${dateOfDoy(m.doy)}`).join(" · ")}
              </span>
            )}
          </div>
          {seasonMode === "water" && seasons?.water_note && (
            <p className="text-[10px] text-slate-500" data-testid="wheel-water-note">{seasons.water_note}</p>
          )}

          {modulesBlock}

          {activeEnv && envGeo && (
            <p className="text-[11px] text-slate-400 tabular-nums flex items-center flex-wrap gap-x-1" data-testid="wheel-env-caption">
              <button className="text-emerald-300 hover:underline" data-testid="wheel-env-open"
                onClick={() => onOpenEnvironment?.(activeEnv.key)}>
                {activeEnv.label}{activeEnv.unit ? ` (${activeEnv.unit})` : ""} ↗
              </button>
              <span>· ring: monthly mean{w.year ? ` ${w.year.year}` : ""}, {envGeo.lo.toFixed(1)}–{envGeo.hi.toFixed(1)}</span>
              <InfoTip title="The ring">
                <p>Each sector is one calendar month, from the inner edge (the smallest monthly mean) out to that month&rsquo;s mean; the outer edge is the largest. A missing month stays empty.</p>
                <p>Dots are the measurements themselves, one per sample, placed on their day; larger dots were sampled deeper. Year and value in the tooltip.</p>
                <p>Context only — no correlation with the modules is computed.</p>
                {activeEnv.unit_note && <p className="text-amber-400/90">{activeEnv.unit_note}</p>}
              </InfoTip>
            </p>
          )}

          <div className="space-y-1" data-testid="wheel-list">
            {clusters.map((c) => (
              <button key={c.louvain_label} data-testid={`wheel-row-${c.louvain_label}`}
                onClick={() => { hold(c.louvain_label); onOpenCluster(c.louvain_label); }}
                onMouseEnter={() => setFront(c.louvain_label)}
                aria-pressed={held === c.louvain_label}
                className={`w-full flex items-center gap-2 text-left px-2 py-1 rounded hover:bg-slate-800 ${held === c.louvain_label ? "bg-slate-800 ring-1 ring-slate-500" : ""}`}>
                <span className="inline-block w-3 h-3 rounded-sm shrink-0"
                      style={{ background: modules.color(c.louvain_label) }} />
                <span className="text-slate-200 shrink-0">{modules.label(c.louvain_label)}</span>
                <span className="text-slate-400 text-xs flex-1">
                  {c.window.length
                    ? `${c.window[0]}–${c.window[c.window.length - 1]}` + (c.peak ? ` · peak ${c.peak}` : "")
                    : "no window above its own annual mean"}
                </span>
                <span className="text-slate-500 text-xs tabular-nums shrink-0">{c.n_members} ASVs</span>
              </button>
            ))}
          </div>

          <p className="flex items-center text-[10px] text-slate-500" data-testid="wheel-windows-note">
            <span data-testid="wheel-windows-definition">Shares, not cell counts — a window is the months
            above the module&rsquo;s own annual mean; the dot is its strongest month.</span>
          </p>
        </div>
      )}

      {w?.absent_reason && modulesBlock}

      {w && (
        <div className="p-4 pt-2 space-y-2 text-sm border-t border-slate-800" data-testid="wheel-pairs">
          <h3 className="text-slate-300 font-medium flex items-center">
            Transitions between communities

          </h3>
          {w.pairs.length === 0 ? (
            <p className="text-xs text-slate-400" data-testid="wheel-pairs-empty">
              No link crosses a cluster border — the clusters are unconnected parts.
            </p>
          ) : (
            <div className="space-y-1">
              {w.pairs.map((p) => (
                <div key={`${p.ca}-${p.cb}`} data-testid={`wheel-pair-${p.ca}-${p.cb}`}
                  className="flex items-center gap-2 px-2 py-1 rounded bg-slate-950/40">
                  <span className="inline-block w-3 h-3 rounded-sm shrink-0"
                        style={{ background: modules.color(p.ca) }} />
                  <button className="text-slate-200 hover:underline shrink-0"
                          onClick={() => onOpenCluster(p.ca)}>C{p.ca}</button>
                  <span className="text-slate-500 shrink-0">↔</span>
                  <span className="inline-block w-3 h-3 rounded-sm shrink-0"
                        style={{ background: modules.color(p.cb) }} />
                  <button className="text-slate-200 hover:underline shrink-0"
                          onClick={() => onOpenCluster(p.cb)}>C{p.cb}</button>
                  <span className="text-xs text-slate-400 flex-1 text-right tabular-nums">
                    {p.n_con} link{p.n_con === 1 ? "" : "s"} · {p.n_with_ccm} with direction
                    {p.mean_nmi != null && <> · mean NMI {p.mean_nmi.toFixed(2)}</>}
                  </span>
                  {p.n_with_ccm === 0 && (
                    <span className="text-[10px] text-amber-400/90 shrink-0"
                          data-testid="wheel-pair-reset">
                      no measurable direction
                    </span>
                  )}
                </div>
              ))}
              <p className="text-[10px] text-slate-500">
                Links are co-occurrences (similar temporal pattern, not interaction); a direction
                is a pruned CCM annotation. Pairs sorted by how strongly they are connected.
              </p>
            </div>
          )}
          <ProvenanceFooter datasetId={datasetId} />
        </div>
      )}
    </div>
  );
}

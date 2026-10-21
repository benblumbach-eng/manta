import { StateNotice } from "./ui";
import { useEffect, useMemo, useState } from "react";
import { getLight, getSeasons, getWheel, type LightYear, type SeasonMark, type Seasons,
         type Wheel } from "../api";
import { Chooser, ChooserGroup, ChooserRow } from "./controls";
import InfoTip from "./InfoTip";
import { useModules } from "../modules";
import ProvenanceFooter from "./ProvenanceFooter";
import ErrorNotice from "./ErrorNotice";
import { PanelHeader } from "./PanelFrame";
import { useTokens } from "../design/tokens";
import { envColour, envLabelColour, sunColours } from "../design/dataColours";


function windowLabel(w: string[]): string {
  if (w.length === 0) return "";
  return w.length === 1 ? w[0] : `${w[0]}–${w[w.length - 1]}`;
}

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

function niceTicks(lo: number, hi: number): number[] {
  const roh = (hi - lo) / 3;
  const zehn = Math.pow(10, Math.floor(Math.log10(roh)));
  const schritt = [1, 2, 5, 10].map((f) => f * zehn).find((s) => (hi - lo) / s <= 4) ?? 10 * zehn;
  const out: number[] = [];
  for (let v = Math.ceil(lo / schritt) * schritt; v <= hi + 1e-9 * Math.abs(hi || 1); v += schritt) {
    out.push(Math.abs(v) < 1e-12 ? 0 : v);
  }
  return out.length >= 2 ? out : [lo, hi];
}

function tickDigits(lo: number, hi: number): number {
  const s = hi - lo;
  return s >= 10 ? 0 : s >= 1 ? 1 : s >= 0.1 ? 2 : 3;
}

export default function WheelPanel({ datasetId, onClose, onOpenCluster, onOpenEnvironment }: {
  datasetId: string; onClose: () => void; onOpenCluster: (label: number) => void;
  onOpenEnvironment?: (key: string) => void;
}) {
  const [w, setW] = useState<Wheel | null>(null);
  const modules = useModules();
  const { light: hell } = useTokens();
  const ENV = envColour(hell), sonne = sunColours(hell);
  const [err, setErr] = useState<unknown>(null);
  const [nochmal, setNochmal] = useState(0);
  const [envKey, setEnvKey] = useState<string | null>("temp");
  const [year, setYear] = useState<string | null>(null);
  useEffect(() => { setYear(null); }, [datasetId]);
  const [held, setHeld] = useState<number | null>(null);
  const hold = (l: number) => setHeld((h) => (h === l ? null : l));
  useEffect(() => { setHeld(null); }, [datasetId]);

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
    getWheel(datasetId, year).then(setW).catch((e) => setErr(e));
  }, [datasetId, year, nochmal]);

  const envVars = w?.environment?.variables ?? [];
  const activeEnv = envVars.find((v) => v.key === envKey) ?? null;
  const monthly = (activeEnv && w?.environment?.monthly[activeEnv.key]) || null;

  const CX = 220, CY = 220;
  const R_LABEL = 209;
  const R_ENV_MAX = 186, R_ENV_MIN = 148;
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
    const guides = (hi === lo ? [lo] : niceTicks(lo, hi)).map((v) => ({ v, r: rOf(v) }));
    return { pts: [...pts.values()], segs, lo, hi, guides, digits: tickDigits(lo, hi) };
  }, [monthly]);

  return (
    <div data-testid="wheel-panel">
      <PanelHeader title="The year wheel" onClose={onClose} closeTestid="wheel-close" />

      {err != null && <ErrorNotice error={err} what="Could not load the year wheel."
        onRetry={() => setNochmal((n) => n + 1)} />}
      {!w && err == null && <StateNotice state="loading">loading …</StateNotice>}

      {w?.absent_reason && (
        <div className="p-4 pb-0">
          <p className="text-sm text-warn" data-testid="wheel-absent">{w.absent_reason}</p>
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
            <p className="text-xs text-warn" data-testid="wheel-year-note">
              {w.year.year}: {w.year.note} — windows rest on this year&rsquo;s {w.year.n} samples only.
            </p>
          )}

          <div className="relative">
          <svg viewBox="0 0 440 440" className="w-full" data-testid="wheel-svg" data-origin={origin}>
            <circle cx={CX} cy={CY} r={R_LIGHT} fill="none" stroke="var(--chart-axis)" strokeWidth={9}
                    opacity={0.35} />
            {!envGeo && <circle cx={CX} cy={CY} r={R_ENV_MIN} fill="none" stroke="var(--chart-axis)" strokeWidth={0.5} />}
            {!envGeo && <circle cx={CX} cy={CY} r={R_ENV_MAX} fill="none" stroke="var(--chart-axis)" strokeWidth={0.5} />}
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
                      <path d={bogen} fill="none" stroke={nacht ? sonne.nightBand : sonne.day}
                        strokeWidth={8} opacity={nacht ? 0.95 : 0.85}>
                        <title>{nacht ? "polar night: the sun stays below the horizon"
                                      : "midnight sun: the sun stays above the horizon"} · days {b.start_doy}–{b.end_doy}</title>
                      </path>
                      {span >= 45 && (
                        <text x={tx} y={ty + 4} fontSize={11} textAnchor="middle" className="font-medium"
                              stroke="var(--raised)" strokeWidth={2.5} paintOrder="stroke" fill="var(--text)">
                          {nacht ? "no sun" : "sun all day"}</text>
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
                  <line x1={gx0} y1={gy0} x2={gx1} y2={gy1} stroke="var(--chart-grid)" strokeWidth={1} />
                  <text x={tx} y={ty} fill="var(--text-muted)" fontSize={11} textAnchor="middle"
                        dominantBaseline="middle">{name}</text>
                </g>
              );
            })}

            {envGeo && activeEnv && (
              <g data-testid="wheel-env-band" data-n-months={envGeo.pts.length}
                 data-n-guides={envGeo.guides.length}
                 className={onOpenEnvironment ? "cursor-pointer" : undefined}
                 onClick={() => onOpenEnvironment?.(activeEnv.key)}>
                {envGeo.guides.map((g) => (
                  <circle key={`c${g.v}`} cx={CX} cy={CY} r={g.r} fill="none" stroke="var(--chart-axis)"
                          strokeWidth={0.6} strokeDasharray="2 3" data-testid="wheel-env-guide" />
                ))}
                <g data-testid="wheel-env-line">
                  {envGeo.segs.map(([a, b], i) => (
                    <line key={i} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke={ENV}
                          strokeWidth={1.6} opacity={0.9} />
                  ))}
                </g>
                {envGeo.pts.map((p) => (
                  <circle key={p.month} cx={p.xy[0]} cy={p.xy[1]} r={3} fill={ENV}
                          stroke="var(--raised)" strokeWidth={1} data-testid="wheel-env-month"
                          data-month={p.month}>
                    <title>{`${w.months[p.month - 1]}: ${p.mean.toFixed(2)}${activeEnv.unit ? ` ${activeEnv.unit}` : ""} (mean of ${p.n})`}</title>
                  </circle>
                ))}
                {envGeo.guides.map((g) => (
                  <text key={`t${g.v}`} x={CX - 3} y={CY - g.r} fontSize={11} textAnchor="end"
                        dominantBaseline="middle" fill={envLabelColour(hell)} stroke="var(--raised)" strokeWidth={2.5}
                        paintOrder="stroke" data-testid="wheel-env-guide-label">
                    {g.v.toFixed(envGeo.digits)}
                  </text>
                ))}
              </g>
            )}
            {clusters.map((c, i) => {
              const r = ringR(i);
              const col = modules.color(c.louvain_label);
              const title = `${modules.label(c.louvain_label)} · ${c.statement ?? "no window"} · ${c.n_members} ASVs`;
              return (
                <g key={c.louvain_label} data-testid={`wheel-arc-${c.louvain_label}`}
                   className="cursor-pointer"
                   onClick={() => { hold(c.louvain_label); onOpenCluster(c.louvain_label); }}>
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
                    return <circle cx={px} cy={py} r={4} fill={col} stroke="var(--raised)" strokeWidth={1.5} />;
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
                      <line x1={x0} y1={y0} x2={x1} y2={y1} stroke="var(--text)" strokeWidth={1}
                            strokeDasharray="3 3" opacity={0.65} />
                      <circle cx={x1} cy={y1} r={2.5} fill="var(--text)" opacity={0.9} />
                    </g>
                  );
                })}
              </g>
            )}
            {lightMode === "hours" && extremLaeufe.map((l) => {
              const [tx, ty] = P(R_LIGHT, angleOfDoy(l.mitte));
              return (
                <text key={`${l.art}-${l.mitte}`} x={tx} y={ty + 4} fontSize={11}
                      textAnchor="middle" className="font-medium"
                      stroke="var(--raised)" strokeWidth={2.5} paintOrder="stroke" fill="var(--text)">
                  {l.art === "nacht" ? "no sun" : "sun all day"}
                </text>
              );
            })}
          </svg>
          </div>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-fg-muted"
               data-testid="wheel-legend">
            {lightYear?.available && lightMode === "zones" && (<>
              <span><span className="inline-block w-3 h-1.5 align-middle mr-1" style={{ background: sonne.nightBand }} />no sun (polar night)</span>
              <span><span className="inline-block w-3 h-1.5 align-middle mr-1" style={{ background: sonne.day }} />sun all day (midnight sun)</span>
              <span><span className="inline-block w-3 h-1.5 align-middle mr-1" style={{ background: sonne.twilight, opacity: 0.6 }} />sun rises and sets</span>
            </>)}
            {lightYear?.available && lightMode === "hours" && (<>
              <span>0 h</span>
              <span className="inline-block h-1.5 w-14 align-middle rounded"
                style={{ background: `linear-gradient(to right, ${hourColour(0)}, ${hourColour(12)}, ${hourColour(24)})` }} />
              <span>24 h of sun</span>
            </>)}
            {activeEnv && <span><span className="inline-block w-3 h-0.5 align-middle mr-1" style={{ background: ENV }} />{SHORT[activeEnv.key] ?? activeEnv.label}, monthly mean (dashed circles: scale)</span>}
            <span><span className="inline-block w-3 h-1.5 align-middle mr-1 rounded" style={{ background: "var(--chart-line)" }} />module window; dot = highest month</span>
            {seasonMarks.length > 0 && (
              <span data-testid="wheel-season-legend">
                <span className="inline-block w-3 h-px align-middle mr-1" style={{ background: "var(--text)" }} />
                {seasonMarks.map((m) => `${m.label} ${dateOfDoy(m.doy)}`).join(" · ")}
              </span>
            )}
          </div>
          {seasonMode === "water" && seasons?.water_note && (
            <p className="text-2xs text-fg-muted" data-testid="wheel-water-note">{seasons.water_note}</p>
          )}

          {activeEnv && envGeo && (
            <p className="text-2xs text-fg-muted tabular-nums flex items-center flex-wrap gap-x-1" data-testid="wheel-env-caption">
              <button className="text-ok hover:underline" data-testid="wheel-env-open"
                onClick={() => onOpenEnvironment?.(activeEnv.key)}>
                {activeEnv.label}{activeEnv.unit ? ` (${activeEnv.unit})` : ""} ↗
              </button>
              <span>· ring: monthly mean{w.year ? ` ${w.year.year}` : ""}, {envGeo.lo.toFixed(1)}–{envGeo.hi.toFixed(1)}</span>
              <InfoTip title="The ring">
                <p>Each point is one calendar month&rsquo;s mean; the line joins neighbouring months. The dashed circles are the scale, labelled with their values at 12 o&rsquo;clock. A month without a measurement leaves a gap.</p>
                <p>Context only — no correlation with the modules is computed.</p>
                {activeEnv.unit_note && <p className="text-warn">{activeEnv.unit_note}</p>}
              </InfoTip>
            </p>
          )}

          <div className="space-y-1" data-testid="wheel-list">
            {clusters.map((c) => (
              <button key={c.louvain_label} data-testid={`wheel-row-${c.louvain_label}`}
                onClick={() => { hold(c.louvain_label); onOpenCluster(c.louvain_label); }}
                aria-pressed={held === c.louvain_label}
                className={`w-full flex items-center gap-2 text-left px-2 py-1 rounded hover:bg-control ${held === c.louvain_label ? "bg-control ring-1 ring-line-strong" : ""}`}>
                <span className="inline-block w-3 h-3 rounded-sm shrink-0"
                      style={{ background: modules.color(c.louvain_label) }} />
                <span className="text-fg shrink-0">{modules.label(c.louvain_label)}</span>
                <span className="text-fg-muted text-xs flex-1">
                  {c.window.length
                    ? windowLabel(c.window) + (c.peak ? ` · peak ${c.peak}` : "")
                    : "no window above its own annual mean"}
                </span>
                <span className="text-fg-muted text-xs tabular-nums shrink-0">{c.n_members} ASVs</span>
              </button>
            ))}
          </div>

          <p className="flex items-center text-2xs text-fg-muted" data-testid="wheel-windows-note">
            <span data-testid="wheel-windows-definition">Shares, not cell counts. Arc: one above-mean
            run (others not drawn); dot: highest month, can lie outside the arc.</span>
            <InfoTip title="The arc">
              <p>A run is a stretch of consecutive months in which the module lies above its own
              annual mean. A module can have several runs. The arc shows one of them: the
              module&rsquo;s window, as named in the list below. Other runs are not drawn.</p>
              <p>The window is the run with the largest summed excess over the annual mean, so
              height and length both count. When a second run comes close, the hover text names
              both; only the window is drawn.</p>
              <p>The dot marks the single highest month. It can lie outside the arc, for example
              when one high month stands alone and a longer run adds up to more.</p>
            </InfoTip>
          </p>
        </div>
      )}

      {w && (
        <div className="p-4 pt-2 text-sm border-t border-line-subtle">
          <ProvenanceFooter datasetId={datasetId} />
        </div>
      )}
    </div>
  );
}

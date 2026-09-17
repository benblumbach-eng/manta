import { useMemo, useState } from "react";
import ReactECharts from "echarts-for-react";
import type { Environment, Frequency, SeasonalYear } from "../api";
import InfoTip from "./InfoTip";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const YEAR_COLORS = ["#f472b6", "#a3e635", "#fbbf24", "#c084fc", "#fb923c", "#38bdf8", "#4ade80", "#f87171"];
const MEAN = "Typical year";
const BAND = "Spread between years";

const pct = (v: number | null | undefined, d = 2) => (v == null ? "—" : `${(100 * v).toFixed(d)}%`);

type View = "measured" | "season";

export default function FrequencyPanel({ freq, subject, env, color = "#22d3ee",
                                        testid = "frequency", compact = false, onPointClick }: {
  freq: Frequency;
  subject: string;
  env?: Environment | null;
  color?: string;
  testid?: string;
  compact?: boolean;
  onPointClick?: (sample: string, date: string | null) => void;
}) {
  const hasSeason = freq.seasonal != null;
  const [view, setView] = useState<View>("measured");
  const [shownYears, setShownYears] = useState<string[]>([]);
  const [selectedYear, setSelectedYear] = useState<string | null>(null);
  const [overlay, setOverlay] = useState<string>("none");

  const s = freq.summary;
  const dated = freq.time_axis === "dates";

  const views: [View, string, boolean, string][] = [
    ["measured", "Each sample", true, ""],
    ["season", "Average year", hasSeason,
      "This dataset has no sampling dates — only the order of the samples. Pooling them by "
      + "calendar month would produce a season nobody measured."],
  ] as [View, string, boolean, string][];
  const active = views.find(([v, , ok]) => v === view && ok) ? view : "measured";

  const option = useMemo(() => {
    const base = {
      backgroundColor: "transparent",
      grid: { left: 56, right: 14, top: 26, bottom: 30 },
      yAxis: {
        type: "value" as const,
        axisLabel: { color: "#94a3b8", formatter: (v: number) => `${(100 * v).toFixed(1)}%` },
        splitLine: { lineStyle: { color: "#1e293b" } },
      },
    };

    const ov = active === "measured"
      ? (env?.variables.find((v) => v.key === overlay) ?? null)
      : null;
    const ovAxis = ov
      ? [{
          type: "value" as const, scale: true, position: "right" as const,
          name: ov.unit ?? "", nameTextStyle: { color: "#94a3b8", fontSize: 9 },
          axisLabel: { color: "#94a3b8" }, splitLine: { show: false },
        }]
      : [];
    const ovSeries = ov
      ? [{
          name: ov.label, type: "line" as const, yAxisIndex: 1, showSymbol: false,
          connectNulls: false, z: 1,
          data: ov.points.map((p, i) => [dated ? p.date : String(i + 1), p.value] as [string, number | null]),
          lineStyle: { color: "#94a3b8", width: 1.2, type: "dashed" as const },
          itemStyle: { color: "#94a3b8" },
        }]
      : [];

    if (active === "measured") {
      const pts = freq.points.map((p, i) => [dated ? p.date : String(i + 1), p.share] as [string, number | null]);
      const absent = freq.points
        .map((p, i) => [dated ? p.date : String(i + 1), p.share] as [string, number | null])
        .filter((_, i) => (freq.points[i].share ?? 0) === 0);
      return {
        ...base,
        grid: { left: 56, right: ov ? 52 : 14, top: 26, bottom: 30 },
        yAxis: [base.yAxis, ...ovAxis],
        tooltip: {
          trigger: "axis" as const,
          formatter: (ps: { axisValueLabel: string; seriesName: string; data: [string, number | null] }[]) => {
            const p = ps[0];
            if (!p) return "";
            const o = ov ? ps.find((x) => x.seriesName === ov.label) : null;
            return `<b>${dated ? p.data[0] : `Sample ${p.data[0]} of ${freq.points.length}`}</b><br/>`
              + `${pct(p.data[1])}${p.data[1] == null ? "<br/>not detected" : ""}`
              + (ov ? `<br/>${ov.label}: ${o?.data?.[1] == null ? "not measured"
                  : `${(o.data[1] as number).toFixed(2)}${ov.unit ? ` ${ov.unit}` : ""}`}` : "");
          },
        },
        xAxis: dated
          ? { type: "time" as const, axisLabel: { color: "#94a3b8" } }
          : { type: "category" as const, data: freq.points.map((_, i) => String(i + 1)),
              name: "sample order", nameLocation: "middle" as const, nameGap: 20,
              nameTextStyle: { color: "#64748b", fontSize: 10 },
              axisLabel: { color: "#94a3b8", interval: Math.max(0, Math.floor(freq.points.length / 12) - 1) } },
        series: [
          { name: "share", type: "line" as const, showSymbol: true, symbolSize: 4, data: pts,
            lineStyle: { color, width: 1.8 }, itemStyle: { color },
            areaStyle: { opacity: 0.1, color } },
          { name: "not detected", type: "scatter" as const, data: absent, symbolSize: 6,
            symbol: "emptyCircle", itemStyle: { color: "#64748b" }, tooltip: { show: false } },
          ...ovSeries,
        ],
      };
    }


    const clim = freq.seasonal!.climatology;
    const years = freq.seasonal!.years;

    const sel = selectedYear ? years.find((y) => y.year === selectedYear) ?? null : null;
    if (sel) {
      return {
        ...base,
        tooltip: {
          trigger: "axis" as const,
          formatter: (ps: { axisValue: string; value: number | null }[]) => {
            const p = ps.find((x) => x.value != null) ?? ps[0];
            return p ? `<b>${p.axisValue} ${sel.year}</b><br/>${pct(p.value)}` : "";
          },
        },
        xAxis: { type: "category" as const, data: MONTHS, axisLabel: { color: "#94a3b8" } },
        series: [
          { name: sel.year, type: "line" as const, showSymbol: true, symbolSize: 5,
            connectNulls: false, z: 3,
            data: MONTHS.map((_, mi) => sel.by_month.find((m) => m.month === mi + 1)?.mean ?? null),
            lineStyle: { color, width: 2.5 }, itemStyle: { color } },
        ],
      };
    }
    return {
      ...base,
      legend: { show: true, top: 0, right: 8, textStyle: { color: "#94a3b8", fontSize: 10 },
                data: [MEAN, BAND, ...shownYears] },
      tooltip: {
        trigger: "axis" as const,
        formatter: (ps: { axisValue: string; seriesName: string; value: number | null }[]) => {
          const m = clim.find((c) => c.label === ps[0]?.axisValue);
          const rows = ps.filter((x) => x.seriesName !== BAND && x.value != null)
            .map((x) => `${x.seriesName}: ${pct(x.value)}`).join("<br/>");
          const n = m ? ` · ${m.n} samples from ${m.n_years} year${m.n_years === 1 ? "" : "s"}` : "";
          return `<b>${ps[0]?.axisValue}</b>${n}<br/>${rows}`;
        },
      },
      xAxis: { type: "category" as const, data: clim.map((c) => c.label), axisLabel: { color: "#94a3b8" } },
      series: [
        { name: "​", type: "line" as const, stack: "band", showSymbol: false, silent: true,
          lineStyle: { opacity: 0 }, tooltip: { show: false }, data: clim.map((c) => c.lo) },
        { name: BAND, type: "line" as const, stack: "band", showSymbol: false, silent: true,
          lineStyle: { opacity: 0 }, areaStyle: { color: "rgba(148,163,184,0.18)" },
          data: clim.map((c) => (c.lo == null || c.hi == null ? null : c.hi - c.lo)) },
        { name: MEAN, type: "line" as const, showSymbol: true, symbolSize: 5, connectNulls: true, z: 3,
          data: clim.map((c) => c.mean), lineStyle: { color, width: 2.5 }, itemStyle: { color } },
        ...shownYears.map((y) => {
          const yr = years.find((x) => x.year === y);
          const i = years.findIndex((x) => x.year === y);
          const c = YEAR_COLORS[i % YEAR_COLORS.length];
          return {
            name: y, type: "line" as const, showSymbol: true, symbolSize: 4, connectNulls: false, z: 2,
            data: MONTHS.map((_, mi) => yr?.by_month.find((m) => m.month === mi + 1)?.mean ?? null),
            lineStyle: { color: c, width: 1.4 }, itemStyle: { color: c },
          };
        }),
      ],
    };
  }, [active, freq, shownYears, selectedYear, dated, color, env, overlay]);

  const selYear = active === "season" && freq.seasonal && selectedYear
    ? freq.seasonal.years.find((y) => y.year === selectedYear) ?? null
    : null;

  return (
    <div data-testid={testid}>
      <div className="flex items-center gap-1 mb-2" data-testid={`${testid}-views`}>
        {views.map(([v, label, ok, reason]) => (
          <span key={v} className="inline-flex items-center">
            <button data-testid={`freq-view-${v}`} onClick={() => ok && setView(v)} disabled={!ok}
              className={`px-2 py-0.5 rounded text-xs border ${!ok
                ? "border-slate-800 text-slate-600 cursor-not-allowed line-through decoration-slate-700"
                : active === v
                  ? "border-cyan-400 text-cyan-300"
                  : "border-slate-700 text-slate-400 hover:border-slate-500"}`}>
              {label}
            </button>
            {!ok && <InfoTip title={`${label} — not available here`}><p>{reason}</p></InfoTip>}
          </span>
        ))}
      </div>

      {active === "season" && freq.seasonal && (
        <div className="mb-1 flex items-center gap-1 flex-wrap text-xs"
          data-testid={`${testid}-year-select`}>
          <span className="text-slate-500 mr-1">year</span>
          <button data-testid="year-select-avg" onClick={() => setSelectedYear(null)}
            className={`px-2 py-0.5 rounded border ${selectedYear == null
              ? "border-cyan-400 text-cyan-300"
              : "border-slate-700 text-slate-400 hover:border-slate-500"}`}>
            average year
          </button>
          {freq.seasonal.years.map((y) => (
            <button key={y.year} data-testid={`year-select-${y.year}`}
              title={y.note ?? `${y.n} samples · all 12 months`}
              onClick={() => setSelectedYear(y.year)}
              className={`px-2 py-0.5 rounded border ${selectedYear === y.year
                ? "border-cyan-400 text-cyan-300"
                : "border-slate-700 text-slate-400 hover:border-slate-500"}`}>
              {y.year}{y.note ? "*" : ""}
            </button>
          ))}
        </div>
      )}

      {active === "season" && !selYear && (
        <p data-testid={`${testid}-what`} className="mb-1 text-xs text-slate-300">
          The same values sorted into calendar months and averaged — 12 points out of{" "}
          {freq.points.length} samples.
        </p>
      )}
      {selYear && (
        <p data-testid={`${testid}-what`} className="mb-1 text-xs text-slate-300">
          The samples of {selYear.year} sorted into calendar months and averaged — the same
          computation as the average year, restricted to this year&rsquo;s {selYear.n} samples.
          {selYear.note && (
            <span className="text-amber-400" data-testid={`${testid}-year-note`}>
              {" "}({selYear.note})
            </span>
          )}
        </p>
      )}

      <div data-testid={`${testid}-quantity`}
        className={`mb-1 text-xs text-slate-400 ${compact ? "hidden" : ""}`}>
        {(
          <>Share of {subject} in {freq.quantity.basis}.
            <InfoTip title="How this percentage is formed">
              <p><strong>Numerator:</strong> {freq.quantity.numerator}</p>
              <p><strong>Denominator:</strong> {freq.quantity.denominator}</p>
              <p>So not the whole sample — only the most abundant ASVs were kept before
              the analysis. And it is {freq.quantity.not}.</p>
              {dated && (
                <p>The x-axis is real time: points sit at their real sampling date; the gaps
                are real gaps.</p>
              )}
            </InfoTip>
            {freq.quantity.value_kind === "transformed" && (
              <span className="text-amber-400" data-testid={`${testid}-transformed`}>
                {" "}· not raw reads
                <InfoTip title="Preprocessing unknown">
                  <p>Not one value in this dataset is a whole number
                  {freq.quantity.min_value != null && <> (smallest {freq.quantity.min_value.toExponential(1)})</>}.
                  Something converted them before we received them, and nothing we received says what.</p>
                  <p>One thing is ruled out: it is <strong>not</strong> the Hellinger transformation
                  that the source publication names for this analysis. Hellinger would leave every
                  sample with a length of exactly 1; here the sample lengths run from about 43 to
                  100,000, and the pipeline itself is configured with Hellinger switched off.</p>
                  <p>Calling these &ldquo;reads&rdquo; would be a guess, so the axis does not.</p>
                </InfoTip>
              </span>
            )}
          </>
        )}
      </div>

      <ReactECharts option={option} style={{ height: 210 }} notMerge
        onEvents={onPointClick && active === "measured" ? {
          click: (p: { dataIndex?: number }) => {
            const pt = p.dataIndex != null ? freq.points[p.dataIndex] : null;
            if (pt?.sample) onPointClick(pt.sample, pt.date);
          },
        } : undefined} />

      {s.statement != null && (
        <div className="mt-2 text-xs text-slate-300 space-y-0.5" data-testid={`${testid}-trio`}>
          {s.statement.split(" · ").map((teil, i) => (
            <div key={i} className="tabular-nums"
              data-testid={`${testid}-trio-${["rank", "detection", "share"][i] ?? i}`}>
              {teil.startsWith("no relative abundance")
                ? <span className="text-amber-400">{teil}</span>
                : teil.startsWith("no ") ? <span className="text-slate-500">{teil}</span> : teil}
            </div>
          ))}
        </div>
      )}

      {active === "measured" && !compact && env && env.variables.length > 0 && (
        <div className="mt-2 flex items-center gap-1 flex-wrap text-xs" data-testid={`${testid}-overlay`}>
          <span className="text-slate-500 mr-1">measured alongside</span>
          <button data-testid="ov-none" onClick={() => setOverlay("none")}
            className={`px-2 py-0.5 rounded border ${overlay === "none"
              ? "border-cyan-400 text-cyan-300"
              : "border-slate-700 text-slate-400 hover:border-slate-500"}`}>
            none
          </button>
          {env.variables.map((v) => (
            <button key={v.key} data-testid={`ov-${v.key}`} onClick={() => setOverlay(v.key)}
              title={`${v.n} of ${v.total} samples`}
              className={`px-2 py-0.5 rounded border ${overlay === v.key
                ? "border-cyan-400 text-cyan-300"
                : "border-slate-700 text-slate-400 hover:border-slate-500"}`}>
              {v.label}
            </button>
          ))}
        </div>
      )}
      {active === "measured" && env?.variables.some((v) => v.key === overlay) && (
        <p className="mt-1 text-[10px] text-slate-500" data-testid={`${testid}-overlay-note`}>
          Measured, not derived from the sequences. Shown side by side only — no correlation is
          computed, and two lines moving together are not evidence of one.
        </p>
      )}

      {active === "measured" && !dated && (
        <div className="mt-1 text-[10px] text-slate-500" data-testid={`${testid}-ordinal-note`}>
          The x-axis is the <strong>order</strong> of the samples, not a date — this dataset has
          no sampling dates, so there are no month, year or season statements.
        </div>
      )}

      {active === "season" && !selYear && (
        <SeasonExtras seasonal={freq.seasonal!} shownYears={shownYears} setShownYears={setShownYears}
          testid={testid} />
      )}

      <div className={`grid gap-2 mt-3 text-slate-300 ${compact ? "grid-cols-1" : "grid-cols-2"}`}>
        {!compact && (
          <Stat label="found in" testid={`${testid}-presence`}
            value={`${s.n_detected} of ${s.n_samples} samples`}
            hint="samples where the value was above zero" />
        )}
        <Stat label="highest share" testid={`${testid}-max`}
          value={pct(s.max_share)}
          hint={`largest of the ${s.n_samples} shares${whereLabel(s.max_at, s.n_samples) ? ` · ${whereLabel(s.max_at, s.n_samples)}` : ""}`} />
      </div>

      <p data-testid="composition-caveat" className="mt-2 text-xs text-red-400 leading-snug">
        {freq.quantity.share_caveat}
        <InfoTip title="What a rising share can and cannot mean">
          <p>Shares always add up to 100%. If one goes up, everything else may simply have gone
          down — that says nothing about how much was in the water.</p>
          <p>These are not cell counts, and how many rare organisms show up at all depends on
          sequencing depth. The <em>timing</em> of a maximum survives this; its height does not.</p>
        </InfoTip>
      </p>
    </div>
  );
}

function whereLabel(w: { date: string | null; index: number | null }, n: number): string | undefined {
  if (w.date) return w.date;
  if (w.index != null) return `sample ${w.index} of ${n}`;
  return undefined;
}

function SeasonExtras({ seasonal, shownYears, setShownYears, testid }: {
  seasonal: NonNullable<Frequency["seasonal"]>;
  shownYears: string[];
  setShownYears: (f: (c: string[]) => string[]) => void;
  testid: string;
}) {
  const partial = new Set(seasonal.partial_years);
  const years: SeasonalYear[] = seasonal.years;
  return (
    <>
      <div className="mt-1 flex items-center gap-1 flex-wrap text-xs" data-testid={`${testid}-years`}>
        <span className="text-slate-500 mr-1">overlay a year</span>
        {years.map((y, i) => {
          const on = shownYears.includes(y.year);
          const c = YEAR_COLORS[i % YEAR_COLORS.length];
          return (
            <button key={y.year} data-testid={`year-${y.year}`}
              title={`${y.n} samples · ${y.months_covered}/12 months`}
              onClick={() => setShownYears((cur) => (on ? cur.filter((x) => x !== y.year) : [...cur, y.year]))}
              style={on ? { borderColor: c, color: c } : undefined}
              className={`px-2 py-0.5 rounded border ${on ? "" : "border-slate-700 text-slate-400 hover:border-slate-500"}`}>
              {y.year}{partial.has(y.year) ? "*" : ""}
            </button>
          );
        })}
      </div>

      <table className="mt-2 w-full text-xs text-slate-400" data-testid={`${testid}-year-table`}>
        <thead><tr className="text-slate-500">
          <th className="text-left font-normal">Year</th>
          <th className="text-right font-normal">mean share</th>
          <th className="text-right font-normal">
            within-year spread
            <InfoTip title="Two different spreads">
              <p>This column is how much the share moved <em>during</em> that year — a large
              number means a pronounced annual cycle.</p>
              <p>The grey band in the chart is a different thing: how much the same calendar
              month differed <em>between</em> years.</p>
            </InfoTip>
          </th>
          <th className="text-right font-normal">
            vs. typical year (pp)
            <InfoTip title="Comparison with the typical year">
              <p>For each year: how far above or below it sat, compared with what its <em>own</em>
              months usually show. In percentage points.</p>
              <p>Without that correction a year that happens to contain many winter months would
              look higher for that reason alone. Years marked * do not cover all 12 months.</p>
            </InfoTip>
          </th>
          <th className="text-right font-normal">samples</th>
        </tr></thead>
        <tbody>
          {years.map((y) => (
            <tr key={y.year} className={partial.has(y.year) ? "text-slate-500" : ""}>
              <td>{y.year}{partial.has(y.year) ? "*" : ""}</td>
              <td className="text-right tabular-nums">{pct(y.mean)}</td>
              <td className="text-right tabular-nums">± {pct(y.std)}</td>
              <td className={`text-right tabular-nums ${y.anomaly >= 0 ? "text-emerald-400/80" : "text-amber-400/80"}`}>
                {y.anomaly >= 0 ? "+" : "−"}{Math.abs(100 * y.anomaly).toFixed(2)}
              </td>
              <td className="text-right tabular-nums">{y.n} · {y.months_covered}/12</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="mt-1 text-xs text-slate-300 tabular-nums" data-testid={`${testid}-trend`}>
        Trend {seasonal.trend_per_year == null ? "—"
          : `${seasonal.trend_per_year >= 0 ? "+" : "−"}${Math.abs(100 * seasonal.trend_per_year).toFixed(3)} pp/year`}
        <InfoTip title="Trend per year">
          <p>Slope across the years, season-adjusted: each value has the mean of <em>its own</em>
          calendar month subtracted first.</p>
          <p>Necessary because the years cover different months. Resting on {years.length} yearly
          points, this is a hint, not evidence.</p>
        </InfoTip>
      </div>
    </>
  );
}

function Stat({ label, value, hint, testid }: {
  label: string; value: string; hint?: string; testid?: string;
}) {
  return (
    <div className="bg-slate-800 rounded px-2 py-1">
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div data-testid={testid} className="text-slate-100">{value}</div>
      {hint && <div className="text-[10px] text-slate-500">{hint}</div>}
    </div>
  );
}

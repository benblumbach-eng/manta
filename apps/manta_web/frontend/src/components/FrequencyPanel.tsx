import { useMemo, useState } from "react";
import ReactECharts from "echarts-for-react";
import type { EnvVariable, Environment, Frequency, SeasonalYear } from "../api";
import InfoTip from "./InfoTip";
import { esc } from "../format";
import { Chooser, ChooserRow, Segmented } from "./controls";
import { chartTooltip, FONT, useTokens } from "../design/tokens";
import { primarySeries, seriesColour, yearColour, SERIES_SIZE } from "../design/dataColours";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const overlayColour = (i: number, light: boolean) => seriesColour(1 + (i % (SERIES_SIZE - 1)), light);
const MEAN = "Average year";
const BAND = "Spread between years";

const pct = (v: number | null | undefined, d = 2) => (v == null ? "—" : `${(100 * v).toFixed(d)}%`);

type View = "measured" | "season";

export default function FrequencyPanel({ freq, subject, env, color: colorProp,
                                        testid = "frequency", compact = false, onPointClick }: {
  freq: Frequency;
  subject: string;
  env?: Environment | null;
  color?: string;
  testid?: string;
  compact?: boolean;
  onPointClick?: (sample: string, date: string | null) => void;
}) {
  const tok = useTokens();
  const color = colorProp ?? primarySeries(tok.light);
  const hasSeason = freq.seasonal != null;
  const [view, setView] = useState<View>("measured");
  const [shownYears, setShownYears] = useState<string[]>([]);
  const [selectedYear, setSelectedYear] = useState<string | null>(null);
  const [overlays, setOverlays] = useState<string[]>([]);
  const umschalten = (k: string) =>
    setOverlays((cur) => cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k]);
  const ovKeys = (env?.variables ?? []).filter((v) => overlays.includes(v.key)).map((v) => v.key);
  const ovFarbe = (k: string) => overlayColour(ovKeys.indexOf(k), tok.light);
  const ovEinzeln = ovKeys.length === 1 ? (env?.variables ?? []).find((v) => v.key === ovKeys[0]) ?? null : null;

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
        axisLabel: { color: tok.textMuted, fontSize: FONT.xs2,
                     formatter: (v: number) => `${(100 * v).toFixed(1)}%` },
        splitLine: { lineStyle: { color: tok.chartGrid } },
      },
    };
    const tip = chartTooltip(tok);
    const xLabel = { color: tok.textMuted, fontSize: FONT.xs2 };

    const ovVars = (env?.variables ?? []).filter((v) => overlays.includes(v.key));
    const jahr = active === "season" && selectedYear ? selectedYear : null;
    const ovPunkte = (v: EnvVariable): { x: string; y: number | null }[] => {
      if (active === "measured") {
        return v.points.map((p, i) => ({ x: dated ? (p.date ?? String(i + 1)) : String(i + 1),
                                         y: p.value }));
      }
      const reihe = jahr ? (v.monthly_by_year?.[jahr] ?? []) : (v.monthly ?? []);
      const nach = new Map<number, number>(reihe.map((m) => [m.month, m.mean]));
      return MONTHS.map((label, i) => ({ x: label, y: nach.get(i + 1) ?? null }));
    };
    const mehrere = ovVars.length > 1;
    const einzeln = !mehrere && ovVars.length === 1 ? ovVars[0] : null;
    const ovAxis = ovVars.length
      ? [{
          type: "value" as const, position: "right" as const, alignTicks: true,
          min: mehrere ? 0 : einzeln?.min, max: mehrere ? 1 : einzeln?.max,
          name: mehrere ? "own range" : (ovVars[0].unit ?? ""),
          nameLocation: "start" as const, nameGap: 8,
          nameTextStyle: { color: tok.textMuted, fontSize: FONT.xs2, align: "left" as const },
          axisLabel: mehrere ? { show: false } : {
            color: tok.textMuted, fontSize: FONT.xs2,
            formatter: (v: number) => {
              const sp = einzeln ? Math.abs(einzeln.max - einzeln.min) : 1;
              return v.toFixed(sp >= 100 ? 0 : sp >= 1 ? 1 : sp >= 0.1 ? 2 : 3);
            },
          },
          splitLine: { show: false },
        }]
      : [];
    const ovSeries = ovVars.map((v, i) => {
      const punkte = ovPunkte(v);
      const werte = punkte.map((p) => p.y).filter((y): y is number => y != null);
      const lo = v.min ?? (werte.length ? Math.min(...werte) : 0);
      const hi = v.max ?? (werte.length ? Math.max(...werte) : 1);
      const farbe = overlayColour(i, tok.light);
      return {
        name: v.label, type: "line" as const, yAxisIndex: 1, showSymbol: false,
        connectNulls: false, z: 1,
        data: punkte.map((p) => ({
          value: [p.x, p.y == null ? null : (mehrere ? (hi > lo ? (p.y - lo) / (hi - lo) : 0.5) : p.y)],
          gemessen: p.y, einheit: v.unit,
        })),
        lineStyle: { color: farbe, width: 1.2, type: "dashed" as const },
        itemStyle: { color: farbe },
      };
    });
    const ovZeilen = (ps: { seriesName: string; data?: { gemessen?: number | null;
                                                         einheit?: string | null } }[]) =>
      ovVars.map((v) => {
        const treffer = ps.find((x) => x.seriesName === v.label);
        const w = treffer?.data?.gemessen;
        return `${esc(v.label)}: ${w == null ? "not measured"
          : `${w.toFixed(2)}${v.unit ? ` ${esc(v.unit)}` : ""}`}`;
      }).join("<br/>");

    if (active === "measured") {
      const pts = freq.points.map((p, i) => [dated ? p.date : String(i + 1), p.share] as [string, number | null]);
      const absent = freq.points
        .map((p, i) => [dated ? p.date : String(i + 1), p.share] as [string, number | null])
        .filter((_, i) => (freq.points[i].share ?? 0) === 0);
      return {
        ...base,
        grid: { left: 56, right: ovVars.length ? 52 : 14, top: 26, bottom: 30 },
        yAxis: [base.yAxis, ...ovAxis],
        tooltip: {
          ...tip,
          trigger: "axis" as const,
          formatter: (ps: { axisValueLabel: string; seriesName: string; data: [string, number | null];
                            }[] & { seriesName: string; data?: { gemessen?: number | null;
                                                                einheit?: string | null } }[]) => {
            const p = ps[0];
            if (!p) return "";
            return `<b>${esc(dated ? p.data[0] : `Sample ${p.data[0]} of ${freq.points.length}`)}</b><br/>`
              + `${pct(p.data[1])}${p.data[1] == null ? "<br/>not detected" : ""}`
              + (ovVars.length ? `<br/>${ovZeilen(ps)}` : "");
          },
        },
        xAxis: dated
          ? { type: "time" as const, axisLabel: xLabel }
          : { type: "category" as const, data: freq.points.map((_, i) => String(i + 1)),
              name: "sample order", nameLocation: "middle" as const, nameGap: 20,
              nameTextStyle: { color: tok.textMuted, fontSize: FONT.xs2 },
              axisLabel: { ...xLabel, interval: Math.max(0, Math.floor(freq.points.length / 12) - 1) } },
        series: [
          { name: "share", type: "line" as const, showSymbol: true, symbolSize: 4, data: pts,
            lineStyle: { color, width: 1.8 }, itemStyle: { color },
            areaStyle: { opacity: 0.1, color },
          },
          { name: "not detected", type: "scatter" as const, data: absent, symbolSize: 6,
            symbol: "emptyCircle", itemStyle: { color: tok.textDisabled }, tooltip: { show: false } },
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
          ...tip,
          trigger: "axis" as const,
          formatter: (ps: { axisValue: string; seriesName: string; value: number | null;
                            data?: { gemessen?: number | null } }[]) => {
            const p = ps.find((x) => x.seriesName === sel.year) ?? ps[0];
            return (p ? `<b>${esc(p.axisValue)} ${esc(sel.year)}</b><br/>${pct(p.value as number | null)}` : "")
              + (ovVars.length ? `<br/>${ovZeilen(ps)}` : "");
          },
        },
        yAxis: [base.yAxis, ...ovAxis],
        grid: { ...base.grid, right: ovVars.length ? 52 : 14 },
        xAxis: { type: "category" as const, data: MONTHS, axisLabel: xLabel },
        series: [
          { name: sel.year, type: "line" as const, showSymbol: true, symbolSize: 5,
            connectNulls: false, z: 3,
            data: MONTHS.map((_, mi) => sel.by_month.find((m) => m.month === mi + 1)?.mean ?? null),
            lineStyle: { color, width: 2.5 }, itemStyle: { color } },
          ...ovSeries,
        ],
      };
    }
    return {
      ...base,
      legend: { show: true, top: 0, right: 8, textStyle: { color: tok.textMuted, fontSize: FONT.xs2 },
                data: [MEAN, BAND, ...shownYears] },
      tooltip: {
        ...tip,
        trigger: "axis" as const,
        formatter: (ps: { axisValue: string; seriesName: string; value: number | null;
                          data?: { gemessen?: number | null } }[]) => {
          const m = clim.find((c) => c.label === ps[0]?.axisValue);
          const namen = new Set(ovVars.map((v) => v.label));
          const rows = ps.filter((x) => x.seriesName !== BAND && !namen.has(x.seriesName)
                                        && x.value != null)
            .map((x) => `${esc(x.seriesName)}: ${pct(x.value)}`).join("<br/>");
          const n = m ? ` · ${m.n} samples from ${m.n_years} year${m.n_years === 1 ? "" : "s"}` : "";
          return `<b>${esc(ps[0]?.axisValue)}</b>${n}<br/>${rows}`
            + (ovVars.length ? `<br/>${ovZeilen(ps)}` : "");
        },
      },
      yAxis: [base.yAxis, ...ovAxis],
      grid: { ...base.grid, right: ovVars.length ? 52 : 14 },
      xAxis: { type: "category" as const, data: clim.map((c) => c.label), axisLabel: xLabel },
      series: [
        { name: "​", type: "line" as const, stack: "band", showSymbol: false, silent: true,
          lineStyle: { opacity: 0 }, tooltip: { show: false }, data: clim.map((c) => c.lo) },
        { name: BAND, type: "line" as const, stack: "band", showSymbol: false, silent: true,
          lineStyle: { opacity: 0 }, areaStyle: { color: tok.chartLine, opacity: 0.18 },
          data: clim.map((c) => (c.lo == null || c.hi == null ? null : c.hi - c.lo)) },
        { name: MEAN, type: "line" as const, showSymbol: true, symbolSize: 5, connectNulls: true, z: 3,
          data: clim.map((c) => c.mean), lineStyle: { color, width: 2.5 }, itemStyle: { color } },
        ...ovSeries,
        ...shownYears.map((y) => {
          const yr = years.find((x) => x.year === y);
          const i = years.findIndex((x) => x.year === y);
          const c = yearColour(i, years.length, tok.light);
          return {
            name: y, type: "line" as const, showSymbol: true, symbolSize: 4, connectNulls: false, z: 2,
            data: MONTHS.map((_, mi) => yr?.by_month.find((m) => m.month === mi + 1)?.mean ?? null),
            lineStyle: { color: c, width: 1.4 }, itemStyle: { color: c },
          };
        }),
      ],
    };
  }, [active, freq, shownYears, selectedYear, dated, color, env, overlays, tok]);

  const selYear = active === "season" && freq.seasonal && selectedYear
    ? freq.seasonal.years.find((y) => y.year === selectedYear) ?? null
    : null;

  return (
    <div data-testid={testid}>
      <div className="mb-2 flex flex-wrap items-center gap-2" data-testid={`${testid}-views`}>
        <Segmented
          value={active}
          onChange={(v) => setView(v)}
          testid={`${testid}-view-switch`}
          options={views.map(([v, label, ok, reason]) => ({
            value: v, label, disabled: !ok, reason, testid: `freq-view-${v}`,
          }))} />

        {active === "season" && freq.seasonal && (
          <Chooser label="year" summary={selectedYear ?? "average"} closeOnPick
            testid={`${testid}-year-select`}>
            <ChooserRow radio checked={selectedYear == null} testid="year-select-avg"
              onToggle={() => setSelectedYear(null)}
              label="average year"
              hint={`all ${freq.points.length} samples folded onto the calendar`} />
            {freq.seasonal.years.map((y) => (
              <ChooserRow key={y.year} radio checked={selectedYear === y.year}
                testid={`year-select-${y.year}`}
                onToggle={() => setSelectedYear(y.year)}
                label={y.year}
                hint={y.note ?? `${y.n} samples · all 12 months`} />
            ))}
          </Chooser>
        )}

        {active === "season" && !selectedYear && freq.seasonal && (
          <Chooser label="overlay years" testid={`${testid}-years`} count={shownYears.length}
            summary={shownYears.length ? undefined : "none"}>
            {freq.seasonal.years.map((y, i) => (
              <ChooserRow key={y.year} testid={`year-${y.year}`}
                checked={shownYears.includes(y.year)}
                onToggle={() => setShownYears((cur) => cur.includes(y.year)
                  ? cur.filter((x) => x !== y.year) : [...cur, y.year])}
                colour={shownYears.includes(y.year)
                  ? yearColour(i, freq.seasonal!.years.length, tok.light) : undefined}
                label={y.year}
                hint={y.note ?? `${y.n} samples · all 12 months`} />
            ))}
            {shownYears.length > 0 && (
              <button data-testid="years-none" onClick={() => setShownYears(() => [])}
                className="mt-1 w-full rounded px-2 py-1 text-left text-2xs text-accent
                           hover:bg-control">
                none
              </button>
            )}
          </Chooser>
        )}

        {!compact && env && env.variables.length > 0 && (
          <Chooser label="measured alongside" testid={`${testid}-overlay`}
            count={overlays.length}
            summary={overlays.length ? undefined : "none"}>
            {(env?.variables ?? []).map((v) => (
              <ChooserRow key={v.key} testid={`ov-${v.key}`}
                checked={overlays.includes(v.key)}
                onToggle={() => umschalten(v.key)}
                colour={overlays.includes(v.key) ? ovFarbe(v.key) : undefined}
                label={v.label}
                hint={`${v.n} of ${v.total} samples${v.unit ? ` · ${v.unit}` : ""}`} />
            ))}
            {overlays.length > 0 && (
              <button data-testid="ov-none" onClick={() => setOverlays([])}
                className="mt-1 w-full rounded px-2 py-1 text-left text-2xs text-accent
                           hover:bg-control">
                none
              </button>
            )}
          </Chooser>
        )}
      </div>

      {active === "season" && !selYear && (
        <p data-testid={`${testid}-what`} className="mb-1 text-xs text-fg">
          Mean share per calendar month, over all years — 12 points from{" "}
          {freq.points.length} samples.
        </p>
      )}
      {selYear && (
        <p data-testid={`${testid}-what`} className="mb-1 text-xs text-fg">
          Mean share per calendar month in {selYear.year} — the same computation as the
          average year, restricted to this year&rsquo;s {selYear.n} samples.
          {selYear.note && (
            <span className="text-warn" data-testid={`${testid}-year-note`}>
              {" "}({selYear.note})
            </span>
          )}
        </p>
      )}

      <div data-testid={`${testid}-quantity`}
        className={`mb-1 text-xs text-fg-muted ${compact ? "hidden" : ""}`}>
        {(
          <>Share of {subject} in {freq.quantity.basis}.
            <InfoTip title="How this percentage is formed"
                  ask={{ concept: "share", question: "What does the share mean here, and what does it not show?" }}>
              <p><strong>Numerator:</strong> {freq.quantity.numerator}</p>
              <p><strong>Denominator:</strong> {freq.quantity.denominator}</p>
              <p>It is {freq.quantity.not}.</p>
              {dated && (
                <p>The x-axis is real time: points sit at their real sampling date; the gaps
                are real gaps.</p>
              )}
            </InfoTip>
            {freq.quantity.value_kind === "transformed" && (
              <span className="text-warn" data-testid={`${testid}-transformed`}>
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

      <div data-testid={`${testid}-chart`}
        data-ov-min={ovEinzeln?.min ?? ""} data-ov-max={ovEinzeln?.max ?? ""}>
      <ReactECharts option={option} style={{ height: 210 }} notMerge
        onEvents={onPointClick && active === "measured" ? {
          click: (p: { dataIndex?: number }) => {
            const pt = p.dataIndex != null ? freq.points[p.dataIndex] : null;
            if (pt?.sample) onPointClick(pt.sample, pt.date);
          },
        } : undefined} />
      </div>

      {s.statement != null && (() => {
        const absagen = s.statement.split(" · ").filter((t) => t.startsWith("no "));
        return absagen.length === 0 ? null : (
          <div className="mt-2 text-xs space-y-1" data-testid={`${testid}-trio`}>
            {absagen.map((teil, i) => (
              <div key={i} className="tabular-nums"
                data-testid={`${testid}-trio-${teil.startsWith("no relative abundance") ? "share" : i}`}>
                {teil.startsWith("no relative abundance")
                  ? <span className="text-warn">{teil}</span>
                  : <span className="text-fg-muted">{teil}</span>}
              </div>
            ))}
          </div>
        );
      })()}

      {overlays.length > 0 && (
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs"
             data-testid={`${testid}-overlay-legend`}>
          {(env?.variables ?? []).filter((v) => overlays.includes(v.key)).map((v) => (
            <span key={v.key} className="inline-flex items-center gap-1 text-fg-muted">
              <svg width="16" height="6"><line x1="0" y1="3" x2="16" y2="3" stroke={ovFarbe(v.key)}
                strokeWidth="1.2" strokeDasharray="4 3" /></svg>
              {v.label}{v.unit ? ` (${v.unit})` : ""}
            </span>
          ))}
        </div>
      )}
      {overlays.length > 0 && (
        <p className="mt-1 text-2xs text-fg-muted" data-testid={`${testid}-overlay-note`}>
          Measured, not derived from the sequences. Drawn over the curve on the right-hand axis
          (the dataset&rsquo;s range) — no correlation is computed.
          {overlays.length > 1 && " Each is laid over its own range: shapes comparable, sizes not."}
        </p>
      )}

      {active === "measured" && !dated && (
        <div className="mt-1 text-2xs text-fg-muted" data-testid={`${testid}-ordinal-note`}>
          The x-axis is the <strong>order</strong> of the samples, not a date — this dataset has
          no sampling dates, so there are no month, year or season statements.
        </div>
      )}

      {active === "season" && !selYear && (
        <SeasonExtras seasonal={freq.seasonal!} testid={testid} />
      )}


      <p data-testid="composition-caveat" data-caveat=""
        className="mt-2 border-l-2 border-line-strong pl-2 text-xs text-fg leading-snug">
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

function SeasonExtras({ seasonal, testid }: {
  seasonal: NonNullable<Frequency["seasonal"]>;
  testid: string;
}) {
  const partial = new Set(seasonal.partial_years);
  const years: SeasonalYear[] = seasonal.years;
  return (
    <>
      <table className="mt-2 w-full text-xs text-fg-muted" data-testid={`${testid}-year-table`}>
        <thead><tr className="text-fg-muted">
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
            <tr key={y.year} className={partial.has(y.year) ? "text-fg-muted" : ""}>
              <td>{y.year}{partial.has(y.year) ? "*" : ""}</td>
              <td className="text-right tabular-nums">{pct(y.mean)}</td>
              <td className="text-right tabular-nums">± {pct(y.std)}</td>
              <td className={`text-right tabular-nums ${y.anomaly >= 0 ? "text-ok" : "text-warn"}`}>
                {y.anomaly >= 0 ? "+" : "−"}{Math.abs(100 * y.anomaly).toFixed(2)}
              </td>
              <td className="text-right tabular-nums">{y.n} · {y.months_covered}/12</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="mt-1 text-xs text-fg tabular-nums" data-testid={`${testid}-trend`}>
        Trend {seasonal.trend_per_year == null ? "—"
          : `${seasonal.trend_per_year >= 0 ? "+" : "−"}${Math.abs(100 * seasonal.trend_per_year).toFixed(3)} pp/year`}
        <InfoTip title="Trend per year"
                  ask={{ concept: "trend_per_year", question: "How is the trend per year computed, and what does it not tell me?" }}>
          <p data-testid={`${testid}-trend-method`}>Least-squares slope across the yearly means,
          season-adjusted: each value has the mean of <em>its own</em> calendar month subtracted
          first. Not robust — one unusual year can tilt it.</p>
          <p>Necessary because the years cover different months. Resting on {years.length} yearly
          points, this is a hint, not evidence.</p>
        </InfoTip>
      </div>
    </>
  );
}

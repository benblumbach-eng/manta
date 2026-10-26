import { useMemo, useRef, useState } from "react";
import ReactECharts from "echarts-for-react";
import type { ECharts } from "echarts";
import type { Frequency, SeasonalYear } from "../api";
import { esc } from "../format";
import { useNearestPointClick } from "../chartClick";
import { Chooser, ChooserRow, Segmented } from "./controls";
import { chartTooltip, FONT, useTokens } from "../design/tokens";
import { primarySeries, yearColour } from "../design/dataColours";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const pct = (v: number | null | undefined, d = 2) => (v == null ? "—" : `${(100 * v).toFixed(d)}%`);

type View = "measured" | "season";

export default function FrequencyPanel({ freq, color: colorProp,
                                        testid = "frequency", onPointClick }: {
  freq: Frequency;
  color?: string;
  testid?: string;
  onPointClick?: (sample: string, date: string | null) => void;
}) {
  const tok = useTokens();
  const color = colorProp ?? primarySeries(tok.light);
  const hasSeason = freq.seasonal != null;
  const [view, setView] = useState<View>("measured");
  const [shownYears, setShownYears] = useState<string[]>([]);
  const [chosenYear, setSelectedYear] = useState<string | null>(null);
  const selectedYear = chosenYear ?? freq.seasonal?.years[0]?.year ?? null;

  const dated = freq.time_axis === "dates";

  const views: [View, string, boolean, string][] = [
    ["measured", "Whole period", true, ""],
    ["season", "By year", hasSeason, "No sampling dates in this dataset"],
  ] as [View, string, boolean, string][];
  const teilweise = (y: SeasonalYear) =>
    y.months_covered < 12 ? ` (${y.months_covered} of 12 months)` : "";
  const active = views.find(([v, , ok]) => v === view && ok) ? view : "measured";

  const option = useMemo(() => {
    const peak = Math.max(0, ...freq.points.map((p) => p.share ?? 0));
    const base = {
      backgroundColor: "transparent",
      grid: { left: 56, right: 14, top: 26, bottom: 30 },
      yAxis: {
        type: "value" as const,
        max: active === "measured" ? "dataMax" : undefined,
        axisLabel: { color: tok.textMuted, fontSize: FONT.xs2,
                     formatter: (v: number) =>
                       `${(100 * v).toFixed(peak < 0.0001 ? 4 : peak < 0.001 ? 3 : peak < 0.01 ? 2 : 1)}%` },
        splitLine: { lineStyle: { color: tok.chartGrid } },
      },
    };
    const tip = chartTooltip(tok);
    const xLabel = { color: tok.textMuted, fontSize: FONT.xs2 };

    if (active === "measured") {
      const pts = freq.points.map((p, i) => [dated ? p.date : String(i + 1), p.share] as [string, number | null]);
      const absent = freq.points
        .map((p, i) => [dated ? p.date : String(i + 1), p.share] as [string, number | null])
        .filter((_, i) => (freq.points[i].share ?? 0) === 0);
      return {
        ...base,
        tooltip: {
          ...tip,
          trigger: "axis" as const,
          formatter: (ps: { axisValueLabel: string; seriesName: string; data: [string, number | null];
                            }[]) => {
            const p = ps[0];
            if (!p) return "";
            return `<b>${esc(dated ? p.data[0] : `Sample ${p.data[0]} of ${freq.points.length}`)}</b><br/>`
              + `${pct(p.data[1])}${p.data[1] == null ? "<br/>not detected" : ""}`;
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
        ],
      };
    }


    const years = freq.seasonal!.years;
    const shown = [selectedYear!, ...shownYears.filter((y) => y !== selectedYear)];
    return {
      ...base,
      legend: { show: shown.length > 1, top: 0, right: 8,
                textStyle: { color: tok.textMuted, fontSize: FONT.xs2 }, data: shown },
      tooltip: {
        ...tip,
        trigger: "axis" as const,
        formatter: (ps: { axisValue: string; seriesName: string; value: number | null }[]) => {
          const rows = ps.filter((x) => x.value != null)
            .map((x) => `${shown.length > 1 ? `${esc(x.seriesName)}: ` : ""}${pct(x.value)}`).join("<br/>");
          return `<b>${esc(ps[0]?.axisValue)}${shown.length > 1 ? "" : ` ${esc(selectedYear ?? "")}`}</b><br/>${rows}`;
        },
      },
      xAxis: { type: "category" as const, data: MONTHS, axisLabel: xLabel },
      series: shown.map((y, k) => {
        const yr = years.find((x) => x.year === y);
        const c = k === 0 ? color
          : yearColour(years.findIndex((x) => x.year === y), years.length, tok.light);
        return {
          name: y, type: "line" as const, showSymbol: true, symbolSize: k === 0 ? 5 : 4,
          connectNulls: false, z: k === 0 ? 3 : 2,
          data: MONTHS.map((_, mi) => yr?.by_month.find((m) => m.month === mi + 1)?.mean ?? null),
          lineStyle: { color: c, width: k === 0 ? 2.5 : 1.4 }, itemStyle: { color: c },
        };
      }),
    };
  }, [active, freq, shownYears, selectedYear, dated, color, tok]);

  const klickBereit = useNearestPointClick(
    freq.points.map((p, i) => (dated && p.date ? Date.parse(p.date) : i)),
    onPointClick && active === "measured"
      ? (i) => { const pt = freq.points[i]; if (pt?.sample) onPointClick(pt.sample, pt.date); }
      : undefined);

  // By year: a click picks the nearest month and, of the years shown, the line closest to the
  // click; Inspect opens at the first sample of that month in that year.
  const jahrKlick = useRef<(chart: ECharts, ev: { offsetX: number; offsetY: number }) => void>();
  jahrKlick.current = (chart, ev) => {
    if (!onPointClick || active !== "season" || !freq.seasonal || !selectedYear) return;
    if (!chart.containPixel({ gridIndex: 0 }, [ev.offsetX, ev.offsetY])) return;
    const mi = Math.round((chart.convertFromPixel({ seriesIndex: 0 }, [ev.offsetX, ev.offsetY]) as number[])[0]);
    const shown = [selectedYear, ...shownYears.filter((y) => y !== selectedYear)];
    let best: string | null = null, abstand = Infinity;
    shown.forEach((y, k) => {
      const v = freq.seasonal!.years.find((x) => x.year === y)?.by_month.find((m) => m.month === mi + 1)?.mean;
      if (v == null) return;
      const py = (chart.convertToPixel({ seriesIndex: k }, [mi, v]) as number[])[1];
      if (Math.abs(py - ev.offsetY) < abstand) { abstand = Math.abs(py - ev.offsetY); best = y; }
    });
    if (best == null) return;
    const prefix = `${best}-${String(mi + 1).padStart(2, "0")}`;
    const pt = freq.points.find((p) => p.sample && p.date?.startsWith(prefix));
    if (pt?.sample) onPointClick(pt.sample, pt.date);
  };
  const chartBereit = (chart: ECharts) => {
    klickBereit(chart);
    chart.getZr().on("click", (ev: { offsetX: number; offsetY: number }) => jahrKlick.current?.(chart, ev));
  };

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
            value: v, label, disabled: !ok, title: ok ? undefined : reason, testid: `freq-view-${v}`,
          }))} />

        {active === "season" && freq.seasonal && (
          <Chooser label="year" closeOnPick testid={`${testid}-year-select`}
            summary={selYear ? `${selYear.year}${teilweise(selYear)}` : undefined}>
            {freq.seasonal.years.map((y) => (
              <ChooserRow key={y.year} radio checked={selectedYear === y.year}
                testid={`year-select-${y.year}`}
                onToggle={() => { setSelectedYear(y.year);
                                   setShownYears((cur) => cur.filter((x) => x !== y.year)); }}
                label={y.year}
                hint={`${y.n} samples${teilweise(y)}`} />
            ))}
          </Chooser>
        )}

        {active === "season" && freq.seasonal && freq.seasonal.years.length > 1 && (
          <Chooser label="add years" testid={`${testid}-years`} count={shownYears.length}
            summary={shownYears.length ? undefined : "none"}>
            {freq.seasonal.years.map((y, i) => y.year !== selectedYear && (
              <ChooserRow key={y.year} testid={`year-${y.year}`}
                checked={shownYears.includes(y.year)}
                onToggle={() => setShownYears((cur) => cur.includes(y.year)
                  ? cur.filter((x) => x !== y.year) : [...cur, y.year])}
                colour={shownYears.includes(y.year)
                  ? yearColour(i, freq.seasonal!.years.length, tok.light) : undefined}
                label={y.year}
                hint={`${y.n} samples${teilweise(y)}`} />
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

      </div>


      <div data-testid={`${testid}-chart`}>
      <ReactECharts option={option} style={{ height: 210 }} notMerge onChartReady={chartBereit}
        className={onPointClick ? "cursor-pointer" : undefined} />
      </div>

    </div>
  );
}

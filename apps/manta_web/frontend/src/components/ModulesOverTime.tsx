import { useEffect, useMemo, useState } from "react";
import ReactECharts from "echarts-for-react";
import { getClusterTimeseries, type ClusterTimeseries } from "../api";
import { useModules } from "../modules";

export default function ModulesOverTime({ datasetId, label = null, colorOf, order, onFront, onHold,
                                          testId = "cluster-timeseries" }: {
  datasetId: string;
  label?: number | null;
  colorOf?: (label: number) => string | undefined;
  order?: number[];
  onFront?: (label: number | null) => void;
  onHold?: (label: number) => void;
  testId?: string;
}) {
  const modules = useModules();
  const [ts, setTs] = useState<ClusterTimeseries | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showOutside, setShowOutside] = useState(false);
  useEffect(() => {
    let dead = false;
    setTs(null); setErr(null);
    getClusterTimeseries(datasetId)
      .then((t) => { if (!dead) setTs(t); })
      .catch((e) => { if (!dead) setErr(String(e)); });
    return () => { dead = true; };
  }, [datasetId]);

  const option = useMemo(() => {
    if (!ts) return null;
    const dated = ts.time_axis === "dates";
    const xs = ts.samples.map((s, i) => (dated && s.date ? s.date : String(i + 1)));
    const yearMarks: { xAxis: number; name: string }[] = [];
    if (dated) {
      let prev = "";
      ts.samples.forEach((s, i) => {
        const y = (s.date ?? "").slice(0, 4);
        if (y && y !== prev) { if (prev) yearMarks.push({ xAxis: i, name: y }); prev = y; }
      });
    }
    const colour = (l: number) => colorOf?.(l) ?? modules.color(l);
    const vorn = label != null && ts.clusters.includes(label);
    const base = (order ?? []).filter((l) => ts.clusters.includes(l))
      .concat(ts.clusters.filter((l) => !(order ?? []).includes(l)));
    const stackOrder = vorn ? [label as number, ...base.filter((l) => l !== label)] : base;
    const markLine = yearMarks.length ? {
      silent: true, symbol: "none",
      lineStyle: { color: "#94a3b8", type: "dashed" as const, opacity: 0.5 },
      label: { formatter: (p: { data: { name: string } }) => p.data.name, color: "#94a3b8", fontSize: 10, position: "insideEndTop" as const },
      data: yearMarks,
    } : undefined;
    const series = [
      ...stackOrder.map((l, i) => ({
        name: modules.label(l), type: "line" as const, stack: "modules", smooth: false,
        showSymbol: false, symbol: "none",
        data: ts.samples.map((s) => s.values[String(l)] ?? 0),
        lineStyle: { width: !vorn || l === label ? 1.5 : 0.5, color: colour(l),
                     opacity: !vorn || l === label ? 1 : 0.5 },
        areaStyle: { color: colour(l), opacity: !vorn ? 0.75 : l === label ? 0.9 : 0.25 },
        emphasis: { focus: "series" as const },
        ...(i === 0 && markLine ? { markLine } : {}),
      })),
      ...(showOutside ? [{
        name: "outside the network", type: "line" as const, stack: "modules", showSymbol: false, symbol: "none",
        data: ts.samples.map((s) => s.outside),
        lineStyle: { width: 0.5, color: "#64748b", opacity: 0.6 },
        areaStyle: { color: "#64748b", opacity: 0.15 },
      }] : []),
    ];
    return {
      backgroundColor: "transparent",
      grid: { left: 52, right: 12, top: 18, bottom: 28 },
      tooltip: { trigger: "axis" as const,
        formatter: (ps: any[]) => {
          const i = ps[0]?.dataIndex ?? 0;
          const smp = ts.samples[i];
          const rows = ps.filter((p) => Number(p.value) > 0)
            .map((p) => `${p.marker} ${p.seriesName}: ${Number(p.value).toPrecision(4)}`);
          return `${smp?.sample ?? ""}<br/>${rows.join("<br/>")}`
            + `<br/><span style="opacity:.7">sample total ${Number(smp?.sample_total ?? 0).toPrecision(4)}</span>`;
        } },
      xAxis: { type: "category" as const, data: xs, boundaryGap: false,
        axisLine: { lineStyle: { color: "#334155" } },
        axisLabel: { color: "#94a3b8", fontSize: 10, formatter: (v: string) => (dated ? v.slice(0, 7) : v) } },
      yAxis: { type: "value" as const,
        axisLabel: { color: "#94a3b8", fontSize: 10, formatter: (v: number) => v.toPrecision(2) },
        splitLine: { lineStyle: { color: "#1e293b" } } },
      series,
    };
  }, [ts, label, colorOf, modules, order, showOutside]);

  const chips = ts ? (order ?? []).filter((l) => ts.clusters.includes(l))
    .concat(ts.clusters.filter((l) => !(order ?? []).includes(l))) : [];

  return (
    <div data-testid={testId}
      data-n-series={ts ? ts.clusters.length + (showOutside ? 1 : 0) : 0} data-highlight={label ?? ""}
      data-unit={ts?.value_declaration.unit ?? ""} data-outside={showOutside ? "1" : "0"}>
      <h3 className="text-slate-300 font-medium flex items-center">
        All modules over time
      </h3>
      {err && <p className="text-xs text-red-300">{err}</p>}
      {!ts && !err && <p className="text-xs text-slate-500">loading …</p>}
      {ts && option && <ReactECharts option={option} style={{ height: 210 }} notMerge />}
      {ts && (
        <div className="flex flex-wrap items-center gap-1 text-xs" data-testid={`${testId}-chips`}
          onMouseLeave={() => onFront?.(null)}>
          {chips.map((l) => (
            <button key={l} data-testid={`${testId}-chip`} data-module={l}
              onMouseEnter={() => onFront?.(l)} onClick={() => onHold?.(l)}
              className={`flex items-center gap-1.5 px-2 py-0.5 rounded border ${label === l
                ? "border-slate-400 text-slate-100 bg-slate-800"
                : "border-slate-700 text-slate-300 hover:border-slate-500"}`}>
              <span className="inline-block w-3 h-3 rounded-sm shrink-0"
                    style={{ background: colorOf?.(l) ?? modules.color(l) }} />
              {modules.label(l)}
            </button>
          ))}
          <button data-testid={`${testId}-outside`} onClick={() => setShowOutside((v) => !v)}
            aria-pressed={showOutside}
            className={`ml-auto flex items-center gap-1.5 px-2 py-0.5 rounded border ${showOutside
              ? "border-slate-400 text-slate-100 bg-slate-800"
              : "border-slate-700 text-slate-400 hover:border-slate-500"}`}>
            <span className="inline-block w-3 h-3 rounded-sm shrink-0" style={{ background: "#64748b" }} />
            + outside the network
          </button>
        </div>
      )}
      {ts && (
        <p className="text-[10px] text-slate-500" data-testid={`${testId}-note`}>
          Sums of stored values ({ts.value_declaration.unit}) per module and sample
          {ts.time_axis === "dates" ? " · dashed lines: turn of the year" : " · sample order only, no dates"}
        </p>
      )}
    </div>
  );
}

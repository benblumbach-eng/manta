import { useEffect, useState } from "react";
import ReactECharts from "echarts-for-react";
import { getEnvironment, type Environment, type EnvVariable } from "../api";
import InfoTip from "./InfoTip";
import ProvenanceFooter from "./ProvenanceFooter";

export default function EnvironmentPanel({ datasetId, onClose }: {
  datasetId: string; onClose: () => void;
}) {
  const [e, setE] = useState<Environment | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setE(null); setErr(null);
    getEnvironment(datasetId).then(setE).catch((x) => setErr(String(x)));
  }, [datasetId]);

  return (
    <div className="h-full overflow-auto"
      data-testid="environment-panel">
      <div className="flex items-center justify-between px-4 py-2 border-b border-slate-700 sticky top-0 bg-slate-900 z-10">
        <span className="flex items-center text-slate-100 font-medium">
          Environment over time
          {e && (
            <InfoTip title="Where these values come from">
              <p data-testid="environment-provenance">{e.provenance}</p>
              <p data-testid="environment-units-note">{e.units_note}</p>
            </InfoTip>
          )}
        </span>
        <button onClick={onClose} data-testid="environment-close" aria-label="Close"
          className="text-slate-400 hover:text-white">✕</button>
      </div>

      {err && <div className="p-4 text-red-300" data-testid="error">{err}</div>}
      {!e && !err && <div className="p-4 text-slate-500">loading …</div>}

      {e && (
        <div className="p-4 space-y-4 text-sm">
          <p className="text-xs text-slate-300" data-testid="environment-declaration">
            Measured, not derived from the sequences.
          </p>

          {e.variables.length === 0 ? (
            <div data-testid="environment-none" className="rounded border border-amber-500/40 bg-amber-500/5 p-3">
              <div className="text-amber-300 font-medium">No environmental data for this dataset</div>
              <p className="mt-1 text-xs text-slate-300">{e.absent_reason}</p>
            </div>
          ) : (
            <>
              {e.variables.map((v) => <VariableChart key={v.key} v={v} dated={e.time_axis === "dates"} />)}
            </>
          )}

          {e.absent.length > 0 && e.variables.length > 0 && (
            <div className="text-xs text-slate-500" data-testid="environment-absent">
              Not supplied with this dataset: {e.absent.map((a) => a.label).join(", ")}.
            </div>
          )}
          <ProvenanceFooter datasetId={datasetId} />
        </div>
      )}
    </div>
  );
}

function VariableChart({ v, dated }: { v: EnvVariable; dated: boolean }) {
  const missing = v.total - v.n;
  const option = {
    backgroundColor: "transparent",
    grid: { left: 52, right: 12, top: 10, bottom: 20 },
    tooltip: {
      trigger: "axis" as const,
      formatter: (ps: { data: [string, number | null] }[]) => {
        const p = ps[0];
        if (!p) return "";
        return `<b>${dated ? p.data[0] : `Sample ${p.data[0]}`}</b><br/>`
          + (p.data[1] == null ? "not measured" : `${p.data[1].toFixed(3)}${v.unit ? ` ${v.unit}` : ""}`);
      },
    },
    xAxis: dated
      ? { type: "time" as const, axisLabel: { color: "#94a3b8", fontSize: 9 } }
      : { type: "category" as const, data: v.points.map((_, i) => String(i + 1)),
          axisLabel: { color: "#94a3b8", fontSize: 9,
                       interval: Math.max(0, Math.floor(v.points.length / 10) - 1) } },
    yAxis: {
      type: "value" as const, scale: true,
      axisLabel: { color: "#94a3b8", fontSize: 9 },
      splitLine: { lineStyle: { color: "#1e293b" } },
    },
    series: [{
      name: v.label, type: "line" as const, showSymbol: true, symbolSize: 3,
      connectNulls: false,
      data: v.points.map((p, i) => [dated ? p.date : String(i + 1), p.value] as [string, number | null]),
      lineStyle: { color: "#34d399", width: 1.5 }, itemStyle: { color: "#34d399" },
    }],
  };

  return (
    <div data-testid={`env-var-${v.key}`}>
      <div className="flex items-baseline justify-between">
        <span className="text-slate-200">
          {v.label}
          {v.unit && <span className="text-slate-400"> ({v.unit})</span>}
          {v.unit_note && (
            <span className="text-amber-400" data-testid={`env-unit-note-${v.key}`}>
              {" "}!
              <InfoTip title="The published unit does not match these values">
                <p>{v.unit_note}</p>
                <p>Column <span className="font-mono">{v.source_column}</span> in{" "}
                <span className="font-mono">environment_info.csv</span>.</p>
              </InfoTip>
            </span>
          )}
        </span>
        <span className="text-[10px] text-slate-500 tabular-nums" data-testid={`env-coverage-${v.key}`}>
          {v.n} of {v.total} samples
        </span>
      </div>
      <div className="text-[10px] text-slate-500 tabular-nums">
        {v.min.toFixed(2)} … {v.max.toFixed(2)}
        {v.unit ? ` ${v.unit}` : ""} · mean {v.mean.toFixed(2)}
        {missing > 0 && (
          <span className="text-amber-400/80" data-testid={`env-gap-${v.key}`}>
            {" "}· {missing} sample{missing === 1 ? "" : "s"} without a value, drawn as a gap
          </span>
        )}
      </div>
      <ReactECharts option={option} style={{ height: 100 }} notMerge />
    </div>
  );
}

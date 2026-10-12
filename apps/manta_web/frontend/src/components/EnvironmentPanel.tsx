import { StateNotice } from "./ui";
import { useEffect, useState } from "react";
import ReactECharts from "echarts-for-react";
import { getEnvironment, type Environment, type EnvVariable } from "../api";
import InfoTip from "./InfoTip";
import { PanelHeader } from "./PanelFrame";
import { esc } from "../format";
import ProvenanceFooter from "./ProvenanceFooter";
import ErrorNotice from "./ErrorNotice";
import { chartTooltip, FONT, useTokens } from "../design/tokens";
import { envColour } from "../design/dataColours";

export default function EnvironmentPanel({ datasetId, onClose, focus }: {
  datasetId: string; onClose: () => void;
  focus?: string;
}) {
  const [e, setE] = useState<Environment | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [nochmal, setNochmal] = useState(0);

  useEffect(() => {
    if (!e || !focus) return;
    const el = document.querySelector(`[data-testid="env-var-${focus}"]`) as HTMLElement | null;
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    el.classList.add("ring-1", "ring-ok", "rounded");
    const t = setTimeout(() => el.classList.remove("ring-1", "ring-ok", "rounded"), 2500);
    return () => clearTimeout(t);
  }, [e, focus]);
  useEffect(() => {
    setE(null); setErr(null);
    getEnvironment(datasetId).then(setE).catch((x) => setErr(x));
  }, [datasetId, nochmal]);

  return (
    <div data-testid="environment-panel">
      <PanelHeader title="Environment over time" onClose={onClose} closeTestid="environment-close">
        {e && (
          <InfoTip title="Where these values come from">
            <p data-testid="environment-provenance">{e.provenance}</p>
            <p data-testid="environment-units-note">{e.units_note}</p>
          </InfoTip>
        )}
      </PanelHeader>

      {err != null && <ErrorNotice error={err} what="Could not load the environment."
        onRetry={() => setNochmal((n) => n + 1)} />}
      {!e && err == null && <StateNotice state="loading">loading …</StateNotice>}

      {e && (
        <div className="p-4 space-y-4 text-sm">
          <p className="text-xs text-fg" data-testid="environment-declaration">
            Measured, not derived from the sequences.
          </p>

          {e.variables.length === 0 ? (
            <div data-testid="environment-none" className="rounded border border-warn bg-warn-soft p-3">
              <div className="text-warn font-medium">No environmental data for this dataset</div>
              <p className="mt-1 text-xs text-fg">{e.absent_reason}</p>
            </div>
          ) : (
            <>
              {e.variables.map((v) => <VariableChart key={v.key} v={v} dated={e.time_axis === "dates"} />)}
            </>
          )}

          {e.absent.length > 0 && e.variables.length > 0 && (
            <div className="text-xs text-fg-muted" data-testid="environment-absent">
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
  const tok = useTokens();
  const achse = { color: tok.textMuted, fontSize: FONT.xs2 };
  const ENV = envColour(tok.light);
  const option = {
    backgroundColor: "transparent",
    grid: { left: 52, right: 12, top: 10, bottom: 20 },
    tooltip: {
      ...chartTooltip(tok),
      trigger: "axis" as const,
      formatter: (ps: { data: [string, number | null] }[]) => {
        const p = ps[0];
        if (!p) return "";
        return `<b>${esc(dated ? p.data[0] : `Sample ${p.data[0]}`)}</b><br/>`
          + (p.data[1] == null ? "not measured" : `${p.data[1].toFixed(3)}${v.unit ? ` ${esc(v.unit)}` : ""}`);
      },
    },
    xAxis: dated
      ? { type: "time" as const, axisLabel: achse }
      : { type: "category" as const, data: v.points.map((_, i) => String(i + 1)),
          axisLabel: { ...achse, interval: Math.max(0, Math.floor(v.points.length / 10) - 1) } },
    yAxis: {
      type: "value" as const, scale: true,
      axisLabel: achse,
      splitLine: { lineStyle: { color: tok.chartGrid } },
    },
    series: [{
      name: v.label, type: "line" as const, showSymbol: true, symbolSize: 3,
      connectNulls: false,
      data: v.points.map((p, i) => [dated ? p.date : String(i + 1), p.value] as [string, number | null]),
      lineStyle: { color: ENV, width: 1.5 }, itemStyle: { color: ENV },
    }],
  };

  return (
    <div data-testid={`env-var-${v.key}`}>
      <div className="flex items-baseline justify-between">
        <span className="text-fg">
          {v.label}
          {v.unit && <span className="text-fg-muted"> ({v.unit})</span>}
          {v.unit_note && (
            <span className="text-warn" data-testid={`env-unit-note-${v.key}`}>
              {" "}!
              <InfoTip title="The published unit does not match these values">
                <p>{v.unit_note}</p>
                <p>Column <span className="font-mono">{v.source_column}</span> in{" "}
                <span className="font-mono">environment_info.csv</span>.</p>
              </InfoTip>
            </span>
          )}
        </span>
        <span className="text-2xs text-fg-muted tabular-nums" data-testid={`env-coverage-${v.key}`}>
          {v.n} of {v.total} samples
        </span>
      </div>
      <div className="text-2xs text-fg-muted tabular-nums">
        {v.min.toFixed(2)} … {v.max.toFixed(2)}
        {v.unit ? ` ${v.unit}` : ""} · mean {v.mean.toFixed(2)}
        {missing > 0 && (
          <span className="text-warn" data-testid={`env-gap-${v.key}`}>
            {" "}· {missing} sample{missing === 1 ? "" : "s"} without a value, drawn as a gap
          </span>
        )}
      </div>
      <ReactECharts option={option} style={{ height: 100 }} notMerge />
    </div>
  );
}

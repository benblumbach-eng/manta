import { useEffect, useState } from "react";
import { getTaxon, type TaxonDetail } from "../api";
import InfoTip from "./InfoTip";
import ProvenanceFooter from "./ProvenanceFooter";
import { useModules } from "../modules";

export default function TaxonPanel({ datasetId, asvId, onClose, onOpenAsv }: {
  datasetId: string;
  asvId: string;
  onClose: () => void;
  onOpenAsv: (id: string) => void;
}) {
  const [d, setD] = useState<TaxonDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const modules = useModules();

  useEffect(() => {
    setD(null); setErr(null);
    getTaxon(datasetId, asvId).then(setD).catch((e) => setErr(String(e.message ?? e)));
  }, [datasetId, asvId]);

  const reihe = d?.series ?? [];
  const werte = reihe.map((r) => (d?.series_absent_reason ? r.n_members_present : (r.share ?? 0)));
  const max = Math.max(...werte, 1e-12);

  return (
    <div className="h-full overflow-auto"
      data-testid="taxon-panel">
      <div className="flex items-center justify-between px-4 py-2 border-b border-slate-700 sticky top-0 bg-slate-900 z-10">
        <span className="flex items-center text-sm text-slate-100 font-medium">
          <span data-testid="taxon-label">{d?.label ?? "…"}</span>
          {d && <span className="ml-2 text-xs text-slate-500" data-testid="taxon-n">
            {d.n_asv} ASV{d.n_asv === 1 ? "" : "s"}
          </span>}
          {d && (
            <InfoTip title="What this page adds up">
              <p>{d.note}</p>
              <p>Grouped by the full taxonomy across all seven ranks; a placeholder in any rank
              keeps an ASV out of the group. Grouping happens in this view, never in the graph.</p>
              <p>{d.value_declaration.value_kind} · {d.value_declaration.frame}</p>
            </InfoTip>
          )}
        </span>
        <button onClick={onClose} data-testid="taxon-close" aria-label="Close"
          className="text-slate-400 hover:text-white">✕</button>
      </div>

      {err && <div className="p-4 text-red-300" data-testid="error">{err}</div>}
      {!d && !err && <div className="p-4 text-slate-500">loading …</div>}

      {d && !d.groupable && (
        <p className="p-4 text-sm text-amber-400" data-testid="taxon-not-groupable">{d.reason}</p>
      )}

      {d && d.groupable && (
        <div className="p-4 space-y-4 text-sm">
          <div className="text-[11px] text-slate-500" data-testid="taxon-path">
            {["kingdom", "phylum", "class", "order", "family", "genus", "species"]
              .map((r) => d.path[r]).filter(Boolean).join(" › ")}
          </div>

          <section data-testid="taxon-series">
            {d.series_absent_reason ? (
              <p className="text-xs text-amber-400" data-testid="taxon-series-absent">
                {d.series_absent_reason}
              </p>
            ) : (
              <div className="text-[10px] uppercase tracking-wide text-slate-500">
                Summed share per sample
              </div>
            )}
            <svg width="460" height="90" role="img" className="mt-1"
              aria-label="the summed series of this taxon">
              {reihe.map((r, i) => {
                const h = (werte[i] / max) * 74;
                const x = reihe.length > 1 ? (i / (reihe.length - 1)) * 452 : 0;
                return <rect key={r.sample} x={x} y={80 - h} width={Math.max(1, 452 / Math.max(1, reihe.length) - 1)}
                  height={Math.max(0, h)} fill={d.series_absent_reason ? "#94a3b8" : "#22d3ee"} />;
              })}
            </svg>
            <div className="text-[10px] text-slate-500">
              {d.series_absent_reason
                ? "members with a detection per sample"
                : `${(100 * max).toFixed(2)} % at the largest sample`}
              {d.time_axis !== "dates" && " · sample order only — no sampling dates"}
            </div>
          </section>

          <section>
            <div className="text-[10px] uppercase tracking-wide text-slate-500 mb-1">Members</div>
            <div className="space-y-1" data-testid="taxon-members">
              {d.members.map((m) => (
                <div key={m.id} className="flex items-baseline gap-2 rounded hover:bg-slate-800 px-1">
                  <button data-testid="taxon-member" onClick={() => onOpenAsv(m.id)}
                    className="font-mono text-cyan-300 hover:underline">{m.id}</button>
                  <span className="text-xs text-slate-400">{modules.label(m.cluster)}</span>
                  <span className="ml-auto text-xs text-slate-500 tabular-nums">
                    {m.n_samples_present} samples
                  </span>
                </div>
              ))}
            </div>
          </section>
          <ProvenanceFooter datasetId={datasetId} />
        </div>
      )}
    </div>
  );
}

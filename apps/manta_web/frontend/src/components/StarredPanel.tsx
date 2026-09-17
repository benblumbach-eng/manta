import { useModules } from "../modules";
import { useEffect, useState } from "react";
import { getStarred, type Starred } from "../api";

export default function StarredPanel(
  { datasetId, onOpenAsv, onOpenCluster, onClose }:
  { datasetId: string; onOpenAsv: (id: string) => void;
    onOpenCluster: (label: number) => void; onClose: () => void },
) {
  const modules = useModules();
  const [d, setD] = useState<Starred | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setD(null); setErr(null);
    getStarred(datasetId).then(setD).catch((e) => setErr(String(e.message ?? e)));
  }, [datasetId]);

  const zeit = (s: string | null) => (s ? s.replace("T", " ").slice(0, 16) : "");

  return (
    <aside data-testid="starred-panel"
           className="h-full overflow-y-auto">
      <div className="flex items-center justify-between px-4 py-2 border-b border-slate-700">
        <h2 className="text-slate-100 font-medium">Starred</h2>
        <button data-testid="starred-close" onClick={onClose}
                className="text-sm text-slate-400 hover:text-cyan-300">close</button>
      </div>

      {err && <p className="p-4 text-sm text-red-400">{err}</p>}
      {!d && !err && <p className="p-4 text-sm text-slate-500">loading …</p>}

      {d && d.n === 0 && (
        <p data-testid="starred-empty" className="p-4 text-sm text-slate-400">
          {d.note ?? "Nothing starred yet — the star sits in the ASV page and the cluster panel."}
        </p>
      )}

      {d && d.asvs.length > 0 && (
        <section className="p-4">
          <h3 className="text-[11px] uppercase tracking-wide text-slate-500 mb-2">
            ASVs ({d.asvs.length})
          </h3>
          <ul className="space-y-1">
            {d.asvs.map((a) => (
              <li key={a.id}>
                <button data-testid="starred-asv" onClick={() => onOpenAsv(a.id)}
                        className="w-full text-left px-2 py-1.5 rounded hover:bg-slate-800">
                  <span className="text-slate-100">{a.genus ?? a.id}</span>
                  <span className="text-xs text-slate-400 ml-2">
                    {a.genus ? a.id : ""}{a.cluster !== null ? ` · cluster ${a.cluster}` : ""}
                  </span>
                  <span className="block text-[11px] text-slate-600">{zeit(a.at)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {d && d.clusters.length > 0 && (
        <section className="p-4 border-t border-slate-800">
          <h3 className="text-[11px] uppercase tracking-wide text-slate-500 mb-2">
            Clusters ({d.clusters.length})
          </h3>
          <ul className="space-y-1">
            {d.clusters.map((c) => (
              <li key={c.louvain_label}>
                <button data-testid="starred-cluster" onClick={() => onOpenCluster(c.louvain_label)}
                        className="w-full text-left px-2 py-1.5 rounded hover:bg-slate-800">
                  <span className="text-slate-100">{modules.label(c.louvain_label)}</span>
                  <span className="block text-[11px] text-slate-600">{zeit(c.at)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </aside>
  );
}

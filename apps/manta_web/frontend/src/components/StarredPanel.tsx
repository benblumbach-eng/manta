import { StateNotice, SectionHeading } from "./ui";
import { useModules } from "../modules";
import { useEffect, useState } from "react";
import { getStarred, type Starred } from "../api";
import ErrorNotice from "./ErrorNotice";
import { PanelHeader } from "./PanelFrame";

export default function StarredPanel(
  { datasetId, onOpenAsv, onOpenCluster, onClose }:
  { datasetId: string; onOpenAsv: (id: string) => void;
    onOpenCluster: (label: number) => void; onClose: () => void },
) {
  const modules = useModules();
  const [d, setD] = useState<Starred | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [nochmal, setNochmal] = useState(0);

  useEffect(() => {
    setD(null); setErr(null);
    getStarred(datasetId).then(setD).catch((e) => setErr(e));
  }, [datasetId, nochmal]);

  const zeit = (s: string | null) => (s ? s.replace("T", " ").slice(0, 16) : "");

  return (
    <aside data-testid="starred-panel">
      <PanelHeader title="Starred" onClose={onClose} closeTestid="starred-close" />

      {err != null && <ErrorNotice error={err} what="Could not load the starred list."
        onRetry={() => setNochmal((n) => n + 1)} />}
      {!d && err == null && <StateNotice state="loading">loading …</StateNotice>}

      {d && d.n === 0 && (
        <StateNotice state="empty" testid="starred-empty">
          {d.note ?? "Nothing starred yet — the star sits in the ASV page and the cluster panel."}
        </StateNotice>
      )}

      {d && d.asvs.length > 0 && (
        <section className="p-4">
          <SectionHeading className="mb-2">
            ASVs ({d.asvs.length})
          </SectionHeading>
          <ul className="space-y-1">
            {d.asvs.map((a) => (
              <li key={a.id}>
                <button data-testid="starred-asv" onClick={() => onOpenAsv(a.id)}
                        className="w-full text-left px-2 py-2 rounded hover:bg-control">
                  <span className="text-fg">{a.genus ?? a.id}</span>
                  <span className="text-xs text-fg-muted ml-2">
                    {a.genus ? a.id : ""}{a.cluster !== null ? ` · ${modules.label(a.cluster)}` : ""}
                  </span>
                  <span className="block text-2xs text-fg-muted">{zeit(a.at)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {d && d.clusters.length > 0 && (
        <section className="p-4 border-t border-line-subtle">
          <SectionHeading className="mb-2">
            Clusters ({d.clusters.length})
          </SectionHeading>
          <ul className="space-y-1">
            {d.clusters.map((c) => (
              <li key={c.louvain_label}>
                <button data-testid="starred-cluster" onClick={() => onOpenCluster(c.louvain_label)}
                        className="w-full text-left px-2 py-2 rounded hover:bg-control">
                  <span className="text-fg">{modules.label(c.louvain_label)}</span>
                  <span className="block text-2xs text-fg-muted">{zeit(c.at)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </aside>
  );
}

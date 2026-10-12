import { StateNotice, SectionHeading } from "./ui";
import { useEffect, useState } from "react";
import { getTaxon, type TaxonDetail } from "../api";
import InfoTip from "./InfoTip";
import ProvenanceFooter from "./ProvenanceFooter";
import ErrorNotice from "./ErrorNotice";
import { PanelHeader } from "./PanelFrame";
import { useModules } from "../modules";

export default function TaxonPanel({ datasetId, asvId, onClose, onOpenAsv }: {
  datasetId: string;
  asvId: string;
  onClose: () => void;
  onOpenAsv: (id: string) => void;
}) {
  const [d, setD] = useState<TaxonDetail | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [nochmal, setNochmal] = useState(0);
  const modules = useModules();

  useEffect(() => {
    setD(null); setErr(null);
    let alive = true;
    getTaxon(datasetId, asvId).then((x) => { if (alive) setD(x); })
      .catch((e) => { if (alive) setErr(e); });
    return () => { alive = false; };
  }, [datasetId, asvId, nochmal]);

  return (
    <div data-testid="taxon-panel">
      <PanelHeader onClose={onClose} closeTestid="taxon-close"
        title={<span data-testid="taxon-label">{d?.label ?? "…"}</span>}>
          {d && <span className="shrink-0 text-xs text-fg-muted" data-testid="taxon-n">
            {d.n_asv} ASV{d.n_asv === 1 ? "" : "s"}
          </span>}
          {d && (
            <InfoTip title="What this group is">
              <p>The members are different sequence variants (ASVs) that carry the same
              name at all seven ranks. The name only says which reference entry is closest —
              it does not make them one organism.</p>
              <p>A placeholder in any rank keeps an ASV out of the group. Grouping happens in
              this view, never in the graph.</p>
            </InfoTip>
          )}
      </PanelHeader>

      {err != null && <ErrorNotice error={err} what="Could not load this taxon."
        onRetry={() => setNochmal((n) => n + 1)} />}
      {!d && err == null && <StateNotice state="loading">loading …</StateNotice>}

      {d && !d.groupable && (
        <p className="p-4 text-sm text-warn" data-testid="taxon-not-groupable">{d.reason}</p>
      )}

      {d && d.groupable && (
        <div className="p-4 space-y-4 text-sm">
          <div className="text-2xs text-fg-muted" data-testid="taxon-path">
            {["kingdom", "phylum", "class", "order", "family", "genus", "species"]
              .map((r) => d.path[r]).filter(Boolean).join(" › ")}
          </div>

          <section>
            <SectionHeading as="div" className="mb-1">Members</SectionHeading>
            <div className="space-y-1" data-testid="taxon-members">
              {d.members.map((m) => (
                <div key={m.id} className="flex items-baseline gap-2 rounded hover:bg-control px-1">
                  <button data-testid="taxon-member" onClick={() => onOpenAsv(m.id)}
                    className="font-mono text-accent hover:underline">{m.id}</button>
                  <span className="text-xs text-fg-muted">{modules.label(m.cluster)}</span>
                  <span className="ml-auto text-xs text-fg-muted tabular-nums">
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

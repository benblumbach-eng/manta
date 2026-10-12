import { Button, StateNotice } from "./ui";
import { useEffect, useRef, useState } from "react";
import { getAsv, getEnvironment, getTaxon, setAsvNote, setAsvStar,
         type AsvDetail, type Environment } from "../api";
import type { EdgeRef } from "../App";
import { useModules } from "../modules";
import ProvenanceFooter from "./ProvenanceFooter";
import FrequencyPanel from "./FrequencyPanel";
import EnvironmentBars from "./EnvironmentBars";
import NeighbourNet from "./NeighbourNet";
import NoteBox from "./NoteBox";
import ErrorNotice from "./ErrorNotice";
import { findCap } from "./DataAvailability";
import StarButton from "./StarButton";
import { PanelHeader } from "./PanelFrame";
import { HubAsvDetails, HubInfoButton, HubMark } from "./Criterion2";

const RANKS: [string, string][] = [
  ["kingdom", "Kingdom"], ["phylum", "Phylum"], ["class", "Class"], ["order", "Order"],
  ["family", "Family"], ["genus", "Genus"], ["species", "Species"],
];
const PLACEHOLDERS = new Set(["unassigned", "NA", "", "Environment_Condition", "uncultured"]);
const named = (v: string | null | undefined) => (v && !PLACEHOLDERS.has(v) ? v : null);

export default function AsvDrawer({ datasetId, asvId, onClose, onOpenAsv, onOpenEdge,
                                    onCompare, onOpenTaxon, onOpenCluster, signedIn = true }: {
  datasetId: string;
  asvId: string;
  onClose: () => void;
  onOpenAsv: (id: string) => void;
  onOpenEdge: (e: EdgeRef) => void;
  onCompare?: (id: string) => void;
  onOpenTaxon?: (id: string) => void;
  onOpenCluster?: (label: number) => void;
  signedIn?: boolean;
}) {
  const modules = useModules();
  const [d, setD] = useState<AsvDetail | null>(null);
  const [taxonN, setTaxonN] = useState<number | null>(null);
  const sternSchreib = useRef<{ asv: string; t: number; wert: boolean } | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [nochmal, setNochmal] = useState(0);
  const [env, setEnv] = useState<Environment | null>(null);
  const [showSeq, setShowSeq] = useState(false);
  const [hubInfo, setHubInfo] = useState(false);
  useEffect(() => { setHubInfo(false); }, [asvId]);

  useEffect(() => {
    setD(null); setErr(null);
    setShowSeq(false);
    const losgeschickt = performance.now();
    let alive = true;
    getAsv(datasetId, asvId).then((frisch) => {
      if (!alive) return;
      const w = sternSchreib.current;
      setD(w && w.asv === asvId && w.t > losgeschickt ? { ...frisch, starred: w.wert } : frisch);
    }).catch((e) => { if (alive) setErr(e); });
    setTaxonN(null);
    getTaxon(datasetId, asvId)
      .then((t) => { if (alive) setTaxonN(t.groupable ? t.n_asv : null); })
      .catch(() => { if (alive) setTaxonN(null); });
    return () => { alive = false; };
  }, [datasetId, asvId, nochmal]);

  useEffect(() => {
    setEnv(null);
    getEnvironment(datasetId).then(setEnv).catch(() => setEnv(null));
  }, [datasetId]);

  const blastUrl = d?.sequence
    ? `https://blast.ncbi.nlm.nih.gov/Blast.cgi?PAGE_TYPE=BlastSearch&PROGRAM=blastn&DATABASE=nt&MEGABLAST=on&QUERY=${encodeURIComponent(d.sequence)}`
    : null;

  const caps = d?.capabilities;

  return (
    <div data-testid="asv-drawer">
      <PanelHeader onClose={onClose} closeTestid="drawer-close"
        lead={d && signedIn ? (
          <StarButton starred={d.starred} testid="asv-star" label={asvId}
            onToggle={(next) => {
              const id = asvId;
              sternSchreib.current = { asv: id, t: performance.now(), wert: next };
              return setAsvStar(datasetId, id, next).then((r) => {
                sternSchreib.current = { asv: id, t: performance.now(), wert: r.starred };
                setD((cur) => (cur && cur.id === id ? { ...cur, starred: r.starred } : cur));
              });
            }} />
        ) : undefined}
        title={<span className="font-mono font-normal text-accent select-text cursor-text"
          data-no-drag="" data-testid="drawer-asv-id">{asvId}</span>}>
        {d?.criterion2?.passes && (
          <>
            <HubMark />
            <HubInfoButton open={hubInfo} onToggle={() => setHubInfo((v) => !v)}
              testid="drawer-hub-info" label="what a hub is" />
          </>
        )}
      </PanelHeader>

      {err != null && <ErrorNotice error={err} what="Could not load this ASV."
        onRetry={() => setNochmal((n) => n + 1)} />}
      {!d && err == null && <StateNotice state="loading">loading …</StateNotice>}

      {d && caps && (
        <div className="p-6 space-y-6 text-sm">
          {hubInfo && d.criterion2?.passes && (
            <HubAsvDetails c2={d.criterion2} testid="drawer-hub-details"
              moduleLabel={d.criterion2.module != null ? modules.label(d.criterion2.module) : null} />
          )}
          <section>
            <div className="text-xl text-fg" data-testid="drawer-genus">
              {named(d.lineage.genus) ?? <span className="text-fg-muted">no genus assigned</span>}
            </div>
            <div className="text-xs text-fg-muted">
              {d.cluster == null ? "no module"
                : onOpenCluster ? (
                  <button data-testid="asv-open-cluster" onClick={() => onOpenCluster(d.cluster!)}
                    className="text-accent hover:underline">{modules.label(d.cluster)} ↗</button>
                ) : modules.label(d.cluster)} · dataset {d.dataset_id}
            </div>
            <div className="text-xs text-fg-muted tabular-nums" data-testid="asv-presence"
                 data-n={d.frequency.summary.n_detected} data-total={d.frequency.summary.n_samples}>
              found in {d.frequency.summary.n_detected} of {d.frequency.summary.n_samples} samples
            </div>
            {taxonN != null && taxonN > 1 && onOpenTaxon && (
              <button data-testid="same-taxon" onClick={() => onOpenTaxon(asvId)}
                className="mt-1 text-xs text-accent hover:underline">
                same taxon · {taxonN} ASVs → open taxon
              </button>
            )}
            {(() => {
              const limits: React.ReactNode[] = [];
              if (!d.sequence && findCap(caps, "sequence")?.available) {
                limits.push(<span key="seq">no sequence</span>);
              }
              if (d.cluster == null) {
                limits.push(
                  <span key="net" className="inline-flex items-center" data-testid="asv-not-in-run"
                    title="This ASV has no link in the network. Its time series and taxonomy are complete.">
                    not in the network
                  </span>);
              }
              return limits.length > 0 ? (
                <div className="mt-1 text-xs text-warn flex items-center gap-1"
                  data-testid="asv-limitations">
                  {limits.map((l, i) => [i > 0 && <span key={`s${i}`} className="text-fg-muted" aria-hidden>·</span>, l])}
                </div>
              ) : null;
            })()}
          </section>

          <section data-testid="taxonomy-section">
            <h3 className="text-fg font-medium mb-1 flex items-center">Taxonomy</h3>
            <table className="text-xs text-fg">
              <tbody>
                {RANKS.map(([k, label]) => (
                  <tr key={k}>
                    <td className="text-fg-muted pr-3 align-top">{label}</td>
                    <td data-testid={`rank-${k}`}>
                      {named(d.lineage[k])
                        ?? <span className="text-fg-muted italic">not assigned</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          {findCap(caps, "sequence")?.available && d.sequence && (
            <section data-testid="sequence-section">
              <div className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
                <h3 className="text-fg font-medium">Sequence</h3>
                <span>{d.seq_length} bp</span>
                <span className="font-mono text-fg-muted" data-testid="seq-hash">{d.seq_hash}</span>
                <Button onClick={() => navigator.clipboard?.writeText(d.sequence ?? "")}>
                  copy
                </Button>
                <a data-testid="blast-link" href={blastUrl ?? "#"} target="_blank" rel="noopener noreferrer"
                  className="px-2 py-1 rounded border border-line-strong hover:border-accent hover:text-accent">
                  BLAST ↗
                </a>
                <Button data-testid="sequence-toggle" onClick={() => setShowSeq((v) => !v)}>
                  {showSeq ? "hide" : "show"}
                </Button>
              </div>
              {showSeq && (
                <pre data-testid="sequence" className="mt-2 max-h-24 overflow-auto rounded bg-surface p-2 font-mono
                                text-2xs leading-tight text-fg-muted break-all whitespace-pre-wrap">{d.sequence}</pre>
              )}
            </section>
          )}

          <section data-testid="asv-frequency-section">
            <h3 className="text-fg font-medium mb-2 flex items-baseline gap-2"
                data-testid="asv-frequency-title">
              Relative abundance (%)
              {d.frequency.quantity.value_kind === "transformed" && (
                <span className="text-xs font-normal text-warn" data-testid="asv-frequency-transformed">
                  transformed values
                </span>
              )}
              {onCompare && (
                <Button data-testid="asv-compare" onClick={() => onCompare(asvId)} className="ml-auto">
                  Compare ↗
                </Button>
              )}
            </h3>
            <FrequencyPanel freq={d.frequency} env={env} testid="asv-frequency" />
          </section>

          {findCap(caps, "environment")?.available && (
          <section data-testid="asv-env-section">
            <h3 className="text-fg font-medium mb-1">Environment where it was found</h3>
            {d.environment_profile.items.length === 0 ? (
              <p className="text-xs text-fg-muted" data-testid="asv-env-missing">
                No measured conditions for the samples where this ASV was found.
              </p>
            ) : (
              <EnvironmentBars profile={d.environment_profile} />
            )}
          </section>
          )}

          <section>
            <h3 className="text-fg font-medium mb-1 flex items-center">Neighbours</h3>
            <p className="text-2xs text-fg-muted mb-1" data-testid="neighbours-declaration">
              CON = co-occurrence (correlation, not an interaction) · CCM = predictive value without a convergence test — no evidence of causation
            </p>
            <NeighbourNet asvId={asvId} cluster={d.cluster} neighbors={d.neighbors}
                          onOpenAsv={onOpenAsv} onOpenEdge={onOpenEdge} />
          </section>

          <NoteBox key={`${datasetId}/${asvId}`} testid="asv-note" value={d.note} savedAt={d.note_at}
            readOnly={!signedIn} draftKey={`${datasetId}/asv/${asvId}`}
            onSave={(t, o) => setAsvNote(datasetId, asvId, t, o)
              .then((r) => setD((cur) => (cur ? { ...cur, note: r.note, note_at: r.note_at } : cur)))} />

          <section data-testid="function-section" data-annotated={d.trait?.annotated ? "1" : "0"}>
            {d.trait?.annotated && (
              <div className="mb-1" data-testid="function-literature">
                <div className="text-xs font-semibold text-fg-muted">annotated function (literature)</div>
                <ul className="text-xs mt-1">
                  {d.trait.functions.map((f, i) => (
                    <li key={`${f}|${d.trait!.sources[i]}`} data-testid="function-entry" data-function={f}
                      className="flex items-baseline gap-2">
                      <span className="text-fg">{f}</span>
                      <span className="text-fg-muted">— {d.trait!.sources[i]}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="text-xs text-fg-muted italic">
              Ecological function — not derivable from amplicon data (a gene fragment, not an activity)
            </div>
          </section>
          <ProvenanceFooter datasetId={datasetId} />
        </div>
      )}
    </div>
  );
}

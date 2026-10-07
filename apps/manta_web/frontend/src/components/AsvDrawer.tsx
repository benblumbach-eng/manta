import { useEffect, useRef, useState } from "react";
import { getAsv, getEnvironment, getTaxon, setAsvNote, setAsvStar,
         type AsvDetail, type Environment } from "../api";
import type { EdgeRef } from "../App";
import InfoTip from "./InfoTip";
import { useModules } from "../modules";
import ProvenanceFooter from "./ProvenanceFooter";
import FrequencyPanel from "./FrequencyPanel";
import EnvironmentBars from "./EnvironmentBars";
import NeighbourNet from "./NeighbourNet";
import NoteBox from "./NoteBox";
import { findCap } from "./DataAvailability";
import StarButton from "./StarButton";

const RANKS: [string, string][] = [
  ["kingdom", "Kingdom"], ["phylum", "Phylum"], ["class", "Class"], ["order", "Order"],
  ["family", "Family"], ["genus", "Genus"], ["species", "Species"],
];
const PLACEHOLDERS = new Set(["unassigned", "NA", "", "Environment_Condition", "uncultured"]);
const named = (v: string | null | undefined) => (v && !PLACEHOLDERS.has(v) ? v : null);

export default function AsvDrawer({ datasetId, asvId, onClose, onOpenAsv, onOpenEdge,
                                    onCompare, onOpenTaxon, onOpenCluster }: {
  datasetId: string;
  asvId: string;
  onClose: () => void;
  onOpenAsv: (id: string) => void;
  onOpenEdge: (e: EdgeRef) => void;
  onCompare?: (id: string) => void;
  onOpenTaxon?: (id: string) => void;
  onOpenCluster?: (label: number) => void;
}) {
  const modules = useModules();
  const [d, setD] = useState<AsvDetail | null>(null);
  const [taxonN, setTaxonN] = useState<number | null>(null);
  const sternSchreib = useRef<{ t: number; wert: boolean } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [env, setEnv] = useState<Environment | null>(null);
  const [showSeq, setShowSeq] = useState(false);
  const [markSample, setMarkSample] = useState<string | null>(null);
  const kurveRef = useRef<HTMLElement | null>(null);
  const zurKurve = (sample: string) => {
    setMarkSample(sample);
    kurveRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  useEffect(() => {
    setD(null); setErr(null);
    const losgeschickt = performance.now();
    getAsv(datasetId, asvId).then((frisch) => {
      const w = sternSchreib.current;
      setD(w && w.t > losgeschickt ? { ...frisch, starred: w.wert } : frisch);
    }).catch((e) => setErr(String(e)));
    setTaxonN(null);
    getTaxon(datasetId, asvId)
      .then((t) => setTaxonN(t.groupable ? t.n_asv : null))
      .catch(() => setTaxonN(null));
  }, [datasetId, asvId]);

  useEffect(() => {
    setEnv(null);
    getEnvironment(datasetId).then(setEnv).catch(() => setEnv(null));
  }, [datasetId]);

  const blastUrl = d?.sequence
    ? `https://blast.ncbi.nlm.nih.gov/Blast.cgi?PAGE_TYPE=BlastSearch&PROGRAM=blastn&DATABASE=nt&MEGABLAST=on&QUERY=${encodeURIComponent(d.sequence)}`
    : null;

  const caps = d?.capabilities;

  return (
    <div className="h-full overflow-auto" data-testid="asv-drawer">
      <div className="flex items-center justify-between px-4 py-2 border-b border-slate-700 sticky top-0 bg-slate-900 z-10">
        <span className="flex items-center gap-1">
          {d && (
            <StarButton starred={d.starred} testid="asv-star" label={asvId}
              onToggle={(next) => {
                sternSchreib.current = { t: performance.now(), wert: next };
                return setAsvStar(datasetId, asvId, next).then((r) => {
                  sternSchreib.current = { t: performance.now(), wert: r.starred };
                  setD((cur) => (cur ? { ...cur, starred: r.starred } : cur));
                });
              }} />
          )}
          <span className="font-mono text-cyan-300" data-testid="drawer-asv-id">{asvId}</span>
          {d?.hub_glow && (
            <span data-testid="drawer-hub" title={d.hub_tooltip}
              className="text-amber-300">✦ hub</span>
          )}
        </span>
        <button onClick={onClose} data-testid="drawer-close" aria-label="Close" className="text-slate-400 hover:text-white">✕</button>
      </div>

      {err && <div className="p-4 text-red-300" data-testid="error">{err}</div>}
      {!d && !err && <div className="p-4 text-slate-500">loading …</div>}

      {d && caps && (
        <div className="p-5 space-y-5 text-sm">
          <section>
            <div className="text-xl text-slate-100" data-testid="drawer-genus">
              {named(d.lineage.genus) ?? <span className="text-slate-500">no genus assigned</span>}
            </div>
            <div className="text-xs text-slate-500">
              {d.cluster == null ? "no module"
                : onOpenCluster ? (
                  <button data-testid="asv-open-cluster" onClick={() => onOpenCluster(d.cluster!)}
                    className="text-cyan-300 hover:underline">{modules.label(d.cluster)} ↗</button>
                ) : modules.label(d.cluster)} · dataset {d.dataset_id}
            </div>
            {taxonN != null && taxonN > 1 && onOpenTaxon && (
              <button data-testid="same-taxon" onClick={() => onOpenTaxon(asvId)}
                className="mt-0.5 text-xs text-cyan-300 hover:underline">
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
                    title={d.network_scope.recorded
                      ? (d.network_scope.subset
                          ? `The network was computed on ${d.network_scope.n_in_run} of the `
                            + `${d.network_scope.n_dataset} ASVs of this dataset, so it may not `
                            + `have been tested at all.`
                          : "It was part of the run and reached no correlation threshold with any partner.")
                      : "It is not recorded how many ASVs went into the network run, so it "
                        + "cannot be said whether it was tested."}>
                    {d.network_scope.recorded
                      ? (d.network_scope.subset ? "not in the network run (not tested)"
                                                : "in the run, below every threshold")
                      : "not in the network run (scope not recorded)"}
                  </span>);
              }
              return limits.length > 0 ? (
                <div className="mt-0.5 text-xs text-amber-400/90 flex items-center gap-1"
                  data-testid="asv-limitations">
                  {limits.map((l, i) => [i > 0 && <span key={`s${i}`} className="text-slate-600">·</span>, l])}
                </div>
              ) : null;
            })()}
          </section>

          <section data-testid="taxonomy-section">
            <h3 className="text-slate-300 font-medium mb-1 flex items-center">Taxonomy</h3>
            <table className="text-xs text-slate-300">
              <tbody>
                {RANKS.map(([k, label]) => (
                  <tr key={k}>
                    <td className="text-slate-500 pr-3 align-top">{label}</td>
                    <td data-testid={`rank-${k}`}>
                      {named(d.lineage[k])
                        ?? <span className="text-slate-600 italic">not assigned</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          {findCap(caps, "sequence")?.available && d.sequence && (
            <section data-testid="sequence-section">
              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
                <h3 className="text-slate-300 font-medium">Sequence</h3>
                <span>{d.seq_length} bp</span>
                <span className="font-mono text-slate-500" data-testid="seq-hash">{d.seq_hash}</span>
                <button onClick={() => navigator.clipboard?.writeText(d.sequence ?? "")}
                  className="px-2 py-0.5 rounded border border-slate-600 hover:border-cyan-400 hover:text-cyan-300">
                  copy
                </button>
                <a data-testid="blast-link" href={blastUrl ?? "#"} target="_blank" rel="noopener noreferrer"
                  className="px-2 py-0.5 rounded border border-slate-600 hover:border-cyan-400 hover:text-cyan-300">
                  BLAST ↗
                </a>
                <button data-testid="sequence-toggle" onClick={() => setShowSeq((v) => !v)}
                  className="px-2 py-0.5 rounded border border-slate-600 hover:border-cyan-400 hover:text-cyan-300">
                  {showSeq ? "hide" : "show"}
                </button>
              </div>
              {showSeq && (
                <pre data-testid="sequence" className="mt-2 max-h-24 overflow-auto rounded bg-slate-950 p-2 font-mono
                                text-[10px] leading-tight text-slate-400 break-all whitespace-pre-wrap">{d.sequence}</pre>
              )}
            </section>
          )}

          <section ref={kurveRef} data-testid="asv-frequency-section">
            <h3 className="text-slate-300 font-medium mb-2 flex items-baseline">
              Frequency over time
              {onCompare && (
                <button data-testid="asv-compare" onClick={() => onCompare(asvId)}
                  className="ml-auto text-xs font-normal px-2 py-0.5 rounded bg-slate-700
                             text-slate-200 hover:bg-slate-600">
                  Compare ↗
                </button>
              )}
            </h3>
            <FrequencyPanel freq={d.frequency} subject="this ASV" env={env} testid="asv-frequency"
              markSample={markSample} pool={d.pool} />
          </section>

          {findCap(caps, "environment")?.available && (
          <section data-testid="peak-env-section">
            <h3 className="text-slate-300 font-medium mb-1 flex items-center">
              Environment
              <InfoTip title="Method and caveat">
                <p data-testid="peak-env-caveat-full">{d.peak_environment.caveat}</p>
                <p>{d.environment_profile.method}</p>
                <p>{d.environment_profile.caveat}</p>
              </InfoTip>
            </h3>
            {d.peak_environment.items.length === 0 && d.environment_profile.items.length === 0 ? (
              <p className="text-xs text-slate-500" data-testid="peak-env-missing">
                Not recorded for this ASV — these values exist only for ASVs in the network.
              </p>
            ) : (
              <>
                <EnvironmentBars peak={d.peak_environment} profile={d.environment_profile}
                  onPeakSample={zurKurve} />
                <p className="mt-1 text-[10px] text-slate-500" data-testid="peak-env-caveat">
                  {d.peak_environment.at_date && <>Peak sample of {d.peak_environment.at_date} · </>}
                  one sample, not a range and not an optimum
                </p>
              </>
            )}
          </section>
          )}

          <section>
            <h3 className="text-slate-300 font-medium mb-1 flex items-center">Neighbours</h3>
            <p className="text-[10px] text-slate-500 mb-1" data-testid="neighbours-declaration">
              CON = co-occurrence (correlation, not an interaction) · CCM = predictive value without a convergence test — no evidence of causation
            </p>
            <NeighbourNet asvId={asvId} cluster={d.cluster} neighbors={d.neighbors}
                          onOpenAsv={onOpenAsv} onOpenEdge={onOpenEdge} />
          </section>

          <NoteBox testid="asv-note" value={d.note} savedAt={d.note_at}
            onSave={(t) => setAsvNote(datasetId, asvId, t)
              .then((r) => setD((cur) => (cur ? { ...cur, note: r.note, note_at: r.note_at } : cur)))} />

          <section data-testid="function-section" data-annotated={d.trait?.annotated ? "1" : "0"}>
            {d.trait?.annotated && (
              <div className="mb-1" data-testid="function-literature">
                <div className="text-[10px] uppercase tracking-wide text-slate-500 flex items-center">
                  annotated function (literature)
                  <InfoTip title="Where this comes from">
                    <p>{d.trait.note}</p>
                    {d.trait_run?.statement && <p data-testid="function-coverage">{d.trait_run.statement}</p>}
                    {d.trait_run?.source_citations?.map((c) => <p key={c} className="text-slate-500">{c}</p>)}
                    {d.trait.functions.some((f) => f.startsWith("mixoplankton (")) && d.trait_run?.mdb_categories && (
                      <p className="text-slate-500">
                        {Object.entries(d.trait_run.mdb_categories).map(([k, v]) => `${k} = ${v}`).join(" · ")}
                      </p>
                    )}
                  </InfoTip>
                </div>
                <ul className="text-xs mt-0.5">
                  {d.trait.functions.map((f, i) => (
                    <li key={`${f}|${d.trait!.sources[i]}`} data-testid="function-entry" data-function={f}
                      className="flex items-baseline gap-2">
                      <span className="text-slate-200">{f}</span>
                      <span className="text-slate-500">— {d.trait!.sources[i]}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="text-xs text-slate-500 italic">
              Ecological function — not derivable from amplicon data (a gene fragment, not an activity)
            </div>
          </section>
          <ProvenanceFooter datasetId={datasetId} />
        </div>
      )}
    </div>
  );
}

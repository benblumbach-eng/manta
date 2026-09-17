import { useEffect, useRef, useState } from "react";
import ReactECharts from "echarts-for-react";
import { getAsv, getEnvironment, getSpectrum, getTaxon, setAsvNote, setAsvStar, type AsvDetail, type Environment, type Neighbor, type Spectrum } from "../api";
import type { EdgeRef } from "../App";
import InfoTip from "./InfoTip";
import { useModules } from "../modules";
import ProvenanceFooter from "./ProvenanceFooter";
import FrequencyPanel from "./FrequencyPanel";
import NoteBox from "./NoteBox";
import { findCap } from "./DataAvailability";
import StarButton from "./StarButton";

const RANKS: [string, string][] = [
  ["kingdom", "Kingdom"], ["phylum", "Phylum"], ["class", "Class"], ["order", "Order"],
  ["family", "Family"], ["genus", "Genus"], ["species", "Species"],
];
const PLACEHOLDERS = new Set(["unassigned", "NA", "", "Environment_Condition", "uncultured"]);
const named = (v: string | null | undefined) => (v && !PLACEHOLDERS.has(v) ? v : null);

function SpectrumSection({ datasetId, asvId, spectrum, neighbours }: {
  datasetId: string; asvId: string; spectrum: Spectrum | null | undefined; neighbours: Neighbor[];
}) {
  const [overlayId, setOverlayId] = useState<string | null>(null);
  const [overlay, setOverlay] = useState<Spectrum | null>(null);
  const [overlayErr, setOverlayErr] = useState<string | null>(null);
  useEffect(() => { setOverlayId(null); setOverlay(null); setOverlayErr(null); }, [asvId]);
  useEffect(() => {
    if (!overlayId) { setOverlay(null); return; }
    let dead = false;
    getSpectrum(datasetId, overlayId)
      .then((r) => { if (!dead) setOverlay(r.spectrum); })
      .catch((e) => { if (!dead) setOverlayErr(String(e)); });
    return () => { dead = true; };
  }, [datasetId, overlayId]);
  const seen = new Set<string>();
  const unique = neighbours.filter((n) => (seen.has(n.id) ? false : (seen.add(n.id), true)));

  const sp = spectrum ?? null;
  const ks = sp?.harmonics ?? [];
  const option = sp?.available ? {
    backgroundColor: "transparent",
    grid: { left: 44, right: 8, top: 8, bottom: 26 },
    tooltip: { trigger: "axis" as const, axisPointer: { type: "shadow" as const },
      formatter: (ps: any[]) => ps.map((p) => `${p.seriesName}: ${Number(p.value).toPrecision(4)}`)
        .join("<br/>") + `<br/><span style="opacity:.7">harmonic ${ps[0]?.axisValue}</span>` },
    xAxis: { type: "category" as const, name: "harmonic", nameLocation: "middle" as const, nameGap: 16,
      data: ks.map(String), axisLabel: { fontSize: 9 }, nameTextStyle: { fontSize: 9 } },
    yAxis: { type: "value" as const, axisLabel: { fontSize: 9, formatter: (v: number) => v.toPrecision(2) },
      splitLine: { lineStyle: { opacity: 0.2 } } },
    series: [
      { name: asvId, type: "bar" as const, data: sp.amplitudes, itemStyle: { color: "#22d3ee" }, barGap: "10%" },
      ...(overlay?.available && overlayId
        ? [{ name: overlayId, type: "bar" as const, data: overlay.amplitudes, itemStyle: { color: "#fbbf24" } }]
        : []),
    ],
  } : null;

  return (
    <section data-testid="asv-spectrum" data-n={sp?.available ? sp.n : 0}
      data-overlay={overlay?.available && overlayId ? overlayId : ""}>
      <h3 className="text-slate-300 font-medium mb-1 flex items-center">Fourier spectrum</h3>
      {sp?.available && (
        <p className="text-[10px] text-slate-500" data-testid="spectrum-method">
          Amplitudes of OTTER&rsquo;s Fourier coefficients 1…{sp.n} — the input CON correlates; k = cycles over the whole series
          {" · "}FFT_COEFFS {sp.fft_coeffs}{sp.params_recorded ? "" : ", not recorded for this dataset"}
        </p>
      )}
      {sp == null ? (
        <p className="text-xs text-slate-500" data-testid="spectrum-absent">not reported by this server</p>
      ) : !sp.available ? (
        <p className="text-xs text-amber-400/90" data-testid="spectrum-absent">{sp.absent_reason}</p>
      ) : (
        <>
          <ReactECharts option={option!} style={{ height: 150 }} notMerge />
          <div className="text-[11px] text-slate-400 flex flex-wrap items-center gap-x-2 gap-y-1">
            <span><span className="inline-block w-3 h-2 align-middle mr-1" style={{ background: "#22d3ee" }} />{asvId}</span>
            {overlay?.available && overlayId && (
              <span><span className="inline-block w-3 h-2 align-middle mr-1" style={{ background: "#fbbf24" }} />{overlayId}</span>
            )}
            {unique.length > 0 && (
              <span className="text-slate-500 ml-1">compare with:</span>
            )}
            {unique.map((n) => (
              <button key={n.id} data-testid="spectrum-neighbor" data-asv={n.id}
                aria-pressed={overlayId === n.id}
                onClick={() => setOverlayId(overlayId === n.id ? null : n.id)}
                className={`px-1.5 py-0.5 rounded font-mono ${overlayId === n.id
                  ? "bg-amber-500/30 text-amber-200" : "bg-slate-800 text-slate-300 hover:bg-slate-700"}`}>
                {n.id}
              </button>
            ))}
          </div>
          {overlayId && overlay && !overlay.available && (
            <p className="text-[11px] text-amber-400/90" data-testid="spectrum-overlay-absent">
              {overlayId}: {overlay.absent_reason}
            </p>
          )}
          {overlayErr && <p className="text-[11px] text-red-300">{overlayErr}</p>}
        </>
      )}
    </section>
  );
}

function UnitFlag({ note, k }: { note?: string | null; k: string }) {
  if (!note) return null;
  return (
    <span className="text-amber-400" data-testid={`peak-unit-note-${k}`}>
      {" "}<span title={note} aria-label={note}>!</span>
    </span>
  );
}

export default function AsvDrawer({ datasetId, asvId, onClose, onOpenAsv, onOpenEdge,
                                    onCompare, onOpenTaxon }: {
  datasetId: string;
  asvId: string;
  onClose: () => void;
  onOpenAsv: (id: string) => void;
  onOpenEdge: (e: EdgeRef) => void;
  onCompare?: (id: string) => void;
  onOpenTaxon?: (id: string) => void;
}) {
  const modules = useModules();
  const [d, setD] = useState<AsvDetail | null>(null);
  const [taxonN, setTaxonN] = useState<number | null>(null);
  const sternSchreib = useRef<{ t: number; wert: boolean } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [env, setEnv] = useState<Environment | null>(null);
  const [showSeq, setShowSeq] = useState(false);

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

  const NeighborRow = ({ n, kind }: { n: Neighbor; kind: "con" | "ccm" }) => (
    <div className="flex items-center justify-between gap-2 rounded hover:bg-slate-800">
      <button data-testid="neighbor" onClick={() => onOpenAsv(n.id)} className="flex-1 text-left px-2 py-1">
        <span className="font-mono text-cyan-300">{n.id}</span>{" "}
        <span className="text-slate-400">({named(n.genus) ?? "no name"})</span>
      </button>
      <button data-testid="edge-open" title="open this link"
        onClick={() => onOpenEdge({ source: asvId, target: n.id, type: kind })}
        className="px-2 py-1 text-slate-400 hover:text-cyan-300 tabular-nums">
        {kind === "ccm" ? "→" : "—"} {(kind === "ccm" ? n.nmi : n.corr)?.toFixed(2)}
      </button>
    </div>
  );

  const caps = d?.capabilities;
  const nNeighbours = (d?.neighbors.con.length ?? 0) + (d?.neighbors.ccm.length ?? 0);

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
              {d.cluster == null ? "no module" : modules.label(d.cluster)} · dataset {d.dataset_id}
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

          <section>
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
            <FrequencyPanel freq={d.frequency} subject="this ASV" env={env} testid="asv-frequency" />
          </section>

          <SpectrumSection datasetId={datasetId} asvId={asvId} spectrum={d.spectrum}
            neighbours={[...d.neighbors.con, ...d.neighbors.ccm]} />

          {findCap(caps, "environment")?.available && (
          <section data-testid="peak-env-section">
            <h3 className="text-slate-300 font-medium mb-1 flex items-center">
              Environment at the peak sample
              <InfoTip title="Caveat">
                <p data-testid="peak-env-caveat-full">{d.peak_environment.caveat}</p>
              </InfoTip>
            </h3>
            {d.peak_environment.items.length === 0 ? (
              <p className="text-xs text-slate-500" data-testid="peak-env-missing">
                Not recorded for this ASV — these values exist only for ASVs in the network.
              </p>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-x-4 text-xs" data-testid="peak-env-values">
                  {d.peak_environment.items.map((it) => (
                    <div key={it.key} className="flex justify-between border-b border-slate-800 py-0.5">
                      <span className="text-slate-400">{it.label}</span>
                      <span className="text-slate-200 tabular-nums">
                        {it.value.toFixed(2)}{it.unit ? ` ${it.unit}` : ""}
                        <UnitFlag note={it.unit_note} k={it.key} />
                      </span>
                    </div>
                  ))}
                </div>
                <p className="mt-1 text-[10px] text-slate-500" data-testid="peak-env-caveat">
                  {d.peak_environment.at_date && <>Sample of {d.peak_environment.at_date} · </>}
                  one sample, not a range and not an optimum
                </p>
              </>
            )}

            {d.environment_profile.items.length > 0 && (
              <div className="mt-3" data-testid="env-profile">
                <h4 className="text-slate-300 text-xs font-medium mb-1 flex items-center">
                  Environment across samples with detection
                  <InfoTip title="Method and caveat">
                    <p>{d.environment_profile.method}</p>
                    <p>{d.environment_profile.caveat}</p>
                  </InfoTip>
                </h4>
                <div className="text-xs" data-testid="env-profile-values">
                  {d.environment_profile.items.map((it) => (
                    <div key={it.key} className="flex justify-between border-b border-slate-800 py-0.5">
                      <span className="text-slate-400">{it.label}</span>
                      <span className="text-slate-200 tabular-nums">
                        {it.weighted_mean.toFixed(2)}{it.unit ? ` ${it.unit}` : ""}
                        <UnitFlag note={it.unit_note} k={it.key} />
                        <span className="text-slate-500"> · 10–90 %: {it.p10.toFixed(2)}–{it.p90.toFixed(2)}
                          {" "}· {it.n_samples_used} of {it.n_samples_present} samples</span>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>
          )}

          <section>
            <h3 className="text-slate-300 font-medium mb-1 flex items-center">Neighbours</h3>
            <p className="text-[10px] text-slate-500 mb-1" data-testid="neighbours-declaration">
              CON = co-occurrence (correlation, not an interaction) · CCM = predictive value without a convergence test — no evidence of causation
            </p>
            {nNeighbours === 0 ? (
              <p className="text-xs text-amber-400/90">
                No links at the current thresholds. That is a result, not a gap: no partner
                correlated with this ASV strongly enough.
              </p>
            ) : (
              <div className="text-xs">
                <div className="text-slate-500 mb-0.5">CON ({d.neighbors.con.length})</div>
                {d.neighbors.con.map((n) => <NeighborRow key={`con-${n.id}`} n={n} kind="con" />)}
                <div className="text-slate-500 mt-1 mb-0.5">CCM ({d.neighbors.ccm.length})</div>
                {d.neighbors.ccm.map((n) => <NeighborRow key={`ccm-${n.id}`} n={n} kind="ccm" />)}
              </div>
            )}
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

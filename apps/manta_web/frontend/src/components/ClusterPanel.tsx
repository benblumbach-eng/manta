import { useEffect, useMemo, useState } from "react";
import { getCluster, getClusterAtSample, getEnvironment, setClusterNote, setClusterStar,
         type ClusterAtSample, type ClusterDetail, type Environment } from "../api";
import type { EdgeRef } from "../App";
import InfoTip from "./InfoTip";
import { useModules } from "../modules";
import { setClusterLabel } from "../api";
import ProvenanceFooter from "./ProvenanceFooter";
import FrequencyPanel from "./FrequencyPanel";
import NoteBox from "./NoteBox";
import StarButton from "./StarButton";

export default function ClusterPanel({ datasetId, label, color, onClose, onOpenAsv, onOpenEdge,
                                       onOpenCluster, colorOf, isAdmin = false }: {
  datasetId: string;
  label: number;
  isAdmin?: boolean;
  color?: string;
  onClose: () => void;
  onOpenAsv?: (id: string) => void;
  onOpenEdge?: (e: EdgeRef) => void;
  onOpenCluster?: (label: number) => void;
  colorOf?: (label: number) => string | undefined;
}) {
  const modules = useModules();
  const [nameDraft, setNameDraft] = useState("");
  const [colorDraft, setColorDraft] = useState("#4477aa");
  const [saving, setSaving] = useState(false);
  const [nameErr, setNameErr] = useState<string | null>(null);
  useEffect(() => {
    setNameDraft(modules.name(label));
    setColorDraft(modules.color(label));
  }, [label, modules]);
  const schreiben = (body: { name?: string; color?: string }) => {
    setSaving(true); setNameErr(null);
    setClusterLabel(datasetId, label, body)
      .then(() => modules.reload())
      .catch((e) => {
        const t = String(e?.message ?? e);
        setNameErr(/not found/i.test(t)
          ? "this server does not know module names — restart it"
          : t);
      })
      .finally(() => setSaving(false));
  };
  const saveLabel = () => schreiben({ name: nameDraft, color: colorDraft });
  const resetLabel = () => schreiben({ name: "", color: "" });
  const [c, setC] = useState<ClusterDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [env, setEnv] = useState<Environment | null>(null);
  const [genusFilter, setGenusFilter] = useState<string | null>(null);
  const [atSample, setAtSample] = useState<ClusterAtSample | null>(null);
  const [atBusy, setAtBusy] = useState(false);

  useEffect(() => {
    setC(null); setErr(null); setGenusFilter(null);
    setOpenPartners(new Set()); setAllGenera(false); setAllMembers(false); setAtSample(null);
    getCluster(datasetId, label).then(setC).catch((e) => setErr(String(e)));
  }, [datasetId, label]);

  useEffect(() => {
    setEnv(null);
    getEnvironment(datasetId).then(setEnv).catch(() => setEnv(null));
  }, [datasetId]);

  const byPartner = useMemo(() => {
    const shown = new Map<number, ClusterDetail["bridge_edges"]>();
    (c?.bridge_edges ?? []).forEach((e) => {
      const list = shown.get(e.other_cluster) ?? [];
      list.push(e);
      shown.set(e.other_cluster, list);
    });
    return (c?.bridge_partners ?? []).map((p) => ({
      partner: p.partner,
      total: p.kanten,
      edges: (shown.get(p.partner) ?? []).sort((a, b) => b.corr - a.corr || a.other.localeCompare(b.other)),
    })).sort((a, b) => b.total - a.total || a.partner - b.partner);
  }, [c]);
  const [openPartners, setOpenPartners] = useState<Set<number>>(new Set());
  const PREVIEW = 3;
  const GENERA_PREVIEW = 12;
  const MEMBERS_PREVIEW = 30;
  const [allGenera, setAllGenera] = useState(false);
  const [allMembers, setAllMembers] = useState(false);

  const genera = useMemo(
    () => Object.entries(c?.taxa_breakdown.genus ?? {}).sort((a, b) => b[1] - a[1]),
    [c]);
  const members = useMemo(
    () => (c?.members ?? []).filter((m) => !genusFilter || m.genus === genusFilter)
      .sort((a, b) => Number(b.hub) - Number(a.hub) || a.id.localeCompare(b.id)),
    [c, genusFilter]);

  const Swatch = ({ n }: { n: number }) => (
    <span className="inline-block w-2.5 h-2.5 rounded-sm shrink-0 align-middle"
      style={{ background: colorOf?.(n) ?? "#888" }} />
  );

  return (
    <div className="h-full overflow-auto"
      data-testid="cluster-panel">
      <div className="flex items-center justify-between px-4 py-2 border-b border-slate-700 sticky top-0 bg-slate-900 z-10">
        <span className="flex items-center gap-2">
          <span className="inline-block w-3 h-3 rounded-sm" style={{ background: color ?? "#888" }} />
          <span className="text-slate-100 font-medium"
            data-testid="cluster-title">{modules.label(label)}</span>
          {c && (
            <StarButton starred={c.starred} testid="cluster-star" label={`cluster ${label}`}
              onToggle={(next) => setClusterStar(datasetId, label, next)
                .then((r) => setC((cur) => (cur ? { ...cur, starred: r.starred } : cur)))} />
          )}
          <span className="text-xs text-slate-500">{c ? `${c.members.length} ASVs` : ""}</span>
        </span>
        <button onClick={onClose} data-testid="cluster-close" aria-label="Close"
          className="text-slate-400 hover:text-white">✕</button>
      </div>

      {isAdmin && (
        <div className="flex items-center gap-1.5 px-4 py-1.5 border-b border-slate-800"
          data-testid="module-editor">
          <input data-testid="module-name" value={nameDraft} maxLength={40}
            placeholder={`M${label}`}
            onChange={(e) => setNameDraft(e.target.value)}
            className="flex-1 min-w-0 px-2 py-1 rounded bg-slate-950 border border-slate-700
                       text-sm text-slate-100 focus:border-cyan-500 focus:outline-none" />
          <input data-testid="module-color" type="color" value={colorDraft}
            onChange={(e) => setColorDraft(e.target.value)}
            className="w-8 h-7 rounded bg-slate-950 border border-slate-700" />
          <button data-testid="module-save" onClick={saveLabel} disabled={saving}
            className="px-2 py-1 rounded bg-slate-700 text-slate-100 text-xs
                       hover:bg-slate-600 disabled:opacity-50">save</button>
          <button data-testid="module-reset" onClick={resetLabel} disabled={saving}
            className="px-2 py-1 rounded border border-slate-700 text-slate-400 text-xs
                       hover:text-slate-200 disabled:opacity-50">default</button>
        </div>
      )}
      {isAdmin && nameErr && (
        <p className="px-4 pb-1.5 text-xs text-red-300" data-testid="module-error">{nameErr}</p>
      )}

      {err && <div className="p-4 text-red-300" data-testid="error">{err}</div>}
      {!c && !err && <div className="p-4 text-slate-500">loading …</div>}

      {c && (
        <div className="p-4 space-y-5 text-sm">

          <section data-testid="cluster-activity">
            <div className="text-[10px] uppercase tracking-wide text-slate-500">Seasonality</div>
            <div className="text-base text-slate-100 mt-0.5">
              {c.activity.statement
                ? c.activity.statement.charAt(0).toUpperCase() + c.activity.statement.slice(1)
                : "—"}
            </div>
            {c.activity.axis === "dates" && c.activity.n_min > 0 && (
              <p className="text-[10px] text-slate-500" data-testid="cluster-window-support">
                months above the cluster&rsquo;s own annual mean share · thinnest month rests on{" "}
                {c.activity.n_min} sample{c.activity.n_min === 1 ? "" : "s"}
              </p>
            )}
            <div data-testid="cluster-collective" className="mt-2">
              <FrequencyPanel freq={c.frequency} subject="this cluster" color={color}
                env={env} testid="cluster-frequency" compact
                onPointClick={(sample) => {
                  setAtBusy(true); setAtSample(null);
                  getClusterAtSample(datasetId, label, sample)
                    .then(setAtSample).catch(() => setAtSample(null))
                    .finally(() => setAtBusy(false));
                }} />
            </div>
            {(atBusy || atSample) && (
              <div className="mt-2 rounded border border-slate-700 bg-slate-950/50 p-2"
                data-testid="at-sample">
                {atBusy ? <span className="text-xs text-slate-500">loading …</span> : atSample && (
                  <>
                    <div className="flex items-baseline gap-2">
                      <span className="text-[10px] uppercase tracking-wide text-slate-500">
                        in this sample
                      </span>
                      <span className="text-xs text-slate-300">{atSample.sample}</span>
                      <button data-testid="at-sample-close" onClick={() => setAtSample(null)}
                        aria-label="Close" className="ml-auto text-xs text-slate-500 hover:text-white">✕</button>
                    </div>
                    {atSample.members.length === 0 ? (
                      <p className="text-xs text-slate-400">{atSample.note}</p>
                    ) : (
                      <ul className="mt-1 text-xs">
                        {atSample.members.filter((m) => m.count > 0).map((m) => (
                          <li key={m.id}>
                            <button data-testid="at-sample-member" onClick={() => onOpenAsv?.(m.id)}
                              disabled={!onOpenAsv}
                              className="flex w-full items-baseline gap-2 px-1 py-0.5 rounded text-left
                                         hover:bg-slate-800 disabled:hover:bg-transparent">
                              <span className="font-mono text-cyan-300">{m.id}</span>
                              {m.genus && <span className="text-slate-500 truncate">({m.genus})</span>}
                              <span className="ml-auto tabular-nums text-slate-300">
                                {m.share_of_cluster == null ? "—"
                                  : `${(100 * m.share_of_cluster).toFixed(1)}%`}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                    <p className="mt-1 text-[10px] text-slate-500">
                      share of this cluster&rsquo;s total in that one sample
                    </p>
                  </>
                )}
              </div>
            )}
          </section>

          {c.environment_profile.items.length > 0 && (
            <section data-testid="cluster-env-profile">
              <div className="text-[10px] uppercase tracking-wide text-slate-500 flex items-center">
                Environment (weighted by the cluster&rsquo;s share)
                <InfoTip title="Method and caveat">
                  <p>{c.environment_profile.method} The weight of a sample is this cluster&rsquo;s
                  own curve value in it.</p>
                  <p>{c.environment_profile.series_definition} {c.environment_profile.series_note}</p>
                  <p>{c.environment_profile.caveat}</p>
                </InfoTip>
              </div>
              <div className="text-xs mt-1" data-testid="cluster-env-profile-values">
                {c.environment_profile.items.map((it) => (
                  <div key={it.key} className="flex justify-between border-b border-slate-800 py-0.5">
                    <span className="text-slate-400">{it.label}</span>
                    <span className="text-slate-200 tabular-nums">
                      {it.weighted_mean.toFixed(2)}{it.unit ? ` ${it.unit}` : ""}
                      <span className="text-slate-500"> · 10–90 %: {it.p10.toFixed(2)}–{it.p90.toFixed(2)}
                        {" "}· {it.n_samples_used} of {it.n_samples_present} samples</span>
                    </span>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section data-testid="cluster-members">
            <div className="text-[10px] uppercase tracking-wide text-slate-500 flex items-baseline">
              Members
              {genusFilter && (
                <button data-testid="genus-clear" onClick={() => setGenusFilter(null)}
                  className="ml-auto text-[10px] text-cyan-300 hover:underline normal-case">
                  showing {genusFilter} — show all
                </button>
              )}
            </div>

            {c.function_breakdown && (
              <div className="mt-1" data-testid="cluster-functions"
                data-n-annotated={c.function_breakdown.n_annotated}>
                <div className="text-[10px] text-slate-500 flex items-center">
                  by function (literature)
                  <InfoTip title="What these bars count">
                    <p>{c.function_breakdown.note}</p>
                    {c.trait_run?.statement && <p>{c.trait_run.statement}</p>}
                    <p>An ASV with two labels counts in both bars; the bars do not add up to the
                    member count.</p>
                  </InfoTip>
                </div>
                <ul className="mt-0.5 text-[11px]">
                  {c.function_breakdown.functions.map((f) => (
                    <li key={f.label} data-testid="cluster-function-row" data-label={f.label} data-n={f.n_asv}
                      className="flex items-center gap-2 py-px">
                      <span className={`w-28 shrink-0 truncate ${f.label === "not annotated" ? "text-slate-500" : "text-slate-300"}`}
                        title={f.label}>{f.label}</span>
                      <span className="flex-1 h-2 bg-slate-800 rounded-sm overflow-hidden">
                        <span className={`block h-full ${f.label === "not annotated" ? "bg-slate-600" : "bg-cyan-600"}`}
                          style={{ width: `${Math.round(100 * (f.share ?? 0))}%` }} />
                      </span>
                      <span className="w-8 text-right tabular-nums text-slate-400">{f.n_asv}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="mt-1 flex flex-wrap gap-1">
              {(allGenera ? genera : genera.slice(0, GENERA_PREVIEW)).map(([g, n]) => (
                <button key={g} data-testid="genus-chip"
                  onClick={() => setGenusFilter(genusFilter === g ? null : g)}
                  className={`px-1.5 py-0.5 rounded text-xs border ${genusFilter === g
                    ? "border-cyan-400 text-cyan-300"
                    : "border-slate-700 text-slate-400 hover:border-slate-500"}`}>
                  {g} <span className="text-slate-600 tabular-nums">{n}</span>
                </button>
              ))}
              {genera.length > GENERA_PREVIEW && (
                <button data-testid="genus-more" onClick={() => setAllGenera((v) => !v)}
                  className="px-1.5 py-0.5 text-xs text-cyan-300 hover:underline">
                  {allGenera ? "show the top 12 only"
                             : `${genera.length - GENERA_PREVIEW} more genera`}
                </button>
              )}
            </div>

            <ul className="mt-2 text-xs">
              {(allMembers ? members : members.slice(0, MEMBERS_PREVIEW)).map((m) => (
                <li key={m.id}>
                  <button data-testid="cluster-member" onClick={() => onOpenAsv?.(m.id)}
                    disabled={!onOpenAsv}
                    className="flex items-baseline w-full text-left px-1 py-0.5 rounded
                               hover:bg-slate-800 disabled:hover:bg-transparent">
                    <span className="font-mono text-cyan-300">{m.id}</span>
                    {m.hub && (
                      <span data-testid="member-hub" title={c.hub_tooltip}
                        className="ml-1 text-amber-300">✦</span>
                    )}
                    {m.genus && <span className="text-slate-500 truncate ml-1.5">({m.genus})</span>}
                  </button>
                </li>
              ))}
            </ul>
            {members.length > MEMBERS_PREVIEW && (
              <button data-testid="members-more" onClick={() => setAllMembers((v) => !v)}
                className="mt-1 text-[11px] text-cyan-300 hover:underline">
                {allMembers ? `show the first ${MEMBERS_PREVIEW} only`
                            : `show all ${members.length}`}
              </button>
            )}
          </section>

          <section data-testid="cluster-connections">
            <div className="text-[10px] uppercase tracking-wide text-slate-500">Connections</div>
            <p className="text-[10px] text-slate-500" data-testid="cluster-cohesion-line">
              {c.cohesion.innen} links inside · {c.cohesion.aussen} leaving
              {c.cohesion.corr_innen != null && <> · mean r inside {c.cohesion.corr_innen.toFixed(3)}</>}
              {c.cohesion.corr_aussen != null && <>, outside {c.cohesion.corr_aussen.toFixed(3)}</>}
            </p>

            {c.cohesion.aussen === 0 ? (
              <p className="mt-1 text-slate-200" data-testid="cluster-isolated">
                Nothing. All {c.cohesion.innen} of its links stay inside — this cluster is a
                separate piece of the network.
              </p>
            ) : (
              <div className="mt-1 space-y-2">
                {byPartner.map(({ partner, total, edges }) => {
                  const open = openPartners.has(partner);
                  const visible = open ? edges : edges.slice(0, PREVIEW);
                  return (
                  <div key={partner} className="rounded border border-slate-700 bg-slate-950/50">
                    <div className="flex items-baseline gap-2 px-2 py-1">
                      <Swatch n={partner} />
                      <button data-testid="bridge-partner"
                        onClick={() => onOpenCluster?.(partner)} disabled={!onOpenCluster}
                        className="text-slate-100 hover:underline disabled:hover:no-underline">
                        {modules.label(partner)}
                      </button>
                      <span className="text-xs text-slate-500 ml-auto tabular-nums">
                        {total} link{total === 1 ? "" : "s"}
                      </span>
                    </div>
                    <ul className="px-2 pb-1.5 text-xs">
                      {visible.map((e) => (
                        <li key={`${e.mine}-${e.other}`} className="flex items-center gap-1">
                          <Swatch n={label} />
                          <button data-testid="bridge-asv" onClick={() => onOpenAsv?.(e.mine)}
                            disabled={!onOpenAsv}
                            className="font-mono text-cyan-300 hover:underline shrink-0 truncate">
                            {e.mine}
                            {e.mine_genus && <span className="text-slate-500 font-sans"> ({e.mine_genus})</span>}
                          </button>
                          <button data-testid="bridge-edge"
                            onClick={() => onOpenEdge?.({ source: e.mine, target: e.other, type: "con" })}
                            disabled={!onOpenEdge}
                            title="open this link"
                            className="text-slate-500 hover:text-cyan-300 tabular-nums px-1 shrink-0">
                            — {e.corr.toFixed(2)} —
                          </button>
                          <Swatch n={e.other_cluster} />
                          <button data-testid="bridge-asv" onClick={() => onOpenAsv?.(e.other)}
                            disabled={!onOpenAsv}
                            className="font-mono text-cyan-300 hover:underline shrink-0 truncate">
                            {e.other}
                            {e.other_genus && <span className="text-slate-500 font-sans"> ({e.other_genus})</span>}
                          </button>
                        </li>
                      ))}
                    </ul>
                    {edges.length > PREVIEW && (
                      <button data-testid="bridge-more"
                        onClick={() => setOpenPartners((s) => {
                          const n = new Set(s);
                          open ? n.delete(partner) : n.add(partner);
                          return n;
                        })}
                        className="w-full px-2 pb-1 text-left text-[11px] text-cyan-300 hover:underline">
                        {open ? "show the strongest 3 only"
                              : `show ${edges.length - PREVIEW} more`}
                      </button>
                    )}
                    {total > edges.length && (
                      <p className="px-2 pb-1 text-[10px] text-slate-500" data-testid="bridge-capped">
                        {total - edges.length} further link{total - edges.length === 1 ? "" : "s"} to
                        this cluster are not listed — the API returns the 50 strongest per cluster.
                      </p>
                    )}
                  </div>
                  );
                })}
              </div>
            )}
          </section>

          <NoteBox testid="cluster-note" value={c.note?.n ?? null} savedAt={c.note?.t ?? null}
            onSave={(t) => setClusterNote(datasetId, label, t)
              .then((r) => setC((cur) => (cur ? { ...cur, note: { n: r.note, t: r.note_at } } : cur)))} />

          <p className="text-[10px] text-slate-600" data-testid="cluster-source">
            <span data-testid="cluster-source-citation">&ldquo;Community cluster&rdquo; and Louvain after {c.source_publication.citation}</span>
          </p>
          <ProvenanceFooter datasetId={datasetId} />
        </div>
      )}
    </div>
  );
}

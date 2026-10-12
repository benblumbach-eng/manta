import { Button, StateNotice, ToggleButton, SectionHeading } from "./ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { getCluster, getClusterAtSample, getEnvironment, setClusterNote, setClusterStar,
         type ClusterAtSample, type ClusterDetail, type Environment } from "../api";
import type { EdgeRef } from "../App";
import ClusterNet from "./ClusterNet";
import EnvironmentBars from "./EnvironmentBars";
import InfoTip from "./InfoTip";
import { useModules } from "../modules";
import { setClusterLabel } from "../api";
import ProvenanceFooter from "./ProvenanceFooter";
import FrequencyPanel from "./FrequencyPanel";
import NoteBox from "./NoteBox";
import ErrorNotice from "./ErrorNotice";
import { PanelHeader } from "./PanelFrame";
import { Criterion2ModuleLine } from "./Criterion2";
import StarButton from "./StarButton";

export default function ClusterPanel({ datasetId, label, color, onClose, onOpenAsv, onOpenEdge,
                                       onOpenCluster, colorOf, isAdmin = false, signedIn = true }: {
  datasetId: string;
  label: number;
  isAdmin?: boolean;
  color?: string;
  onClose: () => void;
  onOpenAsv?: (id: string) => void;
  onOpenEdge?: (e: EdgeRef) => void;
  onOpenCluster?: (label: number) => void;
  colorOf?: (label: number) => string | undefined;
  signedIn?: boolean;
}) {
  const modules = useModules();
  const [nameDraft, setNameDraft] = useState("");
  const [colorDraft, setColorDraft] = useState(() => modules.color(label));
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
  const [err, setErr] = useState<unknown>(null);
  const [nochmal, setNochmal] = useState(0);
  const [env, setEnv] = useState<Environment | null>(null);
  const [genusFilter, setGenusFilter] = useState<string | null>(null);
  const [atSample, setAtSample] = useState<ClusterAtSample | null>(null);
  const [atBusy, setAtBusy] = useState(false);
  const [atErr, setAtErr] = useState<string | null>(null);

  useEffect(() => {
    setC(null); setErr(null); setGenusFilter(null);
    setOpenPartners(new Set()); setAllGenera(false); setAllMembers(false); setAtSample(null);
    setAtErr(null); setAtBusy(false);
    let alive = true;
    getCluster(datasetId, label).then((x) => { if (alive) setC(x); })
      .catch((e) => { if (alive) setErr(e); });
    return () => { alive = false; };
  }, [datasetId, label, nochmal]);
  const offen = useRef(`${datasetId}/${label}`);
  offen.current = `${datasetId}/${label}`;

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
      raus: p.gerichtet_raus, rein: p.gerichtet_rein,
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
      .sort((a, b) => Number(!!b.criterion2?.passes) - Number(!!a.criterion2?.passes)
        || a.id.localeCompare(b.id)),
    [c, genusFilter]);

  const Swatch = ({ n }: { n: number }) => (
    <span className="inline-block w-2.5 h-2.5 rounded-sm shrink-0 align-middle"
      style={{ background: colorOf?.(n) ?? "var(--text-disabled)" }} />
  );

  return (
    <div data-testid="cluster-panel">
      <PanelHeader onClose={onClose} closeTestid="cluster-close"
        lead={<span aria-hidden className="inline-block w-3 h-3 shrink-0 rounded-sm"
          style={{ background: color ?? "var(--text-disabled)" }} />}
        title={<span data-testid="cluster-title">{modules.label(label)}</span>}>
        {c && signedIn && (
          <StarButton starred={c.starred} testid="cluster-star" label={`cluster ${label}`}
            onToggle={(next) => setClusterStar(datasetId, label, next)
              .then((r) => setC((cur) => (cur ? { ...cur, starred: r.starred } : cur)))} />
        )}
        <span className="shrink-0 text-xs text-fg-muted">{c ? `${c.members.length} ASVs` : ""}</span>
      </PanelHeader>

      {isAdmin && (
        <div className="flex items-center gap-2 px-4 py-2 border-b border-line-subtle"
          data-testid="module-editor">
          <input data-testid="module-name" value={nameDraft} maxLength={40}
            placeholder={`M${label}`}
            onChange={(e) => setNameDraft(e.target.value)}
            className="flex-1 min-w-0 px-2 py-1 rounded-md bg-control border border-line-strong
                       text-sm text-fg focus:border-accent focus:outline-none" />
          <input data-testid="module-color" type="color" value={colorDraft}
            onChange={(e) => setColorDraft(e.target.value)}
            className="w-8 h-7 rounded-md bg-control border border-line-strong" />
          <Button data-testid="module-save" onClick={saveLabel} disabled={saving}>save</Button>
          <Button data-testid="module-reset" onClick={resetLabel} disabled={saving}>default</Button>
        </div>
      )}
      {isAdmin && nameErr && (
        <p className="px-4 pb-2 text-xs text-danger" data-testid="module-error">{nameErr}</p>
      )}

      {err != null && <ErrorNotice error={err} what="Could not load this module."
        onRetry={() => setNochmal((n) => n + 1)} />}
      {!c && err == null && <StateNotice state="loading">loading …</StateNotice>}

      {c && (
        <div className="p-4 space-y-6 text-sm">

          <section data-testid="cluster-activity">
            <SectionHeading as="div">Seasonality</SectionHeading>
            <div className="text-base text-fg mt-1">
              {c.activity.statement
                ? c.activity.statement.charAt(0).toUpperCase() + c.activity.statement.slice(1)
                : "—"}
            </div>
            {c.activity.axis === "dates" && c.activity.n_min > 0 && (
              <p className="text-2xs text-fg-muted" data-testid="cluster-window-support">
                months above the cluster&rsquo;s own annual mean share · thinnest month rests on{" "}
                {c.activity.n_min} sample{c.activity.n_min === 1 ? "" : "s"}
              </p>
            )}
            <div data-testid="cluster-collective" className="mt-2">
              <FrequencyPanel freq={c.frequency} color={color}
                env={env} testid="cluster-frequency" compact
                onPointClick={(sample) => {
                  setAtBusy(true); setAtSample(null); setAtErr(null);
                  const fuer = `${datasetId}/${label}`;
                  getClusterAtSample(datasetId, label, sample)
                    .then((x) => { if (offen.current === fuer) setAtSample(x); })
                    .catch((e) => {
                      if (offen.current === fuer)
                        setAtErr(`${sample}: ${e instanceof Error ? e.message : String(e)}`);
                    })
                    .finally(() => { if (offen.current === fuer) setAtBusy(false); });
                }} />
            </div>
            {(atBusy || atSample || atErr) && (
              <div className="mt-2 rounded border border-line bg-surface/50 p-2"
                data-testid="at-sample">
                {atBusy ? <span className="text-xs text-fg-muted">loading …</span> : atErr ? (
                  <div className="flex items-baseline gap-2 text-xs text-danger" data-testid="at-sample-error">
                    <span>could not load this sample — {atErr}</span>
                    <button onClick={() => setAtErr(null)} aria-label="Close"
                      className="ml-auto text-fg-muted hover:text-fg">✕</button>
                  </div>
                ) : atSample && (
                  <>
                    <div className="flex items-baseline gap-2">
                      <span className="text-xs font-semibold text-fg-muted">
                        in this sample
                      </span>
                      <span className="text-xs text-fg">{atSample.sample}</span>
                      <button data-testid="at-sample-close" onClick={() => setAtSample(null)}
                        aria-label="Close" className="ml-auto text-xs text-fg-muted hover:text-fg">✕</button>
                    </div>
                    {!Array.isArray(atSample.members) || atSample.members.length === 0 ? (
                      <p className="text-xs text-fg-muted">{atSample.note}</p>
                    ) : (
                      <ul className="mt-1 text-xs">
                        {atSample.members.filter((m) => m.count > 0).map((m) => (
                          <li key={m.id}>
                            <button data-testid="at-sample-member" onClick={() => onOpenAsv?.(m.id)}
                              disabled={!onOpenAsv}
                              className="flex w-full items-baseline gap-2 px-1 py-1 rounded text-left
                                         hover:bg-control disabled:hover:bg-transparent">
                              <span className="font-mono text-accent">{m.id}</span>
                              {m.genus && <span className="text-fg-muted truncate">({m.genus})</span>}
                              <span className="ml-auto tabular-nums text-fg">
                                {m.share_of_cluster == null ? "—"
                                  : `${(100 * m.share_of_cluster).toFixed(1)}%`}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                    <p className="mt-1 text-2xs text-fg-muted">
                      share of this cluster&rsquo;s total in that one sample
                    </p>
                    {atSample.caveat && (
                      <p data-testid="at-sample-caveat" className="mt-1 text-xs text-warn leading-snug">
                        {atSample.caveat}
                      </p>
                    )}
                  </>
                )}
              </div>
            )}
          </section>

          {c.environment_profile.items.length > 0 && (
            <section data-testid="cluster-env-profile">
              <div className="text-xs font-semibold text-fg-muted flex items-center">
                Environment (weighted by the cluster&rsquo;s share)
                <InfoTip title="Method and caveat">
                  <p>{c.environment_profile.method} The weight of a sample is this cluster&rsquo;s
                  own curve value in it.</p>
                  <p>{c.environment_profile.series_definition} {c.environment_profile.series_note}</p>
                  <p>{c.environment_profile.caveat}</p>
                </InfoTip>
              </div>
              <div className="text-xs mt-1" data-testid="cluster-env-profile-values">
                <EnvironmentBars profile={c.environment_profile} weightOf="module" />
              </div>
            </section>
          )}

          <section data-testid="cluster-members">
            <div className="text-xs font-semibold text-fg-muted flex items-baseline">
              Members
              {genusFilter && (
                <button data-testid="genus-clear" onClick={() => setGenusFilter(null)}
                  className="ml-auto text-2xs text-accent hover:underline normal-case">
                  showing {genusFilter} — show all
                </button>
              )}
            </div>

            {c.function_breakdown && (
              <div className="mt-1" data-testid="cluster-functions"
                data-n-annotated={c.function_breakdown.n_annotated}>
                <div className="text-2xs text-fg-muted flex items-center">
                  by function (literature)
                  <InfoTip title="What these bars count">
                    <p>{c.function_breakdown.note}</p>
                    {c.trait_run?.statement && <p>{c.trait_run.statement}</p>}
                    <p>An ASV with two labels counts in both bars; the bars do not add up to the
                    member count.</p>
                  </InfoTip>
                </div>
                <ul className="mt-1 text-2xs">
                  {c.function_breakdown.functions.map((f) => (
                    <li key={f.label} data-testid="cluster-function-row" data-label={f.label} data-n={f.n_asv}
                      className="flex items-center gap-2 py-px">
                      <span className={`w-28 shrink-0 truncate ${f.label === "not annotated" ? "text-fg-muted" : "text-fg"}`}
                        title={f.label}>{f.label}</span>
                      <span className="flex-1 h-2 bg-control rounded-sm overflow-hidden">
                        <span className={`block h-full ${f.label === "not annotated" ? "bg-control-strong" : "bg-accent-fill"}`}
                          style={{ width: `${Math.round(100 * (f.share ?? 0))}%` }} />
                      </span>
                      <span className="w-8 text-right tabular-nums text-fg-muted">{f.n_asv}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="mt-1 flex flex-wrap gap-1">
              {(allGenera ? genera : genera.slice(0, GENERA_PREVIEW)).map(([g, n]) => (
                <ToggleButton key={g} data-testid="genus-chip" pressed={genusFilter === g}
                  onClick={() => setGenusFilter(genusFilter === g ? null : g)}>
                  {g} <span className="text-fg-muted tabular-nums">{n}</span>
                </ToggleButton>
              ))}
              {genera.length > GENERA_PREVIEW && (
                <button data-testid="genus-more" onClick={() => setAllGenera((v) => !v)}
                  className="px-2 py-1 text-xs text-accent hover:underline">
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
                    className="flex items-baseline w-full text-left px-1 py-1 rounded
                               hover:bg-control disabled:hover:bg-transparent">
                    <span className="font-mono text-accent">{m.id}</span>
                    {m.criterion2?.passes && (
                      <span data-testid="member-c2" title="hub"
                        className="ml-1 text-mark">✦</span>
                    )}
                    {m.genus && <span className="text-fg-muted truncate ml-2">({m.genus})</span>}
                  </button>
                </li>
              ))}
            </ul>
            {members.length > MEMBERS_PREVIEW && (
              <button data-testid="members-more" onClick={() => setAllMembers((v) => !v)}
                className="mt-1 text-2xs text-accent hover:underline">
                {allMembers ? `show the first ${MEMBERS_PREVIEW} only`
                            : `show all ${members.length}`}
              </button>
            )}
          </section>

          {c.criterion2 && (
            <section data-testid="cluster-c2-section">
              <Criterion2ModuleLine c2={c.criterion2} testid="cluster-c2" />
            </section>
          )}

          <section data-testid="cluster-connections">
            <SectionHeading as="div">Connections</SectionHeading>
            <p className="text-2xs text-fg-muted" data-testid="cluster-cohesion-line">
              {c.cohesion.innen} links inside · {c.cohesion.aussen} leaving
              {c.cohesion.corr_innen != null && <> · mean r inside {c.cohesion.corr_innen.toFixed(3)}</>}
              {c.cohesion.corr_aussen != null && <>, outside {c.cohesion.corr_aussen.toFixed(3)}</>}
            </p>

            {c.cohesion.aussen === 0 ? (
              <p className="mt-1 text-fg" data-testid="cluster-isolated">
                Nothing. All {c.cohesion.innen} of its links stay inside — this cluster is a
                separate piece of the network.
              </p>
            ) : (
              <div className="mt-1 space-y-2">
                <ClusterNet label={label} partners={byPartner}
                  onOpenCluster={onOpenCluster} onOpenEdge={onOpenEdge} />
                {(() => {
                  const gelistet = byPartner.reduce((a, p) => a + p.total, 0);
                  const fehlt = c.cohesion.aussen - gelistet;
                  return fehlt > 0 ? (
                    <p className="text-xs text-warn" data-testid="cluster-partners-cut">
                      {fehlt} more leaving link{fehlt === 1 ? " is" : "s are"} not listed below: to
                      ASVs without a module, or past a partner list cut short by the server.
                    </p>
                  ) : null;
                })()}
                {byPartner.map(({ partner, total, edges }) => {
                  const open = openPartners.has(partner);
                  const visible = open ? edges : edges.slice(0, PREVIEW);
                  return (
                  <div key={partner} className="rounded border border-line bg-surface/50">
                    <div className="flex items-baseline gap-2 px-2 py-1">
                      <Swatch n={partner} />
                      <button data-testid="bridge-partner"
                        onClick={() => onOpenCluster?.(partner)} disabled={!onOpenCluster}
                        className="text-fg hover:underline disabled:hover:no-underline">
                        {modules.label(partner)}
                      </button>
                      <span className="text-xs text-fg-muted ml-auto tabular-nums">
                        {total} link{total === 1 ? "" : "s"}
                      </span>
                    </div>
                    <ul className="px-2 pb-2 text-xs">
                      {visible.map((e) => (
                        <li key={`${e.mine}-${e.other}`} className="flex items-center gap-1">
                          <Swatch n={label} />
                          <button data-testid="bridge-asv" onClick={() => onOpenAsv?.(e.mine)}
                            disabled={!onOpenAsv}
                            className="font-mono text-accent hover:underline shrink-0 truncate">
                            {e.mine}
                            {e.mine_genus && <span className="text-fg-muted font-sans"> ({e.mine_genus})</span>}
                          </button>
                          <button data-testid="bridge-edge"
                            onClick={() => onOpenEdge?.({ source: e.mine, target: e.other, type: "con" })}
                            disabled={!onOpenEdge}
                            title="open this link"
                            className="text-fg-muted hover:text-accent tabular-nums px-1 shrink-0">
                            — {e.corr.toFixed(2)} —
                          </button>
                          <Swatch n={e.other_cluster} />
                          <button data-testid="bridge-asv" onClick={() => onOpenAsv?.(e.other)}
                            disabled={!onOpenAsv}
                            className="font-mono text-accent hover:underline shrink-0 truncate">
                            {e.other}
                            {e.other_genus && <span className="text-fg-muted font-sans"> ({e.other_genus})</span>}
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
                        className="w-full px-2 pb-1 text-left text-2xs text-accent hover:underline">
                        {open ? "show the strongest 3 only"
                              : `show ${edges.length - PREVIEW} more`}
                      </button>
                    )}
                    {total > edges.length && (
                      <p className="px-2 pb-1 text-2xs text-fg-muted" data-testid="bridge-capped">
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

          <NoteBox key={`${datasetId}/${label}`} testid="cluster-note" value={c.note?.n ?? null}
            savedAt={c.note?.t ?? null} readOnly={!signedIn} draftKey={`${datasetId}/cluster/${label}`}
            onSave={(t, o) => setClusterNote(datasetId, label, t, o)
              .then((r) => setC((cur) => (cur ? { ...cur, note: { n: r.note, t: r.note_at } } : cur)))} />

          <p className="text-2xs text-fg-muted" data-testid="cluster-source">
            <span data-testid="cluster-source-citation">&ldquo;Community cluster&rdquo; and Louvain after {c.source_publication.citation}</span>
          </p>
          <ProvenanceFooter datasetId={datasetId} />
        </div>
      )}
    </div>
  );
}

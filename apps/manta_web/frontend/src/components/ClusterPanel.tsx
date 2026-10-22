import { Button, StateNotice, ToggleButton } from "./ui";
import { useEffect, useMemo, useState } from "react";
import { getCluster, setClusterNote, setClusterStar, type ClusterDetail } from "../api";
import type { EdgeRef } from "../App";
import type { InspectMark } from "./ComparePanel";
import ClusterNet from "./ClusterNet";
import { useModules } from "../modules";
import { setClusterLabel } from "../api";
import FrequencyPanel from "./FrequencyPanel";
import NoteBox from "./NoteBox";
import ErrorNotice from "./ErrorNotice";
import { PanelHeader } from "./PanelFrame";
import { KEYSTONE_LABEL, type KeystoneCrit } from "../networkFilters";
import StarButton from "./StarButton";

export default function ClusterPanel({ datasetId, label, color, onClose, onOpenAsv, onOpenEdge,
                                       onOpenCluster, onInspectAt, colorOf, crit = 2, c1Ids,
                                       isAdmin = false, signedIn = true }: {
  datasetId: string;
  label: number;
  isAdmin?: boolean;
  color?: string;
  onClose: () => void;
  onOpenAsv?: (id: string) => void;
  onOpenEdge?: (e: EdgeRef) => void;
  onOpenCluster?: (label: number) => void;
  onInspectAt?: (sample: string, mark?: InspectMark) => void;
  colorOf?: (label: number) => string | undefined;
  crit?: KeystoneCrit;
  c1Ids?: Set<string>;
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
  const [genusFilter, setGenusFilter] = useState<string | null>(null);

  useEffect(() => {
    setC(null); setErr(null); setGenusFilter(null);
    setPartner(null); setAllGenera(false); setAllMembers(false);
    let alive = true;
    getCluster(datasetId, label).then((x) => { if (alive) setC(x); })
      .catch((e) => { if (alive) setErr(e); });
    return () => { alive = false; };
  }, [datasetId, label, nochmal]);
  useEffect(() => {
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
  const [partner, setPartner] = useState<number | null>(null);
  const GENERA_PREVIEW = 12;
  const MEMBERS_PREVIEW = 30;
  const [allGenera, setAllGenera] = useState(false);
  const [allMembers, setAllMembers] = useState(false);

  const genera = useMemo(
    () => Object.entries(c?.taxa_breakdown.genus ?? {}).sort((a, b) => b[1] - a[1]),
    [c]);
  const keystone = (m: ClusterDetail["members"][number], k: KeystoneCrit) =>
    k === 1 ? !!c1Ids?.has(m.id) : !!m.criterion2?.passes;
  const anders: KeystoneCrit = crit === 1 ? 2 : 1;
  const members = useMemo(
    () => (c?.members ?? []).filter((m) => !genusFilter || m.genus === genusFilter)
      .sort((a, b) => Number(keystone(b, crit)) - Number(keystone(a, crit))
        || Number(keystone(b, anders)) - Number(keystone(a, anders))
        || a.id.localeCompare(b.id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [c, genusFilter, crit, c1Ids]);

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
            <h3 className="text-fg font-medium mb-2">Relative abundance (%)</h3>
            <FrequencyPanel freq={c.frequency} color={color} testid="cluster-frequency"
              onPointClick={onInspectAt
                ? (sample) => onInspectAt(sample, { kind: "cluster", id: String(label) })
                : undefined} />
          </section>

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
                    {keystone(m, crit) ? (
                      <span data-testid="member-keystone" title={`keystone · ${KEYSTONE_LABEL[crit]}`}
                        className="ml-1 text-mark">✦</span>
                    ) : keystone(m, anders) && (
                      <span data-testid="member-keystone-other" title={`keystone only under ${KEYSTONE_LABEL[anders]}`}
                        className="ml-1 text-mark opacity-40">✦</span>
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

          <section data-testid="cluster-connections">
            <h3 className="text-fg font-medium mb-1">Neighbours</h3>

            {c.cohesion.aussen === 0 ? (
              <p className="mt-1 text-fg-muted" data-testid="cluster-isolated">no connections</p>
            ) : (
              <div className="mt-1 space-y-2">
                <ClusterNet label={label} partners={byPartner} selected={partner}
                  onPick={(n) => setPartner((cur) => (cur === n ? null : n))}
                  onOpenCluster={onOpenCluster} />
                {byPartner.filter((b) => b.partner === partner).map(({ partner, edges }) => (
                  <div key={partner} className="rounded border border-line bg-surface/50"
                    data-testid="bridge-bundle">
                    <ul className="px-2 py-1 text-xs">
                      {edges.map((e) => (
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
                  </div>
                ))}
              </div>
            )}
          </section>

          <NoteBox key={`${datasetId}/${label}`} testid="cluster-note" value={c.note?.n ?? null}
            savedAt={c.note?.t ?? null} readOnly={!signedIn} draftKey={`${datasetId}/cluster/${label}`}
            onSave={(t, o) => setClusterNote(datasetId, label, t, o)
              .then((r) => setC((cur) => (cur ? { ...cur, note: { n: r.note, t: r.note_at } } : cur)))} />

        </div>
      )}
    </div>
  );
}

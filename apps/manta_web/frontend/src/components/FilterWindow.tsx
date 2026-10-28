import { useMemo, useState } from "react";
import { errorText, getStarred, type Network, type NetNode } from "../api";
import { ABUNDANCE_STEPS, type Filters, type OccurrenceFilter } from "../networkFilters";
import { Segmented, SliderNumber } from "./controls";
import { Button, ToggleButton } from "./ui";
import { TAX_RANKS } from "./NetworkSidebar";
import { useModules } from "../modules";

export type WindowKind = "modules" | "asvs" | "abundance" | "strength" | "occurrence" | "taxon" | "presence";

export const WINDOW_TITLE: Record<WindowKind, string> = {
  modules: "Module filter", asvs: "ASV filter", abundance: "Abundance filter", strength: "Link strength filter",
  occurrence: "Occurrence filter", taxon: "Taxon filter", presence: "Presence filter",
};

const MONTHS = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];
const OCC_START: OccurrenceFilter = { from: null, to: null, months: [], share: 0.1, min: 1 };
const ROW = "grid grid-cols-[4.5rem_1fr] items-center gap-x-2 gap-y-2 text-xs";
const SELECT = "flex-1 min-w-0 px-1 py-1 rounded bg-control border border-line-strong text-xs text-fg";

export default function FilterWindow({ kind, net, filters, onFilters, dates, nSamples, datasetId,
                                       occError, onOpenModule }: {
  kind: WindowKind;
  net: Network;
  filters: Filters;
  onFilters: (patch: Partial<Filters>) => void;
  dates: string[];
  nSamples: number;
  datasetId: string;
  occError: unknown;
  onOpenModule?: (label: number) => void;
}) {
  const modules = useModules();
  const clusters = useMemo(() => [...new Set(net.nodes.map((n) => n.cluster))].sort((a, b) => a - b), [net]);
  const perCluster = useMemo(() => {
    const m = new Map<number, number>();
    net.nodes.forEach((n) => m.set(n.cluster, (m.get(n.cluster) ?? 0) + 1));
    return m;
  }, [net]);
  const f = filters;
  const [q, setQ] = useState("");
  const [taxRank, setTaxRank] = useState(f.taxon?.rank ?? "genus");
  const [taxValue, setTaxValue] = useState(f.taxon?.value ?? "");
  const byId = useMemo(() => new Map(net.nodes.map((n) => [n.id, n])), [net]);
  const ids = f.asvs?.ids ?? [];
  const hits = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return [];
    return net.nodes.filter((n) => !ids.includes(n.id)
      && [n.id, n.genus, n.species].some((v) => v?.toLowerCase().includes(s))).slice(0, 6);
  }, [q, net, ids]);
  const name = (n: NetNode) => n.species ?? n.genus ?? "";
  const setIds = (next: string[]) => {
    const uniq = [...new Set(next)];
    onFilters({ asvs: uniq.length || f.asvs ? { ids: uniq, neighbors: f.asvs?.neighbors ?? false,
      expand: (f.asvs?.expand ?? []).filter((id) => uniq.includes(id)) } : null });
  };
  const unknown = ids.filter((id) => !byId.has(id));
  const [starredNote, setStarredNote] = useState<string | null>(null);
  const taxValues = useMemo(() => [...new Set(net.nodes
    .map((n) => (n as unknown as Record<string, string | null>)[taxRank])
    .filter((v) => v && v !== "unassigned"))].sort() as string[],
  [net, taxRank]);
  const o = f.occurrence ?? OCC_START;
  const samplesIn = (x: OccurrenceFilter) => dates.filter((d) => (x.from == null || d >= x.from)
    && (x.to == null || d <= x.to)
    && (x.months.length === 0 || x.months.includes(Number(d.slice(5, 7))))).length;
  const nInPeriod = samplesIn(o);
  const setOcc = (patch: Partial<OccurrenceFilter>) => {
    const next = { ...o, ...patch };
    const n = samplesIn(next);
    onFilters({ occurrence: dates.length ? { ...next, min: Math.max(1, Math.min(next.min, n)) } : next });
  };

  return (
    <div data-testid={`filter-window-${kind}`} className="p-3 text-fg">
      {kind === "modules" && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-1">
            <Button variant="ghost" data-testid="cluster-all"
              onClick={() => onFilters({ hidden: new Set() })}>all</Button>
            <Button variant="ghost" data-testid="cluster-none"
              onClick={() => onFilters({ hidden: new Set(clusters) })}>none</Button>
          </div>
          <div data-testid="cluster-list" className="flex flex-col gap-1 max-h-96 overflow-auto">
            {clusters.map((c) => (
              <div key={c} className="flex items-center gap-2 text-sm text-fg">
                <input type="checkbox" data-testid={`cluster-check-${c}`}
                  aria-label={`show ${modules.label(c)}`}
                  checked={!f.hidden.has(c)}
                  onChange={(e) => {
                    const next = new Set(f.hidden);
                    if (e.target.checked) next.delete(c); else next.add(c);
                    onFilters({ hidden: next });
                  }} />
                <span data-testid="cluster-swatch" className="inline-block w-3 h-3 rounded-sm shrink-0"
                  style={{ background: modules.color(c) }} />
                <button data-testid={`cluster-open-${c}`} onClick={() => onOpenModule?.(c)}
                  className="flex-1 text-left hover:underline">{modules.label(c)}</button>
                <span className="text-xs text-fg-muted tabular-nums">{perCluster.get(c) ?? 0}</span>
              </div>
            ))}
          </div>
          {net.partition?.clusters_are_components && (
            <p className="text-xs text-warn leading-snug" data-testid="partition-note">
              These {net.partition.n_clusters} clusters are exactly the{" "}
              {net.partition.n_components} unconnected parts of this network — no link crosses a
              cluster border.
            </p>
          )}
        </div>
      )}

      {kind === "asvs" && (
        <div className="flex flex-col gap-2">
          <input data-testid="fw-asv-input" value={q} onChange={(e) => setQ(e.target.value)} autoFocus
            placeholder="ASV, taxon or a list of ASVs …"
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              const tokens = q.split(/[\s,;]+/).filter(Boolean);
              if (tokens.length > 1) { setIds([...ids, ...tokens]); setQ(""); }
              else if (hits.length === 1) { setIds([...ids, hits[0].id]); setQ(""); }
            }}
            className="w-full px-2 py-1 rounded bg-control border border-line-strong text-xs text-fg" />
          {hits.length > 0 && (
            <div className="rounded border border-line bg-overlay py-1">
              {hits.map((n) => (
                <button key={n.id} onClick={() => { setIds([...ids, n.id]); setQ(""); }}
                  className="flex w-full gap-2 px-2 py-1 text-xs text-left hover:bg-control">
                  <span className="font-mono text-accent">{n.id}</span>
                  <span className="text-fg-muted">{name(n)}</span>
                </button>
              ))}
            </div>
          )}
          {ids.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {ids.map((id) => (
                <span key={id} className="inline-flex items-center gap-1 text-xs rounded-full border border-line-strong px-2 py-0.5">
                  <span className="font-mono">{id}</span>
                  <span className="text-fg-muted">{byId.get(id) ? name(byId.get(id)!) : ""}</span>
                  <button onClick={() => setIds(ids.filter((x) => x !== id))}
                    className="text-fg-muted hover:text-fg" aria-label={`remove ${id}`}>×</button>
                </span>
              ))}
            </div>
          )}
          {unknown.length > 0 && (
            <p data-testid="fw-asv-unknown" className="text-xs text-warn break-all">
              not in this network, ignored: {unknown.join(", ")}
            </p>
          )}
          <div className="flex items-center gap-2">
            <Button data-testid="fw-asv-starred"
              onClick={() => getStarred(datasetId).then((d) => {
                const add = d.asvs.map((a) => a.id);
                setStarredNote(add.length ? null
                  : d.note ?? "nothing starred by this account in this dataset");
                if (add.length) setIds([...ids, ...add]);
              }).catch(() => setStarredNote("could not load the starred list"))}>
              ★ my starred
            </Button>
            {starredNote && <span className="text-2xs text-fg-muted">{starredNote}</span>}
          </div>
          <Segmented full value={f.asvs?.neighbors ? "n" : "o"}
            onChange={(v) => f.asvs && onFilters({ asvs: { ...f.asvs, neighbors: v === "n" } })}
            options={[{ value: "o", label: "only these" }, { value: "n", label: "+ neighbours" }]} />
        </div>
      )}

      {kind === "abundance" && (
        <div className="flex flex-col gap-2">
          <SliderNumber testid="fw-abundance-min" label="minimum mean relative abundance"
            min={0} max={100} steps={ABUNDANCE_STEPS} value={f.abundance} fallback={0.1}
            onChange={(v) => onFilters({ abundance: v })} prefix="≥" suffix="%" />
          <SliderNumber testid="fw-abundance-max" label="maximum mean relative abundance"
            min={0} max={100} steps={[...ABUNDANCE_STEPS, 10, 50, 100]} value={f.abundanceMax}
            fallback={100} onChange={(v) => onFilters({ abundanceMax: v })} prefix="≤" suffix="%" />
        </div>
      )}

      {kind === "strength" && (
        <div className="flex flex-col gap-2">
          <span className="text-xs text-fg-muted">Link (con)</span>
          <SliderNumber testid="fw-strength-min" label="minimum r" min={0} max={1} step={0.01}
            value={f.strength} fallback={0.7} onChange={(v) => onFilters({ strength: v })} prefix="r ≥" />
          <SliderNumber testid="fw-strength-max" label="maximum r" min={0} max={1} step={0.01}
            value={f.strengthMax} fallback={1} onChange={(v) => onFilters({ strengthMax: v })} prefix="r ≤" />
          <span className="mt-1 text-xs text-fg-muted">Direction (ccm)</span>
          <SliderNumber testid="fw-nmi" label="minimum NMI of a kept direction" min={0} max={1} step={0.01}
            value={f.nmi} fallback={0} onChange={(v) => onFilters({ nmi: v })} prefix="NMI ≥" />
        </div>
      )}

      {kind === "occurrence" && occError != null && (
        <p className="mb-2 text-xs text-warn">could not load occurrence data: {errorText(occError)}</p>
      )}
      {kind === "occurrence" && (
        <div className={ROW}>
          <span className="text-fg-muted">period</span>
          <span className="flex gap-1">
            <select value={o.from ?? ""} onChange={(e) => setOcc({ from: e.target.value || null })} className={SELECT}>
              <option value="">first sample</option>
              {[...new Set(dates)].map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
            <select value={o.to ?? ""} onChange={(e) => setOcc({ to: e.target.value || null })} className={SELECT}>
              <option value="">last sample</option>
              {[...new Set(dates)].map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </span>
          <span className="text-fg-muted">months</span>
          <span className="flex gap-0.5">
            {MONTHS.map((m, i) => {
              const on = o.months.includes(i + 1);
              return (
                <ToggleButton key={i} pressed={on} className="!px-1 flex-1 justify-center"
                  title={new Date(2000, i, 1).toLocaleString("en", { month: "long" })}
                  onClick={() => setOcc({ months: on ? o.months.filter((x) => x !== i + 1)
                                                     : [...o.months, i + 1].sort((a, b) => a - b) })}>
                  {m}
                </ToggleButton>
              );
            })}
          </span>
          <span className="text-fg-muted">present</span>
          <SliderNumber testid="fw-occ-share" label="present means share at least"
            min={0} max={100} steps={ABUNDANCE_STEPS} value={o.share} fallback={0.1}
            onChange={(v) => setOcc({ share: v })} prefix="share ≥" suffix="%" />
          <span className="text-fg-muted">how often</span>
          <SliderNumber testid="fw-occ-min" label="in at least this many samples"
            min={1} max={Math.max(1, nInPeriod)} value={o.min} fallback={1}
            onChange={(v) => setOcc({ min: Math.round(v) })} prefix="in ≥" suffix={`of ${nInPeriod} samples`} />
        </div>
      )}

      {kind === "taxon" && (
        <div className="flex gap-1">
          <select value={taxRank} onChange={(e) => setTaxRank(e.target.value)} className={SELECT + " !flex-none"}>
            {TAX_RANKS.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          <input list="fw-tax-values" value={taxValue} placeholder="value …"
            onChange={(e) => {
              setTaxValue(e.target.value);
              if (taxValues.includes(e.target.value)) onFilters({ taxon: { rank: taxRank, value: e.target.value } });
              if (!e.target.value) onFilters({ taxon: null });
            }}
            className={SELECT} />
          <datalist id="fw-tax-values">{taxValues.map((v) => <option key={v} value={v} />)}</datalist>
        </div>
      )}

      {kind === "presence" && (
        <SliderNumber testid="fw-presence" label="minimum number of samples"
          min={1} max={Math.max(1, nSamples)} value={f.presence} fallback={1}
          onChange={(v) => onFilters({ presence: Math.round(v) })} prefix="≥" suffix={`of ${nSamples} samples`} />
      )}
    </div>
  );
}

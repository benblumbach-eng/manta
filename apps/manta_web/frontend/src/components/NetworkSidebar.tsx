import { useEffect, useMemo, useState } from "react";
import { getStarred, type Capabilities, type Dataset, type HubCriterion,
         type Network, type NetNode, type Thresholds } from "../api";
import DataAvailability from "./DataAvailability";
import { useModules } from "../modules";
import ProvenanceFooter from "./ProvenanceFooter";
import { isActive, type Filters, type FilterKind, type LegendRow, layerLabel, layersDefault, functionLabel } from "../networkFilters";


export const TAX_RANKS = ["species", "genus", "family", "order", "class", "phylum", "kingdom"];

export type ViewItem = {
  key: string; testid: string; label: string; icon: string; open: boolean;
  onOpen: () => void;
  disabledReason: string | null;
};

export type SidebarProps = {
  dataset: Dataset;
  caps: Capabilities | null;
  net: Network | null;
  hub: HubCriterion | null;
  thr: Thresholds | undefined;
  visibleNodes: NetNode[];
  clusters: number[];
  clusterColor: Map<number, string>;
  countByCluster: Map<number, number>;
  filters: Filters;
  onFilters: (patch: Partial<Filters>) => void;
  onClearKind: (k: FilterKind) => void;
  onClearAll: () => void;
  order: FilterKind[];
  chipCounts: Map<FilterKind, number>;
  unknownAsvIds: string[];
  counts: { nodes: number; edges: number; cross: number; ccm: number; rejected?: number };
  taxaMode: boolean;
  onTaxaMode: (v: boolean) => void;
  linkLength: number;
  linkLengthDefault: number;
  onLinkLength: (v: number) => void;
  colorMode: "module" | "function";
  onColorMode: (m: "module" | "function") => void;
  functionClasses: { label: string; n: number; color: string }[];
  taxaLayers: { n_con: number; n_asv_con: number;
                n_con_with_ccm: number; n_asv_ccm: number;
                n_con_with_rejected: number; n_asv_rejected: number } | null;
  legend: LegendRow[];
  sizeAbsent: boolean;
  widthText: string | null;
  thresholds: string;
  views: { anyViewOpen: boolean; onShowNet: () => void; items: ViewItem[] };
  onPickAsv: (id: string) => void;
  onPickTaxon: (rank: string, value: string) => void;
  onPickCluster: (label: number) => void;
  onOpenClusterPanel: (label: number) => void;
};

const LEGEND_TESTID: Record<string, string> = {
  node: "legend-node", size: "size-legend", edge: "legend-edge", ccm: "legend-ccm",
  width: "edge-width-legend", hub: "hub-legend", highlight: "legend-highlight",
};

export default function NetworkSidebar(p: SidebarProps) {
  const { dataset, caps, net, hub, thr, visibleNodes, filters } = p;
  const modules = useModules();

  const [infoOpen, setInfoOpen] = useState(false);
  const [legendOpen, setLegendOpen] = useState(() => {
    try { return localStorage.getItem("manta-legend") === "1"; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem("manta-legend", legendOpen ? "1" : "0"); } catch { }
  }, [legendOpen]);
  useEffect(() => { setInfoOpen(false); }, [dataset.dataset_id]);
  const timeWord = caps ? (caps.time_axis === "dates" ? "calendar dates" : "ordinal") : null;

  const [search, setSearch] = useState("");
  const [lenDraft, setLenDraft] = useState(p.linkLength);
  useEffect(() => { setLenDraft(p.linkLength); }, [p.linkLength]);
  useEffect(() => {
    if (lenDraft === p.linkLength) return;
    const t = setTimeout(() => p.onLinkLength(lenDraft), 300);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lenDraft]);
  const q = search.trim();
  const results = useMemo(
    () => (q
      ? visibleNodes.filter((n) => n.id.startsWith(q)
          || (n.genus ?? "").toLowerCase().includes(q.toLowerCase()))
      : []),
    [q, visibleNodes]);
  const taxMatches = useMemo(() => {
    const ql = q.toLowerCase();
    if (ql.length < 2) return [] as { rank: string; value: string; n: number }[];
    const counts = new Map<string, number>();
    for (const n of visibleNodes) {
      const rec = n as unknown as Record<string, unknown>;
      for (const rank of TAX_RANKS) {
        const v = rec[rank];
        if (typeof v === "string" && v && v !== "unassigned" && v.toLowerCase().includes(ql)) {
          counts.set(`${rank}:${v}`, (counts.get(`${rank}:${v}`) ?? 0) + 1);
        }
      }
    }
    return [...counts.entries()]
      .map(([key, n]) => {
        const i = key.indexOf(":");
        return { rank: key.slice(0, i), value: key.slice(i + 1), n };
      })
      .sort((a, b) => b.n - a.n || a.value.localeCompare(b.value))
      .slice(0, 8);
  }, [q, visibleNodes]);
  const clusterMatch = useMemo(() => {
    const m = /^c(?:luster)?\s*(\d+)$/i.exec(q);
    if (!m) return null;
    const label = Number(m[1]);
    return p.clusters.includes(label) ? label : null;
  }, [q, p.clusters]);

  const [addOpen, setAddOpen] = useState(false);
  const [taxonOpen, setTaxonOpen] = useState(isActive(filters, "taxon"));
  const [functionOpen, setFunctionOpen] = useState(isActive(filters, "function"));
  const [asvOpen, setAsvOpen] = useState(isActive(filters, "asvs"));
  const [sizeOpen, setSizeOpen] = useState(isActive(filters, "size"));
  const [strengthOpen, setStrengthOpen] = useState(isActive(filters, "strength"));
  const [taxRank, setTaxRank] = useState("genus");
  const [taxValue, setTaxValue] = useState("");
  const [asvText, setAsvText] = useState(filters.asvs?.ids.join("\n") ?? "");
  const [starredNote, setStarredNote] = useState<string | null>(null);
  useEffect(() => {
    if (isActive(filters, "taxon")) setTaxonOpen(true);
    if (isActive(filters, "function")) setFunctionOpen(true);
    if (isActive(filters, "asvs")) setAsvOpen(true);
    if (isActive(filters, "size")) setSizeOpen(true);
    if (isActive(filters, "strength")) setStrengthOpen(true);
  }, [filters]);

  const anyActive = p.order.length > 0;
  const visibleClusters = p.clusters.filter((c) => !filters.hidden.has(c));

  const chipLabel = (k: FilterKind): string => {
    switch (k) {
      case "modules":
        return "Modules " + (visibleClusters.length <= 4
          ? visibleClusters.join(", ")
          : `${visibleClusters.length} of ${p.clusters.length}`);
      case "layer": return layerLabel(filters.layers);
      case "cross": return "crossing only";
      case "hubs": return hub ? `Hubs (${hub.measure_label}, μ+${hub.k}σ)` : "Hubs";
      case "function": return `Function: ${functionLabel(filters.fn ?? "")}`;
      case "taxon": return filters.taxon ? `${filters.taxon.value} (${filters.taxon.rank})` : "Taxon";
      case "asvs": {
        const valid = (filters.asvs?.ids.length ?? 0) - p.unknownAsvIds.length;
        return `ASVs: ${valid}${filters.asvs?.neighbors ? " +neighbours" : ""}`;
      }
      case "size": return filters.size
        ? `size: ${filters.size.dir === "top" ? "largest" : "smallest"} ${filters.size.pct} %`
        : "size";
      case "strength": return filters.strength
        ? `links: ${filters.strength.dir === "top" ? "strongest" : "weakest"} ${filters.strength.pct} % (|r|)`
        : "strength";
    }
  };

  const applyAsvText = (text: string, neighbors?: boolean) => {
    const ids = [...new Set(text.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean))];
    p.onFilters({ asvs: ids.length
      ? { ids, neighbors: neighbors ?? filters.asvs?.neighbors ?? false }
      : null });
  };

  const taxValues = useMemo(() => {
    if (!net) return [] as string[];
    const s = new Set<string>();
    for (const n of net.nodes) {
      const v = (n as unknown as Record<string, unknown>)[taxRank];
      if (typeof v === "string" && v && v !== "unassigned") s.add(v);
    }
    return [...s].sort();
  }, [net, taxRank]);

  return (
    <aside data-testid="network-sidebar"
      className="w-72 border-r border-slate-700 flex flex-col gap-3 p-3 overflow-auto">
      <div>
        <div className="flex items-center gap-1">
          <span className="text-slate-100 font-medium truncate">
            {dataset.region ?? dataset.dataset_id}
          </span>
          <button data-testid="dataset-info-open" onClick={() => setInfoOpen((v) => !v)}
            aria-label="dataset facts"
            className={`text-xs px-1 rounded ${infoOpen
              ? "text-cyan-300" : "text-slate-500 hover:text-slate-300"}`}>ⓘ</button>
        </div>
        <div className="text-xs text-slate-400">
          Marker {dataset.marker ?? "?"} · {dataset.n_sample} samples{timeWord ? ` · ${timeWord}` : ""}
        </div>
        {infoOpen && (
          <div data-testid="dataset-info"
            className="mt-1.5 rounded border border-slate-700 bg-slate-950/60 p-2 space-y-2">
            {caps && <DataAvailability caps={caps} />}
            {thr && (
              <div className="text-[10px] text-slate-500 tabular-nums" data-testid="dataset-info-run">
                {thr.recorded
                  ? <>run {thr.run_id ?? "—"} · computed {thr.computed_at ?? "—"}</>
                  : <>run not recorded — thresholds are defaults</>}
                <br />CON |r| ≥ {thr.con_tr} · p &lt; {thr.con_alpha} · CCM NMI ≥ {thr.ccmn_tr} ·{" "}
                {thr.num_permutations} permutations
              </div>
            )}
          </div>
        )}
      </div>

      <div>
        <div className="text-[10px] uppercase tracking-wide text-slate-500 mb-1">Views</div>
        <div className="flex flex-wrap gap-1">
          <button data-testid="net-tab" onClick={p.views.onShowNet}
            className={`text-xs px-2 py-1 rounded ${!p.views.anyViewOpen
              ? "bg-cyan-700 text-white" : "bg-slate-700 text-slate-200 hover:bg-slate-600"}`}>
            ◉ Network
          </button>
          {p.views.items.map((v) => (
            <button key={v.key} data-testid={v.testid} onClick={v.onOpen}
              title={v.disabledReason ?? undefined}
              className={`text-xs px-2 py-1 rounded ${v.open
                ? "bg-cyan-700 text-white"
                : "bg-slate-700 text-slate-200 hover:bg-slate-600"}${
                v.disabledReason ? " opacity-50" : ""}`}>
              {v.icon} {v.label}
            </button>
          ))}
        </div>
      </div>

      <div>
        <input data-testid="asv-search" value={search} onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && results.length === 1 && taxMatches.length === 0
                && clusterMatch == null) p.onPickAsv(results[0].id);
          }}
          placeholder="search ASV, taxon or cluster …"
          className="w-full px-2 py-1 rounded bg-slate-800 border border-slate-600 text-sm text-slate-100" />
        {(results.length > 0 || taxMatches.length > 0 || clusterMatch != null) && (
          <ul className="mt-1 max-h-40 overflow-auto border border-slate-700 rounded">
            {clusterMatch != null && (
              <li>
                <button data-testid="cluster-result" onClick={() => p.onPickCluster(clusterMatch)}
                  className="w-full text-left px-2 py-1 hover:bg-slate-800 text-sm">
                  <span data-testid="cluster-swatch" className="inline-block w-3 h-3 rounded-sm mr-1 align-middle"
                    style={{ background: p.clusterColor.get(clusterMatch) ?? "#888" }} />
                  <span className="text-slate-100">{modules.label(clusterMatch)}</span>{" "}
                  <span className="text-slate-400">
                    {p.countByCluster.get(clusterMatch) ?? 0} ASVs — mark all
                  </span>
                </button>
              </li>
            )}
            {taxMatches.map((t) => (
              <li key={`${t.rank}:${t.value}`}>
                <button data-testid="tax-result" onClick={() => p.onPickTaxon(t.rank, t.value)}
                  className="w-full text-left px-2 py-1 hover:bg-slate-800 text-sm">
                  <span className="text-amber-300">◌ {t.value}</span>{" "}
                  <span className="text-slate-400">
                    {t.rank} · {t.n} ASV{t.n === 1 ? "" : "s"} — mark all
                  </span>
                </button>
              </li>
            ))}
            {results.map((n) => (
              <li key={n.id}>
                <button data-testid="asv-result" onClick={() => p.onPickAsv(n.id)}
                  className="w-full text-left px-2 py-1 hover:bg-slate-800 text-sm">
                  <span className="inline-block w-2 h-2 rounded-full mr-1.5"
                    style={{ background: p.clusterColor.get(n.cluster) ?? "#888" }} />
                  <span className="text-slate-100">{n.id}</span>{" "}
                  <span className="text-slate-400">{n.genus}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-[10px] uppercase tracking-wide text-slate-500">Filter</span>
          {anyActive && (
            <button data-testid="filter-clear-all" onClick={p.onClearAll}
              className="text-xs text-slate-400 hover:text-cyan-300 underline">clear all</button>
          )}
        </div>
        {anyActive && (
          <div className="flex flex-wrap gap-1 mb-2" data-testid="filter-chips">
            {p.order.map((k) => (
              <span key={k} data-testid={`filter-chip-${k}`}
                className="inline-flex items-center gap-1 text-xs rounded-full border border-cyan-800 bg-cyan-950/50 px-2 py-0.5 text-cyan-200">
                {chipLabel(k)}
                <span className="tabular-nums text-cyan-300"
                  data-testid={`filter-chip-${k}-n`}>{p.chipCounts.get(k) ?? "…"}</span>
                <button data-testid={`filter-chip-${k}-remove`} onClick={() => p.onClearKind(k)}
                  className="text-cyan-400 hover:text-white" aria-label={`remove ${k} filter`}>×</button>
              </span>
            ))}
          </div>
        )}

        <div className="rounded border border-slate-700 bg-slate-950/40 px-2 py-1.5 mb-2">
          <div className="flex items-center justify-between mb-1">
            <div className="text-[10px] uppercase tracking-wide text-slate-500 flex items-center">
              Modules

            </div>
            <div className="flex gap-1">
              <button data-testid="cluster-all" onClick={() => p.onFilters({ hidden: new Set() })}
                className="text-xs px-1.5 py-0.5 rounded bg-slate-700 text-slate-300 hover:bg-slate-600">all</button>
              <button data-testid="cluster-none" onClick={() => p.onFilters({ hidden: new Set(p.clusters) })}
                className="text-xs px-1.5 py-0.5 rounded bg-slate-700 text-slate-300 hover:bg-slate-600">none</button>
            </div>
          </div>
          <div className="flex flex-col gap-1 max-h-40 overflow-auto">
            {p.clusters.map((c) => (
              <div key={c} className="flex items-center gap-2 text-sm text-slate-200">
                <input type="checkbox" data-testid={`cluster-check-${c}`}
                  checked={!filters.hidden.has(c)}
                  onChange={(e) => {
                    const next = new Set(filters.hidden);
                    if (e.target.checked) next.delete(c); else next.add(c);
                    p.onFilters({ hidden: next });
                  }} />
                <span data-testid="cluster-swatch" className="inline-block w-3 h-3 rounded-sm shrink-0"
                  style={{ background: p.clusterColor.get(c) ?? "#888" }} />
                <button data-testid={`cluster-open-${c}`} onClick={() => p.onOpenClusterPanel(c)}
                  className="flex-1 text-left hover:underline">{modules.label(c)}</button>
                <span className="text-xs text-slate-500 tabular-nums">
                  {p.countByCluster.get(c) ?? 0}
                </span>
              </div>
            ))}
          </div>
          {net?.partition?.clusters_are_components && (
            <p className="mt-1 text-[11px] text-amber-400/90 leading-snug" data-testid="partition-note">
              These {net.partition.n_clusters} clusters are exactly the{" "}
              {net.partition.n_components} unconnected parts of this network — no link crosses a
              cluster border.
            </p>
          )}
        </div>

        <div className="flex gap-1 mb-2" data-testid="grain-control">
          <button data-testid="grain-asvs" onClick={() => p.onTaxaMode(false)}
            className={`flex-1 px-2 py-1 rounded text-xs ${!p.taxaMode
              ? "bg-cyan-700 text-white" : "bg-slate-700 text-slate-300 hover:bg-slate-600"}`}>
            ASVs
          </button>
          <button data-testid="grain-taxa" onClick={() => p.onTaxaMode(true)}
            className={`flex-1 px-2 py-1 rounded text-xs ${p.taxaMode
              ? "bg-cyan-700 text-white" : "bg-slate-700 text-slate-300 hover:bg-slate-600"}`}>
            Taxa
          </button>
        </div>
        {p.taxaMode && (
          <p className="mb-2 text-[10px] text-slate-500 leading-snug" data-testid="taxa-note">
            One point per taxon (all seven ranks equal); a line counts member pairs with a link.
          </p>
        )}

        <div className="mb-2" data-testid="link-length-control">
          <div className="flex gap-2 items-center">
            <span className="text-[10px] uppercase tracking-wide text-slate-500">link length</span>
            <input type="range" data-testid="link-length" aria-label="link length"
              min={60} max={900} step={20} value={lenDraft}
              onChange={(e) => setLenDraft(Number(e.target.value))}
              className="flex-1 accent-cyan-600" />
            <span className="w-8 text-right text-xs tabular-nums text-slate-400">{lenDraft}</span>
            <button data-testid="link-length-reset" onClick={() => setLenDraft(p.linkLengthDefault)}
              disabled={lenDraft === p.linkLengthDefault} title="back to the default length"
              className="text-xs text-slate-400 hover:text-white disabled:opacity-30">↺</button>
          </div>
        </div>

        <div className="mb-2" data-testid="color-control">
          <div className="flex gap-1 items-center">
            <span className="text-[10px] uppercase tracking-wide text-slate-500 mr-1">colour</span>
            <button data-testid="color-module" aria-pressed={p.colorMode === "module"}
              onClick={() => p.onColorMode("module")}
              className={`flex-1 px-2 py-1 rounded text-xs ${p.colorMode === "module"
                ? "bg-cyan-700 text-white" : "bg-slate-700 text-slate-300 hover:bg-slate-600"}`}>
              by module
            </button>
            <button data-testid="color-function" aria-pressed={p.colorMode === "function"}
              disabled={!net?.traits?.available}
              title={net?.traits?.available ? undefined
                : (net?.traits?.absent_reason ?? "no literature annotation for this dataset")}
              onClick={() => p.onColorMode("function")}
              className={`flex-1 px-2 py-1 rounded text-xs ${p.colorMode === "function"
                ? "bg-cyan-700 text-white"
                : net?.traits?.available ? "bg-slate-700 text-slate-300 hover:bg-slate-600"
                : "bg-slate-800 text-slate-500 cursor-not-allowed"}`}>
              by function
            </button>

          </div>
          {p.colorMode === "function" && net?.traits?.statement && (
            <p className="mt-1 text-[10px] text-slate-400" data-testid="legend-function-coverage">
              {net.traits.statement}
            </p>
          )}
          {p.colorMode === "function" && net?.traits?.note && (
            <p className="mt-0.5 text-[10px] text-slate-500 leading-snug" data-testid="function-note">
              {net.traits.note.split(". ")[0].replace(/\.?$/, ".")}
            </p>
          )}
        </div>

        <div className="rounded border border-slate-700 bg-slate-950/40 px-2 py-1.5 mb-2" data-testid="layer-control">
          <div className="text-[10px] uppercase tracking-wide text-slate-500 flex items-center">
            Links

          </div>
          <div className="mt-1 flex flex-col gap-1">
            {(() => {
              const L = filters.layers;
              const toggle = (k: "con" | "ccm" | "rejected") =>
                p.onFilters({ layers: { ...L, [k]: !L[k] } });
              const cls = (on: boolean, enabled = true) =>
                `px-2 py-1 rounded text-sm text-left tabular-nums ${on ? "bg-cyan-700 text-white"
                  : enabled ? "bg-slate-700 text-slate-300 hover:bg-slate-600"
                  : "bg-slate-800 text-slate-500 cursor-not-allowed"}`;
              const mark = (on: boolean) => (on ? "☑" : "☐");
              const recorded = !!net?.layers?.ccm_tested_recorded;
              const unit = p.taxaMode ? "taxa" : "ASVs";
              return (
                <>
                  <button data-testid="layer-all" aria-pressed={L.con} onClick={() => toggle("con")}
                    className={cls(L.con)}>
                    {mark(L.con)} Links (con) ·{" "}
                    <span data-testid="layer-n-con">
                      {p.taxaLayers?.n_con ?? net?.layers?.n_con ?? "…"}</span> links ·{" "}
                    <span data-testid="layer-asv-con">
                      {p.taxaLayers?.n_asv_con ?? net?.layers?.n_asv_con ?? "…"}</span> {unit}
                  </button>
                  <button data-testid="layer-ccm" aria-pressed={L.ccm} onClick={() => toggle("ccm")}
                    className={cls(L.ccm)}>
                    {mark(L.ccm)} Direction (ccm) ·{" "}
                    <span data-testid="layer-n-ccm">
                      {p.taxaLayers?.n_con_with_ccm ?? net?.layers?.n_con_with_ccm ?? "…"}</span>{" "}
                    links ·{" "}
                    <span data-testid="layer-asv-ccm">
                      {p.taxaLayers?.n_asv_ccm ?? net?.layers?.n_asv_ccm ?? "…"}</span> {unit}
                  </button>
                  <button data-testid="layer-rejected" aria-pressed={L.rejected} disabled={!recorded}
                    onClick={() => toggle("rejected")} className={cls(L.rejected, recorded)}>
                    {mark(L.rejected)} ⇢ Rejected (ccm) ·{" "}
                    <span data-testid="layer-n-rejected">
                      {recorded
                        ? (p.taxaLayers?.n_con_with_rejected ?? net?.layers?.n_con_with_rejected ?? "…")
                        : "—"}</span>{" "}
                    links ·{" "}
                    <span data-testid="layer-asv-rejected">
                      {recorded
                        ? (p.taxaLayers?.n_asv_rejected ?? net?.layers?.n_asv_rejected ?? "…")
                        : "—"}</span> {unit}
                  </button>
                </>
              );
            })()}
            {net?.layers && (net.layers.ccm_tested_recorded ? (
              <p className="text-[10px] text-slate-500 tabular-nums leading-snug" data-testid="layer-tested-note">
                OTTER tested {net.layers.n_ccm_tested} directions (each link both ways);{" "}
                {net.layers.n_ccm_rejected} rejected at p ≥ 0.05.
              </p>
            ) : (
              <p className="text-[10px] text-slate-500 leading-snug" data-testid="layer-tested-note">
                Rejected directions not recorded for this dataset (no PV table in its run).
              </p>
            ))}
            {net?.layers && !net.layers.ccm_tested_recorded && (
              <p data-testid="rejected-not-recorded" className="text-[10px] text-amber-400 leading-snug">
                rejected directions not recorded for this dataset
              </p>
            )}
          </div>
          {filters.layers.rejected && (
            <p data-testid="rejected-caveat" className="mt-1 text-xs text-amber-400 leading-snug">
              Dashed arrows: directions OTTER tested and <strong>rejected</strong> (p ≥ 0.05 in
              its permutation test) — no arrow in the kept network; where the line itself is
              drawn, the rejected direction bends beside it. Same CCM caveat: predictive value,
              no convergence test, no evidence of causation.
            </p>
          )}
          {filters.layers.ccm && !layersDefault(filters.layers) && (
            <p data-testid="ccm-caveat" className="mt-1 text-xs text-amber-400 leading-snug">
              CCM measures directed predictive value (NMI), <strong>without</strong> a convergence
              test — no evidence of causation.
            </p>
          )}
        </div>

        {functionOpen && (
          <div className="rounded border border-slate-700 bg-slate-950/40 px-2 py-1.5 mb-2"
            data-testid="filter-function-section">
            <div className="text-[10px] uppercase tracking-wide text-slate-500 mb-1">Function filter</div>
            {net?.traits?.available ? (
              [...p.functionClasses.map((c) => ({ ...c, key: c.label })),
                { label: "not annotated", key: "", color: "#94a3b8",
                  n: net.nodes.filter((n) => !n.trait_group).length }].map((c) => {
                const on = filters.fn === c.key;
                return (
                  <button key={c.key || "__none"} data-testid="filter-function" data-label={c.key}
                    aria-pressed={on}
                    onClick={() => {
                      p.onFilters({ fn: on ? null : c.key });
                      if (!on) p.onColorMode("function");
                    }}
                    className={`w-full flex items-center gap-1.5 px-1.5 py-0.5 rounded text-xs text-left ${on
                      ? "bg-cyan-800/70 text-white" : "text-slate-300 hover:bg-slate-800"}`}>
                    <span className="inline-block w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: c.color }} />
                    <span className="flex-1 truncate">{c.label}</span>
                    <span className="text-slate-500 tabular-nums">{c.n}</span>
                  </button>
                );
              })
            ) : (
              <p className="text-[10px] text-amber-400 leading-snug" data-testid="filter-function-absent">
                {net?.traits?.absent_reason ?? "no literature annotation for this dataset"}
              </p>
            )}
          </div>
        )}

        {taxonOpen && (
          <div className="rounded border border-slate-700 bg-slate-950/40 px-2 py-1.5 mb-2"
            data-testid="filter-taxon-section">
            <div className="text-[10px] uppercase tracking-wide text-slate-500 mb-1">Taxon filter</div>
            <div className="flex gap-1">
              <select data-testid="filter-tax-rank" value={taxRank}
                onChange={(e) => setTaxRank(e.target.value)}
                className="px-1 py-0.5 rounded bg-slate-800 border border-slate-600 text-xs text-slate-100">
                {TAX_RANKS.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
              <input data-testid="filter-tax-value" list="manta-tax-values" value={taxValue}
                onChange={(e) => {
                  setTaxValue(e.target.value);
                  if (taxValues.includes(e.target.value))
                    p.onFilters({ taxon: { rank: taxRank, value: e.target.value } });
                }}
                placeholder="value …"
                className="flex-1 min-w-0 px-1 py-0.5 rounded bg-slate-800 border border-slate-600 text-xs text-slate-100" />
              <datalist id="manta-tax-values">
                {taxValues.map((v) => <option key={v} value={v} />)}
              </datalist>
            </div>
          </div>
        )}

        {asvOpen && (
          <div className="rounded border border-slate-700 bg-slate-950/40 px-2 py-1.5 mb-2"
            data-testid="filter-asv-section">
            <div className="text-[10px] uppercase tracking-wide text-slate-500 mb-1">ASV selection</div>
            <textarea data-testid="filter-asv-input" value={asvText}
              onChange={(e) => setAsvText(e.target.value)}
              placeholder={"one identifier per line\nor comma-separated"}
              rows={3}
              className="w-full px-1.5 py-1 rounded bg-slate-800 border border-slate-600 text-xs text-slate-100 font-mono" />
            <div className="flex flex-wrap gap-1 mt-1">
              <button data-testid="filter-asv-apply" onClick={() => applyAsvText(asvText)}
                className="text-xs px-1.5 py-0.5 rounded bg-slate-700 text-slate-200 hover:bg-slate-600">
                apply
              </button>
              <button data-testid="filter-asv-starred"
                onClick={() => getStarred(dataset.dataset_id).then((d) => {
                  const ids = d.asvs.map((a) => a.id);
                  setStarredNote(ids.length ? null
                    : d.note ?? "nothing starred by this account in this dataset");
                  setAsvText(ids.join("\n"));
                  applyAsvText(ids.join("\n"));
                }).catch(() => setStarredNote("could not load the starred list"))}
                className="text-xs px-1.5 py-0.5 rounded bg-slate-700 text-slate-200 hover:bg-slate-600">
                ★ my starred
              </button>
              <button data-testid="filter-asv-from-search"
                onClick={() => {
                  const ids = results.map((n) => n.id);
                  setAsvText(ids.join("\n"));
                  applyAsvText(ids.join("\n"));
                }}
                disabled={results.length === 0}
                className="text-xs px-1.5 py-0.5 rounded bg-slate-700 text-slate-200 hover:bg-slate-600 disabled:opacity-40">
                take search hits
              </button>
            </div>
            <label className="flex items-center gap-1.5 mt-1 text-xs text-slate-300 cursor-pointer">
              <input type="checkbox" data-testid="filter-asv-neighbors"
                checked={filters.asvs?.neighbors ?? false}
                onChange={(e) => filters.asvs
                  && p.onFilters({ asvs: { ...filters.asvs, neighbors: e.target.checked } })} />
              + neighbours
            </label>
            {starredNote && <p className="mt-1 text-[10px] text-slate-500">{starredNote}</p>}
            {p.unknownAsvIds.length > 0 && (
              <p data-testid="filter-asv-unknown" className="mt-1 text-[10px] text-amber-400 break-all">
                not in this network, ignored: {p.unknownAsvIds.join(", ")}
              </p>
            )}
          </div>
        )}

        {sizeOpen && (
          <div className="rounded border border-slate-700 bg-slate-950/40 px-2 py-1.5 mb-2"
            data-testid="filter-size-section">
            <div className="text-[10px] uppercase tracking-wide text-slate-500 mb-1">
              Node size (total read count)
            </div>
            <div className="flex items-center gap-2 text-xs text-slate-300">
              <select data-testid="filter-size-dir" value={filters.size?.dir ?? "top"}
                onChange={(e) => p.onFilters({ size: { dir: e.target.value as "top" | "bottom",
                                                       pct: filters.size?.pct ?? 20 } })}
                className="px-1 py-0.5 rounded bg-slate-800 border border-slate-600 text-xs text-slate-100">
                <option value="top">largest</option>
                <option value="bottom">smallest</option>
              </select>
              <input data-testid="filter-size-pct" type="range" min={5} max={100} step={5}
                value={filters.size?.pct ?? 20}
                onChange={(e) => p.onFilters({ size: { dir: filters.size?.dir ?? "top",
                                                       pct: Number(e.target.value) } })}
                className="flex-1" />
              <span className="tabular-nums w-10 text-right" data-testid="filter-size-pct-value">
                {filters.size ? `${filters.size.pct} %` : "—"}
              </span>
            </div>
          </div>
        )}

        {strengthOpen && (
          <div className="rounded border border-slate-700 bg-slate-950/40 px-2 py-1.5 mb-2"
            data-testid="filter-strength-section">
            <div className="text-[10px] uppercase tracking-wide text-slate-500 mb-1">
              Link strength (|r| of the co-occurrence)
            </div>
            <div className="flex items-center gap-2 text-xs text-slate-300">
              <select data-testid="filter-strength-dir" value={filters.strength?.dir ?? "top"}
                onChange={(e) => p.onFilters({ strength: { dir: e.target.value as "top" | "bottom",
                                                           pct: filters.strength?.pct ?? 20 } })}
                className="px-1 py-0.5 rounded bg-slate-800 border border-slate-600 text-xs text-slate-100">
                <option value="top">strongest</option>
                <option value="bottom">weakest</option>
              </select>
              <input data-testid="filter-strength-pct" type="range" min={5} max={100} step={5}
                value={filters.strength?.pct ?? 20}
                onChange={(e) => p.onFilters({ strength: { dir: filters.strength?.dir ?? "top",
                                                           pct: Number(e.target.value) } })}
                className="flex-1" />
              <span className="tabular-nums w-10 text-right" data-testid="filter-strength-pct-value">
                {filters.strength ? `${filters.strength.pct} %` : "—"}
              </span>
            </div>
          </div>
        )}

        <div className="relative">
          <button data-testid="filter-add" onClick={() => setAddOpen((v) => !v)}
            className="text-xs px-2 py-1 rounded border border-slate-600 text-slate-300 hover:border-slate-400">
            + add filter
          </button>
          {addOpen && (
            <div data-testid="filter-add-menu"
              className="absolute z-20 mt-1 w-56 rounded border border-slate-600 bg-slate-900 shadow-xl py-1 text-sm">
              <button data-testid="filter-add-cross"
                onClick={() => { p.onFilters({ crossOnly: !filters.crossOnly }); setAddOpen(false); }}
                className="w-full text-left px-2 py-1 hover:bg-slate-800 text-slate-200">
                {filters.crossOnly ? "✓ " : ""}only module-crossing links
              </button>
              <button data-testid="filter-add-hubs"
                onClick={() => { p.onFilters({ hubsOnly: !filters.hubsOnly }); setAddOpen(false); }}
                className="w-full text-left px-2 py-1 hover:bg-slate-800 text-slate-200">
                {filters.hubsOnly ? "✓ " : ""}only hubs
                {hub && <span className="text-slate-500"> ({hub.measure_label}, μ+{hub.k}σ)</span>}
              </button>
              <button data-testid="filter-add-function"
                onClick={() => { setFunctionOpen(true); setAddOpen(false); }}
                className="w-full text-left px-2 py-1 hover:bg-slate-800 text-slate-200">
                function …
              </button>
              <button data-testid="filter-add-taxon"
                onClick={() => { setTaxonOpen(true); setAddOpen(false); }}
                className="w-full text-left px-2 py-1 hover:bg-slate-800 text-slate-200">
                taxon …
              </button>
              <button data-testid="filter-add-asvs"
                onClick={() => { setAsvOpen(true); setAddOpen(false); }}
                className="w-full text-left px-2 py-1 hover:bg-slate-800 text-slate-200">
                ASV selection …
              </button>
              <button data-testid="filter-add-size" disabled={p.sizeAbsent}
                title={p.sizeAbsent
                  ? "not applicable: this dataset carries no read counts (transformed values)"
                  : undefined}
                onClick={() => { setSizeOpen(true); setAddOpen(false); }}
                className="w-full text-left px-2 py-1 hover:bg-slate-800 text-slate-200 disabled:opacity-40">
                node size …
              </button>
              <button data-testid="filter-add-strength"
                onClick={() => { setStrengthOpen(true); setAddOpen(false); }}
                className="w-full text-left px-2 py-1 hover:bg-slate-800 text-slate-200">
                link strength …
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="mt-auto space-y-2">
        <div className="text-[10px] leading-snug">
          <div className="flex items-center gap-1">
            <button data-testid="legend-toggle" onClick={() => setLegendOpen((v) => !v)}
              aria-expanded={legendOpen}
              className={`uppercase tracking-wide ${legendOpen
                ? "text-slate-300" : "text-slate-500 hover:text-slate-300"}`}>
              legend
            </button>

          </div>
          {legendOpen && (
            <div data-testid="network-legend" className="mt-0.5">
              {p.legend.map((row) => (
                <div key={row.key} data-testid={LEGEND_TESTID[row.key] ?? `legend-${row.key}`}
                  className={`flex items-baseline gap-1.5 py-px ${row.dim ? "opacity-40" : ""}`}>
                  <span className="w-3 shrink-0 text-slate-400">{row.icon}</span>
                  <span className={`w-[3.2rem] shrink-0 text-slate-400${row.struck ? " line-through" : ""}`}>
                    {row.term}
                  </span>
                  <span className={`text-slate-300${row.struck ? " line-through" : ""}`}>{row.desc}</span>
                </div>
              ))}
              {p.widthText && (
                <p data-testid="edge-width-text" className="mt-0.5 text-slate-500">{p.widthText}</p>
              )}
              {p.sizeAbsent && (
                <p data-testid="size-absent-reason" className="mt-0.5 text-slate-500 leading-snug">
                  Size not computed for this dataset: its values are a transform of unknown form.
                </p>
              )}
              <div data-testid="legend-thresholds" className="mt-0.5 text-slate-500 tabular-nums">
                {p.thresholds}
              </div>
              {p.colorMode === "function" && (
                <div data-testid="legend-function" className="mt-0.5">
                  {p.functionClasses.map((c) => (
                    <div key={c.label} data-testid="legend-function-class" data-label={c.label}
                      className="flex items-center gap-1.5 py-px">
                      <span className="inline-block w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: c.color }} />
                      <span className="text-slate-300">{c.label}</span>
                      <span className="text-slate-500 tabular-nums">{c.n}</span>
                    </div>
                  ))}
                  <div className="flex items-center gap-1.5 py-px">
                    <span className="inline-block w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: "#94a3b8" }} />
                    <span className="text-slate-500">not annotated</span>
                  </div>
                </div>
              )}
            </div>
          )}
          <div className="mt-1 text-slate-400 tabular-nums" data-testid="legend-counts">
            <span data-testid="node-count">{p.counts.nodes}</span>{" "}
            {p.taxaMode ? "taxa" : "ASVs"} ·{" "}
            <span data-testid="edge-count">{p.counts.edges}</span> edges ·{" "}
            <span data-testid="ccm-count" className="text-violet-300">{p.counts.ccm}</span> with CCM ·{" "}
            {p.counts.rejected != null && net?.layers?.ccm_tested_recorded && (
              <><span data-testid="rejected-count">{p.counts.rejected}</span> with a rejected direction ·{" "}</>
            )}
            <span data-testid="cross-count" className="text-amber-400">{p.counts.cross}</span> crossing modules
            {hub && !p.taxaMode && <> · <span data-testid="hub-count">{hub.n_marked}</span> hub{hub.n_marked === 1 ? "" : "s"}</>}
          </div>
        </div>

        <div className="text-[10px] text-slate-500" data-testid="position-note">
          Node position: layout, not a measurement
        </div>

        <ProvenanceFooter datasetId={dataset.dataset_id} />
      </div>
    </aside>
  );
}

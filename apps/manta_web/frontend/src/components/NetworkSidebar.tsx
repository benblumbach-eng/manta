import { useEffect, useMemo, useRef, useState } from "react";
import { getAsvList, type Criterion2Summary, type Dataset,
         type Network, type NetNode } from "../api";
import { useModules } from "../modules";
import { occurrenceLabel, rangeLabel, type Filters, type FilterKind, type KeystoneParams, KEYSTONE_DEFAULTS, KEYSTONE_LABEL, layerLabel, layersDefault } from "../networkFilters";
import { useDatasetSearch } from "../datasetSearch";
import { fmtShare } from "../format";
import ErrorNotice from "./ErrorNotice";
import DatasetFacts from "./DatasetFacts";
import { Button, SectionHeading, TextButton, ToggleButton } from "./ui";
import { Segmented, SliderNumber } from "./controls";
import type { WindowKind } from "./FilterWindow";

const WINDOWED: FilterKind[] = ["modules", "asvs", "abundance", "strength", "occurrence", "taxon", "presence"];
const BOX = "rounded-md border border-line bg-raised px-2 py-2 mb-2";

const checkCls = (_on: boolean, enabled = true) =>
  `flex items-center gap-2 rounded px-2 py-1 text-xs text-left tabular-nums ${enabled
    ? "text-fg hover:bg-control" : "text-fg-disabled cursor-not-allowed"}`;
const checkMark = (on: boolean) => (
  <span aria-hidden className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center
    rounded-[3px] border text-2xs leading-none ${on
      ? "border-accent bg-accent-fill text-on-accent" : "border-line-strong"}`}>
    {on ? "✓" : ""}
  </span>
);


export const TAX_RANKS = ["species", "genus", "family", "order", "class", "phylum", "kingdom"];

export type ViewItem = {
  key: string; testid: string; label: string; icon: string; open: boolean;
  onOpen: () => void;
  disabledReason: string | null;
};

export type SidebarProps = {
  dataset: Dataset;
  net: Network | null;
  c2: Criterion2Summary | null;
  kp: KeystoneParams;
  onKp: (patch: Partial<KeystoneParams>) => void;
  nCrit1: number;
  nKey: number;
  visibleNodes: NetNode[];
  clusters: number[];
  clusterColor: Map<number, string>;
  countByCluster: Map<number, number>;
  filters: Filters;
  onFilters: (patch: Partial<Filters>) => void;
  onClearKind: (k: FilterKind) => void;
  onClearAll: () => void;
  onStartNone: () => void;
  onRemoveShown: (what: { asv: string } | { module: number }) => void;
  onToggleModule: (c: number) => void;
  order: FilterKind[];
  chipCounts: Map<FilterKind, number>;
  unknownAsvIds: string[];
  taxaMode: boolean;
  points: "asvs" | "taxa";
  onPoints: (v: "asvs" | "taxa") => void;
  taxonRank: "genus" | "species";
  onTaxonRank: (v: "genus" | "species") => void;
  explore: boolean;
  onExplore: (on: boolean) => void;
  linkLength: number;
  linkLengthDefault: number;
  onLinkLength: (v: number) => void;
  taxaLayers: { n_con: number; n_asv_con: number;
                n_con_with_ccm: number; n_asv_ccm: number;
                n_con_with_rejected: number; n_asv_rejected: number } | null;
  sizeAbsent: boolean;
  views: { anyViewOpen: boolean; onShowNet: () => void; items: ViewItem[] };
  onPickAsv: (id: string) => void;
  onOpenAsv: (id: string) => void;
  onPickTaxon: (rank: string, value: string) => void;
  onPickCluster: (label: number) => void;
  onOpenClusterPanel: (label: number) => void;
  onOpenFilter: (k: WindowKind) => void;
  occurrenceReason: string | null;
  nSamples: number;
};


export default function NetworkSidebar(p: SidebarProps) {
  const { dataset, net, c2, visibleNodes, filters } = p;
  const modules = useModules();


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
  // ASVs are searched in the whole network, so a hidden one can be found and added.
  const shownIds = useMemo(() => new Set(visibleNodes.map((n) => n.id)), [visibleNodes]);
  const results = useMemo(
    () => (q
      ? (net?.nodes ?? []).filter((n) => n.id.toLowerCase().includes(q.toLowerCase())
          || (n.genus ?? "").toLowerCase().includes(q.toLowerCase()))
        .sort((a, b) => (b.rel_abundance ?? 0) - (a.rel_abundance ?? 0))
      : []),
    [q, net]);
  const [searchFocus, setSearchFocus] = useState(false);
  const [topAsvs, setTopAsvs] = useState<{ id: string; cluster: number | null; label: string;
                                           share: number }[]>([]);
  useEffect(() => {
    setTopAsvs([]);
    getAsvList(dataset.dataset_id).then((r) => setTopAsvs(r.asvs.slice(0, 10)))
      .catch(() => setTopAsvs([]));
  }, [dataset.dataset_id]);
  const ganz = useDatasetSearch(dataset.dataset_id, q);
  const [offeneGruppe, setOffeneGruppe] = useState<string | null>(null);
  useEffect(() => { setOffeneGruppe(null); }, [q, dataset.dataset_id]);
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
  const clusterMatches = useMemo(() => {
    const m = /^(?:m|module|c|cluster)\s*(\d*)$/i.exec(q);
    if (!m) return [];
    return p.clusters.filter((c) => String(c).startsWith(m[1]));
  }, [q, p.clusters]);
  const netzLeer = results.length === 0 && taxMatches.length === 0 && clusterMatches.length === 0;

  const [addOpen, setAddOpen] = useState(false);
  const addRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!addOpen) return;
    const taste = (e: KeyboardEvent) => { if (e.key === "Escape") setAddOpen(false); };
    const daneben = (e: MouseEvent) => {
      if (addRef.current && !addRef.current.contains(e.target as Node)) setAddOpen(false);
    };
    document.addEventListener("keydown", taste);
    document.addEventListener("mousedown", daneben);
    return () => {
      document.removeEventListener("keydown", taste);
      document.removeEventListener("mousedown", daneben);
    };
  }, [addOpen]);
  const anyActive = p.order.length > 0;
  const visibleClusters = p.clusters.filter((c) => !filters.hidden.has(c));

  const [collapsed, setCollapsedState] = useState(() => {
    try { return localStorage.getItem("manta-sidebar-collapsed") === "1"; } catch { return false; }
  });
  const setCollapsed = (v: boolean) => {
    setCollapsedState(v);
    try { localStorage.setItem("manta-sidebar-collapsed", v ? "1" : "0"); } catch { }
  };
  const [details, setDetails] = useState(false);
  const [keystoneOpen, setKeystoneOpen] = useState(false);

  const chipLabel = (k: FilterKind): string => {
    switch (k) {
      case "modules":
        return "Modules " + (visibleClusters.length <= 4
          ? visibleClusters.join(", ")
          : `${visibleClusters.length} of ${p.clusters.length}`);
      case "layer": return layerLabel(filters.layers);
      case "cross": return "crossing only";
      case "c2": return "✦ only";
      case "taxon": return filters.taxon ? `${filters.taxon.value} (${filters.taxon.rank})` : "Taxon";
      case "asvs": {
        const ids = (filters.asvs?.ids ?? []).filter((id) => !p.unknownAsvIds.includes(id));
        const mods = filters.asvs?.modules ?? [];
        const modTxt = mods.length ? (ids.length ? " + " : "") + mods.map((c) => modules.label(c)).join(", ") : "";
        if (!ids.length) return mods.length ? `ASVs ${modTxt}` : "ASVs: none yet";
        const ex = filters.asvs?.neighbors ? ids.length
          : (filters.asvs?.expand ?? []).filter((id) => ids.includes(id)).length;
        return "ASVs " + (ids.length <= 3 ? ids.join(", ") : `${ids.length}`)
          + (ex === 0 ? "" : ex === ids.length ? " + partners" : ` + partners of ${ex}`) + modTxt;
      }
      case "presence": return `present in ≥ ${filters.presence ?? 1} samples`;
      case "abundance": return `abundance ${rangeLabel(filters.abundance, filters.abundanceMax, (v) => `${v} %`)}`;
      case "strength": return [
          filters.strength != null || filters.strengthMax != null
            ? `r ${rangeLabel(filters.strength, filters.strengthMax, String)}` : null,
          filters.nmi != null ? `NMI ≥ ${filters.nmi}` : null].filter(Boolean).join(" · ");
      case "occurrence": return filters.occurrence ? occurrenceLabel(filters.occurrence) : "occurrence";
    }
  };

  if (collapsed) {
    return (
      <aside data-testid="network-sidebar-collapsed"
        className="w-11 shrink-0 border-r border-line flex flex-col items-center gap-2 py-3">
        <Button variant="ghost" data-testid="sidebar-expand" title="show the sidebar"
          aria-label="show the sidebar" onClick={() => setCollapsed(false)}>»</Button>
        <ToggleButton data-testid="net-tab" pressed={!p.views.anyViewOpen} onClick={p.views.onShowNet}
          title="Network" className="w-8 justify-center">◉</ToggleButton>
        {p.views.items.map((v) => (
          <ToggleButton key={v.key} data-testid={v.testid} onClick={v.onOpen} pressed={v.open}
            title={v.disabledReason ?? v.label} aria-disabled={v.disabledReason ? true : undefined}
            className={`w-8 justify-center${v.disabledReason ? " text-fg-disabled" : ""}`}>
            {v.icon}
          </ToggleButton>
        ))}
        <div className="mt-2 text-2xs text-accent tabular-nums text-center leading-tight"
          data-testid="sidebar-shown-count" title="ASVs shown">
          {visibleNodes.length}<br />/{net?.nodes.length ?? "…"}
        </div>
      </aside>
    );
  }

  return (
    <aside data-testid="network-sidebar"
      className="w-72 shrink-0 border-r border-line flex flex-col gap-3 p-3 overflow-auto">
      <div className="space-y-2">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-fg truncate">
              {dataset.region ?? dataset.dataset_id}
            </h2>
            <div className="text-xs text-fg-muted" data-testid="dataset-marker">
              Marker {dataset.marker ?? "?"} · {dataset.n_asv} ASVs · {dataset.n_sample} time points{" "}
              <TextButton data-testid="dataset-details" onClick={() => setDetails((v) => !v)}>
                {details ? "hide details" : "details"}</TextButton>
            </div>
          </div>
          <Button variant="ghost" data-testid="sidebar-collapse" title="hide the sidebar"
            aria-label="hide the sidebar" onClick={() => setCollapsed(true)}>«</Button>
        </div>
        {details && <DatasetFacts dataset={dataset} />}
      </div>

      <div>
        <SectionHeading className="mb-1">Views</SectionHeading>
        <div className="grid grid-cols-3 gap-1" data-testid="views-grid">
          <ToggleButton data-testid="net-tab" pressed={!p.views.anyViewOpen} onClick={p.views.onShowNet}
            className="justify-center">
            ◉ Network
          </ToggleButton>
          {p.views.items.map((v) => (
            <ToggleButton key={v.key} data-testid={v.testid} onClick={v.onOpen} pressed={v.open}
              title={v.disabledReason ?? undefined} aria-disabled={v.disabledReason ? true : undefined}
              className={`justify-center${v.disabledReason ? " text-fg-disabled border-dashed" : ""}`}>
              {v.icon} {v.label}
            </ToggleButton>
          ))}
        </div>
      </div>

      <div>
        <SectionHeading className="mb-1" aside={
          <span className="text-xs text-fg tabular-nums" data-testid="shown-count">
            {visibleNodes.length} of {net?.nodes.length ?? "…"} ASVs</span>}>Shown</SectionHeading>
        <div className={`${BOX} space-y-2`} data-testid="shown-section">
          <div className="flex items-center gap-2">
            <span className="text-xs text-fg-muted">start new</span>
            <Button data-testid="start-all" onClick={p.onClearAll}>all ASVs</Button>
            <Button data-testid="start-none" onClick={p.onStartNone}>none</Button>
          </div>
          <div>
          <input data-testid="asv-search" value={search} onChange={(e) => setSearch(e.target.value)}
            onFocus={() => setSearchFocus(true)} onBlur={() => setTimeout(() => setSearchFocus(false), 150)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && results.length === 1 && taxMatches.length === 0
                  && clusterMatches.length === 0) p.onPickAsv(results[0].id);
            }}
            placeholder="search ASV, taxon or module …"
            className="w-full px-2 py-1 rounded-md bg-control border border-line-strong text-sm text-fg placeholder:text-fg-muted" />
          {searchFocus && !q && topAsvs.length > 0 && (
            <div className="mt-1 border border-line rounded-md bg-raised" data-testid="top-asvs">
              <SectionHeading as="h4" className="px-2 pt-1">most abundant ASVs</SectionHeading>
              <ul className="max-h-60 overflow-auto">
                {topAsvs.map((a) => (
                  <li key={a.id}>
                    <button data-testid="top-asv" data-asv={a.id} onMouseDown={(e) => e.preventDefault()}
                      onClick={() => (a.cluster != null ? p.onPickAsv(a.id) : p.onOpenAsv(a.id))}
                      className="w-full flex items-center gap-2 text-left px-2 py-1 hover:bg-control text-sm">
                      <span className="inline-block w-2 h-2 rounded-full shrink-0"
                        style={{ background: (a.cluster != null && p.clusterColor.get(a.cluster)) || "var(--text-disabled)" }} />
                      <span className="text-fg">{a.id}</span>
                      <span className="text-fg-muted truncate flex-1">
                        {a.label !== "unassigned" ? a.label : ""}
                      </span>
                      <span className="text-fg font-semibold tabular-nums">{fmtShare(a.share)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {(results.length > 0 || taxMatches.length > 0 || clusterMatches.length > 0) && (
            <ul className="mt-1 max-h-40 overflow-auto border border-line rounded-md bg-raised">
              {clusterMatches.map((c) => {
                const drin = filters.asvs?.modules?.includes(c) ?? false;
                return (
                  <li key={`c${c}`}>
                    <button data-testid="cluster-result" data-cluster={c} onMouseDown={(e) => e.preventDefault()}
                      onClick={() => (filters.asvs ? p.onToggleModule(c) : p.onPickCluster(c))}
                      className="w-full flex items-center gap-2 text-left px-2 py-1 hover:bg-control text-sm">
                      <span data-testid="cluster-swatch" className="inline-block w-2 h-2 rounded-full shrink-0"
                        style={{ background: p.clusterColor.get(c) ?? "var(--text-disabled)" }} />
                      <span className={!filters.asvs || drin ? "text-fg" : "text-fg-muted"}>{modules.label(c)}</span>
                      <span className="text-fg-muted flex-1">
                        {p.countByCluster.get(c) ?? 0} ASVs{filters.asvs ? "" : " — mark all"}
                      </span>
                    </button>
                  </li>
                );
              })}
              {taxMatches.map((t) => (
                <li key={`${t.rank}:${t.value}`}>
                  <button data-testid="tax-result" onClick={() => p.onPickTaxon(t.rank, t.value)}
                    className="w-full text-left px-2 py-1 hover:bg-control text-sm">
                    <span className="text-warn">◌ {t.value}</span>{" "}
                    <span className="text-fg-muted">
                      {t.rank} · {t.n} ASV{t.n === 1 ? "" : "s"} in the network — mark all
                    </span>
                  </button>
                </li>
              ))}
              {results.map((n) => (
                <li key={n.id}>
                  <button data-testid="asv-result" onMouseDown={(e) => e.preventDefault()}
                    onClick={() => p.onPickAsv(n.id)}
                    className="w-full flex items-center gap-2 text-left px-2 py-1 hover:bg-control text-sm">
                    <span className="inline-block w-2 h-2 rounded-full shrink-0"
                      style={{ background: p.clusterColor.get(n.cluster) ?? "var(--text-disabled)" }} />
                    <span className={shownIds.has(n.id) ? "text-fg" : "text-fg-muted"}>{n.id}</span>
                    <span className="text-fg-muted truncate flex-1">{n.genus}</span>
                    <span className="text-fg font-semibold tabular-nums">{fmtShare(n.rel_abundance)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {q && (
            <div className="mt-1 space-y-1" data-testid="search-dataset">
              {ganz.loading && (
                <p className="text-2xs text-fg-muted" data-testid="search-dataset-loading">
                  searching the whole dataset …
                </p>
              )}
              {ganz.error != null && (
                <ErrorNotice error={ganz.error} inline testid="search-error"
                  what="The search over the whole dataset failed." />
              )}
              {ganz.result && netzLeer && ganz.result.in_network.n_asv > 0 && (
                <p className="text-xs text-warn leading-snug" data-testid="search-hidden">
                  {ganz.result.in_network.n_asv} matching ASV{ganz.result.in_network.n_asv === 1 ? " is" : "s are"} in
                  the network but hidden by the active filters.{" "}
                  <TextButton data-testid="search-hidden-clear" onClick={p.onClearAll}>clear all</TextButton>
                </p>
              )}
              {ganz.result && ganz.result.outside_network.n_asv > 0 && (() => {
                const r = ganz.result;
                const aussen = r.outside_network;
                const gruppen: typeof aussen.taxa = [];
                for (const t of aussen.taxa) {
                  const ids = t.asvs.map((a) => a.id);
                  if (t.n_asv === t.asvs.length && gruppen.some((g) =>
                    ids.every((id) => g.asvs.some((x) => x.id === id)))) continue;
                  gruppen.push(t);
                }
                const inGruppe = new Set(aussen.taxa.flatMap((t) => t.asvs.map((a) => a.id)));
                const nurKennung = aussen.asvs.filter((a) => a.id_match && !inGruppe.has(a.id));
                const zeile = (a: (typeof aussen.asvs)[number]) => (
                  <li key={a.id}>
                    <button data-testid="search-outside-asv" data-asv={a.id} onClick={() => p.onOpenAsv(a.id)}
                      title={`found in ${a.n_samples_present} of ${r.n_samples} samples`}
                      className="w-full flex items-center gap-2 text-left px-2 py-1 hover:bg-control text-sm">
                      <span className="text-fg-muted">{a.id}</span>
                      <span className="text-fg-muted truncate flex-1">{a.label !== "unassigned" ? a.label : ""}</span>
                      <span className="text-fg-muted tabular-nums">{fmtShare(a.share)}</span>
                    </button>
                  </li>
                );
                return (
                  <div className="rounded-md border border-line bg-raised" data-testid="search-outside">
                    <SectionHeading as="h4" className="px-2 pt-1">
                      no link in the network · click: details
                    </SectionHeading>
                    <ul className="max-h-48 overflow-auto pb-1">
                      {gruppen.map((t) => {
                        const gk = `${t.rank}:${t.value}`;
                        const eins = t.n_asv === 1 && t.asvs.length === 1;
                        const offen = offeneGruppe === gk;
                        return (
                          <li key={gk}>
                            <button data-testid="search-outside-taxon" data-n={t.n_asv}
                              aria-expanded={eins ? undefined : offen}
                              onClick={() => (eins ? p.onOpenAsv(t.asvs[0].id) : setOffeneGruppe(offen ? null : gk))}
                              className="w-full text-left px-2 py-1 hover:bg-control text-sm">
                              <span className="text-warn">◌ {t.value}</span>{" "}
                              <span className="text-fg-muted">
                                · {t.n_asv} ASV{t.n_asv === 1 ? "" : "s"} <span className="text-fg-muted">({t.rank})</span>
                              </span>{" "}
                              <span className="text-accent">{eins ? "→ open" : offen ? "▾" : "▸ open"}</span>
                            </button>
                            {offen && (
                              <ul className="ml-3 border-l border-line" data-testid="search-outside-members">
                                {t.asvs.map(zeile)}
                                {t.n_asv > t.asvs.length && (
                                  <li className="px-2 text-2xs text-fg-muted">
                                    {t.asvs.length} of {t.n_asv} shown — type more to narrow down
                                  </li>
                                )}
                              </ul>
                            )}
                          </li>
                        );
                      })}
                      {nurKennung.map(zeile)}
                    </ul>
                    {aussen.n_taxa > aussen.taxa.length && (
                      <p className="px-2 pb-1 text-2xs text-fg-muted">
                        {aussen.taxa.length} of {aussen.n_taxa} names shown — type more to narrow down
                      </p>
                    )}
                  </div>
                );
              })()}
              {ganz.result?.sentence && netzLeer && (
                <p className="text-2xs text-fg-muted leading-snug" data-testid="search-none">
                  {ganz.result.sentence}
                </p>
              )}
            </div>
          )}
          </div>
          {anyActive ? (
            <div className="flex flex-wrap gap-1" data-testid="filter-chips">
            {p.order.map((k) => (
              <span key={k} data-testid={`filter-chip-${k}`}
                className="inline-flex items-center gap-1 text-xs rounded-full border border-accent/60 bg-accent-soft px-2 py-1 text-accent">
                {WINDOWED.includes(k)
                  ? <button onClick={() => p.onOpenFilter(k as WindowKind)} className="hover:underline">{chipLabel(k)}</button>
                  : chipLabel(k)}
                <span className="tabular-nums text-accent"
                  data-testid={`filter-chip-${k}-n`}>{p.chipCounts.get(k) ?? "…"}</span>
                <button data-testid={`filter-chip-${k}-remove`} onClick={() => p.onClearKind(k)}
                  className="text-accent hover:text-fg" aria-label={`remove ${k} filter`}>×</button>
              </span>
            ))}
            </div>
          ) : (
            <p className="text-xs text-fg-muted" data-testid="filter-none">all ASVs · no filter</p>
          )}
          {filters.asvs && (filters.asvs.ids.length + (filters.asvs.modules ?? []).length + (filters.asvs.out ?? []).length > 0) && (
            <div className="flex flex-wrap gap-1 max-h-28 overflow-auto" data-testid="shown-items">
              {(filters.asvs.modules ?? []).map((c) => (
                <span key={`m${c}`} data-testid={`shown-module-${c}`}
                  className="inline-flex items-center gap-1 text-xs rounded border border-line px-1.5 py-0.5 text-fg">
                  <span className="inline-block w-2 h-2 rounded-full"
                    style={{ background: p.clusterColor.get(c) ?? "var(--text-disabled)" }} />
                  {modules.label(c)}
                  <button onClick={() => p.onRemoveShown({ module: c })} aria-label={`remove ${modules.label(c)}`}
                    className="text-fg-muted hover:text-fg">×</button>
                </span>
              ))}
              {filters.asvs.ids.filter((id) => !p.unknownAsvIds.includes(id)).map((id) => (
                <span key={id} data-testid="shown-asv" data-asv={id}
                  className="inline-flex items-center gap-1 text-xs rounded border border-line px-1.5 py-0.5 text-fg">
                  {id}
                  <button onClick={() => p.onRemoveShown({ asv: id })} aria-label={`remove ${id}`}
                    className="text-fg-muted hover:text-fg">×</button>
                </span>
              ))}
              {(filters.asvs.out ?? []).map((id) => (
                <span key={`o${id}`} data-testid="shown-out" data-asv={id}
                  className="inline-flex items-center gap-1 text-xs rounded border border-dashed border-line px-1.5 py-0.5 text-fg-muted line-through">
                  {id}
                  <button onClick={() => p.onPickAsv(id)} aria-label={`add ${id} again`}
                    className="no-underline hover:text-fg">+</button>
                </span>
              ))}
            </div>
          )}
          <div className="flex items-center gap-2">
            <div className="relative" ref={addRef}>
              <Button variant="primary" data-testid="filter-add" aria-expanded={addOpen} onClick={() => setAddOpen((v) => !v)}>
                + add filter
              </Button>
              {addOpen && (
                <div data-testid="filter-add-menu" data-popup=""
                  className="absolute z-20 mt-1 w-56 rounded-md border border-line bg-overlay shadow-xl py-1 text-sm">
                  <div className="px-2 pt-2 pb-1 text-2xs font-semibold text-fg-muted">ASVs</div>
              <button data-testid="filter-add-modules"
                onClick={() => { p.onOpenFilter("modules"); setAddOpen(false); }}
                className="w-full text-left px-2 py-1 hover:bg-control text-fg">
                modules …
              </button>
                  <button data-testid="filter-add-asvs"
                    onClick={() => { p.onOpenFilter("asvs"); setAddOpen(false); }}
                    className="w-full text-left px-2 py-1 hover:bg-control text-fg">
                    ASV selection …
                  </button>
                  <button data-testid="filter-add-taxon"
                    onClick={() => { p.onOpenFilter("taxon"); setAddOpen(false); }}
                    className="w-full text-left px-2 py-1 hover:bg-control text-fg">
                    taxon …
                  </button>
                  <button data-testid="filter-add-abundance" disabled={p.sizeAbsent}
                    title={p.sizeAbsent
                      ? "not applicable: this dataset carries no read counts (transformed values)"
                      : undefined}
                    onClick={() => { p.onOpenFilter("abundance"); setAddOpen(false); }}
                    className="w-full text-left px-2 py-1 hover:bg-control text-fg disabled:text-fg-disabled disabled:hover:bg-transparent">
                    abundance …
                  </button>
                  <button data-testid="filter-add-occurrence" disabled={p.occurrenceReason != null}
                    title={p.occurrenceReason ?? undefined}
                    onClick={() => { p.onOpenFilter("occurrence"); setAddOpen(false); }}
                    className="w-full text-left px-2 py-1 hover:bg-control text-fg disabled:text-fg-disabled disabled:hover:bg-transparent">
                    occurrence …
                  </button>
                  <button data-testid="filter-add-c2"
                    onClick={() => { p.onFilters({ c2Only: !filters.c2Only }); setAddOpen(false); }}
                    className="w-full text-left px-2 py-1 hover:bg-control text-fg disabled:text-fg-muted">
                    {filters.c2Only ? "✓ " : ""}only ✦
                    <span className="text-fg-muted"> ({p.nKey})</span>
                  </button>
                  <div className="px-2 pt-2 pb-1 text-2xs font-semibold text-fg-muted">Links</div>
                  <button data-testid="filter-add-strength"
                    onClick={() => { p.onOpenFilter("strength"); setAddOpen(false); }}
                    className="w-full text-left px-2 py-1 hover:bg-control text-fg">
                    link strength …
                  </button>
                  <button data-testid="filter-add-cross"
                    onClick={() => { p.onFilters({ crossOnly: !filters.crossOnly }); setAddOpen(false); }}
                    className="w-full text-left px-2 py-1 hover:bg-control text-fg">
                    {filters.crossOnly ? "✓ " : ""}only module-crossing links
                  </button>
                </div>
              )}
            </div>
            {!p.taxaMode && (
              <>
                <ToggleButton data-testid="explore-toggle" pressed={p.explore}
                  onClick={() => p.onExplore(!p.explore)}>explore</ToggleButton>
                <span className="text-2xs text-fg-muted leading-tight">click a point: add its partners</span>
              </>
            )}
          </div>
        </div>
      </div>

      <div>
        <SectionHeading className="mb-1">Display</SectionHeading>
        <div className={BOX} data-testid="display-section">
          <div className="mb-2" data-testid="grain-control">
            <Segmented full label="Points" value={p.points} onChange={p.onPoints}
              options={[{ value: "asvs", label: "ASV", testid: "grain-asvs" },
                        { value: "taxa", label: "Taxa", testid: "grain-taxa" }]} />
          </div>
          {p.taxaMode && (
            <div className="mb-2" data-testid="rank-control">
              <Segmented full label="Rank" value={p.taxonRank} onChange={p.onTaxonRank}
                options={[{ value: "genus", label: "Genus", testid: "rank-genus" },
                          { value: "species", label: "Species", testid: "rank-species" }]} />
            </div>
          )}
          {p.taxaMode && (
            <p className="mb-2 text-2xs text-fg-muted leading-snug" data-testid="taxa-note">
              {p.taxonRank === "genus" ? "One point per genus" : "One point per species"}; click a point to pick one of its ASVs.
            </p>
          )}

          <div className="mb-2" data-testid="layer-control">
            <div className="text-xs text-fg-muted">Links</div>
            <div className="mt-1 flex flex-col gap-1">
              {(() => {
                const L = filters.layers;
                const toggle = (k: "con" | "ccm" | "rejected") =>
                  p.onFilters({ layers: { ...L, [k]: !L[k] } });
                const cls = checkCls;
                const mark = checkMark;
                const recorded = !!net?.layers?.ccm_tested_recorded;
                const unit = p.taxaMode ? "taxa" : "ASVs";
                return (
                  <>
                    <button data-testid="layer-all" aria-pressed={L.con} onClick={() => toggle("con")}
                      className={cls(L.con)}>
                      {mark(L.con)}<span>Links (con) ·{" "}
                      <span data-testid="layer-n-con">
                        {p.taxaLayers?.n_con ?? net?.layers?.n_con ?? "…"}</span> links ·{" "}
                      <span data-testid="layer-asv-con">
                        {p.taxaLayers?.n_asv_con ?? net?.layers?.n_asv_con ?? "…"}</span> {unit}</span>
                    </button>
                    <button data-testid="layer-ccm" aria-pressed={L.ccm} onClick={() => toggle("ccm")}
                      className={cls(L.ccm)}>
                      {mark(L.ccm)}<span>Direction (ccm) ·{" "}
                      <span data-testid="layer-n-ccm">
                        {p.taxaLayers?.n_con_with_ccm ?? net?.layers?.n_con_with_ccm ?? "…"}</span>{" "}
                      links ·{" "}
                      <span data-testid="layer-asv-ccm">
                        {p.taxaLayers?.n_asv_ccm ?? net?.layers?.n_asv_ccm ?? "…"}</span> {unit}</span>
                    </button>
                    <button data-testid="layer-rejected" aria-pressed={L.rejected} disabled={!recorded}
                      onClick={() => toggle("rejected")} className={cls(L.rejected, recorded)}>
                      {mark(L.rejected)}<span>⇢ Rejected (ccm) ·{" "}
                      <span data-testid="layer-n-rejected">
                        {recorded
                          ? (p.taxaLayers?.n_con_with_rejected ?? net?.layers?.n_con_with_rejected ?? "…")
                          : "—"}</span>{" "}
                      links ·{" "}
                      <span data-testid="layer-asv-rejected">
                        {recorded
                          ? (p.taxaLayers?.n_asv_rejected ?? net?.layers?.n_asv_rejected ?? "…")
                          : "—"}</span> {unit}</span>
                    </button>
                  </>
                );
              })()}
              {net?.layers && !net.layers.ccm_tested_recorded && (
                <p data-testid="rejected-not-recorded" className="text-xs text-warn leading-snug">
                  rejected directions not recorded for this dataset
                </p>
              )}
            </div>
            {filters.layers.rejected && (
              <p data-testid="rejected-caveat" className="mt-1 text-xs text-warn leading-snug">
                Dashed arrows: directions OTTER tested and <strong>rejected</strong> (p ≥ 0.05 in
                its permutation test) — no arrow in the kept network; where the line itself is
                drawn, the rejected direction bends beside it. Same CCM caveat: predictive value,
                no convergence test, no evidence of causation.
              </p>
            )}
            {filters.layers.ccm && !layersDefault(filters.layers) && (
              <p data-testid="ccm-caveat" className="mt-1 text-xs text-warn leading-snug">
                CCM measures directed predictive value (NMI), <strong>without</strong> a convergence
                test — no evidence of causation.
              </p>
            )}
          </div>
          <div className="mb-2" data-testid="link-length-control">
            <div className="flex gap-2 items-center">
              <span className="text-xs text-fg-muted whitespace-nowrap">Link length</span>
              <div className="flex-1">
                <SliderNumber testid="link-length" label="link length" min={0} max={100}
                  value={lenDraft} fallback={p.linkLengthDefault} onChange={setLenDraft} />
              </div>
              <button data-testid="link-length-reset" onClick={() => setLenDraft(p.linkLengthDefault)}
                disabled={lenDraft === p.linkLengthDefault} title="back to the default length"
                aria-label="back to the default length"
                className="rounded-md px-1 text-xs text-fg-muted hover:text-fg hover:bg-control disabled:text-fg-disabled disabled:hover:bg-transparent">↺</button>
            </div>
          </div>
        </div>
      </div>

      {!p.taxaMode && (
        <div data-testid="keystone-control">
          <SectionHeading aside={<span className="text-xs text-mark tabular-nums"
            data-testid="keystone-n">✦ {p.nKey}</span>}>
            <button data-testid="keystone-toggle" aria-expanded={keystoneOpen}
              onClick={() => setKeystoneOpen((v) => !v)} className="hover:text-fg">
              {keystoneOpen ? "▾" : "▸"} Keystone</button>
          </SectionHeading>
          {keystoneOpen && (
            <div className={`${BOX} mt-1`}>
              <div className="flex flex-col gap-1" role="radiogroup" aria-label="Keystone criterion">
                {([1, 2] as const).map((k) => {
                  const on = p.kp.crit === k;
                  const enabled = k === 1 || !!c2;
                  const d = KEYSTONE_DEFAULTS;
                  const isDefault = k === 1 ? p.kp.p1 === d.p1 && p.kp.links1 === d.links1
                    : p.kp.q2 === d.q2;
                  const reset = (
                    <button data-testid={`keystone-k${k}-reset`} disabled={isDefault}
                      onClick={() => p.onKp(k === 1 ? { p1: d.p1, links1: d.links1 }
                        : { q2: d.q2 })}
                      title="back to the defaults" aria-label="back to the defaults"
                      className="rounded-md px-1 text-xs text-fg-muted hover:text-fg hover:bg-control disabled:text-fg-disabled disabled:hover:bg-transparent">↺</button>
                  );
                  return (
                    <div key={k}>
                      <button data-testid={`keystone-k${k}`} role="radio" aria-checked={on}
                        disabled={!enabled} onClick={() => p.onKp({ crit: k })} className={checkCls(on, enabled)}>
                        <span aria-hidden className={`h-3.5 w-3.5 shrink-0 rounded-full border ${on
                          ? "border-accent bg-accent-fill" : "border-line-strong"}`} />
                        <span>{KEYSTONE_LABEL[k]} · {k === 1 ? p.nCrit1 : (c2?.n_pass ?? "…")}</span>
                      </button>
                      {on && (
                        <div className="ml-5 mt-1 grid grid-cols-[1fr_auto_auto] items-center gap-x-2 gap-y-1 text-xs text-fg-muted"
                          data-testid={`keystone-k${k}-params`}>
                          {k === 1 ? <>
                            <KeystoneField testid="keystone-p1" label="max. CCM p-value" value={p.kp.p1}
                              min={0} max={1} onChange={(v) => p.onKp({ p1: v })} />
                            {reset}
                            <KeystoneField testid="keystone-links1" label="min. CCM links" value={p.kp.links1}
                              min={1} max={1000} integer onChange={(v) => p.onKp({ links1: v })} />
                          </> : <>
                            <KeystoneField testid="keystone-q2" label="max. corrected p-value" value={p.kp.q2}
                              min={0} max={1} onChange={(v) => p.onKp({ q2: v })} />
                            {reset}
                          </>}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </aside>
  );
}


function KeystoneField({ label, value, min, max, integer, onChange, testid }: {
  label: string; value: number; min: number; max: number; integer?: boolean;
  onChange: (v: number) => void; testid: string;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => {
    if (Number(text.replace(",", ".")) !== value) setText(String(value));
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <span>{label}</span>
      <input data-testid={testid} type="text" inputMode={integer ? "numeric" : "decimal"} value={text}
        aria-label={label}
        onChange={(e) => {
          setText(e.target.value);
          const n = Number(e.target.value.replace(",", "."));
          if (e.target.value.trim() !== "" && Number.isFinite(n) && n <= max
              && (integer ? Number.isInteger(n) && n >= min : n > min)) onChange(n);
        }}
        className="w-14 px-1 py-0.5 rounded-md bg-control border border-line-strong text-fg tabular-nums text-right" />
    </>
  );
}

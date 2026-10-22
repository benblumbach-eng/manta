import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getStarred, type Criterion2Summary, type Dataset,
         type Network, type NetNode } from "../api";
import { useModules } from "../modules";
import { isActive, type Filters, type FilterKind, type KeystoneParams, KEYSTONE_DEFAULTS, KEYSTONE_LABEL, layerLabel, layersDefault, functionLabel } from "../networkFilters";
import { FUNCTION_NONE, functionOther } from "../clusterPalette";
import { useDatasetSearch } from "../datasetSearch";
import ErrorNotice from "./ErrorNotice";
import DatasetFacts from "./DatasetFacts";
import { Button, SectionHeading, TextButton, ToggleButton } from "./ui";
import { Segmented } from "./controls";
import { ABUNDANCE_STEPS } from "../networkFilters";

const NEUTRAL_SWATCH = "var(--control-strong)";
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
  order: FilterKind[];
  chipCounts: Map<FilterKind, number>;
  unknownAsvIds: string[];
  taxaMode: boolean;
  points: "asvs" | "genus" | "species";
  onPoints: (v: "asvs" | "genus" | "species") => void;
  linkLength: number;
  linkLengthDefault: number;
  onLinkLength: (v: number) => void;
  colorMode: "module" | "function";
  onColorMode: (m: "module" | "function") => void;
  functionClasses: { label: string; n: number; color: string; other?: boolean }[];
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
  nSamples: number;
};

const PRESENCE_START = 5;

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
  const results = useMemo(
    () => (q
      ? visibleNodes.filter((n) => n.id.toLowerCase().includes(q.toLowerCase())
          || (n.genus ?? "").toLowerCase().includes(q.toLowerCase()))
      : []),
    [q, visibleNodes]);
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
  const clusterMatch = useMemo(() => {
    const m = /^c(?:luster)?\s*(\d+)$/i.exec(q);
    if (!m) return null;
    const label = Number(m[1]);
    return p.clusters.includes(label) ? label : null;
  }, [q, p.clusters]);
  const netzLeer = results.length === 0 && taxMatches.length === 0 && clusterMatch == null;

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
  const [taxonOpen, setTaxonOpen] = useState(isActive(filters, "taxon"));
  const [functionOpen, setFunctionOpen] = useState(isActive(filters, "function"));
  const [asvOpen, setAsvOpen] = useState(isActive(filters, "asvs"));
  const [abundanceOpen, setAbundanceOpen] = useState(isActive(filters, "abundance"));
  const [presenceOpen, setPresenceOpen] = useState(isActive(filters, "presence"));
  const [strengthOpen, setStrengthOpen] = useState(isActive(filters, "strength"));
  const rRange = useMemo((): [number, number] => {
    const rs = (net?.edges ?? []).flatMap((e) => (e.corr != null ? [Math.abs(e.corr)] : []));
    if (!rs.length) return [0, 1];
    return [Math.floor(Math.min(...rs) * 100) / 100, Math.ceil(Math.max(...rs) * 100) / 100];
  }, [net]);
  const [taxRank, setTaxRank] = useState("genus");
  const [taxValue, setTaxValue] = useState("");
  const [asvText, setAsvText] = useState(filters.asvs?.ids.join("\n") ?? "");
  const [starredNote, setStarredNote] = useState<string | null>(null);
  useEffect(() => {
    if (isActive(filters, "taxon")) setTaxonOpen(true);
    if (isActive(filters, "function")) setFunctionOpen(true);
    if (isActive(filters, "asvs")) setAsvOpen(true);
    if (isActive(filters, "abundance")) setAbundanceOpen(true);
    if (isActive(filters, "presence")) setPresenceOpen(true);
    if (isActive(filters, "strength")) setStrengthOpen(true);
  }, [filters]);

  const anyActive = p.order.length > 0;
  const visibleClusters = p.clusters.filter((c) => !filters.hidden.has(c));

  const modListRef = useRef<HTMLDivElement>(null);
  const [modBelow, setModBelow] = useState(0);
  const measureModList = useCallback(() => {
    const el = modListRef.current;
    if (!el) { setModBelow(0); return; }
    const bottom = el.scrollTop + el.clientHeight;
    let n = 0;
    for (const row of Array.from(el.children) as HTMLElement[]) {
      if (row.offsetTop + row.offsetHeight > bottom + 1) n++;
    }
    setModBelow(n);
  }, []);
  useEffect(() => {
    measureModList();
    const el = modListRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measureModList);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measureModList, p.clusters, modules]);

  const chipLabel = (k: FilterKind): string => {
    switch (k) {
      case "modules":
        return "Modules " + (visibleClusters.length <= 4
          ? visibleClusters.join(", ")
          : `${visibleClusters.length} of ${p.clusters.length}`);
      case "layer": return layerLabel(filters.layers);
      case "cross": return "crossing only";
      case "c2": return "✦ only";
      case "function": return `Function: ${functionLabel(filters.fn ?? "")}`;
      case "taxon": return filters.taxon ? `${filters.taxon.value} (${filters.taxon.rank})` : "Taxon";
      case "asvs": {
        const valid = (filters.asvs?.ids.length ?? 0) - p.unknownAsvIds.length;
        return `ASVs: ${valid}${filters.asvs?.neighbors ? " +neighbours" : ""}`;
      }
      case "presence": return `present in ≥ ${filters.presence ?? 1} samples`;
      case "abundance": return `abundance ≥ ${filters.abundance ?? 0} %`;
      case "strength": return `r ≥ ${filters.strength?.toFixed(2) ?? ""}`;
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
      className="w-72 border-r border-line flex flex-col gap-3 p-3 overflow-auto">
      <div className="space-y-2">
        <div>
          <h2 className="text-base font-semibold text-fg truncate">
            {dataset.region ?? dataset.dataset_id}
          </h2>
          <div className="text-xs text-fg-muted" data-testid="dataset-marker">
            Marker {dataset.marker ?? "?"}
          </div>
        </div>
        <DatasetFacts dataset={dataset} />
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
        <input data-testid="asv-search" value={search} onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && results.length === 1 && taxMatches.length === 0
                && clusterMatch == null) p.onPickAsv(results[0].id);
          }}
          placeholder="search ASV, taxon or cluster …"
          className="w-full px-2 py-1 rounded-md bg-control border border-line-strong text-sm text-fg placeholder:text-fg-muted" />
        {(results.length > 0 || taxMatches.length > 0 || clusterMatch != null) && (
          <ul className="mt-1 max-h-40 overflow-auto border border-line rounded-md bg-raised">
            {clusterMatch != null && (
              <li>
                <button data-testid="cluster-result" onClick={() => p.onPickCluster(clusterMatch)}
                  className="w-full text-left px-2 py-1 hover:bg-control text-sm">
                  <span data-testid="cluster-swatch" className="inline-block w-3 h-3 rounded-sm mr-1 align-middle"
                    style={{ background: p.clusterColor.get(clusterMatch) ?? "var(--text-disabled)" }} />
                  <span className="text-fg">{modules.label(clusterMatch)}</span>{" "}
                  <span className="text-fg-muted">
                    {p.countByCluster.get(clusterMatch) ?? 0} ASVs — mark all
                  </span>
                </button>
              </li>
            )}
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
                <button data-testid="asv-result" onClick={() => p.onPickAsv(n.id)}
                  className="w-full text-left px-2 py-1 hover:bg-control text-sm">
                  <span className="inline-block w-2 h-2 rounded-full mr-2"
                    style={{ background: p.clusterColor.get(n.cluster) ?? "var(--text-disabled)" }} />
                  <span className="text-fg">{n.id}</span>{" "}
                  <span className="text-fg-muted">{n.genus}</span>
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
                    className="w-full text-left px-2 py-1 hover:bg-control text-xs">
                    <span className="font-mono text-fg">{a.id}</span>{" "}
                    <span className="text-fg-muted">
                      {a.label !== "unassigned" ? `${a.label} · ` : ""}found in {a.n_samples_present} of {r.n_samples} samples
                    </span>{" "}
                    <span className="text-accent">→ open</span>
                  </button>
                </li>
              );
              return (
                <div className="rounded-md border border-line bg-raised" data-testid="search-outside">
                  <SectionHeading as="h4" className="px-2 pt-1">
                    in this dataset, no link in the network
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

      <div>
        <SectionHeading className="mb-1">Display</SectionHeading>
        <div className={BOX} data-testid="display-section">
          <div className="mb-2" data-testid="grain-control">
            <Segmented full label="Points" value={p.points} onChange={p.onPoints}
              options={[{ value: "asvs", label: "ASVs", testid: "grain-asvs" },
                        { value: "genus", label: "Genus", testid: "grain-genus" },
                        { value: "species", label: "Species", testid: "grain-taxa" }]} />
          </div>
          {p.taxaMode && (
            <p className="mb-2 text-2xs text-fg-muted leading-snug" data-testid="taxa-note">
              {p.points === "genus" ? "One point per genus" : "One point per species"}; click a point to pick one of its ASVs.
            </p>
          )}

          <div className="mb-2" data-testid="link-length-control">
            <div className="flex gap-2 items-center">
              <span className="text-xs text-fg-muted">Link length</span>
              <input type="range" data-testid="link-length" aria-label="link length"
                min={60} max={900} step={20} value={lenDraft}
                onChange={(e) => setLenDraft(Number(e.target.value))}
                className="flex-1 accent-accent-fill" />
              <span className="w-8 text-right text-xs tabular-nums text-fg-muted">{lenDraft}</span>
              <button data-testid="link-length-reset" onClick={() => setLenDraft(p.linkLengthDefault)}
                disabled={lenDraft === p.linkLengthDefault} title="back to the default length"
                aria-label="back to the default length"
                className="rounded-md px-1 text-xs text-fg-muted hover:text-fg hover:bg-control disabled:text-fg-disabled disabled:hover:bg-transparent">↺</button>
            </div>
          </div>

          <div className="mb-2" data-testid="color-control">
            <div>
              <Segmented full label="Colour" value={p.colorMode} onChange={p.onColorMode}
                options={[{ value: "module", label: "by module", testid: "color-module" },
                          { value: "function", label: "by function", testid: "color-function",
                            disabled: !net?.traits?.available,
                            reason: net?.traits?.available ? undefined
                              : (net?.traits?.absent_reason ?? "no literature annotation for this dataset") }]} />
            </div>
            {p.colorMode === "function" && (
              <div className="mt-1 flex flex-wrap gap-x-2 gap-y-1 text-2xs" data-testid="function-key">
                {p.functionClasses.filter((c) => !c.other).map((c) => (
                  <span key={c.label} className="inline-flex items-center gap-1 text-fg"
                    data-testid="function-key-class" data-label={c.label} data-color={c.color}>
                    <span className="inline-block w-2.5 h-2.5 rounded-full shrink-0" style={{ background: c.color }} />
                    {c.label} <span className="text-fg-muted tabular-nums">{c.n}</span>
                  </span>
                ))}
                {p.functionClasses.some((c) => c.other) && (
                  <span className="inline-flex items-center gap-1 text-fg" data-testid="function-key-other"
                    title={p.functionClasses.filter((c) => c.other).map((c) => c.label).join(", ")}>
                    <span className="inline-block w-2.5 h-2.5 rounded-full shrink-0" style={{ background: functionOther() }} />
                    other classes <span className="text-fg-muted tabular-nums">
                      {p.functionClasses.filter((c) => c.other).reduce((a, c) => a + c.n, 0)}</span>
                  </span>
                )}
                <span className="inline-flex items-center gap-1 text-fg-muted" data-testid="function-key-none">
                  <span className="inline-block w-2.5 h-2.5 rounded-full shrink-0" style={{ background: FUNCTION_NONE }} />
                  {p.taxaMode ? "not annotated or mixed classes" : "not annotated"}
                </span>
              </div>
            )}
            {p.colorMode === "function" && net?.traits?.statement && (
              <p className="mt-1 text-2xs text-fg-muted" data-testid="legend-function-coverage">
                {net.traits.statement}
              </p>
            )}
            {p.colorMode === "function" && net?.traits?.note && (
              <p className="mt-1 text-2xs text-fg-muted leading-snug" data-testid="function-note">
                {net.traits.note.split(". ")[0].replace(/\.?$/, ".")}
              </p>
            )}
          </div>

          {!p.taxaMode && (
            <div className="border-t border-line-subtle pt-2" data-testid="keystone-control">
              <SectionHeading aside={<span className="text-xs text-mark tabular-nums"
                data-testid="keystone-n">✦ {p.nKey}</span>}>Keystone</SectionHeading>
              <div className="mt-1 flex flex-col gap-1" role="radiogroup" aria-label="Keystone criterion">
                {([1, 2] as const).map((k) => {
                  const on = p.kp.crit === k;
                  const enabled = k === 1 || !!c2;
                  const d = KEYSTONE_DEFAULTS;
                  const isDefault = k === 1 ? p.kp.p1 === d.p1 && p.kp.links1 === d.links1
                    : p.kp.q2 === d.q2 && p.kp.module2 === d.module2;
                  const reset = (
                    <button data-testid={`keystone-k${k}-reset`} disabled={isDefault}
                      onClick={() => p.onKp(k === 1 ? { p1: d.p1, links1: d.links1 }
                        : { q2: d.q2, module2: d.module2 })}
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
                            <KeystoneField testid="keystone-p1" label="p <" value={p.kp.p1}
                              min={0} max={1} onChange={(v) => p.onKp({ p1: v })} />
                            {reset}
                            <KeystoneField testid="keystone-links1" label="min. links" value={p.kp.links1}
                              min={1} max={1000} integer onChange={(v) => p.onKp({ links1: v })} />
                          </> : <>
                            <KeystoneField testid="keystone-q2" label="q ≤" value={p.kp.q2}
                              min={0} max={1} onChange={(v) => p.onKp({ q2: v })} />
                            {reset}
                            <KeystoneField testid="keystone-module2" label="min. module size"
                              value={p.kp.module2} min={3} max={10000} integer
                              onChange={(v) => p.onKp({ module2: v })} />
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
      </div>

      <div>
        <SectionHeading className="mb-1" aside={anyActive && (
            <TextButton data-testid="filter-clear-all" onClick={p.onClearAll} className="text-xs">
              clear all</TextButton>
          )}>Filter</SectionHeading>
        {anyActive && (
          <div className="flex flex-wrap gap-1 mb-2" data-testid="filter-chips">
            {p.order.map((k) => (
              <span key={k} data-testid={`filter-chip-${k}`}
                className="inline-flex items-center gap-1 text-xs rounded-full border border-accent/60 bg-accent-soft px-2 py-1 text-accent">
                {chipLabel(k)}
                <span className="tabular-nums text-accent"
                  data-testid={`filter-chip-${k}-n`}>{p.chipCounts.get(k) ?? "…"}</span>
                <button data-testid={`filter-chip-${k}-remove`} onClick={() => p.onClearKind(k)}
                  className="text-accent hover:text-fg" aria-label={`remove ${k} filter`}>×</button>
              </span>
            ))}
          </div>
        )}

        <div className={BOX}>
          <SectionHeading className="mb-1" aside={<>
              <Button variant="ghost" data-testid="cluster-all"
                onClick={() => p.onFilters({ hidden: new Set() })}>all</Button>
              <Button variant="ghost" data-testid="cluster-none"
                onClick={() => p.onFilters({ hidden: new Set(p.clusters) })}>none</Button>
            </>}>Modules</SectionHeading>
          <div ref={modListRef} onScroll={measureModList} data-testid="cluster-list"
            className="relative flex flex-col gap-1 max-h-64 overflow-auto">
            {p.clusters.map((c) => (
              <div key={c} className="flex items-center gap-2 text-sm text-fg">
                <input type="checkbox" data-testid={`cluster-check-${c}`}
                  aria-label={`show ${modules.label(c)}`}
                  checked={!filters.hidden.has(c)}
                  onChange={(e) => {
                    const next = new Set(filters.hidden);
                    if (e.target.checked) next.delete(c); else next.add(c);
                    p.onFilters({ hidden: next });
                  }} />
                <span data-testid="cluster-swatch" className="inline-block w-3 h-3 rounded-sm shrink-0"
                  data-neutral={p.colorMode === "function" ? "1" : "0"}
                  style={{ background: p.colorMode === "function" ? NEUTRAL_SWATCH
                                                                 : (p.clusterColor.get(c) ?? "var(--text-disabled)") }} />
                <button data-testid={`cluster-open-${c}`} onClick={() => p.onOpenClusterPanel(c)}
                  className="flex-1 text-left hover:underline">{modules.label(c)}</button>
                <span className="text-xs text-fg-muted tabular-nums">
                  {p.countByCluster.get(c) ?? 0}
                </span>
              </div>
            ))}
          </div>
          {modBelow > 0 && (
            <div className="mt-1 text-2xs text-fg-muted" data-testid="cluster-more">
              +{modBelow} more — scroll
            </div>
          )}
          {net?.partition?.clusters_are_components && (
            <p className="mt-1 text-xs text-warn leading-snug" data-testid="partition-note">
              These {net.partition.n_clusters} clusters are exactly the{" "}
              {net.partition.n_components} unconnected parts of this network — no link crosses a
              cluster border.
            </p>
          )}
        </div>

        <div className={BOX} data-testid="layer-control">
          <SectionHeading>Links</SectionHeading>
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

        {functionOpen && (
          <div className={BOX} data-testid="filter-function-section">
            <SectionHeading className="mb-1">Function filter</SectionHeading>
            {net?.traits?.available ? (
              [...p.functionClasses.map((c) => ({ ...c, key: c.label })),
                { label: "not annotated", key: "", color: FUNCTION_NONE,
                  n: net.nodes.filter((n) => !n.trait_group).length }]
                .filter((c) => c.key !== "" || c.n > 0).map((c) => {
                const on = filters.fn === c.key;
                return (
                  <button key={c.key || "__none"} data-testid="filter-function" data-label={c.key}
                    aria-pressed={on}
                    onClick={() => {
                      p.onFilters({ fn: on ? null : c.key });
                      if (!on) p.onColorMode("function");
                    }}
                    className={`w-full flex items-center gap-2 px-2 py-1 rounded text-xs text-left ${on
                      ? "bg-accent-soft text-accent font-medium" : "text-fg hover:bg-control"}`}>
                    <span className="inline-block w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: c.color }} />
                    <span className="flex-1 truncate">{c.label}</span>
                    <span className="text-fg-muted tabular-nums">{c.n}</span>
                  </button>
                );
              })
            ) : (
              <p className="text-xs text-warn leading-snug" data-testid="filter-function-absent">
                {net?.traits?.absent_reason ?? "no literature annotation for this dataset"}
              </p>
            )}
          </div>
        )}

        {taxonOpen && (
          <div className={BOX} data-testid="filter-taxon-section">
            <SectionHeading className="mb-1">Taxon filter</SectionHeading>
            <div className="flex gap-1">
              <select data-testid="filter-tax-rank" value={taxRank}
                onChange={(e) => setTaxRank(e.target.value)}
                className="px-1 py-1 rounded bg-control border border-line-strong text-xs text-fg">
                {TAX_RANKS.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
              <input data-testid="filter-tax-value" list="manta-tax-values" value={taxValue}
                onChange={(e) => {
                  setTaxValue(e.target.value);
                  if (taxValues.includes(e.target.value))
                    p.onFilters({ taxon: { rank: taxRank, value: e.target.value } });
                }}
                placeholder="value …"
                className="flex-1 min-w-0 px-1 py-1 rounded bg-control border border-line-strong text-xs text-fg" />
              <datalist id="manta-tax-values">
                {taxValues.map((v) => <option key={v} value={v} />)}
              </datalist>
            </div>
          </div>
        )}

        {asvOpen && (
          <div className={BOX} data-testid="filter-asv-section">
            <SectionHeading className="mb-1">ASV selection</SectionHeading>
            <textarea data-testid="filter-asv-input" value={asvText}
              onChange={(e) => setAsvText(e.target.value)}
              placeholder={"one identifier per line\nor comma-separated"}
              rows={3}
              className="w-full px-2 py-1 rounded bg-control border border-line-strong text-xs text-fg font-mono" />
            <div className="flex flex-wrap gap-1 mt-1">
              <Button data-testid="filter-asv-apply" onClick={() => applyAsvText(asvText)}>
                apply
              </Button>
              <Button data-testid="filter-asv-starred"
                onClick={() => getStarred(dataset.dataset_id).then((d) => {
                  const ids = d.asvs.map((a) => a.id);
                  setStarredNote(ids.length ? null
                    : d.note ?? "nothing starred by this account in this dataset");
                  setAsvText(ids.join("\n"));
                  applyAsvText(ids.join("\n"));
                }).catch(() => setStarredNote("could not load the starred list"))}>
                ★ my starred
              </Button>
              <Button data-testid="filter-asv-from-search"
                onClick={() => {
                  const ids = results.map((n) => n.id);
                  setAsvText(ids.join("\n"));
                  applyAsvText(ids.join("\n"));
                }}
                disabled={results.length === 0} reason="no search hits to take">
                take search hits
              </Button>
            </div>
            <label className="flex items-center gap-2 mt-1 text-xs text-fg cursor-pointer">
              <input type="checkbox" data-testid="filter-asv-neighbors"
                checked={filters.asvs?.neighbors ?? false}
                onChange={(e) => filters.asvs
                  && p.onFilters({ asvs: { ...filters.asvs, neighbors: e.target.checked } })} />
              + neighbours
            </label>
            {starredNote && <p className="mt-1 text-2xs text-fg-muted">{starredNote}</p>}
            {p.unknownAsvIds.length > 0 && (
              <p data-testid="filter-asv-unknown" className="mt-1 text-xs text-warn break-all">
                not in this network, ignored: {p.unknownAsvIds.join(", ")}
              </p>
            )}
          </div>
        )}

        {presenceOpen && (
          <div className={BOX} data-testid="filter-presence-section">
            <SectionHeading className="mb-1">Present in at least … samples</SectionHeading>
            <div className="flex items-center gap-2 text-xs text-fg">
              <input data-testid="filter-presence-n" type="range" min={1}
                max={Math.max(1, p.nSamples)} step={1}
                aria-label="minimum number of samples"
                aria-valuetext={`${filters.presence ?? PRESENCE_START} samples`}
                value={filters.presence ?? Math.min(PRESENCE_START, Math.max(1, p.nSamples))}
                onChange={(e) => p.onFilters({ presence: Number(e.target.value) })}
                className="flex-1" />
              <span className="tabular-nums w-16 text-right" data-testid="filter-presence-value">
                {filters.presence != null ? `≥ ${filters.presence} of ${p.nSamples}` : "off"}
              </span>
            </div>
          </div>
        )}

        {abundanceOpen && (() => {
          const i = filters.abundance != null
            ? Math.max(0, ABUNDANCE_STEPS.indexOf(filters.abundance)) : ABUNDANCE_STEPS.indexOf(0.1);
          return (
          <div className={BOX} data-testid="filter-abundance-section">
            <SectionHeading className="mb-1">Mean relative abundance</SectionHeading>
            <div className="flex items-center gap-2 text-xs text-fg">
              <input data-testid="filter-abundance" type="range" min={0}
                max={ABUNDANCE_STEPS.length - 1} step={1}
                aria-label="minimum mean relative abundance"
                aria-valuetext={`${ABUNDANCE_STEPS[i]} %`} value={i}
                onChange={(e) => p.onFilters({ abundance: ABUNDANCE_STEPS[Number(e.target.value)] })}
                className="flex-1" />
              <span className="tabular-nums w-16 text-right" data-testid="filter-abundance-value">
                {filters.abundance != null ? `≥ ${filters.abundance} %` : "off"}
              </span>
            </div>
          </div>
          );
        })()}

        {strengthOpen && (
          <div className={BOX} data-testid="filter-strength-section">
            <SectionHeading className="mb-1">Link strength (r)</SectionHeading>
            <div className="flex items-center gap-2 text-xs text-fg">
              <input data-testid="filter-strength" type="range" min={rRange[0]} max={rRange[1]}
                step={0.01} aria-label="minimum r"
                aria-valuetext={`r ≥ ${(filters.strength ?? rRange[0]).toFixed(2)}`}
                value={filters.strength ?? rRange[0]}
                onChange={(e) => p.onFilters({ strength: Number(e.target.value) })}
                className="flex-1" />
              <span className="tabular-nums w-16 text-right" data-testid="filter-strength-value">
                {filters.strength != null ? `≥ ${filters.strength.toFixed(2)}` : "off"}
              </span>
            </div>
          </div>
        )}

        <div className="relative" ref={addRef}>
          <Button data-testid="filter-add" aria-expanded={addOpen} onClick={() => setAddOpen((v) => !v)}>
            + add filter
          </Button>
          {addOpen && (
            <div data-testid="filter-add-menu" data-popup=""
              className="absolute z-20 mt-1 w-56 rounded-md border border-line bg-overlay shadow-xl py-1 text-sm">
              <button data-testid="filter-add-cross"
                onClick={() => { p.onFilters({ crossOnly: !filters.crossOnly }); setAddOpen(false); }}
                className="w-full text-left px-2 py-1 hover:bg-control text-fg">
                {filters.crossOnly ? "✓ " : ""}only module-crossing links
              </button>
              <button data-testid="filter-add-c2"
                onClick={() => { p.onFilters({ c2Only: !filters.c2Only }); setAddOpen(false); }}
                className="w-full text-left px-2 py-1 hover:bg-control text-fg disabled:text-fg-muted">
                {filters.c2Only ? "✓ " : ""}only ✦
                <span className="text-fg-muted"> ({p.nKey})</span>
              </button>
              <button data-testid="filter-add-function"
                onClick={() => { setFunctionOpen(true); setAddOpen(false); }}
                className="w-full text-left px-2 py-1 hover:bg-control text-fg">
                function …
              </button>
              <button data-testid="filter-add-taxon"
                onClick={() => { setTaxonOpen(true); setAddOpen(false); }}
                className="w-full text-left px-2 py-1 hover:bg-control text-fg">
                taxon …
              </button>
              <button data-testid="filter-add-asvs"
                onClick={() => { setAsvOpen(true); setAddOpen(false); }}
                className="w-full text-left px-2 py-1 hover:bg-control text-fg">
                ASV selection …
              </button>
              <button data-testid="filter-add-presence"
                onClick={() => { setPresenceOpen(true); setAddOpen(false); }}
                className="w-full text-left px-2 py-1 hover:bg-control text-fg">
                present in ≥ N samples …
              </button>
              <button data-testid="filter-add-abundance" disabled={p.sizeAbsent}
                title={p.sizeAbsent
                  ? "not applicable: this dataset carries no read counts (transformed values)"
                  : undefined}
                onClick={() => { setAbundanceOpen(true); setAddOpen(false); }}
                className="w-full text-left px-2 py-1 hover:bg-control text-fg disabled:text-fg-disabled disabled:hover:bg-transparent">
                abundance …
              </button>
              <button data-testid="filter-add-strength"
                onClick={() => { setStrengthOpen(true); setAddOpen(false); }}
                className="w-full text-left px-2 py-1 hover:bg-control text-fg">
                link strength …
              </button>
            </div>
          )}
        </div>
      </div>
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

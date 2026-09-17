import type { NetEdge, NetNode, Network } from "./api";


export type FilterKind = "modules" | "layer" | "cross" | "hubs" | "function" | "taxon" | "asvs"
  | "size" | "strength";

export type TaxonFilter = { rank: string; value: string };
export type AsvFilter = { ids: string[]; neighbors: boolean };
export type QuantileFilter = { dir: "top" | "bottom"; pct: number };

export type Filters = {
  hidden: Set<number>;
  layers: { con: boolean; ccm: boolean; rejected: boolean };
  crossOnly: boolean;
  hubsOnly: boolean;
  fn: string | null;
  taxon: TaxonFilter | null;
  asvs: AsvFilter | null;
  size: QuantileFilter | null;
  strength: QuantileFilter | null;
};

export const DEFAULT_LAYERS = { con: true, ccm: true, rejected: false } as const;

export const emptyFilters = (): Filters => ({
  hidden: new Set(), layers: { ...DEFAULT_LAYERS }, crossOnly: false, hubsOnly: false,
  fn: null, taxon: null, asvs: null, size: null, strength: null,
});

export const layersDefault = (l: Filters["layers"]): boolean =>
  l.con === DEFAULT_LAYERS.con && l.ccm === DEFAULT_LAYERS.ccm
  && l.rejected === DEFAULT_LAYERS.rejected;

export function layerLabel(l: Filters["layers"]): string {
  if (!l.con && !l.ccm && !l.rejected) return "nodes only";
  if (!l.con) {
    if (l.ccm && l.rejected) return "directed + rejected only";
    return l.ccm ? "directed only" : "tested, rejected only";
  }
  if (l.ccm && l.rejected) return "links + rejected";
  if (!l.ccm && l.rejected) return "links + rejected, no kept arrows";
  if (!l.ccm) return "links without arrows";
  return "all links";
}

export const FILTER_KINDS: FilterKind[] = ["modules", "layer", "cross", "hubs", "function", "taxon",
                                           "asvs", "size", "strength"];

export const functionLabel = (fn: string): string => (fn === "" ? "not annotated" : fn);

export const isActive = (f: Filters, k: FilterKind): boolean => {
  switch (k) {
    case "modules": return f.hidden.size > 0;
    case "layer": return !layersDefault(f.layers);
    case "cross": return f.crossOnly;
    case "hubs": return f.hubsOnly;
    case "function": return f.fn != null;
    case "taxon": return f.taxon != null;
    case "asvs": return (f.asvs?.ids.length ?? 0) > 0;
    case "size": return f.size != null;
    case "strength": return f.strength != null;
  }
};

export const takeKind = (dst: Filters, src: Filters, k: FilterKind): Filters => {
  switch (k) {
    case "modules": return { ...dst, hidden: src.hidden };
    case "layer": return { ...dst, layers: { ...src.layers } };
    case "cross": return { ...dst, crossOnly: src.crossOnly };
    case "hubs": return { ...dst, hubsOnly: src.hubsOnly };
    case "function": return { ...dst, fn: src.fn };
    case "taxon": return { ...dst, taxon: src.taxon };
    case "asvs": return { ...dst, asvs: src.asvs };
    case "size": return { ...dst, size: src.size };
    case "strength": return { ...dst, strength: src.strength };
  }
};

export const clearKind = (f: Filters, k: FilterKind): Filters => takeKind(f, emptyFilters(), k);

export type Visible = {
  nodes: NetNode[];
  edges: NetEdge[];
  edgesInView: NetEdge[];
};

const hasCcm = (e: NetEdge) => (e.ccm_dirs ?? 0) > 0;
const hasRejected = (e: NetEdge) => (e.rejected_dirs ?? 0) > 0;

function quantileCut(values: number[], q: QuantileFilter): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => (q.dir === "top" ? b - a : a - b));
  const n = Math.max(1, Math.min(sorted.length, Math.round((sorted.length * q.pct) / 100)));
  return sorted[n - 1];
}

export function computeVisible(net: Network, f: Filters, hubIds: Set<string>): Visible {
  const asvSet = new Set(f.asvs?.ids ?? []);
  const neighborSet = new Set<string>();
  if (f.asvs?.neighbors && asvSet.size) {
    for (const e of net.edges) {
      if (asvSet.has(e.source)) neighborSet.add(e.target);
      if (asvSet.has(e.target)) neighborSet.add(e.source);
    }
  }
  const asvActive = asvSet.size > 0;
  const sizeCut = f.size
    ? quantileCut(net.nodes.map((n) => n.size).filter((v): v is number => v != null), f.size)
    : null;
  const pass = (n: NetNode): boolean => {
    if (f.hidden.has(n.cluster)) return false;
    if (f.hubsOnly && !hubIds.has(n.id)) return false;
    if (f.fn != null && (n.trait_group ?? "") !== f.fn) return false;
    if (f.taxon
        && (n as unknown as Record<string, unknown>)[f.taxon.rank] !== f.taxon.value) return false;
    if (asvActive && !asvSet.has(n.id)
        && !(f.asvs!.neighbors && neighborSet.has(n.id))) return false;
    if (f.size && sizeCut != null) {
      if (n.size == null) return false;
      if (f.size.dir === "top" ? n.size < sizeCut : n.size > sizeCut) return false;
    }
    return true;
  };
  const nodes = net.nodes.filter(pass);
  const ids = new Set(nodes.map((n) => n.id));
  const clusterOf = new Map(net.nodes.map((n) => [n.id, n.cluster]));
  const isCross = (e: NetEdge) => clusterOf.get(e.source) !== clusterOf.get(e.target);
  const strengthCut = f.strength
    ? quantileCut(net.edges.map((e) => (e.corr != null ? Math.abs(e.corr) : null))
        .filter((v): v is number => v != null), f.strength)
    : null;
  const strengthPass = (e: NetEdge): boolean => {
    if (!f.strength || strengthCut == null) return true;
    const v = e.corr != null ? Math.abs(e.corr) : null;
    if (v == null) return false;
    return f.strength.dir === "top" ? v >= strengthCut : v <= strengthCut;
  };
  const edgesInView = net.edges.filter((e) => ids.has(e.source) && ids.has(e.target));
  const L = f.layers;
  const layerPass = (e: NetEdge): boolean =>
    L.con || (L.ccm && hasCcm(e)) || (L.rejected && hasRejected(e));
  const edges = edgesInView.filter(
    (e) => (!f.crossOnly || isCross(e)) && layerPass(e) && strengthPass(e));
  const layerRestricts = !L.con && (L.ccm || L.rejected);
  const edgeFilterActive = f.crossOnly || layerRestricts
    || (f.strength != null && strengthCut != null);
  if (!edgeFilterActive) return { nodes, edges, edgesInView };
  const linked = new Set<string>();
  edges.forEach((e) => { linked.add(e.source); linked.add(e.target); });
  return { nodes: nodes.filter((n) => linked.has(n.id)), edges, edgesInView };
}

export function chainedCounts(net: Network, f: Filters, hubIds: Set<string>,
                              order: FilterKind[]): Map<FilterKind, number> {
  const m = new Map<FilterKind, number>();
  let partial = emptyFilters();
  for (const k of order) {
    partial = takeKind(partial, f, k);
    m.set(k, computeVisible(net, partial, hubIds).nodes.length);
  }
  return m;
}


export function encodeFilters(f: Filters): string {
  const seg: string[] = [];
  if (f.hidden.size) seg.push("m-" + [...f.hidden].sort((a, b) => a - b).join("."));
  if (!f.layers.con) seg.push("nocon");
  if (!f.layers.ccm) seg.push("nodir");
  if (f.layers.rejected) seg.push("rej");
  if (f.crossOnly) seg.push("x");
  if (f.hubsOnly) seg.push("h");
  if (f.fn != null) seg.push("fn-" + encodeURIComponent(f.fn));
  if (f.taxon) seg.push(`t-${f.taxon.rank}-${encodeURIComponent(f.taxon.value)}`);
  if (f.asvs?.ids.length)
    seg.push("a" + (f.asvs.neighbors ? "n" : "") + "-" + f.asvs.ids.join("."));
  if (f.size) seg.push(`sz-${f.size.dir === "top" ? "t" : "b"}${f.size.pct}`);
  if (f.strength) seg.push(`st-${f.strength.dir === "top" ? "t" : "b"}${f.strength.pct}`);
  return seg.join(";");
}

export function decodeFilters(s: string | null): Filters {
  const f = emptyFilters();
  if (!s) return f;
  for (const seg of s.split(";")) {
    if (seg === "ccm") f.layers = { ...f.layers, con: false, ccm: true };
    else if (seg === "nocon") f.layers = { ...f.layers, con: false };
    else if (seg === "nodir") f.layers = { ...f.layers, ccm: false };
    else if (seg === "rej") f.layers = { ...f.layers, rejected: true };
    else if (seg === "x") f.crossOnly = true;
    else if (seg === "h") f.hubsOnly = true;
    else if (seg.startsWith("fn-")) f.fn = decodeURIComponent(seg.slice(3));
    else if (seg.startsWith("m-")) {
      f.hidden = new Set(seg.slice(2).split(".").map(Number).filter(Number.isFinite));
    } else if (seg.startsWith("t-")) {
      const i = seg.indexOf("-", 2);
      if (i > 2) f.taxon = { rank: seg.slice(2, i), value: decodeURIComponent(seg.slice(i + 1)) };
    } else if (seg.startsWith("a-") || seg.startsWith("an-")) {
      const neighbors = seg.startsWith("an-");
      const ids = seg.slice(neighbors ? 3 : 2).split(".").filter(Boolean);
      if (ids.length) f.asvs = { ids, neighbors };
    } else if (/^s[zt]-[tb]\d+$/.test(seg)) {
      const q: QuantileFilter = { dir: seg[3] === "t" ? "top" : "bottom",
                                  pct: Math.min(100, Math.max(1, Number(seg.slice(4)))) };
      if (seg.startsWith("sz-")) f.size = q; else f.strength = q;
    }
  }
  return f;
}


export type LegendRow = {
  key: string; icon: string; term: string; desc: string;
  dim: boolean;
  struck?: boolean;
};

export function legendRows(o: {
  nModules: number;
  colorMode?: "module" | "function";
  nFunctionClasses?: number;
  sizePresent: boolean;
  conTr: number | null; conAlpha: number | null; ccmnTr: number | null; recorded: boolean;
  ccmVisible: boolean;
  rejectedVisible: boolean;
  widthText: string | null;
  hubMeasureLabel: string | null; hubK: number | null;
  highlightActive: boolean;
}): LegendRow[] {
  const rows: LegendRow[] = [
    { key: "node", icon: "●", term: "Node",
      desc: o.colorMode === "function"
        ? `colour = function (${o.nFunctionClasses ?? 0} classes, grey = not annotated)`
        : `colour = module (${o.nModules})`,
      dim: false },
    { key: "size", icon: "◯", term: "Size", desc: "total reads",
      dim: !o.sizePresent, struck: !o.sizePresent },
    { key: "edge", icon: "—", term: "Link", desc: "association", dim: false },
    { key: "ccm", icon: "→", term: "Arrow", desc: "direction", dim: !o.ccmVisible },
    ...(o.rejectedVisible
      ? [{ key: "rejected", icon: "⇢", term: "Dashed arrow", desc: "tested, rejected", dim: false }]
      : []),
    { key: "width", icon: "▬", term: "Width", desc: "strength", dim: o.widthText == null },
  ];
  if (o.hubMeasureLabel != null && o.hubK != null) {
    rows.push({ key: "hub", icon: "◎", term: "Hub", desc: "see ⚙", dim: false });
  }
  rows.push({ key: "highlight", icon: "◌", term: "Ring", desc: "same taxon",
    dim: !o.highlightActive });
  return rows;
}

export function thresholdLine(o: {
  conTr: number | null; conAlpha: number | null; ccmnTr: number | null; recorded: boolean;
}): string {
  if (!o.recorded) return "thresholds not recorded";
  const t = (v: number | null) => (v != null ? String(v) : "not recorded");
  return `|r| ≥ ${t(o.conTr)} · p < ${t(o.conAlpha)} · NMI ≥ ${t(o.ccmnTr)}`;
}

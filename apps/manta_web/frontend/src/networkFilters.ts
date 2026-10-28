import type { NetEdge, NetNode, Network } from "./api";


export type KeystoneCrit = 1 | 2;

export const KEYSTONE_LABEL: Record<KeystoneCrit, string> = {
  1: "1 · significant CCM link",
  2: "2 · high closeness in the CCM network",
};

export type KeystoneParams = { crit: KeystoneCrit; p1: number; links1: number; q2: number };

export const KEYSTONE_DEFAULTS: KeystoneParams = { crit: 2, p1: 0.05, links1: 1, q2: 0.05 };

const keystoneKey = (ds: string) => `manta-keystone:${ds}`;

export function loadKeystone(ds: string): KeystoneParams {
  try { return { ...KEYSTONE_DEFAULTS, ...JSON.parse(localStorage.getItem(keystoneKey(ds)) ?? "{}") }; }
  catch { return KEYSTONE_DEFAULTS; }
}

export function saveKeystone(ds: string, k: KeystoneParams) {
  try { localStorage.setItem(keystoneKey(ds), JSON.stringify(k)); } catch { }
}

export type FilterKind = "modules" | "layer" | "cross" | "c2" | "taxon" | "asvs"
  | "presence" | "abundance" | "strength" | "occurrence";

export type TaxonFilter = { rank: string; value: string };
// ids empty = nothing shown yet ("start new: none"). expand = ids whose partners are shown too
// (explore clicks); neighbors = the partners of all ids are shown.
export type AsvFilter = { ids: string[]; neighbors: boolean; expand?: string[] };
export type OccurrenceFilter = {
  from: string | null; to: string | null; months: number[]; share: number; min: number;
};
export type OccPoint = { date: string; share: number };

export type Filters = {
  hidden: Set<number>;
  layers: { con: boolean; ccm: boolean; rejected: boolean };
  crossOnly: boolean;
  c2Only: boolean;
  taxon: TaxonFilter | null;
  asvs: AsvFilter | null;
  presence: number | null;
  abundance: number | null;
  strength: number | null;
  abundanceMax: number | null;
  strengthMax: number | null;
  nmi: number | null;
  occurrence: OccurrenceFilter | null;
};

export const DEFAULT_LAYERS = { con: true, ccm: true, rejected: false } as const;

export const emptyFilters = (): Filters => ({
  hidden: new Set(), layers: { ...DEFAULT_LAYERS }, crossOnly: false, c2Only: false,
  taxon: null, asvs: null, presence: null, abundance: null, strength: null,
  abundanceMax: null, strengthMax: null, nmi: null, occurrence: null,
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

export const FILTER_KINDS: FilterKind[] = ["modules", "layer", "cross", "c2", "taxon",
                                           "asvs", "presence", "abundance", "strength",
                                           "occurrence"];

export const isActive = (f: Filters, k: FilterKind): boolean => {
  switch (k) {
    case "modules": return f.hidden.size > 0;
    case "layer": return !layersDefault(f.layers);
    case "cross": return f.crossOnly;
    case "c2": return f.c2Only;
    case "taxon": return f.taxon != null;
    case "asvs": return f.asvs != null;
    case "presence": return f.presence != null;
    case "abundance": return f.abundance != null || f.abundanceMax != null;
    case "strength": return f.strength != null || f.strengthMax != null || f.nmi != null;
    case "occurrence": return f.occurrence != null;
  }
};

export const takeKind = (dst: Filters, src: Filters, k: FilterKind): Filters => {
  switch (k) {
    case "modules": return { ...dst, hidden: src.hidden };
    case "layer": return { ...dst, layers: { ...src.layers } };
    case "cross": return { ...dst, crossOnly: src.crossOnly };
    case "c2": return { ...dst, c2Only: src.c2Only };
    case "taxon": return { ...dst, taxon: src.taxon };
    case "asvs": return { ...dst, asvs: src.asvs };
    case "presence": return { ...dst, presence: src.presence };
    case "abundance": return { ...dst, abundance: src.abundance, abundanceMax: src.abundanceMax };
    case "strength": return { ...dst, strength: src.strength, strengthMax: src.strengthMax,
                                         nmi: src.nmi };
    case "occurrence": return { ...dst, occurrence: src.occurrence };
  }
};

export const clearKind = (f: Filters, k: FilterKind): Filters => takeKind(f, emptyFilters(), k);

// "start new: none": nothing shown until ASVs are added.
export const startNone = (): Filters => ({ ...emptyFilters(), asvs: { ids: [], neighbors: false } });

// Explore: add the ASV to the shown ASVs, together with its partners.
export function exploreAdd(f: Filters, id: string): Filters {
  const a = f.asvs ?? { ids: [], neighbors: false };
  return { ...f, asvs: { ...a, ids: [...new Set([...a.ids, id])],
                         expand: [...new Set([...(a.expand ?? []), id])] } };
}

export type Visible = {
  nodes: NetNode[];
  edges: NetEdge[];
  edgesInView: NetEdge[];
};

const hasCcm = (e: NetEdge) => (e.ccm_dirs ?? 0) > 0;
const hasRejected = (e: NetEdge) => (e.rejected_dirs ?? 0) > 0;

export const ABUNDANCE_STEPS = [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5];

export function occurrenceCount(pts: OccPoint[], o: OccurrenceFilter): number {
  return pts.filter((p) => (o.from == null || p.date >= o.from) && (o.to == null || p.date <= o.to)
    && (o.months.length === 0 || o.months.includes(Number(p.date.slice(5, 7))))
    && p.share > 0 && p.share * 100 >= o.share).length;
}

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function rangeLabel(lo: number | null, hi: number | null, fmt: (v: number) => string): string {
  if (lo != null && hi != null) return `${fmt(lo)} – ${fmt(hi)}`;
  return lo != null ? `≥ ${fmt(lo)}` : `≤ ${fmt(hi ?? 0)}`;
}

export function occurrenceLabel(o: OccurrenceFilter): string {
  const parts: string[] = [];
  if (o.from || o.to) parts.push(`${o.from ?? "start"} – ${o.to ?? "end"}`);
  if (o.months.length) parts.push(o.months.map((m) => MONTH_ABBR[m - 1]).join(","));
  return `present ${parts.join(" · ") || "anytime"} · share ≥ ${o.share} %`
    + (o.min > 1 ? ` · ≥ ${o.min} samples` : "");
}

export function computeVisible(net: Network, f: Filters, c2Ids: Set<string>,
                               occ?: Map<string, OccPoint[]> | null): Visible {
  const asvSet = new Set(f.asvs?.ids ?? []);
  const offen = f.asvs?.neighbors ? asvSet : new Set(f.asvs?.expand ?? []);
  const neighborSet = new Set<string>();
  if (offen.size) {
    for (const e of net.edges) {
      if (offen.has(e.source)) neighborSet.add(e.target);
      if (offen.has(e.target)) neighborSet.add(e.source);
    }
  }
  const asvActive = f.asvs != null;
  const pass = (n: NetNode): boolean => {
    if (f.hidden.has(n.cluster)) return false;
    if (f.c2Only && !c2Ids.has(n.id)) return false;
    if (f.taxon
        && (n as unknown as Record<string, unknown>)[f.taxon.rank] !== f.taxon.value) return false;
    if (asvActive && !asvSet.has(n.id) && !neighborSet.has(n.id)) return false;
    if (f.presence != null && (n.n_samples_present ?? 0) < f.presence) return false;
    if (f.abundance != null && (n.rel_abundance ?? 0) * 100 < f.abundance) return false;
    if (f.abundanceMax != null && (n.rel_abundance ?? 0) * 100 > f.abundanceMax) return false;
    if (f.occurrence && occ
        && occurrenceCount(occ.get(n.id) ?? [], f.occurrence) < f.occurrence.min) return false;
    return true;
  };
  const nodes = net.nodes.filter(pass);
  const ids = new Set(nodes.map((n) => n.id));
  const clusterOf = new Map(net.nodes.map((n) => [n.id, n.cluster]));
  const isCross = (e: NetEdge) => clusterOf.get(e.source) !== clusterOf.get(e.target);
  const strengthPass = (e: NetEdge): boolean =>
    (f.strength == null || (e.corr != null && Math.abs(e.corr) >= f.strength))
    && (f.strengthMax == null || (e.corr != null && Math.abs(e.corr) <= f.strengthMax))
    && (f.nmi == null || Math.max(e.ccm_forward ? e.nmi_forward ?? 0 : 0,
                                  e.ccm_backward ? e.nmi_backward ?? 0 : 0) >= f.nmi);
  const edgesInView = net.edges.filter((e) => ids.has(e.source) && ids.has(e.target));
  const L = f.layers;
  const layerPass = (e: NetEdge): boolean =>
    L.con || (L.ccm && hasCcm(e)) || (L.rejected && hasRejected(e));
  const edges = edgesInView.filter(
    (e) => (!f.crossOnly || isCross(e)) && layerPass(e) && strengthPass(e));
  const layerRestricts = !L.con && (L.ccm || L.rejected);
  const edgeFilterActive = f.crossOnly || layerRestricts
    || f.strength != null || f.strengthMax != null || f.nmi != null;
  if (!edgeFilterActive) return { nodes, edges, edgesInView };
  const linked = new Set<string>();
  edges.forEach((e) => { linked.add(e.source); linked.add(e.target); });
  return { nodes: nodes.filter((n) => linked.has(n.id)), edges, edgesInView };
}

export function hiddenBy(net: Network, f: Filters, c2Ids: Set<string>, id: string,
                         occ?: Map<string, OccPoint[]> | null): FilterKind[] {
  if (!net.nodes.some((n) => n.id === id)) return [];
  const sichtbar = (g: Filters) => computeVisible(net, g, c2Ids, occ).nodes.some((n) => n.id === id);
  if (sichtbar(f)) return [];
  const aktiv = FILTER_KINDS.filter((k) => isActive(f, k));
  const schuld = aktiv.filter((k) => !sichtbar(takeKind(emptyFilters(), f, k)));
  let ohne = schuld.reduce((g, k) => clearKind(g, k), f);
  for (const k of aktiv) {
    if (sichtbar(ohne)) break;
    if (schuld.includes(k)) continue;
    schuld.push(k);
    ohne = clearKind(ohne, k);
  }
  return FILTER_KINDS.filter((k) => schuld.includes(k));
}

export function chainedCounts(net: Network, f: Filters, c2Ids: Set<string>,
                              order: FilterKind[],
                              occ?: Map<string, OccPoint[]> | null): Map<FilterKind, number> {
  const m = new Map<FilterKind, number>();
  let partial = emptyFilters();
  for (const k of order) {
    partial = takeKind(partial, f, k);
    m.set(k, computeVisible(net, partial, c2Ids, occ).nodes.length);
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
  if (f.c2Only) seg.push("c2");
  if (f.taxon) seg.push(`t-${f.taxon.rank}-${encodeURIComponent(f.taxon.value)}`);
  if (f.asvs) {
    seg.push("a" + (f.asvs.neighbors ? "n" : "") + "-" + f.asvs.ids.join("."));
    const ex = (f.asvs.expand ?? []).filter((id) => f.asvs!.ids.includes(id));
    if (ex.length && !f.asvs.neighbors) seg.push("ax-" + ex.join("."));
  }
  if (f.presence != null) seg.push(`pr-${f.presence}`);
  if (f.abundance != null) seg.push(`ab-${f.abundance}`);
  if (f.strength != null) seg.push(`r-${f.strength}`);
  if (f.abundanceMax != null) seg.push(`abx-${f.abundanceMax}`);
  if (f.strengthMax != null) seg.push(`rx-${f.strengthMax}`);
  if (f.nmi != null) seg.push(`nmi-${f.nmi}`);
  if (f.occurrence) {
    const o = f.occurrence;
    seg.push("o-" + [o.from ?? "", o.to ?? "", o.months.join("."), o.share, o.min].join("_"));
  }
  return seg.join(";");
}

export function decodeFilters(s: string | null): Filters {
  const f = emptyFilters();
  if (!s) return f;
  let expand: string[] = [];
  for (const seg of s.split(";")) {
    if (seg === "ccm") f.layers = { ...f.layers, con: false, ccm: true };
    else if (seg === "nocon") f.layers = { ...f.layers, con: false };
    else if (seg === "nodir") f.layers = { ...f.layers, ccm: false };
    else if (seg === "rej") f.layers = { ...f.layers, rejected: true };
    else if (seg === "x") f.crossOnly = true;
    else if (seg === "c2" || seg === "h") f.c2Only = true;
    else if (seg.startsWith("m-")) {
      f.hidden = new Set(seg.slice(2).split(".").map(Number).filter(Number.isFinite));
    } else if (seg.startsWith("t-")) {
      const i = seg.indexOf("-", 2);
      if (i > 2) f.taxon = { rank: seg.slice(2, i), value: decodeURIComponent(seg.slice(i + 1)) };
    } else if (seg.startsWith("a-") || seg.startsWith("an-")) {
      const neighbors = seg.startsWith("an-");
      const ids = seg.slice(neighbors ? 3 : 2).split(".").filter(Boolean);
      f.asvs = { ids, neighbors };
    } else if (seg.startsWith("ax-")) {
      expand = seg.slice(3).split(".").filter(Boolean);
    } else if (/^pr-\d+$/.test(seg)) {
      const n = Number(seg.slice(3));
      if (n >= 1) f.presence = n;
    } else if (/^ab-[\d.]+$/.test(seg)) {
      const v = Number(seg.slice(3));
      if (v > 0) f.abundance = v;
    } else if (/^abx-[\d.]+$/.test(seg)) {
      const v = Number(seg.slice(4));
      if (v > 0) f.abundanceMax = v;
    } else if (/^rx-[\d.]+$/.test(seg)) {
      const v = Number(seg.slice(3));
      if (v > 0 && v <= 1) f.strengthMax = v;
    } else if (/^nmi-[\d.]+$/.test(seg)) {
      const v = Number(seg.slice(4));
      if (v >= 0 && v <= 1) f.nmi = v;
    } else if (seg.startsWith("o-")) {
      const [from, to, months, share, min] = seg.slice(2).split("_");
      const sh = Number(share), mi = Number(min);
      if (Number.isFinite(sh) && sh >= 0 && Number.isInteger(mi) && mi >= 1) {
        f.occurrence = { from: from || null, to: to || null, share: sh, min: mi,
          months: (months ?? "").split(".").map(Number).filter((m) => m >= 1 && m <= 12) };
      }
    } else if (/^r-[\d.]+$/.test(seg)) {
      const v = Number(seg.slice(2));
      if (v > 0 && v <= 1) f.strength = v;
    }
  }
  if (f.asvs && expand.length) f.asvs = { ...f.asvs, expand: expand.filter((id) => f.asvs!.ids.includes(id)) };
  return f;
}


export type LegendRow = {
  key: string; icon: string; term: string; desc: string;
  dim: boolean;
  struck?: boolean;
  color?: string;
};

export const CROSS_LINK_COLOR = "var(--cross-link)";

export function legendRows(o: {
  nModules: number;
  nCross?: number | null;
  sizePresent: boolean | null;
  conTr: number | null; conAlpha: number | null; recorded: boolean;
  ccmVisible: boolean;
  rejectedVisible: boolean;
  widthText: string | null;
  c2Glow: string | null; c2Visible?: boolean;
  highlightActive: boolean;
}): LegendRow[] {
  const rows: LegendRow[] = [
    { key: "node", icon: "●", term: "Node",
      desc: `colour = module (${o.nModules})`,
      dim: false },
    { key: "size", icon: "◯", term: "Size", desc: "reads summed over all samples",
      dim: o.sizePresent === false, struck: o.sizePresent === false },
    { key: "edge", icon: "—", term: "Link", desc: "association", dim: false },
    { key: "cross", icon: "—", term: "Amber", color: CROSS_LINK_COLOR,
      desc: `link between two modules${o.nCross != null ? ` (${o.nCross})` : ""}`,
      dim: (o.nCross ?? 0) === 0 },
    { key: "ccm", icon: "→", term: "Arrow", desc: "direction", dim: !o.ccmVisible },
    ...(o.rejectedVisible
      ? [{ key: "rejected", icon: "⇢", term: "Dashed arrow", desc: "tested, rejected", dim: false }]
      : []),
    { key: "width", icon: "▬", term: "Width", desc: "strength", dim: o.widthText == null },
  ];
  if (o.c2Glow != null) {
    rows.push({ key: "c2", icon: "✦", term: "Keystone", desc: o.c2Glow, dim: o.c2Visible === false });
  }
  rows.push({ key: "highlight", icon: "◌", term: "Ring", desc: "same taxon",
    dim: !o.highlightActive });
  return rows;
}

export function thresholdLine(o: {
  conTr: number | null; conAlpha: number | null; recorded: boolean;
}): string {
  if (!o.recorded) return "thresholds not recorded";
  const t = (v: number | null) => (v != null ? String(v) : "not recorded");
  return `r ≥ ${t(o.conTr)} (positive only) · p < ${t(o.conAlpha)}`;
}

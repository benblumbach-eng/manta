import type { NetEdge, NetNode } from "./api";


export const TAXONOMY_RANKS = [
  "kingdom", "phylum", "class", "order", "family", "genus", "species",
] as const;

export const TAXONOMY_PLACEHOLDERS = [
  "unassigned", "NA", "", "Environment_Condition", "uncultured",
];

export type TaxonPoint = {
  id: string;
  label: string;
  path: Record<string, string | null>;
  members: NetNode[];
  cluster: number | null;
  size: number | null;
  n_samples_present: number;
};

export type TaxonLink = {
  source: string;
  target: string;
  n_links: number;
  n_directed: number;
};

const platzhalter = (v: string | null | undefined) =>
  TAXONOMY_PLACEHOLDERS.includes((v ?? "").trim());

export function groupable(n: Partial<NetNode>): boolean {
  if (!((n.genus ?? "").trim())) return false;
  return !TAXONOMY_RANKS.some((r) => platzhalter((n as Record<string, string | null>)[r]));
}

export function taxonLabel(path: Record<string, string | null>): string {
  const genus = (path.genus ?? "").trim();
  const roh = (path.species ?? "").trim();
  if (!genus) return "unassigned";
  if (!roh || platzhalter(roh)) return genus;
  const art = roh.replace(/_/g, " ").trim();
  if (art === genus || art === `${genus} sp.` || art === `${genus} sp`) return genus;
  if (art.startsWith(`${genus} `)) return art;
  return `${genus} ${art}`;
}

const SEP = "\u0000";

function keyOf(n: NetNode): string {
  return TAXONOMY_RANKS
    .map((r) => (n as unknown as Record<string, string | null>)[r] ?? "")
    .join(SEP);
}

export function taxonPoints(nodes: NetNode[]): TaxonPoint[] {
  const groups = new Map<string, NetNode[]>();
  const einzeln: NetNode[] = [];
  for (const n of nodes) {
    if (!groupable(n)) { einzeln.push(n); continue; }
    const k = keyOf(n);
    const g = groups.get(k);
    if (g) g.push(n); else groups.set(k, [n]);
  }
  const punkt = (id: string, members: NetNode[]): TaxonPoint => {
    const path = Object.fromEntries(
      TAXONOMY_RANKS.map((r) => [r, (members[0] as unknown as Record<string, string | null>)[r]]));
    const cl = new Set(members.map((m) => m.cluster));
    const size = members.some((m) => m.size == null)
      ? null : members.reduce((a, m) => a + (m.size ?? 0), 0);
    return {
      id, label: taxonLabel(path), path, members,
      cluster: cl.size === 1 ? members[0].cluster : null,
      size,
      n_samples_present: Math.max(...members.map((m) => m.n_samples_present ?? 0), 0),
    };
  };
  const punkte = [...groups.entries()].map(([k, members]) => punkt("tax:" + k, members));
  for (const n of einzeln) punkte.push(punkt("asv:" + n.id, [n]));
  punkte.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return punkte;
}

export function taxonLinks(points: TaxonPoint[], edges: NetEdge[]): TaxonLink[] {
  const wohin = new Map<string, string>();
  for (const p of points) for (const m of p.members) wohin.set(m.id, p.id);
  const acc = new Map<string, TaxonLink>();
  for (const e of edges) {
    const a = wohin.get(e.source);
    const b = wohin.get(e.target);
    if (!a || !b || a === b) continue;
    const [s, t] = a < b ? [a, b] : [b, a];
    const k = s + SEP + t;
    const cur = acc.get(k) ?? { source: s, target: t, n_links: 0, n_directed: 0 };
    cur.n_links += 1;
    if ((e.ccm_dirs ?? 0) > 0) cur.n_directed += 1;
    acc.set(k, cur);
  }
  return [...acc.values()].sort((x, y) =>
    x.source === y.source ? (x.target < y.target ? -1 : 1) : (x.source < y.source ? -1 : 1));
}

export function revolverPositions(n: number, radius: number): { dx: number; dy: number }[] {
  return Array.from({ length: n }, (_, i) => {
    const w = -Math.PI / 2 + (2 * Math.PI * i) / Math.max(1, n);
    return { dx: radius * Math.cos(w), dy: radius * Math.sin(w) };
  });
}

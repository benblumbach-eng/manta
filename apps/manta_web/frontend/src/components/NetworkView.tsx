import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactECharts from "echarts-for-react";
import { getCapabilities, getHubCriterion, getNetwork,
         type Capabilities, type Dataset, type HubCriterion, type NetEdge, type NetNode, type Network } from "../api";
import type { EdgeRef } from "../App";
import ClusterPanel from "./ClusterPanel";
import PanelFrame from "./PanelFrame";
import LegendPanel from "./LegendPanel";
import NetworkSidebar, { type ViewItem } from "./NetworkSidebar";
import ThemeSwitch, { type Theme } from "./ThemeSwitch";
import { useModules } from "../modules";
import { clusterColor as paletteColor } from "../clusterPalette";
import { revolverPositions, taxonLinks, taxonPoints } from "../taxonView";
import ThresholdDialog from "./ThresholdDialog";
import { chainedCounts, clearKind, computeVisible, decodeFilters, emptyFilters, encodeFilters,
         isActive, legendRows, thresholdLine, FILTER_KINDS,
         type Filters, type FilterKind, layerLabel, layersDefault, functionLabel } from "../networkFilters";

const NODE_OUTLINE = "#0f172a";
const COLLIDE_MARGIN = 1.5;
const COLLIDE_ITERATIONS = 80;
const DIM_NODE = 0.2;
const revolverRadiusPx = (n: number) => Math.max(70, 4.5 * n + 20);
const istSatellit = (n: unknown) =>
  (n as { revX?: number }).revX != null && (n as { revY?: number }).revY != null;
const istRing = (p: { data?: { id?: unknown; source?: unknown } }) =>
  /^(ring|disc):/.test(String(p.data?.id ?? p.data?.source ?? ""));
const LINK_LENGTH_DEFAULT = 260;
const NODE_SCALE_RATIO = 0.6;
const RING_W = 2;
const RING_GLOW = 14;
const DIM_EDGE = 0.15;

function resolveCollisions(pos: Map<string, [number, number]>,
                           radius: (id: string) => number): Map<string, [number, number]> {
  const p = [...pos.keys()].sort().map((id) => (
    { id, x: pos.get(id)![0], y: pos.get(id)![1], r: radius(id) + COLLIDE_MARGIN }));
  for (let it = 0; it < COLLIDE_ITERATIONS; it++) {
    let moved = false;
    for (let i = 0; i < p.length; i++) {
      for (let j = i + 1; j < p.length; j++) {
        const a = p[i], b = p[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.hypot(dx, dy);
        const min = a.r + b.r;
        if (d >= min) continue;
        const ux = d > 1e-6 ? dx / d : 1, uy = d > 1e-6 ? dy / d : 0;
        const push = (min - d) / 2;
        a.x -= ux * push; a.y -= uy * push;
        b.x += ux * push; b.y += uy * push;
        moved = true;
      }
    }
    if (!moved) break;
  }
  return new Map(p.map((q) => [q.id, [q.x, q.y] as [number, number]]));
}

type Sel =
  | { kind: "asv"; id: string;
      focus?: number;
      label?: boolean }
  | { kind: "taxon"; rank: string; value: string }
  | { kind: "cluster"; label: number };

export default function NetworkView({ dataset, onOpenAsv, onOpenEdge,
                                      onOpenEnvironment, environmentOpen,
                                      onOpenStarred, starredOpen, clusterVonAussen,
                                      onOpenWheel, wheelOpen,
                                      onOpenEla, elaOpen,
                                      onOpenCompare, compareOpen,
                                      openAsvId, isAdmin, onOpenTaxon, onCloseView,
                                      onShowNet,
                                      settingsOpen, theme, onTheme,
                                      onRefresh }: {
  dataset: Dataset;
  onOpenAsv: (id: string) => void;
  openAsvId: string | null;
  isAdmin: boolean;
  onOpenTaxon: (asvId: string) => void;
  onCloseView: (kind: string) => void;
  onShowNet: () => void;
  settingsOpen: boolean;
  theme: Theme;
  onTheme: (t: Theme) => void;
  onOpenEdge: (e: EdgeRef) => void;
  onOpenEnvironment: () => void;
  onOpenStarred: () => void;
  starredOpen: boolean;
  clusterVonAussen: { label: number; tick: number } | null;
  environmentOpen: boolean;
  onOpenWheel: () => void;
  wheelOpen: boolean;
  onOpenEla: () => void;
  elaOpen: boolean;
  onOpenCompare: () => void;
  compareOpen: boolean;
  onRefresh?: () => void;
}) {
  const modules = useModules();
  const [net, setNet] = useState<Network | null>(null);
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [selectedCluster, setSelectedCluster] = useState<number | null>(null);
  useEffect(() => { if (clusterVonAussen != null) setSelectedCluster(clusterVonAussen.label); },
            [clusterVonAussen]);
  const [labelMode, setLabelMode] = useState<"auto" | "on" | "off">("auto");
  const [frozen, setFrozen] = useState<Map<string, [number, number]> | null>(null);
  const chartRef = useRef<ReactECharts>(null);
  const [showThresholds, setShowThresholds] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const light = theme === "light";

  const [filters, setFilters] = useState<Filters>(
    () => decodeFilters(new URLSearchParams(window.location.search).get("f")));
  const [order, setOrder] = useState<FilterKind[]>(
    () => FILTER_KINDS.filter((k) => isActive(
      decodeFilters(new URLSearchParams(window.location.search).get("f")), k)));
  useEffect(() => {
    setOrder((prev) => {
      const kept = prev.filter((k) => isActive(filters, k));
      const added = FILTER_KINDS.filter((k) => isActive(filters, k) && !kept.includes(k));
      const next = [...kept, ...added];
      return next.length === prev.length && next.every((k, i) => k === prev[i]) ? prev : next;
    });
  }, [filters]);
  useEffect(() => {
    const u = new URL(window.location.href);
    const s = encodeFilters(filters);
    if (s) u.searchParams.set("f", s); else u.searchParams.delete("f");
    window.history.replaceState(null, "", u);
  }, [filters]);
  const patchFilters = useCallback(
    (patch: Partial<Filters>) => setFilters((prev) => ({ ...prev, ...patch })), []);

  const [sel, setSel] = useState<Sel | null>(null);
  const [vorherOffen, setVorherOffen] = useState<string | null>(openAsvId);
  if (vorherOffen !== openAsvId) {
    setVorherOffen(openAsvId);
    if (openAsvId == null && sel?.kind === "asv") setSel(null);
    else if (openAsvId != null && sel?.kind === "asv" && sel.id !== openAsvId)
      setSel({ kind: "asv", id: openAsvId });
  }
  const focusTimer = useRef<number | null>(null);
  const roam = useRef<{ zoom: number; center: [number, number] } | null>(null);
  useEffect(() => () => { if (focusTimer.current) clearTimeout(focusTimer.current); }, []);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setRevolver((r) => { if (r) return null; setSel(null); return r; });
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  useEffect(() => {
    setNet(null); setErr(null);
    getNetwork(dataset.dataset_id, "con", dataset.marker).then(setNet).catch((e) => setErr(String(e)));
    setCaps(null);
    getCapabilities(dataset.dataset_id).then(setCaps).catch(() => setCaps(null));
    setHubSel(null); setHubOverride(null);
    setSel(null);
  }, [dataset.dataset_id, dataset.marker, reloadKey]);

  const clusters = useMemo(
    () => (net ? [...new Set(net.nodes.map((n) => n.cluster))].sort((a, b) => a - b) : []),
    [net],
  );
  const clusterColor = useMemo(() => {
    const m = new Map<number, string>();
    net?.nodes.forEach((n) => { if (!m.has(n.cluster)) m.set(n.cluster, modules.color(n.cluster)); });
    return m;
  }, [net, modules]);
  const countByCluster = useMemo(() => {
    const m = new Map<number, number>();
    net?.nodes.forEach((n) => m.set(n.cluster, (m.get(n.cluster) ?? 0) + 1));
    return m;
  }, [net]);
  const nodeCluster = useMemo(() => {
    const m = new Map<string, number>();
    net?.nodes.forEach((n) => m.set(n.id, n.cluster));
    return m;
  }, [net]);
  const isCross = (e: NetEdge) => nodeCluster.get(e.source) !== nodeCluster.get(e.target);
  const hasCcm = (e: NetEdge) => (e.ccm_dirs ?? 0) > 0;
  const hasRejected = (e: NetEdge) => (e.rejected_dirs ?? 0) > 0;

  const [hubSel, setHubSel] = useState<{ measure: string; k: number } | null>(null);
  const [hubOverride, setHubOverride] = useState<HubCriterion | null>(null);
  useEffect(() => {
    if (!hubSel) { setHubOverride(null); return; }
    let dead = false;
    getHubCriterion(dataset.dataset_id, hubSel.measure, hubSel.k)
      .then((h) => { if (!dead) setHubOverride(h); })
      .catch(() => { });
    return () => { dead = true; };
  }, [hubSel, dataset.dataset_id]);
  const hub: HubCriterion | null = hubOverride ?? net?.hubs ?? null;
  const hubIds = useMemo(() => new Set(hub?.ids ?? []), [hub]);

  const vis = useMemo(
    () => (net ? computeVisible(net, filters, hubIds) : null),
    [net, filters, hubIds]);
  const visibleNodes = useMemo(() => vis?.nodes ?? [], [vis]);
  const visibleEdges = useMemo(() => vis?.edges ?? [], [vis]);
  const edgesInView = useMemo(() => vis?.edgesInView ?? [], [vis]);
  const visibleIds = useMemo(() => new Set(visibleNodes.map((n) => n.id)), [visibleNodes]);

  const [taxaMode, setTaxaMode] = useState(false);
  const [legendeOffen, setLegendeOffen] = useState(false);
  const [revolver, setRevolver] =
    useState<{ id: string; x: number; y: number; r: number; tick: number } | null>(null);
  const [linkLen, setLinkLen] = useState(LINK_LENGTH_DEFAULT);
  const [zoomTick, setZoomTick] = useState(0);
  useEffect(() => { setRevolver(null); }, [taxaMode, filters, linkLen]);

  const taxa = useMemo(
    () => (taxaMode ? taxonPoints(visibleNodes) : []), [taxaMode, visibleNodes]);
  const taxaLinks = useMemo(
    () => (taxaMode ? taxonLinks(taxa, visibleEdges) : []), [taxaMode, taxa, visibleEdges]);
  const taxaById = useMemo(() => new Map(taxa.map((t) => [t.id, t])), [taxa]);

  const [colorMode, setColorMode] = useState<"module" | "function">("module");
  const functionClasses = useMemo(() => {
    const m = new Map<string, number>();
    net?.nodes.forEach((n) => { if (n.trait_group) m.set(n.trait_group, (m.get(n.trait_group) ?? 0) + 1); });
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))
      .map(([label, n], i) => ({ label, n, color: paletteColor(i) }));
  }, [net]);
  const functionColor = useMemo(
    () => new Map(functionClasses.map((c) => [c.label, c.color])), [functionClasses]);
  const NO_FUNCTION = "#94a3b8";
  const colorOfNode = (n: NetNode): string => {
    if (colorMode !== "function") return n.cluster < 0 ? NO_FUNCTION : modules.color(n.cluster);
    const tp = taxaById.get(n.id);
    const groups = new Set(tp ? tp.members.map((m) => m.trait_group ?? null) : [n.trait_group ?? null]);
    if (groups.size !== 1) return NO_FUNCTION;
    const g = [...groups][0];
    return g ? (functionColor.get(g) ?? NO_FUNCTION) : NO_FUNCTION;
  };
  const taxaLayers = useMemo(() => {
    if (!taxaMode || !net) return null;
    const alle = taxonPoints(net.nodes);
    const con = taxonLinks(alle, net.edges);
    const mitRichtung = net.edges.filter((e) => (e.ccm_dirs ?? 0) > 0);
    const ccm = taxonLinks(alle, mitRichtung);
    const rej = taxonLinks(alle, net.edges.filter((e) => (e.rejected_dirs ?? 0) > 0));
    const beruehrt = (ls: { source: string; target: string }[]) =>
      new Set(ls.flatMap((l) => [l.source, l.target])).size;
    return { n_con: con.length, n_asv_con: beruehrt(con),
             n_con_with_ccm: ccm.length, n_asv_ccm: beruehrt(ccm),
             n_con_with_rejected: rej.length, n_asv_rejected: beruehrt(rej) };
  }, [taxaMode, net]);
  const offenerTaxon = revolver ? taxaById.get(revolver.id) ?? null : null;

  const drawNodes = useMemo<NetNode[]>(() => {
    if (!taxaMode) return visibleNodes;
    const punkte = taxa.map((t) => ({
      ...(t.members[0]),
      id: t.id,
      genus: t.label,
      cluster: t.cluster ?? -1,
      size: t.size,
      n_samples_present: t.n_samples_present,
    } as NetNode));
    if (!(offenerTaxon && revolver)) return punkte;
    const pos = revolverPositions(offenerTaxon.members.length, revolver.r);
    return [
      ...punkte,
      ...offenerTaxon.members.map((m, i) => ({
        ...m, genus: "", revX: revolver.x + pos[i].dx, revY: revolver.y + pos[i].dy,
      } as NetNode & { revX: number; revY: number })),
    ];
  }, [taxaMode, offenerTaxon, revolver, taxa, visibleNodes]);

  const drawEdges = useMemo<NetEdge[]>(() => {
    if (!taxaMode) return visibleEdges;
    return taxaLinks.map((l) => ({
      source: l.source, target: l.target,
      ccm_dirs: l.n_directed > 0 ? 1 : 0,
      tax: l,
    } as unknown as NetEdge));
  }, [taxaMode, taxaLinks, visibleEdges]);

  const crossCount = useMemo(() => edgesInView.filter(isCross).length, [edgesInView, nodeCluster]);
  const ccmCount = useMemo(() => edgesInView.filter(hasCcm).length, [edgesInView]);
  const rejectedCount = useMemo(() => edgesInView.filter(hasRejected).length, [edgesInView]);
  const allIds = useMemo(() => new Set(net?.nodes.map((n) => n.id) ?? []), [net]);
  const unknownAsvIds = useMemo(
    () => (filters.asvs?.ids ?? []).filter((id) => !allIds.has(id)),
    [filters.asvs, allIds]);
  const chipCounts = useMemo(
    () => (net ? chainedCounts(net, filters, hubIds, order) : new Map<FilterKind, number>()),
    [net, filters, hubIds, order]);

  const selMarked = useMemo(() => {
    if (!sel) return new Set<string>();
    if (sel.kind === "asv") return new Set(visibleIds.has(sel.id) ? [sel.id] : []);
    if (sel.kind === "taxon") {
      return new Set(visibleNodes
        .filter((n) => (n as unknown as Record<string, unknown>)[sel.rank] === sel.value)
        .map((n) => n.id));
    }
    return new Set(visibleNodes.filter((n) => n.cluster === sel.label).map((n) => n.id));
  }, [sel, visibleNodes, visibleIds]);
  const taxKey = sel?.kind === "taxon" ? `${sel.rank}:${sel.value}` : null;
  const TAX_OUTLINE = ["#e879f9", "#fb7185", "#a3e635", "#c084fc", "#34d399"];
  const taxColorOf = useCallback((key: string) => {
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
    return TAX_OUTLINE[h % TAX_OUTLINE.length];
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const markColor = sel?.kind === "cluster" ? taxColorOf(`cluster:${sel.label}`)
    : taxKey ? taxColorOf(taxKey) : null;

  const selHiddenBy = useMemo((): { label: string; kind: FilterKind } | null => {
    if (!net || !sel || sel.kind !== "asv" || visibleIds.has(sel.id)) return null;
    const n = net.nodes.find((x) => x.id === sel.id);
    if (!n) return null;
    if (filters.hidden.has(n.cluster)) return { label: `module ${n.cluster} hidden`, kind: "modules" };
    if (filters.hubsOnly && !hubIds.has(n.id)) return { label: "only hubs", kind: "hubs" };
    if (filters.taxon
        && (n as unknown as Record<string, unknown>)[filters.taxon.rank] !== filters.taxon.value)
      return { label: `${filters.taxon.value} (${filters.taxon.rank})`, kind: "taxon" };
    if ((filters.asvs?.ids.length ?? 0) > 0 && !filters.asvs!.ids.includes(n.id))
      return { label: "ASV selection", kind: "asvs" };
    if (filters.size)
      return { label: `node size (${filters.size.dir === "top" ? "largest" : "smallest"} ${filters.size.pct} %)`,
               kind: "size" };
    if (!layersDefault(filters.layers)) return { label: layerLabel(filters.layers), kind: "layer" };
    if (filters.fn != null && (n.trait_group ?? "") !== filters.fn)
      return { label: `function ${functionLabel(filters.fn)}`, kind: "function" };
    if (filters.crossOnly) return { label: "crossing links only", kind: "cross" };
    if (filters.strength)
      return { label: `link strength (${filters.strength.dir === "top" ? "strongest" : "weakest"} ${filters.strength.pct} %)`,
               kind: "strength" };
    return null;
  }, [net, sel, visibleIds, filters, hubIds]);

  const EDGE_W_MIN = 1, EDGE_W_MAX = 5;
  const widthKind: "corr" | "ccm" | "rejected" | null =
    filters.layers.con ? "corr" : filters.layers.ccm ? "ccm"
      : filters.layers.rejected ? "rejected" : null;
  const edgeStrength = useCallback((e: NetEdge): number | null => {
    if (widthKind === "rejected") {
      const r = [e.nmi_rejected_forward, e.nmi_rejected_backward].filter((v): v is number => v != null);
      return r.length ? Math.max(...r) : null;
    }
    if (widthKind === "corr") return e.corr != null ? Math.abs(e.corr) : null;
    if (widthKind === "ccm") {
      const vals = [e.nmi_forward, e.nmi_backward].filter((v): v is number => v != null);
      return vals.length ? Math.max(...vals) : null;
    }
    return null;
  }, [widthKind]);
  const [ewMin, ewMax] = useMemo(() => {
    let lo = Infinity, hi = -Infinity;
    const take = (v: number | null | undefined) => {
      if (v == null) return;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    };
    for (const e of visibleEdges) {
      if (widthKind === "rejected") { take(e.nmi_rejected_forward); take(e.nmi_rejected_backward); }
      else if (widthKind === "ccm") { take(e.nmi_forward); take(e.nmi_backward); }
      else if (widthKind === "corr") take(e.corr != null ? Math.abs(e.corr) : null);
    }
    return lo <= hi ? [lo, hi] : [null, null];
  }, [visibleEdges, widthKind]);
  const edgeWidth = useCallback((e: NetEdge): number => {
    const v = edgeStrength(e);
    if (v == null || ewMin == null || ewMax == null) return EDGE_W_MIN;
    if (ewMax - ewMin < 1e-12) return (EDGE_W_MIN + EDGE_W_MAX) / 2;
    return EDGE_W_MIN + (EDGE_W_MAX - EDGE_W_MIN) * (v - ewMin) / (ewMax - ewMin);
  }, [edgeStrength, ewMin, ewMax]);

  const LABEL_AUTO_MAX = 60;
  const showLabels = labelMode === "on" || (labelMode === "auto" && drawNodes.length <= LABEL_AUTO_MAX);

  const layoutKey = useMemo(
    () => `${dataset.dataset_id}|${filters.layers.con}|${filters.layers.ccm}|${filters.layers.rejected}`
         + `|${taxaMode ? "taxa" : "asvs"}|${linkLen}`
         + `|${drawNodes.filter((n) => !istSatellit(n)).map((n) => n.id).join(",")}`,
    [dataset.dataset_id, filters.layers, taxaMode, linkLen, drawNodes]);
  const frozenKey = useRef<string | null>(null);
  useEffect(() => {
    if (frozenKey.current !== layoutKey) { frozenKey.current = layoutKey; setFrozen(null); }
  }, [layoutKey]);

  const sizes = drawNodes.map((n) => n.size || 0);
  const maxSize = Math.max(1, ...sizes);
  const dense = drawNodes.length > 150;
  const scale = useCallback(
    (s: number) => (dense ? 7 : 10) + (dense ? 23 : 34) * Math.sqrt((s || 0) / maxSize),
    [dense, maxSize]);
  const radiusOf = useMemo(() => {
    const m = new Map<string, number>();
    drawNodes.forEach((n) => m.set(n.id, scale(n.size ?? 0) / 2));
    return m;
  }, [drawNodes, scale]);

  const freeze = useCallback(() => {
    if (frozen) return;
    try {
      const inst = chartRef.current?.getEchartsInstance();
      const data = (inst as any)?.getModel()?.getSeriesByIndex(0)?.getData();
      if (!data) return;
      const m = new Map<string, [number, number]>();
      for (let i = 0; i < data.count(); i++) {
        const l = data.getItemLayout(i);
        if (!l || !Number.isFinite(l[0])) return;
        m.set(String(data.getId(i)), [l[0], l[1]]);
      }
      if (m.size) setFrozen(resolveCollisions(m, (id) => radiusOf.get(id) ?? 5));
    } catch { }
  }, [frozen, radiusOf]);

  const runId = net?.thresholds?.run_id ?? "";
  const clusterOrder = useMemo(
    () => [...new Set(visibleNodes.map((n) => n.cluster))].sort((a, b) => a - b),
    [visibleNodes]);
  const seedXY = useCallback((id: string): [number, number] => {
    const key = `${dataset.dataset_id}|${runId}|${id}`;
    let h = 2166136261 >>> 0;
    for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    const a = (h >>> 0) / 4294967296;
    h ^= 0x9e3779b9; h = Math.imul(h ^ (h >>> 16), 2246822507) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 3266489909) >>> 0; h = (h ^ (h >>> 16)) >>> 0;
    const b = h / 4294967296;
    const k = clusterOrder.indexOf(nodeCluster.get(id) ?? clusterOrder[0]);
    const K = Math.max(1, clusterOrder.length);
    const ringR = K > 1 ? 420 : 0;
    const cx = 500 + ringR * Math.cos((2 * Math.PI * Math.max(0, k)) / K);
    const cy = 500 + ringR * Math.sin((2 * Math.PI * Math.max(0, k)) / K);
    const ang = 2 * Math.PI * a;
    const rad = 150 * Math.sqrt(b);
    return [cx + rad * Math.cos(ang), cy + rad * Math.sin(ang)];
  }, [dataset.dataset_id, runId, clusterOrder, nodeCluster]);

  const minGap = useMemo(() => {
    if (!frozen) return null;
    const pts = drawNodes
      .map((n) => ({ xy: frozen.get(n.id), r: radiusOf.get(n.id) ?? 0 }))
      .filter((e): e is { xy: [number, number]; r: number } => e.xy != null);
    let worst = Infinity;
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const gap = Math.hypot(pts[i].xy[0] - pts[j].xy[0], pts[i].xy[1] - pts[j].xy[1])
          - pts[i].r - pts[j].r;
        if (gap < worst) worst = gap;
      }
    }
    return Number.isFinite(worst) ? worst : null;
  }, [frozen, drawNodes, radiusOf, taxaById]);
  useEffect(() => {
    (window as unknown as Record<string, unknown>).__mantaLayout = frozen
      ? drawNodes.map((n) => ({ id: n.id,
                                xy: frozen.get(n.id)
                                  ?? (istSatellit(n)
                                    ? [(n as unknown as { revX: number }).revX,
                                       (n as unknown as { revY: number }).revY] as [number, number]
                                    : null),
                                sat: istSatellit(n),
                                r: radiusOf.get(n.id) ?? null,
                                n: taxaById.get(n.id)?.members.length ?? 1 }))
      : null;
  }, [frozen, visibleNodes, radiusOf]);
  useEffect(() => {
    (window as unknown as Record<string, unknown>).__mantaHighlight = sel
      ? { kind: sel.kind, marked: selMarked.size, dimmed: visibleNodes.length - selMarked.size }
      : null;
  }, [sel, selMarked, visibleNodes]);
  useEffect(() => {
    (window as unknown as Record<string, unknown>).__mantaNodePixel = (id: string) => {
      try {
        const inst = chartRef.current?.getEchartsInstance();
        const data = (inst as any)?.getModel()?.getSeriesByIndex(0)?.getData();
        if (!data) return null;
        for (let i = 0; i < data.count(); i++) {
          if (String(data.getId(i)) === id) {
            const el = data.getItemGraphicEl(i);
            if (!el) return null;
            return typeof el.transformCoordToGlobal === "function"
              ? el.transformCoordToGlobal(0, 0) : [el.x, el.y];
          }
        }
        return null;
      } catch { return null; }
    };
  }, []);
  useEffect(() => {
    (window as unknown as Record<string, unknown>).__mantaDisc = () => {
      try {
        const inst = chartRef.current?.getEchartsInstance();
        const data = (inst as any)?.getModel()?.getSeriesByIndex(0)?.getData();
        if (!data) return null;
        let disc: { fill: string; r: number } | null = null;
        let dimmed = 0, lit = 0;
        for (let i = 0; i < data.count(); i++) {
          const id = String(data.getId(i));
          if (id.startsWith("ring:")) continue;
          if (id.startsWith("disc:")) {
            const el = data.getItemGraphicEl(i);
            if (!el) return null;
            const rect = el.getBoundingRect().clone();
            rect.applyTransform(el.getComputedTransform());
            const path = el.childAt?.(0) ?? el;
            disc = { fill: String(path.style?.fill), r: rect.width / 2 };
            continue;
          }
          if (data.getItemModel(i).get(["itemStyle", "opacity"]) === DIM_NODE) dimmed++;
          else lit++;
        }
        return disc ? { ...disc, light, dimmed, lit } : null;
      } catch { return null; }
    };
  }, [light]);

  const layoutHash = useMemo(() => {
    if (!frozen) return "";
    const parts = [...frozen.entries()].sort(([a], [b]) => a.localeCompare(b))
      .map(([id, [x, y]]) => `${id}:${x.toFixed(1)},${y.toFixed(1)}`).join(";");
    let h = 2166136261 >>> 0;
    for (let i = 0; i < parts.length; i++) { h ^= parts.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return (h >>> 0).toString(16);
  }, [frozen]);

  const totalSize = useMemo(
    () => (net?.nodes ?? []).reduce((acc, n) => acc + (n.size || 0), 0), [net]);

  const appliedFocus = useRef<string | null>(null);
  const focusKey = sel?.kind === "asv" && sel.focus ? `${sel.id}:${sel.focus}` : null;
  const focusXY: [number, number] | null =
    focusKey && appliedFocus.current !== focusKey && sel?.kind === "asv"
      ? frozen?.get(sel.id) ?? null : null;
  useEffect(() => {
    if (!focusXY || !focusKey) return;
    roam.current = { zoom: dense ? 2.5 : 1.8, center: focusXY };
    appliedFocus.current = focusKey;
  }, [focusXY, focusKey, dense]);
  const ring = useMemo(() => {
    if (!(taxaMode && offenerTaxon && revolver)) return { nodes: [] as unknown[], links: [] as unknown[] };
    const N = 48;
    const key = (i: number) => `ring:${revolver.tick}:${i}`;
    const nodes = Array.from({ length: N }, (_, i) => {
      const w = (2 * Math.PI * i) / N;
      return { id: key(i), name: key(i), x: revolver.x + revolver.r * Math.cos(w),
               y: revolver.y + revolver.r * Math.sin(w), fixed: true, symbol: "circle",
               symbolSize: 1, silent: true, label: { show: false }, itemStyle: { opacity: 0 } };
    });
    const links = Array.from({ length: N }, (_, i) => ({
      source: key(i), target: key((i + 1) % N), silent: true,
      symbol: ["none", "none"],
      lineStyle: { color: light ? "#64748b" : "#94a3b8", width: 1, opacity: 0.45, type: "dashed" as const },
    }));
    return { nodes, links };
  }, [taxaMode, offenerTaxon, revolver, light]);

  const scheibe = useMemo(() => {
    if (!(taxaMode && offenerTaxon && revolver)) return null;
    let k = 1;
    try {
      const inst = chartRef.current?.getEchartsInstance();
      const a = (inst as any)?.convertToPixel({ seriesIndex: 0 }, [revolver.x, revolver.y]);
      const b = (inst as any)?.convertToPixel({ seriesIndex: 0 }, [revolver.x + 1, revolver.y]);
      const d = a && b ? Math.abs(b[0] - a[0]) : 0;
      if (Number.isFinite(d) && d > 0) k = d;
    } catch { }
    const nodeScale = ((roam.current?.zoom ?? 1) - 1) * NODE_SCALE_RATIO + 1;
    const satR = Math.max(0, ...offenerTaxon.members.map((m) => scale(m.size ?? 0) / 2)) * nodeScale;
    const rPx = revolver.r * k + satR + 8;
    const id = `disc:${revolver.tick}`;
    return { id, name: id, x: revolver.x, y: revolver.y, fixed: true, symbol: "circle",
             symbolSize: (2 * rPx) / nodeScale, label: { show: false },
             tooltip: { show: false }, emphasis: { disabled: true }, cursor: "default",
             itemStyle: { color: light ? "#ffffff" : "#000000", opacity: 1, borderWidth: 1,
                          borderType: "dashed" as const, borderColor: light ? "#64748b" : "#94a3b8" } };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taxaMode, offenerTaxon, revolver, light, scale, zoomTick]);
  const imRevolver = useCallback(
    (n: NetNode) => istSatellit(n) || (revolver != null && n.id === revolver.id), [revolver]);
  const zeichenfolge = useMemo(
    () => (scheibe
      ? [...drawNodes.filter((n) => !imRevolver(n)), ...drawNodes.filter(imRevolver)]
      : drawNodes),
    [drawNodes, scheibe, imRevolver]);
  const nUnterScheibe = scheibe ? drawNodes.filter((n) => !imRevolver(n)).length : 0;

  const nodeOutline = light ? "#ffffff" : NODE_OUTLINE;
  const selRing = light ? "#0f172a" : "#f8fafc";
  const labelColor = light ? "#1e293b" : "#cbd5e1";
  const labelBorder = light ? "#f6f8fb" : "#0f172a";
  const markTextFill = light ? "#b45309" : "#fbbf24";


  const option = useMemo(() => ({
    backgroundColor: "transparent",
    tooltip: {
      formatter: (p: any) => {
        if (istRing(p)) return "";
        const tax = p.data?.taxon as { label: string; n: number; nModules: number } | undefined;
        if (p.dataType === "node" && tax) {
          return `${tax.label}<br/><span style="opacity:.75">${tax.n} ASV`
            + `${tax.n === 1 ? "" : "s"}</span>`
            + (tax.nModules > 1
              ? `<br/><span style="opacity:.75">members in ${tax.nModules} modules</span>` : "");
        }
        const tl = p.data?.tax as { n_links: number; n_directed: number } | undefined;
        if (p.dataType === "edge" && tl) {
          return `${p.data.source} — ${p.data.target}`
            + `<br/><span style="opacity:.75">${tl.n_links} link`
            + `${tl.n_links === 1 ? "" : "s"} between members, ${tl.n_directed} with a `
            + `direction</span>`;
        }
        if (p.dataType === "node") return `${p.data.id}${p.data.value ? ` (${p.data.value})` : ""}`
          + (p.data.share != null
            ? `<br/><span style="opacity:.75">${(100 * p.data.share).toFixed(2)} % of the summed abundance of the ${p.data.nPool} network ASVs</span>`
            : "")
          + (p.data.hub ? `<br/><span style="color:#fbbf24">✦ ${hub?.node_tooltip ?? "hub"}</span>` : "");
        const e: NetEdge | undefined = p.data?.manta;
        if (!e) return "";
        const dir = e.ccm_forward && e.ccm_backward ? "↔"
          : e.ccm_forward ? "→" : e.ccm_backward ? "←" : "—";
        const ccm = (e.ccm_dirs ?? 0) === 0
          ? "co-occurrence only — no measurable direction"
          : e.ccm_dirs === 2 ? "CCM in both directions" : "CCM in one direction";
        return `${e.source} ${dir} ${e.target}<br/>corr ${e.corr?.toFixed(4)} · p ${e.p_value?.toFixed(4)}`
          + (e.nmi_forward != null ? `<br/>NMI → ${e.nmi_forward.toFixed(4)}` : "")
          + (e.nmi_backward != null ? `<br/>NMI ← ${e.nmi_backward.toFixed(4)}` : "")
          + (e.nmi_rejected_forward != null
            ? `<br/><span style="opacity:.75">NMI → ${e.nmi_rejected_forward.toFixed(4)} · tested, rejected</span>` : "")
          + (e.nmi_rejected_backward != null
            ? `<br/><span style="opacity:.75">NMI ← ${e.nmi_rejected_backward.toFixed(4)} · tested, rejected</span>` : "")
          + `<br/><span style="opacity:.75">${ccm}</span>`
          + (edgeStrength(e) != null && ewMin != null && ewMax != null
            ? `<br/><span style="opacity:.75">line width = ${widthKind === "rejected" ? "NMI of the rejected direction" : widthKind === "ccm" ? "largest NMI" : "|corr|"} `
              + `${edgeStrength(e)!.toFixed(3)} (this view: ${ewMin.toFixed(3)}–${ewMax.toFixed(3)})</span>`
            : "")
          + (isCross(e) ? "<br/>crosses clusters" : "")
          + `<br/><span style="opacity:.65">click to open this link</span>`;
      },
    },
    series: [
      {
        type: "graph",
        layout: frozen ? "none" : "force",
        roam: true,
        draggable: true,
        ...(focusXY ? { zoom: dense ? 2.5 : 1.8, center: focusXY }
                    : roam.current ? { zoom: roam.current.zoom, center: roam.current.center }
                    : {}),
        force: { repulsion: 2600, edgeLength: linkLen, gravity: 0.06, layoutAnimation: false },
        data: [...ring.nodes, ...(() => { const pts = zeichenfolge.map((n) => {
          const rev = n as unknown as { revX?: number; revY?: number };
          const istRevolver = istSatellit(n);
          const xy: [number, number] = istRevolver
            ? [rev.revX as number, rev.revY as number]
            : (frozen?.get(n.id) ?? seedXY(n.id));
          const isHub = hubIds.has(n.id);
          const isOpen = n.id === openAsvId;
          const isSelAsv = sel?.kind === "asv" && n.id === sel.id;
          const marked = sel != null && sel.kind !== "asv" && selMarked.has(n.id);
          const dimmed = (sel != null && !isSelAsv && !marked && !isOpen)
            || (scheibe != null && !imRevolver(n) && !isOpen && !isSelAsv);
          const tp = taxaById.get(n.id);
          return {
            id: n.id, name: n.id, value: n.genus ?? "", genus: n.genus ?? "", hub: isHub,
            ...(tp ? { taxon: { label: tp.label, n: tp.members.length,
                                nModules: new Set(tp.members.map((m) => m.cluster)).size } } : {}),
            share: totalSize > 0 ? (n.size || 0) / totalSize : null, nPool: net?.nodes.length ?? 0,
            x: xy[0], y: xy[1],
            ...(istRevolver ? { fixed: true } : {}),
            symbolSize: scale(n.size ?? 0),
            ...((isSelAsv && sel?.label) || istRevolver ? { label: { show: true } } : {}),
            itemStyle: {
              color: colorOfNode(n),
              opacity: dimmed ? DIM_NODE : 1,
              borderWidth: RING_W,
              shadowBlur: RING_GLOW,
              borderColor: isOpen ? "#22d3ee"
                : isSelAsv ? selRing
                : marked ? (markColor ?? "#e879f9")
                : isHub ? "#fde68a"
                : nodeOutline,
              ...(marked && !isOpen && !isSelAsv ? { borderType: "dashed" as const } : {}),
              shadowColor: dimmed ? "transparent"
                : isOpen ? "#22d3ee"
                : isSelAsv ? selRing
                : isHub ? "#fbbf24"
                : "transparent",
            },
          };
        });
        return scheibe ? [...pts.slice(0, nUnterScheibe), scheibe, ...pts.slice(nUnterScheibe)] : pts;
        })()],
        links: [...ring.links, ...drawEdges.flatMap((e) => {
          const base = isCross(e)
            ? { color: "#f59e0b", opacity: 0.9 }
            : { color: "#5b6b8c", opacity: hasCcm(e) ? 0.75 : 0.4 };
          const incident = sel?.kind === "asv" && (e.source === sel.id || e.target === sel.id);
          const tl = (e as unknown as { tax?: { n_links: number; n_directed: number } }).tax;
          const L = filters.layers;
          const anMitte = revolver != null && (e.source === revolver.id || e.target === revolver.id);
          const opacity = scheibe != null ? (anMitte ? base.opacity : DIM_EDGE)
            : sel == null || incident ? base.opacity : DIM_EDGE;
          const common = {
            source: e.source, target: e.target, value: e.corr, manta: tl ? undefined : e,
            ...(tl ? { tax: tl } : {}),
          };
          const out: Record<string, unknown>[] = [];
          const gerade = tl != null || L.con || (L.ccm && hasCcm(e));
          if (gerade) out.push({
            ...common,
            symbol: L.ccm
              ? [e.ccm_backward ? "arrow" : "none", e.ccm_forward ? "arrow" : "none"]
              : ["none", "none"],
            lineStyle: { ...base, opacity,
                         width: tl ? Math.min(EDGE_W_MAX, EDGE_W_MIN + (tl.n_links - 1) * 0.8)
                                   : edgeWidth(e) },
          });
          if (!tl && L.rejected && hasRejected(e)) out.push({
            ...common,
            symbol: [e.rejected_backward ? "arrow" : "none", e.rejected_forward ? "arrow" : "none"],
            lineStyle: { ...base, opacity, type: "dashed" as const,
                         curveness: gerade ? 0.25 : 0,
                         width: gerade ? EDGE_W_MIN : edgeWidth(e) },
          });
          return out;
        })],
        edgeSymbolSize: 9,
        label: {
          show: showLabels,
          position: "right" as const,
          formatter: (p: { data: { genus?: string; id: string } }) => p.data.genus || p.data.id,
          color: labelColor,
          fontSize: 10,
          textBorderColor: labelBorder,
          textBorderWidth: 3,
        },
        emphasis: { focus: "adjacency" },
      },
    ],
    graphic: [
      ...(sel?.kind === "taxon" ? [{
        type: "text" as const, left: 12, top: 10, silent: true,
        style: {
          text: `${sel.value} (${sel.rank}) marked — ${selMarked.size} ASVs; `
            + "nodes stay individual, no link is touched",
          fill: markTextFill, font: "11px sans-serif",
        },
      }] : []),
      ...(sel?.kind === "cluster" ? [{
        type: "text" as const, left: 12, top: 10, silent: true,
        style: {
          text: `Module ${sel.label} marked — ${selMarked.size} ASVs; other nodes dimmed`,
          fill: markTextFill, font: "11px sans-serif",
        },
      }] : []),
      ...(sel?.kind === "asv" ? [{
        type: "text" as const, left: 12, top: 10, silent: true,
        style: {
          text: `${sel.id} highlighted — other nodes dimmed, its links kept`,
          fill: selRing, font: "11px sans-serif",
        },
      }] : []),
    ],
  }), [drawNodes, drawEdges, taxaMode, offenerTaxon, maxSize, totalSize, net, nodeCluster, showLabels, frozen,
       hub, hubIds, seedXY, sel, selMarked, markColor, edgeWidth, openAsvId, focusXY, dense, ring,
       scale, edgeStrength, ewMin, ewMax, filters.layers, light, nodeOutline, selRing,
       labelColor, labelBorder, markTextFill, modules, colorMode, functionColor,
       linkLen, revolver, scheibe, zeichenfolge, nUnterScheibe, imRevolver]);

  const thr = net?.thresholds;

  const sizePresent = visibleNodes.some((n) => n.size != null);
  const widthText = (ewMin != null && ewMax != null && net?.edge_width_legend)
    ? (widthKind === "rejected" ? net.edge_width_legend.rejected
       : widthKind === "ccm" ? net.edge_width_legend.ccm : net.edge_width_legend.con)
        .replace("{min}", ewMin.toFixed(3)).replace("{max}", ewMax.toFixed(3))
    : null;
  const legend = useMemo(() => legendRows({
    nModules: net?.partition?.n_clusters ?? clusters.length,
    colorMode, nFunctionClasses: functionClasses.length,
    sizePresent,
    conTr: thr?.con_tr ?? null, conAlpha: thr?.con_alpha ?? null,
    ccmnTr: thr?.ccmn_tr ?? null, recorded: thr?.recorded ?? false,
    ccmVisible: filters.layers.ccm && ccmCount > 0,
    rejectedVisible: filters.layers.rejected && rejectedCount > 0,
    widthText,
    hubMeasureLabel: hub?.measure_label ?? null, hubK: hub?.k ?? null,
    highlightActive: sel != null,
  }), [net, clusters.length, sizePresent, thr, ccmCount, rejectedCount, filters.layers,
       widthText, hub, sel, colorMode, functionClasses.length]);

  const filterLineText = useCallback((): string => {
    if (!net || order.length === 0) return "Filters: none";
    const txt = order.map((k): string => {
      switch (k) {
        case "modules": {
          const vs = clusters.filter((c) => !filters.hidden.has(c));
          return "modules " + (vs.length <= 6 ? vs.join(",") : `${vs.length} of ${clusters.length}`);
        }
        case "layer": return layerLabel(filters.layers);
        case "cross": return "crossing only";
        case "hubs": return "hubs only";
        case "function": return `function ${functionLabel(filters.fn ?? "")}`;
        case "taxon": return filters.taxon ? `${filters.taxon.value} (${filters.taxon.rank})` : "taxon";
        case "asvs": return `${(filters.asvs?.ids.length ?? 0) - unknownAsvIds.length} selected ASVs`
          + (filters.asvs?.neighbors ? " + neighbours" : "");
        case "size": return filters.size
          ? `${filters.size.dir === "top" ? "largest" : "smallest"} ${filters.size.pct} % by read count`
          : "size";
        case "strength": return filters.strength
          ? `${filters.strength.dir === "top" ? "strongest" : "weakest"} ${filters.strength.pct} % of links (|r|)`
          : "strength";
      }
    }).join(" · ");
    return `Filters: ${txt} — ${visibleNodes.length} of ${net.nodes.length} ASVs shown`;
  }, [net, order, filters, clusters, unknownAsvIds, visibleNodes.length]);

  const exportPng = useCallback(() => {
    const inst = chartRef.current?.getEchartsInstance();
    if (!inst || !net) return;
    const url = (inst as any).getDataURL({ pixelRatio: 2,
      backgroundColor: light ? "#ffffff" : "#0f172a" });
    const img = new Image();
    img.onload = () => {
      const lines = [
        filterLineText(),
        "Legend:",
        ...legend.filter((r) => !r.dim).map((r) => `  ${r.icon}  ${r.term} — ${r.desc}`),
        `  Thresholds: ${thresholdLine({
          conTr: thr?.con_tr ?? null, conAlpha: thr?.con_alpha ?? null,
          ccmnTr: thr?.ccmn_tr ?? null, recorded: thr?.recorded ?? false })}`,
        ...(widthText ? [`  ${widthText}`] : []),
        `${visibleNodes.length} ASVs · ${visibleEdges.length} edges · ${ccmCount} with CCM · `
          + (net.layers?.ccm_tested_recorded ? `${rejectedCount} with a rejected direction · ` : "")
          + `${crossCount} crossing modules${hub ? ` · ${hub.n_marked} hubs` : ""}`,
      ];
      const pad = 24, lineH = 30;
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height + pad * 2 + lines.length * lineH;
      const g = c.getContext("2d");
      if (!g) return;
      g.fillStyle = light ? "#ffffff" : "#0f172a"; g.fillRect(0, 0, c.width, c.height);
      g.drawImage(img, 0, 0);
      g.fillStyle = light ? "#1e293b" : "#cbd5e1"; g.font = "22px sans-serif";
      lines.forEach((l, i) => g.fillText(l, pad, img.height + pad + (i + 0.8) * lineH));
      const a = document.createElement("a");
      a.href = c.toDataURL("image/png");
      a.download = `${dataset.dataset_id}_network.png`;
      a.click();
    };
    img.src = url;
  }, [net, legend, filterLineText, visibleNodes.length, visibleEdges.length, ccmCount,
      rejectedCount, crossCount, hub, dataset.dataset_id, light, thr, widthText]);

  const resetZoom = useCallback(() => {
    setSel(null);
    roam.current = null;
    const inst = chartRef.current?.getEchartsInstance();
    try { (inst as any)?.setOption(option, true); } catch { }
  }, [option]);

  const letzterTaxaMode = useRef(taxaMode);
  const resetRef = useRef(resetZoom);
  resetRef.current = resetZoom;
  useEffect(() => {
    if (letzterTaxaMode.current === taxaMode) return;
    letzterTaxaMode.current = taxaMode;
    resetRef.current();
  }, [taxaMode]);

  useEffect(() => {
    const inst = chartRef.current?.getEchartsInstance();
    const zr = (inst as any)?.getZr?.();
    if (!zr) return;
    const h = (e: { target?: unknown }) => {
      if (!e.target) { onShowNet(); resetZoom(); }
    };
    const einfach = (e: { target?: unknown }) => { if (!e.target) setRevolver(null); };
    zr.on("dblclick", h);
    zr.on("click", einfach);
    return () => {
      try { zr.off("dblclick", h); zr.off("click", einfach); } catch { }
    };
  }, [net, onShowNet, resetZoom]);

  const capOf = (key: string) => caps?.items.find((i) => i.key === key);
  const envCap = capOf("environment");
  const timeCap = capOf("time_axis");
  const umschalten = (art: string, offen: boolean, oeffnen: () => void) => () =>
    (offen ? onCloseView(art) : oeffnen());
  const viewItems: ViewItem[] = [
    { key: "environment", testid: "environment-toggle", label: "Env", icon: "≈",
      open: environmentOpen, onOpen: umschalten("environment", environmentOpen, onOpenEnvironment),
      disabledReason: envCap && !envCap.available ? envCap.detail : null },
    { key: "wheel", testid: "wheel-toggle", label: "Wheel", icon: "◔",
      open: wheelOpen, onOpen: umschalten("wheel", wheelOpen, onOpenWheel),
      disabledReason: timeCap && !timeCap.available ? timeCap.detail : null },
    { key: "ela", testid: "ela-toggle", label: "ELA", icon: "⛰",
      open: elaOpen, onOpen: umschalten("ela", elaOpen, onOpenEla), disabledReason: null },
    { key: "compare", testid: "compare-toggle", label: "Compare", icon: "⇄",
      open: compareOpen, onOpen: umschalten("compare", compareOpen, onOpenCompare),
      disabledReason: timeCap && !timeCap.available ? timeCap.detail : null },
    { key: "legend", testid: "legend-view-toggle", label: "Legend", icon: "ⓘ",
      open: legendeOffen, onOpen: () => setLegendeOffen((v) => !v), disabledReason: null },
    { key: "starred", testid: "starred-toggle", label: "Star", icon: "★",
      open: starredOpen, onOpen: umschalten("starred", starredOpen, onOpenStarred), disabledReason: null },
  ];
  const anyViewOpen = environmentOpen || wheelOpen || elaOpen || compareOpen || starredOpen
    || legendeOffen;

  const selNode = sel?.kind === "asv" ? net?.nodes.find((n) => n.id === sel.id) ?? null : null;

  return (
    <div className="h-full flex relative">
      <NetworkSidebar
        dataset={dataset} caps={caps} net={net} hub={hub} thr={thr}
        visibleNodes={visibleNodes}
        clusters={clusters} clusterColor={clusterColor} countByCluster={countByCluster}
        filters={filters} onFilters={patchFilters}
        onClearKind={(k) => setFilters((f) => clearKind(f, k))}
        onClearAll={() => setFilters(emptyFilters())}
        order={order} chipCounts={chipCounts} unknownAsvIds={unknownAsvIds}
        counts={taxaMode
          ? { nodes: taxa.length, edges: taxaLinks.length,
              cross: taxaLinks.filter((l) => {
                const a = taxaById.get(l.source)?.cluster;
                const b = taxaById.get(l.target)?.cluster;
                return a == null || b == null || a !== b;
              }).length,
              ccm: taxaLinks.filter((l) => l.n_directed > 0).length }
          : { nodes: visibleNodes.length, edges: visibleEdges.length,
              cross: crossCount, ccm: ccmCount, rejected: rejectedCount }}
        taxaMode={taxaMode} onTaxaMode={setTaxaMode} taxaLayers={taxaLayers}
        linkLength={linkLen} linkLengthDefault={LINK_LENGTH_DEFAULT}
        onLinkLength={(v) => { roam.current = null; setLinkLen(v); }}
        colorMode={colorMode} onColorMode={setColorMode} functionClasses={functionClasses}
        legend={legend} sizeAbsent={!sizePresent} widthText={widthText}
        thresholds={thresholdLine({
          conTr: thr?.con_tr ?? null, conAlpha: thr?.con_alpha ?? null,
          ccmnTr: thr?.ccmn_tr ?? null, recorded: thr?.recorded ?? false })}
        views={{ anyViewOpen: anyViewOpen || selectedCluster != null || openAsvId != null,
                 onShowNet: () => { onShowNet(); setSelectedCluster(null); setLegendeOffen(false); },
                 items: viewItems }}
        onPickAsv={(id) => setSel({ kind: "asv", id, focus: Date.now(), label: true })}
        onPickTaxon={(rank, value) => setSel({ kind: "taxon", rank, value })}
        onPickCluster={(label) => setSel({ kind: "cluster", label })}
        onOpenClusterPanel={(label) => setSelectedCluster(label)}
      />

      <div className="flex-1 relative" data-testid="network-canvas" data-layout-hash={layoutHash}
        data-color-mode={colorMode}
        data-link-length={linkLen}
        data-tax-key={taxKey ?? ""}
        data-tax-marked={sel?.kind === "taxon" ? selMarked.size : 0}
        data-highlight={sel?.kind === "asv" ? sel.id : ""}
        data-open-asv={openAsvId ?? ""}
        data-ew-min={ewMin?.toFixed(4) ?? ""} data-ew-max={ewMax?.toFixed(4) ?? ""}
        data-min-gap={minGap?.toFixed(1) ?? ""}>
        {err && <div className="p-4 text-red-300" data-testid="error">{err}</div>}

        {offenerTaxon && (
          <div data-testid="revolver-bar"
            className="absolute top-2 left-3 z-10 flex items-center gap-2
                       rounded border border-slate-600 bg-slate-900/90 px-2.5 py-1 text-xs
                       shadow-lg">
            <span className="text-slate-200">{offenerTaxon.label}</span>
            <span className="text-slate-500 tabular-nums">
              {offenerTaxon.members.length} ASVs
            </span>
            <button data-testid="revolver-summary"
              onClick={() => onOpenTaxon(offenerTaxon.members[0].id)}
              className="underline text-cyan-300 hover:text-white">summary</button>
            <button data-testid="revolver-close" onClick={() => setRevolver(null)}
              aria-label="close" className="text-slate-400 hover:text-white">✕</button>
          </div>
        )}

        {sel && !(sel.kind === "asv" && sel.id === openAsvId && !selHiddenBy) && (
          <div data-testid="highlight-bar"
            className={`absolute ${offenerTaxon ? "top-10" : "top-2"} left-3 z-10 flex
                       items-center gap-2 rounded border border-slate-600 bg-slate-900/90
                       px-2.5 py-1 text-xs shadow-lg max-w-[70%]`}>
            {sel.kind === "asv" && (
              <>
                <span className="font-mono text-slate-100">{sel.id}</span>
                {selNode?.genus && <span className="italic text-slate-300">{selNode.genus}</span>}
                {selNode && <span className="text-slate-400">{modules.label(selNode.cluster)}</span>}
                {selHiddenBy ? (
                  <>
                    <span data-testid="highlight-hidden-note" className="text-amber-400">
                      not visible — hidden by the filter &ldquo;{selHiddenBy.label}&rdquo;
                    </span>
                    <button data-testid="highlight-unfilter"
                      onClick={() => setFilters((f) => clearKind(f, selHiddenBy.kind))}
                      className="underline text-cyan-300 hover:text-white whitespace-nowrap">
                      remove that filter
                    </button>
                  </>
                ) : (
                  <button data-testid="highlight-open-details" onClick={() => onOpenAsv(sel.id)}
                    className="underline text-cyan-300 hover:text-white whitespace-nowrap">
                    open details
                  </button>
                )}
              </>
            )}
            {sel.kind === "taxon" && (
              <span data-testid="tax-marked-note" className="text-amber-300">
                ◌ {selMarked.size} ASV{selMarked.size === 1 ? "" : "s"} of{" "}
                {sel.value} ({sel.rank}) marked
              </span>
            )}
            {sel.kind === "cluster" && (
              <span className="text-amber-300">
                ◌ {modules.label(sel.label)} · {selMarked.size} ASV{selMarked.size === 1 ? "" : "s"} marked
              </span>
            )}
            {sel.kind === "taxon" ? (
              <button data-testid="tax-clear" onClick={() => setSel(null)}
                className="underline text-amber-200 hover:text-white">clear</button>
            ) : (
              <button data-testid="highlight-clear" onClick={() => setSel(null)}
                aria-label="clear highlight"
                className="text-slate-400 hover:text-white">✕</button>
            )}
          </div>
        )}

        <div className="absolute top-2 right-2 z-10 flex gap-1">
          <button data-testid="canvas-zoom-reset" onClick={resetZoom}
            title="reset zoom and centering"
            className="text-xs px-2 py-1 rounded border border-slate-600 bg-slate-900/70 text-slate-300 hover:border-slate-400">⛶ fit</button>
          <button data-testid="canvas-export" onClick={exportPng}
            title="export image (carries legend and active filters)"
            className="text-xs px-2 py-1 rounded border border-slate-600 bg-slate-900/70 text-slate-300 hover:border-slate-400">⇩ PNG</button>
          <button data-testid="canvas-reload" title="reload network"
            onClick={() => { setFrozen(null); setReloadKey((k) => k + 1); }}
            className="text-xs px-2 py-1 rounded border border-slate-600 bg-slate-900/70 text-slate-300 hover:border-slate-400">⟳ reload</button>
        </div>
        {settingsOpen && (
            <div data-testid="settings-panel"
              className="fixed right-2 top-11 z-50 w-80 rounded border border-slate-600 bg-slate-900/95 px-2 py-1.5 shadow-xl space-y-2">
              <ThemeSwitch theme={theme} onTheme={onTheme} />
              <div className="flex items-center gap-1 text-xs" data-testid="label-switch">
                <span className="text-slate-500">Names</span>
                {([["auto", "auto"], ["on", "on"], ["off", "off"]] as ["auto" | "on" | "off", string][]).map(([v, l]) => (
                  <button key={v} data-testid={`labels-${v}`} onClick={() => setLabelMode(v)}
                    className={`px-2 py-0.5 rounded border ${labelMode === v
                      ? "border-cyan-400 text-cyan-300" : "border-slate-700 text-slate-400 hover:border-slate-500"}`}>
                    {l}
                  </button>
                ))}

              </div>

              {hub && (
                <div className="pt-1 border-t border-slate-700">
                  <div className="text-[10px] uppercase tracking-wide text-slate-500" data-testid="hub-title">
                    {hub.title}
                  </div>
                  <select data-testid="hub-measure" value={hubSel?.measure ?? hub.measure}
                    onChange={(e) => setHubSel({ measure: e.target.value, k: hubSel?.k ?? hub.k })}
                    className="mt-1 w-full px-1 py-0.5 rounded bg-slate-800 border border-slate-600 text-xs text-slate-100">
                    {hub.controls.measures.map((m) => (
                      <option key={m.key} value={m.key}>{m.label}</option>
                    ))}
                  </select>
                  <label className="mt-1 flex items-center gap-2 text-xs text-slate-300">
                    <span className="whitespace-nowrap">μ + k·σ, k =</span>
                    <input data-testid="hub-k" type="range" min={hub.controls.k_min}
                      max={hub.controls.k_max} step={hub.controls.k_step}
                      value={hubSel?.k ?? hub.k}
                      onChange={(e) => setHubSel({ measure: hubSel?.measure ?? hub.measure,
                                                   k: Number(e.target.value) })}
                      className="flex-1" />
                    <span className="tabular-nums w-7 text-right" data-testid="hub-k-value">
                      {(hubSel?.k ?? hub.k).toFixed(1)}
                    </span>
                  </label>
                  <p className="mt-1 text-[10px] text-slate-500 leading-snug" data-testid="hub-info">
                    <span data-testid="hub-statement">{hub.statement}</span>
                  </p>
                  {hub.measure.includes("betweenness") && hub.zero_caveat && (
                    <p className="mt-1 text-[10px] text-amber-400 leading-snug" data-testid="hub-zero-caveat">
                      {hub.zero_caveat}
                    </p>
                  )}
                </div>
              )}

              {thr && (
                <div className="pt-1 border-t border-slate-700" data-testid="threshold-summary">
                  <div className="text-[10px] uppercase tracking-wide text-slate-500 flex items-center">
                    Threshold

                  </div>
                  <div className="text-xs text-slate-300 tabular-nums">
                    <div>CON: Pearson ≥ {thr.con_tr} · p &lt; {thr.con_alpha}</div>
                    <div className="text-slate-400">
                      CCM: NMI ≥ {thr.ccmn_tr} · {thr.num_permutations} permutations
                    </div>
                  </div>
                  {!thr.recorded && (
                    <div className="text-[10px] text-amber-400" data-testid="threshold-defaults-note">
                      defaults — not recorded for this dataset
                    </div>
                  )}
                  <button data-testid="threshold-open" onClick={() => setShowThresholds(true)}
                    className="mt-1 text-xs text-cyan-300 hover:underline">
                    adjust and recompute …
                  </button>
                </div>
              )}
            </div>
        )}
        {net ? (
          <ReactECharts ref={chartRef} option={option} style={{ height: "100%", width: "100%" }}
            notMerge lazyUpdate
            onEvents={{
              finished: freeze,
              graphroam: () => {
                const inst = chartRef.current?.getEchartsInstance();
                const serie = (inst as any)?.getOption()?.series?.[0];
                if (serie && Number.isFinite(serie.zoom) && Array.isArray(serie.center)) {
                  const zoomVorher = roam.current?.zoom ?? 1;
                  roam.current = { zoom: serie.zoom, center: serie.center as [number, number] };
                  if (revolver && Math.abs(serie.zoom - zoomVorher) > 1e-6) setZoomTick((t) => t + 1);
                }
              },
              click: (p: any) => {
                if (istRing(p)) return;
                if (p.dataType === "node" && taxaMode) {
                  const id: string = p.data.id;
                  if (offenerTaxon && id === offenerTaxon.id) {
                    onOpenTaxon(offenerTaxon.members[0].id);
                    return;
                  }
                  const t = taxaById.get(id);
                  if (t && t.members.length > 1) {
                    const xy = frozen?.get(id) ?? seedXY(id);
                    let r = revolverRadiusPx(t.members.length);
                    try {
                      const inst = chartRef.current?.getEchartsInstance();
                      const a = (inst as any)?.convertToPixel({ seriesIndex: 0 }, [xy[0], xy[1]]);
                      const b = (inst as any)?.convertToPixel({ seriesIndex: 0 }, [xy[0] + 1, xy[1]]);
                      const k = a && b ? Math.abs(b[0] - a[0]) : 0;
                      if (Number.isFinite(k) && k > 0) r = r / k;
                    } catch { }
                    setRevolver({ id, x: xy[0], y: xy[1], r, tick: Date.now() });
                    return;
                  }
                  if (t) {
                    p = { ...p, data: { ...p.data, id: t.members[0].id } };
                  }
                }
                if (p.dataType === "node") {
                  if (focusTimer.current) {
                    clearTimeout(focusTimer.current); focusTimer.current = null;
                  }
                  setSel({ kind: "asv", id: p.data.id, focus: Date.now() });
                  onOpenAsv(p.data.id);
                } else if (p.dataType === "edge" && p.data?.manta) {
                  onOpenEdge({ source: p.data.manta.source, target: p.data.manta.target, type: "con" });
                }
              },
            }} />
        ) : (
          !err && <div className="h-full grid place-items-center text-slate-500">loading network …</div>
        )}
      </div>

      {legendeOffen && (
        <PanelFrame id="legend" defaultWidth={440}>
          <LegendPanel datasetId={dataset.dataset_id} thr={thr} hub={hub}
            labelMax={LABEL_AUTO_MAX} functionClasses={functionClasses} colorMode={colorMode}
            onClose={() => setLegendeOffen(false)} />
        </PanelFrame>
      )}

      {selectedCluster != null && (
        <PanelFrame id="cluster" defaultWidth={460}>
        <ClusterPanel datasetId={dataset.dataset_id} label={selectedCluster} isAdmin={isAdmin}
          color={clusterColor.get(selectedCluster)} onClose={() => setSelectedCluster(null)}
          onOpenAsv={onOpenAsv} onOpenEdge={onOpenEdge}
          colorOf={(c) => clusterColor.get(c)}
          onOpenCluster={(c) => setSelectedCluster(c)} />
        </PanelFrame>
      )}

      {showThresholds && thr && (
        <ThresholdDialog datasetId={dataset.dataset_id} current={thr} nAsv={dataset.n_asv}
          onClose={() => setShowThresholds(false)}
          onDone={() => { setFrozen(null); setReloadKey((k) => k + 1); onRefresh?.(); }} />
      )}
    </div>
  );
}

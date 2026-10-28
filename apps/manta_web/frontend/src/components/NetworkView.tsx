import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import OwnModelSettings from "./OwnModelSettings";
import { createPortal } from "react-dom";
import ReactECharts from "echarts-for-react";
import { getOccurrence, getCapabilities, getCriterion2, getNetwork,
         type Capabilities, type Criterion2Summary, type Dataset, type NetEdge, type NetNode, type Network } from "../api";
import type { EdgeRef } from "../App";
import type { InspectMark } from "./ComparePanel";
import ClusterPanel from "./ClusterPanel";
import PanelFrame from "./PanelFrame";
import LegendPanel from "./LegendPanel";
import FilterWindow, { WINDOW_TITLE, type WindowKind } from "./FilterWindow";
import NetworkSidebar, { type ViewItem } from "./NetworkSidebar";
import type { ExtraView } from "../extraViews";
import ThemeSwitch, { type Theme } from "./ThemeSwitch";
import { useModules } from "../modules";
import { NETWORK, usePublishView } from "../viewContext";
import { NO_MODULE_COLOUR } from "../clusterPalette";
import { chartTooltip, FONT, useTokens } from "../design/tokens";
import { glowRing, markerRings } from "../design/dataColours";
import { Z } from "../design/layers";
import { Button, TextButton, StateNotice, SectionHeading } from "./ui";
import { Segmented } from "./controls";

import TaxonWheel from "./TaxonWheel";
import { memberPoint, taxonLinks, taxonPoints, type TaxonLink, type TaxonRank } from "../taxonView";
import ThresholdDialog from "./ThresholdDialog";
import ErrorNotice from "./ErrorNotice";
import { esc, fmtP } from "../format";
import { chainedCounts, clearKind, computeVisible, decodeFilters, emptyFilters, encodeFilters,
         exploreAdd, hiddenBy, startNone, isActive, legendRows, thresholdLine, FILTER_KINDS,
         type Filters, type FilterKind, type KeystoneParams, KEYSTONE_DEFAULTS, KEYSTONE_LABEL, loadKeystone, saveKeystone, layerLabel,
         occurrenceLabel, rangeLabel, type OccPoint } from "../networkFilters";

const COLLIDE_MARGIN = 1.5;
const COLLIDE_ITERATIONS = 80;
const DIM_NODE = 0.2;
const LINK_LENGTH_DEFAULT = 52;
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
                                      onOpenStarred, starredOpen, clusterVonAussen, vonInspect,
                                      onOpenWheel, wheelOpen,
                                      extraViews,
                                      onOpenCompare, compareOpen, onInspectAt,
                                      openAsvId, isAdmin, signedIn = true, onOpenTaxon, onCloseView,
                                      onShowNet,
                                      settingsOpen, onCloseSettings, theme, onTheme,
                                      onRefresh, onOpenDataset }: {
  dataset: Dataset;
  onOpenAsv: (id: string) => void;
  openAsvId: string | null;
  isAdmin: boolean;
  signedIn?: boolean;
  onOpenTaxon: (asvId: string) => void;
  onCloseView: (kind: string) => void;
  onShowNet: () => void;
  settingsOpen: boolean;
  onCloseSettings?: () => void;
  theme: Theme;
  onTheme: (t: Theme) => void;
  onOpenEdge: (e: EdgeRef) => void;
  onOpenStarred: () => void;
  starredOpen: boolean;
  clusterVonAussen: { label: number; tick: number; ds?: string } | null;
  vonInspect?: { modules: number[]; asvs: string[]; tick: number; ds: string } | null;
  onOpenWheel: () => void;
  wheelOpen: boolean;
  extraViews: { view: ExtraView; kind: string; open: boolean; onOpen: () => void }[];
  onOpenCompare: () => void;
  compareOpen: boolean;
  onInspectAt: (sample: string, mark?: InspectMark) => void;
  onRefresh?: () => void;
  onOpenDataset?: (datasetId: string) => void;
}) {
  const modules = useModules();
  const [net, setNet] = useState<Network | null>(null);
  const nSamples = net?.n_samples ?? dataset.n_sample;
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [selectedCluster, setSelectedCluster] = useState<number | null>(null);
  useEffect(() => {
    if (clusterVonAussen == null) return;
    if (clusterVonAussen.ds != null && clusterVonAussen.ds !== dataset.dataset_id) return;
    setSelectedCluster(clusterVonAussen.label);
  }, [clusterVonAussen]);
  const [labelMode, setLabelMode] = useState<"auto" | "on" | "off">("auto");
  const [frozen, setFrozen] = useState<Map<string, [number, number]> | null>(null);
  const chartRef = useRef<ReactECharts>(null);
  const [showThresholds, setShowThresholds] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const light = theme === "light";
  const tok = useTokens();

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
  const letzterKlick = useRef<{ id: string; t: number } | null>(null);
  const roam = useRef<{ zoom: number; center: [number, number] } | null>(null);
  useEffect(() => () => { if (focusTimer.current) clearTimeout(focusTimer.current); }, []);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      setRevolver((r) => { if (r) return null; setSel(null); return r; });
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  useEffect(() => {
    setNet(null); setErr(null);
    getNetwork(dataset.dataset_id, "con", dataset.marker).then(setNet).catch((e) => setErr(e));
    setCaps(null);
    getCapabilities(dataset.dataset_id).then(setCaps).catch(() => setCaps(null));
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

  const [kp, setKp] = useState<KeystoneParams>(() => loadKeystone(dataset.dataset_id));
  const [kpDs, setKpDs] = useState(dataset.dataset_id);
  if (kpDs !== dataset.dataset_id) { setKpDs(dataset.dataset_id); setKp(loadKeystone(dataset.dataset_id)); }
  const patchKp = useCallback((patch: Partial<KeystoneParams>) => setKp((prev) => {
    const next = { ...prev, ...patch };
    saveKeystone(dataset.dataset_id, next);
    return next;
  }), [dataset.dataset_id]);
  const crit = kp.crit;
  const c2Default = kp.q2 === KEYSTONE_DEFAULTS.q2;
  const [c2Custom, setC2Custom] = useState<Criterion2Summary | null>(null);
  useEffect(() => {
    setC2Custom(null);
    if (c2Default || !net?.criterion2) return;
    let aktiv = true;
    getCriterion2(dataset.dataset_id, kp.q2).then((r) => { if (aktiv) setC2Custom(r); })
      .catch(() => { });
    return () => { aktiv = false; };
  }, [dataset.dataset_id, net, kp.q2, c2Default]);
  const c2: Criterion2Summary | null = (c2Default ? net?.criterion2 : c2Custom) ?? null;
  const c1Ids = useMemo(() => {
    const links = new Map<string, number>();
    net?.edges.forEach((e) => {
      if ((e.p_forward ?? 1) < kp.p1 || (e.p_backward ?? 1) < kp.p1) {
        links.set(e.source, (links.get(e.source) ?? 0) + 1);
        links.set(e.target, (links.get(e.target) ?? 0) + 1);
      }
    });
    return new Set([...links].filter(([, n]) => n >= kp.links1).map(([id]) => id));
  }, [net, kp.p1, kp.links1]);
  const keyIds = useMemo(() => (crit === 1 ? c1Ids : new Set(c2?.ids ?? [])), [c1Ids, c2, crit]);
  const keyLabel = KEYSTONE_LABEL[crit];

  const [filterWin, setFilterWin] = useState<WindowKind | null>(null);
  const [dates, setDates] = useState<string[]>([]);
  const [occ, setOcc] = useState<Map<string, OccPoint[]> | null>(null);
  const [occErr, setOccErr] = useState<unknown>(null);
  useEffect(() => { setOcc(null); setDates([]); setOccErr(null); }, [net]);
  const occWanted = !!net && (filterWin === "occurrence" || filters.occurrence != null);
  useEffect(() => {
    if (!occWanted || occ || occErr) return;
    let aktiv = true;
    getOccurrence(dataset.dataset_id).then((o) => {
      if (!aktiv) return;
      const ds = o.dates.map((d) => d ?? "");
      setDates(ds.filter(Boolean));
      setOcc(new Map(Object.entries(o.asvs).map(([id, pts]) =>
        [id, pts.filter(([i]) => ds[i]).map(([i, share]) => ({ date: ds[i], share }))])));
    }).catch((e) => { if (aktiv) setOccErr(e); });
    return () => { aktiv = false; };
  }, [occWanted, occ, occErr, dataset.dataset_id]);
  const occLoading = filters.occurrence != null && occ == null;

  const vis = useMemo(
    () => (net ? computeVisible(net, filters, keyIds, occ) : null),
    [net, filters, keyIds, occ]);
  // Explore: each click on a point adds it and its partners to the shown ASVs.
  const [exploreOn, setExploreOn] = useState(false);
  // Without an ASV selection a click would collapse the whole network; explore ends there.
  useEffect(() => { if (filters.asvs == null) setExploreOn(false); }, [filters.asvs]);

  // Undo: every change of the filters is one step back; kept per dataset across a reload.
  const undoKey = `manta-undo:${dataset.dataset_id}`;
  const verlauf = useRef<string[]>((() => {
    try { return JSON.parse(sessionStorage.getItem(undoKey) ?? "[]") as string[]; } catch { return []; }
  })());
  const vorher = useRef(encodeFilters(filters));
  const rueckgaengig = useRef(false);
  const [nUndo, setNUndo] = useState(verlauf.current.length);
  useEffect(() => {
    const jetzt = encodeFilters(filters);
    if (jetzt === vorher.current) return;
    if (rueckgaengig.current) rueckgaengig.current = false;
    else verlauf.current.push(vorher.current);
    vorher.current = jetzt;
    try { sessionStorage.setItem(undoKey, JSON.stringify(verlauf.current.slice(-100))); } catch { }
    setNUndo(verlauf.current.length);
  }, [filters, undoKey]);
  const undo = () => {
    const s = verlauf.current.pop();
    if (s == null) return;
    rueckgaengig.current = true;
    setFilters(decodeFilters(s));
  };
  const visibleNodes = vis?.nodes ?? [];
  const visibleEdges = vis?.edges ?? [];

  // Inspect -> network, applied once per click in Inspect (not again on reload or in another
  // dataset). Modules become the module filter; ASVs alone become the shown ASVs. Single ASVs
  // stay highlighted as long as the filters stay exactly as set here.
  const [heraus, setHeraus] = useState<{ asvs: Set<string>; key: string } | null>(null);
  const inspectTick = useRef<number | null>(null);
  useEffect(() => {
    if (!vonInspect || !net || vonInspect.ds !== dataset.dataset_id) return;
    if (inspectTick.current === vonInspect.tick) return;
    inspectTick.current = vonInspect.tick;
    if (!vonInspect.modules.length) {
      setHeraus(null);
      setFilters((f) => ({ ...f, hidden: new Set(), asvs: { ids: [...vonInspect.asvs], neighbors: false } }));
      return;
    }
    const alle = [...new Set(net.nodes.map((n) => n.cluster))];
    const neu: Filters = { ...filters, asvs: null,
      hidden: new Set(alle.filter((c) => !vonInspect.modules.includes(c))) };
    setFilters(neu);
    setHeraus(vonInspect.asvs.length ? { asvs: new Set(vonInspect.asvs), key: encodeFilters(neu) } : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vonInspect?.tick, net]);
  const herausAktiv = heraus != null && heraus.key === encodeFilters(filters) ? heraus.asvs : null;
  const visibleIds = useMemo(() => new Set(visibleNodes.map((n) => n.id)), [visibleNodes]);

  const [points, setPoints] = useState<"asvs" | "taxa">("asvs");
  const [taxonRank, setTaxonRank] = useState<TaxonRank>("genus");
  usePublishView(NETWORK, { view: "network", points, rank: taxonRank,
    selected: sel?.kind === "asv" ? { kind: "asv", id: sel.id, label: sel.id }
      : sel?.kind === "cluster" ? { kind: "cluster", n: sel.label, label: modules.label(sel.label) }
      : null,
    taxon: sel?.kind === "taxon" ? { rank: sel.rank, name: sel.value } : null });
  const taxaMode = points === "taxa";
  const [legendeOffen, setLegendeOffen] = useState(false);
  const [revolver, setRevolver] =
    useState<{ id: string; x: number; y: number } | null>(null);
  const [linkLen, setLinkLen] = useState(LINK_LENGTH_DEFAULT);
  usePublishView("cluster", selectedCluster != null ? { view: "cluster", module:
    { kind: "cluster", n: selectedCluster, label: modules.label(selectedCluster) } } : null);
  const [zoomTick, setZoomTick] = useState(0);
  useEffect(() => { setRevolver(null); }, [points, taxonRank, filters, linkLen]);

  const taxa = useMemo(
    () => (taxaMode ? taxonPoints(visibleNodes, taxonRank) : []), [taxaMode, taxonRank, visibleNodes]);
  const taxaLinks = useMemo(
    () => (taxaMode ? taxonLinks(taxa, visibleEdges) : []), [taxaMode, taxa, visibleEdges]);
  const taxaById = useMemo(() => new Map(taxa.map((t) => [t.id, t])), [taxa]);
  const punktVon = useMemo(() => (taxaMode ? memberPoint(taxa) : new Map<string, string>()),
    [taxaMode, taxa]);

  const colorOfNode = (n: NetNode): string =>
    n.cluster < 0 ? NO_MODULE_COLOUR : modules.color(n.cluster);
  const taxaLayers = useMemo(() => {
    if (!taxaMode || !net) return null;
    const alle = taxonPoints(net.nodes, taxonRank);
    const con = taxonLinks(alle, net.edges);
    const mitRichtung = net.edges.filter((e) => (e.ccm_dirs ?? 0) > 0);
    const ccm = taxonLinks(alle, mitRichtung);
    const rej = taxonLinks(alle, net.edges.filter((e) => (e.rejected_dirs ?? 0) > 0));
    const beruehrt = (ls: { source: string; target: string }[]) =>
      new Set(ls.flatMap((l) => [l.source, l.target])).size;
    return { n_con: con.length, n_asv_con: beruehrt(con),
             n_con_with_ccm: ccm.length, n_asv_ccm: beruehrt(ccm),
             n_con_with_rejected: rej.length, n_asv_rejected: beruehrt(rej) };
  }, [taxaMode, taxonRank, net]);
  const offenerTaxon = revolver ? taxaById.get(revolver.id) ?? null : null;
  const radPx = useMemo(() => {
    if (!revolver) return null;
    try {
      const inst = chartRef.current?.getEchartsInstance();
      const a = (inst as any)?.convertToPixel({ seriesIndex: 0 }, [revolver.x, revolver.y]);
      return a ? { x: a[0] as number, y: a[1] as number } : null;
    } catch { return null; }
  }, [revolver, zoomTick]);

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
    return punkte;
  }, [taxaMode, taxa, visibleNodes]);

  const drawEdges = useMemo<NetEdge[]>(() => {
    if (!taxaMode) return visibleEdges;
    return taxaLinks.map((l) => ({
      source: l.source, target: l.target,
      ccm_dirs: l.n_directed > 0 ? 1 : 0,
      tax: l,
    } as unknown as NetEdge));
  }, [taxaMode, taxaLinks, visibleEdges]);

  const crossCount = useMemo(() => visibleEdges.filter(isCross).length, [visibleEdges, nodeCluster]);
  const ccmCount = useMemo(() => visibleEdges.filter(hasCcm).length, [visibleEdges]);
  const rejectedCount = useMemo(() => visibleEdges.filter(hasRejected).length, [visibleEdges]);
  const c2Visible = useMemo(() => visibleNodes.filter((n) => keyIds.has(n.id)).length,
    [visibleNodes, keyIds]);
  const c2Of = c2Visible !== keyIds.size ? ` (of ${keyIds.size} in the network)` : "";
  const isCrossDrawn = (e: NetEdge): boolean => {
    const tl = (e as unknown as { tax?: TaxonLink }).tax;
    return tl ? tl.n_crossing > 0 : isCross(e);
  };
  const drawnCounts = useMemo(() => (taxaMode
    ? { nodes: taxa.length, edges: taxaLinks.length,
        cross: taxaLinks.filter((l) => l.n_crossing > 0).length,
        ccm: taxaLinks.filter((l) => l.n_directed > 0).length }
    : { nodes: visibleNodes.length, edges: visibleEdges.length, cross: crossCount, ccm: ccmCount,
        rejected: rejectedCount, c2: c2Visible }),
  [taxaMode, taxa.length, taxaLinks, visibleNodes.length, visibleEdges.length, crossCount, ccmCount,
   rejectedCount, c2Visible]);
  const allIds = useMemo(() => new Set(net?.nodes.map((n) => n.id) ?? []), [net]);
  const unknownAsvIds = useMemo(
    () => (filters.asvs?.ids ?? []).filter((id) => !allIds.has(id)),
    [filters.asvs, allIds]);
  const chipCounts = useMemo(
    () => (net ? chainedCounts(net, filters, keyIds, order, occ) : new Map<FilterKind, number>()),
    [net, filters, keyIds, order, occ]);

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
  const markedDrawn = useMemo(() => (taxaMode
    ? new Set([...selMarked, ...[...selMarked].map((id) => punktVon.get(id) ?? id)])
    : selMarked), [taxaMode, selMarked, punktVon]);
  const gezeichnet = useCallback((id: string | null | undefined) =>
    (id == null ? null : punktVon.get(id) ?? id), [punktVon]);
  const taxKey = sel?.kind === "taxon" ? `${sel.rank}:${sel.value}` : null;
  const taxColorOf = useCallback((key: string) => {
    const TAX_OUTLINE = markerRings(tok.light);
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
    return TAX_OUTLINE[h % TAX_OUTLINE.length];
  }, [tok.light]);
  const markColor = sel?.kind === "cluster" ? taxColorOf(`cluster:${sel.label}`)
    : taxKey ? taxColorOf(taxKey) : null;

  const selHiddenBy = useMemo((): { labels: string[]; kinds: FilterKind[] } | null => {
    if (!net || !sel || sel.kind !== "asv" || visibleIds.has(sel.id)) return null;
    const n = net.nodes.find((x) => x.id === sel.id);
    if (!n) return null;
    const kinds = hiddenBy(net, filters, keyIds, n.id, occ);
    if (!kinds.length) return null;
    const label = (k: FilterKind): string => {
      switch (k) {
        case "modules": return `${modules.label(n.cluster)} hidden`;
        case "c2": return "only hubs";
        case "taxon": return filters.taxon ? `${filters.taxon.value} (${filters.taxon.rank})` : "taxon";
        case "asvs": return "ASV selection";
        case "presence": return `present in ≥ ${filters.presence ?? 1} samples`;
        case "abundance": return `abundance ${rangeLabel(filters.abundance, filters.abundanceMax, (v) => `${v} %`)}`;
        case "layer": return layerLabel(filters.layers);
        case "cross": return "crossing links only";
        case "strength": return [
          filters.strength != null || filters.strengthMax != null
            ? `r ${rangeLabel(filters.strength, filters.strengthMax, String)}` : null,
          filters.nmi != null ? `NMI ≥ ${filters.nmi}` : null].filter(Boolean).join(" · ");
        case "occurrence": return filters.occurrence ? occurrenceLabel(filters.occurrence) : "occurrence";
      }
    };
    return { labels: kinds.map(label), kinds };
  }, [net, sel, visibleIds, filters, keyIds, modules]);

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
  const [ewMin, ewMax] = useMemo((): [number | null, number | null] => {
    if (widthKind == null) return [null, null];
    const sk = net?.edge_width_scale?.[widthKind === "corr" ? "con" : widthKind];
    if (sk) return [sk[0], sk[1]];
    return widthKind === "corr" ? [net?.thresholds?.con_tr ?? 0, 1] : [0, 1];
  }, [net, widthKind]);
  const edgeWidth = useCallback((e: NetEdge): number => {
    const v = edgeStrength(e);
    if (v == null) return EDGE_W_MIN;
    // Three fixed steps instead of a continuous width (named in the legend).
    return v >= 0.9 ? 6 : v >= 0.8 ? 3 : 1;
  }, [edgeStrength, ewMin, ewMax]);

  const LABEL_AUTO_MAX = 60;
  const showLabels = labelMode === "on" || (labelMode === "auto" && drawNodes.length <= LABEL_AUTO_MAX);

  const layoutKey = useMemo(
    () => `${dataset.dataset_id}|${filters.layers.con}|${filters.layers.ccm}|${filters.layers.rejected}`
         + `|${points}|${taxonRank}|${linkLen}`
         + `|${drawNodes.map((n) => n.id).join(",")}`,
    [dataset.dataset_id, filters.layers, points, taxonRank, linkLen, drawNodes]);
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
                                xy: frozen.get(n.id) ?? null,
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


  const nodeOutline = tok.netNodeOutline;
  const selRing = tok.text;
  const labelColor = tok.netLabel;
  const labelBorder = tok.surface;
  const glowColours = useMemo(() => glowRing(tok.light), [tok.light]);


  const option = useMemo(() => ({
    backgroundColor: "transparent",
    tooltip: {
      ...chartTooltip(tok),
      formatter: (p: any) => {
        const tax = p.data?.taxon as { label: string; n: number; nModules: number } | undefined;
        if (p.dataType === "node" && tax) {
          return `${esc(tax.label)}<br/><span style="opacity:.75">${tax.n} ASV`
            + `${tax.n === 1 ? "" : "s"}</span>`
            + (tax.nModules > 1
              ? `<br/><span style="opacity:.75">members in ${tax.nModules} modules</span>` : "");
        }
        const tl = p.data?.tax as TaxonLink | undefined;
        if (p.dataType === "edge" && tl) {
          return `${esc(p.data.source)} — ${esc(p.data.target)}`
            + `<br/><span style="opacity:.75">${tl.n_links} link`
            + `${tl.n_links === 1 ? "" : "s"} between members, ${tl.n_directed} with a `
            + `direction</span>`
            + (tl.n_crossing > 0 ? `<br/>${tl.n_crossing} of them cross modules` : "");
        }
        if (p.dataType === "node") return `${esc(p.data.id)}${p.data.value ? ` (${esc(p.data.value)})` : ""}`
          + (p.data.module != null ? `<br/>${esc(p.data.module)}` : "")
          + (p.data.present != null
            ? `<br/><span style="opacity:.75">found in ${p.data.present} of ${nSamples} samples</span>`
            : "")
          + (p.data.share != null
            ? `<br/><span style="opacity:.75">${(100 * p.data.share).toFixed(2)} % of the summed abundance of the ${p.data.nPool} network ASVs</span>`
            : "")
          + (p.data.c2 ? `<br/><span style="color:${tok.mark}">✦</span>` : "");
        const e: NetEdge | undefined = p.data?.manta;
        if (!e) return "";
        const dir = e.ccm_forward && e.ccm_backward ? "↔"
          : e.ccm_forward ? "→" : e.ccm_backward ? "←" : "—";
        const ccm = (e.ccm_dirs ?? 0) === 0
          ? "co-occurrence only — no measurable direction"
          : e.ccm_dirs === 2 ? "CCM in both directions" : "CCM in one direction";
        return `${esc(e.source)} ${dir} ${esc(e.target)}<br/>corr ${e.corr?.toFixed(4)} · raw p ${fmtP(e.p_value)}`
          + (e.nmi_forward != null ? `<br/>NMI → ${e.nmi_forward.toFixed(4)}` : "")
          + (e.nmi_backward != null ? `<br/>NMI ← ${e.nmi_backward.toFixed(4)}` : "")
          + (e.nmi_rejected_forward != null
            ? `<br/><span style="opacity:.75">NMI → ${e.nmi_rejected_forward.toFixed(4)} · tested, rejected</span>` : "")
          + (e.nmi_rejected_backward != null
            ? `<br/><span style="opacity:.75">NMI ← ${e.nmi_rejected_backward.toFixed(4)} · tested, rejected</span>` : "")
          + `<br/><span style="opacity:.75">${ccm}</span>`
          + (edgeStrength(e) != null && ewMin != null && ewMax != null
            ? `<br/><span style="opacity:.75">line width = ${widthKind === "rejected" ? "NMI of the rejected direction" : widthKind === "ccm" ? "largest NMI" : "corr"} `
              + `${edgeStrength(e)!.toFixed(3)} (steps ≥ 0.9 · 0.8–0.9 · < 0.8)</span>`
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
        nodeScaleRatio: 0,
        draggable: true,
        ...(roam.current ? { zoom: roam.current.zoom, center: roam.current.center }
                    : {}),
        force: { repulsion: 2600, edgeLength: Math.round(10 * 1.065 ** linkLen), gravity: 0.06, layoutAnimation: false },
        data: drawNodes.map((n) => {
          const xy: [number, number] = frozen?.get(n.id) ?? seedXY(n.id);
          const glows = keyIds.has(n.id);
          const isOpen = openAsvId != null && (n.id === openAsvId || n.id === gezeichnet(openAsvId));
          const isSelAsv = sel?.kind === "asv" && (n.id === sel.id || n.id === gezeichnet(sel.id));
          const marked = sel != null && sel.kind !== "asv" && markedDrawn.has(n.id);
          const dimmed = !exploreOn && sel != null && !isSelAsv && !marked && !isOpen;
          const hervor = herausAktiv?.has(n.id) ?? false;
          const tp = taxaById.get(n.id);
          return {
            id: n.id, name: n.id, value: n.genus ?? "", genus: n.genus ?? "", c2: glows,
            module: n.cluster >= 0 ? modules.label(n.cluster) : null,
            ...(tp ? { taxon: { label: tp.label, n: tp.members.length,
                                nModules: new Set(tp.members.map((m) => m.cluster)).size } } : {}),
            share: totalSize > 0 ? (n.size || 0) / totalSize : null, nPool: net?.nodes.length ?? 0,
            present: tp ? null : n.n_samples_present,
            x: xy[0], y: xy[1],
            symbolSize: scale(n.size ?? 0),
            ...((isSelAsv && sel?.label) || hervor ? { label: { show: true, formatter: hervor ? n.id : undefined } } : {}),
            itemStyle: {
              color: colorOfNode(n),
              opacity: dimmed ? DIM_NODE : 1,
              borderWidth: RING_W,
              shadowBlur: RING_GLOW,
              borderColor: isOpen ? tok.accent
                : isSelAsv ? selRing
                : marked ? (markColor ?? markerRings(tok.light)[0])
                : glows ? glowColours.ring
                : nodeOutline,
              ...(marked && !isOpen && !isSelAsv ? { borderType: "dashed" as const } : {}),
              ...(hervor ? { borderColor: tok.accent, borderWidth: 4, shadowBlur: 18 } : {}),
              shadowColor: dimmed ? "transparent"
                : isOpen ? tok.accent
                : isSelAsv ? selRing
                : hervor ? tok.accent
                : glows ? glowColours.glow
                : "transparent",
            },
          };
        }),
        links: drawEdges.flatMap((e) => {
          const cross = isCrossDrawn(e);
          const base = cross
            ? { color: tok.crossLink, opacity: 0.9 }
            : { color: tok.netLink, opacity: hasCcm(e) ? 0.75 : 0.4 };
          const selPunkt = sel?.kind === "asv" ? gezeichnet(sel.id) : null;
          const incident = sel?.kind === "asv" && (e.source === sel.id || e.target === sel.id
            || e.source === selPunkt || e.target === selPunkt);
          const tl = (e as unknown as { tax?: TaxonLink }).tax;
          const L = filters.layers;
          const opacity = sel == null || incident ? base.opacity : DIM_EDGE;
          const common = {
            source: e.source, target: e.target, value: e.corr, manta: tl ? undefined : e,
            ...(tl ? { tax: tl } : {}),
            cross,
          };
          const out: Record<string, unknown>[] = [];
          // Draft C: the selected ASV's links carry their values.
          const wert = !tl && incident ? [e.corr != null ? `r ${e.corr.toFixed(2)}` : null,
            e.nmi_forward != null || e.nmi_backward != null
              ? `NMI ${Math.max(e.nmi_forward ?? 0, e.nmi_backward ?? 0).toFixed(2)}` : null]
            .filter(Boolean).join(" · ") : "";
          const gerade = tl != null || L.con || (L.ccm && hasCcm(e));
          if (gerade) out.push({
            ...common,
            symbol: L.ccm
              ? [e.ccm_backward ? "arrow" : "none", e.ccm_forward ? "arrow" : "none"]
              : ["none", "none"],
            lineStyle: { ...base, opacity,
                         width: tl ? Math.min(EDGE_W_MAX, EDGE_W_MIN + (tl.n_links - 1) * 0.8)
                                   : edgeWidth(e) },
            ...(wert ? { label: { show: true, formatter: wert, color: tok.text, fontSize: FONT.xs2,
                                  backgroundColor: tok.overlay, padding: [1, 3], borderRadius: 3 } } : {}),
          });
          if (!tl && L.rejected && hasRejected(e)) out.push({
            ...common,
            symbol: [e.rejected_backward ? "arrow" : "none", e.rejected_forward ? "arrow" : "none"],
            lineStyle: { ...base, opacity, type: "dashed" as const,
                         curveness: gerade ? 0.25 : 0,
                         width: gerade ? EDGE_W_MIN : edgeWidth(e) },
          });
          return out;
        }),
        edgeSymbolSize: 15,
        label: {
          show: showLabels,
          position: "right" as const,
          formatter: (p: { data: { genus?: string; id: string } }) => p.data.genus || p.data.id,
          color: labelColor,
          fontSize: FONT.xs2,
          textBorderColor: labelBorder,
          textBorderWidth: 3,
        },
        emphasis: { focus: "adjacency" },
      },
    ],
  }), [drawNodes, drawEdges, taxaMode, maxSize, totalSize, net, nodeCluster, showLabels, frozen,
       c2, keyIds, seedXY, sel, selMarked, markedDrawn, gezeichnet, markColor, edgeWidth, openAsvId, dense,
       scale, edgeStrength, ewMin, ewMax, filters.layers, light, nodeOutline, selRing,
       labelColor, labelBorder, glowColours, tok, modules,
       linkLen, nSamples, exploreOn, herausAktiv]);

  const optionRef = useRef(option);
  optionRef.current = option;
  useEffect(() => {
    (window as unknown as Record<string, unknown>).__mantaDrawn = () => {
      const s = (optionRef.current as { series?: { data: any[]; links: any[] }[] }).series?.[0];
      if (!s) return null;
      const pts = s.data.filter((d) => !/^(ring|disc):/.test(String(d.id)));
      const ls = s.links.filter((l) => !/^ring:/.test(String(l.source)));
      const dimmed = pts.filter((d) => d.itemStyle?.opacity === DIM_NODE).length;
      const widths: Record<string, number> = {};
      for (const l of ls) {
        const k = `${l.source}|${l.target}`;
        if (!(k in widths) && !l.lineStyle?.type) widths[k] = l.lineStyle?.width;
      }
      const graphic = (optionRef.current as { graphic?: unknown[] }).graphic?.length ?? 0;
      return { nodes: pts.length, lit: pts.length - dimmed, dimmed, links: ls.length,
               amber: ls.filter((l) => l.cross === true).length, widths, graphic };
    };
  }, []);

  const thr = net?.thresholds;

  const sizePresent: boolean | null = net ? net.nodes.some((n) => n.size != null) : null;
  const widthText = widthKind == null ? null
    : `${widthKind === "corr" ? "r" : "NMI"} ≥ 0.9 · 0.8–0.9 · < 0.8`;
  const legend = useMemo(() => legendRows({
    nModules: net?.partition?.n_clusters ?? clusters.length,
    nCross: drawnCounts.cross,
    sizePresent,
    conTr: thr?.con_tr ?? null, conAlpha: thr?.con_alpha ?? null,
    recorded: thr?.recorded ?? false,
    ccmVisible: filters.layers.ccm && ccmCount > 0,
    rejectedVisible: filters.layers.rejected && rejectedCount > 0,
    widthText,
    c2Glow: keyLabel, c2Visible: !taxaMode && c2Visible > 0,
    highlightActive: sel != null,
  }), [net, clusters.length, sizePresent, thr, ccmCount, rejectedCount, filters.layers,
       widthText, keyLabel, c2Visible, sel, taxaMode, drawnCounts.cross]);

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
        case "c2": return "✦ only";
        case "taxon": return filters.taxon ? `${filters.taxon.value} (${filters.taxon.rank})` : "taxon";
        case "asvs": return `${(filters.asvs?.ids.length ?? 0) - unknownAsvIds.length} selected ASVs`
          + (filters.asvs?.neighbors ? " + neighbours" : "");
        case "presence": return `present in ≥ ${filters.presence ?? 1} of ${nSamples} samples`;
        case "abundance": return `mean relative abundance ${rangeLabel(filters.abundance, filters.abundanceMax, (v) => `${v} %`)}`;
        case "strength": return [
          filters.strength != null || filters.strengthMax != null
            ? `r ${rangeLabel(filters.strength, filters.strengthMax, String)}` : null,
          filters.nmi != null ? `NMI ≥ ${filters.nmi}` : null].filter(Boolean).join(" · ");
        case "occurrence": return filters.occurrence ? occurrenceLabel(filters.occurrence) : "occurrence";
      }
    }).join(" · ");
    return `Filters: ${txt} — ${visibleNodes.length} of ${net.nodes.length} ASVs shown`;
  }, [net, order, filters, clusters, unknownAsvIds, visibleNodes.length, nSamples]);

  const exportPng = useCallback(() => {
    const inst = chartRef.current?.getEchartsInstance();
    if (!inst || !net) return;
    const url = (inst as any).getDataURL({ pixelRatio: 2, backgroundColor: tok.surface });
    const img = new Image();
    img.onload = () => {
      const markLine = sel?.kind === "taxon"
        ? `${sel.value} (${sel.rank}) marked — ${selMarked.size} ASVs; nodes stay individual, no link is touched`
        : sel?.kind === "cluster"
          ? `${modules.label(sel.label)} marked — ${selMarked.size} ASVs; other nodes dimmed`
          : sel?.kind === "asv" ? `${sel.id} highlighted — other nodes dimmed, its links kept` : null;
      const lines = [
        ...(markLine ? [markLine] : []),
        filterLineText(),
        "Legend:",
        ...legend.filter((r) => !r.dim).map((r) => `  ${r.icon}  ${r.term} — ${r.desc}`),
        `  Thresholds: ${thresholdLine({
          conTr: thr?.con_tr ?? null, conAlpha: thr?.con_alpha ?? null,
          recorded: thr?.recorded ?? false })}`,
        ...(widthText ? [`  ${widthText}`] : []),
        ...(c2 && crit === 2 && !taxaMode ? [
          `  Hubs computed: ${c2.formula}`,
          `  Source: ${c2.source}`,
        ] : []),
        `${drawnCounts.nodes} ${taxaMode ? "taxa" : "ASVs"} · ${drawnCounts.edges} edges · ${drawnCounts.ccm} with CCM · `
          + (!taxaMode && net.layers?.ccm_tested_recorded ? `${rejectedCount} with a rejected direction · ` : "")
          + `${drawnCounts.cross} crossing modules${!taxaMode ? ` · ${c2Visible} ✦${c2Of}` : ""}`,
      ];
      const pad = 24, lineH = 30;
      const c = document.createElement("canvas");
      c.width = img.width;
      const g = c.getContext("2d");
      if (!g) return;
      g.font = "22px sans-serif";
      const maxW = c.width - 2 * pad;
      const zeilen = lines.flatMap((l) => {
        if (g.measureText(l).width <= maxW) return [l];
        const out: string[] = [];
        let cur = "";
        for (const w of l.split(" ")) {
          const next = cur ? `${cur} ${w}` : w;
          if (cur && g.measureText(next).width > maxW) { out.push(cur); cur = `      ${w}`; }
          else cur = next;
        }
        if (cur) out.push(cur);
        return out;
      });
      c.height = img.height + pad * 2 + zeilen.length * lineH;
      g.fillStyle = tok.surface; g.fillRect(0, 0, c.width, c.height);
      g.drawImage(img, 0, 0);
      g.fillStyle = tok.text; g.font = "22px sans-serif";
      zeilen.forEach((l, i) => g.fillText(l, pad, img.height + pad + (i + 0.8) * lineH));
      const a = document.createElement("a");
      a.href = c.toDataURL("image/png");
      a.download = `${dataset.dataset_id}_network.png`;
      a.click();
    };
    img.src = url;
  }, [net, legend, filterLineText, visibleNodes.length, visibleEdges.length, ccmCount,
      rejectedCount, crossCount, c2, c2Visible, c2Of, dataset.dataset_id, tok, thr, widthText,
      drawnCounts, taxaMode, sel, selMarked, modules]);

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
    // Double-click on a point opens its ASV page. The first click re-renders the chart, so
    // ECharts' node dblclick never fires; the canvas dblclick plus the last clicked point does.
    const h = (e: { target?: unknown }) => {
      const k = letzterKlick.current;
      if (k && Date.now() - k.t < 600) { letzterKlick.current = null; setTimeout(() => onOpenAsv(k.id), 0); return; }
      if (!e.target) { onShowNet(); resetZoom(); }
    };
    const einfach = (e: { target?: unknown }) => { if (!e.target) setRevolver(null); };
    zr.on("dblclick", h);
    zr.on("click", einfach);
    return () => {
      try { zr.off("dblclick", h); zr.off("click", einfach); } catch { }
    };
  }, [net, onShowNet, resetZoom, onOpenAsv]);

  const capOf = (key: string) => caps?.items.find((i) => i.key === key);
  const timeCap = capOf("time_axis");
  const umschalten = (art: string, offen: boolean, oeffnen: () => void) => () =>
    (offen ? onCloseView(art) : oeffnen());
  const viewItems: ViewItem[] = [
    { key: "wheel", testid: "wheel-toggle", label: "Wheel", icon: "◔",
      open: wheelOpen, onOpen: umschalten("wheel", wheelOpen, onOpenWheel),
      disabledReason: timeCap && !timeCap.available ? timeCap.detail : null },
    ...extraViews.map(({ view, kind, open, onOpen }) => ({
      key: view.key, testid: view.testid, label: view.label, icon: view.icon,
      open, onOpen: umschalten(kind, open, onOpen), disabledReason: null })),
    { key: "compare", testid: "compare-toggle", label: "Inspect", icon: "⌕",
      open: compareOpen, onOpen: umschalten("compare", compareOpen, onOpenCompare),
      disabledReason: timeCap && !timeCap.available ? timeCap.detail : null },
    { key: "legend", testid: "legend-view-toggle", label: "Legend", icon: "ⓘ",
      open: legendeOffen, onOpen: () => setLegendeOffen((v) => !v), disabledReason: null },
    { key: "starred", testid: "starred-toggle", label: "Star", icon: "★",
      open: starredOpen, onOpen: umschalten("starred", starredOpen, onOpenStarred), disabledReason: null },
  ];
  const anyViewOpen = wheelOpen || extraViews.some((x) => x.open)
    || compareOpen || starredOpen || legendeOffen;

  const selNode = sel?.kind === "asv" ? net?.nodes.find((n) => n.id === sel.id) ?? null : null;

  return (
    <div className="h-full flex relative">
      <NetworkSidebar
        dataset={dataset} net={net} c2={c2}
        kp={kp} onKp={patchKp} nCrit1={c1Ids.size} nKey={keyIds.size}
        visibleNodes={visibleNodes} nSamples={nSamples}
        clusters={clusters} clusterColor={clusterColor} countByCluster={countByCluster}
        filters={filters} onFilters={patchFilters}
        onClearKind={(k) => setFilters((f) => clearKind(f, k))}
        onClearAll={() => setFilters(emptyFilters())}
        onStartNone={() => { setSel(null); setFilters(startNone()); }}
        order={order} chipCounts={chipCounts} unknownAsvIds={unknownAsvIds}
        taxaMode={taxaMode} points={points} onPoints={setPoints}
        taxonRank={taxonRank} onTaxonRank={setTaxonRank} taxaLayers={taxaLayers}
        explore={exploreOn}
        onExplore={(on) => {
          setExploreOn(on);
          if (on && filters.asvs == null) { setSel(null); setFilters((f) => ({ ...f, asvs: { ids: [], neighbors: false } })); }
        }}
        linkLength={linkLen} linkLengthDefault={LINK_LENGTH_DEFAULT}
        onLinkLength={(v) => { roam.current = null; setLinkLen(v); }}
        sizeAbsent={sizePresent === false}
        views={{ anyViewOpen: anyViewOpen || selectedCluster != null || openAsvId != null,
                 onShowNet: () => { onShowNet(); setSelectedCluster(null); setLegendeOffen(false); },
                 items: viewItems }}
        onPickAsv={(id) => {
          if (exploreOn) setFilters((f) => exploreAdd(f, id));
          setSel({ kind: "asv", id, focus: Date.now(), label: true });
        }}
        onOpenAsv={onOpenAsv}
        onPickTaxon={(rank, value) => setSel({ kind: "taxon", rank, value })}
        onPickCluster={(label) => setSel({ kind: "cluster", label })}
        onOpenClusterPanel={(label) => setSelectedCluster(label)}
        onOpenFilter={setFilterWin}
        occurrenceReason={timeCap && !timeCap.available ? timeCap.detail : null}
      />

      <div className="flex-1 min-w-0 relative" data-testid="network-canvas" data-layout-hash={layoutHash}
        data-link-length={linkLen}
        data-tax-key={taxKey ?? ""}
        data-tax-marked={sel?.kind === "taxon" ? selMarked.size : 0}
        data-highlight={sel?.kind === "asv" ? sel.id : ""}
        data-open-asv={openAsvId ?? ""}
        data-ew-min={ewMin?.toFixed(4) ?? ""} data-ew-max={ewMax?.toFixed(4) ?? ""}
        data-min-gap={minGap?.toFixed(1) ?? ""}>
        {err != null && <ErrorNotice error={err} what="Could not load the network."
          onRetry={() => { setFrozen(null); setReloadKey((k) => k + 1); }} />}

        {occLoading && occErr == null && (
          <div className="absolute inset-x-0 top-14 z-10 flex justify-center pointer-events-none">
            <StateNotice state="loading" inline>loading occurrence …</StateNotice>
          </div>
        )}

        {net && drawnCounts.nodes === 0 && !occLoading && (
          <div className="absolute inset-x-0 top-14 z-10 flex justify-center pointer-events-none">
            <p data-testid="canvas-empty"
              className="pointer-events-auto rounded border border-line-strong bg-overlay px-3 py-2 text-xs text-fg">
              {net.nodes.length === 0 ? "This dataset's network has no nodes."
                : filters.asvs?.ids.length === 0 ? "Nothing shown yet. Search an ASV on the left to add it." : (
                <>
                  No ASV passes the active filters.{" "}
                  <TextButton data-testid="canvas-empty-clear" onClick={() => setFilters(emptyFilters())}>
                    clear all</TextButton>
                </>
              )}
            </p>
          </div>
        )}

        {offenerTaxon && radPx && (
          <TaxonWheel x={radPx.x} y={radPx.y} label={offenerTaxon.label}
            members={offenerTaxon.members} colorOf={colorOfNode}
            moduleOf={(m) => (m.cluster >= 0 ? modules.label(m.cluster) : null)}
            onPick={(id) => {
              setRevolver(null);
              setSel({ kind: "asv", id, focus: Date.now() });
              onOpenAsv(id);
            }}
            onCenter={() => {
              setRevolver(null);
              if (taxonRank === "species") onOpenTaxon(offenerTaxon.members[0].id);
            }}
            onClose={() => setRevolver(null)} />
        )}

        {sel && !(sel.kind === "asv" && sel.id === openAsvId && !selHiddenBy) && (
          <div data-testid="highlight-bar"
            className={`absolute top-2 left-3 z-10 flex
                       items-center gap-2 rounded border border-line-strong bg-overlay
                       px-3 py-1 text-xs shadow-lg max-w-[70%]`}>
            {sel.kind === "asv" && (
              <>
                <span className="font-mono text-fg">{sel.id}</span>
                {selNode?.genus && <span className="italic text-fg">{selNode.genus}</span>}
                {selNode && <span className="text-fg-muted">{modules.label(selNode.cluster)}</span>}
                {selHiddenBy && selHiddenBy.kinds.length === 1 && selHiddenBy.kinds[0] === "asvs" ? (
                  <>
                    <span data-testid="highlight-hidden-note" className="text-warn">not shown</span>
                    <TextButton data-testid="highlight-add" className="whitespace-nowrap"
                      onClick={() => setFilters((f) => (f.asvs
                        ? { ...f, asvs: { ...f.asvs, ids: [...new Set([...f.asvs.ids, sel.id])] } } : f))}>
                      add it</TextButton>
                  </>
                ) : selHiddenBy ? (
                  <>
                    <span data-testid="highlight-hidden-note" className="text-warn">
                      not visible — hidden by the filter{selHiddenBy.labels.length > 1 ? "s" : ""}{" "}
                      {selHiddenBy.labels.map((l) => `“${l}”`).join(", ")}
                    </span>
                    <TextButton data-testid="highlight-unfilter" className="whitespace-nowrap"
                      onClick={() => setFilters((f) => selHiddenBy.kinds.reduce((g, k) => clearKind(g, k), f))}>
                      {selHiddenBy.kinds.length > 1 ? "remove these filters" : "remove that filter"}
                    </TextButton>
                  </>
                ) : (
                  <TextButton data-testid="highlight-open-details" className="whitespace-nowrap"
                    onClick={() => onOpenAsv(sel.id)}>
                    open details
                  </TextButton>
                )}
              </>
            )}
            {sel.kind === "taxon" && (
              <span data-testid="tax-marked-note" className="text-warn">
                ◌ {selMarked.size} ASV{selMarked.size === 1 ? "" : "s"} of{" "}
                {sel.value} ({sel.rank}) marked
              </span>
            )}
            {sel.kind === "cluster" && (
              <span className="text-warn">
                ◌ {modules.label(sel.label)} · {selMarked.size} ASV{selMarked.size === 1 ? "" : "s"} marked
              </span>
            )}
            {sel.kind === "taxon" ? (
              <TextButton data-testid="tax-clear" onClick={() => setSel(null)}>clear</TextButton>
            ) : (
              <button data-testid="highlight-clear" onClick={() => setSel(null)}
                aria-label="clear highlight"
                className="text-fg-muted hover:text-fg">✕</button>
            )}
          </div>
        )}

        <div className="absolute top-2 right-2 z-10 flex gap-1">
          <Button data-testid="canvas-undo" onClick={undo} disabled={nUndo === 0}
            title="undo the last change of the network" className="bg-raised">↶ undo</Button>
          <Button data-testid="canvas-zoom-reset" onClick={resetZoom}
            title="reset zoom and centering" className="bg-raised">⛶ fit</Button>
          <Button data-testid="canvas-export" onClick={exportPng}
            title="export image (carries legend and active filters)" className="bg-raised">⇩ PNG</Button>
          <Button data-testid="canvas-reload" title="reload network" className="bg-raised"
            onClick={() => { setFrozen(null); setReloadKey((k) => k + 1); }}>⟳ reload</Button>
        </div>
        {settingsOpen && createPortal(
            <div data-testid="settings-panel" role="dialog" aria-label="Display settings" data-popup=""
              style={{ zIndex: Z.popover }}
              className="fixed right-2 top-12 w-80 max-h-[calc(100vh-4rem)] overflow-y-auto
                         rounded-md border border-line bg-overlay p-3 shadow-xl space-y-3">
              <h2 className="text-xs font-semibold text-fg-muted">Display</h2>
              <ThemeSwitch theme={theme} onTheme={onTheme} />
              <div className="flex items-center justify-between gap-2" data-testid="label-switch">
                <span className="text-xs text-fg-muted">Names</span>
                <Segmented value={labelMode} onChange={setLabelMode}
                  options={(["auto", "on", "off"] as const).map((v) => (
                    { value: v, label: v, testid: `labels-${v}` }))} />
              </div>


              {thr && (
                <div className="pt-3 border-t border-line space-y-1" data-testid="threshold-summary">
                  <SectionHeading>Threshold</SectionHeading>
                  <div className="text-xs text-fg tabular-nums">
                    <div>CON: Pearson ≥ {thr.con_tr} · p &lt; {thr.con_alpha}</div>
                    <div className="text-fg-muted">
                      CCM: permutation test · {thr.num_permutations} permutations
                    </div>
                  </div>
                  {!thr.recorded && (
                    <div className="text-xs text-warn" data-testid="threshold-defaults-note">
                      defaults — not recorded for this dataset
                    </div>
                  )}
                  <TextButton data-testid="threshold-open" className="text-xs"
                    onClick={() => { onCloseSettings?.(); setShowThresholds(true); }}>
                    adjust and recompute …
                  </TextButton>
                </div>
              )}
              {signedIn && <OwnModelSettings />}
            </div>, document.body)}
        {net ? (
          <ReactECharts ref={chartRef} option={option} style={{ height: "100%", width: "100%" }}
            notMerge lazyUpdate
            onEvents={{
              finished: freeze,
              graphroam: () => {
                const inst = chartRef.current?.getEchartsInstance();
                const serie = (inst as any)?.getOption()?.series?.[0];
                if (serie && Number.isFinite(serie.zoom) && Array.isArray(serie.center)) {
                  roam.current = { zoom: serie.zoom, center: serie.center as [number, number] };
                  if (revolver) setZoomTick((t) => t + 1);
                }
              },
              click: (p: any) => {
                if (p.dataType === "node" && taxaMode) {
                  const id: string = p.data.id;
                  const t = taxaById.get(id);
                  if (t && t.members.length > 1) {
                    const xy = frozen?.get(id) ?? seedXY(id);
                    setRevolver({ id, x: xy[0], y: xy[1] });
                    return;
                  }
                  if (t) {
                    p = { ...p, data: { ...p.data, id: t.members[0].id } };
                  }
                }
                if (p.dataType === "node") {
                  letzterKlick.current = { id: p.data.id, t: Date.now() };
                  if (focusTimer.current) {
                    clearTimeout(focusTimer.current); focusTimer.current = null;
                  }
                  setSel({ kind: "asv", id: p.data.id, focus: Date.now() });
                  if (exploreOn) { const id: string = p.data.id; setFilters((f) => exploreAdd(f, id)); }
                } else if (p.dataType === "edge" && p.data?.manta) {
                  onOpenEdge({ source: p.data.manta.source, target: p.data.manta.target, type: "con" });
                }
              },
            }} />
        ) : (
          err == null && <div className="h-full grid place-items-center"><StateNotice state="loading" inline>loading network …</StateNotice></div>
        )}
      </div>

      {filterWin && net && (
        <PanelFrame id="filter" title={WINDOW_TITLE[filterWin]} onClose={() => setFilterWin(null)}
          defaultWidth={460}>
          <FilterWindow key={filterWin} kind={filterWin} net={net} filters={filters}
            onFilters={patchFilters} dates={dates} nSamples={nSamples}
            datasetId={dataset.dataset_id} occError={occErr} onOpenModule={setSelectedCluster} />
        </PanelFrame>
      )}

      {legendeOffen && (
        <PanelFrame id="legend" title="Legend" onClose={() => setLegendeOffen(false)} defaultWidth={440}>
          <LegendPanel datasetId={dataset.dataset_id} thr={thr} c2={c2} keyLabel={keyLabel}
            labelMax={LABEL_AUTO_MAX}
            sizeAbsent={sizePresent === false} widthText={widthText}
            onClose={() => setLegendeOffen(false)} />
        </PanelFrame>
      )}

      {selectedCluster != null && (
        <PanelFrame id="cluster" title="Module" onClose={() => setSelectedCluster(null)} defaultWidth={460}>
        <ClusterPanel datasetId={dataset.dataset_id} label={selectedCluster} isAdmin={isAdmin}
          signedIn={signedIn}
          color={clusterColor.get(selectedCluster)} onClose={() => setSelectedCluster(null)}
          onOpenAsv={onOpenAsv} onOpenEdge={onOpenEdge}
          colorOf={(c) => clusterColor.get(c)}
          onOpenCluster={(c) => setSelectedCluster(c)} onInspectAt={onInspectAt}
          crit={crit} c1Ids={c1Ids} />
        </PanelFrame>
      )}

      {showThresholds && thr && (
        <ThresholdDialog datasetId={dataset.dataset_id} current={thr}
          onClose={() => setShowThresholds(false)}
          onDone={() => onRefresh?.()}
          onOpenDataset={onOpenDataset ? (id) => { setShowThresholds(false); onOpenDataset(id); }
                                       : undefined} />
      )}
    </div>
  );
}

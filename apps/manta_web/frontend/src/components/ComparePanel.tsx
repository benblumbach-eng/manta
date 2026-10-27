import { useEffect, useMemo, useRef, useState } from "react";
import ReactECharts from "echarts-for-react";
import { getAsv, getAsvList, getCluster, getEdge, getEnvironment, getModules, getSamples,
         type EdgeDetail, type Environment, type ModuleLabel, type SampleList } from "../api";
import { Chooser, ChooserRow, Segmented } from "./controls";
import InfoTip from "./InfoTip";
import { Button } from "./ui";
import { PanelHeader } from "./PanelFrame";
import ProvenanceFooter from "./ProvenanceFooter";
import ErrorNotice from "./ErrorNotice";
import { fmtShare } from "../format";
import InspectTimePoint from "./InspectTimePoint";
import { useDatasetSearch } from "../datasetSearch";
import { chartTooltip, FONT, useTokens } from "../design/tokens";
import { seriesColour } from "../design/dataColours";
import { esc } from "../format";
import { useNearestPointClick } from "../chartClick";
import type { EdgeRef } from "../App";


const MAX_CURVES = 6;
const DOTS = "time points";
const MONATE = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

type Kind = "asv" | "cluster" | "env";
export type InspectMark = { kind: "asv" | "cluster"; id: string };
type Punkt = { t: number; date: string; value: number | null };
type Partner = { id: string; corr?: number; nmi?: number; con: boolean; ccm: boolean };
type Curve = {
  key: string; kind: Kind; id: string; label: string; sub: string | null;
  unit: string | null; partners?: Partner[];
  points: Punkt[];
};
type Tab = "time" | "point";

const prozent = (v: number, max: number) =>
  `${(100 * v).toFixed(max < 0.001 ? 3 : max < 0.1 ? 2 : 1)} %`;

const ausPunkten = (rohe: { date: string | null; value: number | null }[]): Punkt[] =>
  rohe
    .filter((p): p is { date: string; value: number | null } => !!p.date)
    .map((p) => ({ t: Date.parse(p.date), date: p.date, value: p.value }))
    .filter((p) => Number.isFinite(p.t))
    .sort((a, b) => a.t - b.t);

const partnerVon = (n: { con: { id: string; corr?: number }[]; ccm: { id: string; nmi?: number }[] }) => {
  const m = new Map<string, Partner>();
  for (const x of n.con) m.set(x.id, { id: x.id, corr: x.corr, con: true, ccm: false });
  for (const x of n.ccm) {
    const v = m.get(x.id);
    if (v) { v.ccm = true; v.nmi = x.nmi; } else m.set(x.id, { id: x.id, nmi: x.nmi, con: false, ccm: true });
  }
  return [...m.values()].sort((a, b) => (b.corr ?? b.nmi ?? 0) - (a.corr ?? a.nmi ?? 0));
};

// The series rebuilt from Fourier coefficients 1..fc-1 (the pattern the link's r compares),
// plus the mean so it sits on the measured curve.
const rhythmus = (vs: number[], fc: number) => {
  const n = vs.length;
  if (!n) return [];
  const mean = vs.reduce((a, b) => a + b, 0) / n;
  const ks = new Set<number>();
  for (let k = 1; k < fc; k++) { ks.add(k % n); ks.add((n - k) % n); }
  ks.delete(0);
  const co = [...ks].map((k) => {
    let re = 0, im = 0;
    vs.forEach((v, t) => { re += v * Math.cos(2 * Math.PI * k * t / n); im -= v * Math.sin(2 * Math.PI * k * t / n); });
    return [k, re, im] as const;
  });
  return vs.map((_, t) => mean + co.reduce((acc, [k, re, im]) =>
    acc + re * Math.cos(2 * Math.PI * k * t / n) - im * Math.sin(2 * Math.PI * k * t / n), 0) / n);
};

export default function ComparePanel({ datasetId, initialAsvId, initialSample, mark, sampleTick,
                                       link, onOpenEdge, onToNetwork, onClose, onOpenAsv }: {
  datasetId: string;
  initialAsvId?: string;
  initialSample?: string;
  mark?: InspectMark;
  sampleTick?: number;
  link?: EdgeRef;
  onOpenEdge?: (e: EdgeRef) => void;
  onToNetwork?: (modules: number[], asvs: string[]) => void;
  onClose: () => void;
  onOpenAsv: (id: string) => void;
}) {
  const [env, setEnv] = useState<Environment | null>(null);
  const [modules, setModules] = useState<ModuleLabel[]>([]);
  const [curves, setCurves] = useState<Curve[]>([]);
  const [search, setSearch] = useState("");
  const [err, setErr] = useState<unknown>(null);
  const [zeitraum, setZeitraum] = useState<string>("total");
  const [von, setVon] = useState<string | null>(null);
  const [bis, setBis] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("time");
  const [samples, setSamples] = useState<SampleList["samples"]>([]);
  const [punkt, setPunkt] = useState<string | null>(null);
  const [markiert, setMarkiert] = useState<string | null>(null);

  useEffect(() => {
    setCurves([]); setErr(null); setEnv(null); setModules([]); setSamples([]); setPunkt(null);
    setMarkiert(null); setVon(null); setBis(null); setZeitraum("total");
    getEnvironment(datasetId).then(setEnv).catch(() => setEnv(null));
    getModules(datasetId).then((m) => setModules(m.modules)).catch(() => setModules([]));
    getSamples(datasetId).then((r) => {
      setSamples(r.samples);
      setPunkt((p) => p ?? r.samples[0]?.sample ?? null);
    }).catch(() => setSamples([]));
  }, [datasetId]);
  const [asvListe, setAsvListe] = useState<{ id: string; label: string; share: number }[]>([]);
  const [searchFocus, setSearchFocus] = useState(false);
  useEffect(() => {
    setAsvListe([]);
    getAsvList(datasetId).then((r) => setAsvListe(r.asvs)).catch(() => setAsvListe([]));
  }, [datasetId]);
  const zeige = (sample: string) => { setPunkt(sample); setTab("point"); };
  useEffect(() => {
    if (initialSample) zeige(initialSample);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSample, sampleTick]);
  const punktDatum = samples.find((s) => s.sample === punkt)?.date ?? null;

  const timeAxisIsDates = env ? env.time_axis === "dates" : true;

  const chosen = useMemo(() => new Set(curves.map((c) => c.key)), [curves]);

  const ganz = useDatasetSearch(datasetId, search, 8);

  type Kandidat = { key: string; kind: Kind; id: string; label: string; sub: string | null;
                    outside?: boolean; share?: number };
  const candidates = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) {
      if (!searchFocus) return [] as Kandidat[];
      return asvListe.filter((a) => !chosen.has(`asv:${a.id}`)).slice(0, 10).map((a): Kandidat => ({
        key: `asv:${a.id}`, kind: "asv", id: a.id, label: a.id,
        sub: a.label !== "unassigned" ? a.label : null, share: a.share }));
    }
    const treffer: Kandidat[] = [];
    for (const v of env?.variables ?? []) {
      if (v.label.toLowerCase().includes(q) || v.key.toLowerCase().includes(q)) {
        treffer.push({ key: `env:${v.key}`, kind: "env", id: v.key, label: v.label,
                       sub: v.unit });
      }
    }
    for (const m of modules) {
      const name = m.display || `module ${m.louvain_label}`;
      if (name.toLowerCase().includes(q) || String(m.louvain_label) === q
          || `module ${m.louvain_label}`.includes(q)) {
        treffer.push({ key: `cluster:${m.louvain_label}`, kind: "cluster",
                       id: String(m.louvain_label), label: name, sub: "collective curve" });
      }
    }
    const r = ganz.result;
    for (const a of [...(r?.in_network.asvs ?? []), ...(r?.outside_network.asvs ?? [])]
           .sort((x, y) => y.share - x.share)) {
      treffer.push({ key: `asv:${a.id}`, kind: "asv", id: a.id, label: a.id,
                     sub: a.genus ?? (a.label !== "unassigned" ? a.label : null),
                     outside: a.cluster == null, share: a.share });
    }
    return treffer.filter((t) => !chosen.has(t.key)).slice(0, 8);
  }, [ganz.result, env, modules, search, chosen, searchFocus, asvListe]);

  const add = (kind: Kind, id: string) => {
    const key = `${kind}:${id}`;
    if (curves.length >= MAX_CURVES || chosen.has(key)) return;
    setSearch(""); setErr(null);
    const anfuegen = (c: Curve) =>
      setCurves((cur) => cur.some((x) => x.key === c.key) ? cur : [...cur, c]);

    if (kind === "asv") {
      getAsv(datasetId, id).then((d) => anfuegen({
        key, kind, id, label: id, sub: d.lineage?.genus ?? null, unit: null,
        partners: partnerVon(d.neighbors),
        points: ausPunkten(d.frequency.points.map((p) => ({ date: p.date, value: p.share }))),
      })).catch((e) => setErr(e));
    } else if (kind === "cluster") {
      getCluster(datasetId, Number(id)).then((d) => anfuegen({
        key, kind, id, label: modules.find((m) => String(m.louvain_label) === id)?.display
                              ?? `module ${id}`,
        sub: "collective curve", unit: null,
        points: ausPunkten(d.frequency.points.map((p) => ({ date: p.date, value: p.share }))),
      })).catch((e) => setErr(e));
    } else {
      const v = env?.variables.find((x) => x.key === id);
      if (!v) return;
      anfuegen({ key, kind, id, label: v.label, sub: v.unit, unit: v.unit ?? "", points: ausPunkten(v.points) });
    }
  };

  const seeded = useRef<string | null>(null);
  useEffect(() => {
    if (!initialAsvId) return;
    const key = `${datasetId}|${initialAsvId}`;
    if (seeded.current === key) return;
    seeded.current = key;
    add("asv", initialAsvId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datasetId, initialAsvId]);

  useEffect(() => {
    if (!mark) return;
    add(mark.kind, mark.id);
    setMarkiert(`${mark.kind}:${mark.id}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mark?.kind, mark?.id, sampleTick]);

  // Every pair of ASV curves that is linked in the network gets its link values.
  const paare = useMemo(() => {
    const asvs = curves.filter((c) => c.kind === "asv");
    const out: { a: string; b: string; type: "con" | "ccm" }[] = [];
    asvs.forEach((c, i) => asvs.slice(i + 1).forEach((d) => {
      const p = c.partners?.find((x) => x.id === d.id);
      if (p) out.push({ a: c.id, b: d.id, type: p.con ? "con" : "ccm" });
    }));
    return out;
  }, [curves]);
  const paarKey = paare.map((x) => `${x.a}|${x.b}`).join(",");
  const [links, setLinks] = useState<Record<string, EdgeDetail>>({});
  useEffect(() => {
    let live = true;
    for (const x of paare) {
      const k = `${x.a}|${x.b}`;
      if (links[k]) continue;
      getEdge(datasetId, x.a, x.b, x.type)
        .then((d) => { if (live) setLinks((cur) => ({ ...cur, [k]: d })); }).catch(() => {});
    }
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datasetId, paarKey]);
  const [zeigRhythmus, setZeigRhythmus] = useState(true);
  const fc = Object.values(links)[0]?.pattern?.fft_coeffs ?? 14;
  const imRhythmus = useMemo(() => new Set(paare.filter((x) => x.type === "con")
    .flatMap((x) => [x.a, x.b])), [paare]);

  useEffect(() => {
    if (!link) return;
    setTab("time");
    Promise.all([link.source, link.target].map((id) => getAsv(datasetId, id).then((d): Curve => ({
      key: `asv:${id}`, kind: "asv", id, label: id, sub: d.lineage?.genus ?? null, unit: null,
      partners: partnerVon(d.neighbors), points: ausPunkten(d.frequency.points.map((p) => ({ date: p.date, value: p.share }))),
    })))).then((zwei) => setCurves((cur) => [...cur.filter((c) => c.kind !== "asv"), ...zwei]))
      .catch((e) => setErr(e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [link?.source, link?.target, link?.type, sampleTick]);

  const jahre = useMemo(() => {
    const j = new Set<string>();
    for (const c of curves) for (const p of c.points) j.add(p.date.slice(0, 4));
    return [...j].sort();
  }, [curves]);
  useEffect(() => {
    if (zeitraum !== "total" && zeitraum !== "custom" && !jahre.includes(zeitraum)) setZeitraum("total");
  }, [jahre, zeitraum]);

  const tok = useTokens();

  const datiert = useMemo(() => samples
    .map((s) => ({ sample: s.sample, date: s.date ?? "", t: s.date ? Date.parse(s.date) : NaN }))
    .filter((s) => Number.isFinite(s.t)).sort((a, b) => a.t - b.t), [samples]);

  const fenster = useMemo(() => {
    if (zeitraum === "custom" && datiert.length) {
      const a = datiert.find((s) => s.sample === von) ?? datiert[0];
      const b = datiert.find((s) => s.sample === bis) ?? datiert[datiert.length - 1];
      return [Math.min(a.t, b.t), Math.max(a.t, b.t)] as const;
    }
    if (zeitraum !== "total") {
      return [Date.parse(`${zeitraum}-01-01T00:00:00Z`),
              Date.parse(`${zeitraum}-12-31T23:59:59Z`)] as const;
    }
    const ts = curves.flatMap((c) => c.points.map((p) => p.t));
    return ts.length ? [Math.min(...ts), Math.max(...ts)] as const : [0, 1] as const;
  }, [curves, zeitraum, datiert, von, bis]);

  const zeitpunkte = useMemo(() => datiert.filter((s) => s.t >= fenster[0] && s.t <= fenster[1]),
    [datiert, fenster]);

  // Long spans get one bracket per year, dense ones one per month, drawn under the x axis.
  const klammern = useMemo(() => {
    const proMonat = new Map<string, number>();
    for (const z of zeitpunkte) proMonat.set(z.date.slice(0, 7), (proMonat.get(z.date.slice(0, 7)) ?? 0) + 1);
    const art = fenster[1] - fenster[0] > 400 * 86400000 ? 4
      : Math.max(0, ...proMonat.values()) >= 4 ? 7 : 0;
    if (!art) return [];
    const gruppen = new Map<string, { von: number; bis: number }>();
    for (const z of zeitpunkte) {
      const k = z.date.slice(0, art);
      const g = gruppen.get(k);
      gruppen.set(k, g ? { von: g.von, bis: z.t } : { von: z.t, bis: z.t });
    }
    return [...gruppen].map(([k, g]) => ({ ...g,
      label: art === 4 ? k : `${MONATE[Number(k.slice(5, 7)) - 1]} ${k.slice(0, 4)}` }));
  }, [zeitpunkte, fenster]);

  const option = useMemo(() => {
    const drin = curves.map((c) => c.points.filter((p) => p.t >= fenster[0] && p.t <= fenster[1]));
    const anteile = drin.filter((_, i) => curves[i].unit == null).flat()
      .map((p) => p.value).filter((v): v is number => v != null);
    const max = anteile.length ? Math.max(...anteile) : 0;
    const genormt = curves.some((c) => c.kind === "env");
    const spitze = drin.map((pts) => Math.max(0, ...pts.map((p) => p.value ?? 0)));
    const punktT = punktDatum ? Date.parse(punktDatum) : NaN;
    const datum = (t: number) => new Date(t).toISOString().slice(0, 10);
    const achse = { color: tok.textMuted, fontSize: FONT.xs2 };
    return {
      backgroundColor: "transparent",
      grid: [{ left: 56, right: 14, top: 14, bottom: klammern.length ? 52 : 30 },
             { left: 56, right: 14, bottom: 4, height: 20 }],
      tooltip: {
        ...chartTooltip(tok),
        trigger: "item" as const,
        formatter: (p: { seriesIndex: number; dataIndex: number; marker: string; data: [number, number | null] }) => {
          const c = curves[p.seriesIndex];
          const echt = drin[p.seriesIndex]?.[p.dataIndex]?.value;
          if (!c || echt == null) return "";
          const v = c.unit == null ? prozent(echt, echt)
            : `${Number(echt.toFixed(3))}${c.unit ? ` ${c.unit}` : ""}`;
          return `<b>${esc(datum(p.data[0]))}</b><br/>${p.marker}${esc(c.label)}: ${esc(v)}`;
        },
      },
      xAxis: [{ type: "time" as const, min: fenster[0], max: fenster[1], axisLabel: achse,
               axisPointer: { show: true, snap: true, type: "line" as const,
                              lineStyle: { color: tok.textMuted, type: "dashed" as const },
                              label: { show: true, formatter: (x: { value: number }) => datum(x.value),
                                       backgroundColor: tok.overlay, color: tok.text,
                                       borderColor: tok.border, borderWidth: 1 } } },
              { type: "time" as const, gridIndex: 1, min: fenster[0], max: fenster[1], show: false }],
      yAxis: [{
        type: "value" as const, min: 0, max: genormt ? 1 : "dataMax",
        axisLabel: { ...achse, formatter: (v: number) => (genormt ? `${Math.round(100 * v)} %` : prozent(v, max)) },
        splitLine: { lineStyle: { color: tok.chartGrid } },
      }, { type: "value" as const, gridIndex: 1, min: 0, max: 1, show: false }],
      series: [
        ...curves.map((c, i) => {
          const farbe = seriesColour(i, tok.light);
          return {
            name: c.label, type: "line" as const, showSymbol: true, symbolSize: 5,
            data: drin[i].map((p) => [p.t, p.value == null ? null
              : genormt ? (spitze[i] > 0 ? p.value / spitze[i] : 0) : p.value]),
            lineStyle: { color: farbe, width: 1.8, type: c.kind === "env" ? "dashed" as const : "solid" as const },
            itemStyle: { color: farbe },
            ...(i === 0 && Number.isFinite(punktT) ? {
              markLine: { symbol: "none", silent: true, label: { show: false },
                          lineStyle: { color: tok.textMuted, type: "dotted" as const },
                          data: [{ xAxis: punktT }] },
            } : {}),
          };
        }),
        ...(zeigRhythmus ? curves.map((c, i) => {
          if (c.kind !== "asv" || !imRhythmus.has(c.id)) return null;
          const voll = c.points.filter((p) => p.value != null);
          const rh = rhythmus(voll.map((p) => p.value as number), fc);
          const farbe = seriesColour(i, tok.light);
          return {
            name: `${c.label} rhythm`, type: "line" as const, showSymbol: false, silent: true,
            tooltip: { show: false }, z: 1,
            data: voll.map((p, k) => [p.t, genormt ? (spitze[i] > 0 ? rh[k] / spitze[i] : 0) : Math.max(0, rh[k])])
              .filter(([t]) => t >= fenster[0] && t <= fenster[1]),
            lineStyle: { color: farbe, width: 2, type: "dotted" as const, opacity: 0.9 },
          };
        }).filter((x): x is NonNullable<typeof x> => x != null) : []),
        { name: DOTS, type: "scatter" as const, data: zeitpunkte.map((z) => [z.t, 0]),
          symbolSize: 4, itemStyle: { color: tok.textMuted }, silent: true,
          tooltip: { show: false }, clip: false },
        { name: "brackets", type: "line" as const, xAxisIndex: 1, yAxisIndex: 1, silent: true,
          symbol: "none", connectNulls: false, tooltip: { show: false },
          lineStyle: { color: tok.textMuted, width: 1 },
          data: klammern.flatMap((k) => [[k.von, 1], [k.von, 0.75], [k.bis, 0.75], [k.bis, 1], [k.bis, null]]) },
        { name: "bracket labels", type: "scatter" as const, xAxisIndex: 1, yAxisIndex: 1, silent: true,
          symbolSize: 0, tooltip: { show: false },
          label: { show: true, position: "bottom" as const, distance: 0, color: tok.textMuted, fontSize: FONT.xs2,
                   formatter: (x: { dataIndex: number }) => klammern[x.dataIndex]?.label ?? "" },
          data: klammern.map((k) => [(k.von + k.bis) / 2, 0.75]) },
      ],
    };
  }, [curves, fenster, zeitpunkte, klammern, punktDatum, tok, zeigRhythmus, imRhythmus, fc]);

  const klickBereit = useNearestPointClick(zeitpunkte.map((z) => z.t),
    (i) => { const z = zeitpunkte[i]; if (z) zeige(z.sample); });

  return (
    <div data-testid="compare-panel">
      <PanelHeader title="Inspect" onClose={onClose} closeTestid="compare-close">
          <InfoTip title="What Inspect shows">
            <p><em>Over time</em> lays the measured series of ASVs and modules over each other,
            as share of all reads of a sample, and measured environmental variables. <em>Time point</em> shows one sample: which modules
            and ASVs made up how much of it, and the environmental values measured with it.
            As soon as an environmental variable is shown, every curve is drawn relative to its
            own maximum (100 %); hovering a point shows the measured value.
            Click a point on a curve to open its time point.</p>
          </InfoTip>
      </PanelHeader>

      <div className="p-4 text-xs text-fg space-y-3">
        <Segmented full value={tab} onChange={setTab} testid="inspect-tabs"
          options={[{ value: "time", label: "Over time", testid: "inspect-tab-time" },
                    { value: "point", label: "Time point", testid: "inspect-tab-point" }]} />

        {tab === "point" ? (
          <InspectTimePoint datasetId={datasetId} samples={samples} sample={punkt}
            onSample={setPunkt} env={env} onOpenAsv={onOpenAsv}
            chosen={chosen} marked={markiert} full={curves.length >= MAX_CURVES}
            onAdd={(kind, id) => add(kind, id)} />
        ) : <>
        {err != null && <ErrorNotice error={err} inline what="Could not add this curve." />}
        {paare.some((x) => links[`${x.a}|${x.b}`]) && (
          <LinkBox rows={paare.flatMap((x) => links[`${x.a}|${x.b}`] ? [links[`${x.a}|${x.b}`]] : [])}
            rhythm={paare.some((x) => x.type === "con") ? zeigRhythmus : undefined}
            onRhythm={setZeigRhythmus}
            onDetails={(d) => onOpenEdge?.({ source: d.source.id, target: d.target.id, type: d.type })} />
        )}

        {!timeAxisIsDates ? (
          <p className="text-fg-muted" data-testid="compare-no-dates">
            This dataset has no calendar dates — the samples are ordered, not dated. A common
            time axis would place them on days nobody measured, so there is nothing to lay
            side by side here.
          </p>
        ) : (
          <>
            <div>
              <input data-testid="compare-search" value={search}
                onChange={(e) => setSearch(e.target.value)}
                onFocus={() => setSearchFocus(true)}
                onBlur={() => setTimeout(() => setSearchFocus(false), 150)}
                placeholder={curves.length >= MAX_CURVES
                  ? `at most ${MAX_CURVES} curves`
                  : "add an ASV, a module or an environmental variable …"}
                disabled={curves.length >= MAX_CURVES}
                className="w-full px-2 py-1 rounded bg-control border border-line-strong text-fg" />
              {candidates.length > 0 && (
                <ul className="mt-1 rounded border border-line bg-surface/70">
                  {candidates.map((t) => (
                    <li key={t.key}>
                      <button data-testid="compare-candidate" data-kind={t.kind}
                        onClick={() => add(t.kind, t.id)}
                        className="w-full text-left px-2 py-1 hover:bg-control flex items-baseline gap-1">
                        <span className={`text-2xs uppercase tracking-wide ${
                          t.kind === "env" ? "text-ok"
                          : t.kind === "cluster" ? "text-accent" : "text-fg-muted"}`}>
                          {t.kind === "env" ? "env" : t.kind === "cluster" ? "module" : "asv"}
                        </span>
                        <span className={t.kind === "asv" ? "font-mono text-accent" : "text-fg"}>
                          {t.label}
                        </span>
                        {t.sub && <span className="text-fg-muted">({t.sub})</span>}
                        {t.outside && (
                          <span className="text-fg-muted" data-testid="compare-candidate-outside">
                            · no link in the network
                          </span>
                        )}
                        {t.share != null && (
                          <span className="ml-auto text-fg font-semibold tabular-nums">{fmtShare(t.share)}</span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {candidates.length === 0 && search.trim() && (ganz.loading ? (
                <p className="mt-1 text-fg-muted" data-testid="compare-searching">
                  searching the whole dataset …
                </p>
              ) : ganz.error != null ? (
                <ErrorNotice error={ganz.error} inline testid="compare-search-error"
                  what="The search over the whole dataset failed." />
              ) : ganz.result?.sentence ? (
                <p className="mt-1 text-fg-muted" data-testid="compare-none">{ganz.result.sentence}</p>
              ) : null)}
            </div>

            <div className="grid grid-cols-3 gap-1" data-testid="compare-pickers">
              {([
                ["cluster", "module", modules.map((m) => [String(m.louvain_label),
                  m.display || `module ${m.louvain_label}`])],
                ["env", "environment", (env?.variables ?? []).map((v) => [v.key, v.label])],
                ["asv", "ASV", asvListe.map((a) => [a.id,
                  `${a.id}${a.label !== "unassigned" ? ` · ${a.label}` : ""} · ${fmtShare(a.share)}`])],
              ] as [Kind, string, [string, string][]][]).map(([kind, name, eintraege]) => (
                <select key={kind} data-testid={`compare-pick-${kind}`} value=""
                  aria-label={`add ${name}`}
                  disabled={curves.length >= MAX_CURVES || eintraege.length === 0}
                  onChange={(e) => e.target.value && add(kind, e.target.value)}
                  className="min-w-0 px-1 py-1 rounded bg-control border border-line-strong text-fg">
                  <option value="">+ {name} …</option>
                  {eintraege.filter(([id]) => !chosen.has(`${kind}:${id}`)).map(([id, text]) => (
                    <option key={id} value={id}>{text}</option>
                  ))}
                </select>
              ))}
            </div>

            {(() => {
              const partner = new Map<string, { von: string; p: Partner }>();
              for (const c of curves) for (const p of c.partners ?? []) {
                if (!chosen.has(`asv:${p.id}`) && !partner.has(p.id)) partner.set(p.id, { von: c.id, p });
              }
              return partner.size > 0 && (
                <select data-testid="compare-pick-linked" value="" aria-label="add linked ASV"
                  disabled={curves.length >= MAX_CURVES}
                  onChange={(e) => e.target.value && add("asv", e.target.value)}
                  className="w-full px-1 py-1 rounded bg-control border border-line-strong text-fg">
                  <option value="">+ linked ASV …</option>
                  {[...partner.values()].map(({ von, p }) => (
                    <option key={p.id} value={p.id}>
                      {p.id} · linked to {von}{p.corr != null ? ` · r ${p.corr.toFixed(2)}` : ""}
                      {p.nmi != null ? ` · NMI ${p.nmi.toFixed(2)}` : ""}
                    </option>
                  ))}
                </select>
              );
            })()}

            {curves.length > 0 && (
              <div className="flex flex-wrap gap-2" data-testid="compare-legend">
                {curves.map((s, i) => (
                  <span key={s.key} data-testid="compare-curve" data-kind={s.kind}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded border border-line">
                    <svg width="14" height="6" className="shrink-0">
                      <line x1="0" y1="3" x2="14" y2="3" stroke={seriesColour(i, tok.light)}
                        strokeWidth="1.5" strokeDasharray={s.kind === "env" ? "3 2" : undefined} />
                    </svg>
                    {s.kind === "asv" ? (
                      <button onClick={() => onOpenAsv(s.id)}
                        className="font-mono text-accent hover:underline">{s.label}</button>
                    ) : (
                      <span className="text-fg">{s.label}</span>
                    )}
                    {s.sub && <span className="text-fg-muted">({s.sub})</span>}
                    <button aria-label={`remove ${s.label}`} data-testid="compare-remove"
                      onClick={() => setCurves((cur) => cur.filter((c) => c.key !== s.key))}
                      className="text-fg-muted hover:text-fg">✕</button>
                  </span>
                ))}
              </div>
            )}

            {curves.length === 0 && (
              <p className="text-fg-muted">
                Add two or more curves to lay their measured series over each other.
              </p>
            )}

            {curves.length > 0 && (
              <>
                <div className="flex flex-wrap items-center gap-2" data-testid="compare-controls">
                  {onToNetwork && curves.some((c) => c.kind !== "env") && (
                    <Button data-testid="compare-to-network" className="order-last ml-auto"
                      onClick={() => onToNetwork(
                        curves.filter((c) => c.kind === "cluster").map((c) => Number(c.id)),
                        curves.filter((c) => c.kind === "asv").map((c) => c.id))}>
                      filter network</Button>
                  )}
                  <Chooser label="period"
                    summary={zeitraum === "total" ? "total" : zeitraum === "custom" ? "from … to" : zeitraum}
                    closeOnPick testid="compare-period">
                    <ChooserRow radio checked={zeitraum === "total"} testid="compare-period-total"
                      onToggle={() => setZeitraum("total")} label="total"
                      hint="every sample, on its real date" />
                    {jahre.map((j) => (
                      <ChooserRow key={j} radio checked={zeitraum === j}
                        testid={`compare-period-${j}`} onToggle={() => setZeitraum(j)}
                        label={j} hint="the samples of this calendar year" />
                    ))}
                    <ChooserRow radio checked={zeitraum === "custom"} testid="compare-period-custom"
                      onToggle={() => setZeitraum("custom")} label="from … to"
                      hint="from one time point to another" />
                  </Chooser>
                  {zeitraum === "custom" && ([["from", von ?? datiert[0]?.sample, setVon],
                      ["to", bis ?? datiert[datiert.length - 1]?.sample, setBis]] as
                      [string, string | undefined, (v: string) => void][]).map(([name, wert, setze]) => (
                    <select key={name} data-testid={`compare-period-${name}`} aria-label={name}
                      value={wert ?? ""} onChange={(e) => setze(e.target.value)}
                      className="px-2 py-1 rounded bg-control border border-line-strong text-fg tabular-nums">
                      {datiert.map((d) => <option key={d.sample} value={d.sample}>{d.date}</option>)}
                    </select>
                  ))}
                </div>

                <div data-testid="compare-chart" data-period={zeitraum}>
                  <ReactECharts option={option} style={{ height: 222 }} notMerge
                    onChartReady={klickBereit} className="cursor-pointer" />
                </div>
              </>
            )}
          </>
        )}
        </>}
        <ProvenanceFooter datasetId={datasetId} />
      </div>
    </div>
  );
}

// Draft: every link between the ASV curves shown, with its values.
function LinkBox({ rows, onDetails, rhythm, onRhythm }: {
  rows: EdgeDetail[]; onDetails: (d: EdgeDetail) => void; rhythm?: boolean; onRhythm: (v: boolean) => void;
}) {
  const nmi = (x: { nmi: number; decision?: string } | null | undefined) => x
    ? <span className={x.decision === "rejected" ? "text-warn" : ""}>{x.nmi.toFixed(2)}
        {x.decision === "rejected" ? " rejected" : ""}</span>
    : <span className="text-fg-muted">—</span>;
  return (
    <div className="rounded-md border border-line bg-raised px-3 py-2" data-testid="inspect-link">
      <table className="w-full tabular-nums">
        <thead><tr className="text-fg-muted text-left">
          <th className="font-normal">Link</th><th className="font-normal">r</th>
          <th className="font-normal">NMI →</th><th className="font-normal">NMI ←</th>
          <th className="font-normal">together</th><th /></tr></thead>
        <tbody>
          {rows.map((d) => (
            <tr key={`${d.source.id}|${d.target.id}`} className="border-t border-line">
              <td className="py-1 font-mono">
                <span className="text-accent">{d.source.id}</span> → <span className="text-accent">{d.target.id}</span>
              </td>
              <td className="text-sm">{d.edge.corr != null ? d.edge.corr.toFixed(2) : "—"}</td>
              <td>{nmi(d.directions?.forward)}</td>
              <td>{nmi(d.directions?.backward)}</td>
              <td className="text-fg-muted">{d.co_detected_in} of {d.n_samples}</td>
              <td className="text-right">
                <button onClick={() => onDetails(d)} className="text-accent hover:underline">details</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rhythm != null && (
        <label className="mt-1 flex items-center gap-1 text-fg-muted cursor-pointer">
          <input type="checkbox" checked={rhythm} onChange={(e) => onRhythm(e.target.checked)} />
          shared rhythm (dotted)
        </label>
      )}
    </div>
  );
}

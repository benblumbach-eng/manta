import { useEffect, useMemo, useRef, useState } from "react";
import ReactECharts from "echarts-for-react";
import { getAsv, getAsvList, getCluster, getEnvironment, getModules, getSamples,
         type Environment, type ModuleLabel, type SampleList } from "../api";
import { Chooser, ChooserRow, Segmented } from "./controls";
import InfoTip from "./InfoTip";
import { PanelHeader } from "./PanelFrame";
import ProvenanceFooter from "./ProvenanceFooter";
import ErrorNotice from "./ErrorNotice";
import InspectTimePoint from "./InspectTimePoint";
import { useDatasetSearch } from "../datasetSearch";
import { chartTooltip, FONT, useTokens } from "../design/tokens";
import { seriesColour } from "../design/dataColours";
import { esc } from "../format";
import { useNearestPointClick } from "../chartClick";


const MAX_CURVES = 6;
const DOTS = "time points";

type Kind = "asv" | "cluster";
export type InspectMark = { kind: Kind; id: string };
type Punkt = { t: number; date: string; value: number | null };
type Curve = {
  key: string; kind: Kind; id: string; label: string; sub: string | null;
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

export default function ComparePanel({ datasetId, initialAsvId, initialSample, mark, sampleTick,
                                       onClose, onOpenAsv }: {
  datasetId: string;
  initialAsvId?: string;
  initialSample?: string;
  mark?: InspectMark;
  sampleTick?: number;
  onClose: () => void;
  onOpenAsv: (id: string) => void;
}) {
  const [env, setEnv] = useState<Environment | null>(null);
  const [modules, setModules] = useState<ModuleLabel[]>([]);
  const [curves, setCurves] = useState<Curve[]>([]);
  const [search, setSearch] = useState("");
  const [err, setErr] = useState<unknown>(null);
  const [zeitraum, setZeitraum] = useState<string>("total");
  const [tab, setTab] = useState<Tab>("time");
  const [samples, setSamples] = useState<SampleList["samples"]>([]);
  const [punkt, setPunkt] = useState<string | null>(null);
  const [markiert, setMarkiert] = useState<string | null>(null);

  useEffect(() => {
    setCurves([]); setErr(null); setEnv(null); setModules([]); setSamples([]); setPunkt(null);
    setMarkiert(null);
    getEnvironment(datasetId).then(setEnv).catch(() => setEnv(null));
    getModules(datasetId).then((m) => setModules(m.modules)).catch(() => setModules([]));
    getSamples(datasetId).then((r) => {
      setSamples(r.samples);
      setPunkt((p) => p ?? r.samples[0]?.sample ?? null);
    }).catch(() => setSamples([]));
  }, [datasetId]);
  const [asvListe, setAsvListe] = useState<{ id: string; label: string }[]>([]);
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
                    outside?: boolean };
  const candidates = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [] as Kandidat[];
    const treffer: Kandidat[] = [];
    for (const m of modules) {
      const name = m.display || `module ${m.louvain_label}`;
      if (name.toLowerCase().includes(q) || String(m.louvain_label) === q
          || `module ${m.louvain_label}`.includes(q)) {
        treffer.push({ key: `cluster:${m.louvain_label}`, kind: "cluster",
                       id: String(m.louvain_label), label: name, sub: "collective curve" });
      }
    }
    const r = ganz.result;
    for (const a of [...(r?.in_network.asvs ?? []), ...(r?.outside_network.asvs ?? [])]) {
      treffer.push({ key: `asv:${a.id}`, kind: "asv", id: a.id, label: a.id,
                     sub: a.genus ?? (a.label !== "unassigned" ? a.label : null),
                     outside: a.cluster == null });
    }
    return treffer.filter((t) => !chosen.has(t.key)).slice(0, 8);
  }, [ganz.result, modules, search, chosen]);

  const add = (kind: Kind, id: string) => {
    const key = `${kind}:${id}`;
    if (curves.length >= MAX_CURVES || chosen.has(key)) return;
    setSearch(""); setErr(null);
    const anfuegen = (c: Curve) =>
      setCurves((cur) => cur.some((x) => x.key === c.key) ? cur : [...cur, c]);

    if (kind === "asv") {
      getAsv(datasetId, id).then((d) => anfuegen({
        key, kind, id, label: id, sub: d.lineage?.genus ?? null,
        points: ausPunkten(d.frequency.points.map((p) => ({ date: p.date, value: p.share }))),
      })).catch((e) => setErr(e));
    } else if (kind === "cluster") {
      getCluster(datasetId, Number(id)).then((d) => anfuegen({
        key, kind, id, label: modules.find((m) => String(m.louvain_label) === id)?.display
                              ?? `module ${id}`,
        sub: "collective curve",
        points: ausPunkten(d.frequency.points.map((p) => ({ date: p.date, value: p.share }))),
      })).catch((e) => setErr(e));
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

  const jahre = useMemo(() => {
    const j = new Set<string>();
    for (const c of curves) for (const p of c.points) j.add(p.date.slice(0, 4));
    return [...j].sort();
  }, [curves]);
  useEffect(() => {
    if (zeitraum !== "total" && !jahre.includes(zeitraum)) setZeitraum("total");
  }, [jahre, zeitraum]);

  const tok = useTokens();

  const fenster = useMemo(() => {
    if (zeitraum !== "total") {
      return [Date.parse(`${zeitraum}-01-01T00:00:00Z`),
              Date.parse(`${zeitraum}-12-31T23:59:59Z`)] as const;
    }
    const ts = curves.flatMap((c) => c.points.map((p) => p.t));
    return ts.length ? [Math.min(...ts), Math.max(...ts)] as const : [0, 1] as const;
  }, [curves, zeitraum]);

  const zeitpunkte = useMemo(() => samples
    .map((s) => ({ sample: s.sample, t: s.date ? Date.parse(s.date) : NaN }))
    .filter((s) => Number.isFinite(s.t) && s.t >= fenster[0] && s.t <= fenster[1]),
  [samples, fenster]);

  const option = useMemo(() => {
    const drin = curves.map((c) => c.points.filter((p) => p.t >= fenster[0] && p.t <= fenster[1]));
    const werte = drin.flat().map((p) => p.value).filter((v): v is number => v != null);
    const max = werte.length ? Math.max(...werte) : 0;
    const punktT = punktDatum ? Date.parse(punktDatum) : NaN;
    return {
      backgroundColor: "transparent",
      grid: { left: 56, right: 14, top: 14, bottom: 30 },
      tooltip: {
        ...chartTooltip(tok),
        trigger: "axis" as const,
        formatter: (ps: { seriesName: string; marker: string; data: [number, number | null] }[]) => {
          const linien = ps.filter((x) => x.seriesName !== DOTS);
          const t = (linien[0] ?? ps[0])?.data[0];
          if (t == null) return "";
          const zeilen = linien.filter((x) => x.data[1] != null)
            .map((x) => `${x.marker}${esc(x.seriesName)}: ${prozent(x.data[1]!, x.data[1]!)}`);
          return `<b>${esc(new Date(t).toISOString().slice(0, 10))}</b>`
            + (zeilen.length ? `<br/>${zeilen.join("<br/>")}` : "");
        },
      },
      xAxis: { type: "time" as const, min: fenster[0], max: fenster[1],
               axisLabel: { color: tok.textMuted, fontSize: FONT.xs2 } },
      yAxis: {
        type: "value" as const, min: 0, max: "dataMax",
        axisLabel: { color: tok.textMuted, fontSize: FONT.xs2, formatter: (v: number) => prozent(v, max) },
        splitLine: { lineStyle: { color: tok.chartGrid } },
      },
      series: [
        ...curves.map((c, i) => {
          const farbe = seriesColour(i, tok.light);
          return {
            name: c.label, type: "line" as const, showSymbol: true, symbolSize: 4,
            data: drin[i].map((p) => [p.t, p.value]),
            lineStyle: { color: farbe, width: 1.8 }, itemStyle: { color: farbe },
            ...(i === 0 && Number.isFinite(punktT) ? {
              markLine: { symbol: "none", silent: true, label: { show: false },
                          lineStyle: { color: tok.textMuted, type: "dashed" as const },
                          data: [{ xAxis: punktT }] },
            } : {}),
          };
        }),
        { name: DOTS, type: "scatter" as const, data: zeitpunkte.map((z) => [z.t, 0]),
          symbolSize: 4, itemStyle: { color: tok.textMuted }, silent: true,
          tooltip: { show: false }, clip: false },
      ],
    };
  }, [curves, fenster, zeitpunkte, punktDatum, tok]);

  const klickBereit = useNearestPointClick(zeitpunkte.map((z) => z.t),
    (i) => { const z = zeitpunkte[i]; if (z) zeige(z.sample); });

  return (
    <div data-testid="compare-panel">
      <PanelHeader title="Inspect" onClose={onClose} closeTestid="compare-close">
          <InfoTip title="What Inspect shows">
            <p><em>Over time</em> lays the measured series of ASVs and modules over each other,
            as share of all reads of a sample. <em>Time point</em> shows one sample: which modules
            and ASVs made up how much of it, and the environmental values measured with it.
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
                placeholder={curves.length >= MAX_CURVES
                  ? `at most ${MAX_CURVES} curves`
                  : "add an ASV or a module …"}
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
                          t.kind === "cluster" ? "text-accent" : "text-fg-muted"}`}>
                          {t.kind === "cluster" ? "module" : "asv"}
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

            <div className="grid grid-cols-2 gap-1" data-testid="compare-pickers">
              {([
                ["cluster", "module", modules.map((m) => [String(m.louvain_label),
                  m.display || `module ${m.louvain_label}`])],
                ["asv", "ASV", asvListe.map((a) => [a.id,
                  a.label !== "unassigned" ? `${a.id} · ${a.label}` : a.id])],
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

            {curves.length > 0 && (
              <div className="flex flex-wrap gap-2" data-testid="compare-legend">
                {curves.map((s, i) => (
                  <span key={s.key} data-testid="compare-curve" data-kind={s.kind}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded border border-line">
                    <svg width="14" height="6" className="shrink-0">
                      <line x1="0" y1="3" x2="14" y2="3" stroke={seriesColour(i, tok.light)}
                        strokeWidth="1.5" />
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
                  <Chooser label="period" summary={zeitraum === "total" ? "total" : zeitraum}
                    closeOnPick testid="compare-period">
                    <ChooserRow radio checked={zeitraum === "total"} testid="compare-period-total"
                      onToggle={() => setZeitraum("total")} label="total"
                      hint="every sample, on its real date" />
                    {jahre.map((j) => (
                      <ChooserRow key={j} radio checked={zeitraum === j}
                        testid={`compare-period-${j}`} onToggle={() => setZeitraum(j)}
                        label={j} hint="the samples of this calendar year" />
                    ))}
                  </Chooser>
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

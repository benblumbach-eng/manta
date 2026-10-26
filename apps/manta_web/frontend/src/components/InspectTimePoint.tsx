import { useEffect, useMemo, useState } from "react";
import { getSample, type Environment, type SampleDetail, type SampleList } from "../api";
import { useModules } from "../modules";
import ErrorNotice from "./ErrorNotice";
import { Button } from "./ui";

const MIN_SHARES = [0, 0.001, 0.01] as const;
const PAGE = 50;

const pct = (v: number | null) => (v == null ? "—" : `${(100 * v).toFixed(v < 0.001 ? 3 : 2)} %`);

export default function InspectTimePoint({ datasetId, samples, sample, onSample, env, onOpenAsv,
                                           chosen, marked, full, colours, onAdd }: {
  datasetId: string;
  samples: SampleList["samples"];
  sample: string | null;
  onSample: (s: string) => void;
  env: Environment | null;
  onOpenAsv: (id: string) => void;
  chosen: Set<string>;
  marked: string | null;
  full: boolean;
  colours: Map<string, string>;
  onAdd: (kind: "asv" | "cluster", id: string) => void;
}) {
  const modules = useModules();
  const [data, setData] = useState<SampleDetail | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [text, setText] = useState("");
  const [modul, setModul] = useState<number | null>(null);
  const [minShare, setMinShare] = useState<number>(0);
  const [alle, setAlle] = useState(false);

  useEffect(() => {
    if (!sample) return;
    let lebt = true;
    setErr(null);
    getSample(datasetId, sample)
      .then((d) => { if (lebt) setData(d); })
      .catch((e) => { if (lebt) { setData(null); setErr(e); } });
    return () => { lebt = false; };
  }, [datasetId, sample]);
  useEffect(() => { setAlle(false); }, [sample, text, modul, minShare]);

  const i = samples.findIndex((s) => s.sample === sample);
  const name = (s: SampleList["samples"][number]) => s.date ?? s.sample;

  const envHier = useMemo(() => (env?.variables ?? []).flatMap((v) => {
    const p = v.points.find((x) => x.sample === sample);
    return p && p.value != null ? [{ key: v.key, label: v.label, unit: v.unit, value: p.value }] : [];
  }), [env, sample]);

  const gezeigt = useMemo(() => {
    const q = text.trim().toLowerCase();
    return (data?.asvs ?? []).filter((a) =>
      (modul == null || a.cluster === modul)
      && (a.share ?? 0) >= minShare
      && (!q || a.id.toLowerCase().includes(q) || a.taxa.some((t) => t.toLowerCase().includes(q))));
  }, [data, text, modul, minShare]);
  const maxShare = gezeigt.length ? Math.max(...gezeigt.map((a) => a.share ?? 0)) : 0;
  const markIndex = marked?.startsWith("asv:")
    ? gezeigt.findIndex((a) => `asv:${a.id}` === marked) : -1;
  useEffect(() => {
    if (markIndex >= PAGE) setAlle(true);
  }, [markIndex]);

  const plus = (kind: "asv" | "cluster", id: string, name: string) => {
    const drin = chosen.has(`${kind}:${id}`);
    return (
      <button data-testid={`tp-add-${kind}`} disabled={drin || full} onClick={() => onAdd(kind, id)}
        title={drin ? "already a curve in Over time" : full ? "Over time is full" : "add as a curve to Over time"}
        aria-label={`add ${name} to Over time`}
        className="w-5 rounded text-fg-muted hover:text-accent hover:bg-control disabled:text-fg-disabled disabled:hover:bg-transparent">
        {drin ? "✓" : "+"}
      </button>
    );
  };
  const markiert = (() => {
    if (!data || !marked) return null;
    const [art, id] = [marked.slice(0, marked.indexOf(":")), marked.slice(marked.indexOf(":") + 1)];
    if (art === "asv") {
      const a = data.asvs.find((x) => x.id === id);
      return { asv: true, name: id, share: a?.share ?? 0 };
    }
    const m = data.modules.find((x) => String(x.cluster) === id);
    return { asv: false, name: modules.label(Number(id)), share: m?.share ?? 0 };
  })();
  const maxMod = data?.modules.length ? Math.max(...data.modules.map((m) => m.share ?? 0)) : 0;

  return (
    <div className="space-y-3" data-testid="inspect-timepoint">
      <div className="flex items-center gap-1">
        <Button data-testid="tp-prev" disabled={i <= 0} reason="first time point"
          onClick={() => onSample(samples[i - 1].sample)} aria-label="previous time point">‹</Button>
        <select data-testid="tp-select" value={sample ?? ""} aria-label="time point"
          onChange={(e) => onSample(e.target.value)}
          className="flex-1 min-w-0 px-2 py-1 rounded bg-control border border-line-strong text-fg tabular-nums">
          {samples.map((s) => <option key={s.sample} value={s.sample}>{name(s)}</option>)}
        </select>
        <Button data-testid="tp-next" disabled={i < 0 || i >= samples.length - 1} reason="last time point"
          onClick={() => onSample(samples[i + 1].sample)} aria-label="next time point">›</Button>
        <span className="w-14 text-right text-fg-muted tabular-nums">{i + 1} / {samples.length}</span>
      </div>

      {err != null && <ErrorNotice error={err} inline what="Could not load this time point." />}

      {data && data.sample === sample && (
        <>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-md border border-line bg-raised px-3 py-2"
            data-testid="tp-facts">
            <dt className="text-fg-muted">ASVs detected</dt>
            <dd className="text-right font-semibold tabular-nums">{data.asvs.length}</dd>
            {markiert && (
              <div className="contents" data-testid="tp-marked">
                <dt className={markiert.asv ? "font-mono text-accent" : "text-fg"}>{markiert.name}</dt>
                <dd className="text-right font-semibold tabular-nums">{pct(markiert.share)}</dd>
              </div>
            )}
            {envHier.map((v) => (
              <div key={v.key} className="contents">
                <dt className="text-fg-muted">{v.label}</dt>
                <dd className="text-right tabular-nums" data-testid="tp-env">
                  {Number(v.value.toFixed(3))}{v.unit ? ` ${v.unit}` : ""}
                </dd>
              </div>
            ))}
          </dl>

          <section>
            <h4 className="mb-1 font-semibold text-fg-muted">Modules</h4>
            <ul className="space-y-1" data-testid="tp-modules">
              {data.modules.map((m) => {
                const an = modul === m.cluster;
                const mark = marked === `cluster:${m.cluster}`;
                const kurve = colours.get(`cluster:${m.cluster}`);
                return (
                  <li key={m.cluster} data-marked={mark || undefined} data-curve={kurve ? true : undefined}
                    className={`flex items-center gap-1 rounded ${mark ? "ring-1 ring-accent" : ""}`}
                    style={kurve ? { outline: `2px solid ${kurve}`, outlineOffset: "-1px" } : undefined}>
                    <button data-testid="tp-module" aria-pressed={an}
                      onClick={() => setModul(an ? null : m.cluster)}
                      className={`flex-1 min-w-0 grid grid-cols-[6rem_1fr_4.5rem] items-center gap-2 rounded px-1 py-1 text-left ${an
                        ? "bg-accent-soft" : "hover:bg-control"}`}>
                      <span className="flex items-center gap-1 truncate">
                        <span className="inline-block w-2.5 h-2.5 rounded-sm shrink-0"
                          style={{ background: modules.color(m.cluster) }} />
                        <span className="truncate">{modules.label(m.cluster)}</span>
                      </span>
                      <span className="h-2 rounded-sm bg-control">
                        <span className="block h-2 rounded-sm" style={{
                          width: `${maxMod > 0 ? (100 * (m.share ?? 0)) / maxMod : 0}%`,
                          background: modules.color(m.cluster) }} />
                      </span>
                      <span className="text-right tabular-nums">{pct(m.share)}</span>
                    </button>
                    {plus("cluster", String(m.cluster), modules.label(m.cluster))}
                  </li>
                );
              })}
            </ul>
          </section>

          <section>
            <h4 className="mb-1 font-semibold text-fg-muted">ASVs</h4>
            <div className="flex flex-wrap items-center gap-1 mb-1" data-testid="tp-filters">
              <input data-testid="tp-search" value={text} onChange={(e) => setText(e.target.value)}
                placeholder="ASV or taxon …"
                className="flex-1 min-w-[8rem] px-2 py-1 rounded bg-control border border-line-strong text-fg" />
              <select data-testid="tp-module-select" aria-label="module"
                value={modul == null ? "" : String(modul)}
                onChange={(e) => setModul(e.target.value === "" ? null : Number(e.target.value))}
                className="px-1 py-1 rounded bg-control border border-line-strong text-fg">
                <option value="">all modules</option>
                {data.modules.map((m) => (
                  <option key={m.cluster} value={m.cluster}>{modules.label(m.cluster)}</option>
                ))}
              </select>
              <select data-testid="tp-min-share" aria-label="minimum share"
                value={String(minShare)} onChange={(e) => setMinShare(Number(e.target.value))}
                className="px-1 py-1 rounded bg-control border border-line-strong text-fg">
                {MIN_SHARES.map((v) => (
                  <option key={v} value={v}>{v === 0 ? "any share" : `≥ ${100 * v} %`}</option>
                ))}
              </select>
            </div>
            <p className="mb-1 text-2xs text-fg-muted" data-testid="tp-count">
              {gezeigt.length} of {data.asvs.length} ASVs · share of this sample
            </p>
            <ul data-testid="tp-asvs">
              {(alle ? gezeigt : gezeigt.slice(0, PAGE)).map((a) => (
                <li key={a.id} data-marked={marked === `asv:${a.id}` || undefined}
                  className={`flex items-center gap-1 rounded ${marked === `asv:${a.id}` ? "ring-1 ring-accent" : ""}`}>
                  <button data-testid="tp-asv" onClick={() => onOpenAsv(a.id)}
                    className={`flex-1 min-w-0 grid grid-cols-[2rem_1fr_5rem_4.5rem] items-center gap-2 rounded px-1 py-1 text-left ${
                      marked === `asv:${a.id}` ? "bg-accent-soft" : "hover:bg-control"}`}>
                    <span className="text-fg-muted tabular-nums">{a.rank}</span>
                    <span className="truncate">
                      <span className="inline-block w-2 h-2 rounded-full mr-1 align-middle"
                        style={{ background: modules.color(a.cluster) }} />
                      <span className="font-mono text-accent">{a.id}</span>{" "}
                      {a.label !== "unassigned" && <span className="text-fg-muted">{a.label}</span>}
                    </span>
                    <span className="h-2 rounded-sm bg-control">
                      <span className="block h-2 rounded-sm bg-accent-fill" style={{
                        width: `${maxShare > 0 ? (100 * (a.share ?? 0)) / maxShare : 0}%` }} />
                    </span>
                    <span className="text-right tabular-nums">{pct(a.share)}</span>
                  </button>
                  {plus("asv", a.id, a.id)}
                </li>
              ))}
            </ul>
            {!alle && gezeigt.length > PAGE && (
              <Button variant="ghost" data-testid="tp-more" onClick={() => setAlle(true)}>
                show all {gezeigt.length}
              </Button>
            )}
          </section>
        </>
      )}
    </div>
  );
}

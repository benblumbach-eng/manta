import { Button, SectionHeading, StateNotice } from "./ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { getImportStatus, deleteDataset, moveDataset, renameDataset, HttpError, errorText,
         SharedStationError, type Dataset, type ImportStatus } from "../api";
import ImportDialog from "./ImportDialog";
import SharedStationAsk, { type StationAsk } from "./SharedStationAsk";
import ErrorBoundary from "./ErrorBoundary";
import GlobeMap, { DEPTH_RAMP_DARK, DEPTH_RAMP_LIGHT, LAND_DARK, LAND_LIGHT, type BathyMeta } from "./GlobeMap";



export default function MapView(
  { datasets, light = false, onSelect, onRefresh, canImport, orderKey }:
  { datasets: Dataset[]; light?: boolean; onSelect: (d: Dataset) => void; onRefresh: () => Promise<void>;
    canImport: boolean;
    orderKey: string },
) {
  const [mapReady, setMapReady] = useState(false);
  const [globeOff, setGlobeOff] = useState(false);
  const [bathy, setBathy] = useState<BathyMeta | null>(null);
  const [hoverIds, setHoverIds] = useState<string[]>([]);
  const [mapApi, setMapApi] = useState<{ zoomIn: () => void; zoomOut: () => void; reset: () => void } | null>(null);
  const [handles, setHandles] = useState(0);
  const [moveErr, setMoveErr] = useState<string | null>(null);
  const [stationAsk, setStationAsk] = useState<StationAsk | null>(null);
  const [imp, setImp] = useState<{ running: boolean; stage?: string; err?: string; done?: boolean }>({ running: false });
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [editVal, setEditVal] = useState("");
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [confirmTyped, setConfirmTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [mgmtErr, setMgmtErr] = useState<string | null>(null);

  const STORE = `manta-dataset-order:${orderKey}`;
  const [order, setOrder] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem(STORE) ?? "[]"); } catch { return []; }
  });
  const [dragId, setDragId] = useState<string | null>(null);

  const geordnet = useMemo(() => {
    const rang = new Map(order.map((id, i) => [id, i]));
    return [...datasets].sort((a, b) =>
      (rang.get(a.dataset_id) ?? Number.MAX_SAFE_INTEGER) - (rang.get(b.dataset_id) ?? Number.MAX_SAFE_INTEGER));
  }, [datasets, order]);

  const vorhanden = useMemo(() => new Set(datasets.map((d) => d.dataset_id)), [datasets]);
  const elternVon = (d: Dataset) =>
    d.derived?.from && vorhanden.has(d.derived.from) ? d.derived.from : null;
  const kinder = useMemo(() => {
    const m = new Map<string, Dataset[]>();
    for (const d of datasets) {
      const von = d.derived?.from;
      if (von && vorhanden.has(von)) m.set(von, [...(m.get(von) ?? []), d]);
    }
    for (const l of m.values()) l.sort((a, b) => (a.derived?.at ?? "").localeCompare(b.derived?.at ?? ""));
    return m;
  }, [datasets, vorhanden]);
  const zeilen = useMemo(() => {
    const out: { d: Dataset; tiefe: number }[] = [];
    const gesehen = new Set<string>();
    const haenge = (d: Dataset, tiefe: number) => {
      if (gesehen.has(d.dataset_id)) return;
      gesehen.add(d.dataset_id);
      out.push({ d, tiefe });
      for (const k of kinder.get(d.dataset_id) ?? []) haenge(k, tiefe + 1);
    };
    for (const d of geordnet) if (!elternVon(d)) haenge(d, 0);
    for (const d of geordnet) haenge(d, 0);
    return out;
  }, [geordnet, kinder]);
  const wurzel = (id: string): string => {
    let d = datasets.find((x) => x.dataset_id === id);
    for (let i = 0; d && elternVon(d) && i < 50; i++) {
      const e = elternVon(d)!;
      d = datasets.find((x) => x.dataset_id === e);
    }
    return d?.dataset_id ?? id;
  };

  const merken = (ids: string[]) => {
    setOrder(ids);
    try { localStorage.setItem(STORE, JSON.stringify(ids)); } catch { }
  };

  function ablegenAuf(ziel: string) {
    const zielId = wurzel(ziel);
    if (!dragId || dragId === zielId) return;
    const ids = geordnet.map((d) => d.dataset_id);
    const von = ids.indexOf(dragId), nach = ids.indexOf(zielId);
    if (von < 0 || nach < 0) return;
    ids.splice(nach, 0, ...ids.splice(von, 1));
    merken(ids);
  }

  async function saveRename(id: string) {
    const next = editVal.trim();
    if (!next) return;
    setBusy(true); setMgmtErr(null);
    try {
      await renameDataset(id, next);
      setEditId(null);
      await onRefresh();
    } catch (e) {
      setMgmtErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete(id: string) {
    setBusy(true); setMgmtErr(null);
    try {
      await deleteDataset(id);
      setConfirmId(null); setConfirmTyped("");
      await onRefresh();
    } catch (e) {
      setMgmtErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  async function poll(job_id: string) {
    let fehler = 0;
    for (;;) {
      await new Promise((r) => setTimeout(r, 1000 * (1 + fehler)));
      if (!alive.current) return;
      let st: ImportStatus;
      try {
        st = await getImportStatus(job_id);
        fehler = 0;
      } catch (e) {
        if (!alive.current) return;
        if (e instanceof HttpError && e.status === 404) {
          setImp({ running: false, err: "Import job no longer known to the server (backend restarted?) — check the dataset list." });
          return;
        }
        if (++fehler >= 5) {
          setImp({ running: false, err: `Import status not reachable (${errorText(e)}) — check the dataset list.` });
          return;
        }
        continue;
      }
      if (!alive.current) return;
      if (st.status === "done") { await onRefresh(); if (alive.current) setImp({ running: false, done: true }); return; }
      if (st.status === "error") { setImp({ running: false, err: st.error }); return; }
      setImp({ running: true, stage: st.stage });
    }
  }

  const ramp = light ? DEPTH_RAMP_LIGHT : DEPTH_RAMP_DARK;
  const landColor = light ? LAND_LIGHT : LAND_DARK;

  return (
    <div className="h-full flex" data-testid="map-view">
      <aside className="w-80 border-r border-line flex flex-col">
        <div className="px-3 py-2 border-b border-line">
          <SectionHeading as="h2">Datasets ({datasets.length})</SectionHeading>
        </div>
        {editId && datasets.some((d) => d.dataset_id === editId && d.coords) && (
          <div data-testid="map-move-hint" className="px-3 py-2 text-xs text-warn border-b border-line-subtle">
            Drag this dataset&rsquo;s dot on the map to where it was sampled. Saved on drop, four
            decimals (~11 m).
          </div>
        )}
        {stationAsk ? (
          <div className="px-3 py-2 border-b border-line-subtle">
            <SharedStationAsk ask={stationAsk}
              onCancel={() => { setStationAsk(null); setMoveErr(null); }}
              onMoved={async () => { setStationAsk(null); setMoveErr(null); await onRefresh(); }} />
          </div>
        ) : moveErr && <div data-testid="map-move-error" className="px-3 py-1 text-xs text-danger">{moveErr}</div>}
        <ul className="flex-1 overflow-auto">
          {zeilen.map(({ d, tiefe }) => (
            <li key={d.dataset_id}
                data-testid="dataset-row"
                data-derived-from={elternVon(d) ?? undefined}
                draggable={tiefe === 0}
                onDragStart={() => setDragId(d.dataset_id)}
                onDragEnd={() => setDragId(null)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => { e.preventDefault(); ablegenAuf(d.dataset_id); }}
                data-hover={hoverIds.includes(d.dataset_id) ? "1" : undefined}
                style={tiefe > 0 ? { paddingLeft: `${Math.min(tiefe, 4) * 14}px` } : undefined}
                className={`border-b border-line-subtle ${dragId === d.dataset_id ? "opacity-40" : ""}
                            ${hoverIds.includes(d.dataset_id) ? "bg-accent-soft" : ""}`}>
              <div className="flex items-stretch">
                {tiefe === 0
                  ? <span className="grid place-items-center px-1 text-fg-disabled cursor-grab select-none"
                          title="drag to reorder" aria-hidden>⠿</span>
                  : <span className="px-1" aria-hidden />}
                <button
                  data-testid="dataset-item"
                  data-ds={d.dataset_id}
                  onClick={() => onSelect(d)}
                  className="flex-1 min-w-0 text-left px-3 py-2 hover:bg-control"
                >
                  {tiefe > 0 ? (
                    <div className="text-fg truncate" data-testid="dataset-derived-title">
                      ↳ recomputed {tag(d.derived?.at)}
                      {d.region && !d.region.includes("recomputed") && <span className="text-fg-muted"> · {d.region}</span>}
                    </div>
                  ) : (
                    <div className="text-fg truncate">{d.region ?? d.dataset_id}</div>
                  )}
                  {tiefe > 0 || d.derived ? (
                    <div className="text-xs text-fg-muted tabular-nums" data-testid="dataset-derived-params">
                      {parameterZeile(d)}
                      {tiefe === 0 && <> · recomputed {tag(d.derived?.at)}, original not in the list</>}
                    </div>
                  ) : (
                    <div className="text-xs text-fg-muted">
                      Marker {d.marker ?? "?"} · {d.n_asv} ASVs · {d.n_network} in the network · {d.n_sample} samples
                    </div>
                  )}
                </button>
                {canImport && <div className="flex flex-col justify-center gap-1 pr-2">
                  <button data-testid="dataset-rename" title="rename" aria-label="Rename this dataset" disabled={busy}
                    onClick={() => { setConfirmId(null); setEditId(d.dataset_id); setEditVal(d.region ?? d.dataset_id); }}
                    className="rounded-md px-2 text-xs text-fg-muted hover:text-accent hover:bg-control disabled:text-fg-disabled">✎</button>
                  <button data-testid="dataset-delete" title="delete dataset" aria-label="Delete this dataset" disabled={busy}
                    onClick={() => { setEditId(null); setConfirmTyped(""); setConfirmId(d.dataset_id); }}
                    className="rounded-md px-2 text-xs text-fg-muted hover:text-danger hover:bg-control disabled:text-fg-disabled">✕</button>
                </div>}
              </div>

              {editId === d.dataset_id && (
                <div data-testid="dataset-rename-form" className="px-3 pb-2">
                  <div className="flex gap-1">
                  <input autoFocus data-testid="dataset-rename-input" value={editVal}
                    onChange={(e) => setEditVal(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") saveRename(d.dataset_id);
                      if (e.key === "Escape") setEditId(null);
                    }}
                    className="flex-1 min-w-0 px-2 py-1 rounded-md bg-control border border-line-strong text-sm text-fg" />
                  <Button variant="primary" data-testid="dataset-rename-save" disabled={busy || !editVal.trim()}
                    reason={busy ? "saving" : "the name is empty"}
                    onClick={() => saveRename(d.dataset_id)}>OK</Button>
                  <Button data-testid="dataset-rename-cancel" onClick={() => setEditId(null)}>Cancel</Button>
                </div>
                  </div>
              )}

              {confirmId === d.dataset_id && (
                <div data-testid="dataset-delete-confirm" className="px-3 pb-2">
                  <p className="text-xs text-danger leading-snug mb-1">
                    Permanently delete &ldquo;{d.region ?? d.dataset_id}&rdquo; with {d.n_asv} ASVs
                    and {d.n_sample} samples? This cannot be undone.
                  </p>
                  {(kinder.get(d.dataset_id)?.length ?? 0) > 0 && (
                    <p data-testid="dataset-delete-derived" className="text-xs text-fg leading-snug mb-1">
                      {kinder.get(d.dataset_id)!.length === 1
                        ? "Its recomputed dataset stays — it holds its own copy of the samples."
                        : `Its ${kinder.get(d.dataset_id)!.length} recomputed datasets stay — each holds its own copy of the samples.`}
                    </p>
                  )}
                  {elternVon(d) && (
                    <p data-testid="dataset-delete-derived" className="text-xs text-fg leading-snug mb-1">
                      The original it was recomputed from stays.
                    </p>
                  )}
                  <label className="block text-xs text-fg-muted mb-1">
                    Type <code className="text-fg">{d.dataset_id}</code> to confirm
                    <input data-testid="dataset-delete-type" value={confirmTyped} autoFocus
                      onChange={(e) => setConfirmTyped(e.target.value)}
                      className="mt-1 w-full px-2 py-1 rounded-md bg-control border border-line-strong text-xs text-fg" />
                  </label>
                  <div className="flex gap-1">
                    <Button variant="danger" data-testid="dataset-delete-yes"
                      disabled={busy || confirmTyped !== d.dataset_id}
                      reason={busy ? "deleting" : "type the identifier first"}
                      onClick={() => confirmDelete(d.dataset_id)}>
                      {busy ? "deleting …" : "Delete"}
                    </Button>
                    <Button onClick={() => { setConfirmId(null); setConfirmTyped(""); }}>Cancel</Button>
                  </div>
                  {mgmtErr && (
                    <p data-testid="dataset-delete-error" className="mt-1 text-xs text-danger">{mgmtErr}</p>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
        {dialogOpen && (
          <ImportDialog onClose={() => setDialogOpen(false)}
            onStarted={(jobId) => { setDialogOpen(false); setImp({ running: true, stage: "start" }); poll(jobId); }} />
        )}
        {mgmtErr && <div data-testid="dataset-mgmt-error" className="px-3 py-1 text-xs text-danger">{mgmtErr}</div>}
        {canImport && <div className="m-3">
          <Button data-testid="upload-button" size="md" className="w-full"
            disabled={imp.running} reason="an import is running"
            onClick={() => setDialogOpen(true)}>
            Import a dataset …
          </Button>
          {(imp.running || imp.done || imp.err) && (
            <div
              data-testid="import-status"
              className={`mt-2 text-xs ${imp.err ? "text-danger" : imp.done ? "text-ok" : "text-fg-muted"}`}
            >
              {imp.err
                ? `Import failed — ${imp.err}`
                : imp.done
                  ? "Import finished — dataset stored."
                  : `DADA2→OTTER→Neo4j — stage: ${imp.stage}`}
            </div>
          )}
        </div>}
      </aside>
      <div className="flex-1 relative" data-testid="map-canvas" data-handles={handles}>
        {mapReady && bathy && (
          <div data-testid="map-depth-legend"
            className="absolute right-12 top-2 z-10 rounded-md px-2 py-1 text-2xs text-fg-muted
                       bg-surface/70 hover:bg-surface transition-colors">
            <div className="flex items-start gap-2">
              <span className="text-fg">depth</span>
              <div>
                <div className="flex">
                  {bathy.classes.map((c, i) => (
                    <span key={c.key} data-testid="map-depth-class" title={c.name}
                      className="inline-block w-3.5 h-2 first:rounded-l-sm last:rounded-r-sm"
                      style={{ background: ramp[Math.min(i, ramp.length - 1)] }} />
                  ))}
                </div>
                <div className="mt-1 flex justify-between gap-2 text-2xs text-fg-muted leading-none">
                  <span>0 m</span><span>500</span><span>{bathy.classes[bathy.classes.length - 1]?.name}</span>
                </div>
              </div>
              <span className="inline-block w-3.5 h-2 rounded-sm" title="land"
                style={{ background: landColor }} />
              <span className="text-fg-muted">land</span>
            </div>
            <div data-testid="map-depth-source" className="text-2xs text-fg-muted leading-none mt-1">
              {bathy.source.name} · public domain · {Math.round(bathy.coarse.cell_deg * 60)}′ global,
              {" "}{bathy.windows[0] ? Math.round(bathy.windows[0].cell_deg * 60) : "–"}′ near the stations
            </div>
          </div>
        )}
        <ErrorBoundary label="the globe">
          <GlobeMap datasets={datasets} editId={editId} light={light}
            onSelect={onSelect} onHover={setHoverIds}
            onMove={(id, lat, lon) => moveDataset(id, lat, lon).then(() => onRefresh(), (e) => {
              if (e instanceof SharedStationError) setStationAsk({ id, lat, lon, reason: e.reason });
              throw e;
            })}
            onMoveError={setMoveErr} onBathy={setBathy} onHandles={setHandles}
            onReady={() => setMapReady(true)} onApi={setMapApi}
            onUnavailable={() => setGlobeOff(true)} />
        </ErrorBoundary>
        {mapReady && mapApi && (
          <div data-testid="map-zoom" className="absolute right-3 top-2 z-20 flex flex-col gap-1">
            {([["+", "zoom in", mapApi.zoomIn], ["−", "zoom out", mapApi.zoomOut], ["⟲", "whole globe", mapApi.reset]] as const).map(([t, title, fn]) => (
              <button key={t} title={title} onClick={fn}
                aria-label={title}
                className="w-7 h-7 rounded-md border border-line-strong bg-raised text-fg text-sm leading-none
                           hover:bg-control hover:text-accent">{t}</button>
            ))}
          </div>
        )}
        {!mapReady && !globeOff && (
          <div className="absolute inset-0 grid place-items-center pointer-events-none">
            <StateNotice state="loading" inline>loading map …</StateNotice>
          </div>
        )}
      </div>
    </div>
  );
}


function tag(at: string | null | undefined): string {
  return at && /^\d{4}-\d{2}-\d{2}/.test(at) ? at.slice(0, 10) : "—";
}

function parameterZeile(d: Dataset): string {
  const p = d.derived?.params;
  if (!p) return `${d.n_asv} ASVs · run not recorded`;
  return `CON r ≥ ${p.con_tr ?? "?"} · α ${p.con_alpha ?? "?"} · `
    + `${p.num_permutations ?? "?"} permutations · ${p.n_asv ?? d.n_asv} ASVs`;
}

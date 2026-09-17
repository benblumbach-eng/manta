import { useMemo, useState } from "react";
import { startImport, getImportStatus, deleteDataset, moveDataset, renameDataset,
         type Dataset } from "../api";
import ImportDialog from "./ImportDialog";
import GlobeMap, { DEPTH_RAMP_DARK, DEPTH_RAMP_LIGHT, LAND_DARK, LAND_LIGHT, type BathyMeta } from "./GlobeMap";

const DEMO_ID = "demo_dataset";


export default function MapView(
  { datasets, light = false, onSelect, onRefresh, canImport, orderKey }:
  { datasets: Dataset[]; light?: boolean; onSelect: (d: Dataset) => void; onRefresh: () => Promise<void>;
    canImport: boolean;
    orderKey: string },
) {
  const [mapReady, setMapReady] = useState(false);
  const [bathy, setBathy] = useState<BathyMeta | null>(null);
  const [hoverIds, setHoverIds] = useState<string[]>([]);
  const [mapApi, setMapApi] = useState<{ zoomIn: () => void; zoomOut: () => void; reset: () => void } | null>(null);
  const [handles, setHandles] = useState(0);
  const [moveErr, setMoveErr] = useState<string | null>(null);
  const [imp, setImp] = useState<{ running: boolean; stage?: string; err?: string; done?: boolean }>({ running: false });
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [editVal, setEditVal] = useState("");
  const [confirmId, setConfirmId] = useState<string | null>(null);
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

  const merken = (ids: string[]) => {
    setOrder(ids);
    try { localStorage.setItem(STORE, JSON.stringify(ids)); } catch { }
  };

  function ablegenAuf(zielId: string) {
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
      setMgmtErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete(id: string) {
    setBusy(true); setMgmtErr(null);
    try {
      await deleteDataset(id);
      setConfirmId(null);
      await onRefresh();
    } catch (e) {
      setMgmtErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function poll(job_id: string) {
    for (;;) {
      await new Promise((r) => setTimeout(r, 1000));
      const st = await getImportStatus(job_id);
      if (st.status === "done") { await onRefresh(); setImp({ running: false, done: true }); return; }
      if (st.status === "error") { setImp({ running: false, err: st.error }); return; }
      setImp({ running: true, stage: st.stage });
    }
  }

  async function handleImport() {
    setImp({ running: true, stage: "start" });
    try {
      const { job_id } = await startImport(DEMO_ID, "Bundled demo dataset");
      await poll(job_id);
    } catch (e) {
      setImp({ running: false, err: String(e) });
    }
  }

  const ramp = light ? DEPTH_RAMP_LIGHT : DEPTH_RAMP_DARK;
  const landColor = light ? LAND_LIGHT : LAND_DARK;

  return (
    <div className="h-full flex" data-testid="map-view">
      <aside className="w-80 border-r border-slate-700 flex flex-col">
        <div className="px-3 py-2 text-slate-400 text-sm border-b border-slate-700
                        flex items-center justify-between gap-2">
          <span>Datasets ({datasets.length})</span>
        </div>
        {editId && datasets.some((d) => d.dataset_id === editId && d.coords) && (
          <div data-testid="map-move-hint" className="px-3 py-2 text-xs text-amber-300/90 border-b border-slate-800">
            Drag this dataset&rsquo;s dot on the map to where it was sampled. Saved on drop, four
            decimals (~11 m).
          </div>
        )}
        {moveErr && <div data-testid="map-move-error" className="px-3 py-1 text-xs text-red-400">{moveErr}</div>}
        <ul className="flex-1 overflow-auto">
          {geordnet.map((d) => (
            <li key={d.dataset_id}
                data-testid="dataset-row"
                draggable
                onDragStart={() => setDragId(d.dataset_id)}
                onDragEnd={() => setDragId(null)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => { e.preventDefault(); ablegenAuf(d.dataset_id); }}
                data-hover={hoverIds.includes(d.dataset_id) ? "1" : undefined}
                className={`border-b border-slate-800 ${dragId === d.dataset_id ? "opacity-40" : ""}
                            ${hoverIds.includes(d.dataset_id) ? "bg-sky-900/40" : ""}`}>
              <div className="flex items-stretch">
                <span className="grid place-items-center px-1 text-slate-600 cursor-grab select-none"
                      title="drag to reorder" aria-hidden>⠿</span>
                <button
                  data-testid="dataset-item"
                  data-ds={d.dataset_id}
                  onClick={() => onSelect(d)}
                  className="flex-1 min-w-0 text-left px-3 py-2 hover:bg-slate-800"
                >
                  <div className="text-slate-100 truncate">{d.region ?? d.dataset_id}</div>
                  <div className="text-xs text-slate-400">
                    Marker {d.marker ?? "?"} · {d.n_network} of {d.n_asv} in the network · {d.n_sample} samples
                  </div>
                </button>
                <div className="flex flex-col justify-center gap-1 pr-2">
                  <button data-testid="dataset-rename" title="rename" aria-label="Rename this dataset" disabled={busy}
                    onClick={() => { setConfirmId(null); setEditId(d.dataset_id); setEditVal(d.region ?? d.dataset_id); }}
                    className="px-1.5 text-xs text-slate-500 hover:text-cyan-300 disabled:opacity-40">✎</button>
                  <button data-testid="dataset-delete" title="delete dataset" aria-label="Delete this dataset" disabled={busy}
                    onClick={() => { setEditId(null); setConfirmId(d.dataset_id); }}
                    className="px-1.5 text-xs text-slate-500 hover:text-red-400 disabled:opacity-40">✕</button>
                </div>
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
                    className="flex-1 min-w-0 px-2 py-1 rounded bg-slate-800 border border-slate-600 text-sm text-slate-100" />
                  <button data-testid="dataset-rename-save" disabled={busy || !editVal.trim()}
                    onClick={() => saveRename(d.dataset_id)}
                    className="px-2 py-1 rounded bg-cyan-700 text-white text-xs disabled:opacity-50">OK</button>
                  <button data-testid="dataset-rename-cancel" onClick={() => setEditId(null)}
                    className="px-2 py-1 rounded bg-slate-700 text-slate-300 text-xs">Cancel</button>
                </div>
                  </div>
              )}

              {confirmId === d.dataset_id && (
                <div data-testid="dataset-delete-confirm" className="px-3 pb-2">
                  <p className="text-xs text-red-300 leading-snug mb-1">
                    Permanently delete &ldquo;{d.region ?? d.dataset_id}&rdquo; with {d.n_asv} ASVs
                    and {d.n_sample} samples? This cannot be undone.
                  </p>
                  <div className="flex gap-1">
                    <button data-testid="dataset-delete-yes" disabled={busy}
                      onClick={() => confirmDelete(d.dataset_id)}
                      className="px-2 py-1 rounded bg-red-700 text-white text-xs disabled:opacity-50">
                      {busy ? "deleting …" : "Delete"}
                    </button>
                    <button onClick={() => setConfirmId(null)}
                      className="px-2 py-1 rounded bg-slate-700 text-slate-300 text-xs">Cancel</button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
        {dialogOpen && (
          <ImportDialog onClose={() => setDialogOpen(false)}
            onStarted={(jobId) => { setDialogOpen(false); setImp({ running: true, stage: "start" }); poll(jobId); }} />
        )}
        {mgmtErr && <div data-testid="dataset-mgmt-error" className="px-3 py-1 text-xs text-red-400">{mgmtErr}</div>}
        {canImport && <div className="m-3">
          <button
            data-testid="import-button"
            disabled={imp.running}
            className="w-full px-3 py-2 rounded bg-slate-700 text-slate-200 hover:bg-slate-600 disabled:opacity-60 text-sm"
            onClick={handleImport}
          >
            {imp.running ? "import running …" : "+ Import demo"}
          </button>
          <button
            data-testid="upload-button"
            disabled={imp.running}
            className="w-full mt-2 px-3 py-2 rounded border border-slate-600 text-slate-300 hover:bg-slate-800 disabled:opacity-60 text-sm"
            onClick={() => setDialogOpen(true)}
          >
            Import a dataset …
          </button>
          {(imp.running || imp.done || imp.err) && (
            <div
              data-testid="import-status"
              className={`mt-2 text-xs ${imp.err ? "text-red-400" : imp.done ? "text-emerald-400" : "text-slate-400"}`}
            >
              {imp.err
                ? `Error: ${imp.err}`
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
            className="absolute right-12 top-2 z-10 rounded px-2 py-1 text-[10px] text-slate-400
                       bg-slate-950/40 opacity-60 hover:opacity-100 hover:bg-slate-950/80 transition-opacity">
            <div className="flex items-end gap-2">
              <span className="text-slate-300">depth</span>
              <div className="flex">
                {bathy.classes.map((c, i) => (
                  <span key={c.key} data-testid="map-depth-class" title={c.name}
                    className="inline-block w-3.5 h-2 first:rounded-l-sm last:rounded-r-sm"
                    style={{ background: ramp[Math.min(i, ramp.length - 1)] }} />
                ))}
              </div>
              <span className="inline-block w-3.5 h-2 rounded-sm" title="land"
                style={{ background: landColor }} />
              <span className="text-slate-500">land</span>
            </div>
            <div className="flex justify-between text-[9px] text-slate-500 leading-none mt-0.5 pl-9 pr-10">
              <span>0 m</span><span>500</span><span>{bathy.classes[bathy.classes.length - 1]?.name}</span>
            </div>
            <div data-testid="map-depth-source" className="text-[9px] text-slate-600 leading-none mt-1">
              {bathy.source.name} · public domain · {Math.round(bathy.coarse.cell_deg * 60)}′ global,
              {" "}{bathy.windows[0] ? Math.round(bathy.windows[0].cell_deg * 60) : "–"}′ near the stations
            </div>
          </div>
        )}
        <GlobeMap datasets={datasets} editId={editId} light={light}
          onSelect={onSelect} onHover={setHoverIds}
          onMove={(id, lat, lon) => moveDataset(id, lat, lon).then(() => onRefresh())}
          onMoveError={setMoveErr} onBathy={setBathy} onHandles={setHandles}
          onReady={() => setMapReady(true)} onApi={setMapApi} />
        {mapReady && mapApi && (
          <div data-testid="map-zoom" className="absolute right-3 top-2 z-20 flex flex-col gap-0.5">
            {([["+", "zoom in", mapApi.zoomIn], ["−", "zoom out", mapApi.zoomOut], ["⟲", "whole globe", mapApi.reset]] as const).map(([t, title, fn]) => (
              <button key={t} title={title} onClick={fn}
                className="w-7 h-7 rounded border border-slate-700 bg-slate-950/80 text-slate-300 text-sm leading-none
                           hover:bg-slate-800 hover:text-cyan-300">{t}</button>
            ))}
          </div>
        )}
        {!mapReady && (
          <div className="absolute inset-0 grid place-items-center text-slate-500 pointer-events-none">loading map …</div>
        )}
      </div>
    </div>
  );
}

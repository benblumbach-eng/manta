import { Fragment, useState } from "react";
import { deleteDataset, moveDataset, renameDataset, setVisibility,
         type Dataset } from "../api";
import InfoTip from "./InfoTip";

export default function DatasetAdmin(
  { datasets, visibilities, input, onChanged }:
  { datasets: Dataset[]; visibilities: string[]; input: string; onChanged: () => void },
) {
  const [offen, setOffen] = useState<string | null>(null);
  const [region, setRegion] = useState("");
  const [lat, setLat] = useState("");
  const [lon, setLon] = useState("");
  const [tippen, setTippen] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (p: Promise<unknown>) => {
    setBusy(true); setErr(null);
    try { await p; onChanged(); setOffen(null); setTippen(""); }
    catch (e) { setErr(String((e as Error).message ?? e)); }
    finally { setBusy(false); }
  };

  const oeffnen = (d: Dataset) => {
    setOffen(offen === d.dataset_id ? null : d.dataset_id);
    setRegion(d.region ?? "");
    setLat(d.coords ? String(d.coords[1]) : "");
    setLon(d.coords ? String(d.coords[0]) : "");
    setTippen(""); setErr(null);
  };

  return (
    <section className="space-y-3" data-testid="dataset-admin">
      <h3 className="flex items-center text-sm font-medium text-slate-200">
        Datasets
        <InfoTip title="internal and public">
          <p><strong>internal</strong> requires an account. <strong>public</strong> is readable by
          anyone who knows the address. New datasets start internal, so nothing becomes readable
          by accident.</p>
          <p>Marker, counts and time axis are not editable: they describe the ingested data.</p>
        </InfoTip>
      </h3>

      {err && <p data-testid="dataset-error" className="text-xs text-red-400">{err}</p>}

      <table className="w-full text-sm">
        <tbody>
          {datasets.map((d) => (
            <Fragment key={d.dataset_id}>
              <tr className="border-t border-slate-800">
                <td className="py-1.5 text-slate-300">
                  {d.region ?? d.dataset_id}
                  <span className="ml-2 text-[11px] text-slate-600">{d.dataset_id}</span>
                </td>
                <td className="py-1.5 text-right">
                  <select data-testid={`vis-${d.dataset_id}`} className={input}
                          value={d.visibility ?? "internal"} disabled={busy}
                          onChange={(e) => run(setVisibility(
                            d.dataset_id, e.target.value as "public" | "internal"))}>
                    {visibilities.map((v) => <option key={v} value={v}>{v}</option>)}
                  </select>
                </td>
                <td className="py-1.5 w-16 text-right">
                  <button data-testid={`dataset-edit-${d.dataset_id}`}
                          className="text-xs text-slate-400 hover:text-cyan-300"
                          onClick={() => oeffnen(d)}>
                    {offen === d.dataset_id ? "close" : "edit"}
                  </button>
                </td>
              </tr>
              {offen === d.dataset_id && (
                <tr key={`${d.dataset_id}-edit`} data-testid={`dataset-editor-${d.dataset_id}`}>
                  <td colSpan={3} className="pb-3">
                    <div className="grid grid-cols-3 gap-2">
                      <label className="col-span-3 text-[11px] uppercase tracking-wide text-slate-500">
                        Label
                        <input data-testid="dataset-region" className={input} value={region}
                               onChange={(e) => setRegion(e.target.value)} />
                      </label>
                      <label className="text-[11px] uppercase tracking-wide text-slate-500">
                        Latitude
                        <input data-testid="dataset-lat" className={input} value={lat}
                               onChange={(e) => setLat(e.target.value)} placeholder="79.0" />
                      </label>
                      <label className="text-[11px] uppercase tracking-wide text-slate-500">
                        Longitude
                        <input data-testid="dataset-lon" className={input} value={lon}
                               onChange={(e) => setLon(e.target.value)} placeholder="4.17" />
                      </label>
                      <div className="flex items-end">
                        <button data-testid="dataset-save" disabled={busy}
                          className="px-3 py-1 rounded bg-cyan-700 text-sm text-white hover:bg-cyan-500 disabled:opacity-40"
                          onClick={() => {
                            const arbeit: Promise<unknown>[] = [];
                            if (region.trim() && region !== (d.region ?? "")) {
                              arbeit.push(renameDataset(d.dataset_id, region.trim()));
                            }
                            if (lat.trim() && lon.trim()) {
                              arbeit.push(moveDataset(d.dataset_id, Number(lat), Number(lon)));
                            }
                            run(arbeit.length ? Promise.all(arbeit) : Promise.resolve());
                          }}>save</button>
                      </div>
                    </div>

                    <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-800 pt-2">
                      <span className="text-[11px] text-slate-500">
                        Delete permanently — type <code className="text-slate-300">{d.dataset_id}</code> to confirm:
                      </span>
                      <input data-testid="dataset-confirm" className={input + " w-56"}
                             value={tippen} onChange={(e) => setTippen(e.target.value)} />
                      <button data-testid="dataset-delete"
                        disabled={busy || tippen !== d.dataset_id}
                        className="px-3 py-1 rounded border border-red-700 text-sm text-red-400 hover:bg-red-950 disabled:opacity-40"
                        onClick={() => run(deleteDataset(d.dataset_id))}>delete</button>
                    </div>
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </section>
  );
}

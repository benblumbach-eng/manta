import { Button } from "./ui";
import { Fragment, useState } from "react";
import { deleteDataset, moveDataset, renameDataset, setVisibility, SharedStationError,
         type Dataset } from "../api";
import InfoTip from "./InfoTip";
import SharedStationAsk, { type StationAsk } from "./SharedStationAsk";

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
  const [frage, setFrage] = useState<StationAsk | null>(null);

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
      <h3 className="flex items-center text-sm font-medium text-fg">
        Datasets
        <InfoTip title="internal and public">
          <p><strong>internal</strong> requires an account. <strong>public</strong> is readable by
          anyone who knows the address. New datasets start internal, so nothing becomes readable
          by accident.</p>
          <p>Marker, counts and time axis are not editable: they describe the ingested data.</p>
        </InfoTip>
      </h3>

      {err && <p data-testid="dataset-error" className="text-xs text-danger">{err}</p>}
      {frage && (
        <SharedStationAsk ask={frage} onCancel={() => setFrage(null)}
          onMoved={() => { setFrage(null); onChanged(); }} />
      )}

      <table className="w-full text-sm">
        <tbody>
          {datasets.map((d) => (
            <Fragment key={d.dataset_id}>
              <tr className="border-t border-line-subtle">
                <td className="py-2 text-fg">
                  {d.region ?? d.dataset_id}
                  <span className="ml-2 text-2xs text-fg-muted">{d.dataset_id}</span>
                </td>
                <td className="py-2 text-right">
                  <select data-testid={`vis-${d.dataset_id}`} className={input}
                          value={d.visibility ?? "internal"} disabled={busy}
                          onChange={(e) => run(setVisibility(
                            d.dataset_id, e.target.value as "public" | "internal"))}>
                    {visibilities.map((v) => <option key={v} value={v}>{v}</option>)}
                  </select>
                </td>
                <td className="py-2 w-16 text-right">
                  <button data-testid={`dataset-edit-${d.dataset_id}`}
                          className="text-xs text-fg-muted hover:text-accent"
                          onClick={() => oeffnen(d)}>
                    {offen === d.dataset_id ? "close" : "edit"}
                  </button>
                </td>
              </tr>
              {offen === d.dataset_id && (
                <tr key={`${d.dataset_id}-edit`} data-testid={`dataset-editor-${d.dataset_id}`}>
                  <td colSpan={3} className="pb-3">
                    <div className="grid grid-cols-3 gap-2">
                      <label className="col-span-3 text-xs text-fg-muted">
                        Label
                        <input data-testid="dataset-region" className={input} value={region}
                               onChange={(e) => setRegion(e.target.value)} />
                      </label>
                      <label className="text-xs text-fg-muted">
                        Latitude
                        <input data-testid="dataset-lat" className={input} value={lat}
                               onChange={(e) => setLat(e.target.value)} placeholder="79.0" />
                      </label>
                      <label className="text-xs text-fg-muted">
                        Longitude
                        <input data-testid="dataset-lon" className={input} value={lon}
                               onChange={(e) => setLon(e.target.value)} placeholder="4.17" />
                      </label>
                      <div className="flex items-end">
                        <Button variant="primary" size="md" data-testid="dataset-save" disabled={busy} reason="saving"
                          onClick={() => {
                            const arbeit: Promise<unknown>[] = [];
                            if (region.trim() && region !== (d.region ?? "")) {
                              arbeit.push(renameDataset(d.dataset_id, region.trim()));
                            }
                            const [la, lo] = [Number(lat), Number(lon)];
                            if (lat.trim() && lon.trim()
                                && (!d.coords || la !== d.coords[1] || lo !== d.coords[0])) {
                              arbeit.push(moveDataset(d.dataset_id, la, lo).catch((e) => {
                                if (!(e instanceof SharedStationError)) throw e;
                                setFrage({ id: d.dataset_id, lat: la, lon: lo, reason: e.reason });
                              }));
                            }
                            run(arbeit.length ? Promise.all(arbeit) : Promise.resolve());
                          }}>save</Button>
                      </div>
                    </div>

                    <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line-subtle pt-2">
                      {datasets.some((x) => x.derived?.from === d.dataset_id) && (
                        <span data-testid={`dataset-admin-derived-${d.dataset_id}`}
                              className="basis-full text-2xs text-fg-muted">
                          Recomputed datasets made from it stay:{" "}
                          {datasets.filter((x) => x.derived?.from === d.dataset_id)
                            .map((x) => x.dataset_id).join(", ")}
                        </span>
                      )}
                      <span className="text-2xs text-fg-muted">
                        Delete permanently — type <code className="text-fg">{d.dataset_id}</code> to confirm:
                      </span>
                      <input data-testid="dataset-confirm" className={input + " w-56"}
                             value={tippen} onChange={(e) => setTippen(e.target.value)} />
                      <Button variant="danger" size="md" data-testid="dataset-delete"
                        disabled={busy || tippen !== d.dataset_id} reason="type the identifier first"
                        onClick={() => run(deleteDataset(d.dataset_id))}>delete</Button>
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

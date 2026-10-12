import { useState } from "react";
import { moveDataset } from "../api";

export type StationAsk = { id: string; lat: number; lon: number; reason: string };

export default function SharedStationAsk({ ask, onMoved, onCancel }: {
  ask: StationAsk; onMoved: () => Promise<void> | void; onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const ja = async () => {
    setBusy(true); setErr(null);
    try {
      await moveDataset(ask.id, ask.lat, ask.lon, true);
      await onMoved();
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="station-ask" role="alertdialog" aria-label="The station is shared"
      className="rounded border border-warn bg-warn-soft p-2 text-xs space-y-1">
      <p className="text-warn">
        {ask.id} shares its sampling station with other datasets.
      </p>
      <p className="text-fg" data-testid="station-ask-reason">{ask.reason}</p>
      <p className="text-fg-muted">
        Day length and seasons are read from the station. Move all of them
        to {ask.lat}, {ask.lon}?
      </p>
      {err && <p className="text-danger" data-testid="station-ask-error">{err}</p>}
      <div className="flex gap-3 pt-1">
        <button data-testid="station-ask-yes" disabled={busy} onClick={ja}
          className="underline text-warn hover:text-warn disabled:opacity-40">
          move all
        </button>
        <button data-testid="station-ask-no" disabled={busy} onClick={onCancel}
          className="underline text-fg-muted hover:text-fg disabled:opacity-40">
          cancel
        </button>
      </div>
    </div>
  );
}

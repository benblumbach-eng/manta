import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { getModules, type ModuleLabel } from "./api";
import { clusterColor } from "./clusterPalette";


type Modules = {
  label: (label: number | null | undefined) => string;
  name: (label: number | null | undefined) => string;
  color: (label: number | null | undefined) => string;
  all: ModuleLabel[];
  reload: () => void;
};

function displayOf(label: number, name: string | null | undefined): string {
  const n = (name ?? "").trim();
  return n ? `M${label} · ${n}` : `M${label}`;
}

const FALLBACK: Modules = {
  label: (l) => (l == null ? "no module" : displayOf(l, null)),
  name: () => "",
  color: (l) => clusterColor(l),
  all: [],
  reload: () => {},
};

const Ctx = createContext<Modules>(FALLBACK);

export const useModules = () => useContext(Ctx);

export function ModulesProvider({ datasetId, children }: {
  datasetId: string | null;
  children: React.ReactNode;
}) {
  const [rows, setRows] = useState<ModuleLabel[]>([]);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!datasetId) { setRows([]); return; }
    let alive = true;
    getModules(datasetId)
      .then((r) => { if (alive) setRows(r.modules); })
      .catch(() => { if (alive) setRows([]); });
    return () => { alive = false; };
  }, [datasetId, tick]);

  const value = useMemo<Modules>(() => {
    const byLabel = new Map(rows.map((m) => [m.louvain_label, m]));
    return {
      label: (l) => (l == null ? "no module" : displayOf(l, byLabel.get(l)?.name)),
      name: (l) => (l == null ? "" : (byLabel.get(l)?.name ?? "")),
      color: (l) => (l == null ? clusterColor(null)
        : (byLabel.get(l)?.color ?? clusterColor(l))),
      all: rows,
      reload: () => setTick((t) => t + 1),
    };
  }, [rows]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

import { useEffect, useState } from "react";
import { searchDataset, type SearchResult } from "./api";

const PAUSE_MS = 250;

export type DatasetSearch = {
  result: SearchResult | null;
  loading: boolean;
  error: unknown;
};

export function useDatasetSearch(datasetId: string, query: string, limit = 25): DatasetSearch {
  const q = query.trim();
  const key = q ? `${datasetId}|${q}|${limit}` : "";
  const [s, setS] = useState<DatasetSearch & { key: string }>(
    { key: "", result: null, loading: false, error: null });

  useEffect(() => {
    if (!key) return;
    const ctl = new AbortController();
    const t = setTimeout(() => {
      searchDataset(datasetId, q, limit, ctl.signal)
        .then((result) => setS({ key, result, loading: false, error: null }))
        .catch((error) => {
          if (ctl.signal.aborted) return;
          setS({ key, result: null, loading: false, error });
        });
    }, PAUSE_MS);
    return () => { clearTimeout(t); ctl.abort(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (!key) return { result: null, loading: false, error: null };
  if (s.key !== key) return { result: null, loading: true, error: null };
  return { result: s.result, loading: s.loading, error: s.error };
}

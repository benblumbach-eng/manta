
export function fmtUtc(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso);
  return m ? `${m[1]} ${m[2]} UTC` : iso;
}

export const OTTER_DEFAULT_RUN_ID = "PyTest";

export function fmtRun(runId: string | null | undefined): string {
  if (runId == null || runId === "") return "run —";
  return runId === OTTER_DEFAULT_RUN_ID ? "OTTER default run" : `run ${runId}`;
}

export function fmtP(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  if (v === 0) return "0";
  return v < 1e-4 ? v.toExponential(2) : v.toFixed(4);
}

const HTML_ESC: Record<string, string> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
};
export function esc(v: unknown): string {
  return String(v ?? "").replace(/[&<>"']/g, (c) => HTML_ESC[c]);
}

export function fmtShare(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const p = v * 100;
  if (p > 0 && p < 0.01) return "< 0.01 %";
  return `${p >= 10 ? p.toFixed(0) : p >= 1 ? p.toFixed(1) : p.toFixed(2)} %`;
}

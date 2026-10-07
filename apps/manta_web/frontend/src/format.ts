
export function fmtUtc(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso);
  return m ? `${m[1]} ${m[2]} UTC` : iso;
}

export const OTTER_DEFAULT_RUN_ID = "PyTest";

export function fmtRun(runId: string | null | undefined): string {
  if (runId == null || runId === "") return "run —";
  return runId === OTTER_DEFAULT_RUN_ID ? "OTTER default run" : `run ${runId}`;
}

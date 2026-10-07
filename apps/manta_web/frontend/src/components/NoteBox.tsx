import { useEffect, useState } from "react";

export default function NoteBox({ value, savedAt, onSave, testid = "note" }:
  { value: string | null; savedAt: string | null; onSave: (t: string) => Promise<unknown>; testid?: string }) {
  const [text, setText] = useState(value ?? "");
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");

  useEffect(() => { setText(value ?? ""); setState("idle"); }, [value]);

  const dirty = text !== (value ?? "");

  async function save() {
    setState("saving");
    try { await onSave(text); setState("saved"); } catch { setState("error"); }
  }

  return (
    <section data-testid={testid}>
      <h3 className="text-slate-300 font-medium mb-1 flex items-center gap-2">
        Note
        <span className="text-[10px] font-normal uppercase tracking-wide text-amber-500/80 border border-amber-700/50 rounded px-1">
          your own input, not a measurement
        </span>
      </h3>
      <textarea
        data-testid={`${testid}-input`}
        value={text}
        onChange={(e) => { setText(e.target.value); setState("idle"); }}
        rows={3}
        placeholder="observation, hunch, to-do …"
        className="w-full rounded bg-slate-950 border border-slate-700 px-2 py-1 text-xs text-slate-200
                   placeholder:text-slate-600 focus:border-cyan-500 focus:outline-none"
      />
      <div className="flex items-center gap-2 mt-1 text-xs">
        <button data-testid={`${testid}-save`} onClick={save} disabled={!dirty || state === "saving"}
          className="px-2 py-0.5 rounded border border-slate-600 text-slate-300 hover:border-cyan-400
                     hover:text-cyan-300 disabled:opacity-40 disabled:hover:border-slate-600">
          {state === "saving" ? "saving …" : "save"}
        </button>
        {state === "saved" && <span className="text-emerald-400">saved</span>}
        {state === "error" && <span className="text-red-400">not saved</span>}
        {savedAt && state !== "saved" && (
          <span className="text-slate-500">last {savedAt.replace("T", " ").replace("+00:00", " UTC")}</span>
        )}
      </div>
    </section>
  );
}

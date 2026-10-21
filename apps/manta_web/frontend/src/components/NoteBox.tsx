import { Button } from "./ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { currentUsername, errorText } from "../api";

const MAX_NOTE_CHARS = 20000;
const AUTOSAVE_MS = 750;
const DRAFT_PREFIX = "manta-note-draft:";

type Draft = { text: string; base: string };

function readDraft(k: string | null): Draft | null {
  if (!k) return null;
  try {
    const raw = sessionStorage.getItem(k);
    const d = raw ? JSON.parse(raw) : null;
    return d && typeof d.text === "string" && typeof d.base === "string" ? d : null;
  } catch { return null; }
}
function writeDraft(k: string | null, d: Draft) {
  if (!k) return;
  try { sessionStorage.setItem(k, JSON.stringify(d)); } catch { }
}
function dropDraft(k: string | null) {
  if (!k) return;
  try { sessionStorage.removeItem(k); } catch { }
}
function draftSaved(k: string | null, t: string) {
  const d = readDraft(k);
  if (!d) return;
  if (d.text === t) dropDraft(k);
  else writeDraft(k, { text: d.text, base: t.trim() });
}

type State = "idle" | "pending" | "saving" | "saved" | "error" | "conflict";

export default function NoteBox({ value, savedAt, onSave, testid = "note", readOnly = false,
                                  draftKey }:
  { value: string | null; savedAt: string | null;
    onSave: (t: string, opts?: { keepalive?: boolean }) => Promise<unknown>;
    testid?: string;
    readOnly?: boolean;
    draftKey?: string }) {
  const server = value ?? "";
  const key = draftKey && !readOnly ? `${DRAFT_PREFIX}${currentUsername() ?? "guest"}:${draftKey}` : null;

  const [start] = useState(() => {
    const d = readDraft(key);
    if (!d || d.text.trim() === server) {
      if (d) dropDraft(key);
      return { text: server, restored: null as null | "auto" | "conflict" };
    }
    return { text: d.text, restored: d.base === server ? "auto" as const : "conflict" as const };
  });
  const [text, setText] = useState(start.text);
  const [state, setStateRaw] = useState<State>(
    start.restored === "conflict" ? "conflict" : start.restored === "auto" ? "pending" : "idle");
  const [why, setWhy] = useState<string | null>(null);

  const textRef = useRef(start.text);
  const savedRef = useRef(server);
  const serverRef = useRef(server);
  const stateRef = useRef<State>(state);
  const autoRef = useRef(start.restored !== "conflict");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inflight = useRef<Promise<void> | null>(null);
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const setState = (s: State) => { stateRef.current = s; setStateRaw(s); };

  useEffect(() => {
    const alt = serverRef.current;
    serverRef.current = server;
    if (textRef.current === alt) {
      textRef.current = server;
      savedRef.current = server;
      setText(server);
    }
  }, [server]);

  const save = useCallback(async (): Promise<void> => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    if (!autoRef.current) return;
    if (inflight.current) { await inflight.current; return save(); }
    const t = textRef.current;
    if (t === savedRef.current) {
      if (stateRef.current === "pending") setState("idle");
      return;
    }
    setState("saving"); setWhy(null);
    inflight.current = onSaveRef.current(t).then(
      () => {
        savedRef.current = t;
        draftSaved(key, t);
        if (textRef.current === t) setState("saved");
        else schedule();
      },
      (e) => { setWhy(errorText(e)); setState("error"); },
    ).finally(() => { inflight.current = null; });
    await inflight.current;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  function schedule() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { void save(); }, AUTOSAVE_MS);
  }

  useEffect(() => {
    if (start.restored === "auto") schedule();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const vorDemGehen = (e: BeforeUnloadEvent) => {
      const t = textRef.current;
      if (!autoRef.current || t === savedRef.current) return;
      void onSaveRef.current(t, { keepalive: true }).then(() => draftSaved(key, t), () => undefined);
      if (stateRef.current === "error") { e.preventDefault(); e.returnValue = ""; }
    };
    window.addEventListener("beforeunload", vorDemGehen);
    return () => {
      window.removeEventListener("beforeunload", vorDemGehen);
      if (timer.current) { clearTimeout(timer.current); timer.current = null; }
      const nachreichen = () => {
        const t = textRef.current;
        if (!autoRef.current || t === savedRef.current) return;
        void onSaveRef.current(t).then(() => { savedRef.current = t; draftSaved(key, t); },
                                       () => undefined);
      };
      if (inflight.current) void inflight.current.then(nachreichen);
      else nachreichen();
    };
  }, [key]);

  if (readOnly) {
    return (
      <section data-testid={testid} data-readonly="1">
        <h3 className="text-fg font-medium mb-1">Note</h3>
        {value
          ? <p data-testid={`${testid}-text`} className="whitespace-pre-wrap text-xs text-fg">{value}</p>
          : null}
        <p className="text-2xs text-fg-muted" data-testid={`${testid}-signin`}>
          Notes and stars belong to an account — sign in to keep your own.
        </p>
      </section>
    );
  }

  return (
    <section data-testid={testid}>
      <h3 className="text-fg font-medium mb-1">Note</h3>
      <textarea
        data-testid={`${testid}-input`}
        value={text}
        maxLength={MAX_NOTE_CHARS}
        onChange={(e) => {
          const t = e.target.value;
          textRef.current = t;
          setText(t);
          writeDraft(key, { text: t, base: serverRef.current });
          setWhy(null);
          if (!autoRef.current) return;
          setState(t === savedRef.current ? "idle" : "pending");
          schedule();
        }}
        onBlur={() => { if (textRef.current !== savedRef.current) void save(); }}
        rows={3}
        placeholder="observation, hunch, to-do …"
        className="w-full rounded-md bg-control border border-line-strong px-2 py-1 text-xs text-fg
                   placeholder:text-fg-muted focus:border-accent focus:outline-none"
      />
      <div className="flex flex-wrap items-center gap-2 mt-1 text-xs" data-testid={`${testid}-status`}
        data-state={state} aria-live="polite">
        {state === "pending" && <span className="text-warn">● unsaved</span>}
        {state === "saving" && <span className="text-fg-muted">saving …</span>}
        {state === "saved" && <span className="text-ok" data-testid={`${testid}-saved`}>saved ✓</span>}
        {state === "error" && (
          <>
            <span className="text-danger" data-testid={`${testid}-error`}>
              not saved{why ? ` — ${why}` : ""}
            </span>
            <Button type="button" data-testid={`${testid}-retry`} onClick={() => void save()}>
              Try again
            </Button>
          </>
        )}
        {state === "conflict" && (
          <>
            <span className="text-warn" data-testid={`${testid}-conflict`}>
              An unsaved draft from earlier differs from the saved note.
            </span>
            <Button type="button" data-testid={`${testid}-keep-draft`}
              onClick={() => { autoRef.current = true; setState("pending"); void save(); }}>
              keep draft
            </Button>
            <Button type="button" data-testid={`${testid}-discard-draft`}
              onClick={() => {
                dropDraft(key);
                autoRef.current = true;
                textRef.current = serverRef.current;
                setText(serverRef.current);
                setState("idle");
              }}>
              discard draft
            </Button>
          </>
        )}
        {savedAt && state === "idle" && (
          <span className="text-fg-muted">last saved {savedAt.replace("T", " ").replace("+00:00", " UTC")}</span>
        )}
      </div>
    </section>
  );
}

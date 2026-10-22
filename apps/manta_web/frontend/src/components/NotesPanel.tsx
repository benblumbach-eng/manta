import { useEffect, useMemo, useRef, useState } from "react";
import { addNote, deleteNote, editNote, errorText, getAsvList, getEnvironment, getNotes, getSamples,
         type Note, type NoteKind, type NoteTarget } from "../api";
import { useModules } from "../modules";
import { Segmented } from "./controls";
import ErrorNotice from "./ErrorNotice";
import { PanelHeader } from "./PanelFrame";
import { Button, SectionHeading, StateNotice, TextButton } from "./ui";

export type { NoteTarget };

export const NOTES_EVENT = "manta:notes";
export const openNotes = (target?: NoteTarget) =>
  window.dispatchEvent(new CustomEvent<NoteTarget | undefined>(NOTES_EVENT, { detail: target }));

const MAX_NOTE_CHARS = 20000;
const AUTOSAVE_MS = 750;

const KINDS: { kind: NoteKind; label: string; group: string }[] = [
  { kind: "dataset", label: "dataset", group: "Dataset" },
  { kind: "asv", label: "ASV", group: "ASVs" },
  { kind: "cluster", label: "module", group: "Modules" },
  { kind: "sample", label: "time point", group: "Time points" },
  { kind: "env", label: "environment", group: "Environmental variables" },
];
const gleich = (a: NoteTarget, b: NoteTarget) => a.kind === b.kind && a.key === b.key;
const schluessel = (z: NoteTarget[], t: string) =>
  `${z.map((x) => `${x.kind}:${x.key}`).sort().join("|")}#${t.trim()}`;

const NOTES_CHANGED = "manta:notes-changed";
const gaendert = () => window.dispatchEvent(new Event(NOTES_CHANGED));

export function NotesLink({ datasetId, kind, id, n: anfang }:
  { datasetId: string; kind: NoteKind; id: string; n: number }) {
  const [n, setN] = useState(anfang);
  useEffect(() => {
    const neu = () => getNotes(datasetId)
      .then((r) => setN(r.notes.filter((x) => x.targets.some((z) => z.kind === kind && z.key === id))
        .length))
      .catch(() => undefined);
    window.addEventListener(NOTES_CHANGED, neu);
    return () => window.removeEventListener(NOTES_CHANGED, neu);
  }, [datasetId, kind, id]);
  return (
    <TextButton data-testid={`${kind}-notes`} className="text-xs"
      onClick={() => openNotes({ kind, key: id })}>
      Notes ({n})
    </TextButton>
  );
}

export function NotesBar({ onOpen }: { onOpen: () => void }) {
  return (
    <button type="button" data-testid="notes-bar" onClick={onOpen} aria-label="Write a note"
      className="w-40 h-7 px-2 rounded-md bg-control border border-line-strong text-left text-xs
                 text-fg-muted hover:border-accent focus:outline-none focus-visible:border-accent">
      Note …
    </button>
  );
}

type Status = "idle" | "pending" | "saving" | "saved" | "error";

export default function NotesPanel({ datasetId, target, tick, onClose, onOpenAsv, onOpenCluster,
                                     onOpenSample }: {
  datasetId: string; target: NoteTarget; tick?: number; onClose: () => void;
  onOpenAsv: (id: string) => void; onOpenCluster: (label: number) => void;
  onOpenSample: (sample: string) => void;
}) {
  const modules = useModules();
  const [mode, setMode] = useState<"note" | "all">("note");
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [nochmal, setNochmal] = useState(0);
  const [asvs, setAsvs] = useState<{ id: string; label: string }[]>([]);
  const [samples, setSamples] = useState<{ sample: string; date: string | null }[]>([]);
  const [envs, setEnvs] = useState<{ key: string; label: string }[]>([]);

  const [noteId, setNoteId] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [ziele, setZiele] = useState<NoteTarget[]>([target]);
  const [status, setStatus] = useState<Status>("idle");
  const [why, setWhy] = useState<string | null>(null);
  const eingabe = useRef<HTMLTextAreaElement | null>(null);

  const stand = useRef({ id: null as string | null, text: "", ziele: [target], gespeichert: "" });
  const kette = useRef<Promise<void>>(Promise.resolve());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setNotes(null); setErr(null);
    getNotes(datasetId).then((r) => setNotes(r.notes)).catch((e) => setErr(e));
  }, [datasetId, nochmal]);
  useEffect(() => {
    getAsvList(datasetId).then((r) => setAsvs(r.asvs)).catch(() => setAsvs([]));
    getSamples(datasetId).then((r) => setSamples(r.samples)).catch(() => setSamples([]));
    getEnvironment(datasetId).then((r) => setEnvs(r.variables)).catch(() => setEnvs([]));
  }, [datasetId]);

  function speichern(): Promise<void> {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    kette.current = kette.current.then(async () => {
      const s = stand.current;
      const k = schluessel(s.ziele, s.text);
      if (k === s.gespeichert) { setStatus((x) => (x === "pending" ? "idle" : x)); return; }
      if (!s.id && !s.text.trim()) return;
      if (!s.ziele.length) { setStatus("pending"); return; }
      setStatus("saving"); setWhy(null);
      try {
        const body = { targets: s.ziele, text: s.text };
        if (s.id && !s.text.trim()) {
          await deleteNote(datasetId, s.id);
          setNotes((cur) => cur?.filter((n) => n.id !== s.id) ?? cur);
          s.id = null; setNoteId(null);
        } else {
          const n = s.id ? await editNote(datasetId, s.id, body) : await addNote(datasetId, body);
          s.id = n.id; setNoteId(n.id);
          setNotes((cur) => [n, ...(cur ?? []).filter((x) => x.id !== n.id)]);
        }
        s.gespeichert = k;
        gaendert();
        setStatus(schluessel(stand.current.ziele, stand.current.text) === k ? "saved" : "pending");
      } catch (e) { setWhy(errorText(e)); setStatus("error"); }
    });
    return kette.current;
  }

  function beginne(n: Note | null, z: NoteTarget[]) {
    void speichern();
    kette.current = kette.current.then(() => {
      const t = n?.text ?? "";
      stand.current = { id: n?.id ?? null, text: t, ziele: z, gespeichert: n ? schluessel(z, t) : "" };
      setNoteId(n?.id ?? null); setText(t); setZiele(z); setStatus("idle"); setWhy(null);
      setMode("note");
      setTimeout(() => eingabe.current?.focus(), 0);
    });
  }

  useEffect(() => { beginne(null, [target]); },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [target.kind, target.key, tick]);
  useEffect(() => () => { void speichern(); },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []);

  const setzeZiele = (z: NoteTarget[]) => {
    stand.current.ziele = z; setZiele(z);
    void speichern();
  };

  const auswahl: Record<NoteKind, [string, string][]> = useMemo(() => ({
    dataset: [["", "this dataset"]],
    asv: asvs.map((a) => [a.id, a.label !== "unassigned" ? `${a.id} · ${a.label}` : a.id]),
    cluster: modules.all.map((m) => [String(m.louvain_label), modules.label(m.louvain_label)]),
    sample: samples.map((s) => [s.sample, s.date ?? s.sample]),
    env: envs.map((v) => [v.key, v.label]),
  }), [asvs, modules, samples, envs]);
  const name = (z: NoteTarget) => z.kind === "dataset" ? "this dataset"
    : auswahl[z.kind].find(([k]) => k === z.key)?.[1] ?? z.key;
  const art = (k: NoteKind) => KINDS.find((x) => x.kind === k)!.label;
  const zeit = (s: string) => s.replace("T", " ").slice(0, 16);

  const oeffnen = (z: NoteTarget) =>
    z.kind === "asv" ? () => onOpenAsv(z.key)
    : z.kind === "cluster" ? () => onOpenCluster(Number(z.key))
    : z.kind === "sample" ? () => onOpenSample(z.key) : null;

  const zeile = (n: Note, hier?: NoteTarget) => {
    const auch = hier ? n.targets.filter((z) => !gleich(z, hier)) : [];
    return (
      <li key={n.id} data-testid="note-item" className="px-2 py-1 rounded hover:bg-control">
        <p className="whitespace-pre-wrap text-xs text-fg line-clamp-3">{n.text}</p>
        {auch.length > 0 && (
          <p className="text-2xs text-fg-muted" data-testid="note-also">
            also: {auch.map((z) => `${art(z.kind)} ${name(z)}`).join(", ")}
          </p>
        )}
        <span className="flex items-center gap-2 text-2xs text-fg-muted">
          {zeit(n.at)}
          <TextButton data-testid="note-edit" onClick={() => beginne(n, n.targets)}>edit</TextButton>
          <TextButton data-testid="note-delete" onClick={() =>
            deleteNote(datasetId, n.id).then(() => {
              setNotes((cur) => cur?.filter((x) => x.id !== n.id) ?? cur);
              gaendert();
              if (stand.current.id === n.id) beginne(null, stand.current.ziele);
            }).catch((e) => setErr(e))}>
            delete
          </TextButton>
        </span>
      </li>
    );
  };

  const zuDenZielen = (notes ?? []).filter((n) => n.id !== noteId
    && n.targets.some((z) => ziele.some((y) => gleich(z, y))));

  return (
    <aside data-testid="notes-panel">
      <PanelHeader title="Notes" onClose={onClose} closeTestid="notes-close" />
      <div className="p-4 space-y-3 text-xs">
        <Segmented value={mode} onChange={setMode} testid="notes-mode" options={[
          { value: "note", label: noteId ? "Note" : "New note", testid: "notes-mode-note" },
          { value: "all", label: `All notes${notes ? ` (${notes.length})` : ""}`,
            testid: "notes-mode-all" },
        ]} />

        {err != null && <ErrorNotice error={err} inline what="Could not load the notes."
          onRetry={() => setNochmal((n) => n + 1)} />}

        {mode === "note" && (
          <>
            <div className="space-y-1">
              <span className="text-fg-muted">Belongs to</span>
              <div className="flex flex-wrap gap-2" data-testid="note-targets">
                {ziele.map((z) => (
                  <span key={`${z.kind}:${z.key}`} data-testid="note-target" data-kind={z.kind}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded border border-line">
                    <span className="text-2xs text-fg-muted">{art(z.kind)}</span>
                    <span className="text-fg">{z.kind === "dataset" ? "" : name(z)}</span>
                    <button aria-label={`remove ${name(z)}`} data-testid="note-target-remove"
                      onClick={() => setzeZiele(ziele.filter((y) => !gleich(y, z)))}
                      className="text-fg-muted hover:text-fg">✕</button>
                  </span>
                ))}
                {!ziele.length && <span className="text-warn py-1">nothing chosen</span>}
              </div>
              <div className="grid grid-cols-3 gap-1" data-testid="note-pickers">
                {KINDS.map(({ kind, label }) => (
                  <select key={kind} data-testid={`note-pick-${kind}`} value=""
                    aria-label={`add ${label}`}
                    onChange={(e) => {
                      if (!e.target.value) return;
                      const z = { kind, key: kind === "dataset" ? "" : e.target.value };
                      if (!ziele.some((y) => gleich(y, z))) setzeZiele([...ziele, z]);
                    }}
                    className="min-w-0 px-1 py-1 rounded bg-control border border-line-strong text-fg">
                    <option value="">+ {label} …</option>
                    {auswahl[kind].filter(([k]) => !ziele.some((y) => gleich(y, { kind, key: k })))
                      .map(([k, t]) => <option key={k} value={k || "dataset"}>{t}</option>)}
                  </select>
                ))}
              </div>
            </div>

            <textarea ref={eingabe} data-testid="note-input" value={text} rows={6}
              maxLength={MAX_NOTE_CHARS} placeholder="observation, hunch, to-do …"
              onChange={(e) => {
                const t = e.target.value;
                stand.current.text = t; setText(t); setStatus("pending"); setWhy(null);
                if (timer.current) clearTimeout(timer.current);
                timer.current = setTimeout(() => { void speichern(); }, AUTOSAVE_MS);
              }}
              onBlur={() => { void speichern(); }}
              className="w-full rounded-md bg-control border border-line-strong px-2 py-1 text-xs
                         text-fg placeholder:text-fg-muted focus:border-accent focus:outline-none" />

            <div className="flex flex-wrap items-center gap-2" data-testid="note-status"
              data-state={status} aria-live="polite">
              {status === "pending" && !ziele.length && text.trim() && (
                <span className="text-warn">● choose what it belongs to</span>)}
              {status === "pending" && ziele.length > 0 && <span className="text-warn">● unsaved</span>}
              {status === "saving" && <span className="text-fg-muted">saving …</span>}
              {status === "saved" && <span className="text-ok" data-testid="note-saved">saved ✓</span>}
              {status === "error" && (
                <>
                  <span className="text-danger" data-testid="note-error">
                    not saved{why ? ` — ${why}` : ""}
                  </span>
                  <Button type="button" onClick={() => void speichern()}>Try again</Button>
                </>
              )}
              {noteId && (
                <TextButton data-testid="note-new" className="ml-auto"
                  onClick={() => beginne(null, ziele)}>new note</TextButton>
              )}
            </div>

            {zuDenZielen.length > 0 && (
              <section data-testid="notes-same-target">
                <SectionHeading className="mb-1">
                  More notes on the same things ({zuDenZielen.length})
                </SectionHeading>
                <ul className="space-y-1">{zuDenZielen.map((n) => zeile(n))}</ul>
              </section>
            )}
          </>
        )}

        {mode === "all" && !notes && err == null && <StateNotice state="loading" inline>loading …</StateNotice>}
        {mode === "all" && notes && notes.length === 0 && (
          <StateNotice state="empty" inline testid="notes-empty">No notes yet.</StateNotice>
        )}
        {mode === "all" && notes && KINDS.map(({ kind, group }) => {
          const hier = notes.filter((n) => n.targets.some((z) => z.kind === kind));
          if (!hier.length) return null;
          const keys = [...new Set(hier.flatMap((n) => n.targets.filter((z) => z.kind === kind)
            .map((z) => z.key)))];
          return (
            <section key={kind} data-testid={`notes-group-${kind}`}
              className="pt-2 border-t border-line-subtle first:border-t-0">
              <SectionHeading className="mb-1">{group} ({hier.length})</SectionHeading>
              {keys.map((key) => {
                const z = { kind, key };
                const auf = oeffnen(z);
                return (
                  <div key={key} className="mb-2">
                    {kind !== "dataset" && (auf
                      ? <TextButton data-testid="note-target-open" onClick={auf}>{name(z)}</TextButton>
                      : <span className="text-fg">{name(z)}</span>)}
                    <ul className="space-y-1">
                      {hier.filter((n) => n.targets.some((y) => gleich(y, z))).map((n) => zeile(n, z))}
                    </ul>
                  </div>
                );
              })}
            </section>
          );
        })}
      </div>
    </aside>
  );
}

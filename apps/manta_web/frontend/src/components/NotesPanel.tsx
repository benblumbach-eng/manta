import { useEffect, useMemo, useRef, useState } from "react";
import { addNote, deleteNote, editNote, errorText, getAsvList, getEnvironment, getNotes, getSamples,
         type Note, type NoteKind } from "../api";
import { useModules } from "../modules";
import { Segmented } from "./controls";
import ErrorNotice from "./ErrorNotice";
import { PanelHeader } from "./PanelFrame";
import { Button, SectionHeading, StateNotice, TextButton } from "./ui";

export type NoteTarget = { kind: NoteKind; key: string };

export const NOTES_EVENT = "manta:notes";
export const openNotes = (target?: NoteTarget) =>
  window.dispatchEvent(new CustomEvent<NoteTarget | undefined>(NOTES_EVENT, { detail: target }));

const MAX_NOTE_CHARS = 20000;
const AUTOSAVE_MS = 750;

const KINDS: { kind: NoteKind; label: string; group: string }[] = [
  { kind: "dataset", label: "Dataset", group: "Dataset" },
  { kind: "asv", label: "ASV", group: "ASVs" },
  { kind: "cluster", label: "Module", group: "Modules" },
  { kind: "sample", label: "Time point", group: "Time points" },
  { kind: "env", label: "Environment", group: "Environmental variables" },
];

const NOTES_CHANGED = "manta:notes-changed";
const gaendert = () => window.dispatchEvent(new Event(NOTES_CHANGED));

export function NotesLink({ datasetId, kind, id, n: anfang }:
  { datasetId: string; kind: NoteKind; id: string; n: number }) {
  const [n, setN] = useState(anfang);
  useEffect(() => {
    const neu = () => getNotes(datasetId)
      .then((r) => setN(r.notes.filter((x) => x.kind === kind && x.key === id).length))
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
  const [ziel, setZiel] = useState<NoteTarget>(target);
  const [status, setStatus] = useState<Status>("idle");
  const [why, setWhy] = useState<string | null>(null);
  const eingabe = useRef<HTMLTextAreaElement | null>(null);

  const stand = useRef({ id: null as string | null, text: "", ziel: target, gespeichert: "" });
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
      const schluessel = `${s.ziel.kind}|${s.ziel.key}|${s.text.trim()}`;
      if (schluessel === s.gespeichert) { setStatus((x) => (x === "pending" ? "idle" : x)); return; }
      if (!s.id && !s.text.trim()) return;
      if (s.ziel.kind !== "dataset" && !s.ziel.key) { setStatus("pending"); return; }
      setStatus("saving"); setWhy(null);
      try {
        const body = { kind: s.ziel.kind, key: s.ziel.key, text: s.text };
        if (s.id && !s.text.trim()) {
          await deleteNote(datasetId, s.id);
          setNotes((cur) => cur?.filter((n) => n.id !== s.id) ?? cur);
          s.id = null; setNoteId(null);
        } else {
          const n = s.id ? await editNote(datasetId, s.id, body) : await addNote(datasetId, body);
          s.id = n.id; setNoteId(n.id);
          setNotes((cur) => [n, ...(cur ?? []).filter((x) => x.id !== n.id)]);
        }
        s.gespeichert = schluessel;
        gaendert();
        setStatus(stand.current.text === s.text ? "saved" : "pending");
      } catch (e) { setWhy(errorText(e)); setStatus("error"); }
    });
    return kette.current;
  }

  function beginne(n: Note | null, z: NoteTarget) {
    void speichern();
    kette.current = kette.current.then(() => {
      const t = n?.text ?? "";
      stand.current = { id: n?.id ?? null, text: t, ziel: z,
                        gespeichert: n ? `${z.kind}|${z.key}|${t.trim()}` : "" };
      setNoteId(n?.id ?? null); setText(t); setZiel(z); setStatus("idle"); setWhy(null);
      setMode("note");
      setTimeout(() => eingabe.current?.focus(), 0);
    });
  }

  useEffect(() => { beginne(null, target); },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [target.kind, target.key, tick]);
  useEffect(() => () => { void speichern(); },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []);

  const setzeZiel = (z: NoteTarget) => {
    stand.current.ziel = z; setZiel(z);
    void speichern();
  };

  const auswahl: Record<NoteKind, [string, string][]> = useMemo(() => ({
    dataset: [],
    asv: asvs.map((a) => [a.id, a.label !== "unassigned" ? `${a.id} · ${a.label}` : a.id]),
    cluster: modules.all.map((m) => [String(m.louvain_label), modules.label(m.louvain_label)]),
    sample: samples.map((s) => [s.sample, s.date ?? s.sample]),
    env: envs.map((v) => [v.key, v.label]),
  }), [asvs, modules, samples, envs]);
  const name = (z: NoteTarget) => z.kind === "dataset" ? "this dataset"
    : auswahl[z.kind].find(([k]) => k === z.key)?.[1] ?? z.key;
  const zeit = (s: string) => s.replace("T", " ").slice(0, 16);

  const oeffnen = (z: NoteTarget) =>
    z.kind === "asv" ? () => onOpenAsv(z.key)
    : z.kind === "cluster" ? () => onOpenCluster(Number(z.key))
    : z.kind === "sample" ? () => onOpenSample(z.key) : null;

  const zeile = (n: Note) => (
    <li key={n.id} data-testid="note-item" className="px-2 py-1 rounded hover:bg-control">
      <p className="whitespace-pre-wrap text-xs text-fg line-clamp-3">{n.text}</p>
      <span className="flex items-center gap-2 text-2xs text-fg-muted">
        {zeit(n.at)}
        <TextButton data-testid="note-edit" onClick={() => beginne(n, { kind: n.kind, key: n.key })}>
          edit
        </TextButton>
        <TextButton data-testid="note-delete" onClick={() =>
          deleteNote(datasetId, n.id).then(() => {
            setNotes((cur) => cur?.filter((x) => x.id !== n.id) ?? cur);
            gaendert();
            if (stand.current.id === n.id) beginne(null, stand.current.ziel);
          }).catch((e) => setErr(e))}>
          delete
        </TextButton>
      </span>
    </li>
  );

  const zumZiel = (notes ?? []).filter((n) => n.kind === ziel.kind && n.key === ziel.key
    && n.id !== noteId);

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
              <Segmented value={ziel.kind} testid="note-kind" full
                onChange={(k) => setzeZiel({ kind: k, key: "" })}
                options={KINDS.map((k) => ({ value: k.kind, label: k.label,
                                             testid: `note-kind-${k.kind}` }))} />
              {ziel.kind !== "dataset" && (
                <select data-testid="note-target" value={ziel.key} aria-label="belongs to"
                  onChange={(e) => setzeZiel({ kind: ziel.kind, key: e.target.value })}
                  className="w-full px-1 py-1 rounded bg-control border border-line-strong text-fg">
                  <option value="">choose …</option>
                  {auswahl[ziel.kind].map(([k, t]) => <option key={k} value={k}>{t}</option>)}
                </select>
              )}
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
              {status === "pending" && ziel.kind !== "dataset" && !ziel.key && text.trim() && (
                <span className="text-warn">● choose what it belongs to</span>)}
              {status === "pending" && (ziel.kind === "dataset" || ziel.key) && (
                <span className="text-warn">● unsaved</span>)}
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
                  onClick={() => beginne(null, ziel)}>new note</TextButton>
              )}
            </div>

            {zumZiel.length > 0 && (
              <section data-testid="notes-same-target">
                <SectionHeading className="mb-1">
                  More notes on {name(ziel)} ({zumZiel.length})
                </SectionHeading>
                <ul className="space-y-1">{zumZiel.map(zeile)}</ul>
              </section>
            )}
          </>
        )}

        {mode === "all" && !notes && err == null && <StateNotice state="loading" inline>loading …</StateNotice>}
        {mode === "all" && notes && notes.length === 0 && (
          <StateNotice state="empty" inline testid="notes-empty">No notes yet.</StateNotice>
        )}
        {mode === "all" && notes && KINDS.map(({ kind, group }) => {
          const eigene = notes.filter((n) => n.kind === kind);
          if (!eigene.length) return null;
          const ziele = [...new Set(eigene.map((n) => n.key))];
          return (
            <section key={kind} data-testid={`notes-group-${kind}`}
              className="pt-2 border-t border-line-subtle first:border-t-0">
              <SectionHeading className="mb-1">{group} ({eigene.length})</SectionHeading>
              {ziele.map((key) => {
                const z = { kind, key };
                const auf = oeffnen(z);
                return (
                  <div key={key} className="mb-2">
                    {kind !== "dataset" && (auf
                      ? <TextButton data-testid="note-target-open" onClick={auf}>{name(z)}</TextButton>
                      : <span className="text-fg">{name(z)}</span>)}
                    <ul className="space-y-1">{eigene.filter((n) => n.key === key).map(zeile)}</ul>
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

import { createContext, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState,
         useSyncExternalStore, type ReactNode } from "react";
import { Z } from "../design/layers";


export type PanelBox = { x: number; y: number; w: number; h: number | null };
type Flaeche = { width: number; height: number };

const MIN_W = 320;
const MIN_H = 180;
const GAP = 10;
const FIGUR = { w: 104, h: 104 };
const schluessel = (id: string) => `manta-panel-v2-${id}`;
const NICHT_ZIEHEN = "button, a, input, select, textarea, label, [role=button], [data-no-drag]";

let stapel: readonly string[] = [];
const abos = new Set<() => void>();
const schliesser = new Map<string, () => void>();
const rahmen = new Map<string, HTMLElement>();

function setzen(neu: readonly string[]) { stapel = neu; abos.forEach((f) => f()); }
function heben(id: string) {
  if (stapel[stapel.length - 1] === id || !stapel.includes(id)) return;
  setzen([...stapel.filter((x) => x !== id), id]);
}
const abonnieren = (f: () => void) => { abos.add(f); return () => { abos.delete(f); }; };
const lesen = () => stapel;

function escapeKette(e: KeyboardEvent) {
  if (e.key !== "Escape" || e.defaultPrevented) return;
  if (document.querySelector("[data-popup], [role=dialog][aria-modal=true]")) {
    e.preventDefault();
    return;
  }
  const t = e.target;
  if (t instanceof Element) {
    const feld = t.closest("input, textarea, select, [contenteditable=true]");
    if (feld && !feld.closest("[data-panel-id]")) return;
  }
  const oben = stapel[stapel.length - 1];
  if (!oben) return;
  e.preventDefault();
  schliesser.get(oben)?.();
}
let lauscher = 0;
function lauschen() {
  if (lauscher++ === 0) window.addEventListener("keydown", escapeKette, true);
  return () => { if (--lauscher === 0) window.removeEventListener("keydown", escapeKette, true); };
}

function laden(id: string): PanelBox | null {
  try {
    const roh = localStorage.getItem(schluessel(id));
    if (!roh) return null;
    const b = JSON.parse(roh) as PanelBox;
    const zahl = (v: unknown) => typeof v === "number" && Number.isFinite(v);
    return [b.x, b.y, b.w].every(zahl) && (b.h === null || zahl(b.h)) ? b : null;
  } catch { return null; }
}

export function klemmen(b: PanelBox, f: Flaeche): PanelBox {
  const w = Math.min(Math.max(b.w, MIN_W), Math.max(0, f.width - 2 * GAP));
  const x = Math.min(Math.max(0, b.x), Math.max(0, f.width - w));
  const y = Math.min(Math.max(0, b.y), Math.max(0, f.height - MIN_H));
  const h = b.h == null ? null : Math.min(Math.max(b.h, MIN_H), Math.max(0, f.height - y - GAP));
  return { x, y, w, h };
}

function freierPlatz(wunsch: number, f: Flaeche): PanelBox {
  const w = Math.min(wunsch, Math.max(MIN_W, f.width - 2 * GAP));
  const offen = [...rahmen.values()].filter((el) => el.offsetParent !== null)
    .map((el) => ({ x: el.offsetLeft, w: el.offsetWidth }));
  let x = f.width - w - GAP;
  for (let i = 0; i <= offen.length; i++) {
    const stoert = offen.filter((b) => x < b.x + b.w && x + w > b.x);
    if (stoert.length === 0) return { x, y: GAP, w, h: null };
    x = Math.min(...stoert.map((b) => b.x)) - w - GAP;
    if (x < GAP) break;
  }
  return { x: Math.max(GAP, f.width - w - GAP), y: GAP, w, h: null };
}

type PanelCtx = {
  titleId: string;
  ziehen: (e: React.PointerEvent) => void;
  nachInhalt: (e: React.MouseEvent) => void;
  kopfDa: () => () => void;
};
const Ctx = createContext<PanelCtx | null>(null);

export function PanelHeader(p: KopfProps) {
  const ctx = useContext(Ctx);
  useLayoutEffect(() => ctx?.kopfDa(), [ctx]);
  return <Kopfleiste {...p} />;
}

type KopfProps = {
  title: ReactNode;
  lead?: ReactNode;
  children?: ReactNode;
  onClose: () => void;
  closeTestid?: string;
  titleTestid?: string;
};

function Kopfleiste({ title, lead, children, onClose, closeTestid, titleTestid }: KopfProps) {
  const ctx = useContext(Ctx);
  return (
    <div data-testid="panel-grip" onPointerDown={ctx?.ziehen} onDoubleClick={ctx?.nachInhalt}
      className={`sticky top-0 z-10 flex min-h-11 select-none items-center gap-2 border-b border-line
        bg-raised px-4 py-1${ctx ? " cursor-move" : ""}`}>
      {lead}
      <h2 id={ctx?.titleId} data-testid={titleTestid}
        className="min-w-0 truncate text-sm font-semibold text-fg">{title}</h2>
      {children}
      <button type="button" onClick={onClose} data-testid={closeTestid} aria-label="Close"
        title="close (Esc)"
        className="ml-auto shrink-0 cursor-default rounded-md px-2 py-1 text-fg-muted hover:bg-control
                   hover:text-fg">
        ✕
      </button>
    </div>
  );
}

export default function PanelFrame({ id, title, onClose, defaultWidth = 520, testid, hidden = false,
                                     figureGap = true, fit = true, children }: {
  id: string;
  title: string;
  onClose: () => void;
  defaultWidth?: number;
  testid?: string;
  hidden?: boolean;
  figureGap?: boolean;
  fit?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const rumpf = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<PanelBox | null>(null);
  const [flaeche, setFlaeche] = useState<Flaeche | null>(null);
  const [koepfe, setKoepfe] = useState(0);
  const [figurNah, setFigurNah] = useState(false);
  const titleId = useId();
  const platz = useSyncExternalStore(abonnieren, lesen).indexOf(id);
  const schliessen = useRef(onClose);
  schliessen.current = onClose;

  const shown = box && flaeche ? klemmen(box, flaeche) : box;
  const maxH = flaeche && shown ? Math.max(0, flaeche.height - shown.y - GAP) : undefined;
  const sichtbar = !!box && !hidden;
  const jetzt = useRef({ shown, flaeche });
  jetzt.current = { shown, flaeche };

  useLayoutEffect(() => {
    const p = ref.current?.parentElement;
    if (!p) return;
    const messen = () => setFlaeche((alt) =>
      alt && alt.width === p.clientWidth && alt.height === p.clientHeight
        ? alt : { width: p.clientWidth, height: p.clientHeight });
    messen();
    const ro = new ResizeObserver(messen);
    ro.observe(p);
    return () => ro.disconnect();
  }, []);

  useEffect(lauschen, []);

  useLayoutEffect(() => {
    if (hidden || box || !flaeche) return;
    setBox(laden(id) ?? freierPlatz(defaultWidth, flaeche));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, defaultWidth, hidden, flaeche]);

  useLayoutEffect(() => {
    if (!sichtbar) return;
    const el = ref.current;
    setzen([...stapel.filter((x) => x !== id), id]);
    schliesser.set(id, () => schliessen.current());
    if (el) rahmen.set(id, el);
    return () => {
      if (stapel.includes(id)) setzen(stapel.filter((x) => x !== id));
      schliesser.delete(id);
      rahmen.delete(id);
    };
  }, [sichtbar, id]);

  useLayoutEffect(() => {
    if (!sichtbar) return;
    const el = ref.current;
    if (!el) return;
    const vorher = document.activeElement;
    const ausloeser = vorher && vorher !== document.body && !el.contains(vorher) ? vorher : null;
    if (!el.contains(vorher)) (rumpf.current ?? el).focus({ preventScroll: true });
    return () => {
      const a = document.activeElement;
      if (a && a !== document.body && !el.contains(a)) return;
      if (ausloeser instanceof HTMLElement && ausloeser.isConnected
          && ausloeser.getClientRects().length > 0) {
        ausloeser.focus({ preventScroll: true });
        return;
      }
      const naechstes = [...stapel].reverse().find((x) => x !== id && rahmen.has(x));
      const ziel = naechstes ? rahmen.get(naechstes) : null;
      ziel?.querySelector<HTMLElement>("[data-panel-body]")?.focus({ preventScroll: true });
    };
  }, [sichtbar, id]);

  const merken = (b: PanelBox) => {
    try { localStorage.setItem(schluessel(id), JSON.stringify(b)); } catch { }
  };

  const zug = useRef<{ art: "move" | "w" | "wl" | "h" | "wh"; x: number; y: number; b: PanelBox;
                       hJetzt: number } | null>(null);
  const zuletzt = useRef<PanelBox | null>(null);
  useEffect(() => {
    const move = (e: PointerEvent) => {
      const s = zug.current;
      const f = jetzt.current.flaeche;
      if (!s || !f) return;
      const dx = e.clientX - s.x, dy = e.clientY - s.y;
      let n: PanelBox;
      if (s.art === "move") {
        n = klemmen({ ...s.b, x: s.b.x + dx, y: s.b.y + dy }, f);
      } else if (s.art === "wl") {
        const rechts = s.b.x + s.b.w;
        const w = Math.min(Math.max(MIN_W, s.b.w - dx), rechts);
        n = { ...s.b, x: rechts - w, w };
      } else {
        const w = s.art === "h" ? s.b.w
          : Math.min(Math.max(MIN_W, s.b.w + dx), Math.max(MIN_W, f.width - s.b.x));
        const h = s.art === "w" ? s.b.h
          : Math.min(Math.max(MIN_H, s.hJetzt + dy), Math.max(MIN_H, f.height - s.b.y - GAP));
        n = { ...s.b, w, h };
      }
      zuletzt.current = n;
      setBox(n);
    };
    const up = () => {
      if (zug.current && zuletzt.current) merken(zuletzt.current);
      zug.current = null;
      zuletzt.current = null;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const start = (art: "move" | "w" | "wl" | "h" | "wh") => (e: React.PointerEvent) => {
    const b = jetzt.current.shown;
    if (!b || e.button !== 0) return;
    if (art === "move" && (e.target as Element).closest?.(NICHT_ZIEHEN)) return;
    e.preventDefault();
    zug.current = { art, x: e.clientX, y: e.clientY, b,
                    hJetzt: ref.current?.offsetHeight ?? MIN_H };
    heben(id);
  };

  const ctx = useMemo<PanelCtx>(() => ({
    titleId,
    ziehen: (e) => start("move")(e),
    nachInhalt: (e) => {
      if ((e.target as Element).closest?.(NICHT_ZIEHEN)) return;
      setBox((b) => {
        if (!b || b.h == null) return b;
        const n = { ...b, h: null };
        merken(n);
        return n;
      });
    },
    kopfDa: () => {
      setKoepfe((k) => k + 1);
      return () => setKoepfe((k) => k - 1);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [titleId, id]);

  useLayoutEffect(() => {
    if (!figureGap || !sichtbar) { setFigurNah(false); return; }
    const el = ref.current, r = rumpf.current;
    if (!el || !r) return;
    const pruefen = () => {
      const { shown: s, flaeche: f } = jetzt.current;
      if (!s || !f) return;
      const frei = parseFloat(getComputedStyle(r).paddingBottom) || 0;
      const rand = el.offsetHeight - r.clientHeight;
      const hoch = s.h ?? Math.min(f.height - s.y - GAP, rand + r.scrollHeight - frei);
      setFigurNah(s.y + hoch > f.height - FIGUR.h && s.x + s.w > f.width - FIGUR.w);
    };
    pruefen();
    const ro = new ResizeObserver(pruefen);
    ro.observe(el);
    if (r.firstElementChild) ro.observe(r.firstElementChild);
    return () => ro.disconnect();
  }, [figureGap, sichtbar, shown?.x, shown?.y, shown?.w, shown?.h, flaeche?.width, flaeche?.height]);

  if (!shown) return <div ref={ref} className="hidden" />;

  return (
    <div ref={ref} data-testid={testid} data-panel-id={id} role="region"
      aria-labelledby={titleId} data-height={shown.h == null && fit ? "content" : "fixed"}
      onPointerDownCapture={() => heben(id)} onFocus={() => heben(id)}
      className={`absolute flex flex-col overflow-hidden rounded-md border border-line bg-raised
        shadow-2xl${hidden ? " hidden" : ""}`}
      style={{ left: shown.x, top: shown.y, width: shown.w,
               height: shown.h ?? (fit ? undefined : maxH), maxHeight: maxH,
               zIndex: Z.windowBase + Math.max(0, platz) }}>
      <Ctx.Provider value={ctx}>
        {koepfe === 0 && (
          <Kopfleiste title={title} onClose={() => schliessen.current()} />
        )}
        <div ref={rumpf} tabIndex={-1} data-panel-body=""
          className={`min-h-0 flex-auto overflow-auto outline-none focus-visible:ring-2
            focus-visible:ring-inset focus-visible:ring-accent${figureGap && figurNah
              ? " pb-24 [scroll-padding-bottom:6rem]" : ""}`}>
          {children}
        </div>
      </Ctx.Provider>
      <div onPointerDown={start("wl")} data-testid="panel-resize-wl" title="drag to resize"
        className="absolute top-0 left-0 w-1.5 h-full cursor-ew-resize hover:bg-accent/40" />
      <div onPointerDown={start("w")} data-testid="panel-resize-w" title="drag to resize"
        className="absolute top-0 right-0 w-1.5 h-full cursor-ew-resize hover:bg-accent/40" />
      <div onPointerDown={start("h")} data-testid="panel-resize-h"
        className="absolute bottom-0 left-0 h-1.5 w-full cursor-ns-resize" />
      <div onPointerDown={start("wh")}
        className="absolute bottom-0 right-0 h-3 w-3 cursor-nwse-resize" />
    </div>
  );
}

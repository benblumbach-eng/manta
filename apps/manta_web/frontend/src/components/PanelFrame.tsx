import { useCallback, useEffect, useRef, useState } from "react";


export type PanelBox = { x: number; y: number; w: number; h: number };

const MIN_W = 320;
const MIN_H = 180;
const GAP = 10;

let zTop = 30;

const belegt = new Map<string, PanelBox>();

function laden(id: string): PanelBox | null {
  try {
    const roh = localStorage.getItem(`manta-panel-${id}`);
    if (!roh) return null;
    const b = JSON.parse(roh) as PanelBox;
    return [b.x, b.y, b.w, b.h].every((v) => typeof v === "number" && Number.isFinite(v))
      ? b : null;
  } catch { return null; }
}

function freierPlatz(w: number, flaeche: { width: number; height: number }): PanelBox {
  const h = Math.max(MIN_H, flaeche.height - 2 * GAP);
  const y = GAP;
  let x = flaeche.width - w - GAP;
  for (let i = 0; i < 8; i++) {
    const stoert = [...belegt.values()].filter((b) =>
      x < b.x + b.w && x + w > b.x && y < b.y + b.h && y + h > b.y);
    if (stoert.length === 0) return { x, y, w, h };
    const linkeste = Math.min(...stoert.map((b) => b.x));
    x = linkeste - w - GAP;
    if (x < GAP) return { x: Math.max(GAP, flaeche.width - w - GAP), y, w, h };
  }
  return { x: Math.max(GAP, x), y, w, h };
}

export default function PanelFrame({ id, defaultWidth = 520, testid, hidden = false, children }: {
  id: string;
  defaultWidth?: number;
  testid?: string;
  hidden?: boolean;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<PanelBox | null>(null);
  const [z, setZ] = useState(() => ++zTop);
  const zieht = useRef<{ art: "move" | "w" | "h" | "wh"; x: number; y: number; b: PanelBox } | null>(null);

  useEffect(() => {
    if (!box) return;
    if (hidden) { belegt.delete(id); return; }
    belegt.set(id, box);
    setZ(++zTop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hidden]);

  useEffect(() => {
    if (hidden || box) return;
    const eltern = ref.current?.parentElement;
    const flaeche = eltern
      ? { width: eltern.clientWidth, height: eltern.clientHeight }
      : { width: window.innerWidth, height: window.innerHeight };
    const b = laden(id) ?? freierPlatz(defaultWidth, flaeche);
    const sicher: PanelBox = {
      x: Math.min(Math.max(-b.w + 80, b.x), Math.max(0, flaeche.width - 80)),
      y: Math.min(Math.max(0, b.y), Math.max(0, flaeche.height - 60)),
      w: Math.max(MIN_W, Math.min(b.w, flaeche.width)),
      h: Math.max(MIN_H, Math.min(b.h, flaeche.height)),
    };
    setBox(sicher);
    belegt.set(id, sicher);
    return () => { belegt.delete(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, defaultWidth, hidden]);

  const merken = useCallback((b: PanelBox) => {
    belegt.set(id, b);
    try { localStorage.setItem(`manta-panel-${id}`, JSON.stringify(b)); } catch { }
  }, [id]);

  useEffect(() => {
    const move = (e: PointerEvent) => {
      const s = zieht.current;
      if (!s || !box) return;
      const dx = e.clientX - s.x, dy = e.clientY - s.y;
      const n: PanelBox = s.art === "move"
        ? { ...s.b, x: s.b.x + dx, y: Math.max(0, s.b.y + dy) }
        : { ...s.b,
            w: s.art === "h" ? s.b.w : Math.max(MIN_W, s.b.w + dx),
            h: s.art === "w" ? s.b.h : Math.max(MIN_H, s.b.h + dy) };
      setBox(n);
    };
    const up = () => {
      if (zieht.current && box) merken(box);
      zieht.current = null;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [box, merken]);

  const start = (art: "move" | "w" | "h" | "wh") => (e: React.PointerEvent) => {
    if (!box) return;
    e.preventDefault();
    zieht.current = { art, x: e.clientX, y: e.clientY, b: box };
    setZ(++zTop);
  };

  if (!box) return <div ref={ref} className="hidden" />;

  return (
    <div ref={ref} data-testid={testid} data-panel-id={id}
      onPointerDown={() => setZ(++zTop)}
      className={`absolute bg-slate-900 border border-slate-700 shadow-2xl flex flex-col${hidden ? " hidden" : ""}`}
      style={{ left: box.x, top: box.y, width: box.w, height: box.h, zIndex: z }}>
      <div data-testid="panel-grip" onPointerDown={start("move")}
        className="h-4 shrink-0 cursor-move bg-slate-800/80 border-b border-slate-700
                   flex items-center justify-center">
        <span className="text-slate-600 text-[9px] leading-none tracking-[0.3em]">···</span>
      </div>
      <div className="flex-1 min-h-0 overflow-auto">{children}</div>
      <div onPointerDown={start("w")} data-testid="panel-resize-w"
        className="absolute top-0 right-0 w-1.5 h-full cursor-ew-resize" />
      <div onPointerDown={start("h")}
        className="absolute bottom-0 left-0 h-1.5 w-full cursor-ns-resize" />
      <div onPointerDown={start("wh")}
        className="absolute bottom-0 right-0 h-3 w-3 cursor-nwse-resize" />
    </div>
  );
}

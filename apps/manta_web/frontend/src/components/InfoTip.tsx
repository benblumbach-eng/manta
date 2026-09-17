import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export default function InfoTip({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const place = useCallback(() => {
    if (!btnRef.current) return;
    const b = btnRef.current.getBoundingClientRect();
    const W = 320, M = 12;
    let left = Math.min(b.right - W, window.innerWidth - W - M);
    left = Math.max(M, left);
    const h = panelRef.current?.offsetHeight ?? 200;
    const top = b.bottom + 6 + h > window.innerHeight - M ? Math.max(M, b.top - h - 6) : b.bottom + 6;
    setPos({ top, left });
  }, []);

  useLayoutEffect(() => { if (open) place(); }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!panelRef.current?.contains(e.target as Node) && !btnRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, place]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        data-testid="infotip-button"
        aria-label={`Explanation: ${title}`}
        aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        className="ml-1 inline-grid place-items-center w-4 h-4 shrink-0 rounded-full border border-slate-600
                   text-slate-400 text-[10px] leading-none align-middle
                   hover:border-cyan-400 hover:text-cyan-300"
      >
        ?
      </button>
      {open && createPortal(
        <div
          ref={panelRef}
          data-testid="infotip-panel"
          role="tooltip"
          style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, width: 320 }}
          className="fixed z-[100] rounded-md border border-slate-600 bg-slate-950/98 p-3 shadow-2xl
                     text-xs leading-relaxed text-slate-300 backdrop-blur"
        >
          <div className="flex items-start justify-between gap-2 mb-1">
            <span className="font-medium text-slate-100">{title}</span>
            <button onClick={() => setOpen(false)} aria-label="close"
              className="text-slate-500 hover:text-slate-200 leading-none">✕</button>
          </div>
          <div className="space-y-1.5">{children}</div>
        </div>,
        document.body,
      )}
    </>
  );
}

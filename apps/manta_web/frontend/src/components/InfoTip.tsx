import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Z } from "../design/layers";

export type AskAssistant = { question: string; concept: string };
export const ASK_EVENT = "manta:ask";

export default function InfoTip({ title, children, ask }:
  { title: string; children: React.ReactNode; ask?: AskAssistant }) {
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
        className="ml-1 inline-grid place-items-center w-4 h-4 shrink-0 rounded-full border border-line-strong
                   text-fg-muted text-2xs leading-none align-middle
                   hover:border-accent hover:text-accent"
      >
        ?
      </button>
      {open && createPortal(
        <div
          ref={panelRef}
          data-testid="infotip-panel"
          role="tooltip"
          data-popup=""
          style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, width: 320, zIndex: Z.tip }}
          className="fixed rounded-md border border-line bg-overlay p-3 shadow-2xl
                     text-xs leading-relaxed text-fg"
        >
          <div className="flex items-start justify-between gap-2 mb-1">
            <span className="font-medium text-fg">{title}</span>
            <button onClick={() => setOpen(false)} aria-label="close"
              className="text-fg-muted hover:text-fg leading-none">✕</button>
          </div>
          <div className="space-y-2">{children}</div>
          {ask && (
            <button data-testid="infotip-ask"
              onClick={() => {
                setOpen(false);
                window.dispatchEvent(new CustomEvent<AskAssistant>(ASK_EVENT, { detail: ask }));
              }}
              className="mt-2 text-accent hover:underline text-left">
              ask the assistant: “{ask.question}” →
            </button>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}

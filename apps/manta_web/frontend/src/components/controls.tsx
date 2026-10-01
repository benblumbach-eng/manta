import { useEffect, useRef, useState, type ReactNode } from "react";
import InfoTip from "./InfoTip";


export function Segmented<T extends string>({ value, options, onChange, testid, label }: {
  value: T;
  options: { value: T; label: string; disabled?: boolean; reason?: string; testid?: string }[];
  onChange: (v: T) => void;
  testid?: string;
  label?: string;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {label && <span className="text-[10px] uppercase tracking-wide text-slate-500">{label}</span>}
      <span data-testid={testid}
        className="inline-flex rounded-md border border-slate-700 bg-slate-900/60 p-0.5">
        {options.map((o) => {
          const aktiv = o.value === value;
          return (
            <span key={o.value} className="inline-flex items-center">
              <button data-testid={o.testid} disabled={o.disabled}
                aria-pressed={aktiv}
                onClick={() => !o.disabled && onChange(o.value)}
                className={`px-2.5 py-1 text-xs rounded transition-colors ${
                  o.disabled ? "text-slate-600 cursor-not-allowed"
                  : aktiv ? "bg-slate-700 text-cyan-300"
                  : "text-slate-400 hover:text-slate-200"}`}>
                {o.label}
              </button>
              {o.disabled && o.reason && (
                <InfoTip title={`${o.label} — not available here`}><p>{o.reason}</p></InfoTip>
              )}
            </span>
          );
        })}
      </span>
    </span>
  );
}

export function Chooser({ label, summary, count, children, testid, disabled, reason,
                         closeOnPick = false }: {
  label: string;
  summary?: string;
  count?: number;
  children: ReactNode;
  testid?: string;
  disabled?: boolean;
  reason?: string;
  closeOnPick?: boolean;
}) {
  const [offen, setOffen] = useState(false);
  const huelle = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (!offen) return;
    const daneben = (e: MouseEvent) => {
      if (huelle.current && !huelle.current.contains(e.target as Node)) setOffen(false);
    };
    const taste = (e: KeyboardEvent) => { if (e.key === "Escape") setOffen(false); };
    document.addEventListener("mousedown", daneben);
    document.addEventListener("keydown", taste);
    return () => {
      document.removeEventListener("mousedown", daneben);
      document.removeEventListener("keydown", taste);
    };
  }, [offen]);

  return (
    <span className="relative inline-flex items-center" ref={huelle}>
      <button data-testid={testid} disabled={disabled} aria-expanded={offen}
        onClick={() => !disabled && setOffen((v) => !v)}
        className={`inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded-md border
          transition-colors ${disabled
            ? "border-slate-800 text-slate-600 cursor-not-allowed"
            : count
              ? "border-cyan-500/60 bg-cyan-500/10 text-cyan-200 hover:border-cyan-400"
              : "border-slate-700 text-slate-400 hover:text-slate-200 hover:border-slate-500"}`}>
        <span>{label}</span>
        {summary && <span className="text-slate-300">{summary}</span>}
        {count ? (
          <span className="rounded-full bg-cyan-500/20 px-1.5 text-[10px] tabular-nums">{count}</span>
        ) : null}
        <span className="text-[9px] opacity-70">▾</span>
      </button>
      {disabled && reason && (
        <InfoTip title={`${label} — not available here`}><p>{reason}</p></InfoTip>
      )}
      {offen && !disabled && (
        <span data-testid={testid ? `${testid}-panel` : undefined}
          onClick={() => { if (closeOnPick) setOffen(false); }}
          className="absolute left-0 top-full z-30 mt-1 min-w-[15rem] max-h-72 overflow-auto
                     rounded-md border border-slate-600 bg-slate-900 p-1 shadow-xl">
          {children}
        </span>
      )}
    </span>
  );
}

export function ChooserGroup({ label }: { label: string }) {
  return (
    <div className="px-2 pt-1.5 pb-0.5 text-[9px] uppercase tracking-wide text-slate-500">
      {label}
    </div>
  );
}

export function ChooserRow({ checked, onToggle, label, hint, colour, testid, radio = false,
                            disabled = false }: {
  checked: boolean; onToggle: () => void; label: string; hint?: string;
  colour?: string; testid?: string; radio?: boolean;
  disabled?: boolean;
}) {
  return (
    <button data-testid={testid} onClick={() => !disabled && onToggle()} disabled={disabled}
      aria-checked={checked} role={radio ? "radio" : "checkbox"}
      className={`flex w-full items-start gap-2 rounded px-2 py-1 text-left text-xs
        ${disabled ? "opacity-50 cursor-not-allowed"
          : checked ? "bg-slate-800" : "hover:bg-slate-800/60"}`}>
      <span className={`mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center border
        ${radio ? "rounded-full" : "rounded-[3px]"}
        ${checked ? "border-cyan-400 bg-cyan-500/20 text-cyan-300" : "border-slate-600"}`}>
        {checked && <span className="text-[9px] leading-none">{radio ? "●" : "✓"}</span>}
      </span>
      <span className="min-w-0">
        <span className="flex items-center gap-1.5 text-slate-200">
          {colour && <span className="inline-block h-0.5 w-3 shrink-0" style={{ background: colour }} />}
          {label}
        </span>
        {hint && <span className="block text-[10px] text-slate-500">{hint}</span>}
      </span>
    </button>
  );
}

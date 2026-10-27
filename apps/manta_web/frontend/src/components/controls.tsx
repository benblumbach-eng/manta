import { useEffect, useRef, useState, type ReactNode } from "react";
import InfoTip from "./InfoTip";


export function Segmented<T extends string>({ value, options, onChange, testid, label, full = false }: {
  value: T;
  options: { value: T; label: string; disabled?: boolean; reason?: string; title?: string;
             testid?: string }[];
  onChange: (v: T) => void;
  testid?: string;
  label?: string;
  full?: boolean;
}) {
  return (
    <span className={`${full ? "flex w-full" : "inline-flex"} items-center gap-2`}>
      {label && <span className="text-xs text-fg-muted">{label}</span>}
      <span data-testid={testid}
        className={`${full ? "flex flex-1" : "inline-flex"} rounded-md border border-line bg-surface p-1`}>
        {options.map((o) => {
          const aktiv = o.value === value;
          return (
            <span key={o.value} className={`${full ? "flex flex-1" : "inline-flex"} items-center`}>
              <button data-testid={o.testid} disabled={o.disabled} title={o.title}
                aria-pressed={aktiv}
                onClick={() => !o.disabled && onChange(o.value)}
                className={`${full ? "flex-1 " : ""}px-3 py-1 text-xs rounded transition-colors ${
                  o.disabled ? "text-fg-disabled cursor-not-allowed"
                  : aktiv ? "bg-control-strong text-fg font-medium shadow-sm"
                  : "text-fg-muted hover:text-fg"}`}>
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
        className={`inline-flex items-center gap-1 px-3 py-1 text-xs rounded-md border
          transition-colors ${disabled
            ? "border-line-subtle text-fg-disabled cursor-not-allowed"
            : count
              ? "border-accent/60 bg-accent-soft text-accent hover:border-accent"
              : "border-line text-fg-muted hover:text-fg hover:border-line-strong"}`}>
        <span>{label}</span>
        {summary && <span className="text-fg">{summary}</span>}
        {count ? (
          <span className="rounded-full bg-accent-soft px-2 text-2xs tabular-nums">{count}</span>
        ) : null}
        <span aria-hidden className="text-2xs">▾</span>
      </button>
      {disabled && reason && (
        <InfoTip title={`${label} — not available here`}><p>{reason}</p></InfoTip>
      )}
      {offen && !disabled && (
        <span data-testid={testid ? `${testid}-panel` : undefined} data-popup=""
          onClick={() => { if (closeOnPick) setOffen(false); }}
          className="absolute left-0 top-full z-30 mt-1 min-w-[15rem] max-h-72 overflow-auto
                     rounded-md border border-line bg-overlay p-1 shadow-xl">
          {children}
        </span>
      )}
    </span>
  );
}

export function ChooserGroup({ label }: { label: string }) {
  return (
    <div className="px-2 pt-2 pb-1 text-2xs font-semibold text-fg-muted">
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
          : checked ? "bg-control" : "hover:bg-control/60"}`}>
      <span className={`mt-1 flex h-3.5 w-3.5 shrink-0 items-center justify-center border
        ${radio ? "rounded-full" : "rounded-[3px]"}
        ${checked ? "border-accent bg-accent-soft text-accent" : "border-line-strong"}`}>
        {checked && <span className="text-2xs leading-none">{radio ? "●" : "✓"}</span>}
      </span>
      <span className="min-w-0">
        <span className="flex items-center gap-2 text-fg">
          {colour && <span className="inline-block h-0.5 w-3 shrink-0" style={{ background: colour }} />}
          {label}
        </span>
        {hint && <span className="block text-2xs text-fg-muted">{hint}</span>}
      </span>
    </button>
  );
}

export function SliderNumber({ value, fallback, min, max, step = 1, steps, onChange, testid, label,
                              prefix, suffix }: {
  value: number | null; fallback: number; min: number; max: number; step?: number; steps?: number[];
  onChange: (v: number) => void; testid: string; label: string; prefix?: string; suffix?: string;
}) {
  const [text, setText] = useState(value != null ? String(value) : "");
  useEffect(() => {
    if (Number(text.replace(",", ".")) !== value) setText(value != null ? String(value) : "");
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  const v = value ?? fallback;
  const i = steps ? Math.max(0, steps.reduce((best, s, k) => (s <= v ? k : best), -1)) : 0;
  return (
    <div className="flex items-center gap-2 text-xs text-fg">
      {steps ? (
        <input data-testid={testid} type="range" min={0} max={steps.length - 1} step={1}
          aria-label={label} value={i}
          onChange={(e) => onChange(steps[Number(e.target.value)])}
          className="flex-1 accent-accent-fill" />
      ) : (
        <input data-testid={testid} type="range" min={min} max={max} step={step}
          aria-label={label} value={v}
          onChange={(e) => onChange(Number(e.target.value))}
          className="flex-1 accent-accent-fill" />
      )}
      {prefix && <span>{prefix}</span>}
      <input data-testid={`${testid}-value`} type="text" inputMode="decimal" value={text}
        placeholder="off" aria-label={label}
        onChange={(e) => {
          setText(e.target.value);
          const n = Number(e.target.value.replace(",", "."));
          if (e.target.value.trim() !== "" && Number.isFinite(n) && n >= min && n <= max) onChange(n);
        }}
        className="w-14 px-1 py-0.5 rounded-md bg-control border border-line-strong text-fg tabular-nums text-right" />
      {suffix && <span>{suffix}</span>}
    </div>
  );
}

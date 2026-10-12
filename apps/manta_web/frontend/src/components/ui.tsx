import { useEffect, useId, useRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { createPortal } from "react-dom";
import ErrorNotice from "./ErrorNotice";
import { Z } from "../design/layers";


type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

const BASE = "inline-flex items-center justify-center gap-1 rounded-md font-medium whitespace-nowrap "
  + "transition-colors disabled:cursor-not-allowed";
const SIZES: Record<Size, string> = {
  sm: "px-2 py-1 text-xs",
  md: "px-3 py-2 text-sm",
};
const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent-fill text-on-accent hover:bg-accent-fill-hover "
    + "disabled:bg-control disabled:text-fg-disabled",
  secondary: "border border-line-strong text-fg hover:bg-control "
    + "disabled:border-line disabled:text-fg-disabled disabled:hover:bg-transparent",
  ghost: "text-fg-muted hover:text-fg hover:bg-control disabled:text-fg-disabled "
    + "disabled:hover:bg-transparent",
  danger: "bg-danger-fill text-on-accent hover:brightness-90 "
    + "disabled:bg-control disabled:text-fg-disabled disabled:hover:brightness-100",
};

export const buttonClass = (variant: Variant = "secondary", size: Size = "sm", extra = "") =>
  `${BASE} ${SIZES[size]} ${VARIANTS[variant]}${extra ? ` ${extra}` : ""}`;

export function Button({ variant = "secondary", size = "sm", reason, className, title, type,
                         children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant; size?: Size;
  reason?: string | null;
}) {
  return (
    <button type={type ?? "button"} {...rest}
      title={rest.disabled && reason ? reason : title}
      className={buttonClass(variant, size, className)}>
      {children}
    </button>
  );
}

export function ToggleButton({ pressed, className, type, children, ...rest }:
  ButtonHTMLAttributes<HTMLButtonElement> & { pressed: boolean }) {
  return (
    <button type={type ?? "button"} aria-pressed={pressed} {...rest}
      className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs ring-1 ring-inset
        transition-colors disabled:cursor-not-allowed disabled:text-fg-disabled ${pressed
          ? "ring-accent/60 bg-accent-soft text-accent font-medium"
          : "ring-line text-fg hover:bg-control"}${className ? ` ${className}` : ""}`}>
      {children}
    </button>
  );
}

export function TextButton({ className, type, children, ...rest }:
  ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type={type ?? "button"} {...rest}
      className={`underline underline-offset-2 text-accent hover:text-fg disabled:text-fg-disabled
        disabled:no-underline disabled:cursor-not-allowed${className ? ` ${className}` : ""}`}>
      {children}
    </button>
  );
}

export function SectionHeading({ children, aside, className, testid, as = "h3" }: {
  children: ReactNode; aside?: ReactNode; className?: string; testid?: string;
  as?: "h2" | "h3" | "h4" | "div";
}) {
  const Tag = as;
  return (
    <div className={`flex items-center gap-2${className ? ` ${className}` : ""}`}>
      <Tag data-testid={testid} className="text-xs font-semibold text-fg-muted">{children}</Tag>
      {aside && <div className="ml-auto flex items-center gap-1">{aside}</div>}
    </div>
  );
}

export function StateNotice({ state, children, error, what, onRetry, testid, inline = false,
                              className }: {
  state: "loading" | "empty" | "error";
  children?: ReactNode;
  error?: unknown; what?: string; onRetry?: () => void;
  testid?: string; inline?: boolean; className?: string;
}) {
  if (state === "error") {
    return <ErrorNotice error={error} what={what ?? "Something could not be loaded."}
      onRetry={onRetry} testid={testid ?? "error"} inline={inline} />;
  }
  return (
    <p data-testid={testid} role={state === "loading" ? "status" : undefined}
      aria-live={state === "loading" ? "polite" : undefined}
      className={`${inline ? "" : "p-4 "}text-xs text-fg-muted${className ? ` ${className}` : ""}`}>
      {state === "loading" && (
        <span aria-hidden className="mr-2 inline-block h-2 w-2 animate-pulse rounded-full bg-accent align-middle" />
      )}
      {children}
    </p>
  );
}

const offeneDialoge: string[] = [];

export function Dialog({ title, onClose, children, testid, width = "max-w-lg", footer,
                         closeLabel = "close", closeTestid, scroll = true, page = false }: {
  title: ReactNode;
  onClose?: () => void;
  children: ReactNode;
  testid?: string;
  width?: string;
  footer?: ReactNode;
  closeLabel?: string;
  closeTestid?: string;
  scroll?: boolean;
  page?: boolean;
}) {
  const id = useId();
  const karte = useRef<HTMLDivElement>(null);
  const zuvor = useRef<Element | null>(null);
  const schliessen = useRef(onClose);
  schliessen.current = onClose;

  useEffect(() => {
    zuvor.current = document.activeElement;
    offeneDialoge.push(id);
    const el = karte.current;
    const ziel = el?.querySelector<HTMLElement>(
      "input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled])")
      ?? el?.querySelector<HTMLElement>("button:not([disabled]):not([data-dialog-close])")
      ?? el;
    ziel?.focus({ preventScroll: true });
    const taste = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || offeneDialoge[offeneDialoge.length - 1] !== id) return;
      if (!schliessen.current) return;
      if (document.querySelector("[data-testid=infotip-panel]")) return;
      e.stopPropagation();
      schliessen.current();
    };
    document.addEventListener("keydown", taste, true);
    return () => {
      document.removeEventListener("keydown", taste, true);
      const i = offeneDialoge.lastIndexOf(id);
      if (i >= 0) offeneDialoge.splice(i, 1);
      const z = zuvor.current;
      if (z instanceof HTMLElement && document.contains(z)) z.focus({ preventScroll: true });
    };
  }, [id]);

  if (page) {
    return createPortal(
      <div ref={karte} role="dialog" aria-modal="true" aria-labelledby={`${id}-t`} tabIndex={-1}
        data-testid={testid} style={{ zIndex: Z.modal }}
        className="fixed inset-0 overflow-y-auto bg-surface text-fg outline-none
                   [scroll-padding-bottom:6rem]">
        <div className="mx-auto max-w-3xl px-6 pt-6 pb-24">
          <div className="mb-6 flex items-center gap-2">
            <h2 id={`${id}-t`} className="text-xl font-semibold">{title}</h2>
            {onClose && (
              <Button data-dialog-close onClick={onClose} aria-label={closeLabel} className="ml-auto"
                data-testid={closeTestid ?? (testid ? `${testid}-x` : undefined)}>
                ✕ {closeLabel}
              </Button>
            )}
          </div>
          {children}
        </div>
      </div>, document.body);
  }
  return createPortal(
    <div data-testid={testid ? `${testid}-scrim` : undefined} style={{ zIndex: Z.modal }}
      className="fixed inset-0 grid place-items-center bg-scrim p-4">
      <div ref={karte} role="dialog" aria-modal="true" aria-labelledby={`${id}-t`} tabIndex={-1}
        data-testid={testid}
        className={`flex max-h-[calc(100vh-2rem)] w-full ${width} flex-col rounded-lg border
                    border-line bg-overlay text-fg shadow-2xl outline-none`}>
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <h2 id={`${id}-t`} className="text-sm font-semibold">{title}</h2>
          {onClose && (
            <button type="button" data-dialog-close onClick={onClose} aria-label={closeLabel}
              data-testid={closeTestid ?? (testid ? `${testid}-x` : undefined)}
              className="ml-auto rounded-md px-2 py-1 text-fg-muted hover:bg-control hover:text-fg">
              ✕
            </button>
          )}
        </div>
        <div className={`px-4 py-4 ${scroll ? "overflow-y-auto" : ""}`}>{children}</div>
        {footer && (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-4 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>, document.body);
}

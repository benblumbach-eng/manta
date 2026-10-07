import { useState } from "react";

export default function StarButton({ starred, onToggle, testid = "star", label }: {
  starred: boolean;
  onToggle: (next: boolean) => Promise<unknown>;
  testid?: string;
  label: string;
}) {
  const [on, setOn] = useState(starred);
  const [busy, setBusy] = useState(false);

  const [seen, setSeen] = useState(starred);
  if (seen !== starred) { setSeen(starred); setOn(starred); }

  return (
    <button
      data-testid={testid}
      aria-pressed={on}
      aria-label={on ? `Remove the mark from ${label}` : `Mark ${label}`}
      title={on ? "marked — click to remove" : "mark this to come back to it"}
      disabled={busy}
      onClick={async () => {
        const next = !on;
        setOn(next); setBusy(true);
        try {
          await onToggle(next);
        } catch {
          setOn(!next);
        } finally {
          setBusy(false);
        }
      }}
      className={`px-1 leading-none text-base transition-colors disabled:opacity-50 ${on
        ? "text-amber-300 hover:text-amber-200"
        : "text-slate-600 hover:text-amber-300"}`}
    >
      {on ? "★" : "☆"}
    </button>
  );
}

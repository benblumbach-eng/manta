import type { Capabilities, Capability } from "../api";

export default function DataAvailability({ caps, testid = "capabilities", omit = [] }:
  { caps: Capabilities; testid?: string;
    omit?: string[] }) {
  return (
    <dl data-testid={testid} className="text-2xs leading-snug">
      {caps.items.filter((c) => !omit.includes(c.key)).map((c) => (
        <div key={c.key} data-testid={`cap-${c.key}`}
          title={c.detail + (c.per_rank
            ? ` Assigned per rank: ${Object.entries(c.per_rank).map(([r, n]) => `${r} ${n}`)
                .join(" · ")} of ${c.total}.` : "")}
          className="flex items-baseline gap-2 py-px">
          <dt className="text-fg-muted shrink-0">{c.label}</dt>
          <dd className={`truncate ${c.available ? "text-fg" : "text-warn"}`}>
            {c.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function NotAvailable({ cap, testid }: { cap?: Capability; testid?: string }) {
  return (
    <p data-testid={testid} className="text-xs text-warn leading-snug">
      Not available for this dataset
      {cap && <> — {cap.detail}</>}
    </p>
  );
}

export const findCap = (caps: Capabilities | undefined, key: Capability["key"]) =>
  caps?.items.find((c) => c.key === key);

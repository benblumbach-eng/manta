import type { Capabilities, Capability } from "../api";
import InfoTip from "./InfoTip";

export default function DataAvailability({ caps, testid = "capabilities" }:
  { caps: Capabilities; testid?: string }) {
  return (
    <dl data-testid={testid} className="text-2xs leading-snug">
      {caps.items.map((c) => (
        <div key={c.key} data-testid={`cap-${c.key}`}
          className="flex items-baseline gap-2 py-px">
          <dt className="text-fg-muted shrink-0">{c.label}</dt>
          <dd className={`truncate ${c.available ? "text-fg" : "text-warn"}`}>
            {c.value}
          </dd>
          <dd className="ml-auto shrink-0">
            <InfoTip title={c.label}>
              <p>{c.detail}</p>
              {c.per_rank && (
                <p>Assigned per rank:{" "}
                  {Object.entries(c.per_rank).map(([r, n]) => `${r} ${n}`).join(" · ")} of{" "}
                  {c.total}.</p>
              )}
            </InfoTip>
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

import { useState } from "react";
import type { Criterion2Texts } from "../api";
import { TextButton } from "./ui";

export default function Criterion2Declaration({ c2, verdict, testid, open = false }: {
  c2: Criterion2Texts;
  verdict: string;
  testid: string;
  open?: boolean;
}) {
  const [how, setHow] = useState(open);
  return (
    <div data-testid={testid} className="space-y-1 text-xs leading-snug">
      <p className="text-fg" data-testid={`${testid}-verdict`}>{verdict}</p>
      <p className="text-fg-muted" data-testid={`${testid}-not-keystone`}>{c2.not_keystone}</p>
      <p className="text-fg-muted" data-testid={`${testid}-selection`}>{c2.selection_note}</p>
      {!open && (
        <TextButton data-testid={`${testid}-how`} aria-expanded={how}
          onClick={() => setHow((v) => !v)}>
          {how ? "hide the computation" : "how it is computed"}
        </TextButton>
      )}
      {how && (
        <>
          <p className="text-fg-muted" data-testid={`${testid}-method`}>{c2.method}</p>
          <p className="text-fg-muted" data-testid={`${testid}-source`}>Source: {c2.source}</p>
        </>
      )}
    </div>
  );
}

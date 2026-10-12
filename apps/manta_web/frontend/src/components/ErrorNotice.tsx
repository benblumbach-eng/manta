import { describeError } from "../api";
import { Button } from "./ui";

export default function ErrorNotice({ error, what, onRetry, testid = "error", inline = false }: {
  error: unknown;
  what: string;
  onRetry?: () => void;
  testid?: string;
  inline?: boolean;
}) {
  const d = describeError(error);
  const todo = onRetry && d.todo === "Try again." ? null : d.todo;
  return (
    <div role="alert" data-testid={testid} data-kind={d.kind}
      className={`${inline ? "" : "m-4 "}rounded-md border border-danger bg-danger-soft px-3 py-2 text-xs`}>
      <p className="font-medium text-danger" data-testid={`${testid}-what`}>{what}</p>
      <p className="mt-1 text-danger break-words" data-testid={`${testid}-why`}>{d.why}</p>
      {(todo || onRetry) && (
        <p className="mt-1 flex flex-wrap items-center gap-2 text-fg-muted" data-testid={`${testid}-todo`}>
          {todo && <span>{todo}</span>}
          {onRetry && (
            <Button data-testid={`${testid}-retry`} onClick={onRetry}>Try again</Button>
          )}
        </p>
      )}
    </div>
  );
}

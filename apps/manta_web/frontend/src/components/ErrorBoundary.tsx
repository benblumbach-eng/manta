import { Button } from "./ui";
import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = { children: ReactNode; label?: string };
type State = { error: Error | null };

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("MANTA: render failed", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div data-testid="error-boundary" role="alert"
        className="h-full w-full grid place-items-center p-6 bg-surface">
        <div className="max-w-lg rounded border border-danger bg-danger-soft p-4 text-sm">
          <div className="text-danger font-medium">
            {this.props.label ?? "This view"} could not be drawn.
          </div>
          <p className="mt-2 text-fg leading-snug">
            Something in the code failed while rendering — not the database. The data that was
            already loaded is unaffected, and nothing has been changed or deleted.
          </p>
          <pre className="mt-2 max-h-32 overflow-auto rounded bg-surface p-2 font-mono
                          text-2xs leading-tight text-fg-muted whitespace-pre-wrap">
            {error.message || String(error)}
          </pre>
          <div className="mt-3 flex gap-2">
            <Button data-testid="error-boundary-retry"
              onClick={() => this.setState({ error: null })}>
              Try drawing it again
            </Button>
            <Button data-testid="error-boundary-reload"
              onClick={() => window.location.reload()}>
              Reload the page
            </Button>
          </div>
          <p className="mt-2 text-2xs text-fg-muted">
            The full stack is in the browser console.
          </p>
        </div>
      </div>
    );
  }
}

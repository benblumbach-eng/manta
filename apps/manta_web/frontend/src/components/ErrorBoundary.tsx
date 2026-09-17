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
        className="h-full w-full grid place-items-center p-6 bg-slate-950">
        <div className="max-w-lg rounded border border-red-500/40 bg-red-500/5 p-4 text-sm">
          <div className="text-red-300 font-medium">
            {this.props.label ?? "This view"} could not be drawn.
          </div>
          <p className="mt-2 text-slate-300 leading-snug">
            Something in the code failed while rendering — not the database. The data that was
            already loaded is unaffected, and nothing has been changed or deleted.
          </p>
          <pre className="mt-2 max-h-32 overflow-auto rounded bg-slate-950 p-2 font-mono
                          text-[10px] leading-tight text-slate-400 whitespace-pre-wrap">
            {error.message || String(error)}
          </pre>
          <div className="mt-3 flex gap-2">
            <button data-testid="error-boundary-retry"
              onClick={() => this.setState({ error: null })}
              className="px-2 py-1 rounded bg-slate-700 text-slate-100 hover:bg-slate-600 text-xs">
              Try drawing it again
            </button>
            <button data-testid="error-boundary-reload"
              onClick={() => window.location.reload()}
              className="px-2 py-1 rounded border border-slate-600 text-slate-300
                         hover:border-cyan-400 hover:text-cyan-300 text-xs">
              Reload the page
            </button>
          </div>
          <p className="mt-2 text-[10px] text-slate-500">
            The full stack is in the browser console.
          </p>
        </div>
      </div>
    );
  }
}

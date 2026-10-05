import React from 'react';

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Guarantees that a render-time exception surfaces as a readable message
 * instead of an empty white page. Without a boundary React unmounts the whole
 * tree on the first render error, which is exactly what users saw.
 */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('Unhandled UI error:', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="min-h-screen bg-slate-100/60 text-slate-900 flex items-center justify-center p-6 font-sans">
        <div className="max-w-xl w-full rounded-2xl border-2 border-rose-300 bg-white p-6 space-y-4 shadow-sm">
          <div className="text-sm font-extrabold uppercase tracking-wide text-rose-900">
            Something went wrong while displaying the result
          </div>
          <p className="text-sm text-slate-700">
            The page hit an unexpected error while rendering, so it could not be shown. Your audio was
            not modified and nothing was lost.
          </p>
          <pre className="text-xs font-mono text-slate-700 bg-slate-50 border border-slate-200 rounded-lg p-3 whitespace-pre-wrap overflow-x-auto">
            {error.message || String(error)}
          </pre>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              id="btn-error-boundary-reload"
              onClick={() => window.location.reload()}
              className="rounded-xl bg-rose-600 px-4 py-2 text-xs font-bold text-white transition hover:bg-rose-700"
            >
              Reload the app
            </button>
            <button
              type="button"
              onClick={() => this.setState({ error: null })}
              className="rounded-xl bg-slate-100 px-4 py-2 text-xs font-bold text-slate-700 transition hover:bg-slate-200"
            >
              Try again
            </button>
          </div>
        </div>
      </div>
    );
  }
}
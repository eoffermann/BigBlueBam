import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Optional custom fallback. If omitted, a default panel is shown. */
  fallback?: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

/**
 * Class-component error boundary. A render throw anywhere inside `children`
 * is caught here and degrades to a fallback panel instead of unmounting the
 * whole SPA (which previously left Bond on a black/blank screen — e.g. the
 * Analytics page reading fields the API never returned).
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error('[bond] render error caught by ErrorBoundary', error, errorInfo);
  }

  handleReload = (): void => {
    this.setState({ hasError: false, error: null });
  };

  render(): ReactNode {
    if (!this.state.hasError) {
      return this.props.children;
    }

    if (this.props.fallback) {
      return this.props.fallback;
    }

    return (
      <div className="flex flex-col items-center justify-center h-full p-8 text-center">
        <div className="flex items-center justify-center h-12 w-12 rounded-xl bg-red-100 text-red-600 mb-4">
          <AlertTriangle className="h-6 w-6" />
        </div>
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
          Something went wrong
        </h2>
        <p className="text-sm text-zinc-500 mt-1 max-w-md">
          This view hit an unexpected error and could not be displayed. The rest of
          Bond is still available.
        </p>
        {this.state.error?.message && (
          <p className="text-xs text-zinc-400 mt-3 font-mono break-all max-w-md">
            {this.state.error.message}
          </p>
        )}
        <button
          type="button"
          onClick={this.handleReload}
          className="mt-5 px-4 py-2 text-sm font-medium rounded-lg bg-primary-600 text-white hover:bg-primary-700 transition-colors"
        >
          Try again
        </button>
      </div>
    );
  }
}

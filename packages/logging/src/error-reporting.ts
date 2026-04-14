/**
 * Optional Sentry initialization for Bam services. No-op when SENTRY_DSN is
 * unset, so dev and CI never see extra noise.
 *
 * We import @sentry/node lazily via `await import(...)` so services that do
 * not install the peer dependency still build - the function resolves to
 * `undefined` and returns without touching Sentry at all.
 */
export interface ErrorReportingHandle {
  /**
   * A minimal Sentry-like surface the error handler can call. Present only
   * when Sentry was actually initialized.
   */
  captureException(
    error: unknown,
    hint?: { tags?: Record<string, string | number | boolean>; extra?: Record<string, unknown> },
  ): string | undefined;
}

/**
 * Initialize error reporting for a Bam service. Returns the Sentry-like
 * handle when initialized, or `undefined` when `SENTRY_DSN` is not set or
 * the `@sentry/node` dependency is missing at runtime.
 */
export async function initErrorReporting(
  serviceName: string,
): Promise<ErrorReportingHandle | undefined> {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return undefined;

  try {
    // Dynamic import so consumers without @sentry/node installed still build.
    const Sentry = (await import('@sentry/node')) as typeof import('@sentry/node');
    Sentry.init({
      dsn,
      environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? 'development',
      release: process.env.SENTRY_RELEASE,
      tracesSampleRate: Number.parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE ?? '0') || 0,
      serverName: serviceName,
    });
    return {
      captureException: (error, hint) => Sentry.captureException(error, hint),
    };
  } catch {
    // @sentry/node not installed - that's fine, we just no-op.
    return undefined;
  }
}

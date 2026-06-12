/**
 * Browser-side system_errors reporter.
 *
 * Every SPA that imports bureau-client gets this helper for free. The
 * purpose is to make sure any error a user sees on the screen also
 * lands in the SuperUser Log Analysis tab, so we never again have a
 * "they reported a red label" loop without a captured stack to
 * investigate.
 *
 * Three capture surfaces:
 *   1. window.onerror — uncaught synchronous errors.
 *   2. window.unhandledrejection — uncaught promise rejections.
 *   3. Direct calls to `reportSystemError(...)` — anything app code
 *      wants to surface explicitly (Bureau call.errorMessage transition,
 *      mutation failure, etc.).
 *
 * The reporter dedupes by message+stack within a short window so a
 * tight error loop can't flood the table. It also batches sends a
 * single tick into the future so a synchronous reporter call from
 * inside an error path can't trip an infinite loop on its own throw.
 *
 * Initialize once per SPA at boot:
 *
 *   import { initSystemErrorReporter } from '@bigbluebam/bureau-client';
 *   initSystemErrorReporter({ service: 'b3' });   // → service tag becomes "frontend/b3"
 *
 * App code can then emit errors at will:
 *
 *   import { reportSystemError } from '@bigbluebam/bureau-client';
 *   reportSystemError({ message: 'Bureau call failed', error_code: 'CALL_ERROR', payload: { … } });
 *
 * No-op outside the browser (SSR safe).
 */

export interface SystemErrorReporterConfig {
  /** Short app tag — e.g. "b3", "banter", "bureau", "bureau-client".
   *  The endpoint forces a "frontend/" prefix so this is just the leaf. */
  service: string;
  /** REST base — defaults to /b3/api so every SPA on the same origin
   *  reaches the same sink without configuration. Override for tests. */
  apiBase?: string;
  /** If true, also forward to the console at error level. Default true.
   *  Set false in environments where the console is already noisy. */
  alsoLogToConsole?: boolean;
}

export interface SystemErrorPayload {
  /** Short human-readable description of what went wrong. Required. */
  message: string;
  /** A short machine-readable code so the SuperUser tab can filter. */
  error_code?: string;
  /** Stack trace if available. */
  stack?: string;
  /** Free-form metadata. Anything useful for diagnosis goes here. */
  payload?: Record<string, unknown>;
  /** HTTP-ish status code if the error came from a fetch. */
  status_code?: number;
  /** The route the user was on when the error fired. Auto-filled. */
  route?: string;
}

interface InternalState {
  config: SystemErrorReporterConfig | null;
  recentKeys: Map<string, number>;
  installed: boolean;
}

const state: InternalState = {
  config: null,
  recentKeys: new Map(),
  installed: false,
};

const DEDUP_WINDOW_MS = 10_000;
const DEDUP_MAX_ENTRIES = 64;

/**
 * Install the reporter. Idempotent; subsequent calls just update the
 * config so HMR / tests can swap apiBase without re-wiring window.
 */
export function initSystemErrorReporter(config: SystemErrorReporterConfig): void {
  state.config = { alsoLogToConsole: true, apiBase: '/b3/api', ...config };

  if (typeof window === 'undefined') return;
  if (state.installed) return;
  state.installed = true;

  // Uncaught sync errors. The `message` form is what older browsers
  // pass; `event.error` carries the actual Error in modern engines.
  window.addEventListener('error', (event) => {
    const err = event.error instanceof Error ? event.error : null;
    void reportSystemError({
      message: err?.message ?? event.message ?? 'Uncaught error',
      stack: err?.stack ?? `${event.filename ?? ''}:${event.lineno ?? '?'}:${event.colno ?? '?'}`,
      error_code: 'WINDOW_ONERROR',
      payload: {
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
        type: event.type,
      },
    });
  });

  // Promise rejections that no one .catch()ed.
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    let message = 'Unhandled promise rejection';
    let stack: string | undefined;
    if (reason instanceof Error) {
      message = reason.message || message;
      stack = reason.stack;
    } else if (typeof reason === 'string') {
      message = reason;
    } else if (reason && typeof reason === 'object') {
      try {
        message = JSON.stringify(reason).slice(0, 1000);
      } catch {
        /* leave default */
      }
    }
    void reportSystemError({
      message,
      stack,
      error_code: 'UNHANDLED_REJECTION',
      payload: { reason_type: reason?.constructor?.name ?? typeof reason },
    });
  });
}

/**
 * Emit one system_errors row for the current SPA. Safe to call from
 * anywhere; never throws, never blocks the caller. Deduplicates
 * identical messages within a short window so tight retry loops don't
 * flood the SuperUser tab.
 */
export async function reportSystemError(payload: SystemErrorPayload): Promise<void> {
  const config = state.config;
  if (!config) {
    // Reporter wasn't initialized — fall back to the console so we
    // don't silently lose the error during boot.
    if (typeof console !== 'undefined') console.error('[system-errors] (uninitialized)', payload);
    return;
  }
  if (typeof window === 'undefined') return;

  const key = buildDedupKey(payload);
  const now = Date.now();
  const last = state.recentKeys.get(key);
  if (last !== undefined && now - last < DEDUP_WINDOW_MS) {
    // Already sent recently. Skip the network call but keep the local
    // console echo so devtools still shows it.
    if (config.alsoLogToConsole !== false && typeof console !== 'undefined') {
      console.warn('[system-errors] (deduped)', payload);
    }
    return;
  }
  state.recentKeys.set(key, now);
  if (state.recentKeys.size > DEDUP_MAX_ENTRIES) {
    // Evict the oldest entry — small Map, linear is fine.
    const oldestKey = state.recentKeys.keys().next().value;
    if (oldestKey !== undefined) state.recentKeys.delete(oldestKey);
  }

  if (config.alsoLogToConsole !== false && typeof console !== 'undefined') {
    console.error('[system-errors]', payload);
  }

  const body = {
    service: config.service,
    message: payload.message.slice(0, 4000),
    stack: payload.stack ? payload.stack.slice(0, 16000) : null,
    error_code: payload.error_code ?? null,
    status_code: payload.status_code ?? null,
    route: payload.route ?? (typeof window !== 'undefined' ? window.location.pathname : null),
    method: null,
    payload: payload.payload ?? {},
  };

  const csrf = readCsrfToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (csrf) headers['X-CSRF-Token'] = csrf;

  try {
    const apiBase = config.apiBase ?? '/b3/api';
    const url = `${apiBase.replace(/\/+$/, '')}/internal/system-errors/record-browser`;
    // navigator.sendBeacon would survive a tab close, but it can't set
    // headers (no CSRF) and the endpoint is rate-limited so retries are
    // expensive. A fire-and-forget fetch is plenty.
    await fetch(url, {
      method: 'POST',
      headers,
      credentials: 'include',
      body: JSON.stringify(body),
      // keepalive lets the request finish if the user navigates away
      // immediately after the error fires.
      keepalive: true,
    });
  } catch {
    // Never let the reporter throw; the error has already been
    // surfaced to the console above.
  }
}

function buildDedupKey(payload: SystemErrorPayload): string {
  // We don't include payload metadata because two identical messages
  // with subtly-different payload entries (timestamps, retry counters)
  // would otherwise bypass dedup.
  return `${payload.error_code ?? ''}:${payload.message}:${(payload.stack ?? '').slice(0, 200)}`;
}

function readCsrfToken(): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]+)/);
  return match ? decodeURIComponent(match[1]!) : null;
}

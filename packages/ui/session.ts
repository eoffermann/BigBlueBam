/**
 * The one session check every SPA uses (#412).
 *
 * Before this, each SPA's auth store treated ANY failed /auth/me as "signed out", so a 429 from the
 * api rate limiter (or a 5xx, or a dropped connection) bounced a signed-in user to "Please log in".
 * The rule now lives here once:
 *
 *   - 2xx      -> authenticated, with the response body.
 *   - 401      -> signed out. This is the ONLY status that signs a user out.
 *   - anything else (429, 5xx, a network error, an unparseable body, ...) -> keep the session,
 *     raise the shared "Reconnecting" state, wait, and try again. A Retry-After header (seconds or
 *     an HTTP date) sets the wait; otherwise exponential backoff with jitter, capped.
 *
 * scripts/lib/spa-session-single-source.test.mjs fails CI if an SPA auth store calls /auth/me
 * without going through loadSession.
 */

/** The shape of Bam's GET /b3/api/auth/me user, as the SPA stores read it. */
export interface AuthMeUser {
  id: string;
  email: string;
  display_name: string;
  avatar_url?: string | null;
  org_id: string;
  active_org_id?: string | null;
  role: string;
  is_superuser?: boolean;
}

export interface AuthMeResponse<U = AuthMeUser> {
  data: U;
}

/** One try at the session endpoint. `status: null` means the request never got an HTTP answer. */
export type SessionAttempt<T> =
  | { kind: 'ok'; data: T }
  | { kind: 'failed'; status: number | null; retryAfter?: string | null };

export type SessionResult<T> = { kind: 'authenticated'; data: T } | { kind: 'signed_out' };

export interface LoadSessionOptions {
  /** First backoff delay, doubled per retry. Default 1000 ms. */
  baseDelayMs?: number;
  /** Backoff ceiling. Default 30 s. */
  maxDelayMs?: number;
  /** Ceiling on a server-sent Retry-After, so a bad header cannot park the tab for hours. Default 5 min. */
  maxRetryAfterMs?: number;
  /** Test seams. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

/* ------------------------------------------------------------------ */
/*  Shared "Reconnecting" state                                        */
/* ------------------------------------------------------------------ */

let reconnectingCount = 0;
const listeners = new Set<() => void>();

function setReconnecting(delta: 1 | -1): void {
  reconnectingCount = Math.max(0, reconnectingCount + delta);
  for (const l of listeners) l();
}

/** True while any session check is waiting to retry after a non-401 failure. */
export function isSessionReconnecting(): boolean {
  return reconnectingCount > 0;
}

/** Subscribe to Reconnecting changes (useSyncExternalStore-compatible). */
export function subscribeSessionReconnecting(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/* ------------------------------------------------------------------ */
/*  Retry timing                                                       */
/* ------------------------------------------------------------------ */

/** Retry-After as milliseconds (delta-seconds or an HTTP date), or null when absent or unparseable. */
export function parseRetryAfter(header: string | null | undefined, now: number = Date.now()): number | null {
  if (header === null || header === undefined) return null;
  const v = header.trim();
  if (v === '') return null;
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const at = Date.parse(v);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now);
}

/** Whether a failed status means "signed out" (only 401) as opposed to "try again". */
export function isSignedOutStatus(status: number | null): boolean {
  return status === 401;
}

/** The wait before retry number `retry` (1-based). */
export function retryDelayMs(
  retry: number,
  retryAfter: string | null | undefined,
  opts: LoadSessionOptions = {},
): number {
  const now = (opts.now ?? Date.now)();
  const maxRetryAfter = opts.maxRetryAfterMs ?? 5 * 60_000;
  const fromHeader = parseRetryAfter(retryAfter, now);
  if (fromHeader !== null) return Math.min(fromHeader, maxRetryAfter);
  const base = opts.baseDelayMs ?? 1000;
  const cap = opts.maxDelayMs ?? 30_000;
  const exp = Math.min(cap, base * 2 ** Math.max(0, retry - 1));
  const jitter = 0.5 + 0.5 * (opts.random ?? Math.random)();
  return Math.round(exp * jitter);
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs `attempt` until it yields a session (authenticated) or a 401 (signed out). Every other
 * failure keeps waiting and retrying, with the shared Reconnecting state raised meanwhile.
 */
export async function loadSession<T>(
  attempt: () => Promise<SessionAttempt<T>>,
  opts: LoadSessionOptions = {},
): Promise<SessionResult<T>> {
  const sleep = opts.sleep ?? defaultSleep;
  let retry = 0;
  let raised = false;
  try {
    for (;;) {
      const result = await attempt();
      if (result.kind === 'ok') return { kind: 'authenticated', data: result.data };
      if (isSignedOutStatus(result.status)) return { kind: 'signed_out' };
      retry += 1;
      if (!raised) {
        raised = true;
        setReconnecting(1);
      }
      await sleep(retryDelayMs(retry, result.retryAfter, opts));
    }
  } finally {
    if (raised) setReconnecting(-1);
  }
}

/** A session attempt that GETs `url` with the shared session cookie and parses the JSON body. */
export function fetchSessionAttempt<T = AuthMeResponse>(
  url: string,
  init: RequestInit = {},
): () => Promise<SessionAttempt<T>> {
  return async () => {
    let res: Response;
    try {
      res = await fetch(url, { credentials: 'include', ...init });
    } catch {
      return { kind: 'failed', status: null };
    }
    if (!res.ok) return { kind: 'failed', status: res.status, retryAfter: res.headers.get('Retry-After') };
    try {
      return { kind: 'ok', data: (await res.json()) as T };
    } catch {
      return { kind: 'failed', status: null };
    }
  };
}

/**
 * A session attempt over an SPA's own API client (frontend, helpdesk), whose errors carry the
 * HTTP status as `err.status` and, when the client exposes it, the Retry-After as `err.retryAfter`.
 */
export function clientSessionAttempt<T>(call: () => Promise<T>): () => Promise<SessionAttempt<T>> {
  return async () => {
    try {
      return { kind: 'ok', data: await call() };
    } catch (err) {
      const e = err as { status?: unknown; retryAfter?: unknown } | null;
      const status = typeof e?.status === 'number' ? e.status : null;
      const retryAfter = typeof e?.retryAfter === 'string' ? e.retryAfter : null;
      return { kind: 'failed', status, retryAfter };
    }
  };
}

/**
 * Thin wrapper around fetch() that always points at /bureau/api/v1 and
 * includes credentials so the shared Bam session cookie travels with the
 * request. Errors are normalized into a thrown Error with the server's
 * error envelope attached on `cause`.
 */

const API_BASE = '/bureau/api/v1';

/**
 * HB-52 CSRF helper: reads the `csrf_token` cookie that the Bam API sets
 * on login / auth/me. State-changing requests against /b3/api/* must
 * echo it in the `X-CSRF-Token` header (double-submit pattern in
 * apps/api/src/plugins/csrf.ts). Bureau's own /bureau/api/v1 routes do
 * not yet enforce CSRF, but this is exported so cross-app calls (e.g.
 * the image underlay upload to /b3/api/upload) can stay consistent
 * with apps/frontend/src/lib/api.ts.
 *
 * Returns null when running outside a browser (SSR / tests) or when the
 * cookie has not been issued yet.
 */
export function readCsrfToken(): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]+)/);
  return match ? decodeURIComponent(match[1]!) : null;
}

export interface ApiErrorEnvelope {
  error: {
    code: string;
    message: string;
    details?: Array<{ field?: string; issue?: string }>;
    request_id?: string;
  };
}

export class BureauApiError extends Error {
  status: number;
  code: string;
  envelope: ApiErrorEnvelope | null;
  constructor(status: number, code: string, message: string, envelope: ApiErrorEnvelope | null) {
    super(message);
    this.status = status;
    this.code = code;
    this.envelope = envelope;
  }
}

export interface ApiOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
}

export async function api<T>(path: string, opts: ApiOptions = {}): Promise<T> {
  const init: RequestInit = {
    method: opts.method ?? 'GET',
    credentials: 'include',
    signal: opts.signal,
    headers: { 'content-type': 'application/json' },
  };
  if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
  }
  const res = await fetch(`${API_BASE}${path}`, init);
  if (res.status === 204) return undefined as unknown as T;
  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // fall through; envelope stays null
    }
  }
  if (!res.ok) {
    const envelope = (parsed as ApiErrorEnvelope | null) ?? null;
    const code = envelope?.error?.code ?? `HTTP_${res.status}`;
    // `||` not `??`: res.statusText is '' over HTTP/2, and a proxy-level
    // failure (nginx 502/504 HTML) has no envelope — never surface an
    // empty message, always at least the status code.
    const message =
      envelope?.error?.message || res.statusText || `HTTP ${res.status} (${code})`;
    throw new BureauApiError(res.status, code, message, envelope);
  }
  return parsed as T;
}

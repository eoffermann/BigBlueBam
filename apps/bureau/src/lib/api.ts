/**
 * Thin wrapper around fetch() that always points at /bureau/api/v1 and
 * includes credentials so the shared Bam session cookie travels with the
 * request. Errors are normalized into a thrown Error with the server's
 * error envelope attached on `cause`.
 */

const API_BASE = '/bureau/api/v1';

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
    const message = envelope?.error?.message ?? res.statusText ?? 'Request failed';
    throw new BureauApiError(res.status, code, message, envelope);
  }
  return parsed as T;
}

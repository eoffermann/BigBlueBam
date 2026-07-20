// Shared HTTP transport for the Bursar worker jobs (spec 3.2 / 18.6). The bursar-* jobs are
// deliberately THIN: they POST to bursar-api's internal engine routes so all engine logic (and
// every LLM call) lives in one container (bursar-api), mirroring the burn-* / bulwark-* jobs.
// Guarded by INTERNAL_SERVICE_SECRET; a missing secret fails the call. Reads process.env directly.
//
// BURSAR_API_INTERNAL_URL is the container-internal base (http://bursar-api:4023) and the /v1
// PREFIX IS REQUIRED on every path - dropping it is a live 404 (the Bulwark/Braid cycles both
// shipped that bug).

export function bursarInternalUrl(): string {
  return (process.env.BURSAR_API_INTERNAL_URL ?? 'http://bursar-api:4023').replace(/\/+$/, '');
}

export interface BursarPostResult {
  ok: boolean;
  status: number;
  data?: unknown;
}

/**
 * POST to a bursar-api internal route with the shared secret and a bounded timeout. Each worker
 * passes its own deadline. `BURSAR_ENGINE_TIMEOUT_MS` (default 30000) bounds the async-start /
 * one-chunk slice call - the work itself is bounded to one chunk per invocation, so this returns
 * fast and the worker polls again. Returns the parsed body plus status WITHOUT throwing on a
 * non-2xx, so the poller can branch on 409 (claimed) / 429 (throttled) / done.
 */
export async function postBursar(
  path: string,
  body: Record<string, unknown>,
  timeoutMs = Number(process.env.BURSAR_ENGINE_TIMEOUT_MS ?? 30000),
): Promise<BursarPostResult> {
  const secret = process.env.INTERNAL_SERVICE_SECRET;
  if (!secret) throw new Error('INTERNAL_SERVICE_SECRET is empty; cannot call bursar-api');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${bursarInternalUrl()}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': secret },
      signal: controller.signal,
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => undefined);
    return { ok: res.ok, status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

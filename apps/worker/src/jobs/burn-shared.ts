// Shared HTTP transport for the Burn worker jobs (Burn spec 4.0 / 8.1). The 11 burn-* jobs are
// deliberately THIN: they POST to burn-api's internal engine routes so all engine logic (and every
// LLM call) lives in one container (burn-api), mirroring the bulwark-* jobs. Guarded by
// INTERNAL_SERVICE_SECRET; a missing secret fails the call. Reads process.env directly like the
// bulwark/braid jobs.
//
// BURN_API_INTERNAL_URL is the container-internal base (http://burn-api:4022) and the /v1 PREFIX
// IS REQUIRED on every path - the Bulwark and Braid cycles both shipped a live 404 by dropping it.

export function burnInternalUrl(): string {
  return (process.env.BURN_API_INTERNAL_URL ?? 'http://burn-api:4022').replace(/\/+$/, '');
}

export interface BurnPostResult {
  ok: boolean;
  status: number;
  data?: unknown;
}

/**
 * POST to a burn-api internal route with the shared secret and a bounded timeout. Each worker
 * passes its OWN generous deadline, distinct from LLM_TIMEOUT_MS (spec 8.1). Throws on transport
 * failure or non-2xx so BullMQ's attempts/backoff retries (the durability model).
 */
export async function postBurn(
  path: string,
  body: Record<string, unknown>,
  timeoutMs = Number(process.env.BURN_ENGINE_TIMEOUT_MS ?? 180000),
): Promise<BurnPostResult> {
  const secret = process.env.INTERNAL_SERVICE_SECRET;
  if (!secret) throw new Error('INTERNAL_SERVICE_SECRET is empty; cannot call burn-api');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${burnInternalUrl()}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': secret },
      signal: controller.signal,
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => undefined);
    if (!res.ok) throw new Error(`burn ${path} returned ${res.status}`);
    return { ok: true, status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

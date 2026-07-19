// Shared HTTP transport for the Bulwark worker jobs (Bulwark spec §9.2). The 7 bulwark-* jobs
// are deliberately THIN: they POST to bulwark-api's internal engine routes so all engine logic
// lives in one place (bulwark-api), mirroring how braid-proposal-reconcile drives braid-api's
// single executor. Guarded by INTERNAL_SERVICE_SECRET; a missing secret fails the call. Reads
// process.env directly (like the braid jobs) so no loadEnv() plumbing is needed per job.

export function bulwarkInternalUrl(): string {
  return (process.env.BULWARK_API_INTERNAL_URL ?? 'http://bulwark-api:4021').replace(/\/+$/, '');
}

export interface BulwarkPostResult {
  ok: boolean;
  status: number;
  data?: unknown;
}

// POST to a bulwark-api internal route with the shared secret and a bounded timeout. Throws on
// transport failure or non-2xx so BullMQ's attempts/backoff retries (the durability model).
export async function postBulwark(
  path: string,
  body: Record<string, unknown>,
  timeoutMs = Number(process.env.UPSTREAM_TIMEOUT_MS ?? 10000),
): Promise<BulwarkPostResult> {
  const secret = process.env.INTERNAL_SERVICE_SECRET;
  if (!secret) throw new Error('INTERNAL_SERVICE_SECRET is empty; cannot call bulwark-api');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${bulwarkInternalUrl()}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': secret },
      signal: controller.signal,
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => undefined);
    if (!res.ok) throw new Error(`bulwark ${path} returned ${res.status}`);
    return { ok: true, status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

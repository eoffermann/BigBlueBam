// Shared HTTP transport for the Bastion worker jobs (Bastion spec 7). The bastion-* jobs are
// deliberately THIN: they POST to bastion-api's internal engines route so all engine logic, the
// seal signing key and the personal-data HMAC key live in one container (bastion-api), the same
// shape as the bursar-* jobs. Guarded by INTERNAL_SERVICE_SECRET; a missing secret fails the call.
//
// BASTION_API_INTERNAL_URL is the container-internal base (http://bastion-api:4024) and the /v1
// PREFIX IS REQUIRED on every path. Unlike the bursar helper there is NO default: an unset URL
// throws (spec 7), so a mis-provisioned worker fails loudly instead of calling a guessed host.

export class BastionUrlMissingError extends Error {
  constructor() {
    super('BASTION_API_INTERNAL_URL is not set; the Bastion worker jobs cannot reach bastion-api.');
    this.name = 'BastionUrlMissingError';
  }
}

export function bastionInternalUrl(): string {
  const raw = (process.env.BASTION_API_INTERNAL_URL ?? '').trim();
  if (!raw) throw new BastionUrlMissingError();
  return raw.replace(/\/+$/, '');
}

export interface BastionPostResult {
  ok: boolean;
  status: number;
  data?: unknown;
}

/**
 * POST to a bastion-api internal route with the shared secret and a bounded timeout
 * (BASTION_ENGINE_TIMEOUT_MS, default 30000; spec 7.3). Returns status and body without throwing
 * on a non-2xx, so the caller can branch on 404 / 409.
 */
export async function postBastion(
  path: string,
  body: Record<string, unknown>,
  timeoutMs = Number(process.env.BASTION_ENGINE_TIMEOUT_MS ?? 30000),
): Promise<BastionPostResult> {
  const secret = process.env.INTERNAL_SERVICE_SECRET;
  if (!secret) throw new Error('INTERNAL_SERVICE_SECRET is empty; cannot call bastion-api');
  const res = await fetch(`${bastionInternalUrl()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': secret },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => undefined);
  return { ok: res.ok, status: res.status, data };
}

/** The `data` member of a bastion-api envelope. */
export function bodyData<T>(res: BastionPostResult): T | undefined {
  return (res.data as { data?: T } | undefined)?.data;
}

/** Thrown when bastion-api's response does not match the shared contract (issue #205). */
export class BastionContractError extends Error {
  constructor(what: string, issues: string) {
    super(`bastion-api ${what} does not match the shared contract (@bigbluebam/shared schemas/bastion.ts): ${issues}`);
    this.name = 'BastionContractError';
  }
}

/**
 * Parse a bastion-api response body against its shared Zod contract. A mismatch (a field renamed
 * on one side) throws a BastionContractError naming the fields, so it fails loudly in the job
 * log instead of quietly driving the queue with undefined values.
 */
export function parseContract<T>(
  schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false; error: { issues: Array<{ path: Array<string | number>; message: string }> } } },
  value: unknown,
  what: string,
): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
  throw new BastionContractError(what, issues);
}

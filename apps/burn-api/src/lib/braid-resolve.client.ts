import { env } from '../env.js';

// Braid counterparty resolution (spec 8.5). Ported from
// apps/bulwark-api/src/lib/braid-resolve.client.ts.
//
// On engagement register, Burn resolves the account (a bond.company) to a stable Braid
// golden id so a chain that spans three differently-spelled versions of the same client
// rolls up as one account on /v1/financials/accounts.
//
// SOFT DEPENDENCY, and the contract is exact: an absent BRAID_API_INTERNAL_URL, an absent
// internal secret, a missing asker, ANY non-2xx, a timeout, or a thrown fetch all degrade to
// `null`, and the caller stores the RAW bond.company id and continues. A resolution failure
// NEVER fails the create. Burn is a margin monitor; it does not get to refuse to register a
// contract because an identity-resolution service is having a bad afternoon.
//
// asker_user_id is REQUIRED by braid-api's internal route, so a caller with no asker skips
// resolution entirely rather than sending a request that is guaranteed to 400.

export async function resolveAccountGoldenId(args: {
  orgId: string;
  sourceType: string; // e.g. 'bond.company'
  sourceId: string;
  askerUserId?: string | null;
}): Promise<string | null> {
  const base = env.BRAID_API_INTERNAL_URL?.replace(/\/+$/, '');
  const secret = env.INTERNAL_SERVICE_SECRET;
  if (!base || !secret) return null;
  if (!args.askerUserId) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/v1/internal/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': secret },
      body: JSON.stringify({
        org_id: args.orgId,
        source_type: args.sourceType,
        source_id: args.sourceId,
        asker_user_id: args.askerUserId,
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: { profile_id?: string } };
    return json.data?.profile_id ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

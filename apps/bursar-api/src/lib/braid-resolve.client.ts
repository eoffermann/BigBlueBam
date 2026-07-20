import { env } from '../env.js';

// Braid counterparty resolution. Ported from burn-api/src/lib/braid-resolve.client.ts (spec
// 6.1). Bursar calls Braid for ONE thing only: resolving a vendor's bond_company_id to a
// stable golden braid_profile_id, so a vendor that appears under differently-spelled company
// rows rolls up as one. It is NEVER called for payee strings (that is Bursar's own resolver;
// see payee-normalize.ts).
//
// SOFT DEPENDENCY, exact contract: an absent BRAID_API_INTERNAL_URL, an absent internal
// secret, a missing asker, ANY non-2xx, a timeout, or a thrown fetch all degrade to `null`,
// and the caller stores the RAW bond_company_id (or nothing) and continues. A resolution
// failure NEVER fails the create. asker_user_id is REQUIRED by braid-api's internal route, so
// a caller with no asker skips resolution rather than sending a guaranteed 400.

export async function resolveVendorGoldenId(args: {
  orgId: string;
  bondCompanyId: string;
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
        source_type: 'bond.company',
        source_id: args.bondCompanyId,
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

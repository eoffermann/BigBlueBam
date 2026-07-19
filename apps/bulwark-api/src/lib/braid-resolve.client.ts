import { env } from '../env.js';

// Braid counterparty resolution (spec 7.4 / IN7). At contract-register and
// vendor-tier-create, Bulwark resolves the counterparty/vendor (a bond.company) to a stable
// Braid golden id so the deterministic notice recipient (THEME E) is the canonical
// counterparty.
//
// SOFT DEPENDENCY: this is an application-level call, not just an env var. If Braid is
// absent, its URL is empty, or it is unreachable, resolution degrades GRACEFULLY to null and
// the caller stores the raw bond.company id and continues. A resolution failure NEVER fails
// the create.
//
// Transport note: braid-api exposes no internal-secret resolve route; its public
// POST /v1/resolve is session/permission gated. We attempt it with the internal secret
// header (harmless if rejected) and treat any non-2xx / error as "degrade to raw id". When
// a real internal resolve route lands, only this client changes.

export async function resolveCounterpartyGoldenId(args: {
  sourceType: string; // e.g. 'bond.company'
  sourceId: string;
  askerUserId?: string;
}): Promise<string | null> {
  const base = env.BRAID_API_INTERNAL_URL?.replace(/\/+$/, '');
  const secret = env.INTERNAL_SERVICE_SECRET;
  if (!base || !secret) return null; // absent Braid or no secret -> degrade (spec 7.4)
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/v1/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': secret },
      body: JSON.stringify({
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
    return null; // unreachable / aborted -> degrade to raw bond.company id
  } finally {
    clearTimeout(timer);
  }
}

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
// Transport note: braid-api now exposes POST /v1/internal/resolve, guarded by
// INTERNAL_SERVICE_SECRET (M6 item E), which runs the same resolve service as the public route.
// We call it with the internal secret header and the human the caller acts for (asker_user_id);
// any non-2xx / error degrades to the raw id. asker_user_id is REQUIRED by the internal route,
// so when the caller has no asker we skip resolution and keep the raw bond id (soft dependency).

export async function resolveCounterpartyGoldenId(args: {
  orgId: string;
  sourceType: string; // e.g. 'bond.company'
  sourceId: string;
  askerUserId?: string;
}): Promise<string | null> {
  const base = env.BRAID_API_INTERNAL_URL?.replace(/\/+$/, '');
  const secret = env.INTERNAL_SERVICE_SECRET;
  if (!base || !secret) return null; // absent Braid or no secret -> degrade (spec 7.4)
  if (!args.askerUserId) return null; // internal resolve requires an asker; degrade to raw id
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
    return null; // unreachable / aborted -> degrade to raw bond.company id
  } finally {
    clearTimeout(timer);
  }
}

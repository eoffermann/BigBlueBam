import { env } from '../env.js';

// Per-viewer visibility preflight for Bulwark (spec 2.5 / THEME E).
//
// Before registering a contract from a Bin asset (S3), and before attaching the source
// asset at send time, Bulwark confirms the requesting/deciding user can actually see the
// referenced source record, using the Bam API's internal can_access preflight (the SAME
// rules the agent-facing can_access tool uses, apps/api/src/services/visibility.service.ts).
// Ported from apps/braid-api/src/lib/can-access.client.ts.
//
// Fail-closed on every non-2xx, timeout, missing secret, or transport error: a deny must
// never leak as an allow (spec 2.5).

const UPSTREAM_TIMEOUT_MS = 4000;

export async function preflightAccess(
  askerUserId: string,
  entityType: string,
  entityId: string,
): Promise<boolean> {
  const url = `${env.BBB_API_INTERNAL_URL.replace(/\/+$/, '')}/internal/visibility/can-access`;
  const secret = env.INTERNAL_SERVICE_SECRET;
  if (!secret) return false; // no secret -> cannot verify -> fail closed
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': secret },
      body: JSON.stringify({
        asker_user_id: askerUserId,
        entity_type: entityType,
        entity_id: entityId,
      }),
      signal: controller.signal,
    });
    if (!res.ok) return false;
    const json = (await res.json()) as { allowed?: boolean };
    return json.allowed === true;
  } catch {
    return false; // unreachable / aborted -> fail closed
  } finally {
    clearTimeout(timer);
  }
}

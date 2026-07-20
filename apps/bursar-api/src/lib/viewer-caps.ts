// viewerCaps: the ONE source of every financial-flooring decision in Bursar.
//
// Ported from burn-api/src/lib/viewer-caps.ts (spec 13.3). Read burn's copy for the full
// rationale; the shape is identical, only the gated permission changes.
//
// ── WHY THIS FILE EXISTS AT ALL, RATHER THAN `fastify.canResolve` ──────────────────────
//
// bursar-api registers `httpPermissionsPlugin`, whose `canResolve` decorator is a HARDCODED
// `return true` stub in packages/permissions. Using it as the source of a flooring decision
// would report read_all for EVERY caller, shipping per-vendor spend to every org member. So
// `fastify.canResolve` is FORBIDDEN as the source of any Bursar flooring or seal decision.
//
// ── HOW IT IS DERIVED ─────────────────────────────────────────────────────────────────
//
// An explicit, fail-closed POST /internal/permissions/dual-read for `bursar.spend.read_all`.
// ANYTHING other than an explicit 'allow' is false: a non-2xx, a timeout, a thrown fetch, a
// missing secret, a malformed body, a 'deny', an 'unknown'. Resolved ONCE per request (see
// plugins/viewer-caps.ts) and threaded into the serializer.
//
// ── THE BEARER-INTERSECT-ASKER RULE ───────────────────────────────────────────────────
//
// On an MCP call bursar-api sees a SERVICE-ACCOUNT BEARER while `asker_user_id` narrows the
// row set. That parameter is a visibility narrowing, not an approval (spec 13.3). Keying
// viewerCaps off the bearer alone would return unfloored spend to an agent acting for a
// member asker. mcp-server cannot backstop this (its own BBB_PERMISSIONS_ENFORCE defaults to
// 'warn'). So:
//   - asker present and != bearer  ->  viewerCaps is the INTERSECTION of both;
//   - an unresolvable asker         ->  the floored fields fail CLOSED.

export interface ViewerCaps {
  /** bursar.spend.read_all. Gates every per-vendor / per-line dollar figure. */
  spend_read_all: boolean;
  /**
   * Whether the probe produced an explicit answer from the resolver. False means it failed
   * (non-2xx, timeout, throw, missing secret, unresolvable asker) and the cap above was
   * forced to false rather than inferred. Used only for logging / a suppression reason; it
   * never widens anything.
   */
  resolved: boolean;
}

/** The fail-closed value. Every error path returns exactly this. */
export const DENY_ALL_VIEWER_CAPS: Readonly<ViewerCaps> = Object.freeze({
  spend_read_all: false,
  resolved: false,
});

export const BURSAR_SPEND_READ_ALL = 'bursar.spend.read_all';

export interface ViewerCapsDeps {
  /** e.g. http://api:4000 */
  apiInternalUrl: string;
  /** INTERNAL_SERVICE_SECRET. Empty means every cap is false. */
  internalSecret: string | undefined;
  timeoutMs: number;
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  log?: { warn: (obj: object, msg: string) => void };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The `asker_user_id` query parameter, when an agent acts for a human. A malformed value
 * returns the sentinel `'invalid'` rather than null so it can FAIL CLOSED.
 */
export function askerUserIdOf(query: unknown): string | 'invalid' | null {
  const raw = (query as { asker_user_id?: unknown } | undefined)?.asker_user_id;
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string' || !UUID_RE.test(raw)) return 'invalid';
  return raw;
}

export interface ViewerCapsRequest {
  bearerUserId: string | null | undefined;
  orgId: string | null | undefined;
  askerUserId?: string | null;
}

interface LegResult {
  allowed: boolean;
  resolved: boolean;
}

const DENIED_LEG: LegResult = { allowed: false, resolved: false };

/**
 * One dual-read probe. Fails CLOSED on every abnormal path. Never throws. The shape mirrors
 * burn's dual-read (which mirrors bulwark's proposal-decided call site).
 */
async function dualRead(
  deps: ViewerCapsDeps,
  userId: string,
  orgId: string,
  permissionId: string,
): Promise<LegResult> {
  if (!deps.internalSecret) return DENIED_LEG;
  const doFetch = deps.fetchImpl ?? fetch;
  const url = `${deps.apiInternalUrl.replace(/\/+$/, '')}/internal/permissions/dual-read`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs);
  try {
    const res = await doFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': deps.internalSecret },
      body: JSON.stringify({
        user_id: userId,
        permission_id: permissionId,
        agent_policy_decision: 'allow',
        scope: { org_id: orgId, project_id: null },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      deps.log?.warn(
        { permission_id: permissionId, status: res.status },
        'bursar viewerCaps dual-read non-2xx; failing closed',
      );
      return DENIED_LEG;
    }
    const json = (await res.json()) as { data?: { decision?: string } };
    const decision = json?.data?.decision;
    if (decision !== 'allow' && decision !== 'deny') {
      deps.log?.warn(
        { permission_id: permissionId, decision },
        'bursar viewerCaps dual-read returned no explicit decision; failing closed',
      );
      return DENIED_LEG;
    }
    return { allowed: decision === 'allow', resolved: true };
  } catch (err) {
    deps.log?.warn(
      { permission_id: permissionId, err: (err as Error)?.message },
      'bursar viewerCaps dual-read threw; failing closed',
    );
    return DENIED_LEG;
  } finally {
    clearTimeout(timer);
  }
}

/** The caps for one identity. Fails closed as a unit if the identity is unusable. */
export async function resolveViewerCapsFor(
  deps: ViewerCapsDeps,
  userId: string | null | undefined,
  orgId: string | null | undefined,
): Promise<ViewerCaps> {
  if (!userId || !orgId) return { ...DENY_ALL_VIEWER_CAPS };
  const spend = await dualRead(deps, userId, orgId, BURSAR_SPEND_READ_ALL);
  return { spend_read_all: spend.allowed, resolved: spend.resolved };
}

/** The intersection. A capability survives only if BOTH identities hold it. */
export function intersectViewerCaps(bearer: ViewerCaps, asker: ViewerCaps): ViewerCaps {
  return {
    spend_read_all: bearer.spend_read_all && asker.spend_read_all,
    resolved: bearer.resolved && asker.resolved,
  };
}

/**
 * THE ENTRY POINT. Resolve once per request; never call this per row. With no distinct asker
 * this is just the bearer's caps. With an asker that differs it is the intersection, so an
 * admin service-account bearer acting for a plain member gets NO spend figures.
 */
export async function resolveViewerCaps(
  deps: ViewerCapsDeps,
  req: ViewerCapsRequest,
): Promise<ViewerCaps> {
  const bearer = await resolveViewerCapsFor(deps, req.bearerUserId, req.orgId);
  const askerId = req.askerUserId;
  if (!askerId || askerId === req.bearerUserId) return bearer;
  // The bearer already holds nothing, so the intersection is nothing. Skip the round trip.
  if (!bearer.spend_read_all) return { ...bearer, resolved: false };
  const asker = await resolveViewerCapsFor(deps, askerId, req.orgId);
  return intersectViewerCaps(bearer, asker);
}

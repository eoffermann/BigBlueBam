// viewerCaps: the ONE source of every financial-flooring decision in Burn.
//
// Spec 2.4 point 2 (round-3 blockers R3-S1 and R3-S2). Read this before touching it.
//
// ── WHY THIS FILE EXISTS AT ALL, RATHER THAN `fastify.canResolve` ──────────────────────
//
// burn-api is a satellite and registers `httpPermissionsPlugin`. That plugin's
// `canResolve` decorator is a HARDCODED STUB: packages/permissions/src/index.ts:307-319 is
// a comment saying "the HTTP plugin doesn't expose a synchronous probe today" followed by
// `return true;`. It ignores `mode` entirely, so the R2-S1 boot assertion that pins
// BBB_PERMISSIONS_ENFORCE='on' does not help.
//
// The only in-tree precedent for field flooring in a satellite is
// apps/bulwark-api/src/routes/deadlines.routes.ts:21-23, which calls `fastify.canResolve`
// and THEREFORE FLOORS NOTHING TODAY. That is a live bug in shipped code. Copying it here
// would make viewerCaps report read_all for EVERY caller, shipping `cost_amount` to every
// project member at a 100 percent rate -- and for a single bam.time_entry row,
// cost_amount / (minutes / 60) is that person's hourly cost rate to the cent.
//
// So: `fastify.canResolve` is FORBIDDEN as the source of any Burn flooring decision. There
// is a test (test/no-can-resolve-in-flooring-path.test.ts) that greps this file, the
// serializer, and the plugin for the identifier and fails if it reappears.
//
// ── HOW IT IS DERIVED ─────────────────────────────────────────────────────────────────
//
// An explicit, fail-closed POST /internal/permissions/dual-read for
// `burn.financials.read_all` and `burn.costrate.read`, on the shape at
// apps/bulwark-api/src/subscriptions/proposal-decided.ts:88. ANYTHING other than an
// explicit 'allow' is false: a non-2xx, a timeout, a thrown fetch, a missing secret, a
// malformed body, a 'deny', an 'unknown'. Resolved ONCE per request (see
// plugins/viewer-caps.ts) and threaded into the serializer.
//
// ── THE BEARER-INTERSECT-ASKER RULE ───────────────────────────────────────────────────
//
// On an MCP call burn-api sees a SERVICE-ACCOUNT BEARER while `asker_user_id` narrows the
// row set. Per spec 2.2.1 that parameter is a visibility narrowing, not an approval.
// Keying viewerCaps off the bearer alone would return fully unfloored cost_amount to an
// agent acting for a member asker, delivering per-person compensation through the agent
// channel. mcp-server cannot backstop this: register-tool.ts:512 reads
// BBB_PERMISSIONS_ENFORCE from mcp-server's OWN env (compose default 'warn'), so its
// per-action check never denies. Bulwark hit this hazard and wrote the rule down at
// deadlines.routes.ts:11-19. Burn adopts it across all eight serializer surfaces:
//   - asker present and != bearer  ->  viewerCaps is the INTERSECTION of both;
//   - an unresolvable asker         ->  the floored fields fail CLOSED.

export interface ViewerCaps {
  /** burn.financials.read_all. Gates every dollar, margin, coverage and envelope figure. */
  financials_read_all: boolean;
  /** burn.costrate.read. Gates the /v1/cost-rates surface (which is NOT serializer-floored). */
  costrate_read: boolean;
  /**
   * Whether every leg produced an explicit answer from the resolver. False means at least
   * one probe failed (non-2xx, timeout, throw, missing secret, unresolvable asker) and the
   * caps above were forced to false rather than inferred. Used only for the
   * `unresolved_viewer` suppression reason and for logging; it never widens anything.
   */
  resolved: boolean;
}

/** The fail-closed value. Every error path returns exactly this. */
export const DENY_ALL_VIEWER_CAPS: Readonly<ViewerCaps> = Object.freeze({
  financials_read_all: false,
  costrate_read: false,
  resolved: false,
});

export const BURN_FINANCIALS_READ_ALL = 'burn.financials.read_all';
export const BURN_COSTRATE_READ = 'burn.costrate.read';

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
 * The `asker_user_id` query parameter, when an agent acts for a human.
 *
 * A malformed value returns the sentinel `'invalid'` rather than null so it can FAIL
 * CLOSED. Silently ignoring a garbled asker would fall back to the bearer's (possibly
 * service-account admin) caps, which is exactly the widening the intersection rule exists
 * to prevent.
 *
 * Lives here rather than in the plugin so it is importable without pulling in env.ts.
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
  /** The `asker_user_id` query parameter, when an agent acts for a human. */
  askerUserId?: string | null;
}

interface LegResult {
  allowed: boolean;
  /** True only when the resolver returned a 2xx with a parseable decision. */
  resolved: boolean;
}

const DENIED_LEG: LegResult = { allowed: false, resolved: false };

/**
 * One dual-read probe. Fails CLOSED on every abnormal path. Never throws.
 *
 * The shape mirrors apps/bulwark-api/src/subscriptions/proposal-decided.ts:88 exactly,
 * including `agent_policy_decision: 'allow'` (the kill-switch verdict is checked separately
 * by mcp-server's register-tool wrapper; passing 'allow' here means "do not let the policy
 * layer widen or narrow this read", not "the policy allowed it").
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
        'burn viewerCaps dual-read non-2xx; failing closed',
      );
      return DENIED_LEG;
    }
    const json = (await res.json()) as { data?: { decision?: string } };
    const decision = json?.data?.decision;
    if (decision !== 'allow' && decision !== 'deny') {
      // 'unknown', undefined, or a malformed body. A 2xx that does not carry a real
      // decision is NOT an answer; treat it as an outage, not as a deny.
      deps.log?.warn(
        { permission_id: permissionId, decision },
        'burn viewerCaps dual-read returned no explicit decision; failing closed',
      );
      return DENIED_LEG;
    }
    return { allowed: decision === 'allow', resolved: true };
  } catch (err) {
    deps.log?.warn(
      { permission_id: permissionId, err: (err as Error)?.message },
      'burn viewerCaps dual-read threw; failing closed',
    );
    return DENIED_LEG;
  } finally {
    clearTimeout(timer);
  }
}

/** Both caps for one identity. Fails closed as a unit if the identity is unusable. */
export async function resolveViewerCapsFor(
  deps: ViewerCapsDeps,
  userId: string | null | undefined,
  orgId: string | null | undefined,
): Promise<ViewerCaps> {
  if (!userId || !orgId) return { ...DENY_ALL_VIEWER_CAPS };
  const [readAll, costRate] = await Promise.all([
    dualRead(deps, userId, orgId, BURN_FINANCIALS_READ_ALL),
    dualRead(deps, userId, orgId, BURN_COSTRATE_READ),
  ]);
  return {
    financials_read_all: readAll.allowed,
    costrate_read: costRate.allowed,
    resolved: readAll.resolved && costRate.resolved,
  };
}

/**
 * The intersection. A capability survives only if BOTH identities hold it, and `resolved`
 * survives only if both were resolved -- so an unresolvable asker forces every floored
 * field closed AND is distinguishable from a legitimate deny.
 */
export function intersectViewerCaps(bearer: ViewerCaps, asker: ViewerCaps): ViewerCaps {
  return {
    financials_read_all: bearer.financials_read_all && asker.financials_read_all,
    costrate_read: bearer.costrate_read && asker.costrate_read,
    resolved: bearer.resolved && asker.resolved,
  };
}

/**
 * THE ENTRY POINT. Resolve once per request; never call this per row.
 *
 * With no distinct asker this is just the bearer's caps. With an asker that differs from
 * the bearer it is the intersection, which is why an admin service-account bearer acting
 * for a plain member gets NO cost_amount.
 */
export async function resolveViewerCaps(
  deps: ViewerCapsDeps,
  req: ViewerCapsRequest,
): Promise<ViewerCaps> {
  const bearer = await resolveViewerCapsFor(deps, req.bearerUserId, req.orgId);
  const askerId = req.askerUserId;
  if (!askerId || askerId === req.bearerUserId) return bearer;
  // Short-circuit: the bearer already holds nothing, so the intersection is nothing. Skip
  // the second round trip rather than doubling latency to reach the same answer.
  if (!bearer.financials_read_all && !bearer.costrate_read) {
    return { ...bearer, resolved: false };
  }
  const asker = await resolveViewerCapsFor(deps, askerId, req.orgId);
  return intersectViewerCaps(bearer, asker);
}

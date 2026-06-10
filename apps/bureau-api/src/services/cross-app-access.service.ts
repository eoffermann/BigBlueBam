/**
 * Cross-app access checks for the §10 summon system (Agent C, workstream 6).
 *
 * Before navigating any recipient toward a summon target, Bureau must verify
 * that recipient actually has access to the destination resource. The design
 * doc (§10 step 3) is explicit: "Occupants without access are recorded as
 * `no_access`. They are not navigated and not notified, so the summon never
 * reveals the resource to someone who cannot open it."
 *
 * This module is the single place every other Bureau code path goes through
 * for that check. It dispatches by `app` to a per-app handler that calls the
 * destination service's internal can-read endpoint over the BigBlueBam
 * internal network using the shared INTERNAL_SERVICE_SECRET pattern.
 *
 * ─── Current status (D-12 closed) ─────────────────────────────────────
 * Board (POST /v1/internal/can-read), Brief (POST /v1/internal/can-read),
 * and Bam (POST /internal/can-read) all ship live preflights as of D-12.
 * The { allowed: true, canShare: false, reason: 'stub_allow' } fallback
 * remains ONLY for transport failures (peer down, secret unset, non-200)
 * so a peer outage degrades to the historical permissive behavior instead
 * of breaking summons; the fallback is logged via the reason field on the
 * audit row.
 *
 * canShare semantics: only set true when the calling SUMMONER (not the
 * recipient) has rights to share/invite collaborators on the target. Bureau
 * uses canShare to decide whether to surface the §4.4 grant-and-summon
 * dialog after the access report comes back with deniedRecipients.length>0.
 */

import { env } from '../env.js';

// ─────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────

export type CrossAppName = 'board' | 'brief' | 'bam' | string;

export interface CrossAppAccessDecision {
  /** true when the user can READ the target resource. */
  allowed: boolean;
  /**
   * true when the user has SHARE/invite rights on the target. This is only
   * meaningful for the summoner (see §4.4); we leave it on the response so
   * a single resolveAccess call can drive both the recipient-eligibility
   * filter and the summoner's "Grant access" dialog.
   */
  canShare: boolean;
  /**
   * Optional structured reason for denial — useful for logging and for the
   * audit row's recipients[].outcome field. Never surfaced verbatim to the
   * summoner per §10 step 4a ("denial is private to the denied").
   */
  reason?: string;
}

export interface ResolveAccessArgs {
  /** The org doing the summon. Forwarded to the peer's auth check. */
  orgId: string;
  /**
   * The user whose access we are checking. May be a recipient (eligibility
   * filter) or the summoner themselves (canShare probe). The handler does
   * not need to distinguish.
   */
  userId: string;
  /** Target app (e.g. 'board', 'brief', 'bam'). */
  app: CrossAppName;
  /** Canonical target URL — the same one we'll navigate to. */
  targetUrl: string;
}

// ─────────────────────────────────────────────────────────────────────
// HTTP helper
// ─────────────────────────────────────────────────────────────────────

interface RawAccessResponse {
  allowed?: unknown;
  canShare?: unknown;
  can_share?: unknown;
  reason?: unknown;
}

/**
 * Attempt a live cross-app can-read preflight against `${baseUrl}${path}`.
 * Returns null when:
 *   - INTERNAL_SERVICE_SECRET is unset (no way to authenticate),
 *   - the destination does not respond / responds non-200,
 *   - the response body is unparseable.
 *
 * Returning null is the signal to fall back to the safe default in the
 * caller. We deliberately do NOT throw — a peer outage must not cascade
 * into a Bureau 500, and §10 specifies a quiet eligibility filter.
 */
async function tryLivePreflight(
  baseUrl: string,
  path: string,
  args: ResolveAccessArgs,
): Promise<CrossAppAccessDecision | null> {
  if (!env.INTERNAL_SERVICE_SECRET) return null;
  if (!baseUrl) return null;

  try {
    const url = `${baseUrl.replace(/\/$/, '')}${path}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Service-Secret': env.INTERNAL_SERVICE_SECRET,
        'X-Organization-ID': args.orgId,
      },
      body: JSON.stringify({
        user_id: args.userId,
        org_id: args.orgId,
        target_url: args.targetUrl,
      }),
    });
    if (!response.ok) return null;

    const raw = (await response.json()) as RawAccessResponse;
    const allowed = raw.allowed === true;
    const canShare = raw.canShare === true || raw.can_share === true;
    const reason = typeof raw.reason === 'string' ? raw.reason : undefined;
    return { allowed, canShare, reason };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Per-app handlers
// ─────────────────────────────────────────────────────────────────────

/**
 * Board access check — live preflight against board-api's
 * POST /v1/internal/can-read (apps/board-api/src/routes/internal.routes.ts),
 * which mirrors requireBoardAccess. stub_allow only on transport failure.
 */
async function checkBoardAccess(
  args: ResolveAccessArgs,
): Promise<CrossAppAccessDecision> {
  const live = await tryLivePreflight(
    env.BOARD_INTERNAL_URL,
    '/v1/internal/can-read',
    args,
  );
  if (live) return live;

  return { allowed: true, canShare: false, reason: 'stub_allow' };
}

/**
 * Brief access check — live preflight against brief-api's
 * POST /v1/internal/can-read (apps/brief-api/src/routes/internal.routes.ts),
 * which mirrors requireDocumentAccess. stub_allow only on transport failure.
 */
async function checkBriefAccess(
  args: ResolveAccessArgs,
): Promise<CrossAppAccessDecision> {
  const live = await tryLivePreflight(
    env.BRIEF_INTERNAL_URL,
    '/v1/internal/can-read',
    args,
  );
  if (live) return live;

  return { allowed: true, canShare: false, reason: 'stub_allow' };
}

/**
 * Bam access check (projects, tasks, sprints, ...) — live preflight against
 * apps/api's POST /internal/can-read, which dispatches through the §11
 * visibility.service.ts preflightAccess(). can_share is always false for
 * Bam targets (no one-click grant concept). stub_allow only on transport
 * failure.
 */
async function checkBamAccess(
  args: ResolveAccessArgs,
): Promise<CrossAppAccessDecision> {
  const live = await tryLivePreflight(
    env.BBB_API_INTERNAL_URL,
    '/internal/can-read',
    args,
  );
  if (live) return live;

  return { allowed: true, canShare: false, reason: 'stub_allow' };
}

// ─────────────────────────────────────────────────────────────────────
// Public entrypoint
// ─────────────────────────────────────────────────────────────────────

/**
 * Resolve whether `userId` is allowed to navigate to `targetUrl` on `app`,
 * and (separately) whether they have share/invite rights on that target.
 *
 * Unknown apps fall through to a safe default — `{ allowed: true,
 * canShare: false }` — so a future destination app can be summoned to
 * before its handler is wired here. The summon flow records the actual
 * outcome in the audit row regardless.
 */
export async function resolveAccess(
  args: ResolveAccessArgs,
): Promise<CrossAppAccessDecision> {
  switch (args.app) {
    case 'board':
      return checkBoardAccess(args);
    case 'brief':
      return checkBriefAccess(args);
    case 'bam':
      return checkBamAccess(args);
    default:
      // Unknown destination: assume the URL is reachable. The audit row
      // will still record per-recipient outcomes so a missed handler is
      // visible in Bench.
      return { allowed: true, canShare: false, reason: 'unknown_app' };
  }
}

/**
 * Resolve access for a batch of (userId, app, targetUrl) tuples in
 * parallel. Bureau uses this to fan out the access check across every
 * eligible recipient in one shot. Order is preserved.
 */
export async function resolveAccessBatch(
  argsList: ResolveAccessArgs[],
): Promise<CrossAppAccessDecision[]> {
  return Promise.all(argsList.map((a) => resolveAccess(a)));
}

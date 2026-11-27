// Bureau's cross-app access preflight (#300): "may this user learn that someone is at, or be
// summoned to, this suite URL?" ONE implementation, used by bureau-api (presence where/here,
// summon) and by the worker's summon fan-out. It used to exist twice, and both copies failed OPEN
// (unknown app, any non-200, missing secret and a thrown error all meant "allowed"), so presence
// and summons revealed Bond/Bill/Beacon/Helpdesk entity names to users the owning app refuses.
//
// SERVER-ONLY (it sends the internal service secret). Shipped as its own tsup entry and package
// subpath, `@bigbluebam/shared/cross-app-access`, and deliberately NOT re-exported from index.ts.
//
// ── FAIL-CLOSED CONTRACT (do not weaken) ────────────────────────────────────
// The ONLY outcome that allows is an explicit `allowed: true` in a 2xx body from the owning
// service. A URL outside the suite's apps, a missing secret, a non-2xx (401/403 from a wiring
// fault included), a timeout, a transport error and a malformed body all DENY, with a reason, and
// every degraded deny is reported through onDegraded so an outage is visible instead of silent.
//
// Routing: board and brief answer for their own URLs (their collaborator tables give canShare);
// every other suite URL, Bam included, goes to the api's POST /internal/can-read, which maps the
// URL to a can_access entity type and answers through the canonical visibility service, denying
// URLs it cannot map. Bureau's own URLs (floors and rooms, org-wide spaces whose entry Bureau
// enforces itself) are the one local allow.

import { launchpadAppFromUrl } from './launchpad-apps.js';

export interface CrossAppAccessDecision {
  /** true when the user may READ the target. */
  allowed: boolean;
  /** true when the user may share/invite on the target (board/brief only). */
  canShare: boolean;
  /** Why; never shown to a summoner verbatim (spec section 10, "denial is private"). */
  reason: string;
}

export interface CrossAppAccessArgs {
  orgId: string;
  userId: string;
  /** The URL the user would be told about or navigated to. The app is derived from it. */
  targetUrl: string;
}

export type CrossAppDegradedReason = 'no_secret' | 'http_error' | 'timeout' | 'transport_error' | 'malformed_body';

export interface CrossAppAccessConfig {
  internalServiceSecret: string | undefined;
  apiInternalUrl: string;
  boardInternalUrl: string;
  briefInternalUrl: string;
  /** Per-request timeout, milliseconds. Default 4000. */
  timeoutMs?: number;
  /** Called for every degraded deny (never for a real answer). Must not throw. */
  onDegraded?: (info: { reason: CrossAppDegradedReason; app: string; detail?: string }) => void;
}

const DEFAULT_TIMEOUT_MS = 4000;

function deny(reason: string): CrossAppAccessDecision {
  return { allowed: false, canShare: false, reason };
}

function degraded(
  config: CrossAppAccessConfig,
  app: string,
  reason: CrossAppDegradedReason,
  detail?: string,
): CrossAppAccessDecision {
  try {
    config.onDegraded?.({ reason, app, detail });
  } catch {
    // An observability hook must never turn a deny into a throw.
  }
  return deny(`degraded_${reason}`);
}

async function askPeer(
  config: CrossAppAccessConfig,
  app: string,
  baseUrl: string,
  path: string,
  args: CrossAppAccessArgs,
): Promise<CrossAppAccessDecision> {
  const secret = config.internalServiceSecret;
  if (!secret) return degraded(config, app, 'no_secret');
  let response: Response;
  try {
    response = await fetch(`${baseUrl.replace(/\/+$/, '')}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Service-Secret': secret,
        'X-Organization-ID': args.orgId,
      },
      body: JSON.stringify({ user_id: args.userId, org_id: args.orgId, target_url: args.targetUrl }),
      signal: AbortSignal.timeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return degraded(config, app, timedOut ? 'timeout' : 'transport_error', err instanceof Error ? err.message : undefined);
  }
  if (!response.ok) return degraded(config, app, 'http_error', `status ${response.status}`);
  let raw: { allowed?: unknown; canShare?: unknown; can_share?: unknown; reason?: unknown };
  try {
    raw = (await response.json()) as typeof raw;
  } catch {
    return degraded(config, app, 'malformed_body', 'not JSON');
  }
  if (typeof raw?.allowed !== 'boolean') return degraded(config, app, 'malformed_body', 'allowed is not a boolean');
  const reason = typeof raw.reason === 'string' ? raw.reason : raw.allowed ? 'allowed' : 'denied';
  if (!raw.allowed) return deny(reason);
  return { allowed: true, canShare: raw.canShare === true || raw.can_share === true, reason };
}

/** Decide whether `userId` may learn about / be sent to `targetUrl`. Never throws. */
export async function resolveCrossAppAccess(
  args: CrossAppAccessArgs,
  config: CrossAppAccessConfig,
): Promise<CrossAppAccessDecision> {
  const app = launchpadAppFromUrl(args.targetUrl);
  if (!app) return deny('unsupported_app');
  switch (app) {
    case 'bureau':
      return { allowed: true, canShare: false, reason: 'bureau_floor' };
    case 'board':
      return askPeer(config, app, config.boardInternalUrl, '/v1/internal/can-read', args);
    case 'brief':
      return askPeer(config, app, config.briefInternalUrl, '/v1/internal/can-read', args);
    default:
      return askPeer(config, app, config.apiInternalUrl, '/internal/can-read', args);
  }
}

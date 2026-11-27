/**
 * Cross-app access checks for presence (where/here) and the section 10 summon system.
 *
 * The design doc (section 10 step 3) is explicit: "Occupants without access are recorded as
 * `no_access`. They are not navigated and not notified, so the summon never reveals the resource
 * to someone who cannot open it." Presence where/here apply the same rule to the URL a user is on.
 *
 * The rule lives ONCE, in `@bigbluebam/shared/cross-app-access` (#300), shared with the worker's
 * summon fan-out. It fails CLOSED: a URL outside the suite apps, a missing secret, any non-2xx
 * (a 401/403 wiring fault included), a timeout and a malformed body all deny. Board and Brief
 * answer for their own URLs; every other suite URL (Bam, Bond, Bill, Beacon, Helpdesk, ...) goes
 * to the api's POST /internal/can-read, which maps the URL to a can_access entity type and denies
 * what it cannot map. This file only supplies bureau-api's config and logs degraded denies.
 *
 * canShare semantics: only true when the user has share/invite rights on the target (Board and
 * Brief collaborator tables). Bureau uses it on the SUMMONER to offer the section 4.4
 * grant-and-summon dialog.
 */

import {
  resolveCrossAppAccess,
  type CrossAppAccessDecision,
} from '@bigbluebam/shared/cross-app-access';
import { env } from '../env.js';

export type { CrossAppAccessDecision };

/** Kept for callers that still pass the app; the decision derives it from targetUrl. */
export type CrossAppName = string;

export interface ResolveAccessArgs {
  orgId: string;
  userId: string;
  /** Informational: the shared resolver classifies the URL itself, so the two cannot disagree. */
  app?: CrossAppName;
  /** The URL the user would be told about or navigated to. */
  targetUrl: string;
}

export interface ResolveAccessOptions {
  /** Where degraded denies are reported (a request logger); defaults to stderr. */
  log?: { warn: (obj: object, msg: string) => void };
}

/** Resolve whether `userId` may learn about / be sent to `targetUrl`. Never throws. */
export async function resolveAccess(
  args: ResolveAccessArgs,
  options: ResolveAccessOptions = {},
): Promise<CrossAppAccessDecision> {
  return resolveCrossAppAccess(
    { orgId: args.orgId, userId: args.userId, targetUrl: args.targetUrl },
    {
      internalServiceSecret: env.INTERNAL_SERVICE_SECRET,
      apiInternalUrl: env.BBB_API_INTERNAL_URL,
      boardInternalUrl: env.BOARD_INTERNAL_URL,
      briefInternalUrl: env.BRIEF_INTERNAL_URL,
      onDegraded: (info) => {
        const entry = { ...info, target_url: args.targetUrl };
        const msg = 'bureau cross-app access preflight degraded; denying (fail closed)';
        if (options.log) options.log.warn(entry, msg);
        else console.warn(msg, entry);
      },
    },
  );
}

/** Resolve access for many tuples in parallel; order is preserved. */
export async function resolveAccessBatch(
  argsList: ResolveAccessArgs[],
  options: ResolveAccessOptions = {},
): Promise<CrossAppAccessDecision[]> {
  return Promise.all(argsList.map((a) => resolveAccess(a, options)));
}

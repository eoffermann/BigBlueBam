/**
 * Bureau summon orchestration (Agent C, workstream 6).
 *
 * Implements §10 of the design doc end-to-end:
 *
 *   1. planSummon         — resolve summoner's room, list occupants, run
 *                            access checks, return { eligible, denied }.
 *   2. recordSummon       — write the durable bureau_summons audit row
 *                            with the per-recipient outcomes.
 *   3. fanOutSummon       — push summon_incoming to each eligible recipient,
 *                            optionally offloading to BullMQ for large rooms.
 *   4. reportDenials      — push summon_access_report to the summoner.
 *   5. grantAccessAndSummon — (v1 stub) the §4.4 "Grant access & bring them"
 *                              follow-up path. Will eventually call each
 *                              destination app's share API; for v1 we audit
 *                              the request and re-fire summon_incoming.
 *
 * Why these are services, not WS handlers: the REST surface in
 * apps/bureau-api/src/routes/summons.routes.ts mirrors the WS messages
 * one-for-one, and the BullMQ fanout job in apps/worker/ duplicates the
 * recipient resolution + push loop. Centralising the orchestration here
 * keeps the four call sites (WS hub, REST route, fanout job, and the
 * REST grant-access route) honest about the audit-row contract.
 *
 * Bolt: bureau.summon.issued is emitted from this module (not from the
 * route layer) so the inline path and the fanout-job path both get
 * exactly one event per summon.
 *
 * NOTE on `lkRoomHint` (v2 unified-call model — Phase 3).
 *   `lkRoomHint` / `livekit_room_hint` is retained on the wire and in the
 *   `bureau_summons` audit row but is now AUDIT-ONLY. The bureau-client
 *   SDK on the recipient no longer encodes it into the destination URL
 *   (the `?lkRoom=` query param is gone — see
 *   packages/bureau-client/src/summon-handler.tsx). The SDK joins whichever
 *   LiveKit room the unified call manager resolves on URL change:
 *   `bureau-room-{spatial}` while still in a spatial room, otherwise
 *   `huddle-{app}-{surface_id}` for the destination surface. The audit
 *   row's hint records what the summoner was IN at summon time; it does
 *   not steer the destination's call.
 */

import type { FastifyBaseLogger } from 'fastify';
import type Redis from 'ioredis';
import { eq, sql } from 'drizzle-orm';
import { Queue } from 'bullmq';
import { db } from '../db/index.js';
import { bureauSummons, bureauSettings } from '../db/schema/bureau.js';
import { users } from '../db/schema/index.js';
import { getRoomOccupants } from './presence.service.js';
import { publishUserTarget } from './presence-publisher.service.js';
import {
  resolveAccess,
  type CrossAppAccessDecision,
  type CrossAppName,
} from './cross-app-access.service.js';
import { emitSummonIssued } from '../lib/bureau-events.js';

// ─────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────

/**
 * Recipient-count threshold above which we hand the fan-out off to the
 * BullMQ `bureau.summon.fanout` job rather than running it inline in the
 * request handler. Tuned per §10 step 4 "If the room is large, offload..."
 * and matches the threshold called out in the workstream-6 assignment.
 */
export const FANOUT_INLINE_LIMIT = 10;

/** BullMQ queue name for the fan-out worker (apps/worker). */
export const SUMMON_FANOUT_QUEUE = 'bureau-summon-fanout';

// ─────────────────────────────────────────────────────────────────────
// Types — public contract for the routes layer and the WS handler
// ─────────────────────────────────────────────────────────────────────

export interface SummonRecipientRecord {
  userId: string;
  /** name resolved at audit-time so a downstream display doesn't need a JOIN. */
  name: string | null;
  /**
   * eligibility = the access-check result before the user has had a chance
   * to respond. The audit row's `outcome` field evolves: starts as
   * `pending` (eligible) or `no_access` (denied); transitions to
   * `joined` / `declined` / `granted` / `timed_out` later.
   */
  outcome: SummonRecipientOutcome;
  reason?: string;
}

export type SummonRecipientOutcome =
  | 'pending'
  | 'joined'
  | 'declined'
  | 'no_access'
  | 'granted'
  | 'timed_out';

export interface PlanSummonArgs {
  orgId: string;
  summonerId: string;
  targetUrl: string;
  targetApp: CrossAppName;
  targetLabel?: string | null;
  lkRoomHint?: string | null;
}

export interface SummonPlan {
  summonId: string;
  /** Pre-allocated UUID for the bureau_summons row; populated by recordSummon. */
  fromRoomId: string | null;
  eligibleRecipients: SummonRecipientRecord[];
  deniedRecipients: SummonRecipientRecord[];
  /** Did the summoner have share rights on the target? Drives the §4.4 dialog. */
  canShare: boolean;
}

export interface RecordSummonArgs {
  orgId: string;
  summonerId: string;
  fromRoomId: string | null;
  targetUrl: string;
  targetApp: CrossAppName;
  targetLabel?: string | null;
  lkRoomHint?: string | null;
  eligible: SummonRecipientRecord[];
  denied: SummonRecipientRecord[];
}

export interface FanOutSummonArgs {
  redis: Redis;
  summonId: string;
  orgId: string;
  summonerId: string;
  summonerName: string | null;
  targetUrl: string;
  targetApp: CrossAppName;
  targetLabel?: string | null;
  lkRoomHint?: string | null;
  recipients: SummonRecipientRecord[];
  /** When true, force inline fan-out regardless of recipient count (used by tests / worker). */
  forceInline?: boolean;
  logger?: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;
}

export interface ReportDenialsArgs {
  redis: Redis;
  summonId: string;
  summonerId: string;
  denied: SummonRecipientRecord[];
  canShare: boolean;
}

export interface GrantAccessAndSummonArgs {
  redis: Redis;
  summonId: string;
  summonerId: string;
  userIds: string[];
  /** Pre-resolved display name (optional); we look it up if missing. */
  summonerName?: string | null;
  logger?: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;
}

// ─────────────────────────────────────────────────────────────────────
// Redis key helpers (mirror §7 + presence-publisher channel names)
// ─────────────────────────────────────────────────────────────────────

function userChannel(userId: string): string {
  return `user:${userId}`;
}

// ─────────────────────────────────────────────────────────────────────
// Frame helper — same envelope the WS hub uses for outbound frames.
// ─────────────────────────────────────────────────────────────────────

function frame(type: string, data: Record<string, unknown>): string {
  return JSON.stringify({
    type,
    data,
    timestamp: new Date().toISOString(),
  });
}

// ─────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────

/**
 * Look up the summoner's most recent active session in Redis to find the
 * room they are currently in. We walk every session in
 * `bureau:user:{userId}:sessions` and return the first non-empty roomId we
 * see — the §7 model collapses a user's multi-device sessions into one
 * floor avatar, so any device's roomId is authoritative.
 *
 * Returns null when the summoner has no live session or is not in a room
 * (which §10 calls out as the "summoner has no current room → summon
 * disabled" edge case).
 */
async function resolveSummonerRoom(
  redis: Redis,
  summonerId: string,
): Promise<{ roomId: string; floorId: string | null } | null> {
  const sessionIds = await redis.smembers(`bureau:user:${summonerId}:sessions`);
  if (sessionIds.length === 0) return null;

  const pipeline = redis.pipeline();
  for (const sid of sessionIds) {
    pipeline.hmget(`bureau:sess:${sid}`, 'roomId', 'floorId');
  }
  const results = await pipeline.exec();
  if (!results) return null;

  for (const entry of results) {
    if (!entry) continue;
    const [err, value] = entry;
    if (err) continue;
    if (!Array.isArray(value)) continue;
    const [roomId, floorId] = value as [string | null, string | null];
    if (roomId && roomId.length > 0) {
      return { roomId, floorId: floorId && floorId.length > 0 ? floorId : null };
    }
  }
  return null;
}

/**
 * Resolve display names for a batch of userIds in one query so the audit
 * row stores readable values without forcing every consumer to JOIN.
 */
async function resolveDisplayNames(
  userIds: string[],
): Promise<Map<string, string>> {
  if (userIds.length === 0) return new Map();
  const unique = Array.from(new Set(userIds));
  const out = new Map<string, string>();
  // Drizzle's `inArray` is preferred but we keep this simple and use a
  // per-id loop — the recipient sets are bounded by room capacity (~50)
  // and a single round-trip per name is acceptable here.
  for (const uid of unique) {
    const [row] = await db
      .select({ id: users.id, name: users.display_name })
      .from(users)
      .where(eq(users.id, uid))
      .limit(1);
    if (row) out.set(row.id, row.name);
  }
  return out;
}

/**
 * Per-room/per-user `allow_auto_follow` evaluation. v1 only consults the
 * org-level bureau_settings.allow_auto_follow toggle — the per-user/per-
 * room preference column does not exist yet. The §10 step 5 path that
 * shows the 3-second cancelable auto-navigate is still wired client-side;
 * Bureau just decides whether to forward `autoFollow: true` here.
 *
 * Returns false on any error so a misconfigured org never auto-yanks
 * users into a destination they did not explicitly accept.
 */
async function shouldAutoFollow(orgId: string): Promise<boolean> {
  try {
    const [row] = await db
      .select({ allow: bureauSettings.allow_auto_follow })
      .from(bureauSettings)
      .where(eq(bureauSettings.org_id, orgId))
      .limit(1);
    if (!row) return false;
    return row.allow === true;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────
// planSummon
// ─────────────────────────────────────────────────────────────────────

/**
 * Resolve the summoner's room, list occupants, run the cross-app access
 * filter, and return the eligible/denied split plus the summoner's own
 * share-rights flag.
 *
 * Returns null when the summoner is not currently in a room — caller
 * should reply with a BAD_REQUEST ("summon disabled: no current room").
 */
export async function planSummon(
  redis: Redis,
  args: PlanSummonArgs,
): Promise<SummonPlan | null> {
  const room = await resolveSummonerRoom(redis, args.summonerId);
  if (!room) return null;

  const occupants = await getRoomOccupants(redis, room.roomId);
  // Filter the summoner out — §10 step 2.
  const recipientIds = occupants.filter((uid) => uid !== args.summonerId);

  // Resolve summoner's own share rights first so the value lands on the plan
  // even when no one else is in the room (edge case: solo summoner clicks
  // "Bring everyone here" with an empty room — the dialog still needs to know
  // whether sharing is available).
  const summonerAccess = await resolveAccess({
    orgId: args.orgId,
    userId: args.summonerId,
    app: args.targetApp,
    targetUrl: args.targetUrl,
  });

  // Resolve display names for every recipient + the summoner in one pass.
  const nameMap = await resolveDisplayNames([
    args.summonerId,
    ...recipientIds,
  ]);

  // Per-recipient access check in parallel.
  const decisions: CrossAppAccessDecision[] = await Promise.all(
    recipientIds.map((uid) =>
      resolveAccess({
        orgId: args.orgId,
        userId: uid,
        app: args.targetApp,
        targetUrl: args.targetUrl,
      }),
    ),
  );

  const eligible: SummonRecipientRecord[] = [];
  const denied: SummonRecipientRecord[] = [];

  for (let i = 0; i < recipientIds.length; i++) {
    const uid = recipientIds[i]!;
    const decision = decisions[i]!;
    const name = nameMap.get(uid) ?? null;
    if (decision.allowed) {
      eligible.push({ userId: uid, name, outcome: 'pending' });
    } else {
      denied.push({
        userId: uid,
        name,
        outcome: 'no_access',
        reason: decision.reason,
      });
    }
  }

  return {
    summonId: '', // populated by recordSummon
    fromRoomId: room.roomId,
    eligibleRecipients: eligible,
    deniedRecipients: denied,
    canShare: summonerAccess.canShare,
  };
}

// ─────────────────────────────────────────────────────────────────────
// recordSummon
// ─────────────────────────────────────────────────────────────────────

/**
 * Insert the durable bureau_summons row with the resolved recipients.
 * Returns the row's UUID, which is the summonId used everywhere else.
 */
export async function recordSummon(args: RecordSummonArgs): Promise<string> {
  const recipients = [
    ...args.eligible.map((r) => ({
      userId: r.userId,
      name: r.name,
      outcome: r.outcome,
    })),
    ...args.denied.map((r) => ({
      userId: r.userId,
      name: r.name,
      outcome: r.outcome,
      reason: r.reason ?? null,
    })),
  ];

  const [row] = await db
    .insert(bureauSummons)
    .values({
      org_id: args.orgId,
      summoner_id: args.summonerId,
      from_room_id: args.fromRoomId ?? null,
      target_url: args.targetUrl,
      target_app: args.targetApp,
      target_label: args.targetLabel ?? null,
      livekit_room_hint: args.lkRoomHint ?? null,
      recipients,
    })
    .returning({ id: bureauSummons.id });

  if (!row) {
    throw new Error('recordSummon: insert returned no row');
  }
  return row.id;
}

// ─────────────────────────────────────────────────────────────────────
// fanOutSummon
// ─────────────────────────────────────────────────────────────────────

let _summonFanoutQueue: Queue | null = null;

function getFanoutQueue(redis: Redis): Queue {
  if (_summonFanoutQueue) return _summonFanoutQueue;
  // Reuse the bureau-api's redis client for the BullMQ connection. BullMQ
  // does NOT put the client into subscriber mode on a publish-only Queue,
  // so we can safely share the connection with the rest of bureau-api's
  // pub/sub.
  _summonFanoutQueue = new Queue(SUMMON_FANOUT_QUEUE, { connection: redis });
  return _summonFanoutQueue;
}

/**
 * Push `summon_incoming` to every eligible recipient. Below the inline
 * limit we publish directly on each `user:{id}` Redis channel; above the
 * limit we enqueue a BullMQ job and let the worker do the same work off
 * the request hot path.
 *
 * Bolt `bureau.summon.issued` is emitted from inside this function on the
 * inline branch. The worker job is responsible for emitting it on the
 * offloaded branch (so we never double-fire).
 */
export async function fanOutSummon(args: FanOutSummonArgs): Promise<void> {
  const offload =
    !args.forceInline && args.recipients.length > FANOUT_INLINE_LIMIT;

  if (offload) {
    const queue = getFanoutQueue(args.redis);
    await queue.add(
      'fanout',
      {
        summonId: args.summonId,
        orgId: args.orgId,
        summonerId: args.summonerId,
      },
      {
        removeOnComplete: 200,
        removeOnFail: 500,
      },
    );
    return;
  }

  const autoFollow = await shouldAutoFollow(args.orgId);

  for (const recipient of args.recipients) {
    const payload = frame('summon_incoming', {
      summonId: args.summonId,
      summoner: { id: args.summonerId, name: args.summonerName ?? null },
      targetUrl: args.targetUrl,
      app: args.targetApp,
      label: args.targetLabel ?? null,
      lkRoomHint: args.lkRoomHint ?? null,
      autoFollow,
    });
    try {
      await args.redis.publish(userChannel(recipient.userId), payload);
    } catch (err) {
      args.logger?.warn?.(
        { err, summonId: args.summonId, recipientId: recipient.userId },
        'fanOutSummon: publish failed for recipient (swallowed)',
      );
    }
  }

  // Bolt event: one per inline summon. The worker offload path emits its
  // own copy from apps/worker/src/jobs/bureau-summon-fanout.ts.
  emitSummonIssued(args.orgId, args.summonerId, {
    summon: { id: args.summonId },
    summoner: { id: args.summonerId },
    target_url: args.targetUrl,
    target_app: args.targetApp,
    target_label: args.targetLabel ?? null,
    livekit_room_hint: args.lkRoomHint ?? null,
    recipient_count: args.recipients.length,
    actor: { id: args.summonerId },
    org: { id: args.orgId },
  }).catch(() => {
    /* fire-and-forget */
  });
}

// ─────────────────────────────────────────────────────────────────────
// reportDenials
// ─────────────────────────────────────────────────────────────────────

/**
 * Push `summon_access_report` back to the summoner with the held-back
 * recipients and the canShare flag. Per §10 step 4a we send this only
 * when at least one occupant was denied; the caller is responsible for
 * skipping the call when denied.length === 0.
 */
export async function reportDenials(args: ReportDenialsArgs): Promise<void> {
  const payload = frame('summon_access_report', {
    summonId: args.summonId,
    denied: args.denied.map((r) => ({ userId: r.userId, name: r.name })),
    canShare: args.canShare,
  });
  await publishUserTarget(args.redis, args.summonerId, payload);
}

// ─────────────────────────────────────────────────────────────────────
// grantAccessAndSummon — v1 stub per the assignment.
// ─────────────────────────────────────────────────────────────────────

/**
 * v1 implementation of the §4.4 "Grant access & bring them" follow-up.
 *
 * TODO(workstream 6 follow-up): for each destination app, call the
 * canonical share/invite API:
 *   - board → POST /v1/internal/boards/:id/share { user_id, role }
 *   - brief → POST /v1/internal/documents/:id/share { user_id, role }
 *   - bam   → POST /internal/projects/:id/share   { user_id, role }
 *
 * For v1 we log the request, mutate the bureau_summons row to flip each
 * userId's outcome from `no_access` to `granted`, and re-fire
 * summon_incoming to them so the dialog completes end-to-end. The actual
 * share never happens, so a recipient who lacked access before will still
 * get a 403 on navigation; this is documented as a known follow-up and
 * surfaces in the next session as a denial they can knock through.
 */
export async function grantAccessAndSummon(
  args: GrantAccessAndSummonArgs,
): Promise<{ granted: number; missing: string[] }> {
  const [summon] = await db
    .select()
    .from(bureauSummons)
    .where(eq(bureauSummons.id, args.summonId))
    .limit(1);

  if (!summon) {
    args.logger?.warn?.(
      { summonId: args.summonId },
      'grantAccessAndSummon: summon row not found',
    );
    return { granted: 0, missing: args.userIds };
  }
  if (summon.summoner_id !== args.summonerId) {
    args.logger?.warn?.(
      { summonId: args.summonId, summonerId: args.summonerId },
      'grantAccessAndSummon: caller is not the summoner',
    );
    return { granted: 0, missing: args.userIds };
  }

  // Flip no_access → granted for any userId in args.userIds that is
  // present, leave others untouched. The write is a single atomic SQL
  // statement rewriting only the matching entries inside the recipients
  // JSONB array — a JS read-modify-write here would race the recipients'
  // own concurrent `summon_respond` updates and lose one side.
  type RecipientRow = {
    userId: string;
    name?: string | null;
    outcome: SummonRecipientOutcome;
    reason?: string | null;
  };
  const recipients = Array.isArray(summon.recipients)
    ? (summon.recipients as RecipientRow[])
    : [];
  const targetSet = new Set(args.userIds);
  const granted: RecipientRow[] = [];
  const missing: string[] = [];

  for (const uid of args.userIds) {
    const existing = recipients.find((r) => r.userId === uid);
    if (!existing) {
      missing.push(uid);
      continue;
    }
    if (existing.outcome === 'no_access') {
      granted.push({ ...existing, outcome: 'granted', reason: undefined });
    } else {
      // Already eligible or already granted — skip the flip, still re-fire.
      granted.push(existing);
    }
  }

  if (granted.length > 0) {
    // Explicit ::text[] cast — drizzle binds a bare JS array interpolated
    // into sql`` as one untyped param, which Postgres rejects (the D-9
    // 42809 bug class).
    await db.execute(sql`
      UPDATE bureau_summons
      SET recipients = (
        SELECT COALESCE(
          jsonb_agg(
            CASE
              WHEN elem->>'userId' = ANY(${args.userIds}::text[])
               AND elem->>'outcome' = 'no_access'
              THEN jsonb_set(elem - 'reason', '{outcome}', '"granted"'::jsonb)
              ELSE elem
            END
            ORDER BY idx
          ),
          '[]'::jsonb
        )
        FROM jsonb_array_elements(recipients) WITH ORDINALITY AS t(elem, idx)
      )
      WHERE id = ${args.summonId} AND summoner_id = ${args.summonerId}
    `);
  }

  // TODO: call destination app share APIs here.
  args.logger?.info?.(
    {
      summonId: args.summonId,
      app: summon.target_app,
      userIds: args.userIds,
    },
    'grantAccessAndSummon: share calls not yet implemented (v1 stub)',
  );

  // Re-fire summon_incoming to the now-"granted" users so the client
  // dialog completes. We use the same inline path as fanOutSummon — there
  // is never more than O(roomSize) targets here.
  if (granted.length > 0) {
    await fanOutSummon({
      redis: args.redis,
      summonId: args.summonId,
      orgId: summon.org_id,
      summonerId: args.summonerId,
      summonerName: args.summonerName ?? null,
      targetUrl: summon.target_url,
      targetApp: summon.target_app as CrossAppName,
      targetLabel: summon.target_label ?? null,
      lkRoomHint: summon.livekit_room_hint ?? null,
      recipients: granted
        .filter((r) => targetSet.has(r.userId))
        .map((r) => ({
          userId: r.userId,
          name: r.name ?? null,
          outcome: r.outcome,
        })),
      forceInline: true,
      logger: args.logger,
    });
  }

  return { granted: granted.length, missing };
}


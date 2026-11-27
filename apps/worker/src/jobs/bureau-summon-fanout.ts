/**
 * Bureau summon fan-out worker job (Agent C, workstream 6).
 *
 * Spec: docs/plans/bureau-design-document.md §10 step 4, §13 row
 * `bureau.summon.fanout`.
 *
 * Triggered by bureau-api when a planSummon produces more than
 * FANOUT_INLINE_LIMIT eligible recipients. The handler:
 *
 *   1. Loads the bureau_summons audit row.
 *   2. Re-runs the per-recipient access check (mirrors
 *      cross-app-access.service.ts in bureau-api). This is a defense-in-
 *      depth pass: the inline plan already did one, but the worker may
 *      run minutes later if BullMQ backs up, and a permission revocation
 *      in that window must still be respected.
 *   3. Publishes summon_incoming on each eligible recipient's `user:{id}`
 *      Redis channel using the same JSON frame envelope the WS hub uses.
 *   4. Publishes summon_progress to the summoner as recipients are
 *      processed (so the §4.4 dialog can show "Sending invites... 17/42").
 *   5. Mutates the recipients[] JSONB on the audit row to flip newly-
 *      discovered no_access entries from `pending` → `no_access`.
 *   6. Emits the §14 Bolt `bureau.summon.issued` event exactly once.
 *
 * Unavailable is not denied (#330). A check that could not get a real answer
 * (peer down, timeout, non-2xx) leaves the recipient owed a check instead of
 * recording a final no_access; the pass stops spending timeouts once the peer
 * is known to be down and throws, so BullMQ retries with backoff (the queue is
 * enqueued with attempts + exponential backoff). Checks run with bounded
 * concurrency under a wall-clock budget. Only the last attempt records
 * `access_check_unavailable` and completes.
 *
 * NOTE on `lkRoomHint` (v2 unified-call model — Phase 3).
 *   We still ship `lkRoomHint` in the summon_incoming frame for audit
 *   parity with the audit row, but the recipient's bureau-client SDK no
 *   longer threads it into the destination URL — the SDK joins whichever
 *   LiveKit room the unified call manager resolves on URL change. The
 *   `?lkRoom=` query param is dead end-to-end.
 *
 * The access check is the one in `@bigbluebam/shared/cross-app-access`
 * (#300), the same function bureau-api calls. It used to be a copy here,
 * and both copies failed open; it now fails CLOSED in one place.
 */

import type { Job } from 'bullmq';
import type Redis from 'ioredis';
import type { Logger } from 'pino';
import { sql } from 'drizzle-orm';
import { getDb } from '../utils/db.js';
import { publishBoltEvent } from '../utils/bolt-events.js';
import {
  isDegradedDecision,
  isDegradedReason,
  resolveCrossAppAccess,
  type CrossAppAccessDecision,
} from '@bigbluebam/shared/cross-app-access';
import type { Env } from '../env.js';

// ---------------------------------------------------------------------------
// Job payload (mirrors bureau-api summon.service.ts queue.add(...) payload)
// ---------------------------------------------------------------------------

export interface BureauSummonFanoutJobData {
  summonId: string;
  orgId: string;
  summonerId: string;
  /** Recipients already sent summon_incoming by an earlier attempt (#330). */
  notifiedUserIds?: string[];
}

// ---------------------------------------------------------------------------
// Audit-row shape (mirrors infra/postgres/migrations/0176_bureau_tables.sql)
// ---------------------------------------------------------------------------

type SummonRecipientOutcome =
  | 'pending'
  | 'joined'
  | 'declined'
  | 'no_access'
  | 'granted'
  | 'timed_out';

interface SummonRecipientRow {
  userId: string;
  name?: string | null;
  outcome: SummonRecipientOutcome;
  reason?: string | null;
}

interface SummonAuditRow {
  id: string;
  org_id: string;
  summoner_id: string;
  summoner_name: string | null;
  from_room_id: string | null;
  target_url: string;
  target_app: string;
  target_label: string | null;
  livekit_room_hint: string | null;
  recipients: SummonRecipientRow[];
}

// ---------------------------------------------------------------------------
// Cross-app access check: the shared fail-closed resolver (#300).
// ---------------------------------------------------------------------------

export type SummonFanoutEnv = Pick<
  Env,
  'INTERNAL_SERVICE_SECRET' | 'BBB_API_INTERNAL_URL' | 'BOARD_INTERNAL_URL' | 'BRIEF_INTERNAL_URL'
>;

function resolveAccess(
  env: SummonFanoutEnv,
  logger: Logger,
  args: { orgId: string; userId: string; targetUrl: string },
): Promise<CrossAppAccessDecision> {
  return resolveCrossAppAccess(args, {
    internalServiceSecret: env.INTERNAL_SERVICE_SECRET,
    apiInternalUrl: env.BBB_API_INTERNAL_URL,
    boardInternalUrl: env.BOARD_INTERNAL_URL,
    briefInternalUrl: env.BRIEF_INTERNAL_URL,
    onDegraded: (info) =>
      logger.warn(
        { ...info, target_url: args.targetUrl },
        'bureau-summon-fanout: access preflight degraded; recipient denied (fail closed)',
      ),
  });
}

// ---------------------------------------------------------------------------
// Frame + key helpers (mirror §7/§8 of the design doc + WS hub envelope)
// ---------------------------------------------------------------------------

function frame(type: string, data: Record<string, unknown>): string {
  return JSON.stringify({
    type,
    data,
    timestamp: new Date().toISOString(),
  });
}

function userChannel(userId: string): string {
  return `user:${userId}`;
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

/**
 * Load the bureau_summons row + the summoner's display name in one round-trip.
 * Raw SQL because the worker package does not import bureau-api's Drizzle
 * schema (intentionally — see file header).
 */
async function loadSummon(summonId: string): Promise<SummonAuditRow | null> {
  const db = getDb();
  const rows = await db.execute<{
    id: string;
    org_id: string;
    summoner_id: string;
    summoner_name: string | null;
    from_room_id: string | null;
    target_url: string;
    target_app: string;
    target_label: string | null;
    livekit_room_hint: string | null;
    recipients: unknown;
  }>(sql`
    SELECT
      s.id,
      s.org_id,
      s.summoner_id,
      u.display_name AS summoner_name,
      s.from_room_id,
      s.target_url,
      s.target_app,
      s.target_label,
      s.livekit_room_hint,
      s.recipients
    FROM bureau_summons s
    LEFT JOIN users u ON u.id = s.summoner_id
    WHERE s.id = ${summonId}
    LIMIT 1
  `);
  const list = Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows;
  if (!list || list.length === 0) return null;
  const row = list[0] as {
    id: string;
    org_id: string;
    summoner_id: string;
    summoner_name: string | null;
    from_room_id: string | null;
    target_url: string;
    target_app: string;
    target_label: string | null;
    livekit_room_hint: string | null;
    recipients: unknown;
  };
  const recipients: SummonRecipientRow[] = Array.isArray(row.recipients)
    ? (row.recipients as SummonRecipientRow[])
    : [];
  return {
    id: row.id,
    org_id: row.org_id,
    summoner_id: row.summoner_id,
    summoner_name: row.summoner_name,
    from_room_id: row.from_room_id,
    target_url: row.target_url,
    target_app: row.target_app,
    target_label: row.target_label,
    livekit_room_hint: row.livekit_room_hint,
    recipients,
  };
}

/**
 * Whether the summoner's org has auto-follow enabled in bureau_settings.
 * Raw SQL for the same reason as loadSummon. Defaults to false on any
 * error so a misconfigured org never auto-yanks recipients.
 */
async function shouldAutoFollow(orgId: string): Promise<boolean> {
  try {
    const db = getDb();
    const rows = await db.execute<{ allow_auto_follow: boolean }>(sql`
      SELECT allow_auto_follow
      FROM bureau_settings
      WHERE org_id = ${orgId}
      LIMIT 1
    `);
    const list = Array.isArray(rows)
      ? rows
      : (rows as { rows?: { allow_auto_follow: boolean }[] }).rows;
    if (!list || list.length === 0) return false;
    return list[0]!.allow_auto_follow === true;
  } catch {
    return false;
  }
}

/** Write the updated recipients[] back to the audit row. */
async function updateRecipients(
  summonId: string,
  recipients: SummonRecipientRow[],
): Promise<void> {
  const db = getDb();
  await db.execute(sql`
    UPDATE bureau_summons
    SET recipients = ${JSON.stringify(recipients)}::jsonb
    WHERE id = ${summonId}
  `);
}

// ---------------------------------------------------------------------------
// Job processor
// ---------------------------------------------------------------------------

/**
 * Access checks run this many at a time. They used to run one after another
 * with a 4 s timeout each, so an unreachable peer made a 50-person summon
 * spend about 200 s denying everyone (#330).
 */
export const FANOUT_CHECK_CONCURRENCY = 8;
/** Wall-clock budget for one pass of access checks; whatever is unchecked retries. */
export const FANOUT_CHECK_BUDGET_MS = 20_000;

/**
 * Thrown when a pass could not get a real answer for some recipients (the
 * owning app was unreachable, timed out or answered non-2xx). BullMQ retries
 * the job with backoff; recipients already notified are remembered in
 * job.data.notifiedUserIds so a retry never pings them twice.
 */
export class SummonFanoutDegradedError extends Error {
  constructor(public readonly unavailable: number) {
    super(`bureau-summon-fanout: access check unavailable for ${unavailable} recipient(s); retrying`);
    this.name = 'SummonFanoutDegradedError';
  }
}

export interface SummonFanoutOptions {
  checkConcurrency?: number;
  checkBudgetMs?: number;
}

/**
 * A recipient the fan-out still owes an access check: `pending` (never
 * checked by the worker, or degraded on an earlier attempt), or `no_access`
 * whose reason is a DEGRADED deny recorded inline by planSummon during an
 * outage. A real deny is final; an unavailable check is not (#330).
 */
function owesCheck(r: SummonRecipientRow): boolean {
  return r.outcome === 'pending' || (r.outcome === 'no_access' && isDegradedReason(r.reason));
}

export async function processBureauSummonFanoutJob(
  job: Job<BureauSummonFanoutJobData>,
  redis: Redis,
  env: SummonFanoutEnv,
  logger: Logger,
  options: SummonFanoutOptions = {},
): Promise<void> {
  const { summonId, orgId, summonerId } = job.data;
  const startedAt = Date.now();
  const concurrency = Math.max(1, options.checkConcurrency ?? FANOUT_CHECK_CONCURRENCY);
  const budgetMs = options.checkBudgetMs ?? FANOUT_CHECK_BUDGET_MS;
  const maxAttempts = job.opts?.attempts ?? 1;
  const isLastAttempt = (job.attemptsMade ?? 0) + 1 >= maxAttempts;

  const summon = await loadSummon(summonId);
  if (!summon) {
    logger.warn({ summonId }, 'bureau-summon-fanout: summon row not found');
    return;
  }
  if (summon.org_id !== orgId || summon.summoner_id !== summonerId) {
    logger.warn(
      { summonId, orgId, summonerId, rowOrgId: summon.org_id, rowSummonerId: summon.summoner_id },
      'bureau-summon-fanout: payload/row mismatch (summon may have been mutated)',
    );
  }

  const autoFollow = await shouldAutoFollow(summon.org_id);

  // Recipients notified by an earlier attempt of this job stay `pending` on
  // the audit row (they have not answered yet), so the job remembers them.
  const notified = new Set(job.data.notifiedUserIds ?? []);
  const previouslyNotified = notified.size;
  const candidates = summon.recipients.filter((r) => owesCheck(r) && !notified.has(r.userId));
  const total = candidates.length + previouslyNotified;

  logger.info(
    { summonId, attempt: (job.attemptsMade ?? 0) + 1, maxAttempts, candidates: candidates.length, previouslyNotified },
    'bureau-summon-fanout: checking access',
  );

  const deadline = Date.now() + budgetMs;
  const unavailable: SummonRecipientRow[] = [];
  let stopChecking = false;
  let recipientsChanged = false;
  let newlyDenied = 0;
  let next = 0;

  const pushProgress = async () => {
    try {
      await redis.publish(
        userChannel(summon.summoner_id),
        frame('summon_progress', { summonId: summon.id, joined: notified.size, total }),
      );
    } catch {
      /* swallow */
    }
  };

  const setOutcome = (r: SummonRecipientRow, outcome: SummonRecipientOutcome, reason: string | null) => {
    if (r.outcome !== outcome || (r.reason ?? null) !== reason) {
      r.outcome = outcome;
      r.reason = reason;
      recipientsChanged = true;
    }
  };

  const lane = async () => {
    for (;;) {
      const idx = next++;
      if (idx >= candidates.length) return;
      const recipient = candidates[idx]!;
      // Once the owning app is known to be unavailable, or the pass is out of
      // time, stop spending timeouts: the rest are retried with backoff.
      if (stopChecking || Date.now() > deadline) {
        unavailable.push(recipient);
        continue;
      }
      // Re-run the access check; permissions may have changed since planSummon.
      const decision = await resolveAccess(env, logger, {
        orgId: summon.org_id,
        userId: recipient.userId,
        targetUrl: summon.target_url,
      });
      if (isDegradedDecision(decision)) {
        stopChecking = true;
        unavailable.push(recipient);
        // Not a verdict: the recipient stays owed a check.
        setOutcome(recipient, 'pending', decision.reason);
        continue;
      }
      if (!decision.allowed) {
        setOutcome(recipient, 'no_access', decision.reason ?? 'denied_by_worker');
        newlyDenied += 1;
        continue;
      }

      // Allowed. A recipient planSummon recorded as a degraded no_access is
      // now summoned like any other.
      setOutcome(recipient, 'pending', null);
      const payload = frame('summon_incoming', {
        summonId: summon.id,
        summoner: {
          id: summon.summoner_id,
          name: summon.summoner_name,
        },
        targetUrl: summon.target_url,
        app: summon.target_app,
        label: summon.target_label,
        lkRoomHint: summon.livekit_room_hint,
        autoFollow,
      });
      try {
        await redis.publish(userChannel(recipient.userId), payload);
      } catch (err) {
        logger.warn(
          { err, summonId, recipientId: recipient.userId },
          'bureau-summon-fanout: publish failed (swallowed)',
        );
      }
      notified.add(recipient.userId);

      // Progress nudge to the summoner every 5 recipients.
      if (notified.size % 5 === 0) await pushProgress();
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, () => lane()));

  // Remember who was notified BEFORE anything can throw, so a retry skips them.
  if (notified.size > previouslyNotified) {
    try {
      await job.updateData({ ...job.data, notifiedUserIds: [...notified] });
    } catch (err) {
      logger.warn({ err, summonId }, 'bureau-summon-fanout: failed to record notified recipients');
    }
  }

  if (unavailable.length > 0 && isLastAttempt) {
    // Out of retries: record the truth rather than leave the row pending forever.
    for (const r of unavailable) setOutcome(r, 'no_access', 'access_check_unavailable');
    logger.error(
      { summonId, unavailable: unavailable.length, attempts: maxAttempts },
      'bureau-summon-fanout: access check still unavailable after the last attempt; recipients not summoned',
    );
  }

  if (recipientsChanged) {
    // The entries in candidates are references into summon.recipients.
    await updateRecipients(summonId, summon.recipients).catch((err) => {
      logger.warn({ err, summonId }, 'bureau-summon-fanout: failed to persist recipient outcomes');
    });
  }

  await pushProgress();

  if (unavailable.length > 0 && !isLastAttempt) {
    logger.warn(
      {
        summonId,
        unavailable: unavailable.length,
        notified: notified.size,
        attempt: (job.attemptsMade ?? 0) + 1,
        maxAttempts,
        durationMs: Date.now() - startedAt,
      },
      'bureau-summon-fanout: access check unavailable; job will retry',
    );
    throw new SummonFanoutDegradedError(unavailable.length);
  }

  // §14 Bolt event: emitted exactly once, when the fan-out is complete (a
  // degraded pass throws above and does not emit). The inline bureau-api
  // path emits its own copy; we never double-fire because bureau-api only
  // enqueues this job when it has NOT done the inline push.
  await publishBoltEvent(
    'summon.issued',
    'bureau',
    {
      summon: { id: summon.id },
      summoner: { id: summon.summoner_id },
      from_room_id: summon.from_room_id,
      target_url: summon.target_url,
      target_app: summon.target_app,
      target_label: summon.target_label,
      livekit_room_hint: summon.livekit_room_hint,
      recipient_count: total,
      actor: { id: summon.summoner_id },
      org: { id: summon.org_id },
    },
    summon.org_id,
    summon.summoner_id,
    'user',
  ).catch((err) => {
    logger.warn({ err, summonId }, 'bureau-summon-fanout: bolt emit failed (swallowed)');
  });

  logger.info(
    {
      jobId: job.id,
      summonId,
      candidates: candidates.length,
      pushed: notified.size - previouslyNotified,
      newlyDenied,
      durationMs: Date.now() - startedAt,
    },
    'bureau-summon-fanout: tick complete',
  );
}

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
 * NOTE on `lkRoomHint` (v2 unified-call model — Phase 3).
 *   We still ship `lkRoomHint` in the summon_incoming frame for audit
 *   parity with the audit row, but the recipient's bureau-client SDK no
 *   longer threads it into the destination URL — the SDK joins whichever
 *   LiveKit room the unified call manager resolves on URL change. The
 *   `?lkRoom=` query param is dead end-to-end.
 *
 * ──────────────────────────────────────────────────────────────────────
 * DUPLICATED CODE WARNING.
 *
 * The cross-app access check below is a lift of
 * apps/bureau-api/src/services/cross-app-access.service.ts. We cannot
 * import that file because the worker package does not depend on
 * bureau-api (and shouldn't — see bureau-presence-cleanup.ts for the
 * same pattern). If the canonical version changes, mirror the change
 * here in the same commit.
 * ──────────────────────────────────────────────────────────────────────
 */

import type { Job } from 'bullmq';
import type Redis from 'ioredis';
import type { Logger } from 'pino';
import { sql } from 'drizzle-orm';
import { getDb } from '../utils/db.js';
import { publishBoltEvent } from '../utils/bolt-events.js';

// ---------------------------------------------------------------------------
// Job payload (mirrors bureau-api summon.service.ts queue.add(...) payload)
// ---------------------------------------------------------------------------

export interface BureauSummonFanoutJobData {
  summonId: string;
  orgId: string;
  summonerId: string;
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
// Cross-app access check — duplicated from bureau-api/services/cross-app-access.
// ---------------------------------------------------------------------------

interface CrossAppAccessDecision {
  allowed: boolean;
  canShare: boolean;
  reason?: string;
}

const INTERNAL_SECRET = process.env.INTERNAL_SERVICE_SECRET ?? '';
const BBB_API_INTERNAL_URL = process.env.BBB_API_INTERNAL_URL ?? 'http://api:4000';
const BOARD_INTERNAL_URL = process.env.BOARD_INTERNAL_URL ?? 'http://board-api:4008';
const BRIEF_INTERNAL_URL = process.env.BRIEF_INTERNAL_URL ?? 'http://brief-api:4005';

async function tryLivePreflight(
  baseUrl: string,
  path: string,
  args: { orgId: string; userId: string; targetUrl: string },
): Promise<CrossAppAccessDecision | null> {
  if (!INTERNAL_SECRET || !baseUrl) return null;
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Service-Secret': INTERNAL_SECRET,
        'X-Organization-ID': args.orgId,
      },
      body: JSON.stringify({
        user_id: args.userId,
        org_id: args.orgId,
        target_url: args.targetUrl,
      }),
    });
    if (!response.ok) return null;
    const raw = (await response.json()) as {
      allowed?: unknown;
      canShare?: unknown;
      can_share?: unknown;
      reason?: unknown;
    };
    return {
      allowed: raw.allowed === true,
      canShare: raw.canShare === true || raw.can_share === true,
      reason: typeof raw.reason === 'string' ? raw.reason : undefined,
    };
  } catch {
    return null;
  }
}

async function resolveAccess(
  app: string,
  args: { orgId: string; userId: string; targetUrl: string },
): Promise<CrossAppAccessDecision> {
  switch (app) {
    case 'board': {
      const live = await tryLivePreflight(
        BOARD_INTERNAL_URL,
        '/v1/internal/can-read',
        args,
      );
      if (live) return live;
      return { allowed: true, canShare: false, reason: 'stub_allow' };
    }
    case 'brief': {
      const live = await tryLivePreflight(
        BRIEF_INTERNAL_URL,
        '/v1/internal/can-read',
        args,
      );
      if (live) return live;
      return { allowed: true, canShare: false, reason: 'stub_allow' };
    }
    case 'bam': {
      const live = await tryLivePreflight(
        BBB_API_INTERNAL_URL,
        '/internal/can-read',
        args,
      );
      if (live) return live;
      return { allowed: true, canShare: false, reason: 'stub_allow' };
    }
    default:
      return { allowed: true, canShare: false, reason: 'unknown_app' };
  }
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

export async function processBureauSummonFanoutJob(
  job: Job<BureauSummonFanoutJobData>,
  redis: Redis,
  logger: Logger,
): Promise<void> {
  const { summonId, orgId, summonerId } = job.data;
  const startedAt = Date.now();

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

  // Only the recipients still marked as `pending` are candidates. Anything
  // already in a terminal state (joined/declined/no_access/granted/timed_out)
  // has already been processed and should not be re-pushed.
  const pendingRecipients = summon.recipients.filter(
    (r) => r.outcome === 'pending',
  );

  let pushed = 0;
  let newlyDenied = 0;

  for (let i = 0; i < pendingRecipients.length; i++) {
    const recipient = pendingRecipients[i]!;
    // Re-run the access check; permissions may have changed since planSummon.
    const decision = await resolveAccess(summon.target_app, {
      orgId: summon.org_id,
      userId: recipient.userId,
      targetUrl: summon.target_url,
    });
    if (!decision.allowed) {
      recipient.outcome = 'no_access';
      recipient.reason = decision.reason ?? 'denied_by_worker';
      newlyDenied += 1;
      continue;
    }

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
      pushed += 1;
    } catch (err) {
      logger.warn(
        { err, summonId, recipientId: recipient.userId },
        'bureau-summon-fanout: publish failed (swallowed)',
      );
    }

    // Progress nudge to the summoner every 5 recipients.
    if ((i + 1) % 5 === 0) {
      const progressPayload = frame('summon_progress', {
        summonId: summon.id,
        joined: pushed,
        total: pendingRecipients.length,
      });
      try {
        await redis.publish(userChannel(summon.summoner_id), progressPayload);
      } catch {
        /* swallow */
      }
    }
  }

  // Final progress push so the dialog can transition to "delivery complete".
  try {
    await redis.publish(
      userChannel(summon.summoner_id),
      frame('summon_progress', {
        summonId: summon.id,
        joined: pushed,
        total: pendingRecipients.length,
      }),
    );
  } catch {
    /* swallow */
  }

  // Persist any newly-flipped no_access transitions on the audit row.
  if (newlyDenied > 0) {
    // Rebuild the full recipient list (we mutated entries in pendingRecipients,
    // but they're references into the audit row's recipients[] array).
    await updateRecipients(summonId, summon.recipients).catch((err) => {
      logger.warn(
        { err, summonId },
        'bureau-summon-fanout: failed to persist newly-denied transitions',
      );
    });
  }

  // §14 Bolt event: emitted exactly once from the offload path. The inline
  // bureau-api path emits its own copy; we never double-fire because
  // bureau-api only enqueues this job when it has NOT done the inline push.
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
      recipient_count: pendingRecipients.length,
      actor: { id: summon.summoner_id },
      org: { id: summon.org_id },
    },
    summon.org_id,
    summon.summoner_id,
    'user',
  ).catch((err) => {
    logger.warn({ err, summonId }, 'bureau-summon-fanout: bolt emit failed (swallowed)');
  });

  const durationMs = Date.now() - startedAt;
  logger.info(
    {
      jobId: job.id,
      summonId,
      candidates: pendingRecipients.length,
      pushed,
      newlyDenied,
      durationMs,
    },
    'bureau-summon-fanout: tick complete',
  );
}

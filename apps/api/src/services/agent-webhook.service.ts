import { randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import type { Redis } from 'ioredis';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { agentRunners } from '../db/schema/agent-runners.js';
import { agentWebhookDeliveries } from '../db/schema/agent-webhook-deliveries.js';
import { agentPolicies } from '../db/schema/agent-policies.js';
import { checkUrl, type EgressCheckOptions, type UrlCheckResult } from '@bigbluebam/egress-guard';

/**
 * Registration-time check for an agent webhook URL. Uses the same
 * @bigbluebam/egress-guard rules the worker's safeFetch applies at dispatch,
 * so registration and dispatch can no longer disagree about a URL (#328).
 * The only extra rule is policy, not a range table: https is required in
 * production. Stack-internal receivers (test harnesses) are allowed through
 * EGRESS_ALLOW_PRIVATE_HOSTS, exactly as dispatch allows them.
 */
export async function checkWebhookUrl(
  rawUrl: string,
  nodeEnv: string = process.env.NODE_ENV ?? 'development',
  opts: EgressCheckOptions = {},
): Promise<UrlCheckResult> {
  if (nodeEnv === 'production') {
    try {
      if (new URL(rawUrl).protocol !== 'https:') {
        return { safe: false, reason: 'https:// is required in production' };
      }
    } catch {
      return { safe: false, reason: 'Invalid URL' };
    }
  }
  return checkUrl(rawUrl, opts);
}

// The dispatcher worker signs outbound deliveries with the runner's
// plaintext secret. We stash it in Redis at configure/rotate time so the
// worker has something to sign with (the DB only stores the argon2
// hash). The key has no TTL; deletes happen on reconfigure / rotate /
// disable.
const SECRET_REDIS_KEY_PREFIX = 'agent_webhook_secret:';

/**
 * Agent webhook service (AGENTIC_TODO §20, Wave 5).
 *
 * Drives the configure / rotate / list / redeliver flows that back the
 * `agent_webhook_*` MCP tools and REST routes. The actual outbound POST
 * lives in the worker (apps/worker/src/jobs/agent-webhook-dispatch.job.ts);
 * this service is the control plane only.
 *
 * Secret lifecycle:
 *   - Plaintext secret is returned exactly once at configure or rotate
 *     time. Server stores an argon2id hash.
 *   - Rotation never re-reveals the predecessor — callers that lose a
 *     secret must rotate. There is no "copy of current secret" endpoint.
 */

export interface ConfigureInput {
  webhook_url: string;
  event_filter: string[];
  enabled?: boolean;
}

export type ConfigureResult =
  | { ok: true; runner_id: string; webhook_url: string; event_filter: string[]; enabled: boolean; plaintext_secret: string }
  | { ok: false; code: 'NOT_AN_AGENT' | 'UNSAFE_URL' | 'CROSS_ORG' | 'RUNNER_NOT_FOUND'; reason?: string };

export type RotateResult =
  | { ok: true; runner_id: string; plaintext_secret: string }
  | { ok: false; code: 'RUNNER_NOT_FOUND' | 'CROSS_ORG' | 'WEBHOOK_NOT_CONFIGURED' };

export interface DeliveryListRow {
  id: string;
  runner_id: string;
  event_id: string;
  event_source: string;
  event_type: string;
  status: string;
  attempt_count: number;
  response_status_code: number | null;
  last_error: string | null;
  created_at: string;
  delivered_at: string | null;
  next_retry_at: string | null;
}

function generatePlaintextSecret(): string {
  // 32 bytes of entropy, base64url. Prefixed so callers can recognize it.
  return `bbbhk_${randomBytes(32).toString('base64url')}`;
}

/**
 * Configure (or reconfigure) a runner's webhook. Validates the URL against
 * the SSRF guard, hashes a freshly-generated secret, and writes the
 * columns in a single UPDATE. Returns the plaintext secret exactly once.
 *
 * `event_filter` is a list of `source:event_type` strings (e.g.
 * `['bond:deal.rotting', 'bam:task.moved']`). The dispatcher hook matches
 * events against these entries; an empty list means "no subscriptions"
 * (the row stays off).
 */
export async function configureWebhook(
  runnerUserId: string,
  actor: { org_id: string },
  input: ConfigureInput,
  redis: Redis | null,
): Promise<ConfigureResult> {
  const urlCheck = await checkWebhookUrl(input.webhook_url);
  if (!urlCheck.safe) {
    return { ok: false, code: 'UNSAFE_URL', reason: urlCheck.reason };
  }

  const [runner] = await db
    .select()
    .from(agentRunners)
    .where(eq(agentRunners.user_id, runnerUserId))
    .limit(1);

  if (!runner) {
    return { ok: false, code: 'RUNNER_NOT_FOUND' };
  }
  if (runner.org_id !== actor.org_id) {
    return { ok: false, code: 'CROSS_ORG' };
  }

  const plaintext = generatePlaintextSecret();
  const hash = await argon2.hash(plaintext);

  await db
    .update(agentRunners)
    .set({
      webhook_url: input.webhook_url,
      webhook_secret_hash: hash,
      webhook_event_filter: input.event_filter,
      webhook_enabled: input.enabled ?? true,
      // Reset failure counters so a reconfigure lifts any circuit-breaker
      // auto-disable from the previous configuration.
      webhook_consecutive_failures: 0,
      updated_at: new Date(),
    })
    .where(eq(agentRunners.id, runner.id));

  // Stash the plaintext in Redis so the worker dispatcher can sign. No
  // TTL; the overwrite on the next rotate is the only way to retire it.
  if (redis) {
    try {
      await redis.set(`${SECRET_REDIS_KEY_PREFIX}${runner.id}`, plaintext);
    } catch {
      // Caller already committed the hash to the DB; a Redis outage
      // means the dispatcher will fail-closed with "secret missing",
      // which is operator-visible and recoverable via rotate.
    }
  }

  return {
    ok: true,
    runner_id: runner.id,
    webhook_url: input.webhook_url,
    event_filter: input.event_filter,
    enabled: input.enabled ?? true,
    plaintext_secret: plaintext,
  };
}

/**
 * Rotate the per-runner HMAC secret. The old secret is invalidated
 * immediately; there is no grace window (§20 is simpler than the
 * bbam_ API-key rotation flow). Callers that need zero-downtime rollover
 * should rotate during a maintenance window.
 */
export async function rotateWebhookSecret(
  runnerUserId: string,
  actor: { org_id: string },
  redis: Redis | null,
): Promise<RotateResult> {
  const [runner] = await db
    .select()
    .from(agentRunners)
    .where(eq(agentRunners.user_id, runnerUserId))
    .limit(1);

  if (!runner) {
    return { ok: false, code: 'RUNNER_NOT_FOUND' };
  }
  if (runner.org_id !== actor.org_id) {
    return { ok: false, code: 'CROSS_ORG' };
  }
  if (!runner.webhook_url) {
    return { ok: false, code: 'WEBHOOK_NOT_CONFIGURED' };
  }

  const plaintext = generatePlaintextSecret();
  const hash = await argon2.hash(plaintext);

  await db
    .update(agentRunners)
    .set({
      webhook_secret_hash: hash,
      updated_at: new Date(),
    })
    .where(eq(agentRunners.id, runner.id));

  // Overwrite the Redis plaintext atomically from the caller's POV. The
  // predecessor is immediately invalidated; receivers that were mid-retry
  // will see signature mismatches until they swap in the new secret.
  if (redis) {
    try {
      await redis.set(`${SECRET_REDIS_KEY_PREFIX}${runner.id}`, plaintext);
    } catch {
      // See configureWebhook for the failure posture.
    }
  }

  return { ok: true, runner_id: runner.id, plaintext_secret: plaintext };
}

/**
 * List recent webhook deliveries. Filters optionally by runner_id and
 * status. Paginates by `created_at DESC`; callers can pass `before` (an
 * ISO timestamp) to fetch the next page. Capped at `limit` rows per call
 * (default 50, max 200).
 */
export async function listDeliveries(
  actor: { org_id: string },
  opts: {
    runner_id?: string;
    status?: 'pending' | 'delivered' | 'failed' | 'dead_lettered';
    before?: string;
    limit?: number;
  } = {},
): Promise<DeliveryListRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const conditions = [eq(agentWebhookDeliveries.org_id, actor.org_id)];
  if (opts.runner_id) {
    conditions.push(eq(agentWebhookDeliveries.runner_id, opts.runner_id));
  }
  if (opts.status) {
    conditions.push(eq(agentWebhookDeliveries.status, opts.status));
  }
  if (opts.before) {
    conditions.push(sql`${agentWebhookDeliveries.created_at} < ${new Date(opts.before).toISOString()}::timestamptz`);
  }

  const rows = await db
    .select()
    .from(agentWebhookDeliveries)
    .where(and(...conditions))
    .orderBy(desc(agentWebhookDeliveries.created_at))
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    runner_id: r.runner_id,
    event_id: r.event_id,
    event_source: r.event_source,
    event_type: r.event_type,
    status: r.status,
    attempt_count: r.attempt_count,
    response_status_code: r.response_status_code ?? null,
    last_error: r.last_error ?? null,
    created_at: r.created_at.toISOString(),
    delivered_at: r.delivered_at ? r.delivered_at.toISOString() : null,
    next_retry_at: r.next_retry_at ? r.next_retry_at.toISOString() : null,
  }));
}

export type RedeliverResult =
  | { ok: true; id: string; status: 'pending'; enqueued_job_id: string }
  | { ok: false; code: 'DELIVERY_NOT_FOUND' | 'CROSS_ORG' | 'RUNNER_WEBHOOK_DISABLED' };

/**
 * Redeliver a specific delivery row. Resets attempt_count to 0 and
 * status to `pending`, then enqueues a fresh dispatch job. The caller
 * must supply an enqueue function (the worker queue is not imported
 * here, to avoid a circular dependency between api and worker).
 */
export async function redeliver(
  deliveryId: string,
  actor: { org_id: string },
  enqueue: (deliveryId: string) => Promise<string>,
): Promise<RedeliverResult> {
  const [row] = await db
    .select({
      delivery: agentWebhookDeliveries,
      runner_enabled: agentRunners.webhook_enabled,
      runner_org: agentRunners.org_id,
    })
    .from(agentWebhookDeliveries)
    .leftJoin(agentRunners, eq(agentRunners.id, agentWebhookDeliveries.runner_id))
    .where(eq(agentWebhookDeliveries.id, deliveryId))
    .limit(1);

  if (!row) {
    return { ok: false, code: 'DELIVERY_NOT_FOUND' };
  }
  if (row.delivery.org_id !== actor.org_id) {
    return { ok: false, code: 'CROSS_ORG' };
  }
  if (!row.runner_enabled) {
    return { ok: false, code: 'RUNNER_WEBHOOK_DISABLED' };
  }

  await db
    .update(agentWebhookDeliveries)
    .set({
      status: 'pending',
      attempt_count: 0,
      last_error: null,
      response_status_code: null,
      next_retry_at: new Date(),
    })
    .where(eq(agentWebhookDeliveries.id, deliveryId));

  const jobId = await enqueue(deliveryId);

  return { ok: true, id: deliveryId, status: 'pending', enqueued_job_id: jobId };
}

// ---------------------------------------------------------------------------
// Dispatcher helpers — consumed by the bolt-api webhook-dispatch hook and
// by the worker. These operate directly on the DB and do not require the
// actor scope the configure/rotate/list paths enforce.
// ---------------------------------------------------------------------------

export interface MatchedRunner {
  runner_id: string;
  user_id: string;
  org_id: string;
  webhook_url: string;
  webhook_enabled: boolean;
  agent_policy_enabled: boolean;
}

/**
 * Find every webhook-enabled runner in an org whose event_filter matches
 * the given event, joined with the §15 agent_policies.enabled gate.
 * Runners with an agent policy row set to `enabled = false` are filtered
 * out, matching the requirement that delivery is gated by the kill
 * switch. Runners with NO policy row are kept (fail-open here is safe
 * because configure/rotate already checked cross-org identity).
 *
 * Event matching: an entry of `*` in event_filter matches everything,
 * `bond:*` matches any bond event, `bond:deal.rotting` is exact.
 */
export async function findSubscribedRunners(
  orgId: string,
  source: string,
  eventType: string,
): Promise<MatchedRunner[]> {
  const rows = await db
    .select({
      runner_id: agentRunners.id,
      user_id: agentRunners.user_id,
      org_id: agentRunners.org_id,
      webhook_url: agentRunners.webhook_url,
      webhook_enabled: agentRunners.webhook_enabled,
      webhook_event_filter: agentRunners.webhook_event_filter,
      agent_policy_enabled: agentPolicies.enabled,
    })
    .from(agentRunners)
    .leftJoin(agentPolicies, eq(agentPolicies.agent_user_id, agentRunners.user_id))
    .where(
      and(
        eq(agentRunners.org_id, orgId),
        eq(agentRunners.webhook_enabled, true),
      ),
    );

  const matches: MatchedRunner[] = [];
  for (const r of rows) {
    if (r.webhook_url == null || r.webhook_url === '') continue;
    // Policy gate: if a row exists and is disabled, skip. Null means "no
    // row", which we treat as permissive here (agent simply never had a
    // policy written yet; the dispatcher is not the place to enforce
    // fail-closed the way the MCP gate is).
    if (r.agent_policy_enabled === false) continue;

    const filter = r.webhook_event_filter as unknown;
    if (!Array.isArray(filter)) continue;
    if (!eventMatchesFilter(filter as string[], source, eventType)) continue;

    matches.push({
      runner_id: r.runner_id,
      user_id: r.user_id,
      org_id: r.org_id,
      webhook_url: r.webhook_url,
      webhook_enabled: r.webhook_enabled,
      agent_policy_enabled: r.agent_policy_enabled ?? true,
    });
  }
  return matches;
}

/**
 * Canonical "does this event match this filter list?" check. Exported
 * for unit tests and for the bolt-api hook which re-uses the same
 * semantics.
 *
 *   '*'                 → every event
 *   'bond:*'            → any event where source = 'bond'
 *   'bond:deal.rotting' → exact match on source + event_type
 */
export function eventMatchesFilter(
  filter: string[],
  source: string,
  eventType: string,
): boolean {
  if (filter.length === 0) return false;
  for (const entry of filter) {
    if (entry === '*') return true;
    const colon = entry.indexOf(':');
    if (colon < 0) continue;
    const entrySource = entry.slice(0, colon);
    const entryEvent = entry.slice(colon + 1);
    if (entrySource !== source) continue;
    if (entryEvent === '*') return true;
    if (entryEvent === eventType) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

export const __test__ = {
  generatePlaintextSecret,
};

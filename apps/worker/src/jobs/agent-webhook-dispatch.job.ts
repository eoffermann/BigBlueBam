/**
 * Agent webhook dispatch job (AGENTIC_TODO §20, Wave 5).
 *
 * Signs and POSTs a single delivery row to the runner's configured
 * webhook URL. Enqueued by:
 *   1. The bolt-api dispatch hook when an event fans out to subscribed
 *      runners (initial attempts).
 *   2. The api redeliver route when an operator re-kicks a failed /
 *      dead-lettered row.
 *   3. This job itself, via a delayed re-enqueue on failure.
 *
 * Flow per invocation:
 *   - Load the delivery row + runner row (URL + secret hash context).
 *     Hash is NOT the signing key. The signing key is the plaintext
 *     secret, which this worker does not and cannot retrieve. Plaintext
 *     secrets are stashed in Redis at configure/rotate time with the
 *     key `agent_webhook_secret:<runner_id>`.
 *   - Truncate the payload if it exceeds PAYLOAD_CAP_BYTES.
 *   - Sign the stringified body with the runner's secret.
 *   - POST with a 10s timeout.
 *   - On 2xx: mark delivered, reset consecutive_failures, bump
 *             webhook_last_success_at.
 *   - On non-2xx or network error: increment attempt_count, compute
 *             next_retry_at per the backoff schedule, delay-requeue.
 *             At DLQ_AT_ATTEMPT, flip status to `dead_lettered`.
 *   - At CIRCUIT_BREAKER_THRESHOLD consecutive failures on the runner,
 *             auto-disable the hook and publish `agent.webhook.disabled`
 *             to Bolt so operators see it on the unified event feed.
 */

import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import type Redis from 'ioredis';
import { createHmac } from 'node:crypto';
import { safeFetch } from '@bigbluebam/egress-guard';
import { eq, sql } from 'drizzle-orm';
import { pgTable, uuid, text, jsonb, integer, timestamp, boolean } from 'drizzle-orm/pg-core';
import { getDb } from '../utils/db.js';
import { publishBoltEvent } from '../utils/bolt-events.js';

// ---------------------------------------------------------------------------
// Local schema stubs (keeps the worker decoupled from apps/api imports).
// Wave 1.A convention is to declare the minimal Drizzle shape needed
// inside the worker. Columns must match the agent_runners /
// agent_webhook_deliveries tables.
// ---------------------------------------------------------------------------

const agentRunners = pgTable('agent_runners', {
  id: uuid('id').primaryKey(),
  org_id: uuid('org_id').notNull(),
  user_id: uuid('user_id').notNull(),
  webhook_url: text('webhook_url'),
  webhook_enabled: boolean('webhook_enabled').notNull(),
  webhook_consecutive_failures: integer('webhook_consecutive_failures').notNull(),
  webhook_last_success_at: timestamp('webhook_last_success_at', { withTimezone: true }),
  webhook_last_failure_at: timestamp('webhook_last_failure_at', { withTimezone: true }),
});

const agentWebhookDeliveries = pgTable('agent_webhook_deliveries', {
  id: uuid('id').primaryKey(),
  org_id: uuid('org_id').notNull(),
  runner_id: uuid('runner_id').notNull(),
  event_id: uuid('event_id').notNull(),
  event_source: text('event_source').notNull(),
  event_type: text('event_type').notNull(),
  payload: jsonb('payload').notNull(),
  status: text('status').notNull(),
  attempt_count: integer('attempt_count').notNull(),
  last_attempt_at: timestamp('last_attempt_at', { withTimezone: true }),
  last_error: text('last_error'),
  response_status_code: integer('response_status_code'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull(),
  delivered_at: timestamp('delivered_at', { withTimezone: true }),
  next_retry_at: timestamp('next_retry_at', { withTimezone: true }),
});

// ---------------------------------------------------------------------------
// Backoff schedule (kept in sync with apps/api/src/lib/webhook-signature.ts)
// ---------------------------------------------------------------------------

const BACKOFF_SCHEDULE_SECONDS: readonly number[] = [
  0,        // attempt 1 initial try — fire now
  30,
  120,
  600,
  1800,
  7200,
  21600,
] as const;

const DLQ_AT_ATTEMPT = 8;
const CIRCUIT_BREAKER_THRESHOLD = 20;
const PAYLOAD_CAP_BYTES = 256 * 1024;
const HTTP_TIMEOUT_MS = 10_000;

export interface AgentWebhookDispatchJobData {
  delivery_id: string;
}

// ---------------------------------------------------------------------------
// Signing helpers (duplicated locally to avoid cross-app imports)
// ---------------------------------------------------------------------------

interface SignedPayload {
  timestamp: string;
  signature: string;
  body: string;
}

function signBody(secret: string, body: string): SignedPayload {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const hmac = createHmac('sha256', secret);
  hmac.update(`${timestamp}.${body}`);
  return {
    timestamp,
    signature: `sha256=${hmac.digest('hex')}`,
    body,
  };
}

function nextRetryDelaySeconds(attemptCount: number): number | null {
  if (attemptCount < 1) return 0;
  if (attemptCount >= DLQ_AT_ATTEMPT) return null;
  return BACKOFF_SCHEDULE_SECONDS[attemptCount] ?? null;
}

function maybeTruncatePayload(
  full: Record<string, unknown>,
  meta: { event_id: string; source: string; event_type: string },
): { body: Record<string, unknown>; truncated: boolean } {
  const serialized = JSON.stringify(full);
  if (Buffer.byteLength(serialized, 'utf8') <= PAYLOAD_CAP_BYTES) {
    return { body: full, truncated: false };
  }
  return {
    body: {
      event_id: meta.event_id,
      source: meta.source,
      event_type: meta.event_type,
      truncated: true,
      deep_link: null,
    },
    truncated: true,
  };
}

// ---------------------------------------------------------------------------
// Secret retrieval
// ---------------------------------------------------------------------------
//
// Plaintext secrets are never persisted to the DB (we store an argon2
// hash only). The configure / rotate endpoints stash the plaintext in
// Redis under `agent_webhook_secret:<runner_id>` with no expiry; deletes
// happen on rotate (predecessor overwrite) and on runner disable. If the
// Redis entry is missing the dispatcher fails-closed and marks the
// delivery failed with a diagnostic error; operators must rotate the
// secret so the worker has something to sign with again.

const SECRET_REDIS_KEY_PREFIX = 'agent_webhook_secret:';

async function loadSigningSecret(redis: Redis, runnerId: string): Promise<string | null> {
  try {
    return await redis.get(`${SECRET_REDIS_KEY_PREFIX}${runnerId}`);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Processor
// ---------------------------------------------------------------------------

export async function processAgentWebhookDispatchJob(
  job: Job<AgentWebhookDispatchJobData>,
  redis: Redis,
  logger: Logger,
  opts: { fetchImpl?: typeof fetch; nowMs?: () => number } = {},
): Promise<void> {
  const now = opts.nowMs ? new Date(opts.nowMs()) : new Date();
  const db = getDb();
  const deliveryId = job.data.delivery_id;

  // 1. Load the delivery + runner row in a single join.
  const rows = await db
    .select({
      delivery: agentWebhookDeliveries,
      runner: agentRunners,
    })
    .from(agentWebhookDeliveries)
    .leftJoin(agentRunners, eq(agentRunners.id, agentWebhookDeliveries.runner_id))
    .where(eq(agentWebhookDeliveries.id, deliveryId))
    .limit(1);

  const row = rows[0];
  if (!row || !row.runner) {
    logger.warn({ deliveryId }, 'agent-webhook-dispatch: delivery or runner missing; nothing to do');
    return;
  }

  // 2. Short-circuits: already delivered, dead-lettered, or runner disabled.
  if (row.delivery.status === 'delivered' || row.delivery.status === 'dead_lettered') {
    logger.debug(
      { deliveryId, status: row.delivery.status },
      'agent-webhook-dispatch: delivery already in terminal state; skipping',
    );
    return;
  }
  if (!row.runner.webhook_enabled || !row.runner.webhook_url) {
    await db
      .update(agentWebhookDeliveries)
      .set({
        status: 'failed',
        last_error: 'Runner webhook disabled or URL cleared',
        last_attempt_at: now,
      })
      .where(eq(agentWebhookDeliveries.id, deliveryId));
    return;
  }

  const secret = await loadSigningSecret(redis, row.runner.id);
  if (!secret) {
    logger.error(
      { deliveryId, runnerId: row.runner.id },
      'agent-webhook-dispatch: signing secret missing from Redis; operator must rotate',
    );
    await db
      .update(agentWebhookDeliveries)
      .set({
        status: 'failed',
        last_error: 'Signing secret missing; rotate the runner webhook secret',
        last_attempt_at: now,
      })
      .where(eq(agentWebhookDeliveries.id, deliveryId));
    return;
  }

  // 3. Build the signed body.
  const { body: bodyObj, truncated } = maybeTruncatePayload(
    {
      event_id: row.delivery.event_id,
      source: row.delivery.event_source,
      event_type: row.delivery.event_type,
      payload: row.delivery.payload,
    },
    {
      event_id: row.delivery.event_id,
      source: row.delivery.event_source,
      event_type: row.delivery.event_type,
    },
  );
  const bodyStr = JSON.stringify(bodyObj);
  const signed = signBody(secret, bodyStr);

  // 4. POST with a hard timeout.
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  const attemptNumber = row.delivery.attempt_count + 1;

  let statusCode: number | null = null;
  let responseText: string | null = null;
  let networkError: string | null = null;
  try {
    // Guarded here, at dispatch, on every attempt. The api's configure-time
    // validator checks literal IPs only (it never resolves DNS), and this job
    // re-sends a stored URL on every retry and redelivery, days later, so a
    // configure-time check could not hold even if it resolved names: DNS can
    // be repointed in between. safeFetch resolves and pins per attempt and
    // revalidates each redirect hop.
    const res = await safeFetch(
      row.runner.webhook_url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-BigBlueBam-Signature': signed.signature,
          'X-BigBlueBam-Timestamp': signed.timestamp,
          'X-BigBlueBam-Delivery': row.delivery.id,
          'X-BigBlueBam-Event': `${row.delivery.event_source}.${row.delivery.event_type}`,
        },
        body: bodyStr,
        signal: controller.signal,
      },
      {
        fetchImpl: opts.fetchImpl,
        // The signature authenticates us to the configured receiver only.
        stripHeadersOnCrossOrigin: ['X-BigBlueBam-Signature'],
      },
    );
    statusCode = res.status;
    if (!res.ok) {
      try {
        responseText = (await res.text()).slice(0, 1000);
      } catch {
        responseText = null;
      }
    }
  } catch (err) {
    networkError =
      err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 1000) : 'network error';
  } finally {
    clearTimeout(timeoutHandle);
  }

  const success = statusCode !== null && statusCode >= 200 && statusCode < 300;

  if (success) {
    await db
      .update(agentWebhookDeliveries)
      .set({
        status: 'delivered',
        attempt_count: attemptNumber,
        last_attempt_at: now,
        delivered_at: now,
        response_status_code: statusCode,
        last_error: null,
        next_retry_at: null,
      })
      .where(eq(agentWebhookDeliveries.id, deliveryId));

    await db
      .update(agentRunners)
      .set({
        webhook_consecutive_failures: 0,
        webhook_last_success_at: now,
      })
      .where(eq(agentRunners.id, row.runner.id));

    logger.info(
      {
        deliveryId,
        runnerId: row.runner.id,
        statusCode,
        attempt: attemptNumber,
        truncated,
      },
      'agent-webhook-dispatch: delivered',
    );
    return;
  }

  // Failure path
  const errMessage = networkError ?? `HTTP ${statusCode}: ${responseText ?? ''}`;
  const retryDelay = nextRetryDelaySeconds(attemptNumber);
  const willDeadLetter = retryDelay === null;

  const nextRetryAt = willDeadLetter ? null : new Date(now.getTime() + retryDelay * 1000);

  await db
    .update(agentWebhookDeliveries)
    .set({
      status: willDeadLetter ? 'dead_lettered' : 'pending',
      attempt_count: attemptNumber,
      last_attempt_at: now,
      response_status_code: statusCode,
      last_error: errMessage.slice(0, 4000),
      next_retry_at: nextRetryAt,
    })
    .where(eq(agentWebhookDeliveries.id, deliveryId));

  // Bump runner failure counter.
  const [updatedRunner] = await db
    .update(agentRunners)
    .set({
      webhook_consecutive_failures: sql`${agentRunners.webhook_consecutive_failures} + 1`,
      webhook_last_failure_at: now,
    })
    .where(eq(agentRunners.id, row.runner.id))
    .returning({
      id: agentRunners.id,
      org_id: agentRunners.org_id,
      consecutive_failures: agentRunners.webhook_consecutive_failures,
    });

  // Circuit breaker: auto-disable at CIRCUIT_BREAKER_THRESHOLD and emit
  // an `agent.webhook.disabled` event so operators see it in Bolt.
  if (
    updatedRunner &&
    updatedRunner.consecutive_failures >= CIRCUIT_BREAKER_THRESHOLD
  ) {
    await db
      .update(agentRunners)
      .set({ webhook_enabled: false })
      .where(eq(agentRunners.id, updatedRunner.id));

    await publishBoltEvent(
      'agent.webhook.disabled',
      'platform',
      {
        runner_id: updatedRunner.id,
        consecutive_failures: updatedRunner.consecutive_failures,
        reason: 'circuit_breaker',
        last_error: errMessage.slice(0, 1000),
      },
      updatedRunner.org_id,
    );

    logger.warn(
      {
        runnerId: updatedRunner.id,
        consecutive_failures: updatedRunner.consecutive_failures,
      },
      'agent-webhook-dispatch: circuit breaker tripped, runner auto-disabled',
    );
  }

  if (willDeadLetter) {
    logger.warn(
      { deliveryId, runnerId: row.runner.id, attempt: attemptNumber, err: errMessage },
      'agent-webhook-dispatch: exhausted retries; dead-lettered',
    );
    return;
  }

  // Re-enqueue with the delay so BullMQ carries the schedule. The
  // delivery row itself is the source of truth; the queued job is a
  // kicker. `job.queue` is `protected` in the BullMQ type surface but
  // has the `.add` method we need at runtime; cast through unknown.
  const delayMs = retryDelay * 1000;
  const jobQueue = (job as unknown as { queue: { add: (
    name: string,
    data: AgentWebhookDispatchJobData,
    opts: { delay: number; attempts: number; removeOnComplete: number; removeOnFail: number },
  ) => Promise<unknown> } }).queue;
  await jobQueue.add(
    'dispatch',
    { delivery_id: deliveryId },
    {
      delay: delayMs,
      attempts: 1,
      removeOnComplete: 1000,
      removeOnFail: 5000,
    },
  );

  logger.info(
    { deliveryId, runnerId: row.runner.id, attempt: attemptNumber, delayMs, err: errMessage },
    'agent-webhook-dispatch: retrying with backoff',
  );
}

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

export const __test__ = {
  signBody,
  nextRetryDelaySeconds,
  maybeTruncatePayload,
  BACKOFF_SCHEDULE_SECONDS,
  DLQ_AT_ATTEMPT,
  CIRCUIT_BREAKER_THRESHOLD,
  PAYLOAD_CAP_BYTES,
};

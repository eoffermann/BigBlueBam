import type { FastifyBaseLogger } from 'fastify';
import type { Redis } from 'ioredis';
import { bastionConsumesEvent } from '@bigbluebam/shared';
import { env } from '../env.js';
import {
  BASTION_FEED_BINDINGS_KEY,
  BASTION_SUBSCRIPTION_COUNT,
  isBastionFeedCandidate,
  isBastionSubscribed,
} from './bastion-subscriptions.js';

export { isBastionSubscribed, BASTION_SUBSCRIPTION_COUNT };

/**
 * Bastion live-ingest dispatch (Bastion spec 3.5, 8.2, 8.4), modeled on bursar-dispatch-hook.ts.
 * bolt-api is the event hub; every ingested event Bastion consumes is POSTed to bastion-api's
 * durable inbox at /v1/internal/events (container-internal http://bastion-api:4024; the /v1
 * PREFIX IS REQUIRED). The inbox deduplicates on (org, source_idempotency_key), so a repeated
 * forward is cheap.
 *
 * Fire-and-forget with a 5 s bound: proposal reconcile (M6) re-reads agent_proposals, and feeds
 * report staleness through feed.fresh, so a dropped forward is visible, never silent corruption.
 */

function bastionInternalUrl(): string {
  const fromEnv = (env.BASTION_API_INTERNAL_URL ?? '').trim();
  return (fromEnv || 'http://bastion-api:4024').replace(/\/+$/, '');
}

/** Static subscriptions always; feed bindings only when the org's binding set names the pair. */
export async function bastionWants(redis: Redis, orgId: string, source: string, eventType: string): Promise<boolean> {
  if (isBastionSubscribed(source, eventType)) return true;
  if (!isBastionFeedCandidate(source)) return false;
  try {
    return (await redis.sismember(BASTION_FEED_BINDINGS_KEY(orgId), `${source}:${eventType}`)) === 1;
  } catch {
    return false; // Redis hiccup: feeds are observable through feed.fresh; never forward blind
  }
}

export async function dispatchToBastion(
  redis: Redis,
  event: {
    orgId: string;
    eventId?: string;
    source: string;
    eventType: string;
    payload: Record<string, unknown>;
  },
  logger: FastifyBaseLogger,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!(await bastionWants(redis, event.orgId, event.source, event.eventType))) return;
  // proposal.decided only for Bastion's own proposals (issue #206); the inbox re-checks.
  if (!bastionConsumesEvent(event.source, event.eventType, event.payload)) return;
  const secret = env.INTERNAL_SERVICE_SECRET;
  if (!secret) return; // fail closed: the inbox requires the shared secret

  const payloadEventId = typeof event.payload._event_id === 'string' ? event.payload._event_id : undefined;
  try {
    const res = await fetchImpl(`${bastionInternalUrl()}/v1/internal/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': secret },
      signal: AbortSignal.timeout(5000),
      body: JSON.stringify({
        organization_id: event.orgId,
        event: event.eventType,
        source: event.source,
        event_id: payloadEventId ?? event.eventId ?? null,
        payload: event.payload,
      }),
    });
    if (!res.ok) logger.warn({ status: res.status, source: event.source, event_type: event.eventType }, 'bastion dispatch: inbox refused the event');
  } catch (err) {
    logger.warn({ err: (err as Error).message, source: event.source, event_type: event.eventType }, 'bastion dispatch: forward failed');
  }
}

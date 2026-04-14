/**
 * BOLT-API INTERNAL ONLY.
 *
 * This is a Redis-PubSub variant of publishBoltEvent used exclusively inside
 * bolt-api for fan-out back onto the `bolt:events` channel. It is NOT a
 * drop-in replacement for the canonical HTTP-based publisher in
 * `@bigbluebam/shared` (which every other BigBlueBam service uses to POST to
 * bolt-api's `/v1/events/ingest`). Do not import this from any other app or
 * package and do not merge it with the shared module: the two have different
 * transports (Redis PubSub vs. HTTP), different argument shapes, and serve
 * different roles in the event pipeline. See Wave 0.3 / Cross_Product_
 * Integration_Plan.md Step 3 for the consolidation rationale.
 *
 * publishBoltEvent — lightweight utility for other BigBlueBam services to
 * trigger Bolt automation evaluation.
 *
 * Publishes a standardized event envelope to the Redis `bolt:events` PubSub
 * channel. The Bolt event ingestion endpoint (or a future Redis subscriber)
 * picks it up and routes it to matching automations.
 *
 * Usage from any service that has a Redis connection:
 *
 *   import { publishBoltEvent } from '@bigbluebam/bolt-api/lib/publish-event';
 *   // or copy this function into the calling service
 *
 *   await publishBoltEvent(redis, 'task.moved', 'bam', {
 *     task: { id: '...', title: '...' },
 *     from_phase: { id: '...', name: 'In Progress' },
 *     to_phase: { id: '...', name: 'Done' },
 *   }, orgId, { actorId: userId, projectId });
 */

import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';

export type BoltEventSource =
  | 'bam'
  | 'banter'
  | 'beacon'
  | 'brief'
  | 'helpdesk'
  | 'schedule'
  | 'bond'
  | 'blast'
  | 'board'
  | 'bench'
  | 'bearing'
  | 'bill'
  | 'book'
  | 'blank';
export type BoltActorType = 'user' | 'agent' | 'system';

export interface PublishBoltEventOptions {
  actorId?: string;
  actorType?: BoltActorType;
  projectId?: string;
  chainDepth?: number;
}

export interface BoltEventEnvelope {
  id: string;
  source: BoltEventSource;
  event_type: string;
  organization_id: string;
  project_id?: string;
  actor_id?: string;
  actor_type: BoltActorType;
  payload: Record<string, unknown>;
  chain_depth: number;
  timestamp: string;
}

const BOLT_EVENTS_CHANNEL = 'bolt:events';

/**
 * Publish a Bolt event to the Redis PubSub channel.
 *
 * This is a fire-and-forget operation (sub-millisecond). It does NOT write
 * to the database. The Bolt event router picks up published events and
 * evaluates them against registered automations.
 *
 * @param redis    - ioredis client instance
 * @param eventType - e.g. 'task.moved', 'ticket.created', 'message.posted'
 * @param source   - the originating app, e.g. 'bam', 'banter', 'beacon', 'brief', 'helpdesk', 'schedule', 'bond', 'blast', 'board', 'bench', 'bearing', 'bill', 'book', 'blank'
 * @param payload  - event-specific data (task object, ticket object, etc.)
 * @param orgId    - organization ID the event belongs to
 * @param options  - optional actor/project/chain metadata
 */
export async function publishBoltEvent(
  redis: Redis,
  eventType: string,
  source: BoltEventSource,
  payload: Record<string, unknown>,
  orgId: string,
  options: PublishBoltEventOptions = {},
): Promise<string> {
  const eventId = randomUUID();

  const envelope: BoltEventEnvelope = {
    id: eventId,
    source,
    event_type: eventType,
    organization_id: orgId,
    payload,
    actor_id: options.actorId,
    actor_type: options.actorType ?? 'system',
    chain_depth: options.chainDepth ?? 0,
    timestamp: new Date().toISOString(),
  };

  if (options.projectId) {
    envelope.project_id = options.projectId;
  }

  await redis.publish(BOLT_EVENTS_CHANNEL, JSON.stringify(envelope));

  return eventId;
}

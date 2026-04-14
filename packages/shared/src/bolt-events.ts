/**
 * Shared Bolt event publisher used by every BigBlueBam service.
 * Fire-and-forget: never throws, never blocks.
 *
 * This is the single source of truth for the publishBoltEvent signature.
 * Replaces the 12 per-service copies that used to live in
 * apps/*\/src/lib/bolt-events.ts and apps/worker/src/utils/bolt-events.ts.
 */

export type BoltEventSource =
  | 'bam'
  | 'banter'
  | 'beacon'
  | 'bearing'
  | 'bench'
  | 'bill'
  | 'blank'
  | 'blast'
  | 'board'
  | 'bolt'
  | 'bond'
  | 'book'
  | 'brief'
  | 'helpdesk'
  | 'schedule';

export type BoltActorType = 'user' | 'agent' | 'system';

export interface PublishBoltEventOptions {
  boltApiUrl?: string;
  internalSecret?: string;
  timeoutMs?: number;
  logger?: { warn: (obj: unknown, msg?: string) => void };
}

/**
 * Publish an event to Bolt's ingest endpoint.
 *
 * Signature is canonical across all BigBlueBam services. Each service
 * should wrap this with a thin helper that injects its default
 * source and env-resolved URL/secret.
 */
export async function publishBoltEvent(
  eventType: string,
  source: BoltEventSource,
  payload: Record<string, unknown>,
  orgId: string,
  actorId?: string,
  actorType: BoltActorType = actorId ? 'user' : 'system',
  options: PublishBoltEventOptions = {},
): Promise<void> {
  const boltApiUrl =
    options.boltApiUrl ?? process.env.BOLT_API_INTERNAL_URL ?? 'http://bolt-api:4006';
  const internalSecret = options.internalSecret ?? process.env.INTERNAL_SERVICE_SECRET ?? '';
  const timeoutMs = options.timeoutMs ?? 5000;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${boltApiUrl}/v1/events/ingest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Secret': internalSecret,
      },
      body: JSON.stringify({
        event_type: eventType,
        source,
        payload,
        org_id: orgId,
        actor_id: actorId,
        actor_type: actorType,
      }),
      signal: controller.signal,
    });
    if (!res.ok && options.logger) {
      options.logger.warn(
        { eventType, source, orgId, status: res.status },
        'publishBoltEvent: non-2xx response from bolt-api',
      );
    }
  } catch (err) {
    if (options.logger) {
      options.logger.warn(
        { eventType, source, orgId, err: err instanceof Error ? err.message : String(err) },
        'publishBoltEvent: failed to publish event (swallowed)',
      );
    }
    // Fire-and-forget: do not rethrow.
  } finally {
    clearTimeout(timeout);
  }
}

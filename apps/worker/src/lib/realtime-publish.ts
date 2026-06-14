import Redis from 'ioredis';

/**
 * Realtime publish helper for the worker process.
 *
 * The worker is a separate process from the Bam api and therefore cannot
 * call the api's in-memory `broadcast()` (apps/api/src/plugins/websocket.ts).
 * Instead it publishes to the SAME Redis PubSub channel the api's WebSocket
 * subscriber listens on, with the SAME `{ room, event }` envelope. Each api
 * instance's subscriber JSON-parses the message, pulls `room` + `event`, and
 * relays `JSON.stringify(event)` to every socket in that room.
 *
 * CRITICAL: the channel name and envelope shape below MUST match
 * apps/api/src/plugins/websocket.ts byte-for-byte, or the api subscriber
 * will never forward the message.
 *
 *   - REDIS_CHANNEL = 'bigbluebam:events'           (websocket.ts line 29)
 *   - envelope      = JSON.stringify({ room, event }) (websocket.ts broadcast())
 *   - event shape   = { type, payload, timestamp }    (RealtimeEvent)
 */

// Must equal REDIS_CHANNEL in apps/api/src/plugins/websocket.ts.
const REDIS_CHANNEL = 'bigbluebam:events';

let publisher: Redis | null = null;

function getPublisher(): Redis {
  if (!publisher) {
    const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
    // lazyConnect so importing this module never opens a socket; the client
    // connects on the first publish. An `error` listener keeps a transient
    // Redis outage from crashing the worker via an unhandled error event.
    publisher = new Redis(redisUrl, {
      maxRetriesPerRequest: null,
      lazyConnect: true,
    });
    publisher.on('error', () => {
      // Swallow connection errors — realtime push is best-effort.
    });
  }
  return publisher;
}

/**
 * Publish a realtime event to a specific user's personal room
 * (`user:<userId>`). Fire-and-forget: the network round-trip is NOT awaited,
 * so a slow or unreachable Redis can never delay or fail the calling BullMQ
 * job. Failures are swallowed — the notification row is already persisted, and
 * the client will pick it up on its next poll/refetch even if the live push is
 * dropped.
 */
export function publishToUser(userId: string, type: string, payload: unknown): void {
  let envelope: string;
  try {
    envelope = JSON.stringify({
      room: `user:${userId}`,
      event: {
        type,
        payload,
        timestamp: new Date().toISOString(),
      },
    });
  } catch {
    return;
  }
  // Do not await: detach the publish so connection latency never blocks the job.
  getPublisher()
    .publish(REDIS_CHANNEL, envelope)
    .catch(() => {
      // best-effort
    });
}

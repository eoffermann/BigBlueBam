/**
 * Bay realtime WebSocket — the fanout half of lib/broadcast.ts. A browser
 * subscribes to one review version (`bay:version:<versionId>`) and receives the
 * annotation/decision events the REST routes publish, so a second reviewer sees
 * notes + decisions appear live. Read-only fanout: all writes go through the
 * authenticated REST routes. Mirrors apps/bond-api/src/routes/ws.routes.ts.
 *
 * Protocol (client → server): { "type": "subscribe", "version_id": "<uuid>" }
 * Server → client: the BayEvent payloads verbatim, plus
 *   { "type": "subscribed", "version_id": ... } and { "type": "ping" } (25s).
 */
import type { FastifyInstance } from 'fastify';
import Redis from 'ioredis';
import { z } from 'zod';
import { env } from '../env.js';
import { requireAuth } from '../plugins/auth.js';
import { getVersion } from '../services/version.service.js';
import { versionChannel } from '../lib/broadcast.js';

const subscribeSchema = z.object({
  type: z.literal('subscribe'),
  version_id: z.string().uuid(),
});

const PING_INTERVAL_MS = 25_000;

export default async function wsRoutes(fastify: FastifyInstance) {
  fastify.get('/ws', { websocket: true, preHandler: [requireAuth] }, (socket, request) => {
    const user = request.user!;
    const subscriber = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: true });
    let subscribedVersion: string | null = null;
    let closed = false;

    const send = (payload: unknown): void => {
      if (closed) return;
      try {
        socket.send(JSON.stringify(payload));
      } catch {
        /* socket mid-close */
      }
    };

    subscriber.on('message', (_channel: string, message: string) => {
      if (closed) return;
      try {
        socket.send(message);
      } catch {
        /* close handler owns cleanup */
      }
    });

    const pingTimer = setInterval(() => send({ type: 'ping' }), PING_INTERVAL_MS);

    socket.on('message', (raw: Buffer | string) => {
      void (async () => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(String(raw));
        } catch {
          send({ type: 'error', code: 'BAD_FRAME', message: 'Frames must be JSON' });
          return;
        }
        const sub = subscribeSchema.safeParse(parsed);
        if (!sub.success) return; // tolerate unknown frames (e.g. client pong)
        const versionId = sub.data.version_id;
        try {
          // Same org gate the REST routes use — getVersion throws when the
          // version is not in the caller's org.
          await getVersion(versionId, user.org_id);
        } catch {
          send({ type: 'error', code: 'FORBIDDEN', message: 'No access to this review version' });
          return;
        }
        try {
          if (subscriber.status === 'wait') await subscriber.connect();
          if (subscribedVersion) await subscriber.unsubscribe(versionChannel(subscribedVersion));
          await subscriber.subscribe(versionChannel(versionId));
          subscribedVersion = versionId;
          send({ type: 'subscribed', version_id: versionId });
        } catch (err) {
          request.log.warn({ err, versionId }, 'bay ws: subscribe failed');
          send({ type: 'error', code: 'SUBSCRIBE_FAILED', message: 'Try again' });
        }
      })();
    });

    socket.on('close', () => {
      closed = true;
      clearInterval(pingTimer);
      subscriber.disconnect();
    });
    socket.on('error', () => {
      closed = true;
      clearInterval(pingTimer);
      subscriber.disconnect();
    });
  });
}

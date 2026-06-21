/**
 * Bond realtime WebSocket — the fanout half of lib/broadcast.ts (T1).
 *
 * Every deal mutation route publishes a typed DealEvent on the Redis channel
 * `bond:<pipelineId>`. This route subscribes a browser socket to one pipeline
 * room and forwards those events so a second person watching the same pipeline
 * board sees deals move/appear/disappear live instead of on next manual
 * refresh:
 *
 *   browser ── wss …/bond/ws ──▶ here ──▶ SUBSCRIBE bond:<pipelineId>
 *                                       ◀── deal events ◀── REST routes
 *
 * Protocol (client → server):
 *   { "type": "subscribe", "pipeline_id": "<uuid>" }
 *     Switches this socket's subscription to that pipeline (at most one per
 *     socket — the board shows one pipeline at a time). Access is verified
 *     with the same getPipeline org check the REST routes use; a denied
 *     subscribe gets {type:'error', code:'FORBIDDEN'} and the previous
 *     subscription (if any) stays.
 *
 * Server → client: the DealEvent payloads exactly as published (see
 * lib/broadcast.ts), plus:
 *   { "type": "subscribed", "pipeline_id": ... }   ack
 *   { "type": "error", "code": ..., "message": ... }
 *   { "type": "ping" } every 25s — keeps idle-socket-recycling proxies
 *     (Railway's edge) from killing the connection.
 *
 * Read-only fanout by design: this socket never mutates anything. All writes
 * still go through the authenticated REST routes.
 */
import type { FastifyInstance } from 'fastify';
import Redis from 'ioredis';
import { z } from 'zod';
import { env } from '../env.js';
import { requireAuth } from '../plugins/auth.js';
import { getPipeline } from '../services/pipeline.service.js';

const subscribeSchema = z.object({
  type: z.literal('subscribe'),
  pipeline_id: z.string().uuid(),
});

const PING_INTERVAL_MS = 25_000;

export default async function wsRoutes(fastify: FastifyInstance) {
  fastify.get(
    '/ws',
    { websocket: true, preHandler: [requireAuth] },
    (socket, request) => {
      const user = request.user!;

      // Per-socket Redis subscriber: sub-mode connections can't multiplex
      // normal commands, so the shared fastify.redis can't be reused here.
      const subscriber = new Redis(env.REDIS_URL, {
        maxRetriesPerRequest: null,
        lazyConnect: true,
      });
      let subscribedPipeline: string | null = null;
      let closed = false;

      const send = (payload: unknown): void => {
        if (closed) return;
        try {
          socket.send(JSON.stringify(payload));
        } catch {
          /* socket mid-close — the close handler cleans up */
        }
      };

      subscriber.on('message', (_channel: string, message: string) => {
        // Forward verbatim: the payload is already the typed DealEvent JSON
        // the routes published.
        if (closed) return;
        try {
          socket.send(message);
        } catch {
          /* ignore — close handler owns cleanup */
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
          if (!sub.success) {
            // Tolerate unknown frames (e.g. a client pong) silently.
            return;
          }
          const pipelineId = sub.data.pipeline_id;
          try {
            // Same org gate the REST routes use — getPipeline throws when the
            // pipeline is not in the caller's org. A socket may only ever
            // stream a pipeline its user could fetch.
            await getPipeline(pipelineId, user.org_id);
          } catch {
            send({
              type: 'error',
              code: 'FORBIDDEN',
              message: 'You do not have access to this pipeline',
            });
            return;
          }
          try {
            if (subscriber.status === 'wait') await subscriber.connect();
            if (subscribedPipeline) {
              await subscriber.unsubscribe(`bond:${subscribedPipeline}`);
            }
            await subscriber.subscribe(`bond:${pipelineId}`);
            subscribedPipeline = pipelineId;
            send({ type: 'subscribed', pipeline_id: pipelineId });
          } catch (err) {
            request.log.warn({ err, pipelineId }, 'bond ws: subscribe failed');
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
    },
  );
}

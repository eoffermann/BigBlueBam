/**
 * Blueprint realtime WebSocket — the fanout half of lib/broadcast.ts.
 *
 * Every mutation route already publishes a typed BlueprintEvent on the
 * Redis channel `blueprint:<diagramId>`; until this hub existed those
 * events went nowhere (the broadcast module's "added in a follow-up
 * commit" that never followed up). This route closes the loop so two
 * people on the same diagram see each other's edits live:
 *
 *   browser ── wss …/blueprint/ws ──▶ here ──▶ SUBSCRIBE blueprint:<id>
 *                                            ◀── mutation events ◀── REST routes
 *
 * Protocol (client → server):
 *   { "type": "subscribe", "diagram_id": "<uuid>" }
 *     Switches this socket's subscription to that diagram (at most one
 *     per socket — the editor shows one diagram at a time). Access is
 *     verified with the same assertCanRead the GET /graph route uses;
 *     a denied subscribe gets {type:'error', code:'FORBIDDEN'} and the
 *     previous subscription (if any) stays.
 *
 * Server → client: the BlueprintEvent payloads exactly as published
 * (see lib/broadcast.ts for the union), plus:
 *   { "type": "subscribed", "diagram_id": ... }   ack
 *   { "type": "error", "code": ..., "message": ... }
 *   { "type": "ping" } every 25s — keeps proxies (Railway's edge
 *     recycles idle websockets) from killing the connection. Clients
 *     may ignore it or reply anything.
 *
 * Document-only sync by design: viewport (pan/zoom) is per-user client
 * state and never crosses this wire.
 *
 * nginx exposes this at /blueprint/ws on both deployment profiles
 * (compose proxies to :4015/ws; the Railway profile rewrites the same
 * way) — both blocks predate this hub, wired for exactly this purpose.
 */
import type { FastifyInstance } from 'fastify';
import Redis from 'ioredis';
import { z } from 'zod';
import { env } from '../env.js';
import { requireAuth } from '../plugins/auth.js';
import * as svc from '../services/diagram.service.js';
import {
  awarenessChannel,
  awarenessColor,
  broadcastAwareness,
} from '../lib/broadcast.js';

const subscribeSchema = z.object({
  type: z.literal('subscribe'),
  diagram_id: z.string().uuid(),
  // 'mutations' (default) = the structural document channel use-diagram-sync
  // listens on. 'awareness' = the ephemeral cursor/selection channel (T3).
  channel: z.enum(['mutations', 'awareness']).optional().default('mutations'),
});

// T3 awareness frames a client sends on an 'awareness'-subscribed socket.
const cursorSchema = z.object({
  type: z.literal('cursor'),
  diagram_id: z.string().uuid(),
  x: z.number(),
  y: z.number(),
});

const selectionSchema = z.object({
  type: z.literal('selection'),
  diagram_id: z.string().uuid(),
  node_ids: z.array(z.string()).max(500),
  edge_ids: z.array(z.string()).max(500),
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
      let subscribedDiagram: string | null = null;
      let subscribedChannel: 'mutations' | 'awareness' = 'mutations';
      // Stable color for this user, used to tag their awareness events.
      const myColor = awarenessColor(user.id);
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
        // Forward verbatim: the payload is already the typed
        // BlueprintEvent JSON the routes published.
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
          const channelName = (c: 'mutations' | 'awareness', id: string): string =>
            c === 'awareness' ? awarenessChannel(id) : `blueprint:${id}`;

          const sub = subscribeSchema.safeParse(parsed);
          if (sub.success) {
            const diagramId = sub.data.diagram_id;
            try {
              // Same gate as GET /v1/diagrams/:id/graph — org scoping and
              // per-diagram ACLs included. A socket may only ever stream a
              // diagram its user could fetch (applies to both channels).
              await svc.assertCanRead(user.org_id, user.id, diagramId);
            } catch {
              send({
                type: 'error',
                code: 'FORBIDDEN',
                message: 'You do not have access to this diagram',
              });
              return;
            }
            try {
              if (subscriber.status === 'wait') await subscriber.connect();
              if (subscribedDiagram) {
                await subscriber.unsubscribe(
                  channelName(subscribedChannel, subscribedDiagram),
                );
              }
              await subscriber.subscribe(channelName(sub.data.channel, diagramId));
              subscribedDiagram = diagramId;
              subscribedChannel = sub.data.channel;
              send({
                type: 'subscribed',
                diagram_id: diagramId,
                channel: sub.data.channel,
              });
            } catch (err) {
              request.log.warn({ err, diagramId }, 'blueprint ws: subscribe failed');
              send({ type: 'error', code: 'SUBSCRIBE_FAILED', message: 'Try again' });
            }
            return;
          }

          // T3 awareness frames — only honored on an awareness-subscribed
          // socket for the diagram it is subscribed to. Access was already
          // verified at subscribe time. These publish to the separate
          // awareness channel, never the structural one.
          const cur = cursorSchema.safeParse(parsed);
          if (cur.success) {
            if (
              subscribedChannel === 'awareness' &&
              subscribedDiagram === cur.data.diagram_id
            ) {
              await broadcastAwareness(fastify.redis, cur.data.diagram_id, {
                type: 'blueprint.awareness.cursor',
                diagram_id: cur.data.diagram_id,
                user_id: user.id,
                name: user.display_name,
                color: myColor,
                x: cur.data.x,
                y: cur.data.y,
              });
            }
            return;
          }

          const selFrame = selectionSchema.safeParse(parsed);
          if (selFrame.success) {
            if (
              subscribedChannel === 'awareness' &&
              subscribedDiagram === selFrame.data.diagram_id
            ) {
              await broadcastAwareness(fastify.redis, selFrame.data.diagram_id, {
                type: 'blueprint.awareness.selection',
                diagram_id: selFrame.data.diagram_id,
                user_id: user.id,
                name: user.display_name,
                color: myColor,
                node_ids: selFrame.data.node_ids,
                edge_ids: selFrame.data.edge_ids,
              });
            }
            return;
          }

          // Tolerate unknown frames (e.g. a client pong) silently.
        })();
      });

      socket.on('close', () => {
        closed = true;
        clearInterval(pingTimer);
        // Tell other viewers this awareness peer is gone so their cursor +
        // selection highlight clear immediately (not just on staleness).
        if (subscribedChannel === 'awareness' && subscribedDiagram) {
          void broadcastAwareness(fastify.redis, subscribedDiagram, {
            type: 'blueprint.awareness.left',
            diagram_id: subscribedDiagram,
            user_id: user.id,
          });
        }
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

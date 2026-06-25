/**
 * Bin realtime WebSocket — live structured-data editing + presence. A browser
 * subscribes to one asset (`bin:asset:<assetId>`) and receives:
 *   - `bin.data.updated` when anyone commits an edit (so the editor refetches), and
 *   - presence events (`bin.presence.join/leave` + an initial `roster`) so you
 *     can see who else is in the editor.
 *
 * Read-only fanout for data: all edits still go through the authenticated REST
 * routes (each commit mints a new immutable version). Mirrors the bond-api WS
 * hub; adds a small Redis-hash presence roster (`bin:presence:<assetId>`).
 *
 * Protocol (client → server): { "type": "subscribe", "asset_id": "<uuid>" }
 * Server → client: data events verbatim, plus
 *   { "type": "subscribed", "asset_id", "conn_id" }   (conn_id identifies you)
 *   { "type": "bin.presence.roster", "members": [...] }
 *   { "type": "bin.presence.join"|"bin.presence.leave", ... }
 *   { "type": "ping" } every 25s.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import Redis from 'ioredis';
import { z } from 'zod';
import { env } from '../env.js';
import { requireAuth } from '../plugins/auth.js';
import { getAsset } from '../services/asset.service.js';
import { assetChannel, presenceKey, presenceColor } from '../lib/broadcast.js';

const subscribeSchema = z.object({
  type: z.literal('subscribe'),
  asset_id: z.string().uuid(),
});

const PING_INTERVAL_MS = 25_000;
const PRESENCE_TTL_SECONDS = 7200;

interface PresenceMember {
  conn_id: string;
  user_id: string;
  name: string;
  color: string;
}

export default async function wsRoutes(fastify: FastifyInstance) {
  fastify.get('/ws', { websocket: true, preHandler: [requireAuth] }, (socket, request) => {
    const user = request.user!;
    const subscriber = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: true });
    let assetId: string | null = null;
    const connId = randomUUID();
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

    // Remove self from the roster + announce leave. Best-effort.
    const leave = async (): Promise<void> => {
      if (!assetId) return;
      const ch = assetChannel(assetId);
      try {
        await fastify.redis.hdel(presenceKey(assetId), connId);
        await fastify.redis.publish(ch, JSON.stringify({ type: 'bin.presence.leave', conn_id: connId }));
        await subscriber.unsubscribe(ch);
      } catch {
        /* best-effort */
      }
    };

    const pingTimer = setInterval(() => {
      send({ type: 'ping' });
      // Keep an active room's roster alive.
      if (assetId) fastify.redis.expire(presenceKey(assetId), PRESENCE_TTL_SECONDS).catch(() => undefined);
    }, PING_INTERVAL_MS);

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
        const nextAsset = sub.data.asset_id;
        try {
          // Same org gate the REST routes use — getAsset throws when the asset
          // is not in the caller's org.
          await getAsset(nextAsset, user.org_id);
        } catch {
          send({ type: 'error', code: 'FORBIDDEN', message: 'No access to this asset' });
          return;
        }
        try {
          if (subscriber.status === 'wait') await subscriber.connect();
          if (assetId && assetId !== nextAsset) await leave();
          assetId = nextAsset;
          const ch = assetChannel(assetId);
          await subscriber.subscribe(ch);
          send({ type: 'subscribed', asset_id: assetId, conn_id: connId });

          // Snapshot the current roster (before adding self), then join.
          const rosterRaw = await fastify.redis.hgetall(presenceKey(assetId));
          const members: PresenceMember[] = Object.values(rosterRaw)
            .map((v) => {
              try {
                return JSON.parse(v) as PresenceMember;
              } catch {
                return null;
              }
            })
            .filter((m): m is PresenceMember => m != null);
          send({ type: 'bin.presence.roster', members });

          const self: PresenceMember = {
            conn_id: connId,
            user_id: user.id,
            name: user.display_name,
            color: presenceColor(user.id),
          };
          await fastify.redis.hset(presenceKey(assetId), connId, JSON.stringify(self));
          await fastify.redis.expire(presenceKey(assetId), PRESENCE_TTL_SECONDS);
          await fastify.redis.publish(ch, JSON.stringify({ type: 'bin.presence.join', ...self }));
        } catch (err) {
          request.log.warn({ err, assetId: nextAsset }, 'bin ws: subscribe failed');
          send({ type: 'error', code: 'SUBSCRIBE_FAILED', message: 'Try again' });
        }
      })();
    });

    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(pingTimer);
      void leave().finally(() => subscriber.disconnect());
    };
    socket.on('close', cleanup);
    socket.on('error', cleanup);
  });
}

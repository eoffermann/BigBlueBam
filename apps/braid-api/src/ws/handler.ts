import type { FastifyInstance } from 'fastify';
import type { WebSocket } from '@fastify/websocket';
import Redis from 'ioredis';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { sessions, users } from '../db/schema/index.js';
import { env } from '../env.js';
import { BRAID_WS_CHANNEL, braidRoom } from '../lib/realtime.js';

// The /braid/ws realtime hub (spec 5.2). Org-scoped rooms, REFS-ONLY frames. A single
// Redis subscriber fans each published { room, event } to every local socket whose
// room set contains that room. Mirrors apps/banter-api/src/ws/handler.ts.

interface ConnectedClient {
  ws: WebSocket;
  userId: string;
  orgId: string;
  rooms: Set<string>;
}

const clients = new Map<WebSocket, ConnectedClient>();

function broadcastToRoom(room: string, message: string): void {
  for (const [ws, client] of clients) {
    if (client.rooms.has(room) && ws.readyState === 1) ws.send(message);
  }
}

export default async function websocketHandler(fastify: FastifyInstance) {
  const subscriber = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3, lazyConnect: true });
  await subscriber.connect();
  await subscriber.subscribe(BRAID_WS_CHANNEL);

  subscriber.on('message', (_channel, message) => {
    try {
      const { room, event } = JSON.parse(message) as { room: string; event: unknown };
      broadcastToRoom(room, JSON.stringify(event));
    } catch {
      fastify.log.error('braid ws: failed to parse PubSub message');
    }
  });

  fastify.addHook('onClose', async () => {
    await subscriber.quit();
  });

  fastify.get('/ws', { websocket: true }, async (socket, request) => {
    const sessionId = request.cookies?.session;
    if (!sessionId) {
      socket.close(4001, 'Authentication required');
      return;
    }
    const [row] = await db
      .select({
        session: sessions,
        user: { id: users.id, org_id: users.org_id, is_active: users.is_active },
      })
      .from(sessions)
      .innerJoin(users, eq(sessions.user_id, users.id))
      .where(eq(sessions.id, sessionId))
      .limit(1);
    if (!row || new Date(row.session.expires_at) <= new Date() || !row.user.is_active) {
      socket.close(4001, 'Invalid or expired session');
      return;
    }

    const { id: userId, org_id: orgId } = row.user;
    const client: ConnectedClient = {
      ws: socket,
      userId,
      orgId,
      rooms: new Set([braidRoom(orgId), `braid:user:${userId}`]),
    };
    clients.set(socket, client);
    socket.send(JSON.stringify({ type: 'connected', data: { user_id: userId, org_id: orgId } }));

    socket.on('close', () => clients.delete(socket));
    socket.on('error', () => clients.delete(socket));
  });
}

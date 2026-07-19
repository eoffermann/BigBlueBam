import type { FastifyInstance } from 'fastify';
import type { WebSocket } from '@fastify/websocket';
import Redis from 'ioredis';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  sessions,
  users,
  projectMemberships,
  organizationMemberships,
  accountGroupMemberships,
  permissionGroups,
} from '../db/schema/index.js';
import { env } from '../env.js';
import {
  BULWARK_WS_CHANNEL,
  bulwarkAdminRoom,
  bulwarkProjectRoom,
} from '../lib/realtime.js';

// The /bulwark/ws realtime hub (spec 5.2). Rooms are scoped per (org, project), NOT org-wide.
// On connect the socket joins the project rooms it is entitled to: an org admin/owner (or
// superuser) joins the org admin room (every frame); a plain member joins one room per project
// they belong to PLUS the null-project room (SK3 org fallback). A single Redis subscriber fans
// each published { room, event } to every local socket whose room set contains that room.

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

// Resolve the caller's org role (owner/admin/member) for the admin override.
async function resolveOrgRole(userId: string, orgId: string): Promise<string> {
  const rows = await db
    .select({ role: permissionGroups.legacy_role })
    .from(organizationMemberships)
    .leftJoin(
      accountGroupMemberships,
      and(
        eq(accountGroupMemberships.user_id, organizationMemberships.user_id),
        eq(accountGroupMemberships.scope_type, 'org'),
        eq(accountGroupMemberships.scope_id, organizationMemberships.org_id),
      ),
    )
    .leftJoin(permissionGroups, eq(permissionGroups.id, accountGroupMemberships.group_id))
    .where(
      and(
        eq(organizationMemberships.user_id, userId),
        eq(organizationMemberships.org_id, orgId),
      ),
    );
  for (const r of rows) if (r.role) return r.role;
  return 'member';
}

export default async function websocketHandler(fastify: FastifyInstance) {
  const subscriber = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3, lazyConnect: true });
  await subscriber.connect();
  await subscriber.subscribe(BULWARK_WS_CHANNEL);

  subscriber.on('message', (_channel, message) => {
    try {
      const { room, event } = JSON.parse(message) as { room: string; event: unknown };
      broadcastToRoom(room, JSON.stringify(event));
    } catch {
      fastify.log.error('bulwark ws: failed to parse PubSub message');
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
        user: {
          id: users.id,
          org_id: users.org_id,
          is_active: users.is_active,
          is_superuser: users.is_superuser,
        },
      })
      .from(sessions)
      .innerJoin(users, eq(sessions.user_id, users.id))
      .where(eq(sessions.id, sessionId))
      .limit(1);
    if (!row || new Date(row.session.expires_at) <= new Date() || !row.user.is_active) {
      socket.close(4001, 'Invalid or expired session');
      return;
    }

    const { id: userId, org_id: orgId, is_superuser } = row.user;
    const role = await resolveOrgRole(userId, orgId);
    const isAdmin = is_superuser === true || role === 'owner' || role === 'admin';

    const rooms = new Set<string>([`bulwark:user:${userId}`]);
    if (isAdmin) {
      // Admins/owners/superusers receive every org frame.
      rooms.add(bulwarkAdminRoom(orgId));
    } else {
      // Members receive frames only for their projects, plus the null-project fallback room.
      const memberships = await db
        .select({ project_id: projectMemberships.project_id })
        .from(projectMemberships)
        .where(eq(projectMemberships.user_id, userId));
      for (const m of memberships) rooms.add(bulwarkProjectRoom(orgId, m.project_id));
      rooms.add(bulwarkProjectRoom(orgId, null));
    }

    const client: ConnectedClient = { ws: socket, userId, orgId, rooms };
    clients.set(socket, client);
    socket.send(
      JSON.stringify({ type: 'connected', data: { user_id: userId, org_id: orgId, admin: isAdmin } }),
    );

    socket.on('close', () => clients.delete(socket));
    socket.on('error', () => clients.delete(socket));
  });
}

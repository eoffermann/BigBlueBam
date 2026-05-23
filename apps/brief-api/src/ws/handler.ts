import type { FastifyInstance } from 'fastify';
import type { WebSocket } from '@fastify/websocket';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import Redis from 'ioredis';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  sessions,
  users,
  accountGroupMemberships,
  permissionGroups,
} from '../db/schema/index.js';
import { env } from '../env.js';
import {
  loadYjsState,
  debounceYjsUpdate,
  flushAllPendingYjsWrites,
} from '../services/yjs-persistence.service.js';
import { checkDocumentAccessForWs } from './auth.js';
import { nanoid } from 'nanoid';

// ---------------------------------------------------------------------------
// Yjs WebSocket collaboration handler for Brief
//
// Each document is a "room". Clients connect to /ws?doc=<docId> and exchange
// Yjs sync + awareness messages using y-protocols. Redis PubSub fans out
// updates across multiple brief-api instances.
//
// Message types (first byte):
//   0 = sync protocol
//   1 = awareness protocol
//   2 = auth (server -> client only)
// ---------------------------------------------------------------------------

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
const MSG_AUTH = 2;

const AUTH_OK = 0;
const AUTH_DENIED = 1;

interface ConnectedClient {
  ws: WebSocket;
  userId: string;
  orgId: string;
  docId: string;
  displayName: string;
  canEdit: boolean;
}

interface DocumentRoom {
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  clients: Set<ConnectedClient>;
  /** Last user to edit, for persistence attribution */
  lastUserId: string | null;
  lastOrgId: string | null;
}

const rooms = new Map<string, DocumentRoom>();
const instanceId = nanoid(12);

let subscriber: Redis | null = null;
let persistenceTimer: ReturnType<typeof setInterval> | null = null;

function getOrCreateRoom(docId: string): DocumentRoom {
  let room = rooms.get(docId);
  if (room) return room;

  const doc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(doc);

  room = {
    doc,
    awareness,
    clients: new Set(),
    lastUserId: null,
    lastOrgId: null,
  };

  // When awareness changes, broadcast to all clients in room
  awareness.on(
    'update',
    ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
      const changedClients = added.concat(updated, removed);
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MSG_AWARENESS);
      encoding.writeVarUint8Array(
        encoder,
        awarenessProtocol.encodeAwarenessUpdate(awareness, changedClients),
      );
      const message = encoding.toUint8Array(encoder);
      broadcastToRoom(docId, message);
    },
  );

  rooms.set(docId, room);
  return room;
}

function broadcastToRoom(
  docId: string,
  message: Uint8Array,
  excludeWs?: WebSocket,
) {
  const room = rooms.get(docId);
  if (!room) return;
  const buf = Buffer.from(message);
  for (const client of room.clients) {
    if (client.ws !== excludeWs && client.ws.readyState === 1) {
      client.ws.send(buf);
    }
  }
}

function cleanupRoom(docId: string) {
  const room = rooms.get(docId);
  if (!room) return;
  if (room.clients.size > 0) return;

  // Flush Yjs state to DB before dropping the room
  if (room.lastOrgId && room.lastUserId) {
    const state = Y.encodeStateAsUpdate(room.doc);
    debounceYjsUpdate(docId, Buffer.from(state), room.lastOrgId, room.lastUserId, true);
  }

  room.awareness.destroy();
  room.doc.destroy();
  rooms.delete(docId);
}

async function loadDocIntoRoom(room: DocumentRoom, docId: string, orgId: string): Promise<void> {
  const persisted = await loadYjsState(docId, orgId);
  if (persisted?.state) {
    Y.applyUpdate(room.doc, persisted.state);
  }
}

function sendSyncStep1(client: ConnectedClient, room: DocumentRoom) {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MSG_SYNC);
  syncProtocol.writeSyncStep1(encoder, room.doc);
  client.ws.send(Buffer.from(encoding.toUint8Array(encoder)));
}

function sendAuthMessage(ws: WebSocket, status: number) {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MSG_AUTH);
  encoding.writeVarUint(encoder, status);
  ws.send(Buffer.from(encoding.toUint8Array(encoder)));
}

export default async function websocketHandler(fastify: FastifyInstance) {
  // Redis subscriber for cross-instance sync
  subscriber = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: 3,
    lazyConnect: true,
  });
  await subscriber.connect();
  await subscriber.subscribe('brief:yjs');

  subscriber.on('message', (_channel: string, raw: string) => {
    try {
      const parsed = JSON.parse(raw);
      if (parsed._instanceId === instanceId) return;

      const { docId, update, type } = parsed;
      const room = rooms.get(docId);
      if (!room) return;

      if (type === 'sync') {
        const updateBuf = Buffer.from(update, 'base64');
        Y.applyUpdate(room.doc, updateBuf);
        // Broadcast to local clients
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MSG_SYNC);
        syncProtocol.writeUpdate(encoder, updateBuf);
        broadcastToRoom(docId, encoding.toUint8Array(encoder));
      } else if (type === 'awareness') {
        const updateBuf = Buffer.from(update, 'base64');
        awarenessProtocol.applyAwarenessUpdate(room.awareness, updateBuf, null);
      }
    } catch {
      fastify.log.error('Failed to parse brief:yjs PubSub message');
    }
  });

  // Periodic persistence: flush dirty rooms every 30 seconds
  persistenceTimer = setInterval(() => {
    for (const [docId, room] of rooms) {
      if (room.lastOrgId && room.lastUserId) {
        const state = Y.encodeStateAsUpdate(room.doc);
        debounceYjsUpdate(docId, Buffer.from(state), room.lastOrgId, room.lastUserId);
      }
    }
  }, 30_000);

  fastify.addHook('onClose', async () => {
    if (persistenceTimer) {
      clearInterval(persistenceTimer);
      persistenceTimer = null;
    }
    // Flush all pending writes
    await flushAllPendingYjsWrites();
    // Clean up all rooms
    for (const [docId] of rooms) {
      cleanupRoom(docId);
    }
    if (subscriber) {
      await subscriber.quit();
      subscriber = null;
    }
  });

  fastify.get('/ws', { websocket: true }, async (socket, request) => {
    // Authenticate via session cookie
    const sessionId = request.cookies?.session;
    if (!sessionId) {
      sendAuthMessage(socket, AUTH_DENIED);
      socket.close(4001, 'Authentication required');
      return;
    }

    const result = await db
      .select({
        session: sessions,
        user: {
          id: users.id,
          org_id: users.org_id,
          email: users.email,
          display_name: users.display_name,
          is_active: users.is_active,
          is_superuser: users.is_superuser,
        },
      })
      .from(sessions)
      .innerJoin(users, eq(sessions.user_id, users.id))
      .where(eq(sessions.id, sessionId))
      .limit(1);

    const row = result[0];
    if (!row || new Date(row.session.expires_at) <= new Date() || !row.user.is_active) {
      sendAuthMessage(socket, AUTH_DENIED);
      socket.close(4001, 'Invalid or expired session');
      return;
    }

    // Extract document ID from query string
    const url = new URL(request.url, `http://${request.hostname}`);
    const docId = url.searchParams.get('doc');
    if (!docId) {
      sendAuthMessage(socket, AUTH_DENIED);
      socket.close(4002, 'Missing doc parameter');
      return;
    }

    // Wave E.F: role is resolved from the user's org-scope group membership.
    const [roleRow] = await db
      .select({ legacy_role: permissionGroups.legacy_role })
      .from(accountGroupMemberships)
      .innerJoin(permissionGroups, eq(permissionGroups.id, accountGroupMemberships.group_id))
      .where(
        and(
          eq(accountGroupMemberships.user_id, row.user.id),
          eq(accountGroupMemberships.scope_type, 'org'),
          eq(accountGroupMemberships.scope_id, row.user.org_id),
        ),
      )
      .limit(1);
    const userRole = roleRow?.legacy_role ?? 'member';

    // Check document access
    const access = await checkDocumentAccessForWs(
      docId,
      row.user.id,
      row.user.org_id,
      userRole,
      row.user.is_superuser,
    );

    if (!access.hasAccess) {
      sendAuthMessage(socket, AUTH_DENIED);
      socket.close(4003, 'No access to this document');
      return;
    }

    // Send auth OK
    sendAuthMessage(socket, AUTH_OK);

    const client: ConnectedClient = {
      ws: socket,
      userId: row.user.id,
      orgId: row.user.org_id,
      docId,
      displayName: row.user.display_name,
      canEdit: access.canEdit,
    };

    const room = getOrCreateRoom(docId);

    // Load persisted state if this is the first client
    if (room.clients.size === 0) {
      await loadDocIntoRoom(room, docId, row.user.org_id);
    }

    room.clients.add(client);
    room.lastOrgId = row.user.org_id;

    // Send sync step 1 to kick off the Yjs sync handshake
    sendSyncStep1(client, room);

    // Send current awareness states
    const awarenessStates = awarenessProtocol.encodeAwarenessUpdate(
      room.awareness,
      Array.from(room.awareness.getStates().keys()),
    );
    const awarenessEncoder = encoding.createEncoder();
    encoding.writeVarUint(awarenessEncoder, MSG_AWARENESS);
    encoding.writeVarUint8Array(awarenessEncoder, awarenessStates);
    socket.send(Buffer.from(encoding.toUint8Array(awarenessEncoder)));

    socket.on('message', async (raw: Buffer | string) => {
      try {
        const data = raw instanceof Buffer ? new Uint8Array(raw) : new Uint8Array(Buffer.from(raw));
        const decoder = decoding.createDecoder(data);
        const messageType = decoding.readVarUint(decoder);

        switch (messageType) {
          case MSG_SYNC: {
            const encoder = encoding.createEncoder();
            encoding.writeVarUint(encoder, MSG_SYNC);
            const syncMessageType = syncProtocol.readSyncMessage(
              decoder,
              encoder,
              room.doc,
              null,
            );

            // If there's something to reply (sync step 2), send it back
            if (encoding.length(encoder) > 1) {
              socket.send(Buffer.from(encoding.toUint8Array(encoder)));
            }

            // If the message was an update (step 2 or update), broadcast + publish
            if (syncMessageType === syncProtocol.messageYjsSyncStep2 ||
                syncMessageType === syncProtocol.messageYjsUpdate) {
              // Re-encode as update message for other clients
              const updateEncoder = encoding.createEncoder();
              encoding.writeVarUint(updateEncoder, MSG_SYNC);
              syncProtocol.writeUpdate(updateEncoder, Y.encodeStateAsUpdate(room.doc));
              const updateMsg = encoding.toUint8Array(updateEncoder);
              broadcastToRoom(docId, updateMsg, socket);

              // Track last editor for persistence attribution
              room.lastUserId = client.userId;
              room.lastOrgId = client.orgId;

              // Publish to Redis for cross-instance sync
              const stateUpdate = Y.encodeStateAsUpdate(room.doc);
              try {
                await fastify.redis.publish(
                  'brief:yjs',
                  JSON.stringify({
                    _instanceId: instanceId,
                    docId,
                    type: 'sync',
                    update: Buffer.from(stateUpdate).toString('base64'),
                  }),
                );
              } catch {
                fastify.log.warn('Failed to publish brief:yjs sync event');
              }
            }
            break;
          }

          case MSG_AWARENESS: {
            const update = decoding.readVarUint8Array(decoder);
            awarenessProtocol.applyAwarenessUpdate(room.awareness, update, client);

            // Broadcast awareness to other local clients
            const encoder = encoding.createEncoder();
            encoding.writeVarUint(encoder, MSG_AWARENESS);
            encoding.writeVarUint8Array(encoder, update);
            broadcastToRoom(docId, encoding.toUint8Array(encoder), socket);

            // Publish to Redis
            try {
              await fastify.redis.publish(
                'brief:yjs',
                JSON.stringify({
                  _instanceId: instanceId,
                  docId,
                  type: 'awareness',
                  update: Buffer.from(update).toString('base64'),
                }),
              );
            } catch {
              fastify.log.warn('Failed to publish brief:yjs awareness event');
            }
            break;
          }

          default:
            break;
        }
      } catch (err) {
        fastify.log.warn({ err }, 'Invalid Brief WebSocket message');
      }
    });

    socket.on('close', () => {
      room.clients.delete(client);
      // Remove awareness state for this client
      awarenessProtocol.removeAwarenessStates(room.awareness, [room.doc.clientID], null);

      // Clean up empty rooms after a short delay
      if (room.clients.size === 0) {
        setTimeout(() => cleanupRoom(docId), 5_000);
      }
    });

    socket.on('error', () => {
      room.clients.delete(client);
      if (room.clients.size === 0) {
        setTimeout(() => cleanupRoom(docId), 5_000);
      }
    });
  });
}

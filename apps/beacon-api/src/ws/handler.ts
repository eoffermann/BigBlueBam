import type { FastifyInstance, FastifyRequest } from 'fastify';
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
  beaconEntries,
  accountGroupMemberships,
  permissionGroups,
} from '../db/schema/index.js';
import { env } from '../env.js';
import {
  loadYjsState,
  debounceYjsUpdate,
  flushAllPendingYjsWrites,
} from '../services/yjs-persistence.service.js';
import { checkBeaconAccessForWs } from './auth.js';
import { nanoid } from 'nanoid';

// ---------------------------------------------------------------------------
// Yjs WebSocket collaboration handler for Beacon (T4 real-time co-editing)
//
// Ported from apps/brief-api/src/ws/handler.ts. Each beacon entry is a "room"
// keyed by its UUID. Clients connect to /ws/<beaconId> — the shape the stock
// y-websocket provider dials (room name appended to the PATH) — or the
// /ws?doc=<beaconId> query form, and exchange Yjs sync + awareness messages via
// y-protocols. nginx exposes this at /beacon/ws; the client appends /<beaconId>.
// Redis PubSub (channel `beacon:yjs`) fans out updates across instances.
//
// CONTRACT DELTA from Brief: the collaborative body lives in a Y.Text named
// 'body' (markdown source), not a Y.XmlFragment. When a room is first created
// for an entry that has NO persisted yjs_state, the Y.Doc is seeded from the
// entry's current body_markdown BEFORE the first client syncs, so existing
// markdown articles open intact.
//
// Message types (first byte):
//   0 = sync protocol
//   1 = awareness protocol
//   2 = auth (server -> client only)
// ---------------------------------------------------------------------------

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
const MSG_AUTH = 2;

// y-protocols/auth message-type-2 payload: 0 = permission-denied. We never send
// an "OK" frame — success is the absence of a denial. AUTH_DENIED below is the
// status byte kept for the denial path.
const AUTH_DENIED = 1;

const REDIS_CHANNEL = 'beacon:yjs';

interface ConnectedClient {
  ws: WebSocket;
  userId: string;
  orgId: string;
  beaconId: string;
  displayName: string;
  canEdit: boolean;
  /** Yjs awareness clientIDs this socket announced — removed on disconnect so
   *  other participants drop the cursor immediately instead of waiting out the
   *  awareness timeout. */
  controlledAwarenessIds: Set<number>;
}

interface BeaconRoom {
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  clients: Set<ConnectedClient>;
  /** Last user to edit, for persistence attribution */
  lastUserId: string | null;
  lastOrgId: string | null;
}

const rooms = new Map<string, BeaconRoom>();
const instanceId = nanoid(12);

let subscriber: Redis | null = null;
let persistenceTimer: ReturnType<typeof setInterval> | null = null;

function getOrCreateRoom(beaconId: string): BeaconRoom {
  let room = rooms.get(beaconId);
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

  // When awareness changes, broadcast to all clients in room. The origin (set by
  // applyAwarenessUpdate) tells us which socket announced which awareness
  // clientIDs so the close handler can retract exactly those.
  awareness.on(
    'update',
    (
      { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
      origin: unknown,
    ) => {
      if (origin && typeof origin === 'object' && 'controlledAwarenessIds' in origin) {
        const ids = (origin as ConnectedClient).controlledAwarenessIds;
        for (const id of added.concat(updated)) ids.add(id);
        for (const id of removed) ids.delete(id);
      }
      const changedClients = added.concat(updated, removed);
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MSG_AWARENESS);
      encoding.writeVarUint8Array(
        encoder,
        awarenessProtocol.encodeAwarenessUpdate(awareness, changedClients),
      );
      const message = encoding.toUint8Array(encoder);
      broadcastToRoom(beaconId, message);
    },
  );

  rooms.set(beaconId, room);
  return room;
}

function broadcastToRoom(beaconId: string, message: Uint8Array, excludeWs?: WebSocket) {
  const room = rooms.get(beaconId);
  if (!room) return;
  const buf = Buffer.from(message);
  for (const client of room.clients) {
    if (client.ws !== excludeWs && client.ws.readyState === 1) {
      client.ws.send(buf);
    }
  }
}

function cleanupRoom(beaconId: string) {
  const room = rooms.get(beaconId);
  if (!room) return;
  if (room.clients.size > 0) return;

  // Flush Yjs state to DB before dropping the room
  if (room.lastOrgId && room.lastUserId) {
    const state = Y.encodeStateAsUpdate(room.doc);
    debounceYjsUpdate(beaconId, Buffer.from(state), room.lastOrgId, room.lastUserId, true);
  }

  room.awareness.destroy();
  room.doc.destroy();
  rooms.delete(beaconId);
}

/**
 * Seeds a freshly-created room. If the entry already has persisted Yjs state we
 * apply it. Otherwise (legacy markdown article, never co-edited) we initialize
 * the 'body' Y.Text from the entry's current body_markdown so the first client
 * to connect sees the existing article rather than a blank document.
 */
async function loadOrSeedRoom(room: BeaconRoom, beaconId: string, orgId: string): Promise<void> {
  const persisted = await loadYjsState(beaconId, orgId);
  if (persisted?.state) {
    Y.applyUpdate(room.doc, persisted.state);
    return;
  }

  // No collaborative state yet — seed from the canonical markdown column.
  const [entry] = await db
    .select({ body_markdown: beaconEntries.body_markdown })
    .from(beaconEntries)
    .where(and(eq(beaconEntries.id, beaconId), eq(beaconEntries.organization_id, orgId)))
    .limit(1);

  const seed = entry?.body_markdown ?? '';
  if (seed.length > 0) {
    const body = room.doc.getText('body');
    // Guard against a race where state was applied between checks.
    if (body.length === 0) {
      body.insert(0, seed);
    }
  }
}

function sendSyncStep1(client: ConnectedClient, room: BeaconRoom) {
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
  await subscriber.subscribe(REDIS_CHANNEL);

  subscriber.on('message', (_channel: string, raw: string) => {
    try {
      const parsed = JSON.parse(raw);
      if (parsed._instanceId === instanceId) return;

      const { beaconId, update, type } = parsed;
      const room = rooms.get(beaconId);
      if (!room) return;

      if (type === 'sync') {
        const updateBuf = Buffer.from(update, 'base64');
        Y.applyUpdate(room.doc, updateBuf);
        // Broadcast to local clients
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MSG_SYNC);
        syncProtocol.writeUpdate(encoder, updateBuf);
        broadcastToRoom(beaconId, encoding.toUint8Array(encoder));
      } else if (type === 'awareness') {
        const updateBuf = Buffer.from(update, 'base64');
        awarenessProtocol.applyAwarenessUpdate(room.awareness, updateBuf, null);
      }
    } catch {
      fastify.log.error('Failed to parse beacon:yjs PubSub message');
    }
  });

  // Periodic persistence: flush dirty rooms every 30 seconds
  persistenceTimer = setInterval(() => {
    for (const [beaconId, room] of rooms) {
      if (room.lastOrgId && room.lastUserId) {
        const state = Y.encodeStateAsUpdate(room.doc);
        debounceYjsUpdate(beaconId, Buffer.from(state), room.lastOrgId, room.lastUserId);
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
    for (const [beaconId] of rooms) {
      cleanupRoom(beaconId);
    }
    if (subscriber) {
      await subscriber.quit();
      subscriber = null;
    }
  });

  const connectionHandler = async (socket: WebSocket, request: FastifyRequest) => {
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

    // Beacon id: y-websocket appends the room name to the PATH (/ws/<beaconId>)
    // — that is what the Beacon client actually dials. The ?doc= query form is
    // the original Brief contract, kept for back-compat.
    const params = request.params as { beaconId?: string };
    const url = new URL(request.url, `http://${request.hostname}`);
    const beaconId = params.beaconId ?? url.searchParams.get('doc');
    if (!beaconId) {
      sendAuthMessage(socket, AUTH_DENIED);
      socket.close(4002, 'Missing beacon id');
      return;
    }

    // Role is resolved from the user's org-scope permission-group membership,
    // same as the auth plugin / Brief WS handler.
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

    // Check beacon access
    const access = await checkBeaconAccessForWs(
      beaconId,
      row.user.id,
      row.user.org_id,
      userRole,
      row.user.is_superuser,
    );

    if (!access.hasAccess) {
      sendAuthMessage(socket, AUTH_DENIED);
      socket.close(4003, 'No access to this beacon');
      return;
    }

    // Auth OK — deliberately send NOTHING. The y-websocket client has no
    // "auth OK" message type: in y-protocols/auth, message-type-2 means
    // permission-DENIED. The sync-step-1 sent below confirms the connection.
    // (Denials still work: they socket.close() with a 40xx code.)

    const client: ConnectedClient = {
      ws: socket,
      userId: row.user.id,
      orgId: row.user.org_id,
      beaconId,
      displayName: row.user.display_name,
      canEdit: access.canEdit,
      controlledAwarenessIds: new Set(),
    };

    const room = getOrCreateRoom(beaconId);

    // Load persisted state (or seed from body_markdown) if this is the first
    // client. Must complete BEFORE we send sync step 1 so the client receives
    // the existing article, not a blank doc.
    if (room.clients.size === 0) {
      await loadOrSeedRoom(room, beaconId, row.user.org_id);
    }

    room.clients.add(client);
    room.lastOrgId = row.user.org_id;

    // Send sync step 1 to kick off the Yjs sync handshake
    sendSyncStep1(client, room);

    // Proactively push the full current doc state as an update. The standard
    // step1 -> client-step1 -> step2 handshake relies on receiving the CLIENT's
    // sync-step-1, but the client sends that immediately on open — during the
    // async auth/seed awaits above, BEFORE socket.on('message') is attached
    // below, so `ws` drops it and the server never replies with the seed. The
    // FIRST client would then never receive existing/seeded content. An
    // unconditional full-state update is idempotent and closes that race.
    {
      const fullState = Y.encodeStateAsUpdate(room.doc);
      const fullEncoder = encoding.createEncoder();
      encoding.writeVarUint(fullEncoder, MSG_SYNC);
      syncProtocol.writeUpdate(fullEncoder, fullState);
      socket.send(Buffer.from(encoding.toUint8Array(fullEncoder)));
    }

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
            // Read-only clients (viewers, no edit grant) may request state (sync
            // step 1) but never mutate the shared doc — drop their step-2/update
            // frames before they apply.
            const syncStart = decoder.pos;
            const syncSubType = decoding.readVarUint(decoder);
            if (!client.canEdit && syncSubType !== syncProtocol.messageYjsSyncStep1) {
              break;
            }
            decoder.pos = syncStart;
            const encoder = encoding.createEncoder();
            encoding.writeVarUint(encoder, MSG_SYNC);
            const syncMessageType = syncProtocol.readSyncMessage(decoder, encoder, room.doc, null);

            // If there's something to reply (sync step 2), send it back
            if (encoding.length(encoder) > 1) {
              socket.send(Buffer.from(encoding.toUint8Array(encoder)));
            }

            // If the message was an update (step 2 or update), broadcast + publish
            if (
              syncMessageType === syncProtocol.messageYjsSyncStep2 ||
              syncMessageType === syncProtocol.messageYjsUpdate
            ) {
              // Re-encode as update message for other clients
              const updateEncoder = encoding.createEncoder();
              encoding.writeVarUint(updateEncoder, MSG_SYNC);
              syncProtocol.writeUpdate(updateEncoder, Y.encodeStateAsUpdate(room.doc));
              const updateMsg = encoding.toUint8Array(updateEncoder);
              broadcastToRoom(beaconId, updateMsg, socket);

              // Track last editor for persistence attribution
              room.lastUserId = client.userId;
              room.lastOrgId = client.orgId;

              // Publish to Redis for cross-instance sync
              const stateUpdate = Y.encodeStateAsUpdate(room.doc);
              try {
                await fastify.redis.publish(
                  REDIS_CHANNEL,
                  JSON.stringify({
                    _instanceId: instanceId,
                    beaconId,
                    type: 'sync',
                    update: Buffer.from(stateUpdate).toString('base64'),
                  }),
                );
              } catch {
                fastify.log.warn('Failed to publish beacon:yjs sync event');
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
            broadcastToRoom(beaconId, encoding.toUint8Array(encoder), socket);

            // Publish to Redis
            try {
              await fastify.redis.publish(
                REDIS_CHANNEL,
                JSON.stringify({
                  _instanceId: instanceId,
                  beaconId,
                  type: 'awareness',
                  update: Buffer.from(update).toString('base64'),
                }),
              );
            } catch {
              fastify.log.warn('Failed to publish beacon:yjs awareness event');
            }
            break;
          }

          default:
            break;
        }
      } catch (err) {
        fastify.log.warn({ err }, 'Invalid Beacon WebSocket message');
      }
    });

    socket.on('close', () => {
      room.clients.delete(client);
      // Retract THIS client's awareness entries (their cursor). The room
      // listener broadcasts the removal locally; mirror it to Redis so viewers
      // on other instances drop the ghost cursor immediately too.
      const controlled = Array.from(client.controlledAwarenessIds);
      if (controlled.length > 0) {
        awarenessProtocol.removeAwarenessStates(room.awareness, controlled, null);
        const removal = awarenessProtocol.encodeAwarenessUpdate(room.awareness, controlled);
        fastify.redis
          .publish(
            REDIS_CHANNEL,
            JSON.stringify({
              _instanceId: instanceId,
              beaconId,
              type: 'awareness',
              update: Buffer.from(removal).toString('base64'),
            }),
          )
          .catch(() => {
            /* best effort — awareness timeout is the fallback */
          });
      }

      // Clean up empty rooms after a short delay
      if (room.clients.size === 0) {
        setTimeout(() => cleanupRoom(beaconId), 5_000);
      }
    });

    socket.on('error', () => {
      room.clients.delete(client);
      if (room.clients.size === 0) {
        setTimeout(() => cleanupRoom(beaconId), 5_000);
      }
    });
  };

  // Both URL shapes hit the same handler: /ws/<beaconId> is what the stock
  // y-websocket provider sends (room appended to the path); /ws?doc= is the
  // original contract this server shipped with.
  fastify.get('/ws', { websocket: true }, connectionHandler);
  fastify.get('/ws/:beaconId', { websocket: true }, connectionHandler);
}

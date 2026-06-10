/**
 * Bureau WebSocket hub (workstream 2 — Agent B).
 *
 *   GET /bureau/ws  — raw WebSocket upgrade, authenticated by the shared
 *                     session cookie at handshake time.
 *
 * Implements §8 of the bureau design doc: an 11-message client→server and
 * 11-message server→client protocol over JSON frames, with Redis PubSub
 * as the cross-instance fan-out and Redis hashes/sets as the live presence
 * substrate (§7).
 *
 * Topology:
 *   - One Redis subscriber per socket (sub-mode can't multiplex normal cmds).
 *     Channels: bureau:floor:{floorId}, bureau:room:{roomId}, user:{userId}.
 *   - Writes go through fastify.redis (the shared connection from
 *     plugins/redis.ts).
 *   - presence-mutation helpers (presenceService.*) live inline in this
 *     file because workstream 2 is a sprint-shape and the broader
 *     service module hasn't been carved out yet. They follow the exact
 *     Redis key layout from §7 of the design doc so a future refactor
 *     can lift them verbatim into a dedicated services/presence.service.ts.
 *
 * Authentication: copies the session-cookie pattern from
 * apps/board-api/src/ws/handler.ts. A missing or invalid session is
 * closed with 4401 (per the assignment's "no session, close 4401").
 *
 * LiveKit handoff: on enter_room, we mint a token via
 * @bigbluebam/livekit-tokens for `bureau-room-{roomId}` with a 3600s TTL
 * and push a livekit_token frame to the connecting socket. Matches the
 * REST handler in livekit.routes.ts.
 *
 * Bolt events: user.entered_room / user.left_room / status.changed /
 * room.locked / knock.requested / knock.resolved are fired through the
 * typed wrappers in apps/bureau-api/src/lib/bureau-events.ts so the
 * Wave 0.4 catalog drift guard stays clean (bare event names + explicit
 * `source: 'bureau'`).
 */

import type { FastifyInstance } from 'fastify';
import type { WebSocket } from '@fastify/websocket';
import Redis from 'ioredis';
import { and, eq } from 'drizzle-orm';
import { mintRoomToken } from '@bigbluebam/livekit-tokens';
import { nanoid } from 'nanoid';
import { db } from '../db/index.js';
import { sessions, users } from '../db/schema/index.js';
import { bureauKnocks, bureauSummons } from '../db/schema/bureau.js';
import { env } from '../env.js';
import {
  evaluateRoomAccess,
  hasRoomAclEntry,
  isOrgAdminOrOwner,
  loadRoom,
} from '../middleware/room-access.js';
import {
  emitKnockRequested,
  emitKnockResolved,
  emitRoomLocked,
  emitStatusChanged,
  emitUserEnteredRoom,
  emitUserLeftRoom,
  type KnockResolution,
} from '../lib/bureau-events.js';
import { isUserInDnd } from '../services/dnd-check.service.js';
import { getCallingConfig } from '../services/calling-settings.service.js';
import * as presence from '../services/presence.service.js';
import {
  channels as presenceChannels,
  mirrorPresenceToShared,
  publishPresenceDelta,
  publishRoomEvent,
  publishUserTarget,
} from '../services/presence-publisher.service.js';
import {
  fanOutSummon,
  grantAccessAndSummon,
  planSummon,
  recordSummon,
  reportDenials,
} from '../services/summon.service.js';
import { scheduleKnockTimeout } from '../services/knock-queue.service.js';

// ─────────────────────────────────────────────────────────────────────
// Per-socket connection record
// ─────────────────────────────────────────────────────────────────────

interface ConnectedClient {
  ws: WebSocket;
  /** Per-socket Redis subscriber (separate connection: sub-mode can't multiplex). */
  subscriber: Redis;
  /** Stable id for this socket, used as the presence sessionId in Redis. */
  sessionId: string;
  userId: string;
  orgId: string;
  displayName: string;
  isSuperuser: boolean;
  /** Active floor (subscribed via subscribe_floor); null until the client picks one. */
  floorId: string | null;
  /** Active room (set after enter_room, cleared on leave_room). */
  roomId: string | null;
  /** Last status reported by set_status — defaults to 'available'. */
  status: string;
  /** Last reported location triple (for presence_delta repaints). */
  locationUrl: string | null;
  locationApp: string | null;
  locationLabel: string | null;
  /** When this socket entered its current room — used to compute session_duration_ms. */
  roomEnteredAt: number | null;
  /** Rate-limit window state. */
  msgCount: number;
  msgWindowStart: number;
  /** Set of pubsub channels this socket has subscribed to, for cleanup. */
  channels: Set<string>;
}

/** Per-socket WS message rate-limit window (matches board-api defaults). */
const WS_RATE_LIMIT_MAX = 120;
const WS_RATE_LIMIT_WINDOW_MS = 10_000;

/** Bureau room name format used for the LiveKit room — matches livekit.routes.ts. */
function buildBureauRoomName(roomId: string): string {
  return `bureau-room-${roomId}`;
}

/** Allowed presence-status enum (mirrors the spec). */
const ALLOWED_STATUS = new Set([
  'available',
  'busy',
  'dnd',
  'focus',
  'away',
  'in_meeting',
]);

/** Allowed door-privacy enum (mirrors the bureau_rooms.privacy_default values). */
const ALLOWED_PRIVACY = new Set(['open', 'knock', 'private']);

// ─────────────────────────────────────────────────────────────────────
// Presence + pub/sub live in services/presence.service.ts and
// services/presence-publisher.service.ts (D-10 consolidation — the §7
// Redis layout used to be re-implemented inline here). The channel-name
// builders below are aliases so the subscribe/unsubscribe call sites read
// the same as before.
// ─────────────────────────────────────────────────────────────────────

const floorChannel = presenceChannels.floor;
const roomChannel = presenceChannels.room;
const userChannel = presenceChannels.user;

// ─────────────────────────────────────────────────────────────────────
// Outbound frame helpers
// ─────────────────────────────────────────────────────────────────────

function frame(type: string, data: Record<string, unknown> = {}): string {
  return JSON.stringify({ type, data, timestamp: new Date().toISOString() });
}

function safeSend(ws: WebSocket, payload: string): void {
  if (ws.readyState === 1) {
    try {
      ws.send(payload);
    } catch {
      // Socket may have torn down between the readyState check and send.
      // No remediation: the close handler will run shortly.
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// Route registration
// ─────────────────────────────────────────────────────────────────────

export default async function wsRoutes(fastify: FastifyInstance) {
  fastify.get('/bureau/ws', { websocket: true }, async (socket, request) => {
    // ── Authenticate via shared session cookie at handshake time ──
    const sessionId = request.cookies?.session;
    if (!sessionId) {
      socket.close(4401, 'Authentication required');
      return;
    }
    const [row] = await db
      .select({
        session: sessions,
        user: {
          id: users.id,
          org_id: users.org_id,
          display_name: users.display_name,
          is_active: users.is_active,
          is_superuser: users.is_superuser,
        },
      })
      .from(sessions)
      .innerJoin(users, eq(sessions.user_id, users.id))
      .where(eq(sessions.id, sessionId))
      .limit(1);

    if (!row || new Date(row.session.expires_at) <= new Date() || !row.user.is_active) {
      socket.close(4401, 'Invalid or expired session');
      return;
    }

    const userId = row.user.id;
    const orgId = row.user.org_id;
    const displayName = row.user.display_name;
    const isSuperuser = row.user.is_superuser;

    // Resolve the caller's org role once — used by the door / lock / knock
    // permission checks below. Cheap: single join, scoped to (user, org).
    let userRole = 'member';
    try {
      const { accountGroupMemberships, permissionGroups } = await import(
        '../db/schema/index.js'
      );
      const [roleRow] = await db
        .select({ legacy_role: permissionGroups.legacy_role })
        .from(accountGroupMemberships)
        .innerJoin(
          permissionGroups,
          eq(permissionGroups.id, accountGroupMemberships.group_id),
        )
        .where(
          and(
            eq(accountGroupMemberships.user_id, userId),
            eq(accountGroupMemberships.scope_type, 'org'),
            eq(accountGroupMemberships.scope_id, orgId),
          ),
        )
        .limit(1);
      if (roleRow?.legacy_role) userRole = roleRow.legacy_role;
    } catch {
      // Fall back to 'member' — the role lookup is a defense-in-depth gate;
      // the per-room ACL check still applies regardless.
    }

    // ── Per-socket Redis subscriber. We pub from fastify.redis (the
    //    shared connection) and sub from THIS connection only, because
    //    Redis sub-mode can't multiplex normal commands. The connection
    //    closes on socket close.
    const subscriber = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: 3,
      lazyConnect: true,
    });
    try {
      await subscriber.connect();
    } catch (err) {
      fastify.log.error({ err }, 'Bureau WS subscriber connect failed');
      socket.close(1011, 'Redis unavailable');
      return;
    }

    const client: ConnectedClient = {
      ws: socket,
      subscriber,
      sessionId: nanoid(16),
      userId,
      orgId,
      displayName,
      isSuperuser,
      floorId: null,
      roomId: null,
      status: 'available',
      locationUrl: null,
      locationApp: null,
      locationLabel: null,
      roomEnteredAt: null,
      msgCount: 0,
      msgWindowStart: Date.now(),
      channels: new Set<string>(),
    };

    // Open the durable presence session and subscribe to the user's
    // own targeted channel so summons/knocks reach them out of the box.
    await presence.createSession(fastify.redis, {
      sessionId: client.sessionId,
      userId,
      isAgent: false,
      orgId,
      device: 'web',
    });

    // Forward every PubSub message verbatim to the socket. The publisher
    // is responsible for framing (we use the same {type,data,timestamp}
    // envelope on every channel). MUST be attached BEFORE the first
    // subscribe (D-13): ioredis delivers messages the moment a channel is
    // subscribed, so a ring/knock/summon published in the gap between
    // subscribe-completion and listener attachment was silently dropped.
    subscriber.on('message', (_channel: string, message: string) => {
      safeSend(socket, message);
    });

    const personalChannel = userChannel(userId);
    await subscriber.subscribe(personalChannel);
    client.channels.add(personalChannel);

    safeSend(
      socket,
      frame('connected', { user_id: userId, session_id: client.sessionId }),
    );

    // ── Helpers that are closures over `client` / `ctx` ──

    async function publishFloor(floorId: string, payload: string) {
      await publishPresenceDelta(fastify.redis, floorId, payload);
    }
    async function publishRoom(roomId: string, payload: string) {
      await publishRoomEvent(fastify.redis, roomId, payload);
    }
    async function publishUser(targetUserId: string, payload: string) {
      await publishUserTarget(fastify.redis, targetUserId, payload);
    }

    /** Door-state permission check. Owners of offices may set their own;
     *  shared-room privacy requires either the ACL `manager` role or org
     *  admin/owner. We borrow the room-access middleware for the ACL probe
     *  and inline the role check. */
    async function canSetDoor(
      room: { id: string; type: string; owner_id: string | null },
    ): Promise<boolean> {
      if (isSuperuser) return true;
      if (isOrgAdminOrOwner(userRole)) return true;
      if (room.type === 'office') {
        return !!room.owner_id && room.owner_id === userId;
      }
      // Shared room: ACL `manager` role grants door rights. We re-query
      // here because hasRoomAclEntry only checks presence, not role.
      const { bureauRoomAcl } = await import('../db/schema/bureau.js');
      const [aclRow] = await db
        .select({ role: bureauRoomAcl.role })
        .from(bureauRoomAcl)
        .where(
          and(
            eq(bureauRoomAcl.room_id, room.id),
            eq(bureauRoomAcl.user_id, userId),
          ),
        )
        .limit(1);
      return aclRow?.role === 'manager';
    }

    /** Lock-room permission: "anyone in a shared room can lock/unlock"
     *  per §8. We additionally require the caller to currently be inside
     *  said room. Office rooms require the owner. */
    async function canLockRoom(room: {
      id: string;
      type: string;
      owner_id: string | null;
    }): Promise<boolean> {
      if (isSuperuser) return true;
      if (isOrgAdminOrOwner(userRole)) return true;
      if (room.type === 'office') {
        return !!room.owner_id && room.owner_id === userId;
      }
      // Shared room: must be inside it right now.
      if (client.roomId === room.id) return true;
      // Or have a private-room ACL row.
      return await hasRoomAclEntry(room.id, userId);
    }

    socket.on('message', async (raw: Buffer | string) => {
      // ── Per-socket rate limit ──
      const now = Date.now();
      if (now - client.msgWindowStart > WS_RATE_LIMIT_WINDOW_MS) {
        client.msgCount = 0;
        client.msgWindowStart = now;
      }
      client.msgCount++;
      if (client.msgCount > WS_RATE_LIMIT_MAX) {
        socket.close(4429, 'Rate limit exceeded');
        return;
      }

      let msg: { type?: string; [k: string]: unknown };
      try {
        msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
      } catch {
        safeSend(
          socket,
          frame('error', { code: 'BAD_FRAME', message: 'Invalid JSON' }),
        );
        return;
      }
      if (!msg || typeof msg.type !== 'string') {
        safeSend(
          socket,
          frame('error', { code: 'BAD_FRAME', message: 'Missing type' }),
        );
        return;
      }

      try {
        switch (msg.type) {
          // ──────────────────────────────────────────────
          case 'subscribe_floor': {
            const floorId = typeof msg.floorId === 'string' ? msg.floorId : null;
            if (!floorId) break;

            // Unsubscribe any previously subscribed floor so the socket
            // doesn't bleed events from multiple floors at once.
            if (client.floorId && client.floorId !== floorId) {
              const oldChan = floorChannel(client.floorId);
              if (client.channels.has(oldChan)) {
                await subscriber.unsubscribe(oldChan);
                client.channels.delete(oldChan);
              }
            }
            const chan = floorChannel(floorId);
            await subscriber.subscribe(chan);
            client.channels.add(chan);
            client.floorId = floorId;

            // Mirror floor onto the session hash so the floor reaper /
            // presence aggregator sees the join.
            await presence.setFloor(fastify.redis, client.sessionId, floorId);

            const snapshot = await presence.snapshotFloor(fastify.redis, floorId);
            safeSend(
              socket,
              frame('presence_snapshot', {
                floorId,
                occupancy: snapshot.occupancy,
                roomState: snapshot.roomState,
              }),
            );
            break;
          }

          // ──────────────────────────────────────────────
          case 'enter_room': {
            const roomId = typeof msg.roomId === 'string' ? msg.roomId : null;
            if (!roomId) break;

            const room = await loadRoom(roomId, orgId);
            if (!room) {
              safeSend(
                socket,
                frame('error', { code: 'NOT_FOUND', message: 'Room not found' }),
              );
              break;
            }

            const decision = await evaluateRoomAccess(room, {
              id: userId,
              role: userRole,
              is_superuser: isSuperuser,
            });
            if (!decision.allowed) {
              safeSend(
                socket,
                frame('error', {
                  code: 'FORBIDDEN',
                  message:
                    decision.reason ?? 'You do not have access to this room',
                }),
              );
              break;
            }

            // Leave the prior room first so room counts stay accurate and
            // both rooms see the transition. Bolt user.left_room fires for
            // the prior room before user.entered_room for the new one.
            if (client.roomId && client.roomId !== roomId) {
              // leaveRoom throws when the session HASH has lapsed mid-flight;
              // fall back to the socket's own mirror so the leave events
              // still go out (matches the old inline tolerance).
              let left: { previousRoomId: string | null; floorId: string | null };
              try {
                left = await presence.leaveRoom(fastify.redis, client.sessionId);
              } catch {
                left = { previousRoomId: client.roomId, floorId: client.floorId };
              }
              if (left.previousRoomId) {
                const leftPayload = frame('room_leave', {
                  roomId: left.previousRoomId,
                  userId,
                });
                await publishRoom(left.previousRoomId, leftPayload);
                if (left.floorId) {
                  await publishFloor(
                    left.floorId,
                    frame('presence_delta', { userId, roomId: null }),
                  );
                }
                emitUserLeftRoom(orgId, userId, {
                  room: { id: left.previousRoomId, floor_id: left.floorId ?? null },
                  user: { id: userId, name: displayName },
                  session_duration_ms: client.roomEnteredAt
                    ? Date.now() - client.roomEnteredAt
                    : undefined,
                  actor: { id: userId },
                  org: { id: orgId },
                }).catch(() => {
                  /* fire-and-forget */
                });
              }
            }

            // Auto-subscribe to the new room channel so the entering
            // socket receives subsequent room events without an explicit
            // subscribe message.
            const newRoomChan = roomChannel(roomId);
            if (!client.channels.has(newRoomChan)) {
              await subscriber.subscribe(newRoomChan);
              client.channels.add(newRoomChan);
            }

            await presence.enterRoom(
              fastify.redis,
              client.sessionId,
              roomId,
              room.floor_id,
            );
            client.roomId = roomId;
            client.floorId = room.floor_id;
            client.roomEnteredAt = Date.now();

            // Mint a LiveKit token so the connecting socket can join
            // audio without a follow-up REST call. Credentials resolve
            // through the calling-settings service (system_settings over
            // env, D-1); when the platform kill switch is OFF the user
            // still enters the room but gets no audio token.
            const roomName = buildBureauRoomName(roomId);
            const calling = await getCallingConfig(fastify.redis);
            if (!calling.enabled) {
              safeSend(
                socket,
                frame('error', {
                  code: 'CALLING_DISABLED',
                  message:
                    'Calling is disabled platform-wide; room joined without audio',
                }),
              );
            } else {
              try {
                const token = await mintRoomToken(
                  calling.livekitApiKey,
                  calling.livekitApiSecret,
                  {
                    identity: userId,
                    roomName,
                    name: displayName,
                    metadata: {
                      user_id: userId,
                      display_name: displayName,
                      org_id: orgId,
                      bureau_room_id: roomId,
                    },
                    ttlSeconds: 3600,
                  },
                );
                safeSend(
                  socket,
                  frame('livekit_token', {
                    roomName,
                    token,
                    url: calling.livekitUrl,
                  }),
                );
              } catch (err) {
                fastify.log.error(
                  { err, roomId, userId },
                  'Bureau WS failed to mint LiveKit token',
                );
                safeSend(
                  socket,
                  frame('error', {
                    code: 'LIVEKIT_MINT_FAILED',
                    message: 'Audio token unavailable; room joined without audio',
                  }),
                );
              }
            }

            const enterPayload = frame('room_enter', { roomId, userId });
            await publishRoom(roomId, enterPayload);
            await publishFloor(
              room.floor_id,
              frame('presence_delta', { userId, roomId }),
            );

            emitUserEnteredRoom(orgId, userId, {
              room: {
                id: roomId,
                name: room.type, // room.name not exposed by loadRoom; use type as a stand-in label
                type: room.type,
                floor_id: room.floor_id,
              },
              livekit_room: roomName,
              user: { id: userId, name: displayName },
              actor: { id: userId, name: displayName },
              org: { id: orgId },
            }).catch(() => {
              /* fire-and-forget */
            });
            await mirrorPresenceToShared(
              fastify.redis,
              userId,
              client.status as presence.PresenceStatus,
              { orgId, roomId },
            );
            break;
          }

          // ──────────────────────────────────────────────
          case 'leave_room': {
            let left: { previousRoomId: string | null; floorId: string | null };
            try {
              left = await presence.leaveRoom(fastify.redis, client.sessionId);
            } catch {
              left = { previousRoomId: client.roomId, floorId: client.floorId };
            }
            client.roomId = null;
            client.roomEnteredAt = null;
            if (left.previousRoomId) {
              const leavePayload = frame('room_leave', {
                roomId: left.previousRoomId,
                userId,
              });
              await publishRoom(left.previousRoomId, leavePayload);
              if (left.floorId) {
                await publishFloor(
                  left.floorId,
                  frame('presence_delta', { userId, roomId: null }),
                );
              }
              // Also unsubscribe the per-socket subscriber from the room
              // channel so we don't receive our own leave echo from
              // mid-flight publishes.
              const chan = roomChannel(left.previousRoomId);
              if (client.channels.has(chan)) {
                await subscriber.unsubscribe(chan);
                client.channels.delete(chan);
              }
              emitUserLeftRoom(orgId, userId, {
                room: { id: left.previousRoomId, floor_id: left.floorId ?? null },
                user: { id: userId, name: displayName },
                actor: { id: userId },
                org: { id: orgId },
              }).catch(() => {
                /* fire-and-forget */
              });
            }
            await mirrorPresenceToShared(
              fastify.redis,
              userId,
              client.status as presence.PresenceStatus,
              { orgId, roomId: null },
            );
            break;
          }

          // ──────────────────────────────────────────────
          case 'heartbeat': {
            await presence.heartbeat(fastify.redis, client.sessionId);
            break;
          }

          // ──────────────────────────────────────────────
          case 'set_status': {
            const status =
              typeof msg.status === 'string' && ALLOWED_STATUS.has(msg.status)
                ? msg.status
                : null;
            if (!status) {
              safeSend(
                socket,
                frame('error', {
                  code: 'BAD_FRAME',
                  message: 'Invalid status value',
                }),
              );
              break;
            }
            const statusText =
              typeof msg.statusText === 'string' ? msg.statusText : undefined;
            const emoji = typeof msg.emoji === 'string' ? msg.emoji : undefined;
            // Read-before-write to keep the Bolt event's previous/current
            // pair (the consolidated setStatus doesn't return the old value).
            const prev =
              (await presence.getSession(fastify.redis, client.sessionId))
                ?.status ?? null;
            await presence.setStatus(
              fastify.redis,
              client.sessionId,
              status as presence.PresenceStatus,
              statusText,
              emoji,
            );
            client.status = status;

            const payload = frame('status_changed', {
              userId,
              status,
              statusText: statusText ?? null,
              emoji: emoji ?? null,
            });
            if (client.floorId) await publishFloor(client.floorId, payload);
            if (client.roomId) await publishRoom(client.roomId, payload);

            emitStatusChanged(orgId, userId, {
              user: { id: userId },
              status: { previous: prev, current: status },
              actor: { id: userId },
              org: { id: orgId },
            }).catch(() => {
              /* fire-and-forget */
            });
            await mirrorPresenceToShared(
              fastify.redis,
              userId,
              status as presence.PresenceStatus,
              { orgId, roomId: client.roomId },
            );
            break;
          }

          // ──────────────────────────────────────────────
          case 'set_door': {
            const roomId = typeof msg.roomId === 'string' ? msg.roomId : null;
            const privacy =
              typeof msg.privacy === 'string' && ALLOWED_PRIVACY.has(msg.privacy)
                ? msg.privacy
                : null;
            if (!roomId || !privacy) {
              safeSend(
                socket,
                frame('error', {
                  code: 'BAD_FRAME',
                  message: 'roomId and privacy required',
                }),
              );
              break;
            }
            const room = await loadRoom(roomId, orgId);
            if (!room) {
              safeSend(
                socket,
                frame('error', { code: 'NOT_FOUND', message: 'Room not found' }),
              );
              break;
            }
            if (!(await canSetDoor(room))) {
              safeSend(
                socket,
                frame('error', {
                  code: 'FORBIDDEN',
                  message: 'You do not have permission to set this door',
                }),
              );
              break;
            }
            await presence.setDoor(
              fastify.redis,
              roomId,
              privacy as presence.RoomPrivacy,
              userId,
            );
            const payload = frame('door_changed', {
              roomId,
              privacy,
              by: userId,
            });
            await publishRoom(roomId, payload);
            if (room.floor_id) await publishFloor(room.floor_id, payload);
            break;
          }

          // ──────────────────────────────────────────────
          case 'lock_room': {
            const roomId = typeof msg.roomId === 'string' ? msg.roomId : null;
            const locked = typeof msg.locked === 'boolean' ? msg.locked : null;
            if (!roomId || locked === null) {
              safeSend(
                socket,
                frame('error', {
                  code: 'BAD_FRAME',
                  message: 'roomId and locked required',
                }),
              );
              break;
            }
            const room = await loadRoom(roomId, orgId);
            if (!room) {
              safeSend(
                socket,
                frame('error', { code: 'NOT_FOUND', message: 'Room not found' }),
              );
              break;
            }
            if (!(await canLockRoom(room))) {
              safeSend(
                socket,
                frame('error', {
                  code: 'FORBIDDEN',
                  message: 'You do not have permission to lock this room',
                }),
              );
              break;
            }
            // Treat "locked" as a door override flipped to private.
            const nextPrivacy = locked ? 'private' : room.privacy_default;
            await presence.setDoor(
              fastify.redis,
              roomId,
              nextPrivacy as presence.RoomPrivacy,
              userId,
            );

            const payload = frame('room_locked', {
              roomId,
              locked,
              by: userId,
            });
            await publishRoom(roomId, payload);
            if (room.floor_id) await publishFloor(room.floor_id, payload);

            if (locked) {
              emitRoomLocked(orgId, userId, {
                room: { id: roomId, name: null },
                privacy: {
                  previous: room.privacy_default,
                  current: nextPrivacy,
                },
                reason: 'ws_lock',
                actor: { id: userId },
                org: { id: orgId },
              }).catch(() => {
                /* fire-and-forget */
              });
            }
            break;
          }

          // ──────────────────────────────────────────────
          case 'knock': {
            const roomId = typeof msg.roomId === 'string' ? msg.roomId : null;
            const message =
              typeof msg.message === 'string' ? msg.message.slice(0, 1000) : null;
            if (!roomId) break;

            const room = await loadRoom(roomId, orgId);
            if (!room) {
              safeSend(
                socket,
                frame('error', { code: 'NOT_FOUND', message: 'Room not found' }),
              );
              break;
            }
            if (room.type !== 'office') {
              safeSend(
                socket,
                frame('error', {
                  code: 'BAD_REQUEST',
                  message: 'Only office rooms can be knocked on',
                }),
              );
              break;
            }
            if (!room.owner_id) {
              safeSend(
                socket,
                frame('error', {
                  code: 'BAD_REQUEST',
                  message: 'This office has no occupant to receive a knock',
                }),
              );
              break;
            }
            if (room.owner_id === userId) {
              safeSend(
                socket,
                frame('error', {
                  code: 'BAD_REQUEST',
                  message: 'You cannot knock on your own office',
                }),
              );
              break;
            }

            // §4.3 DND check — same semantics as the REST route, just
            // shaped as a WS event. No row is persisted, no Bolt event
            // fires; the visitor receives knock_resolved with
            // decision: 'dnd_blocked' and can follow up via the
            // /v1/knocks/leave-note REST endpoint if they want.
            const ownerDndForKnock = await isUserInDnd(fastify.redis, room.owner_id);
            if (ownerDndForKnock) {
              safeSend(
                socket,
                frame('knock_resolved', {
                  knockId: null,
                  roomId,
                  decision: 'dnd_blocked',
                  leave_a_note_endpoint: '/v1/knocks/leave-note',
                }),
              );
              break;
            }

            const [created] = await db
              .insert(bureauKnocks)
              .values({
                org_id: orgId,
                room_id: roomId,
                visitor_id: userId,
                owner_id: room.owner_id,
                status: 'pending',
                message,
              })
              .returning({
                id: bureauKnocks.id,
                owner_id: bureauKnocks.owner_id,
                room_id: bureauKnocks.room_id,
                visitor_id: bureauKnocks.visitor_id,
              });
            if (!created) break;

            // §4.3 schedule the 30s timeout. Fire-and-forget.
            void scheduleKnockTimeout(created.id);

            const ownerId = created.owner_id;
            await publishUser(
              ownerId,
              frame('knock_incoming', {
                knockId: created.id,
                visitor: { id: userId, name: displayName },
                roomId,
                message,
              }),
            );
            emitKnockRequested(orgId, userId, {
              knock: { id: created.id },
              room: { id: roomId, name: null },
              visitor: { id: userId, name: displayName },
              owner: { id: ownerId },
              message,
              actor: { id: userId },
              org: { id: orgId },
            }).catch(() => {
              /* fire-and-forget */
            });

            safeSend(
              socket,
              frame('knock_sent', { knockId: created.id, roomId }),
            );
            break;
          }

          // ──────────────────────────────────────────────
          case 'knock_respond': {
            const knockId = typeof msg.knockId === 'string' ? msg.knockId : null;
            const decision =
              typeof msg.decision === 'string' &&
              (msg.decision === 'admit' ||
                msg.decision === 'defer' ||
                msg.decision === 'decline')
                ? msg.decision
                : null;
            if (!knockId || !decision) {
              safeSend(
                socket,
                frame('error', {
                  code: 'BAD_FRAME',
                  message: 'knockId and decision required',
                }),
              );
              break;
            }
            const [existing] = await db
              .select({
                id: bureauKnocks.id,
                owner_id: bureauKnocks.owner_id,
                visitor_id: bureauKnocks.visitor_id,
                room_id: bureauKnocks.room_id,
                status: bureauKnocks.status,
              })
              .from(bureauKnocks)
              .where(
                and(eq(bureauKnocks.id, knockId), eq(bureauKnocks.org_id, orgId)),
              )
              .limit(1);
            if (!existing) {
              safeSend(
                socket,
                frame('error', { code: 'NOT_FOUND', message: 'Knock not found' }),
              );
              break;
            }
            if (existing.owner_id !== userId) {
              safeSend(
                socket,
                frame('error', {
                  code: 'FORBIDDEN',
                  message: 'Only the room owner can resolve this knock',
                }),
              );
              break;
            }
            if (existing.status !== 'pending') {
              safeSend(
                socket,
                frame('error', {
                  code: 'BAD_REQUEST',
                  message: `Knock is already resolved (status=${existing.status})`,
                }),
              );
              break;
            }
            const decisionMap: Record<typeof decision, KnockResolution> = {
              admit: 'admitted',
              defer: 'deferred',
              decline: 'declined',
            };
            const nextStatus = decisionMap[decision];
            const resolvedAt = new Date();
            await db
              .update(bureauKnocks)
              .set({ status: nextStatus, resolved_at: resolvedAt })
              .where(
                and(eq(bureauKnocks.id, knockId), eq(bureauKnocks.org_id, orgId)),
              );

            await publishUser(
              existing.visitor_id,
              frame('knock_resolved', { knockId, decision: nextStatus }),
            );
            emitKnockResolved(orgId, userId, {
              knock: { id: knockId, status: nextStatus },
              room: { id: existing.room_id },
              visitor: { id: existing.visitor_id },
              owner: { id: existing.owner_id },
              resolved_at: resolvedAt.toISOString(),
              actor: { id: userId },
              org: { id: orgId },
            }).catch(() => {
              /* fire-and-forget */
            });
            break;
          }

          // ──────────────────────────────────────────────
          case 'location_update': {
            const url = typeof msg.url === 'string' ? msg.url : null;
            const app = typeof msg.app === 'string' ? msg.app : null;
            const label = typeof msg.label === 'string' ? msg.label : undefined;
            if (!url || !app) break;
            client.locationUrl = url;
            client.locationApp = app;
            client.locationLabel = label ?? null;
            await presence.updateLocation(
              fastify.redis,
              client.sessionId,
              url,
              app,
              label ?? null,
            );
            if (client.floorId) {
              await publishFloor(
                client.floorId,
                frame('presence_delta', {
                  userId,
                  location: { url, app, label: label ?? null },
                }),
              );
            }
            break;
          }

          // ──────────────────────────────────────────────
          // Summon flow (§10 of the design doc, workstream 6).
          // The §8 trio: summon (start), summon_respond (recipient's
          // join/stay decision), summon_grant_access (§4.4 follow-up
          // after the access report).
          case 'summon': {
            const targetUrl =
              typeof msg.targetUrl === 'string' ? msg.targetUrl : null;
            const targetApp = typeof msg.app === 'string' ? msg.app : null;
            const targetLabel =
              typeof msg.label === 'string' ? msg.label : undefined;
            const lkRoomHint =
              typeof msg.lkRoomHint === 'string' ? msg.lkRoomHint : undefined;
            if (!targetUrl || !targetApp) {
              safeSend(
                socket,
                frame('error', {
                  code: 'BAD_FRAME',
                  message: 'summon requires targetUrl and app',
                }),
              );
              break;
            }

            const plan = await planSummon(fastify.redis, {
              orgId,
              summonerId: userId,
              targetUrl,
              targetApp,
              targetLabel,
              lkRoomHint,
            });
            if (!plan) {
              safeSend(
                socket,
                frame('error', {
                  code: 'BAD_REQUEST',
                  message:
                    'You are not currently in a Bureau room (summon disabled)',
                }),
              );
              break;
            }

            const summonId = await recordSummon({
              orgId,
              summonerId: userId,
              fromRoomId: plan.fromRoomId,
              targetUrl,
              targetApp,
              targetLabel,
              lkRoomHint,
              eligible: plan.eligibleRecipients,
              denied: plan.deniedRecipients,
            });

            await fanOutSummon({
              redis: fastify.redis,
              summonId,
              orgId,
              summonerId: userId,
              summonerName: displayName,
              targetUrl,
              targetApp,
              targetLabel,
              lkRoomHint,
              recipients: plan.eligibleRecipients,
              logger: fastify.log,
            });

            if (plan.deniedRecipients.length > 0) {
              await reportDenials({
                redis: fastify.redis,
                summonId,
                summonerId: userId,
                denied: plan.deniedRecipients,
                canShare: plan.canShare,
              });
            }

            safeSend(
              socket,
              frame('summon_ack', {
                summonId,
                accepted: true,
                eligibleCount: plan.eligibleRecipients.length,
                deniedCount: plan.deniedRecipients.length,
                canShare: plan.canShare,
              }),
            );
            break;
          }

          case 'summon_respond': {
            // The §8 contract has the recipient send { summonId, decision }
            // with decision = 'join' | 'stay'. The actual navigation is
            // performed client-side by the bureau-client SDK; the server
            // only needs to record the outcome on the audit row so the
            // §10 step 7 "summon_progress to the summoner" loop closes.
            const summonId =
              typeof msg.summonId === 'string' ? msg.summonId : null;
            const decision =
              msg.decision === 'join' || msg.decision === 'stay'
                ? msg.decision
                : null;
            if (!summonId || !decision) {
              safeSend(
                socket,
                frame('error', {
                  code: 'BAD_FRAME',
                  message: 'summonId and decision required',
                }),
              );
              break;
            }

            const [existing] = await db
              .select({
                id: bureauSummons.id,
                summoner_id: bureauSummons.summoner_id,
                recipients: bureauSummons.recipients,
              })
              .from(bureauSummons)
              .where(
                and(
                  eq(bureauSummons.id, summonId),
                  eq(bureauSummons.org_id, orgId),
                ),
              )
              .limit(1);
            if (!existing) {
              safeSend(
                socket,
                frame('error', {
                  code: 'NOT_FOUND',
                  message: 'Summon not found',
                }),
              );
              break;
            }

            type RecipientRow = {
              userId: string;
              name?: string | null;
              outcome:
                | 'pending'
                | 'joined'
                | 'declined'
                | 'no_access'
                | 'granted'
                | 'timed_out';
              reason?: string | null;
            };
            const recipients: RecipientRow[] = Array.isArray(existing.recipients)
              ? (existing.recipients as RecipientRow[])
              : [];
            const me = recipients.find((r) => r.userId === userId);
            if (!me) {
              safeSend(
                socket,
                frame('error', {
                  code: 'FORBIDDEN',
                  message: 'You are not a recipient of this summon',
                }),
              );
              break;
            }
            // Only progress out of `pending` — terminal states stick.
            if (me.outcome === 'pending') {
              me.outcome = decision === 'join' ? 'joined' : 'declined';
              await db
                .update(bureauSummons)
                .set({ recipients })
                .where(eq(bureauSummons.id, summonId));
            }

            // Send a fresh summon_progress to the summoner so the UI can
            // tick its "joined / total" counter.
            const joined = recipients.filter(
              (r) => r.outcome === 'joined' || r.outcome === 'granted',
            ).length;
            const total = recipients.length;
            await publishUser(
              existing.summoner_id,
              frame('summon_progress', {
                summonId,
                joined,
                total,
              }),
            );
            safeSend(
              socket,
              frame('summon_ack', {
                summonId,
                accepted: true,
                decision: me.outcome,
              }),
            );
            break;
          }

          case 'summon_grant_access': {
            const summonId =
              typeof msg.summonId === 'string' ? msg.summonId : null;
            const userIds = Array.isArray(msg.userIds)
              ? (msg.userIds as unknown[]).filter(
                  (u): u is string => typeof u === 'string',
                )
              : [];
            if (!summonId || userIds.length === 0) {
              safeSend(
                socket,
                frame('error', {
                  code: 'BAD_FRAME',
                  message: 'summonId and userIds required',
                }),
              );
              break;
            }
            const result = await grantAccessAndSummon({
              redis: fastify.redis,
              summonId,
              summonerId: userId,
              summonerName: displayName,
              userIds,
              logger: fastify.log,
            });
            safeSend(
              socket,
              frame('summon_ack', {
                summonId,
                accepted: true,
                granted: result.granted,
                missing: result.missing,
              }),
            );
            break;
          }

          // ──────────────────────────────────────────────
          default: {
            safeSend(
              socket,
              frame('error', {
                code: 'UNKNOWN_TYPE',
                message: `Unknown message type: ${msg.type}`,
              }),
            );
            break;
          }
        }
      } catch (err) {
        fastify.log.error(
          { err, type: msg.type, userId, orgId },
          'Bureau WS handler error',
        );
        safeSend(
          socket,
          frame('error', {
            code: 'INTERNAL',
            message: 'Failed to process message',
          }),
        );
      }
    });

    // ── Connection close (graceful or not): tear down presence state,
    //    publish leave events, unsubscribe the per-socket subscriber.
    const cleanup = async () => {
      try {
        const finalRoomId = client.roomId;
        const finalFloorId = client.floorId;
        // endSession returns null when the HASH already lapsed; fall back to
        // the socket's own mirror so the leave events still go out.
        const final =
          (await presence.endSession(fastify.redis, client.sessionId)) ?? {
            userId,
            roomId: client.roomId,
            floorId: client.floorId,
          };
        if (final.roomId) {
          const leavePayload = frame('room_leave', {
            roomId: final.roomId,
            userId,
          });
          await publishRoom(final.roomId, leavePayload).catch(() => {
            /* best effort */
          });
          if (final.floorId) {
            await publishFloor(
              final.floorId,
              frame('presence_delta', { userId, roomId: null }),
            ).catch(() => {
              /* best effort */
            });
          }
          emitUserLeftRoom(orgId, userId, {
            room: { id: final.roomId, floor_id: final.floorId ?? null },
            user: { id: userId, name: displayName },
            session_duration_ms: client.roomEnteredAt
              ? Date.now() - client.roomEnteredAt
              : undefined,
            actor: { id: userId },
            org: { id: orgId },
          }).catch(() => {
            /* fire-and-forget */
          });
        }
        if (finalFloorId && !final.floorId) {
          // Edge: endSession returns the room's floor; if the socket only
          // ever did subscribe_floor without enter_room we still need to
          // signal departure on the floor channel.
          await publishFloor(
            finalFloorId,
            frame('presence_delta', { userId, roomId: null }),
          ).catch(() => {
            /* best effort */
          });
        }
        if (finalRoomId && !final.roomId) {
          // Same edge for the room channel — should not happen because
          // endSession also pulls roomId, but defensive.
        }
        await mirrorPresenceToShared(fastify.redis, userId, 'offline', {
          orgId,
          roomId: null,
        });
      } catch (err) {
        fastify.log.warn({ err, userId }, 'Bureau WS cleanup partial failure');
      } finally {
        // Drain subscriptions and close the per-socket Redis connection.
        try {
          if (client.channels.size > 0) {
            await subscriber.unsubscribe(...client.channels);
          }
        } catch {
          /* ignore */
        }
        try {
          await subscriber.quit();
        } catch {
          /* ignore */
        }
      }
    };

    socket.on('close', () => {
      void cleanup();
    });
    socket.on('error', (err: Error) => {
      fastify.log.warn({ err, userId }, 'Bureau WS socket error');
      void cleanup();
    });
  });
}

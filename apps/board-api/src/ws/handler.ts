import type { FastifyInstance } from 'fastify';
import type { WebSocket } from '@fastify/websocket';
import Redis from 'ioredis';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  sessions,
  users,
  boards,
  boardCollaborators,
  projectMembers,
  accountGroupMemberships,
  permissionGroups,
} from '../db/schema/index.js';
import { env } from '../env.js';
import { saveScene } from './persistence.js';
import { BoardRedisState } from './redis-state.js';
import {
  BOARD_ELEMENT_SOFT_LIMIT,
  BOARD_ELEMENT_HARD_LIMIT,
} from '../services/element-snapshot.service.js';
import { nanoid } from 'nanoid';

interface ConnectedClient {
  ws: WebSocket;
  userId: string;
  orgId: string;
  boardId: string | null;
  displayName: string;
  color: string;
  canEdit: boolean;
  isAdminOrOwner: boolean;
  /** Message count in the current rate-limit window */
  msgCount: number;
  /** Timestamp (ms) when the current rate-limit window started */
  msgWindowStart: number;
}

/** Max WebSocket messages per client per window */
const WS_RATE_LIMIT_MAX = 120;
/** Rate-limit window duration in ms (10 seconds) */
const WS_RATE_LIMIT_WINDOW_MS = 10_000;

const CURSOR_COLORS = [
  '#FF6B6B', // red
  '#4ECDC4', // teal
  '#45B7D1', // sky blue
  '#96CEB4', // sage
  '#FFEAA7', // yellow
  '#DDA0DD', // plum
  '#98D8C8', // mint
  '#F7DC6F', // gold
];

const clients = new Map<WebSocket, ConnectedClient>();
// Dirty scene state used to live in this Map, but multi-instance setups
// (Railway, k8s) can hit any replica and the map was only visible to the
// instance that received the latest scene_update. We now read/write it
// via BoardRedisState so the eventual flush is correct regardless of
// which replica owns the room when the last collaborator leaves.
const instanceId = nanoid(12);

let persistenceTimer: ReturnType<typeof setInterval> | null = null;

function broadcastToRoom(boardId: string, message: string, excludeWs?: WebSocket) {
  for (const [ws, client] of clients) {
    if (client.boardId === boardId && ws !== excludeWs && ws.readyState === 1) {
      ws.send(message);
    }
  }
}

/** True iff this replica still has at least one client connected to the
 *  given board. Used by the disconnect path to decide whether THIS
 *  instance should attempt the flush-on-empty-room handoff. */
function instanceHasClientsInRoom(boardId: string): boolean {
  for (const [, client] of clients) {
    if (client.boardId === boardId) return true;
  }
  return false;
}

function getCollaboratorsInRoom(boardId: string): Array<{ id: string; name: string; color: string }> {
  const collaborators: Array<{ id: string; name: string; color: string }> = [];
  const seen = new Set<string>();
  for (const [, client] of clients) {
    if (client.boardId === boardId && !seen.has(client.userId)) {
      seen.add(client.userId);
      collaborators.push({
        id: client.userId,
        name: client.displayName,
        color: client.color,
      });
    }
  }
  return collaborators;
}

function assignColor(boardId: string): string {
  const usedColors = new Set<string>();
  for (const [, client] of clients) {
    if (client.boardId === boardId) {
      usedColors.add(client.color);
    }
  }
  for (const color of CURSOR_COLORS) {
    if (!usedColors.has(color)) return color;
  }
  // All colors taken, cycle based on count
  return CURSOR_COLORS[usedColors.size % CURSOR_COLORS.length]!;
}

export default async function websocketHandler(fastify: FastifyInstance) {
  // Redis-backed state for dirty scenes, flush locks, and event streams.
  // Uses fastify.redis (the shared connection) for writes; subscriber is
  // a dedicated connection because Redis sub-mode can't multiplex with
  // other commands.
  const state = new BoardRedisState(fastify.redis as unknown as Redis, fastify.log);

  // Dedicated subscriber connection (sub-mode can't multiplex normal cmds).
  const subscriber = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: 3,
    lazyConnect: true,
  });
  await subscriber.connect();

  // Two channels: scene + presence on board:events, cursors on a
  // separate channel. The split keeps the high-volume cursor traffic
  // from delaying the lower-volume scene/presence traffic on subscribers
  // that pause to JSON.parse each message.
  await subscriber.subscribe(BoardRedisState.EVENTS_CHANNEL, BoardRedisState.CURSORS_CHANNEL);

  subscriber.on('message', (_channel: string, message: string) => {
    try {
      const parsed = JSON.parse(message);
      // Skip messages from this instance — the local broadcastToRoom
      // already delivered them.
      if (parsed._instanceId === instanceId) return;

      const { boardId, event } = parsed;
      if (boardId && event) {
        const payload = JSON.stringify(event);
        broadcastToRoom(boardId, payload);
      }
    } catch {
      fastify.log.error('Failed to parse board PubSub message');
    }
  });

  // Periodic persistence: every 5 seconds, scan for dirty boards and
  // flush them. Each replica scans the SAME Redis namespace, but the
  // takeDirty() Lua atomically removes the entry so only one replica
  // ends up doing each flush — no double-write race.
  persistenceTimer = setInterval(async () => {
    const ids = await state.listDirtyBoardIds();
    for (const boardId of ids) {
      const scene = await state.takeDirty(boardId);
      if (!scene) continue;
      try {
        await saveScene(boardId, scene.orgId, scene);
      } catch (err) {
        fastify.log.error({ boardId, err }, 'Failed to persist board scene');
        // Re-mark as dirty so the next 5s tick retries.
        await state.setDirty(boardId, scene);
      }
    }
  }, 5000);

  fastify.addHook('onClose', async () => {
    if (persistenceTimer) {
      clearInterval(persistenceTimer);
      persistenceTimer = null;
    }
    // Best-effort final flush on graceful shutdown. SCAN-take-flush so
    // we don't leave orphaned dirty entries for the next replica to
    // pick up — that would just delay persistence by another 5s tick.
    const ids = await state.listDirtyBoardIds();
    for (const boardId of ids) {
      const scene = await state.takeDirty(boardId);
      if (!scene) continue;
      try {
        await saveScene(boardId, scene.orgId, scene);
      } catch (err) {
        fastify.log.error({ boardId, err }, 'Failed to persist board scene on shutdown');
      }
    }
    await subscriber.quit();
  });

  async function publishEvent(boardId: string, event: Record<string, unknown>) {
    await state.publishEvent({ _instanceId: instanceId, boardId, event });
  }

  async function publishCursor(boardId: string, event: Record<string, unknown>) {
    await state.publishCursor({ _instanceId: instanceId, boardId, event });
  }

  /** Called from a client's disconnect path. If THIS instance just lost
   *  its last client for the board, try to acquire the cross-replica
   *  flush lock and persist immediately rather than waiting up to 5s
   *  for the periodic timer. The lock prevents two replicas (each of
   *  whom may have just lost their last client) from racing each other
   *  through saveScene. If we don't get the lock, another replica will
   *  handle it; if we do, we flush and release. */
  async function maybeFlushOnRoomEmpty(boardId: string) {
    if (instanceHasClientsInRoom(boardId)) return;
    const acquired = await state.tryAcquireFlushLock(boardId);
    if (!acquired) return;
    try {
      const scene = await state.takeDirty(boardId);
      if (scene) {
        await saveScene(boardId, scene.orgId, scene);
        fastify.log.info({ boardId }, 'Flushed dirty scene on room-empty');
      }
    } catch (err) {
      fastify.log.error({ boardId, err }, 'Failed to flush scene on room-empty');
    } finally {
      await state.releaseFlushLock(boardId);
    }
  }

  interface BoardAccessResult {
    hasAccess: boolean;
    canEdit: boolean;
    locked: boolean;
  }

  /**
   * Check if a user has access to a board and determine edit permissions.
   * Returns access info including whether the user can edit.
   */
  async function checkBoardAccess(
    boardId: string,
    userId: string,
    orgId: string,
    userRole: string,
  ): Promise<BoardAccessResult> {
    const deny: BoardAccessResult = { hasAccess: false, canEdit: false, locked: false };

    const [board] = await db
      .select()
      .from(boards)
      .where(and(eq(boards.id, boardId), eq(boards.organization_id, orgId)))
      .limit(1);

    if (!board) return deny;
    if (board.archived_at) return deny;

    const locked = !!board.locked;
    const ROLE_HIERARCHY = ['viewer', 'member', 'admin', 'owner'] as const;
    const roleIdx = ROLE_HIERARCHY.indexOf(userRole as (typeof ROLE_HIERARCHY)[number]);
    const isOrgAdminOrOwner = roleIdx >= 2; // admin or owner

    // Org admins/owners always have full access
    if (isOrgAdminOrOwner) {
      return { hasAccess: true, canEdit: true, locked };
    }

    // Creator always has full access
    if (board.created_by === userId) {
      return { hasAccess: true, canEdit: true, locked };
    }

    // Organization-wide visibility: any org member can read and edit
    if (board.visibility === 'organization') {
      return { hasAccess: true, canEdit: true, locked };
    }

    // Project visibility: check project membership
    if (board.visibility === 'project' && board.project_id) {
      const [membership] = await db
        .select()
        .from(projectMembers)
        .where(
          and(
            eq(projectMembers.project_id, board.project_id),
            eq(projectMembers.user_id, userId),
          ),
        )
        .limit(1);
      if (membership) {
        return { hasAccess: true, canEdit: true, locked };
      }
    }

    // Check explicit collaborator
    const [collab] = await db
      .select()
      .from(boardCollaborators)
      .where(
        and(
          eq(boardCollaborators.board_id, boardId),
          eq(boardCollaborators.user_id, userId),
        ),
      )
      .limit(1);

    if (collab) {
      return {
        hasAccess: true,
        canEdit: collab.permission === 'edit',
        locked,
      };
    }

    return deny;
  }

  fastify.get('/ws', { websocket: true }, async (socket, request) => {
    // Authenticate via session cookie
    const sessionId = request.cookies?.session;
    if (!sessionId) {
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
      socket.close(4001, 'Invalid or expired session');
      return;
    }

    const userId = row.user.id;
    const orgId = row.user.org_id;
    const displayName = row.user.display_name;

    // Wave E.F: role is resolved from the user's org-scope group membership.
    const [roleRow] = await db
      .select({ legacy_role: permissionGroups.legacy_role })
      .from(accountGroupMemberships)
      .innerJoin(permissionGroups, eq(permissionGroups.id, accountGroupMemberships.group_id))
      .where(
        and(
          eq(accountGroupMemberships.user_id, userId),
          eq(accountGroupMemberships.scope_type, 'org'),
          eq(accountGroupMemberships.scope_id, orgId),
        ),
      )
      .limit(1);
    const userRole = roleRow?.legacy_role ?? 'member';

    const ROLE_HIERARCHY = ['viewer', 'member', 'admin', 'owner'] as const;
    const roleIdx = ROLE_HIERARCHY.indexOf(userRole as (typeof ROLE_HIERARCHY)[number]);
    const isAdminOrOwner = row.user.is_superuser || roleIdx >= 2;

    const client: ConnectedClient = {
      ws: socket,
      userId,
      orgId,
      boardId: null,
      displayName,
      color: CURSOR_COLORS[0]!,
      canEdit: false,
      isAdminOrOwner,
      msgCount: 0,
      msgWindowStart: Date.now(),
    };
    clients.set(socket, client);

    // Send connected confirmation
    socket.send(
      JSON.stringify({
        type: 'connected',
        data: { user_id: userId, org_id: orgId },
        timestamp: new Date().toISOString(),
      }),
    );

    socket.on('message', async (raw: Buffer | string) => {
      // Per-client WebSocket rate limiting
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

      try {
        const msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString());

        switch (msg.type) {
          case 'join_board': {
            const boardId = msg.boardId as string;
            if (!boardId) break;

            // Validate access and determine edit permissions
            let canEdit: boolean;
            if (row.user.is_superuser) {
              canEdit = true;
            } else {
              const access = await checkBoardAccess(boardId, userId, orgId, userRole);
              if (!access.hasAccess) {
                socket.send(
                  JSON.stringify({
                    type: 'error',
                    data: { code: 'FORBIDDEN', message: 'No access to this board' },
                    timestamp: new Date().toISOString(),
                  }),
                );
                break;
              }
              canEdit = access.canEdit;
            }
            client.canEdit = canEdit;

            // Leave previous board if any
            if (client.boardId && client.boardId !== boardId) {
              const oldBoardId = client.boardId;
              client.boardId = null;
              const leftMsg = JSON.stringify({
                type: 'user_left',
                data: { id: userId },
                timestamp: new Date().toISOString(),
              });
              broadcastToRoom(oldBoardId, leftMsg);
              await publishEvent(oldBoardId, {
                type: 'user_left',
                data: { id: userId },
                timestamp: new Date().toISOString(),
              });
              // Best-effort persist if this was the last person in the
              // OLD room (the one this client just left). Cross-replica
              // safe via the flush lock.
              await maybeFlushOnRoomEmpty(oldBoardId);
            }

            // Assign color and join room
            client.boardId = boardId;
            client.color = assignColor(boardId);

            fastify.log.info({ boardId, userId, instanceId }, 'User joined board');

            // Send room_state to the joining user
            const collaborators = getCollaboratorsInRoom(boardId);
            socket.send(
              JSON.stringify({
                type: 'room_state',
                data: { collaborators },
                timestamp: new Date().toISOString(),
              }),
            );

            // Reconnect-window replay: if the client tells us its
            // last_seen_seq (the stream id of the last scene_update it
            // observed), resend everything that happened after it. This
            // is the missing piece that closes the "edits during
            // reconnect gap silently dropped" hole — works the same
            // whether the reconnecting client lands on the same replica
            // or a different one, because the stream lives in Redis.
            const lastSeenSeq: string | null =
              typeof msg.last_seen_seq === 'string' ? msg.last_seen_seq : null;
            if (lastSeenSeq) {
              const replay = await state.readEventsSince(boardId, lastSeenSeq);
              if (replay.length > 0) {
                socket.send(
                  JSON.stringify({
                    type: 'replay',
                    data: { events: replay.map((r) => ({ ...r.event, seq: r.id })) },
                    timestamp: new Date().toISOString(),
                  }),
                );
              }
            }

            // Broadcast user_joined to others
            const joinedMsg = JSON.stringify({
              type: 'user_joined',
              data: { id: userId, name: displayName, color: client.color },
              timestamp: new Date().toISOString(),
            });
            broadcastToRoom(boardId, joinedMsg, socket);
            await publishEvent(boardId, {
              type: 'user_joined',
              data: { id: userId, name: displayName, color: client.color },
              timestamp: new Date().toISOString(),
            });
            break;
          }

          case 'scene_update': {
            if (!client.boardId) break;

            // Reject scene updates from view-only collaborators
            if (!client.canEdit) {
              socket.send(
                JSON.stringify({
                  type: 'error',
                  data: { code: 'FORBIDDEN', message: 'You do not have edit permission on this board' },
                  timestamp: new Date().toISOString(),
                }),
              );
              break;
            }

            // Reject scene updates on locked boards unless user is admin/owner
            // We re-check lock status from DB to avoid stale cached state
            {
              const [currentBoard] = await db
                .select({ locked: boards.locked })
                .from(boards)
                .where(eq(boards.id, client.boardId))
                .limit(1);
              if (currentBoard?.locked && !client.isAdminOrOwner) {
                socket.send(
                  JSON.stringify({
                    type: 'error',
                    data: { code: 'FORBIDDEN', message: 'Board is locked. Only the owner or an admin can edit it.' },
                    timestamp: new Date().toISOString(),
                  }),
                );
                break;
              }
            }

            const elements = msg.elements;
            if (!Array.isArray(elements)) break;

            // Reject oversized scene updates to prevent DoS
            if (elements.length > 50000) {
              socket.send(
                JSON.stringify({
                  type: 'error',
                  data: { code: 'PAYLOAD_TOO_LARGE', message: 'Scene update exceeds maximum element count (50000)' },
                  timestamp: new Date().toISOString(),
                }),
              );
              break;
            }

            // Element count limit enforcement (design section 10).
            // Count non-deleted elements only.
            const liveCount = elements.filter(
              (e: Record<string, unknown>) => e && e.isDeleted !== true,
            ).length;

            if (liveCount > BOARD_ELEMENT_HARD_LIMIT) {
              socket.send(
                JSON.stringify({
                  type: 'error',
                  data: {
                    code: 'ELEMENT_LIMIT_EXCEEDED',
                    message: `Board has ${liveCount} elements, exceeding the hard limit of ${BOARD_ELEMENT_HARD_LIMIT}. Remove some elements before adding more.`,
                    limit: BOARD_ELEMENT_HARD_LIMIT,
                    current: liveCount,
                  },
                  timestamp: new Date().toISOString(),
                }),
              );
              break;
            }

            if (liveCount > BOARD_ELEMENT_SOFT_LIMIT) {
              // Warn the user but allow the save to proceed.
              socket.send(
                JSON.stringify({
                  type: 'warning',
                  data: {
                    code: 'ELEMENT_SOFT_LIMIT',
                    message: `Board has ${liveCount} elements (soft limit: ${BOARD_ELEMENT_SOFT_LIMIT}). Performance may degrade. Hard limit: ${BOARD_ELEMENT_HARD_LIMIT}.`,
                    limit: BOARD_ELEMENT_SOFT_LIMIT,
                    hard_limit: BOARD_ELEMENT_HARD_LIMIT,
                    current: liveCount,
                  },
                  timestamp: new Date().toISOString(),
                }),
              );
            }

            // Mark board as dirty for periodic persistence. Read the
            // existing entry from Redis so a concurrent replica's edits
            // to appState/files survive when this replica only sends
            // elements (Excalidraw's split between scene + appState
            // means cursors on the local debounce arrive separately).
            const existing = await state.takeDirty(client.boardId);
            await state.setDirty(client.boardId, {
              elements,
              appState: existing?.appState ?? {},
              files: existing?.files ?? {},
              orgId: client.orgId,
            });

            // Append to the per-board event stream so clients
            // reconnecting from a transient drop can replay everything
            // since their last_seen_seq instead of full-resyncing.
            // Then broadcast locally + publish to other replicas.
            const eventPayload = {
              type: 'scene_update',
              data: { elements, userId },
              timestamp: new Date().toISOString(),
            };
            const seq = await state.appendEvent(client.boardId, eventPayload);
            const updateMsg = JSON.stringify(seq ? { ...eventPayload, seq } : eventPayload);
            broadcastToRoom(client.boardId, updateMsg, socket);
            await publishEvent(client.boardId, seq ? { ...eventPayload, seq } : eventPayload);
            break;
          }

          case 'cursor_update': {
            if (!client.boardId) break;
            const { pointer, button, tool } = msg;
            if (!pointer || typeof pointer.x !== 'number' || typeof pointer.y !== 'number') break;

            const cursorMsg = JSON.stringify({
              type: 'cursor_update',
              data: {
                userId,
                pointer,
                button: button ?? 'up',
                tool: tool ?? 'pointer',
                color: client.color,
                username: displayName,
              },
              timestamp: new Date().toISOString(),
            });
            broadcastToRoom(client.boardId, cursorMsg, socket);
            // Cross-instance cursor sync. Previously skipped to save
            // bandwidth, but the user requirement is "deterministic on
            // any deployment shape" so cursors travel through Redis
            // pub/sub now too. The dedicated channel keeps this
            // high-volume traffic off the scene/presence channel.
            await publishCursor(client.boardId, {
              type: 'cursor_update',
              data: {
                userId,
                pointer,
                button: button ?? 'up',
                tool: tool ?? 'pointer',
                color: client.color,
                username: displayName,
              },
              timestamp: new Date().toISOString(),
            });
            break;
          }

          case 'ping': {
            socket.send(
              JSON.stringify({
                type: 'pong',
                timestamp: new Date().toISOString(),
              }),
            );
            break;
          }

          default:
            break;
        }
      } catch {
        fastify.log.warn('Invalid WebSocket message received');
      }
    });

    socket.on('close', async () => {
      const boardId = client.boardId;
      clients.delete(socket);

      if (boardId) {
        fastify.log.info({ boardId, userId, instanceId }, 'User left board (close)');
        const leftMsg = JSON.stringify({
          type: 'user_left',
          data: { id: userId },
          timestamp: new Date().toISOString(),
        });
        broadcastToRoom(boardId, leftMsg);
        await publishEvent(boardId, {
          type: 'user_left',
          data: { id: userId },
          timestamp: new Date().toISOString(),
        });
        // Cross-replica safe immediate persist if this was the last
        // collaborator. Closes the tab-close-mid-stroke window.
        await maybeFlushOnRoomEmpty(boardId);
      }
    });

    socket.on('error', () => {
      const boardId = client.boardId;
      clients.delete(socket);

      if (boardId) {
        fastify.log.warn({ boardId, userId, instanceId }, 'User left board (error)');
        const leftMsg = JSON.stringify({
          type: 'user_left',
          data: { id: userId },
          timestamp: new Date().toISOString(),
        });
        broadcastToRoom(boardId, leftMsg);
        // Best-effort flush on error path too — same reasoning.
        void maybeFlushOnRoomEmpty(boardId);
      }
    });
  });
}

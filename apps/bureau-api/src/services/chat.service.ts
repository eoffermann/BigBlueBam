/**
 * Bureau room chat service.
 *
 * Chats are scoped to a Bureau room identity (`room_key` — the surface id
 * presence/calls already use, or a spatial room id) and are EPHEMERAL BY
 * DEFAULT: every message gets `expires_at = created_at + retention_hours`
 * from its room's policy (24h default). Org admins / SuperUsers can extend
 * a thread's retention up to one week, or mark it retain-forever; both
 * recompute the expiry of every existing message so the whole thread moves
 * together. Reads ALWAYS filter expired rows — the worker sweep
 * (bureau-chat-expiry) is disk cleanup, not enforcement.
 *
 * Participation (`bureau_chat_participants`) is recorded when a user's
 * widget joins a room's chat channel; it is what entitles a user to
 * recover a thread later from the Bureau app.
 */
import { and, desc, eq, gt, ilike, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  bureauChatRooms,
  bureauChatMessages,
  bureauChatParticipants,
  users,
} from '../db/schema/index.js';

export const DEFAULT_RETENTION_HOURS = 24;
export const MAX_RETENTION_HOURS = 168; // one week
export const MAX_BODY_LENGTH = 2_000;
export const ROOM_KEY_RE = /^[a-zA-Z0-9_:-]{1,160}$/;

export interface ChatMessageRow {
  id: string;
  room_key: string;
  author_id: string | null;
  author_name: string;
  body: string;
  created_at: Date;
}

/** Clamp an admin-requested retention to the allowed window. */
export function clampRetentionHours(hours: number): number {
  if (!Number.isFinite(hours)) return DEFAULT_RETENTION_HOURS;
  return Math.min(Math.max(Math.round(hours), 1), MAX_RETENTION_HOURS);
}

/** Expiry for a message created `at`, under a room policy. */
export function computeExpiresAt(
  at: Date,
  retentionHours: number,
  retainForever: boolean,
): Date | null {
  if (retainForever) return null;
  return new Date(at.getTime() + clampRetentionHours(retentionHours) * 3_600_000);
}

/** Idempotent room upsert; refreshes label/app when provided. */
export async function upsertRoom(
  orgId: string,
  roomKey: string,
  label: string | null,
  app: string | null,
): Promise<void> {
  await db
    .insert(bureauChatRooms)
    .values({ org_id: orgId, room_key: roomKey, label, app })
    .onConflictDoUpdate({
      target: [bureauChatRooms.org_id, bureauChatRooms.room_key],
      set: {
        // Only overwrite with non-null values — a join from a page that
        // didn't resolve a label must not erase a good one.
        ...(label ? { label } : {}),
        ...(app ? { app } : {}),
        updated_at: new Date(),
      },
    });
}

export async function recordParticipant(
  orgId: string,
  roomKey: string,
  userId: string,
): Promise<void> {
  await db
    .insert(bureauChatParticipants)
    .values({ org_id: orgId, room_key: roomKey, user_id: userId })
    .onConflictDoUpdate({
      target: [
        bureauChatParticipants.org_id,
        bureauChatParticipants.room_key,
        bureauChatParticipants.user_id,
      ],
      set: { last_seen_at: new Date() },
    });
}

export async function isParticipant(
  orgId: string,
  roomKey: string,
  userId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ user_id: bureauChatParticipants.user_id })
    .from(bureauChatParticipants)
    .where(
      and(
        eq(bureauChatParticipants.org_id, orgId),
        eq(bureauChatParticipants.room_key, roomKey),
        eq(bureauChatParticipants.user_id, userId),
      ),
    )
    .limit(1);
  return !!row;
}

export async function insertMessage(
  orgId: string,
  roomKey: string,
  authorId: string,
  authorName: string,
  body: string,
): Promise<ChatMessageRow> {
  const [room] = await db
    .select({
      retention_hours: bureauChatRooms.retention_hours,
      retain_forever: bureauChatRooms.retain_forever,
    })
    .from(bureauChatRooms)
    .where(and(eq(bureauChatRooms.org_id, orgId), eq(bureauChatRooms.room_key, roomKey)))
    .limit(1);

  const now = new Date();
  const expiresAt = computeExpiresAt(
    now,
    room?.retention_hours ?? DEFAULT_RETENTION_HOURS,
    room?.retain_forever ?? false,
  );

  const [message] = await db
    .insert(bureauChatMessages)
    .values({
      org_id: orgId,
      room_key: roomKey,
      author_id: authorId,
      author_name: authorName,
      body,
      created_at: now,
      expires_at: expiresAt,
    })
    .returning({
      id: bureauChatMessages.id,
      room_key: bureauChatMessages.room_key,
      author_id: bureauChatMessages.author_id,
      author_name: bureauChatMessages.author_name,
      body: bureauChatMessages.body,
      created_at: bureauChatMessages.created_at,
    });

  await db
    .update(bureauChatRooms)
    .set({ last_message_at: now, updated_at: now })
    .where(and(eq(bureauChatRooms.org_id, orgId), eq(bureauChatRooms.room_key, roomKey)));

  return message!;
}

function notExpired() {
  return or(isNull(bureauChatMessages.expires_at), gt(bureauChatMessages.expires_at, new Date()));
}

/** Most recent unexpired messages, chronological order. */
export async function listRecentMessages(
  orgId: string,
  roomKey: string,
  limit = 50,
  before?: Date,
): Promise<ChatMessageRow[]> {
  const conditions = [
    eq(bureauChatMessages.org_id, orgId),
    eq(bureauChatMessages.room_key, roomKey),
    notExpired(),
  ];
  if (before) conditions.push(lt(bureauChatMessages.created_at, before));
  const rows = await db
    .select({
      id: bureauChatMessages.id,
      room_key: bureauChatMessages.room_key,
      author_id: bureauChatMessages.author_id,
      author_name: bureauChatMessages.author_name,
      body: bureauChatMessages.body,
      created_at: bureauChatMessages.created_at,
    })
    .from(bureauChatMessages)
    .where(and(...conditions))
    .orderBy(desc(bureauChatMessages.created_at))
    .limit(Math.min(limit, 200));
  return rows.reverse();
}

export interface ChatRoomSummary {
  room_key: string;
  label: string | null;
  app: string | null;
  retention_hours: number;
  retain_forever: boolean;
  last_message_at: Date | null;
  message_count: number;
}

/**
 * Rooms the user participated in, newest activity first, optionally
 * filtered by a search term matched against the room label OR any
 * unexpired message body. Rooms whose messages have all expired still
 * list (the thread happened) but show message_count 0.
 */
export async function listRoomsForUser(
  orgId: string,
  userId: string,
  search?: string,
  limit = 50,
): Promise<ChatRoomSummary[]> {
  const participations = await db
    .select({ room_key: bureauChatParticipants.room_key })
    .from(bureauChatParticipants)
    .where(
      and(
        eq(bureauChatParticipants.org_id, orgId),
        eq(bureauChatParticipants.user_id, userId),
      ),
    );
  const roomKeys = participations.map((p) => p.room_key);
  if (roomKeys.length === 0) return [];

  const term = search?.trim();
  let matchingKeys = roomKeys;
  if (term) {
    const pattern = `%${term.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    const labelMatches = await db
      .select({ room_key: bureauChatRooms.room_key })
      .from(bureauChatRooms)
      .where(
        and(
          eq(bureauChatRooms.org_id, orgId),
          inArray(bureauChatRooms.room_key, roomKeys),
          ilike(bureauChatRooms.label, pattern),
        ),
      );
    const bodyMatches = await db
      .selectDistinct({ room_key: bureauChatMessages.room_key })
      .from(bureauChatMessages)
      .where(
        and(
          eq(bureauChatMessages.org_id, orgId),
          inArray(bureauChatMessages.room_key, roomKeys),
          notExpired(),
          ilike(bureauChatMessages.body, pattern),
        ),
      );
    const merged = new Set<string>([
      ...labelMatches.map((r) => r.room_key),
      ...bodyMatches.map((r) => r.room_key),
    ]);
    matchingKeys = Array.from(merged);
    if (matchingKeys.length === 0) return [];
  }

  const rooms = await db
    .select({
      room_key: bureauChatRooms.room_key,
      label: bureauChatRooms.label,
      app: bureauChatRooms.app,
      retention_hours: bureauChatRooms.retention_hours,
      retain_forever: bureauChatRooms.retain_forever,
      last_message_at: bureauChatRooms.last_message_at,
      message_count: sql<number>`(
        SELECT count(*)::int FROM bureau_chat_messages m
        WHERE m.org_id = ${bureauChatRooms.org_id}
          AND m.room_key = ${bureauChatRooms.room_key}
          AND (m.expires_at IS NULL OR m.expires_at > now())
      )`,
    })
    .from(bureauChatRooms)
    .where(
      and(eq(bureauChatRooms.org_id, orgId), inArray(bureauChatRooms.room_key, matchingKeys)),
    )
    .orderBy(desc(bureauChatRooms.last_message_at))
    .limit(Math.min(limit, 100));
  return rooms;
}

/**
 * Admin retention update. Either a clamped hour count (1..168) or
 * retain-forever. Recomputes expires_at for every existing message so the
 * whole thread inherits the new policy.
 */
export async function setRetention(
  orgId: string,
  roomKey: string,
  opts: { retention_hours?: number; retain_forever?: boolean },
): Promise<{ retention_hours: number; retain_forever: boolean } | null> {
  const retainForever = opts.retain_forever === true;
  const hours = clampRetentionHours(opts.retention_hours ?? DEFAULT_RETENTION_HOURS);

  const [updated] = await db
    .update(bureauChatRooms)
    .set({
      retention_hours: hours,
      retain_forever: retainForever,
      updated_at: new Date(),
    })
    .where(and(eq(bureauChatRooms.org_id, orgId), eq(bureauChatRooms.room_key, roomKey)))
    .returning({
      retention_hours: bureauChatRooms.retention_hours,
      retain_forever: bureauChatRooms.retain_forever,
    });
  if (!updated) return null;

  if (retainForever) {
    await db
      .update(bureauChatMessages)
      .set({ expires_at: null })
      .where(
        and(eq(bureauChatMessages.org_id, orgId), eq(bureauChatMessages.room_key, roomKey)),
      );
  } else {
    await db
      .update(bureauChatMessages)
      .set({
        expires_at: sql`${bureauChatMessages.created_at} + make_interval(hours => ${hours})`,
      })
      .where(
        and(eq(bureauChatMessages.org_id, orgId), eq(bureauChatMessages.room_key, roomKey)),
      );
  }
  return updated;
}

/** Hydrate avatar URLs for transcript display (best effort). */
export async function loadAuthorAvatars(
  authorIds: string[],
): Promise<Map<string, string | null>> {
  const ids = Array.from(new Set(authorIds.filter(Boolean)));
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: users.id, avatar_url: users.avatar_url })
    .from(users)
    .where(inArray(users.id, ids));
  return new Map(rows.map((r) => [r.id, r.avatar_url]));
}

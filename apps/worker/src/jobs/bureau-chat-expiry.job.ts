/**
 * Bureau chat expiry sweep.
 *
 * Room chats are ephemeral by default: every message carries an
 * expires_at computed from its room's retention policy (24h default,
 * admin-extendable to one week, NULL = retained permanently). Reads
 * already filter expired rows, so this hourly sweep is pure disk
 * hygiene: hard-delete expired messages, then drop room rows whose
 * messages are all gone and whose last activity is older than the
 * maximum retention window (participants cascade with the room via FK
 * only on org/user delete — participant rows for swept rooms are
 * removed explicitly so the recovery list doesn't show empty husks).
 */

import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { sql } from 'drizzle-orm';
import { getDb } from '../utils/db.js';

export interface BureauChatExpiryJobData {
  /** Present for parity with other sweeps; unused. */
  organization_id?: string;
}

export async function processBureauChatExpiryJob(
  _job: Job<BureauChatExpiryJobData>,
  logger: Logger,
): Promise<void> {
  const db = getDb();

  const deletedMessages = await db.execute(sql`
    DELETE FROM bureau_chat_messages
    WHERE expires_at IS NOT NULL AND expires_at < now()
  `);

  // Rooms with no surviving messages, not marked retain-forever, and idle
  // past the longest possible retention window (one week) are husks.
  const deletedRooms = await db.execute(sql`
    DELETE FROM bureau_chat_rooms r
    WHERE r.retain_forever = false
      AND COALESCE(r.last_message_at, r.created_at) < now() - interval '8 days'
      AND NOT EXISTS (
        SELECT 1 FROM bureau_chat_messages m
        WHERE m.org_id = r.org_id AND m.room_key = r.room_key
      )
    RETURNING r.org_id, r.room_key
  `);

  const husks = (deletedRooms as unknown as { org_id: string; room_key: string }[]) ?? [];
  for (const husk of husks) {
    await db.execute(sql`
      DELETE FROM bureau_chat_participants
      WHERE org_id = ${husk.org_id} AND room_key = ${husk.room_key}
    `);
  }

  logger.info(
    {
      rooms_swept: husks.length,
      // postgres-js execute returns rows; count not exposed uniformly —
      // log presence rather than a number for messages.
      had_message_sweep: !!deletedMessages,
    },
    '[bureau-chat-expiry] sweep complete',
  );
}

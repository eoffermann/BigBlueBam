// Worker-side Banter system-bot poster.
//
// Posts a system/bot message into a Banter channel addressed by channel UUID.
// Mirrors apps/banter-api/src/services/activity-feed.ts (the BOT_USER_ID
// system author + is_system/is_bot flags) and the channel-counter bump +
// Redis realtime broadcast done by the banter-scheduled-post worker job.
//
// We post by channel UUID (not slug) because callers like the Blank form
// `notify_banter_channel_id` store a UUID. This avoids an HTTP round trip to
// banter-api and the INTERNAL_SERVICE_SECRET dependency — the worker already
// has DB + Redis access.

import { sql } from 'drizzle-orm';
import type Redis from 'ioredis';
import type { Logger } from 'pino';
import { getDb } from './db.js';

// System bot author, matching apps/banter-api/src/services/activity-feed.ts.
const BOT_USER_ID = '00000000-0000-0000-0000-000000000000';

function normaliseRows<T>(raw: unknown): T[] {
  return Array.isArray(raw)
    ? (raw as T[])
    : (((raw as { rows?: unknown[] })?.rows ?? []) as T[]);
}

export interface PostBanterChannelMessageInput {
  channelId: string;
  orgId: string;
  /** Markdown content. */
  content: string;
  metadata?: Record<string, unknown>;
}

/**
 * Insert a system message into a Banter channel by UUID, bump the channel's
 * denormalized counters, and broadcast a realtime message.created event.
 *
 * Returns the new message id on success, or null if the channel does not
 * exist / is archived / belongs to a different org (fail-soft: a notification
 * misconfiguration must never break the submission pipeline).
 */
export async function postBanterChannelMessage(
  redis: Redis,
  input: PostBanterChannelMessageInput,
  logger: Logger,
): Promise<string | null> {
  const db = getDb();

  // Confirm the channel exists, is not archived, and belongs to the org.
  const channelRaw = await db.execute(sql`
    SELECT id, org_id, is_archived
    FROM banter_channels
    WHERE id = ${input.channelId}
    LIMIT 1
  `);
  const [channel] = normaliseRows<{ id: string; org_id: string; is_archived: boolean }>(channelRaw);
  if (!channel || channel.is_archived || channel.org_id !== input.orgId) {
    logger.warn(
      { channelId: input.channelId, orgId: input.orgId },
      'banter-post: channel missing, archived, or org mismatch — skipping',
    );
    return null;
  }

  const contentPlain = input.content.replace(/<[^>]*>/g, '').slice(0, 500);

  const insertRaw = await db.execute(sql`
    INSERT INTO banter_messages
      (channel_id, author_id, content, content_plain, content_format,
       is_system, is_bot, metadata)
    VALUES (${input.channelId}, ${BOT_USER_ID}, ${input.content}, ${contentPlain},
            'markdown', true, true,
            ${JSON.stringify(input.metadata ?? {})}::jsonb)
    RETURNING id, created_at
  `);
  const [inserted] = normaliseRows<{ id: string; created_at: Date }>(insertRaw);
  if (!inserted) {
    logger.error({ channelId: input.channelId }, 'banter-post: insert returned no row');
    return null;
  }

  await db.execute(sql`
    UPDATE banter_channels
    SET last_message_at = NOW(),
        last_message_preview = ${contentPlain.slice(0, 200)},
        message_count = message_count + 1
    WHERE id = ${input.channelId}
  `);

  // Realtime broadcast so open WS clients see the message immediately.
  try {
    await redis.publish(
      'banter:events',
      JSON.stringify({
        room: `banter:channel:${input.channelId}`,
        event: {
          type: 'message.created',
          data: {
            message: {
              id: inserted.id,
              channel_id: input.channelId,
              author_id: BOT_USER_ID,
              content: input.content,
              content_plain: contentPlain,
              content_format: 'markdown',
              is_system: true,
              is_bot: true,
              created_at: inserted.created_at,
              author: { id: BOT_USER_ID, display_name: 'BigBlueBam Bot', avatar_url: null },
            },
          },
          timestamp: new Date().toISOString(),
        },
      }),
    );
  } catch {
    // Non-critical: WS clients pull via REST on reconnect.
  }

  return inserted.id;
}

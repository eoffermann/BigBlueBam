/**
 * Internal DM delivery — service-to-service "send a DM as a real user".
 *
 * Built for the Bureau leave-a-note flow (D-11): when a knock or ring is
 * blocked by DND, bureau-api POSTs /v1/internal/dm and the note lands in
 * the recipient's Banter DMs as a normal message from the visitor —
 * find-or-create the 1:1 DM channel, insert the message, bump channel
 * counters, broadcast message.created, and emit the standard 'dm'
 * notification. The channel find-or-create mirrors POST /v1/dm
 * (dm.routes.ts) so both paths converge on the same channel row.
 *
 * Unlike the activity-feed bot path this posts as `from_user_id` (a real
 * user, is_bot=false) — callers are trusted internal services that have
 * already authenticated the human on their side.
 */

import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  banterChannelMemberships,
  banterChannels,
  banterMessages,
  users,
} from '../db/schema/index.js';
import { broadcastToChannel } from './realtime.js';
import { dmDeepLink, emitNotification } from '../lib/notify.js';

export class InternalDmError extends Error {
  constructor(
    public code: 'INVALID_SENDER' | 'INVALID_RECIPIENT' | 'SELF_DM',
    message: string,
  ) {
    super(message);
    this.name = 'InternalDmError';
  }
}

export interface SendInternalDmArgs {
  org_id: string;
  from_user_id: string;
  to_user_id: string;
  content: string;
  /** Free-form origin tag stored on the message metadata (e.g. 'bureau-knock-note'). */
  source?: string;
}

interface ActiveOrgUser {
  id: string;
  display_name: string;
  avatar_url: string | null;
}

async function loadActiveOrgUser(
  userId: string,
  orgId: string,
): Promise<ActiveOrgUser | null> {
  const [row] = await db
    .select({
      id: users.id,
      display_name: users.display_name,
      avatar_url: users.avatar_url,
      is_active: users.is_active,
      org_id: users.org_id,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row || !row.is_active || row.org_id !== orgId) return null;
  return { id: row.id, display_name: row.display_name, avatar_url: row.avatar_url };
}

/** Find the existing 1:1 DM channel between two users, or create it. */
async function findOrCreateDmChannel(
  orgId: string,
  a: ActiveOrgUser,
  b: ActiveOrgUser,
): Promise<{ id: string }> {
  const aDms = await db
    .select({ channel_id: banterChannelMemberships.channel_id })
    .from(banterChannelMemberships)
    .where(eq(banterChannelMemberships.user_id, a.id))
    .innerJoin(
      banterChannels,
      and(
        eq(banterChannelMemberships.channel_id, banterChannels.id),
        eq(banterChannels.type, 'dm'),
        eq(banterChannels.org_id, orgId),
      ),
    );

  for (const dm of aDms) {
    const [other] = await db
      .select({ user_id: banterChannelMemberships.user_id })
      .from(banterChannelMemberships)
      .where(
        and(
          eq(banterChannelMemberships.channel_id, dm.channel_id),
          eq(banterChannelMemberships.user_id, b.id),
        ),
      )
      .limit(1);
    if (other) return { id: dm.channel_id };
  }

  // Same slug/name convention as POST /v1/dm so a later interactive open
  // resolves to this channel rather than creating a duplicate.
  const slug = `dm-${[a.id, b.id].sort().join('-')}`.slice(0, 80);
  const [channel] = await db
    .insert(banterChannels)
    .values({
      org_id: orgId,
      name: b.display_name,
      slug,
      type: 'dm',
      created_by: a.id,
      member_count: 2,
    })
    .returning({ id: banterChannels.id });
  if (!channel) {
    throw new Error('DM channel insert returned no row');
  }
  await db.insert(banterChannelMemberships).values([
    { channel_id: channel.id, user_id: a.id, role: 'member' as const },
    { channel_id: channel.id, user_id: b.id, role: 'member' as const },
  ]);
  return channel;
}

export async function sendInternalDm(
  args: SendInternalDmArgs,
): Promise<{ channel_id: string; message_id: string }> {
  if (args.from_user_id === args.to_user_id) {
    throw new InternalDmError('SELF_DM', 'Cannot DM yourself');
  }

  const sender = await loadActiveOrgUser(args.from_user_id, args.org_id);
  if (!sender) {
    throw new InternalDmError(
      'INVALID_SENDER',
      'Sender is not an active user of this org',
    );
  }
  const recipient = await loadActiveOrgUser(args.to_user_id, args.org_id);
  if (!recipient) {
    throw new InternalDmError(
      'INVALID_RECIPIENT',
      'Recipient is not an active user of this org',
    );
  }

  const channel = await findOrCreateDmChannel(args.org_id, sender, recipient);

  const contentPlain = args.content.replace(/<[^>]*>/g, '').slice(0, 500);
  const [message] = await db
    .insert(banterMessages)
    .values({
      channel_id: channel.id,
      author_id: sender.id,
      content: args.content,
      content_plain: contentPlain,
      content_format: 'markdown',
      is_system: false,
      is_bot: false,
      metadata: args.source ? { source: args.source } : {},
    })
    .returning();
  if (!message) {
    throw new Error('DM message insert returned no row');
  }

  await db
    .update(banterChannels)
    .set({
      last_message_at: new Date(),
      last_message_preview: contentPlain.slice(0, 200),
      message_count: sql`${banterChannels.message_count} + 1`,
    })
    .where(eq(banterChannels.id, channel.id));

  broadcastToChannel(channel.id, {
    type: 'message.created',
    data: {
      message: {
        ...message,
        author: {
          id: sender.id,
          display_name: sender.display_name,
          avatar_url: sender.avatar_url,
        },
      },
    },
    timestamp: new Date().toISOString(),
  });

  // Same notification the interactive DM path emits (message.routes.ts
  // "DM notifications" block) so the recipient's bell rings either way.
  await emitNotification({
    user_id: recipient.id,
    org_id: args.org_id,
    title: `New message from ${sender.display_name}`,
    body: contentPlain,
    category: 'dm',
    deep_link: dmDeepLink(channel.id, message.id),
    metadata: {
      channel_id: channel.id,
      message_id: message.id,
      ...(args.source ? { source: args.source } : {}),
    },
  });

  return { channel_id: channel.id, message_id: message.id };
}

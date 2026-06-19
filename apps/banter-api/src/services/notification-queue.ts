import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users } from '../db/schema/index.js';
import { env } from '../env.js';

let queue: Queue | null = null;

function getQueue(): Queue {
  if (!queue) {
    const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
    queue = new Queue('banter-notifications', { connection });
  }
  return queue;
}

export interface MentionNotification {
  type: 'banter-mention';
  mentioned_user_id: string;
  channel_id: string;
  channel_name: string;
  message_id: string;
  author_display_name: string;
  content_preview: string;
  org_id: string;
}

export interface DMNotification {
  type: 'banter-dm';
  recipient_user_id: string;
  channel_id: string;
  message_id: string;
  author_display_name: string;
  content_preview: string;
  org_id: string;
}

export interface ThreadReplyNotification {
  type: 'banter-thread-reply';
  thread_author_id: string;
  channel_id: string;
  channel_name: string;
  message_id: string;
  thread_parent_id: string;
  author_display_name: string;
  content_preview: string;
  org_id: string;
}

export interface ChannelInviteNotification {
  type: 'banter-channel-invite';
  invited_user_id: string;
  channel_id: string;
  channel_name: string;
  inviter_display_name: string;
  org_id: string;
}

type NotificationData =
  | MentionNotification
  | DMNotification
  | ThreadReplyNotification
  | ChannelInviteNotification;

export async function enqueueNotification(data: NotificationData): Promise<void> {
  try {
    await getQueue().add(data.type, data, {
      removeOnComplete: 100,
      removeOnFail: 500,
    });
  } catch {
    // Non-critical: don't fail the request if notification queueing fails
  }
}

/**
 * Extract @mention tokens from message content.
 *
 * The composer inserts a *handle* — the slugified display_name (lower-case,
 * whitespace collapsed to '-', non-[a-z0-9-] stripped), so "Jonas Grumby"
 * becomes `@jonas-grumby`. The old `@(\w+)` regex stopped at the first hyphen
 * (and at the space in the raw display_name), so multi-word names never
 * resolved. We match the same character class the canonical mention syntax
 * uses for users — `[a-zA-Z0-9_.-]` (`packages/shared/src/mention-syntax.ts`
 * `MENTION_PATTERNS.user`) — so handles, dotted GitHub-style names, and email
 * localparts are all captured whole.
 */
export function extractMentions(content: string): string[] {
  const matches = content.match(/@([a-zA-Z0-9_.-]+)/g);
  if (!matches) return [];
  return matches.map((m) => m.slice(1));
}

/**
 * Slugify a display_name into the canonical Banter handle.
 *
 * MUST stay in lockstep with the SQL slug used by `/v1/users/by-handle/:handle`
 * (apps/banter-api/src/routes/user.routes.ts) and the channel-member resolver
 * (channel.routes.ts): lower-case, collapse whitespace runs to a single '-',
 * then drop anything that is not [a-z0-9-]. This is the same transform the
 * composer applies before inserting `@handle`, so the round-trip
 * display_name → handle → user is stable.
 */
export function slugifyHandle(displayName: string): string {
  return displayName
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
}

export interface ResolvedMention {
  id: string;
  display_name: string;
  email: string;
}

/**
 * Resolve extracted @mention tokens to org users.
 *
 * A token resolves if it equals either:
 *   1. the slugified display_name (the handle the composer now inserts —
 *      `jonas-grumby`), OR
 *   2. the raw lower-cased display_name (back-compat: single-word names like
 *      `@Alex`, and messages posted before this fix that stored the raw name).
 *
 * A trailing `@domain` is stripped first, mirroring the resolver convention
 * (`packages/shared/src/mention-syntax.ts`) where `@jane@acme.com` falls back
 * to the email localpart.
 *
 * Returns at most one user per distinct token (the slug/display_name pairing
 * is unique enough for a 2-50 person team); duplicate tokens collapse.
 */
export async function resolveMentionsToUsers(
  orgId: string,
  rawTokens: string[],
): Promise<ResolvedMention[]> {
  if (rawTokens.length === 0) return [];

  // Normalise: strip a trailing @domain, then build both candidate keys.
  const slugKeys = new Set<string>();
  const nameKeys = new Set<string>();
  for (const raw of rawTokens) {
    const localPart = raw.includes('@') ? raw.slice(0, raw.indexOf('@')) : raw;
    if (!localPart) continue;
    slugKeys.add(localPart.toLowerCase());
    nameKeys.add(localPart.toLowerCase());
  }
  if (slugKeys.size === 0) return [];

  const slugArray = [...slugKeys];
  const nameArray = [...nameKeys];

  const rows = await db
    .select({
      id: users.id,
      display_name: users.display_name,
      email: users.email,
    })
    .from(users)
    .where(
      and(
        eq(users.org_id, orgId),
        sql`(
          regexp_replace(regexp_replace(lower(${users.display_name}), '\\s+', '-', 'g'), '[^a-z0-9-]', '', 'g') = ANY(${slugArray}::text[])
          OR lower(${users.display_name}) = ANY(${nameArray}::text[])
        )`,
      ),
    );

  // De-dupe by user id (a user could match both the slug and the raw forms).
  const byId = new Map<string, ResolvedMention>();
  for (const r of rows) byId.set(r.id, r);
  return [...byId.values()];
}

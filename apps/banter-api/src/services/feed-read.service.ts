import type Redis from 'ioredis';
import { and, eq, gte, isNull, inArray, sql } from 'drizzle-orm';
import { pgTable, uuid, varchar } from 'drizzle-orm/pg-core';
import { db } from '../db/index.js';
import {
  banterFeedEntries,
  banterFeedWeights,
  banterMessages,
  banterChannels,
  users,
} from '../db/schema/index.js';
import {
  effectiveWeights,
  weightsVersion,
  scoreEntry,
  RELATIONSHIP_FLAGS,
  INTERACTION_FLAGS,
  type FeedWeights,
  type ScoreBreakdown,
} from '@bigbluebam/shared';
import { channelDeepLink, threadDeepLink } from '../lib/notify.js';

/**
 * Feed read + ranking service (banter-feed-design-document.md §6).
 *
 * Scoring is computed at READ time from the current effective weights, so a
 * weight change takes effect on the next read with no recompute job. A bounded
 * candidate set (entries within the window, not dismissed) is scored and sorted
 * in memory; for a 2-50 person team that is a few hundred to low-thousands of
 * rows per user. A best-effort Redis cache (keyed by weights version + the
 * user's max seq) skips re-scoring within a short TTL; it degrades to fresh
 * scoring whenever Redis is unavailable or the key misses.
 */

const CANDIDATE_CEILING = 2000;
const CACHE_TTL_SECONDS = 60;

// Minimal peer-app stubs for cross-app hydration (Phase 5). banter-api does not
// declare the bam/brief Drizzle schema; these shadow the physical tables with
// only the columns the Feed displays. Same drift-safe pattern as the visibility
// service's peer-app-stubs. Keep columns minimal + in lockstep with the source.
const tasksStub = pgTable('tasks', {
  id: uuid('id').primaryKey(),
  title: varchar('title', { length: 500 }),
  // For the §80 ownership boosts: who it's assigned to / who created it.
  assignee_id: uuid('assignee_id'),
  reporter_id: uuid('reporter_id'),
});
const briefDocumentsStub = pgTable('brief_documents', {
  id: uuid('id').primaryKey(),
  title: varchar('title', { length: 500 }),
  slug: varchar('slug', { length: 255 }),
});

export interface FeedQueryOptions {
  limit?: number;
  cursor?: string | null;
  category?: string;
  source?: string;
  unseen?: boolean;
  explain?: boolean;
}

export interface EffectiveWeightsResult {
  weights: FeedWeights;
  version: number;
}

/** Load the merged platform+org weights and the composite cache version. */
export async function loadEffectiveWeights(orgId: string): Promise<EffectiveWeightsResult> {
  const rows = await db
    .select({
      scope: banterFeedWeights.scope,
      org_id: banterFeedWeights.org_id,
      weights: banterFeedWeights.weights,
      version: banterFeedWeights.version,
    })
    .from(banterFeedWeights)
    .where(
      sql`${banterFeedWeights.scope} = 'platform' OR (${banterFeedWeights.scope} = 'org' AND ${banterFeedWeights.org_id} = ${orgId})`,
    );

  const platform = rows.find((r) => r.scope === 'platform');
  const org = rows.find((r) => r.scope === 'org');
  const weights = effectiveWeights(
    (platform?.weights as Record<string, unknown> | undefined) ?? null,
    (org?.weights as Record<string, unknown> | undefined) ?? null,
  );
  const version = weightsVersion(platform?.version ?? 1, org?.version ?? 1);
  return { weights, version };
}

interface ScoredRef {
  id: string;
  score: number;
  category: string;
  source: string;
  entity_type: string;
  seen: boolean;
}

type CandidateRow = typeof banterFeedEntries.$inferSelect;

function scoreCandidates(
  rows: CandidateRow[],
  weights: FeedWeights,
  nowMs: number,
): ScoredRef[] {
  return rows
    .map((r) => ({
      ref: {
        id: r.id,
        score: scoreEntry(
          {
            category: r.category,
            published_at: r.published_at,
            last_activity_at: r.last_activity_at,
            relationship_flags: r.relationship_flags,
            interaction_flags: r.interaction_flags,
            engagement_count: r.engagement_count,
            seen_at: r.seen_at,
          },
          weights,
          nowMs,
        ).score,
        category: r.category,
        source: r.source,
        entity_type: r.entity_type,
        seen: r.seen_at != null,
      } satisfies ScoredRef,
    }))
    .map((x) => x.ref)
    .sort((a, b) => b.score - a.score);
}

function cacheKey(userId: string, version: number, lastSeq: number): string {
  return `bfeed:${userId}:${version}:${lastSeq}`;
}

/** Best-effort: the ordered scored refs for a user, from cache or freshly computed. */
async function getOrderedRefs(
  redis: Redis | undefined,
  userId: string,
  weights: FeedWeights,
  version: number,
  windowDays: number,
  nowMs: number,
): Promise<ScoredRef[]> {
  // Max seq among the user's live entries — bumps when the worker inserts a
  // new entry, which changes the cache key (automatic freshness on new content).
  const seqRows = await db
    .select({ max: sql<number>`COALESCE(MAX(${banterFeedEntries.seq}), 0)` })
    .from(banterFeedEntries)
    .where(and(eq(banterFeedEntries.user_id, userId), isNull(banterFeedEntries.dismissed_at)));
  const lastSeq = Number(seqRows[0]?.max ?? 0);
  const key = cacheKey(userId, version, lastSeq);

  if (redis) {
    try {
      const cached = await redis.get(key);
      if (cached) return JSON.parse(cached) as ScoredRef[];
    } catch {
      // Cache read failed — fall through to fresh scoring.
    }
  }

  const windowStart = new Date(nowMs - windowDays * 86_400_000);
  const rows = await db
    .select()
    .from(banterFeedEntries)
    .where(
      and(
        eq(banterFeedEntries.user_id, userId),
        isNull(banterFeedEntries.dismissed_at),
        gte(banterFeedEntries.last_activity_at, windowStart),
      ),
    )
    .limit(CANDIDATE_CEILING);

  // Compute the viewer's relevance boosts (mention/comment/assignee/author) on
  // this candidate set before scoring, so the boost tier ranks forward.
  await enrichBoostFlags(rows, userId);

  const refs = scoreCandidates(rows, weights, nowMs);

  if (redis) {
    try {
      await redis.set(key, JSON.stringify(refs), 'EX', CACHE_TTL_SECONDS);
    } catch {
      // Cache write failed — non-fatal.
    }
  }
  return refs;
}

/** Invalidate a user's cached feed ordering (after seen/dismiss). Best-effort. */
export async function bustFeedCache(redis: Redis | undefined, userId: string): Promise<void> {
  if (!redis) return;
  try {
    const pattern = `bfeed:${userId}:*`;
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = next;
      if (keys.length > 0) await redis.del(...keys);
    } while (cursor !== '0');
  } catch {
    // Non-fatal: the 60s TTL is the backstop.
  }
}

export interface HydratedFeedEntry {
  id: string;
  category: string;
  source: string;
  entity_type: string;
  entity_id: string;
  /** For thread entries, the thread-root message id; null when the entity IS the root. */
  root_entity_id: string | null;
  channel_id: string | null;
  channel_slug: string | null;
  project_id: string | null;
  published_at: Date;
  last_activity_at: Date;
  engagement_count: number;
  seen: boolean;
  score: number;
  /** Display fields hydrated from the owning app. */
  title: string;
  preview: string | null;
  author: { id: string; display_name: string; avatar_url: string | null } | null;
  deep_link: string;
  open_in_app: string | null;
  score_breakdown?: ScoreBreakdown;
}

/** How often an already-populated feed re-tops-up from all visible channels. */
const BACKFILL_THROTTLE_SECONDS = 180;

/**
 * Seed/top-up the candidate index from recent posts in every channel the user
 * can READ — public channels in their org (now org-readable) PLUS private
 * channels they belong to. This is what makes the feed "surface everything
 * visible" (the Facebook model: your feed is your sources' recent content). DMs
 * never feed (the DM view owns them). The followed/unfollowed subscription is
 * the opt-out: a per-channel (or source) unfollow/mute vetoes here, so channels
 * are followed by default but easy to drop. Idempotent (ON CONFLICT DO NOTHING).
 *
 * Gating — empty feeds ALWAYS run; populated feeds throttle:
 *  - Empty feed → always seed now, ignoring any flag. A stale flag must never
 *    keep an empty feed quiet (the bug the never-empty fix addressed). If the
 *    seed yields nothing (genuinely-empty org), a short flag avoids hammering
 *    but it self-heals the moment readable posts exist.
 *  - Populated feed → re-top-up at most once per BACKFILL_THROTTLE_SECONDS, so a
 *    newly-created public channel (or one the user joins) flows in with recent
 *    history within a few minutes, without an INSERT on every read.
 */
async function ensureVisibleBackfill(
  redis: Redis | undefined,
  userId: string,
  orgId: string,
  windowDays: number,
): Promise<void> {
  const flagKey = `bfeed:bf:${userId}`;

  // Is the feed already populated? Cheap indexed point lookup on user_id.
  const existing = await db
    .select({ one: sql<number>`1` })
    .from(banterFeedEntries)
    .where(eq(banterFeedEntries.user_id, userId))
    .limit(1);
  const isEmpty = existing.length === 0;

  // Populated feeds throttle the top-up; an empty feed always runs (never-empty).
  if (!isEmpty && redis) {
    try {
      if (await redis.get(flagKey)) return;
    } catch {
      // Redis unavailable — fall through (correctness over the throttle).
    }
  }

  try {
    // NB: compute the cutoff in SQL from the numeric windowDays. Passing a JS
    // Date param into a raw sql`` comparison binds it in a form the timestamptz
    // comparison silently rejects (matches nothing, no error).
    await db.execute(sql`
      INSERT INTO banter_feed_entries (
        org_id, user_id, category, entity_type, entity_id, source, channel_id,
        published_at, last_activity_at, relationship_flags, interaction_flags, engagement_count
      )
      SELECT
        bc.org_id, ${userId}, 'banter.channel_post', 'banter.message', m.id, 'banter', m.channel_id,
        m.created_at, COALESCE(m.last_reply_at, m.created_at),
        0, 0, COALESCE(m.reply_count, 0)
      FROM banter_messages m
      JOIN banter_channels bc ON bc.id = m.channel_id
      WHERE m.created_at >= now() - (${windowDays} * interval '1 day')
        AND m.is_deleted = false
        AND m.thread_parent_id IS NULL
        AND m.author_id <> ${userId}
        AND bc.is_archived = false
        AND bc.type IN ('public', 'private')
        AND (
          -- public channels are org-readable → surface to any org member
          (bc.type = 'public' AND bc.org_id = ${orgId})
          -- private channels only to members
          OR EXISTS (
            SELECT 1 FROM banter_channel_memberships mem
             WHERE mem.channel_id = m.channel_id AND mem.user_id = ${userId}
          )
        )
        AND NOT EXISTS (
          SELECT 1 FROM banter_feed_subscriptions s
           WHERE s.user_id = ${userId}
             AND s.scope_type = 'channel'
             AND s.scope_source = 'banter'
             AND s.scope_id = m.channel_id
             AND s.state IN ('muted', 'unfollowed')
        )
      ON CONFLICT (user_id, entity_type, entity_id) DO NOTHING
    `);
  } catch {
    // Best-effort: a backfill failure must not break the feed read.
  }

  if (redis) {
    try {
      // Empty: short TTL so an empty org self-heals fast once posts appear.
      // Populated: the throttle window for the next visible-channel top-up.
      await redis.set(flagKey, '1', 'EX', isEmpty ? 60 : BACKFILL_THROTTLE_SECONDS);
    } catch {
      // Non-fatal.
    }
  }
}

// ---------------------------------------------------------------------------
// Read-time boost enrichment (§80) — compute the viewer-specific relevance
// flags for the candidate page so the boosts the user asked for actually rank
// forward. Done at READ time (not stored at write time) so "I already commented
// in this thread" stays correct as the viewer interacts; the 60s ordering cache
// bounds how long a brand-new interaction takes to re-rank.
// ---------------------------------------------------------------------------
async function enrichBoostFlags(rows: CandidateRow[], userId: string): Promise<void> {
  // Best-effort: the boosts are an enhancement to ordering, so a failure here
  // must degrade to "no boost this read", never break the feed read itself.
  try {
  // (1) Banter threads the viewer has already replied in → COMMENTED +
  //     COMMENTER. reply_user_ids is the denormalized set of repliers on the
  //     thread-root message, so membership in it is exactly "I commented here".
  const msgIds = rows
    .filter((r) => r.entity_type === 'banter.message')
    .map((r) => r.entity_id);
  if (msgIds.length > 0) {
    // Fetch the repliers array and test membership in JS. A SQL
    // `${userId}::uuid = ANY(col)` bound-param form silently matches nothing
    // under postgres.js (the array/param-cast gotcha), so do the check here.
    const msgs = await db
      .select({ id: banterMessages.id, repliers: banterMessages.reply_user_ids })
      .from(banterMessages)
      .where(inArray(banterMessages.id, msgIds));
    const repliedSet = new Set(
      msgs.filter((m) => Array.isArray(m.repliers) && m.repliers.includes(userId)).map((m) => m.id),
    );
    if (repliedSet.size > 0) {
      for (const r of rows) {
        if (r.entity_type === 'banter.message' && repliedSet.has(r.entity_id)) {
          r.relationship_flags |= RELATIONSHIP_FLAGS.COMMENTER;
          r.interaction_flags |= INTERACTION_FLAGS.COMMENTED;
        }
      }
    }
  }

  // (2) Bam tasks the viewer owns → ASSIGNEE (assigned to me) and/or AUTHOR +
  //     AUTHORED (I created it).
  const taskIds = rows
    .filter((r) => r.entity_type === 'bam.task')
    .map((r) => r.entity_id);
  if (taskIds.length > 0) {
    const owned = await db
      .select({
        id: tasksStub.id,
        assignee_id: tasksStub.assignee_id,
        reporter_id: tasksStub.reporter_id,
      })
      .from(tasksStub)
      .where(inArray(tasksStub.id, taskIds));
    const byId = new Map(owned.map((t) => [t.id, t]));
    for (const r of rows) {
      if (r.entity_type !== 'bam.task') continue;
      const t = byId.get(r.entity_id);
      if (!t) continue;
      if (t.assignee_id === userId) r.relationship_flags |= RELATIONSHIP_FLAGS.ASSIGNEE;
      if (t.reporter_id === userId) {
        r.relationship_flags |= RELATIONSHIP_FLAGS.AUTHOR;
        r.interaction_flags |= INTERACTION_FLAGS.AUTHORED;
      }
    }
  }
  } catch {
    // Non-fatal — leave the stored flags as-is for this read.
  }
}

/** The ranked, hydrated feed page for a user. */
export async function getRankedFeed(
  redis: Redis | undefined,
  userId: string,
  orgId: string,
  opts: FeedQueryOptions,
  nowMs: number,
): Promise<{ data: HydratedFeedEntry[]; next_cursor: string | null }> {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  const offset = opts.cursor ? Math.max(0, parseInt(opts.cursor, 10) || 0) : 0;

  const { weights, version } = await loadEffectiveWeights(orgId);

  // Surface-everything-visible + never-empty (§10.3): seed/top-up the per-user
  // index from recent posts in every channel this user can SEE (joined + public),
  // so the feed shows relevant activity instantly — for brand-new users and for
  // content that predates the live fan-in.
  await ensureVisibleBackfill(redis, userId, orgId, weights.candidate_window_days);

  const ordered = await getOrderedRefs(
    redis,
    userId,
    weights,
    version,
    weights.candidate_window_days,
    nowMs,
  );

  // Filter (category/source/unseen) on the ordered list, then paginate.
  const filtered = ordered.filter((r) => {
    if (opts.category && r.category !== opts.category) return false;
    if (opts.source && r.source !== opts.source) return false;
    if (opts.unseen && r.seen) return false;
    return true;
  });

  const pageRefs = filtered.slice(offset, offset + limit);
  const nextCursor = offset + limit < filtered.length ? String(offset + limit) : null;
  if (pageRefs.length === 0) return { data: [], next_cursor: null };

  const scoreById = new Map(pageRefs.map((r) => [r.id, r.score]));
  const rows = await db
    .select()
    .from(banterFeedEntries)
    .where(inArray(banterFeedEntries.id, pageRefs.map((r) => r.id)));

  // Re-apply the read-time boosts on the page rows so the explain breakdown
  // matches the (already-boosted) ordering score; the boosts are computed in
  // memory, not stored, so this re-fetch would otherwise show stored flags = 0.
  await enrichBoostFlags(rows, userId);

  const hydrated = await hydrateEntries(rows, weights, nowMs, opts.explain ?? false, scoreById);
  // Preserve the ranked order (inArray does not guarantee it).
  const byId = new Map(hydrated.map((h) => [h.id, h]));
  const data = pageRefs.map((r) => byId.get(r.id)).filter((x): x is HydratedFeedEntry => !!x);
  return { data, next_cursor: nextCursor };
}

/**
 * Dry-run: re-score the caller's feed against a PROPOSED weight set without
 * persisting or caching. Powers the settings live-preview tuning loop (§9).
 */
export async function previewFeed(
  userId: string,
  proposedWeights: FeedWeights,
  nowMs: number,
  limit = 20,
): Promise<{ data: HydratedFeedEntry[] }> {
  const windowStart = new Date(nowMs - proposedWeights.candidate_window_days * 86_400_000);
  const rows = await db
    .select()
    .from(banterFeedEntries)
    .where(
      and(
        eq(banterFeedEntries.user_id, userId),
        isNull(banterFeedEntries.dismissed_at),
        gte(banterFeedEntries.last_activity_at, windowStart),
      ),
    )
    .limit(CANDIDATE_CEILING);

  const ordered = scoreCandidates(rows, proposedWeights, nowMs).slice(0, limit);
  if (ordered.length === 0) return { data: [] };
  const scoreById = new Map(ordered.map((r) => [r.id, r.score]));
  const pageRows = rows.filter((r) => scoreById.has(r.id));
  const hydrated = await hydrateEntries(pageRows, proposedWeights, nowMs, true, scoreById);
  const byId = new Map(hydrated.map((h) => [h.id, h]));
  return { data: ordered.map((r) => byId.get(r.id)).filter((x): x is HydratedFeedEntry => !!x) };
}

/** A single hydrated entry for the permalink view (GET /v1/feed/:id). */
export async function getFeedEntry(
  userId: string,
  entryId: string,
  orgId: string,
  explain: boolean,
  nowMs: number,
): Promise<HydratedFeedEntry | null> {
  const rows = await db
    .select()
    .from(banterFeedEntries)
    .where(and(eq(banterFeedEntries.id, entryId), eq(banterFeedEntries.user_id, userId)))
    .limit(1);
  if (rows.length === 0) return null;
  const { weights } = await loadEffectiveWeights(orgId);
  const [hydrated] = await hydrateEntries(rows, weights, nowMs, explain, null);
  return hydrated ?? null;
}

/** Mark entries seen by id list or by a seq watermark. */
export async function markSeen(
  userId: string,
  body: { entry_ids?: string[]; before_seq?: number },
): Promise<number> {
  const now = new Date();
  if (body.entry_ids && body.entry_ids.length > 0) {
    const res = await db
      .update(banterFeedEntries)
      .set({ seen_at: now, updated_at: now })
      .where(
        and(
          eq(banterFeedEntries.user_id, userId),
          inArray(banterFeedEntries.id, body.entry_ids),
          isNull(banterFeedEntries.seen_at),
        ),
      )
      .returning({ id: banterFeedEntries.id });
    return res.length;
  }
  if (typeof body.before_seq === 'number') {
    const res = await db
      .update(banterFeedEntries)
      .set({ seen_at: now, updated_at: now })
      .where(
        and(
          eq(banterFeedEntries.user_id, userId),
          sql`${banterFeedEntries.seq} <= ${body.before_seq}`,
          isNull(banterFeedEntries.seen_at),
        ),
      )
      .returning({ id: banterFeedEntries.id });
    return res.length;
  }
  return 0;
}

/** Dismiss a single entry (excluded from future reads). */
export async function dismissEntry(userId: string, entryId: string): Promise<boolean> {
  const now = new Date();
  const res = await db
    .update(banterFeedEntries)
    .set({ dismissed_at: now, updated_at: now })
    .where(and(eq(banterFeedEntries.id, entryId), eq(banterFeedEntries.user_id, userId)))
    .returning({ id: banterFeedEntries.id });
  return res.length > 0;
}

// ---------------------------------------------------------------------------
// Hydration — attach display fields from the owning app.
// ---------------------------------------------------------------------------
//
// Phase 4 surfaces Banter content only, so banter.message is hydrated richly
// (content preview + author + channel deep link). Other entity types get a
// generic title until their per-source hydrators land in Phase 5.

/** Bam task titles for cross-app feed entries, keyed by task id. */
async function fetchTaskTitles(rows: CandidateRow[]): Promise<Map<string, { title: string }>> {
  const ids = [...new Set(rows.filter((r) => r.entity_type === 'bam.task').map((r) => r.entity_id))];
  const out = new Map<string, { title: string }>();
  if (ids.length === 0) return out;
  const result = await db
    .select({ id: tasksStub.id, title: tasksStub.title })
    .from(tasksStub)
    .where(inArray(tasksStub.id, ids));
  for (const row of result) out.set(row.id, { title: row.title ?? 'Untitled' });
  return out;
}

/** Brief document titles + slugs for cross-app feed entries, keyed by doc id. */
async function fetchDocTitles(
  rows: CandidateRow[],
): Promise<Map<string, { title: string; slug?: string }>> {
  const ids = [...new Set(rows.filter((r) => r.entity_type === 'brief.document').map((r) => r.entity_id))];
  const out = new Map<string, { title: string; slug?: string }>();
  if (ids.length === 0) return out;
  const result = await db
    .select({ id: briefDocumentsStub.id, title: briefDocumentsStub.title, slug: briefDocumentsStub.slug })
    .from(briefDocumentsStub)
    .where(inArray(briefDocumentsStub.id, ids));
  for (const row of result) out.set(row.id, { title: row.title ?? 'Untitled', slug: row.slug ?? undefined });
  return out;
}

async function hydrateEntries(
  rows: CandidateRow[],
  weights: FeedWeights,
  nowMs: number,
  explain: boolean,
  scoreById: Map<string, number> | null,
): Promise<HydratedFeedEntry[]> {
  // Batch-load banter.message content + author + channel for message entries.
  const messageIds = rows
    .filter((r) => r.entity_type === 'banter.message')
    .map((r) => r.entity_id);

  const msgMap = new Map<
    string,
    {
      content_plain: string;
      thread_parent_id: string | null;
      author_id: string;
      author_name: string;
      author_avatar: string | null;
      channel_name: string;
      channel_slug: string;
    }
  >();

  if (messageIds.length > 0) {
    const msgRows = await db
      .select({
        id: banterMessages.id,
        content_plain: banterMessages.content_plain,
        thread_parent_id: banterMessages.thread_parent_id,
        author_id: banterMessages.author_id,
        author_name: users.display_name,
        author_avatar: users.avatar_url,
        channel_name: banterChannels.name,
        channel_slug: banterChannels.slug,
      })
      .from(banterMessages)
      .innerJoin(users, eq(users.id, banterMessages.author_id))
      .innerJoin(banterChannels, eq(banterChannels.id, banterMessages.channel_id))
      .where(inArray(banterMessages.id, messageIds));
    for (const m of msgRows) {
      msgMap.set(m.id, {
        content_plain: m.content_plain,
        thread_parent_id: m.thread_parent_id,
        author_id: m.author_id,
        author_name: m.author_name,
        author_avatar: m.author_avatar,
        channel_name: m.channel_name,
        channel_slug: m.channel_slug,
      });
    }
  }

  // Cross-app hydration (Phase 5). Other apps' entity types fall through to the
  // category label until their hydrators land.
  const taskTitles = await fetchTaskTitles(rows);
  const docTitles = await fetchDocTitles(rows);

  return rows.map((r): HydratedFeedEntry => {
    const breakdown = explain
      ? scoreEntry(
          {
            category: r.category,
            published_at: r.published_at,
            last_activity_at: r.last_activity_at,
            relationship_flags: r.relationship_flags,
            interaction_flags: r.interaction_flags,
            engagement_count: r.engagement_count,
            seen_at: r.seen_at,
          },
          weights,
          nowMs,
        )
      : undefined;

    let title = r.category;
    let preview: string | null = null;
    let author: HydratedFeedEntry['author'] = null;
    let channel_slug: string | null = null;
    // Every Feed entry's primary link is its permalink in the Feed (§12.2);
    // open_in_app is the secondary "jump to the source app" link.
    const deep_link = `/banter/feed/${r.id}`;
    let open_in_app: string | null = null;

    if (r.entity_type === 'banter.message') {
      const m = msgMap.get(r.entity_id);
      if (m) {
        channel_slug = m.channel_slug;
        author = { id: m.author_id, display_name: m.author_name, avatar_url: m.author_avatar };
        preview = m.content_plain;
        title =
          r.category === 'banter.mention'
            ? `${m.author_name} mentioned you in #${m.channel_name}`
            : r.category === 'banter.thread.reply'
              ? `${m.author_name} replied in #${m.channel_name}`
              : `${m.author_name} in #${m.channel_name}`;
        open_in_app = m.thread_parent_id
          ? threadDeepLink(m.channel_slug, m.thread_parent_id, r.entity_id)
          : channelDeepLink(m.channel_slug, r.entity_id);
      } else {
        title = 'Message (unavailable)';
      }
    } else if (r.entity_type === 'bam.task') {
      const t = taskTitles.get(r.entity_id);
      const name = t?.title ?? 'a task';
      title =
        r.category === 'bam.task.assigned_to_me'
          ? `Assigned to you: ${name}`
          : r.category === 'bam.task.comment_on_my_task'
            ? `New comment on: ${name}`
            : r.category === 'bam.task.state_changed'
              ? `Moved: ${name}`
              : name;
      open_in_app = `/b3/tasks/${r.entity_id}`;
    } else if (r.entity_type === 'brief.document') {
      const d = docTitles.get(r.entity_id);
      const name = d?.title ?? 'a document';
      title =
        r.category === 'brief.document.created'
          ? `New Brief: ${name}`
          : r.category === 'brief.document.edited'
            ? `Brief edited: ${name}`
            : name;
      open_in_app = `/brief/documents/${d?.slug ?? r.entity_id}`;
    }

    return {
      id: r.id,
      category: r.category,
      source: r.source,
      entity_type: r.entity_type,
      entity_id: r.entity_id,
      root_entity_id: r.root_entity_id,
      channel_id: r.channel_id,
      channel_slug,
      project_id: r.project_id,
      published_at: r.published_at,
      last_activity_at: r.last_activity_at,
      engagement_count: r.engagement_count,
      seen: r.seen_at != null,
      score: scoreById?.get(r.id) ?? breakdown?.score ?? 0,
      title,
      preview,
      author,
      deep_link,
      open_in_app,
      ...(breakdown ? { score_breakdown: breakdown } : {}),
    };
  });
}

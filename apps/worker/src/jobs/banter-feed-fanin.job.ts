// Banter Feed fan-in (docs/plans/banter-feed-design-document.md §10).
//
// Consumes one job per surfacing event (enqueued by banter-api, later other
// apps) and maintains the per-user candidate index banter_feed_entries:
//
//   1. Path A (direct): the producer resolves the direct recipients and their
//      per-user category + relationship flags (e.g. @mention → banter.mention).
//   2. Path B (broad): the worker enumerates the followers of the event's scope
//      (a channel's members for source=banter), category = broad_category.
//   3. Every candidate passes the §4.5 gate before an entry is written:
//        - can_access(user, entity_type, entity_id) — the §4.1 hard gate.
//        - resolveSubscriptionState — muted is the hard veto; broad recipients
//          additionally need 'following'.
//      Path A includes unless muted; Path B includes only when 'following' and
//      the category broad-surfaces.
//   4. Survivors are upserted (insert on first relevance; else bump
//      last_activity_at / engagement_count and OR the flag bitsets). seen_at /
//      dismissed_at are left untouched on re-activity so a seen item can sink
//      and resurface (§6.2) and a dismissed item stays gone.
//
// The read-path Redis cache + WS push (steps 5/6 of §10.2) and notification
// dispatch (§12) are wired in Phase 4 / Phase 6; this phase maintains the index.

import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { sql } from 'drizzle-orm';
import {
  categoryPolicy,
  notificationFires,
  feedOwnsNotification,
  resolveSubscriptionState,
  RELATIONSHIP_FLAGS,
  type BanterFeedFaninJobData,
  type EntityScopes,
  type FeedDirectRecipient,
  type FeedSubscriptionState,
  type SubscriptionRow,
} from '@bigbluebam/shared';
import { getDb } from '../utils/db.js';

export type { BanterFeedFaninJobData };

// Internal counters (exported for tests).
export const feedFaninCounters = {
  jobs: 0,
  direct_seen: 0,
  direct_upserted: 0,
  direct_dropped_access: 0,
  direct_dropped_muted: 0,
  broad_seen: 0,
  broad_upserted: 0,
  broad_dropped_access: 0,
  broad_dropped_not_following: 0,
  notifications_dispatched: 0,
};

export interface FeedFaninDeps {
  /** §4.1 hard gate: can this user see the entity? */
  canAccess: (userId: string, entityType: string, entityId: string) => Promise<boolean>;
  /** Effective subscription state for a user against the event's scopes. */
  resolveState: (userId: string, scopes: EntityScopes) => Promise<FeedSubscriptionState>;
  /** Enumerate broad (Path B) candidate user ids for a scope. */
  enumerateBroadCandidates: (
    scope: 'channel' | 'project' | 'source',
    scopeId: string | null,
    orgId: string,
  ) => Promise<string[]>;
  /** Upsert one feed entry for a (user, entity). Returns the entry id. */
  upsertEntry: (params: UpsertEntryParams) => Promise<string | null>;
  /** Write a unified-notification row (§12) deep-linking to the feed permalink. */
  dispatchNotification: (params: NotifyParams) => Promise<void>;
  logger: Logger;
}

interface NotifyParams {
  orgId: string;
  userId: string;
  category: string;
  source: string;
  entityType: string;
  entityId: string;
  entryId: string;
  title: string;
  body: string;
}

interface UpsertEntryParams {
  orgId: string;
  userId: string;
  category: string;
  entityType: string;
  entityId: string;
  rootEntityType: string | null;
  rootEntityId: string | null;
  source: string;
  channelId: string | null;
  projectId: string | null;
  publishedAt: string;
  lastActivityAt: string;
  relationshipFlags: number;
  engagementCount: number;
}

/**
 * Core handler — one fan-in event → zero-or-more upserted entries.
 * Exported for unit tests; production wiring lives in buildFeedFaninDeps.
 */
export async function handleFeedFanin(
  data: BanterFeedFaninJobData,
  deps: FeedFaninDeps,
): Promise<void> {
  feedFaninCounters.jobs += 1;

  const scopes: EntityScopes = {
    source: data.source,
    // For threads the item people mute is the thread root; else the entity.
    itemId: data.root_entity_id ?? data.entity_id,
    channelId: data.channel_id ?? null,
    projectId: data.project_id ?? null,
  };

  const actorId = data.actor_id ?? null;
  const engagementCount = data.engagement_count ?? 0;
  const handled = new Set<string>(); // user ids already given an entry this job

  // Unified-notification dispatch (§12). Fires only when the producer supplied
  // notification text, the category fires for this recipient kind, AND the Feed
  // owns the category's notification (legacy-owned categories are skipped to
  // avoid duplicate bell dings). Deep-links to the feed permalink (§12.2).
  const maybeNotify = async (
    userId: string,
    category: string,
    isDirect: boolean,
    entryId: string | null,
  ) => {
    if (!entryId || !data.notification_title) return;
    if (!feedOwnsNotification(category)) return;
    if (!notificationFires(category, isDirect)) return;
    try {
      await deps.dispatchNotification({
        orgId: data.org_id,
        userId,
        category,
        source: data.source,
        entityType: data.entity_type,
        entityId: data.entity_id,
        entryId,
        title: data.notification_title,
        body: data.notification_body ?? '',
      });
      feedFaninCounters.notifications_dispatched += 1;
    } catch (err) {
      deps.logger.warn({ err, userId, category }, 'feed-fanin: notification dispatch failed');
    }
  };

  // -------------------------------------------------------------------------
  // Path A — direct recipients (producer-resolved). Include unless muted.
  // -------------------------------------------------------------------------
  const direct = dedupeDirectRecipients(data.direct_recipients ?? []);
  for (const recipient of direct) {
    if (recipient.user_id === actorId) continue;
    feedFaninCounters.direct_seen += 1;

    let allowed = false;
    try {
      allowed = await deps.canAccess(recipient.user_id, data.entity_type, data.entity_id);
    } catch (err) {
      deps.logger.warn(
        { err, user_id: recipient.user_id, entity_id: data.entity_id },
        'feed-fanin: can_access threw for direct recipient; dropping',
      );
      feedFaninCounters.direct_dropped_access += 1;
      continue;
    }
    if (!allowed) {
      feedFaninCounters.direct_dropped_access += 1;
      continue;
    }

    const state = await deps.resolveState(recipient.user_id, scopes);
    if (state === 'muted') {
      feedFaninCounters.direct_dropped_muted += 1;
      continue;
    }

    const entryId = await deps.upsertEntry({
      orgId: data.org_id,
      userId: recipient.user_id,
      category: recipient.category,
      entityType: data.entity_type,
      entityId: data.entity_id,
      rootEntityType: data.root_entity_type ?? null,
      rootEntityId: data.root_entity_id ?? null,
      source: data.source,
      channelId: data.channel_id ?? null,
      projectId: data.project_id ?? null,
      publishedAt: data.published_at,
      lastActivityAt: data.last_activity_at,
      relationshipFlags: recipient.relationship_flags,
      engagementCount,
    });
    handled.add(recipient.user_id);
    feedFaninCounters.direct_upserted += 1;
    await maybeNotify(recipient.user_id, recipient.category, true, entryId);
  }

  // -------------------------------------------------------------------------
  // Path B — broad recipients (followers of the scope). Include only when the
  // category broad-surfaces AND the user's effective state is 'following'.
  // -------------------------------------------------------------------------
  const broadCategory = data.broad_category ?? null;
  const broadScope = data.broad_scope ?? null;
  if (broadCategory && broadScope && categoryPolicy(broadCategory).broad_surface) {
    const scopeId =
      broadScope === 'channel'
        ? (data.channel_id ?? null)
        : broadScope === 'project'
          ? (data.project_id ?? null)
          : null;
    const candidates = await deps.enumerateBroadCandidates(broadScope, scopeId, data.org_id);

    for (const userId of candidates) {
      if (userId === actorId || handled.has(userId)) continue;
      feedFaninCounters.broad_seen += 1;

      const state = await deps.resolveState(userId, scopes);
      if (state !== 'following') {
        feedFaninCounters.broad_dropped_not_following += 1;
        continue;
      }

      let allowed = false;
      try {
        allowed = await deps.canAccess(userId, data.entity_type, data.entity_id);
      } catch (err) {
        deps.logger.warn(
          { err, user_id: userId, entity_id: data.entity_id },
          'feed-fanin: can_access threw for broad recipient; dropping',
        );
        feedFaninCounters.broad_dropped_access += 1;
        continue;
      }
      if (!allowed) {
        feedFaninCounters.broad_dropped_access += 1;
        continue;
      }

      const entryId = await deps.upsertEntry({
        orgId: data.org_id,
        userId,
        category: broadCategory,
        entityType: data.entity_type,
        entityId: data.entity_id,
        rootEntityType: data.root_entity_type ?? null,
        rootEntityId: data.root_entity_id ?? null,
        source: data.source,
        channelId: data.channel_id ?? null,
        projectId: data.project_id ?? null,
        publishedAt: data.published_at,
        lastActivityAt: data.last_activity_at,
        relationshipFlags: 0,
        engagementCount,
      });
      handled.add(userId);
      feedFaninCounters.broad_upserted += 1;
      await maybeNotify(userId, broadCategory, false, entryId);
    }
  }
}

/**
 * Collapse duplicate direct recipients to one row per user, OR-ing the
 * relationship flags and keeping the strongest (lowest-index) category. A
 * mention outranks a thread-reply, so a mentioned thread participant lands as
 * banter.mention with both flags set.
 */
function dedupeDirectRecipients(recipients: FeedDirectRecipient[]): FeedDirectRecipient[] {
  const CATEGORY_RANK: Record<string, number> = {
    'approval.awaiting_me': 0,
    'banter.mention': 1,
    'mention.cross_app': 1,
    'banter.thread.reply': 2,
  };
  const byUser = new Map<string, FeedDirectRecipient>();
  for (const r of recipients) {
    const existing = byUser.get(r.user_id);
    if (!existing) {
      byUser.set(r.user_id, { ...r });
      continue;
    }
    existing.relationship_flags |= r.relationship_flags;
    const rankNew = CATEGORY_RANK[r.category] ?? 99;
    const rankOld = CATEGORY_RANK[existing.category] ?? 99;
    if (rankNew < rankOld) existing.category = r.category;
  }
  return [...byUser.values()];
}

// ---------------------------------------------------------------------------
// Production wiring: db queries, api preflight.
// ---------------------------------------------------------------------------

export function buildFeedFaninDeps(
  logger: Logger,
  opts: { apiInternalUrl: string; internalServiceSecret: string },
): FeedFaninDeps {
  return {
    async canAccess(userId, entityType, entityId) {
      try {
        // Internal service route (service-secret auth, flat result shape). The
        // public /v1/visibility/can_access requires a user session, which the
        // worker does not have.
        const res = await fetch(`${opts.apiInternalUrl}/internal/visibility/can-access`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Internal-Service-Secret': opts.internalServiceSecret,
          },
          body: JSON.stringify({
            asker_user_id: userId,
            entity_type: entityType,
            entity_id: entityId,
          }),
        });
        if (!res.ok) {
          logger.warn(
            { status: res.status, userId, entityType, entityId },
            'feed-fanin: can_access preflight non-ok; dropping',
          );
          return false;
        }
        const body = (await res.json()) as { allowed?: boolean };
        return body?.allowed === true;
      } catch (err) {
        logger.warn({ err, userId, entityType, entityId }, 'feed-fanin: can_access network error');
        return false;
      }
    },

    async resolveState(userId, scopes) {
      const db = getDb();
      const res = await db.execute(sql`
        SELECT scope_type, scope_source, scope_id, state
          FROM banter_feed_subscriptions
         WHERE user_id = ${userId}
      `);
      const rows = (Array.isArray(res) ? res : ((res as { rows?: unknown[] }).rows ?? [])) as SubscriptionRow[];
      return resolveSubscriptionState(rows, scopes);
    },

    async enumerateBroadCandidates(scope, scopeId, orgId) {
      const db = getDb();
      if (scope === 'channel') {
        if (!scopeId) return [];
        // Public channels are org-readable, so a public post is a Feed candidate
        // for EVERY org member (the followed/unfollowed subscription, applied by
        // the caller via resolveState, is the opt-out). Private channels fan in
        // to their members only.
        const res = await db.execute(sql`
          SELECT bcm.user_id
            FROM banter_channel_memberships bcm
           WHERE bcm.channel_id = ${scopeId}
          UNION
          SELECT om.user_id
            FROM organization_memberships om
            JOIN banter_channels bc ON bc.id = ${scopeId}
           WHERE bc.type = 'public' AND bc.is_archived = false AND om.org_id = bc.org_id
        `);
        return extractUserIds(res);
      }
      if (scope === 'project') {
        if (!scopeId) return [];
        const res = await db.execute(sql`
          SELECT user_id FROM project_memberships WHERE project_id = ${scopeId}
        `);
        return extractUserIds(res);
      }
      // 'source' — every member of the org follows by default. Cross-app
      // producers (Phase 5) exercise this; Banter only uses 'channel'.
      // NB: organization_memberships keys org on org_id (not organization_id).
      const res = await db.execute(sql`
        SELECT user_id FROM organization_memberships WHERE org_id = ${orgId}
      `);
      return extractUserIds(res);
    },

    async upsertEntry(p) {
      const db = getDb();
      const res = await db.execute(sql`
        INSERT INTO banter_feed_entries (
          org_id, user_id, category, entity_type, entity_id,
          root_entity_type, root_entity_id, source, channel_id, project_id,
          published_at, last_activity_at, relationship_flags, interaction_flags,
          engagement_count
        ) VALUES (
          ${p.orgId}, ${p.userId}, ${p.category}, ${p.entityType}, ${p.entityId},
          ${p.rootEntityType}, ${p.rootEntityId}, ${p.source}, ${p.channelId}, ${p.projectId},
          ${p.publishedAt}, ${p.lastActivityAt}, ${p.relationshipFlags}, 0,
          ${p.engagementCount}
        )
        ON CONFLICT (user_id, entity_type, entity_id) DO UPDATE SET
          last_activity_at = GREATEST(banter_feed_entries.last_activity_at, EXCLUDED.last_activity_at),
          engagement_count = EXCLUDED.engagement_count,
          relationship_flags = banter_feed_entries.relationship_flags | EXCLUDED.relationship_flags,
          updated_at = now()
        RETURNING id
      `);
      const rows = (Array.isArray(res) ? res : ((res as { rows?: unknown[] }).rows ?? [])) as Array<{
        id: string;
      }>;
      return rows[0]?.id ?? null;
    },

    async dispatchNotification(p) {
      const db = getDb();
      // Mirrors the columns banter-api's emitNotification writes; the bell
      // (NotificationsBell) already reads this table. metadata carries the
      // feed permalink target so a click lands on the feed entry (§12.2/§12.3).
      await db.execute(sql`
        INSERT INTO notifications (
          id, user_id, org_id, type, title, body,
          source_app, deep_link, category, metadata, is_read, created_at
        ) VALUES (
          gen_random_uuid(),
          ${p.userId},
          ${p.orgId},
          ${`feed.${p.category}`},
          ${p.title.slice(0, 500)},
          ${p.body.slice(0, 2000)},
          ${'banter'},
          ${`/banter/feed/${p.entryId}`},
          ${p.category},
          ${JSON.stringify({
            feed_entry_id: p.entryId,
            entity_type: p.entityType,
            entity_id: p.entityId,
          })}::jsonb,
          false,
          now()
        )
      `);
    },

    logger,
  };
}

/** BullMQ entry point — matches the worker.ts (job, env, logger) convention. */
export async function processBanterFeedFaninJob(
  job: Job<BanterFeedFaninJobData>,
  env: { API_INTERNAL_URL: string; INTERNAL_SERVICE_SECRET: string },
  logger: Logger,
): Promise<void> {
  const deps = buildFeedFaninDeps(logger, {
    apiInternalUrl: env.API_INTERNAL_URL,
    internalServiceSecret: env.INTERNAL_SERVICE_SECRET,
  });
  await handleFeedFanin(job.data, deps);
}

function extractUserIds(res: unknown): string[] {
  const rows = (Array.isArray(res) ? res : ((res as { rows?: unknown[] }).rows ?? [])) as Array<{
    user_id: string;
  }>;
  return rows.map((r) => r.user_id).filter((id): id is string => typeof id === 'string');
}

// Re-export so worker.ts can reference the flag constant if needed.
export { RELATIONSHIP_FLAGS };

import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { eq } from 'drizzle-orm';
import { env } from '../env.js';
import { db } from '../db/index.js';
import { briefCollaborators } from '../db/schema/index.js';
import {
  BANTER_FEED_FANIN_QUEUE,
  RELATIONSHIP_FLAGS,
  type BanterFeedFaninJobData,
  type FeedDirectRecipient,
} from '@bigbluebam/shared';

/**
 * Brief producer for the Banter Feed fan-in (banter-feed-design-document.md §10,
 * §11, Phase 5). Document create/edit enqueues a job; the worker resolves
 * project followers (Path B) and applies the gates. Fire-and-forget.
 */

let queue: Queue | null = null;

function getQueue(): Queue {
  if (!queue) {
    const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
    queue = new Queue(BANTER_FEED_FANIN_QUEUE, { connection });
  }
  return queue;
}

export async function enqueueFeedFanin(data: BanterFeedFaninJobData): Promise<void> {
  try {
    await getQueue().add('fanin', data, { removeOnComplete: 200, removeOnFail: 500 });
  } catch {
    // Non-critical relative to the document write.
  }
}

/**
 * Enqueue a fan-in for a Brief document event. Direct (Path A) recipients are
 * the creator plus any explicit collaborators; Path B surfaces to followers of
 * the linked project. The actor is left in — the worker excludes it.
 */
export async function feedFaninForDocument(opts: {
  docId: string;
  category: 'brief.document.created' | 'brief.document.edited';
  createdBy: string;
  actorId: string;
  orgId: string;
  projectId: string | null;
  includeCollaborators?: boolean;
  nowIso?: string;
}): Promise<void> {
  try {
    const byUser = new Map<string, FeedDirectRecipient>();
    const add = (userId: string | null | undefined, flag: number) => {
      if (!userId) return;
      const existing = byUser.get(userId);
      if (existing) existing.relationship_flags |= flag;
      else byUser.set(userId, { user_id: userId, relationship_flags: flag, category: opts.category });
    };

    add(opts.createdBy, RELATIONSHIP_FLAGS.AUTHOR);
    if (opts.includeCollaborators) {
      const collabs = await db
        .select({ user_id: briefCollaborators.user_id })
        .from(briefCollaborators)
        .where(eq(briefCollaborators.document_id, opts.docId));
      for (const c of collabs) add(c.user_id, RELATIONSHIP_FLAGS.AUTHOR);
    }

    const now = opts.nowIso ?? new Date().toISOString();
    await enqueueFeedFanin({
      entity_type: 'brief.document',
      entity_id: opts.docId,
      source: 'brief',
      org_id: opts.orgId,
      actor_id: opts.actorId,
      project_id: opts.projectId,
      published_at: now,
      last_activity_at: now,
      direct_recipients: [...byUser.values()],
      // Both create and edit broad-surface to project followers (§8).
      broad_category: opts.category,
      broad_scope: 'project',
    });
  } catch {
    // Non-critical.
  }
}

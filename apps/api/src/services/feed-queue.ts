import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { eq } from 'drizzle-orm';
import { env } from '../env.js';
import { db } from '../db/index.js';
import { tasks } from '../db/schema/tasks.js';
import { comments } from '../db/schema/comments.js';
import {
  BANTER_FEED_FANIN_QUEUE,
  RELATIONSHIP_FLAGS,
  type BanterFeedFaninJobData,
  type FeedDirectRecipient,
} from '@bigbluebam/shared';

/**
 * Bam producer for the Banter Feed fan-in (banter-feed-design-document.md §10,
 * §11, Phase 5). Bam task activity (assignment, comment, state change) enqueues
 * a job; the worker resolves followers (Path B) + applies the gates and upserts
 * banter_feed_entries. Fire-and-forget: never blocks the task mutation.
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
    // Non-critical relative to the task write.
  }
}

/**
 * Resolve the direct (Path A) recipients for a task event: assignee, reporter,
 * watchers, and (for comments) prior commenters. Deduped, flags OR-ed, all
 * carrying the given category. The actor is left in — the worker excludes it.
 */
async function resolveTaskDirectRecipients(
  taskId: string,
  category: string,
  includePriorCommenters: boolean,
): Promise<{ recipients: FeedDirectRecipient[]; org_id: string | null; project_id: string | null }> {
  const rows = await db
    .select({
      assignee_id: tasks.assignee_id,
      reporter_id: tasks.reporter_id,
      watchers: tasks.watchers,
      org_id: tasks.org_id,
      project_id: tasks.project_id,
    })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1);
  const task = rows[0];
  if (!task) return { recipients: [], org_id: null, project_id: null };

  const byUser = new Map<string, FeedDirectRecipient>();
  const add = (userId: string | null | undefined, flag: number) => {
    if (!userId) return;
    const existing = byUser.get(userId);
    if (existing) existing.relationship_flags |= flag;
    else byUser.set(userId, { user_id: userId, relationship_flags: flag, category });
  };

  add(task.assignee_id, RELATIONSHIP_FLAGS.ASSIGNEE);
  add(task.reporter_id, RELATIONSHIP_FLAGS.AUTHOR);
  for (const w of task.watchers ?? []) add(w, RELATIONSHIP_FLAGS.WATCHER);

  if (includePriorCommenters) {
    const priors = await db
      .select({ author_id: comments.author_id })
      .from(comments)
      .where(eq(comments.task_id, taskId));
    for (const p of priors) add(p.author_id, RELATIONSHIP_FLAGS.COMMENTER);
  }

  return {
    recipients: [...byUser.values()],
    org_id: task.org_id,
    project_id: task.project_id,
  };
}

/**
 * Enqueue a fan-in for a Bam task event, resolving concerned users from the
 * task row. `broad` controls Path B (followed-project surfacing).
 */
export async function feedFaninForTask(opts: {
  taskId: string;
  category: string;
  actorId?: string | null;
  orgId?: string | null;
  projectId?: string | null;
  includePriorCommenters?: boolean;
  broad?: boolean;
  nowIso?: string;
}): Promise<void> {
  try {
    const resolved = await resolveTaskDirectRecipients(
      opts.taskId,
      opts.category,
      opts.includePriorCommenters ?? false,
    );
    const orgId = opts.orgId ?? resolved.org_id;
    if (!orgId) return;
    const projectId = opts.projectId ?? resolved.project_id;
    const now = opts.nowIso ?? new Date().toISOString();

    await enqueueFeedFanin({
      entity_type: 'bam.task',
      entity_id: opts.taskId,
      source: 'bam',
      org_id: orgId,
      actor_id: opts.actorId ?? null,
      project_id: projectId,
      published_at: now,
      last_activity_at: now,
      direct_recipients: resolved.recipients,
      broad_category: opts.broad ? opts.category : null,
      broad_scope: opts.broad ? 'project' : null,
    });
  } catch {
    // Non-critical.
  }
}

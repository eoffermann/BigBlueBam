import { eq, and, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { githubPrEvents, taskGithubRefs } from '../db/schema/github-integrations.js';
import { projects } from '../db/schema/projects.js';
import { tasks } from '../db/schema/tasks.js';
import { parseTaskRefs, decidePrTransition, buildPrEventRow } from './github-integration.service.js';
import { logActivity } from './activity.service.js';

/**
 * Processing of one VERIFIED GitHub delivery (push, pull_request, pull_request_review):
 * the github_pr_events append (Bastion change evidence, spec 3.1/8.4) and the Bam task
 * linking / phase transition.
 *
 * Two callers, one implementation (issue #186):
 *   - POST /webhooks/github runs it inline right after the HMAC check;
 *   - when that inline attempt throws (a Postgres hiccup, a pool spike, a draining deploy),
 *     the route spools the delivery to the github-delivery-retry BullMQ queue and answers
 *     202, because GitHub never redelivers a failed delivery on its own. The worker job
 *     POSTs it back to POST /internal/github/deliveries/process, which calls this again,
 *     with exponential backoff until it lands.
 *
 * Every write is idempotent so a retry after a partial attempt is safe: the pr_events row
 * is unique on (repo, delivery id), task refs insert ON CONFLICT DO NOTHING and then only
 * bump status, and a phase transition is skipped when the task is already in the target.
 */

export type GithubDeliveryEvent = 'push' | 'pull_request' | 'pull_request_review';

export interface GithubDeliveryIntegration {
  id: string;
  project_id: string;
  repo_owner: string;
  repo_name: string;
  transition_on_pr_open_phase_id: string | null;
  transition_on_pr_merged_phase_id: string | null;
  created_by: string | null;
}

type PushCommit = {
  id: string;
  message: string;
  url: string;
  author?: { name?: string; username?: string };
};

type PushPayload = {
  commits?: PushCommit[];
};

type PullRequestPayload = {
  action?: string;
  pull_request?: {
    number?: number;
    title?: string;
    body?: string | null;
    html_url?: string;
    merged?: boolean;
    state?: string;
    user?: { login?: string };
  };
};

/**
 * Applies one delivery. `receivedAt` is when the webhook first arrived, so a retried
 * delivery that carries no event time falls back to its original receipt time (not the
 * replay time) for github_pr_events.occurred_at. Returns the number of
 * newly linked task refs. Throws on any database error (the caller decides whether to
 * spool or to fail the retry attempt).
 */
export async function processGithubDelivery(
  integration: GithubDeliveryIntegration,
  event: GithubDeliveryEvent,
  body: unknown,
  deliveryId: string | null,
  receivedAt: Date,
): Promise<number> {
  // Every pull_request and pull_request_review delivery is appended to github_pr_events
  // whatever its task mention, and before the task linking below.
  if (event === 'pull_request' || event === 'pull_request_review') {
    const [project] = await db
      .select({ org_id: projects.org_id })
      .from(projects)
      .where(eq(projects.id, integration.project_id))
      .limit(1);
    const row = project
      ? buildPrEventRow(event, body, {
          org_id: project.org_id,
          integration_id: integration.id,
          project_id: integration.project_id,
          repo_owner: integration.repo_owner,
          repo_name: integration.repo_name,
          delivery_id: deliveryId,
          now: receivedAt,
        })
      : null;
    if (row) {
      await db.insert(githubPrEvents).values(row).onConflictDoNothing();
    }
  }

  if (event === 'pull_request_review') return 0;

  let processed = 0;

  if (event === 'push') {
    const push = body as PushPayload;
    for (const commit of push.commits ?? []) {
      const refs = parseTaskRefs(commit.message);
      if (refs.length === 0) continue;

      const matched = await db
        .select({ id: tasks.id, human_id: tasks.human_id, project_id: tasks.project_id })
        .from(tasks)
        .where(and(eq(tasks.project_id, integration.project_id), inArray(tasks.human_id, refs)));

      for (const task of matched) {
        const inserted = await db
          .insert(taskGithubRefs)
          .values({
            task_id: task.id,
            ref_type: 'commit',
            ref_id: commit.id,
            ref_url: commit.url,
            ref_title: (commit.message ?? '').split('\n')[0]!.slice(0, 500),
            author_name: commit.author?.username ?? commit.author?.name ?? null,
            status: null,
          })
          .onConflictDoNothing()
          .returning();
        if (inserted.length > 0) {
          processed += 1;
          await logActivity(task.project_id, integration.created_by ?? task.id, 'github.commit_linked', task.id, {
            sha: commit.id,
            url: commit.url,
            title: inserted[0]!.ref_title,
          });
        }
      }
    }
  }

  if (event === 'pull_request') {
    const prEvt = body as PullRequestPayload;
    const pr = prEvt.pull_request;
    const action = prEvt.action;
    if (pr && pr.number !== undefined && pr.html_url) {
      const refs = parseTaskRefs(`${pr.title ?? ''}\n${pr.body ?? ''}`);
      const merged = action === 'closed' && pr.merged === true;
      const prStatus = merged ? 'merged' : pr.state === 'closed' ? 'closed' : 'open';

      if (refs.length > 0) {
        const matched = await db
          .select({ id: tasks.id, human_id: tasks.human_id, project_id: tasks.project_id, phase_id: tasks.phase_id })
          .from(tasks)
          .where(and(eq(tasks.project_id, integration.project_id), inArray(tasks.human_id, refs)));

        for (const task of matched) {
          // Upsert: on first link, create the row; on subsequent events for the same PR, bump
          // the status field instead of inserting a duplicate (the unique constraint would
          // reject a plain insert on replay).
          const inserted = await db
            .insert(taskGithubRefs)
            .values({
              task_id: task.id,
              ref_type: 'pull_request',
              ref_id: String(pr.number),
              ref_url: pr.html_url,
              ref_title: pr.title ?? null,
              author_name: pr.user?.login ?? null,
              status: prStatus,
            })
            .onConflictDoNothing()
            .returning();

          if (inserted.length === 0) {
            await db
              .update(taskGithubRefs)
              .set({ status: prStatus })
              .where(
                and(
                  eq(taskGithubRefs.task_id, task.id),
                  eq(taskGithubRefs.ref_type, 'pull_request'),
                  eq(taskGithubRefs.ref_id, String(pr.number)),
                ),
              );
          } else {
            processed += 1;
          }

          // Optional phase transitions. Guarded on configuration: if the admin hasn't picked
          // a target phase, we skip.
          const transitionTo = decidePrTransition(action, merged, {
            transition_on_pr_open_phase_id: integration.transition_on_pr_open_phase_id,
            transition_on_pr_merged_phase_id: integration.transition_on_pr_merged_phase_id,
          });
          if (transitionTo && task.phase_id !== transitionTo) {
            await db
              .update(tasks)
              .set({ phase_id: transitionTo, updated_at: new Date() })
              .where(eq(tasks.id, task.id));
            await logActivity(task.project_id, integration.created_by ?? task.id, 'github.pr_transition', task.id, {
              pr_number: pr.number,
              pr_url: pr.html_url,
              from_phase: task.phase_id,
              to_phase: transitionTo,
              trigger: merged ? 'merged' : 'opened',
            });
          } else {
            await logActivity(task.project_id, integration.created_by ?? task.id, 'github.pr_linked', task.id, {
              pr_number: pr.number,
              pr_url: pr.html_url,
              status: prStatus,
            });
          }
        }
      }
    }
  }

  return processed;
}

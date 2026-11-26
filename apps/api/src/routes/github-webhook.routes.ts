import type { FastifyInstance, FastifyRequest } from 'fastify';
import { eq, and, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  githubIntegrations,
  githubPrEvents,
  taskGithubRefs,
} from '../db/schema/github-integrations.js';
import { projects } from '../db/schema/projects.js';
import { tasks } from '../db/schema/tasks.js';
import {
  parseTaskRefs,
  verifyGithubSignature,
  decidePrTransition,
  extractHookEvents,
  buildPrEventRow,
} from '../services/github-integration.service.js';
import { logActivity } from '../services/activity.service.js';

/**
 * Phase 6: GitHub → Bam webhook ingest.
 *
 * GitHub POSTs events here with an X-Hub-Signature-256 header we must
 * verify using the per-integration webhook_secret BEFORE parsing or
 * trusting any field in the body. The content-type parser below keeps
 * the raw body around so HMAC verification sees the exact bytes GitHub
 * signed (re-serializing JSON would break the signature).
 *
 * We act on these event types:
 *   - ping                → store hook.events in github_integrations.subscribed_events
 *   - push                → parse commit messages, link to tasks
 *   - pull_request        → append to github_pr_events; on opened/merged, link +
 *                           optionally transition
 *   - pull_request_review → append to github_pr_events (Bastion change evidence)
 *
 * Anything else returns 204 (we acknowledge, but didn't do anything).
 */

type PushCommit = {
  id: string;
  message: string;
  url: string;
  author?: { name?: string; username?: string };
};

type PushPayload = {
  repository?: { owner?: { login?: string; name?: string }; name?: string };
  commits?: PushCommit[];
};

type PullRequestPayload = {
  action?: string;
  repository?: { owner?: { login?: string; name?: string }; name?: string };
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

type RawBodyRequest = FastifyRequest & { rawBody?: Buffer };

export default async function githubWebhookRoutes(fastify: FastifyInstance) {
  // We need the raw body bytes for HMAC verification — Fastify's
  // default JSON parser consumes and discards them. Instead of
  // globally overriding 'application/json' (which would affect every
  // other route), we use a preParsing hook scoped to this one route
  // via a custom config flag. The hook intercepts the incoming stream,
  // buffers it, stashes the raw bytes on the request, and replaces
  // the request's body stream with a fresh Readable so Fastify's
  // JSON parser still runs normally downstream.
  const { Readable } = await import('node:stream');

  fastify.post(
    '/webhooks/github',
    {
      preParsing: async (request, _reply, payload) => {
        const chunks: Buffer[] = [];
        for await (const chunk of payload) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const raw = Buffer.concat(chunks);
        (request as RawBodyRequest).rawBody = raw;
        return Readable.from(raw);
      },
    },
    async (request, reply) => {
    const event = (request.headers['x-github-event'] as string | undefined) ?? '';
    const signature = request.headers['x-hub-signature-256'] as string | undefined;
    const rawBody = (request as RawBodyRequest).rawBody ?? Buffer.from('');

    // We act on push, pull_request and pull_request_review (the last only
    // to record it in github_pr_events for Bastion's change-management
    // evidence), and on ping (to store hook.events). Everything else
    // (issues, stars, etc.) gets a quiet 204.
    const actionable =
      event === 'push' || event === 'pull_request' || event === 'pull_request_review';
    if (!actionable && event !== 'ping') {
      return reply.status(204).send();
    }

    const body = request.body as PushPayload | PullRequestPayload;
    const owner = body?.repository?.owner?.login ?? body?.repository?.owner?.name;
    const repoName = body?.repository?.name;
    if (!owner || !repoName) {
      return reply.status(204).send();
    }

    const [integration] = await db
      .select()
      .from(githubIntegrations)
      .where(
        and(
          eq(githubIntegrations.repo_owner, owner),
          eq(githubIntegrations.repo_name, repoName),
        ),
      )
      .limit(1);

    if (!integration) {
      return reply.status(404).send({
        error: {
          code: 'NOT_FOUND',
          message: 'No GitHub integration configured for this repository',
          details: [],
          request_id: request.id,
        },
      });
    }

    // HMAC verification must happen AFTER we know the secret but
    // BEFORE we trust any field in the body. Using timingSafeEqual
    // inside verifyGithubSignature keeps this safe against timing
    // oracles.
    if (!verifyGithubSignature(rawBody, signature, integration.webhook_secret)) {
      return reply.status(401).send({
        error: {
          code: 'INVALID_SIGNATURE',
          message: 'Webhook signature verification failed',
          details: [],
          request_id: request.id,
        },
      });
    }

    // ping is the handshake. GitHub sends it when the webhook is created and
    // again on "Redeliver", carrying hook.events: the event list the webhook
    // is subscribed to. We store it (migration 0273) so Bastion can tell
    // "review events are not sent" apart from "unknown" (NULL).
    if (event === 'ping') {
      const events = extractHookEvents(request.body);
      if (events) {
        await db
          .update(githubIntegrations)
          .set({ subscribed_events: events, updated_at: new Date() })
          .where(eq(githubIntegrations.id, integration.id));
      }
      return reply.send({ data: { processed: 0, subscribed_events: events } });
    }

    if (!integration.enabled) {
      return reply.send({ data: { processed: 0 } });
    }

    // Every pull_request and pull_request_review delivery is appended to
    // github_pr_events whatever its task mention (Bastion spec 3.1/8.4), and
    // before the task linking below. A failed insert fails the delivery so
    // GitHub shows it as failed and "Redeliver" retries it; a redelivery of a
    // recorded delivery is a no-op (unique on repo + X-GitHub-Delivery).
    if (event === 'pull_request' || event === 'pull_request_review') {
      const [project] = await db
        .select({ org_id: projects.org_id })
        .from(projects)
        .where(eq(projects.id, integration.project_id))
        .limit(1);
      const deliveryHeader = request.headers['x-github-delivery'];
      const row = project
        ? buildPrEventRow(event, request.body, {
            org_id: project.org_id,
            integration_id: integration.id,
            project_id: integration.project_id,
            repo_owner: integration.repo_owner,
            repo_name: integration.repo_name,
            delivery_id: typeof deliveryHeader === 'string' ? deliveryHeader : null,
            now: new Date(),
          })
        : null;
      if (row) {
        await db.insert(githubPrEvents).values(row).onConflictDoNothing();
      }
    }

    if (event === 'pull_request_review') {
      return reply.send({ data: { processed: 0 } });
    }

    let processed = 0;

    if (event === 'push') {
      const push = body as PushPayload;
      for (const commit of push.commits ?? []) {
        const refs = parseTaskRefs(commit.message);
        if (refs.length === 0) continue;

        const matched = await db
          .select({ id: tasks.id, human_id: tasks.human_id, project_id: tasks.project_id })
          .from(tasks)
          .where(
            and(
              eq(tasks.project_id, integration.project_id),
              inArray(tasks.human_id, refs),
            ),
          );

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
            await logActivity(
              task.project_id,
              integration.created_by ?? task.id,
              'github.commit_linked',
              task.id,
              { sha: commit.id, url: commit.url, title: inserted[0]!.ref_title },
            );
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
            .where(
              and(
                eq(tasks.project_id, integration.project_id),
                inArray(tasks.human_id, refs),
              ),
            );

          for (const task of matched) {
            // Upsert: on first link, create the row; on subsequent
            // events for the same PR, bump the status field instead of
            // inserting a duplicate (the unique constraint would reject
            // a plain insert on replay).
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
              // Row already existed — just bump its status.
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

            // Optional phase transitions. Guarded on configuration:
            // if the admin hasn't picked a target phase, we skip.
            const transitionTo = decidePrTransition(action, merged, {
              transition_on_pr_open_phase_id: integration.transition_on_pr_open_phase_id,
              transition_on_pr_merged_phase_id: integration.transition_on_pr_merged_phase_id,
            });
            if (transitionTo && task.phase_id !== transitionTo) {
              await db
                .update(tasks)
                .set({ phase_id: transitionTo, updated_at: new Date() })
                .where(eq(tasks.id, task.id));
              await logActivity(
                task.project_id,
                integration.created_by ?? task.id,
                'github.pr_transition',
                task.id,
                {
                  pr_number: pr.number,
                  pr_url: pr.html_url,
                  from_phase: task.phase_id,
                  to_phase: transitionTo,
                  trigger: merged ? 'merged' : 'opened',
                },
              );
            } else {
              await logActivity(
                task.project_id,
                integration.created_by ?? task.id,
                'github.pr_linked',
                task.id,
                { pr_number: pr.number, pr_url: pr.html_url, status: prStatus },
              );
            }
          }
        }
      }
    }

    return reply.send({ data: { processed } });
  },
  );
}

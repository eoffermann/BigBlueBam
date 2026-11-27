import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { slackIntegrations } from '../db/schema/slack-integrations.js';
import { orgOfProject, type RlsOrgResolver } from '../lib/rls-org-scope.js';
import { tasks } from '../db/schema/tasks.js';
import { phases } from '../db/schema/phases.js';
import { taskStates } from '../db/schema/task-states.js';
import { users } from '../db/schema/users.js';

// ─────────────────────────────────────────────────────────────────────────
// Slack slash command handler
// ─────────────────────────────────────────────────────────────────────────
// Slack POSTs slash commands as application/x-www-form-urlencoded. We
// parse that content type inline since the API doesn't otherwise need it.
//
// Supported: `/bbb <TASK-REF>` — returns an ephemeral message with task
// summary (status, assignee). If the ref doesn't match, returns a "not
// found" ephemeral. If empty, returns usage.
//
// Verification: the `token` field is compared against the matching
// project's slack_integrations.slash_command_token when one is set. We
// look the token up by the token value itself (across all projects) since
// Slack doesn't tell us which Bam project the slash command is "from" —
// the token IS the scoping mechanism. Admins who leave the token blank
// accept commands from any workspace (fine for single-tenant setups).

interface SlackSlashBody {
  token?: string;
  team_id?: string;
  channel_id?: string;
  user_name?: string;
  user_id?: string;
  command?: string;
  text?: string;
  response_url?: string;
}

function ephemeral(text: string, attachments?: unknown[]) {
  const body: Record<string, unknown> = { response_type: 'ephemeral', text };
  if (attachments) body.attachments = attachments;
  return body;
}

export default async function slackWebhookRoutes(fastify: FastifyInstance) {
  // Slack posts x-www-form-urlencoded; register a parser scoped to this plugin.
  fastify.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, body, done) => {
      try {
        const params = new URLSearchParams(body as string);
        const obj: Record<string, string> = {};
        for (const [k, v] of params.entries()) obj[k] = v;
        done(null, obj);
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  // No signed-in user: under RLS enforce mode the org of the integration whose
  // slash-command token the request carries is bound for the request (#338). A
  // request without a token binds nothing, so it finds no task (fail closed).
  const slackOrg: RlsOrgResolver = async (request) => {
    const token = (request.body as SlackSlashBody | undefined)?.token;
    if (typeof token !== 'string' || !token) return null;
    const [match] = await db
      .select({ project_id: slackIntegrations.project_id })
      .from(slackIntegrations)
      .where(eq(slackIntegrations.slash_command_token, token))
      .limit(1);
    return match ? orgOfProject(match.project_id) : null;
  };

  fastify.post('/webhooks/slack/command', { config: { rlsOrgScope: slackOrg } }, async (request, reply) => {
    const body = (request.body ?? {}) as SlackSlashBody;
    const text = (body.text ?? '').trim();

    // Token verification — if ANY integration has a matching token, we
    // accept. Otherwise, if any integration with a non-null token exists
    // but none matches, reject. Integrations without tokens are ignored
    // for the purposes of this check.
    // #345: the org whose tasks this command may read is the org of the
    // integration the token belongs to. A request without a token names no
    // org and finds nothing, in both RLS postures (enforce mode binds no org
    // for it; the advisory default used to search every org by human_id).
    let integrationOrgId: string | null = null;
    if (body.token) {
      const [match] = await db
        .select({ id: slackIntegrations.id, project_id: slackIntegrations.project_id })
        .from(slackIntegrations)
        .where(eq(slackIntegrations.slash_command_token, body.token))
        .limit(1);
      // If we got a token but it doesn't match any configured token,
      // that's likely a wrong/stale install — reject.
      if (!match) {
        // Still return 200 (Slack shows errors as message); ephemeral so
        // only the invoker sees it.
        return reply.send(ephemeral('Slack verification token did not match any configured integration.'));
      }
      integrationOrgId = await orgOfProject(match.project_id);
    }

    if (!text) {
      return reply.send(ephemeral('/bbb <TASK-REF> — e.g. /bbb MAGE-38'));
    }

    // Normalize: Slack sometimes wraps bare words in <...> link syntax.
    const ref = text.replace(/^<|>$/g, '').toUpperCase();

    if (!integrationOrgId) {
      return reply.send(ephemeral(`Task ${ref} not found.`));
    }

    const [task] = await db
      .select({
        id: tasks.id,
        human_id: tasks.human_id,
        title: tasks.title,
        assignee_id: tasks.assignee_id,
        phase_id: tasks.phase_id,
        state_id: tasks.state_id,
        project_id: tasks.project_id,
      })
      .from(tasks)
      .where(and(eq(tasks.org_id, integrationOrgId), eq(tasks.human_id, ref)))
      .limit(1);

    if (!task) {
      return reply.send(ephemeral(`Task ${ref} not found.`));
    }

    // Verify the task belongs to a project with a matching slack integration.
    // Without this check, a Slack workspace associated with project A could
    // query tasks from an unrelated project B by guessing human_ids.
    if (body.token) {
      const [integration] = await db
        .select({ id: slackIntegrations.id })
        .from(slackIntegrations)
        .where(
          and(
            eq(slackIntegrations.project_id, task.project_id),
            eq(slackIntegrations.slash_command_token, body.token),
          ),
        )
        .limit(1);
      if (!integration) {
        return reply.send(ephemeral(`Task ${ref} not found.`));
      }
    }

    // Enrich with phase/state/assignee display values. Each lookup is
    // guarded so a missing reference doesn't break the response.
    let statusLabel = 'Unknown';
    if (task.state_id) {
      const [state] = await db
        .select({ name: taskStates.name })
        .from(taskStates)
        .where(eq(taskStates.id, task.state_id))
        .limit(1);
      if (state) statusLabel = state.name;
    } else if (task.phase_id) {
      const [phase] = await db
        .select({ name: phases.name })
        .from(phases)
        .where(eq(phases.id, task.phase_id))
        .limit(1);
      if (phase) statusLabel = phase.name;
    }

    let assigneeLabel = 'Unassigned';
    if (task.assignee_id) {
      const [user] = await db
        .select({ display_name: users.display_name })
        .from(users)
        .where(eq(users.id, task.assignee_id))
        .limit(1);
      if (user) assigneeLabel = user.display_name;
    }

    return reply.send({
      response_type: 'ephemeral',
      text: `*${task.human_id}*: ${task.title}`,
      attachments: [
        {
          text: `Status: ${statusLabel}\nAssignee: ${assigneeLabel}`,
          color: '#36a64f',
        },
      ],
    });
  });
}

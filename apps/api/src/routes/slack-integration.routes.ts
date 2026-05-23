import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { slackIntegrations } from '../db/schema/slack-integrations.js';
import { requireAuth, requireScope } from '../plugins/auth.js';
import { validateExternalUrl } from '../lib/url-validator.js';
import { shadowOnly } from '../middleware/dual-read.js';

// ─────────────────────────────────────────────────────────────────────────
// Slack integration CRUD (per-project, admin-gated)
// ─────────────────────────────────────────────────────────────────────────
// GET  /projects/:id/slack-integration       — current config or null
// PUT  /projects/:id/slack-integration       — upsert
// POST /projects/:id/slack-integration/test  — send test message
// DELETE /projects/:id/slack-integration     — disconnect
//
// All mutations require project admin + org member + read_write scope.

const upsertSchema = z.object({
  webhook_url: z.string().url(),
  notify_on_task_created: z.boolean().optional(),
  notify_on_task_completed: z.boolean().optional(),
  notify_on_sprint_started: z.boolean().optional(),
  notify_on_sprint_completed: z.boolean().optional(),
  slash_command_token: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
});

export default async function slackIntegrationRoutes(fastify: FastifyInstance) {
  fastify.get<{ Params: { id: string } }>(
    '/projects/:id/slack-integration',
    { preHandler: [requireAuth, shadowOnly('bam.project_slack_integration.get')] },
    async (request, reply) => {
      const [row] = await db
        .select()
        .from(slackIntegrations)
        .where(eq(slackIntegrations.project_id, request.params.id))
        .limit(1);
      return reply.send({ data: row ?? null });
    },
  );

  fastify.put<{ Params: { id: string } }>(
    '/projects/:id/slack-integration',
    {
      preHandler: [
        requireAuth,
        fastify.requireCan('bam.project_slack_integration.update'),
        requireScope('read_write'),
      ],
    },
    async (request, reply) => {
      const data = upsertSchema.parse(request.body);
      const userId = request.user!.id;

      // SSRF protection: reject private/internal URLs (BAM-020)
      const urlCheck = validateExternalUrl(data.webhook_url);
      if (!urlCheck.safe) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: `Invalid webhook URL: ${urlCheck.reason}`,
            details: [{ field: 'webhook_url', issue: urlCheck.reason }],
            request_id: request.id,
          },
        });
      }

      const [existing] = await db
        .select()
        .from(slackIntegrations)
        .where(eq(slackIntegrations.project_id, request.params.id))
        .limit(1);

      if (existing) {
        const updateValues: Record<string, unknown> = {
          webhook_url: data.webhook_url,
          updated_at: new Date(),
        };
        if (data.notify_on_task_created !== undefined) updateValues.notify_on_task_created = data.notify_on_task_created;
        if (data.notify_on_task_completed !== undefined) updateValues.notify_on_task_completed = data.notify_on_task_completed;
        if (data.notify_on_sprint_started !== undefined) updateValues.notify_on_sprint_started = data.notify_on_sprint_started;
        if (data.notify_on_sprint_completed !== undefined) updateValues.notify_on_sprint_completed = data.notify_on_sprint_completed;
        if (data.slash_command_token !== undefined) updateValues.slash_command_token = data.slash_command_token;
        if (data.enabled !== undefined) updateValues.enabled = data.enabled;

        const [updated] = await db
          .update(slackIntegrations)
          .set(updateValues)
          .where(eq(slackIntegrations.project_id, request.params.id))
          .returning();
        return reply.send({ data: updated });
      }

      const [created] = await db
        .insert(slackIntegrations)
        .values({
          project_id: request.params.id,
          webhook_url: data.webhook_url,
          notify_on_task_created: data.notify_on_task_created ?? true,
          notify_on_task_completed: data.notify_on_task_completed ?? true,
          notify_on_sprint_started: data.notify_on_sprint_started ?? true,
          notify_on_sprint_completed: data.notify_on_sprint_completed ?? true,
          slash_command_token: data.slash_command_token ?? null,
          enabled: data.enabled ?? true,
          created_by: userId,
        })
        .returning();
      return reply.status(201).send({ data: created });
    },
  );

  fastify.post<{ Params: { id: string } }>(
    '/projects/:id/slack-integration/test',
    {
      preHandler: [
        requireAuth,
        fastify.requireCan('bam.project_slack_integration_test.create'),
        requireScope('read_write'),
      ],
    },
    async (request, reply) => {
      const [row] = await db
        .select()
        .from(slackIntegrations)
        .where(eq(slackIntegrations.project_id, request.params.id))
        .limit(1);

      if (!row) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'No Slack integration configured for this project',
            details: [],
            request_id: request.id,
          },
        });
      }

      // SSRF protection: re-validate stored URL before making request (BAM-020)
      const urlCheck = validateExternalUrl(row.webhook_url);
      if (!urlCheck.safe) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: `Stored webhook URL is unsafe: ${urlCheck.reason}`,
            details: [{ field: 'webhook_url', issue: urlCheck.reason }],
            request_id: request.id,
          },
        });
      }

      try {
        const res = await fetch(row.webhook_url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: `:wave: BigBlueBam test message from *${request.user!.display_name}* — your Slack integration is wired up.`,
          }),
        });
        return reply.send({ data: { ok: res.ok, status: res.status } });
      } catch (err) {
        return reply.status(502).send({
          error: {
            code: 'SLACK_WEBHOOK_FAILED',
            message: err instanceof Error ? err.message : 'Failed to post to Slack webhook',
            details: [],
            request_id: request.id,
          },
        });
      }
    },
  );

  fastify.delete<{ Params: { id: string } }>(
    '/projects/:id/slack-integration',
    {
      preHandler: [
        requireAuth,
        fastify.requireCan('bam.project_slack_integration.delete'),
        requireScope('read_write'),
      ],
    },
    async (request, reply) => {
      const [deleted] = await db
        .delete(slackIntegrations)
        .where(eq(slackIntegrations.project_id, request.params.id))
        .returning();

      if (!deleted) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'No Slack integration configured for this project',
            details: [],
            request_id: request.id,
          },
        });
      }

      return reply.send({ data: { success: true } });
    },
  );
}

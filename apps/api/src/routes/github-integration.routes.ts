import type { FastifyInstance } from 'fastify';
import { eq, and, desc } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { githubIntegrations, taskGithubRefs } from '../db/schema/github-integrations.js';
import { tasks } from '../db/schema/tasks.js';
import { phases } from '../db/schema/phases.js';
import { requireAuth, requireScope } from '../plugins/auth.js';
import { requireProjectAccessForEntity } from '../middleware/authorize.js';
import { generateWebhookSecret } from '../services/github-integration.service.js';
import { shadowOnly } from '../middleware/dual-read.js';

/**
 * Phase 6: GitHub integration CRUD + task ref listing.
 *
 * Admin-only for the per-project config endpoints. The webhook_secret
 * is only returned to the caller ONCE — either on initial creation or
 * explicit regeneration — because GitHub's webhook UI needs it, but
 * after that point only the HMAC verifier needs the raw value.
 */

const putIntegrationBodySchema = z.object({
  repo_owner: z.string().min(1).max(100),
  repo_name: z.string().min(1).max(200),
  transition_on_pr_open_phase_id: z.string().uuid().nullable().optional(),
  transition_on_pr_merged_phase_id: z.string().uuid().nullable().optional(),
  enabled: z.boolean().optional(),
  regenerate_secret: z.boolean().optional(),
});

export default async function githubIntegrationRoutes(fastify: FastifyInstance) {
  fastify.get<{ Params: { id: string } }>(
    '/projects/:id/github-integration',
    { preHandler: [requireAuth, fastify.requireCan('bam.project_github_integration.get')] },
    async (request, reply) => {
      const [row] = await db
        .select({
          id: githubIntegrations.id,
          project_id: githubIntegrations.project_id,
          repo_owner: githubIntegrations.repo_owner,
          repo_name: githubIntegrations.repo_name,
          transition_on_pr_open_phase_id: githubIntegrations.transition_on_pr_open_phase_id,
          transition_on_pr_merged_phase_id: githubIntegrations.transition_on_pr_merged_phase_id,
          enabled: githubIntegrations.enabled,
          created_by: githubIntegrations.created_by,
          created_at: githubIntegrations.created_at,
          updated_at: githubIntegrations.updated_at,
        })
        .from(githubIntegrations)
        .where(eq(githubIntegrations.project_id, request.params.id))
        .limit(1);

      return reply.send({ data: row ?? null });
    },
  );

  fastify.put<{ Params: { id: string } }>(
    '/projects/:id/github-integration',
    {
      preHandler: [
        requireAuth,
        fastify.requireCan('bam.project_github_integration.update'),
        requireScope('read_write'),
      ],
    },
    async (request, reply) => {
      const data = putIntegrationBodySchema.parse(request.body);
      const projectId = request.params.id;

      // Validate phase FKs belong to this project, if provided. We
      // reject cross-project phase ids to prevent an admin from wiring
      // the integration at project A to a phase that lives in project B.
      for (const phaseId of [
        data.transition_on_pr_open_phase_id,
        data.transition_on_pr_merged_phase_id,
      ]) {
        if (!phaseId) continue;
        const [phase] = await db
          .select({ id: phases.id, project_id: phases.project_id })
          .from(phases)
          .where(and(eq(phases.id, phaseId), eq(phases.project_id, projectId)))
          .limit(1);
        if (!phase) {
          return reply.status(400).send({
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Phase does not belong to this project',
              details: [{ field: 'phase_id', issue: phaseId }],
              request_id: request.id,
            },
          });
        }
      }

      const [existing] = await db
        .select()
        .from(githubIntegrations)
        .where(eq(githubIntegrations.project_id, projectId))
        .limit(1);

      let secretRevealed: string | null = null;

      if (!existing) {
        const secret = generateWebhookSecret();
        secretRevealed = secret;
        const [created] = await db
          .insert(githubIntegrations)
          .values({
            project_id: projectId,
            repo_owner: data.repo_owner,
            repo_name: data.repo_name,
            webhook_secret: secret,
            transition_on_pr_open_phase_id: data.transition_on_pr_open_phase_id ?? null,
            transition_on_pr_merged_phase_id: data.transition_on_pr_merged_phase_id ?? null,
            enabled: data.enabled ?? true,
            created_by: request.user!.id,
          })
          .returning();
        return reply.status(201).send({
          data: {
            id: created!.id,
            project_id: created!.project_id,
            repo_owner: created!.repo_owner,
            repo_name: created!.repo_name,
            transition_on_pr_open_phase_id: created!.transition_on_pr_open_phase_id,
            transition_on_pr_merged_phase_id: created!.transition_on_pr_merged_phase_id,
            enabled: created!.enabled,
            created_at: created!.created_at,
            updated_at: created!.updated_at,
            webhook_secret: secretRevealed,
          },
        });
      }

      // Update path: preserve secret unless explicitly regenerated.
      const updateValues: Record<string, unknown> = {
        repo_owner: data.repo_owner,
        repo_name: data.repo_name,
        transition_on_pr_open_phase_id: data.transition_on_pr_open_phase_id ?? null,
        transition_on_pr_merged_phase_id: data.transition_on_pr_merged_phase_id ?? null,
        updated_at: new Date(),
      };
      if (data.enabled !== undefined) updateValues.enabled = data.enabled;
      if (data.regenerate_secret === true) {
        secretRevealed = generateWebhookSecret();
        updateValues.webhook_secret = secretRevealed;
      }

      const [updated] = await db
        .update(githubIntegrations)
        .set(updateValues)
        .where(eq(githubIntegrations.id, existing.id))
        .returning();

      return reply.send({
        data: {
          id: updated!.id,
          project_id: updated!.project_id,
          repo_owner: updated!.repo_owner,
          repo_name: updated!.repo_name,
          transition_on_pr_open_phase_id: updated!.transition_on_pr_open_phase_id,
          transition_on_pr_merged_phase_id: updated!.transition_on_pr_merged_phase_id,
          enabled: updated!.enabled,
          created_at: updated!.created_at,
          updated_at: updated!.updated_at,
          webhook_secret: secretRevealed,
        },
      });
    },
  );

  fastify.delete<{ Params: { id: string } }>(
    '/projects/:id/github-integration',
    {
      preHandler: [
        requireAuth,
        fastify.requireCan('bam.project_github_integration.delete'),
        requireScope('read_write'),
      ],
    },
    async (request, reply) => {
      // Historical task_github_refs rows are intentionally preserved —
      // they're useful audit data independent of whether the
      // integration is still active.
      const [deleted] = await db
        .delete(githubIntegrations)
        .where(eq(githubIntegrations.project_id, request.params.id))
        .returning();
      if (!deleted) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'GitHub integration not found for this project',
            details: [],
            request_id: request.id,
          },
        });
      }
      return reply.send({ data: { success: true } });
    },
  );

  fastify.get<{ Params: { id: string } }>(
    '/tasks/:id/github-refs',
    { preHandler: [requireAuth, requireProjectAccessForEntity('task'), shadowOnly('bam.task_github_ref.get')] },
    async (request, reply) => {
      // Gate on the task's project membership — a user who can read a
      // task's details should be able to see its linked commits/PRs.
      const [task] = await db
        .select({ id: tasks.id, project_id: tasks.project_id })
        .from(tasks)
        .where(eq(tasks.id, request.params.id))
        .limit(1);
      if (!task) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Task not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      const refs = await db
        .select()
        .from(taskGithubRefs)
        .where(eq(taskGithubRefs.task_id, task.id))
        .orderBy(desc(taskGithubRefs.created_at));

      return reply.send({ data: refs });
    },
  );
}

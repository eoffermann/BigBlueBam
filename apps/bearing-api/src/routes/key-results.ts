import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  BearingMetricType,
  BearingDirection,
  BearingProgressMode,
} from '@bigbluebam/shared';
import { requireAuth, requireScope } from '../plugins/auth.js';
import { requireMinOrgRole, requireGoalAccess } from '../middleware/authorize.js';
import * as krService from '../services/key-result.service.js';
import { publishBoltEvent } from '@bigbluebam/shared';
import {
  buildGoalUrl,
  buildKeyResultUrl,
  loadActor,
  loadGoalById,
  loadKeyResultById,
  loadOrg,
  loadOwner,
  loadPeriod,
} from '../lib/bolt-event-enrich.js';

const METRIC_TYPES = BearingMetricType.options;
const DIRECTIONS = BearingDirection.options;
const PROGRESS_MODES = [...BearingProgressMode.options, 'rollup'] as const;
const LINKED_TARGET_TYPES = ['task', 'tasks', 'epic', 'sprint'] as const;

/** Strict schema for linked_query — only known fields allowed. */
const linkedQuerySchema = z
  .object({
    target_type: z.enum(LINKED_TARGET_TYPES),
    project_id: z.string().uuid().optional(),
    phase_id: z.string().uuid().optional(),
    sprint_id: z.string().uuid().optional(),
    label: z.string().max(100).optional(),
    assignee_id: z.string().uuid().optional(),
    status: z.string().max(50).optional(),
  })
  .strict()
  .nullable()
  .optional();

const createKeyResultSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(5000).nullable().optional(),
  metric_type: z.enum(METRIC_TYPES).optional(),
  target_value: z.number().optional(),
  current_value: z.number().optional(),
  start_value: z.number().optional(),
  unit: z.string().max(50).nullable().optional(),
  direction: z.enum(DIRECTIONS).optional(),
  progress_mode: z.enum(PROGRESS_MODES).optional(),
  linked_query: linkedQuerySchema,
  owner_id: z.string().uuid().nullable().optional(),
  sort_order: z.number().int().min(0).max(1000).optional(),
});

const updateKeyResultSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(5000).nullable().optional(),
  metric_type: z.enum(METRIC_TYPES).optional(),
  target_value: z.number().optional(),
  current_value: z.number().optional(),
  start_value: z.number().optional(),
  unit: z.string().max(50).nullable().optional(),
  direction: z.enum(DIRECTIONS).optional(),
  progress_mode: z.enum(PROGRESS_MODES).optional(),
  linked_query: linkedQuerySchema,
  owner_id: z.string().uuid().nullable().optional(),
  sort_order: z.number().int().min(0).max(1000).optional(),
});

const setValueSchema = z.object({
  value: z.number(),
});

const LINK_TYPES = ['epic', 'project', 'task_query', 'task', 'sprint'] as const;
const TARGET_TYPES = ['task', 'epic', 'project', 'sprint', 'goal'] as const;

const addLinkSchema = z.object({
  link_type: z.enum(LINK_TYPES),
  target_type: z.enum(TARGET_TYPES),
  target_id: z.string().uuid(),
  metadata: z.record(z.unknown()).nullable().optional(),
});

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Publish an enriched `key_result.updated` Bolt event.
 *
 * @param updated   the row returned from the service after the update
 * @param previous  the row fetched before the update (for previous_progress/delta)
 * @param orgId     caller's org id (for org-context fetch + publish routing)
 * @param actorId   user id that performed the action
 */
async function publishKeyResultUpdated(
  updated: {
    id: string;
    goal_id: string;
    title: string;
    description: string | null;
    target_value: string | number;
    current_value: string | number;
    start_value: string | number;
    unit: string | null;
    progress: string | number;
    owner_id: string | null;
    updated_at: Date;
  },
  previous: {
    current_value: string | number;
    progress: string | number;
  } | null,
  orgId: string,
  actorId: string,
) {
  try {
    const goal = await loadGoalById(updated.goal_id);

    const [actor, org, owner, period] = await Promise.all([
      loadActor(actorId),
      loadOrg(orgId),
      loadOwner(updated.owner_id ?? null),
      goal ? loadPeriod(goal.period_id) : Promise.resolve({ id: '', name: null }),
    ]);

    const currentProgress = Number(updated.progress);
    const previousProgress = previous ? Number(previous.progress) : null;
    const delta =
      previousProgress !== null && Number.isFinite(previousProgress)
        ? Number((currentProgress - previousProgress).toFixed(2))
        : null;

    publishBoltEvent(
      'key_result.updated',
      'bearing',
      {
        key_result: {
          id: updated.id,
          goal_id: updated.goal_id,
          title: updated.title,
          description: updated.description,
          target: Number(updated.target_value),
          current_value: Number(updated.current_value),
          start_value: Number(updated.start_value),
          unit: updated.unit,
          progress_percent: currentProgress,
          previous_progress: previousProgress,
          delta,
          owner_id: updated.owner_id,
          url: buildKeyResultUrl(updated.goal_id, updated.id),
          updated_at: updated.updated_at,
        },
        goal: goal
          ? {
              id: goal.id,
              title: goal.title,
              description: goal.description,
              status: goal.status,
              progress_percent: Number(goal.progress),
              period_id: goal.period_id,
              owner_id: goal.owner_id,
              project_id: goal.project_id,
              // TODO: parent_goal_id — not yet modeled in bearing_goals schema
              url: buildGoalUrl(goal.id),
            }
          : null,
        period: goal
          ? { id: period.id, name: period.name }
          : null,
        owner: owner
          ? { id: owner.id, name: owner.name, email: owner.email }
          : null,
        actor: {
          id: actor.id,
          name: actor.name,
          email: actor.email,
        },
        org: {
          id: org.id,
          name: org.name,
          slug: org.slug,
        },
        // Legacy flat fields (backwards compat with any existing rules)
        id: updated.id,
        title: updated.title,
        goal_id: updated.goal_id,
        current_value: Number(updated.current_value),
        target_value: Number(updated.target_value),
        updated_by: actorId,
      },
      orgId,
      actorId,
      'user',
    );
  } catch {
    // Fire-and-forget — never break the caller if enrichment fails.
  }
}

export default async function keyResultRoutes(fastify: FastifyInstance) {
  // GET /goals/:id/key-results — List KRs for goal
  fastify.get<{ Params: { id: string } }>(
    '/goals/:id/key-results',
    { preHandler: [requireAuth, requireGoalAccess()] },
    async (request, reply) => {
      const result = await krService.listKeyResults((request as any).goal.id);
      return reply.send(result);
    },
  );

  // POST /goals/:id/key-results — Create KR
  fastify.post<{ Params: { id: string } }>(
    '/goals/:id/key-results',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      preHandler: [requireAuth, requireGoalAccess(), requireMinOrgRole('member'), requireScope('read_write')],
    },
    async (request, reply) => {
      const goalId = (request as any).goal.id;
      const data = createKeyResultSchema.parse(request.body);
      const kr = await krService.createKeyResult(goalId, data, request.user!.org_id);
      return reply.status(201).send({ data: kr });
    },
  );

  // GET /key-results/:id — Get KR
  fastify.get<{ Params: { id: string } }>(
    '/key-results/:id',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { id } = request.params;
      if (!UUID_REGEX.test(id)) {
        return reply.status(400).send({
          error: {
            code: 'BAD_REQUEST',
            message: 'Valid key result id is required',
            details: [],
            request_id: request.id,
          },
        });
      }

      const kr = await krService.getKeyResultWithOrgCheck(id, request.user!.org_id);
      if (!kr) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Key result not found',
            details: [],
            request_id: request.id,
          },
        });
      }
      return reply.send({ data: kr });
    },
  );

  // PATCH /key-results/:id — Update KR
  fastify.patch<{ Params: { id: string } }>(
    '/key-results/:id',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      preHandler: [requireAuth, requireMinOrgRole('member'), requireScope('read_write')],
    },
    async (request, reply) => {
      const { id } = request.params;
      const data = updateKeyResultSchema.parse(request.body);
      // Capture pre-update snapshot so we can emit previous_progress/delta
      const previousKr = await loadKeyResultById(id);
      const kr = await krService.updateKeyResult(id, data, request.user!.org_id, fastify.redis);
      await publishKeyResultUpdated(
        kr,
        previousKr
          ? { current_value: previousKr.current_value, progress: previousKr.progress }
          : null,
        request.user!.org_id,
        request.user!.id,
      );
      return reply.send({ data: kr });
    },
  );

  // DELETE /key-results/:id — Delete KR
  fastify.delete<{ Params: { id: string } }>(
    '/key-results/:id',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      preHandler: [requireAuth, requireMinOrgRole('member'), requireScope('read_write')],
    },
    async (request, reply) => {
      await krService.deleteKeyResult(request.params.id, request.user!.org_id);
      return reply.status(204).send();
    },
  );

  // POST /key-results/:id/value — Set current value
  fastify.post<{ Params: { id: string } }>(
    '/key-results/:id/value',
    {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      preHandler: [requireAuth, requireScope('read_write')],
    },
    async (request, reply) => {
      const { value } = setValueSchema.parse(request.body);
      const previousKr = await loadKeyResultById(request.params.id);
      const kr = await krService.setCurrentValue(request.params.id, value, request.user!.org_id, fastify.redis);
      await publishKeyResultUpdated(
        kr,
        previousKr
          ? { current_value: previousKr.current_value, progress: previousKr.progress }
          : null,
        request.user!.org_id,
        request.user!.id,
      );
      return reply.send({ data: kr });
    },
  );

  // GET /key-results/:id/links — List links
  fastify.get<{ Params: { id: string } }>(
    '/key-results/:id/links',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const result = await krService.listLinks(request.params.id, request.user!.org_id);
      return reply.send(result);
    },
  );

  // POST /key-results/:id/links — Add link
  fastify.post<{ Params: { id: string } }>(
    '/key-results/:id/links',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      preHandler: [requireAuth, requireScope('read_write')],
    },
    async (request, reply) => {
      const data = addLinkSchema.parse(request.body);
      const link = await krService.addLink(request.params.id, data, request.user!.org_id);
      return reply.status(201).send({ data: link });
    },
  );

  // DELETE /key-results/:id/links/:linkId — Remove link
  fastify.delete<{ Params: { id: string; linkId: string } }>(
    '/key-results/:id/links/:linkId',
    { preHandler: [requireAuth, requireScope('read_write')] },
    async (request, reply) => {
      await krService.removeLink(request.params.linkId, request.user!.org_id);
      return reply.status(204).send();
    },
  );

  // GET /key-results/:id/history — Snapshot history
  fastify.get<{ Params: { id: string } }>(
    '/key-results/:id/history',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const result = await krService.getHistory(request.params.id, request.user!.org_id);
      return reply.send(result);
    },
  );
}

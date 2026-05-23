import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  BearingMetricType,
  BearingDirection,
  BearingProgressMode,
} from '@bigbluebam/shared';
import { requireAuth, requireScope } from '../plugins/auth.js';
import { requireGoalAccess } from '../middleware/authorize.js';
import { shadowOnly } from '../middleware/dual-read.js';
import * as krService from '../services/key-result.service.js';
import { publishBoltEvent } from '../lib/bolt-events.js';
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
    { preHandler: [requireAuth, requireGoalAccess(), shadowOnly('bearing.goal_key_result.get')] },
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
      preHandler: [requireAuth, requireGoalAccess(), fastify.requireCan('bearing.goal_key_result.create'), requireScope('read_write')],
    },
    async (request, reply) => {
      const goalId = (request as any).goal.id;
      const data = createKeyResultSchema.parse(request.body);
      const kr = await krService.createKeyResult(goalId, data, request.user!.org_id);

      // Fire-and-forget Bolt event for KR creation.
      try {
        const goal = await loadGoalById(goalId);
        const [actor, org, owner, period] = await Promise.all([
          loadActor(request.user!.id),
          loadOrg(request.user!.org_id),
          loadOwner(kr.owner_id ?? null),
          goal ? loadPeriod(goal.period_id) : Promise.resolve({ id: '', name: null }),
        ]);
        publishBoltEvent(
          'kr.created',
          'bearing',
          {
            key_result: {
              id: kr.id,
              goal_id: kr.goal_id,
              name: kr.title,
              title: kr.title,
              description: kr.description,
              target: Number(kr.target_value),
              current_value: Number(kr.current_value),
              start_value: Number(kr.start_value),
              unit: kr.unit,
              progress_percent: Number(kr.progress),
              owner_id: kr.owner_id,
              url: buildKeyResultUrl(kr.goal_id, kr.id),
              created_at: kr.created_at,
            },
            goal: goal
              ? {
                  id: goal.id,
                  title: goal.title,
                  status: goal.status,
                  progress_percent: Number(goal.progress),
                  period_id: goal.period_id,
                  owner_id: goal.owner_id,
                  url: buildGoalUrl(goal.id),
                }
              : null,
            period: goal ? { id: period.id, name: period.name } : null,
            owner: owner
              ? { id: owner.id, name: owner.name, email: owner.email }
              : null,
            actor: { id: actor.id, name: actor.name, email: actor.email },
            org: { id: org.id, name: org.name, slug: org.slug },
            // Legacy flat fields
            id: kr.id,
            goal_id: kr.goal_id,
            name: kr.title,
          },
          request.user!.org_id,
          request.user!.id,
          'user',
        );
      } catch {
        // Fire-and-forget: never break the caller if enrichment fails.
      }

      return reply.status(201).send({ data: kr });
    },
  );

  // GET /key-results/:id — Get KR
  fastify.get<{ Params: { id: string } }>(
    '/key-results/:id',
    { preHandler: [requireAuth, shadowOnly('bearing.key_result.get')] },
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
      preHandler: [requireAuth, fastify.requireCan('bearing.key_result.update'), requireScope('read_write')],
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
      preHandler: [requireAuth, fastify.requireCan('bearing.key_result.delete'), requireScope('read_write')],
    },
    async (request, reply) => {
      // Capture the KR snapshot before deletion so we can enrich the
      // `kr.deleted` Bolt event payload after the row is gone.
      const previousKr = await krService.getKeyResultWithOrgCheck(
        request.params.id,
        request.user!.org_id,
      );
      await krService.deleteKeyResult(request.params.id, request.user!.org_id);

      if (previousKr) {
        try {
          const goal = await loadGoalById(previousKr.goal_id);
          const [actor, org, owner, period] = await Promise.all([
            loadActor(request.user!.id),
            loadOrg(request.user!.org_id),
            loadOwner(previousKr.owner_id ?? null),
            goal ? loadPeriod(goal.period_id) : Promise.resolve({ id: '', name: null }),
          ]);
          publishBoltEvent(
            'kr.deleted',
            'bearing',
            {
              key_result: {
                id: previousKr.id,
                goal_id: previousKr.goal_id,
                name: previousKr.title,
                title: previousKr.title,
                target: Number(previousKr.target_value),
                current_value: Number(previousKr.current_value),
                progress_percent: Number(previousKr.progress),
                owner_id: previousKr.owner_id,
                url: buildKeyResultUrl(previousKr.goal_id, previousKr.id),
              },
              goal: goal
                ? {
                    id: goal.id,
                    title: goal.title,
                    status: goal.status,
                    progress_percent: Number(goal.progress),
                    period_id: goal.period_id,
                    owner_id: goal.owner_id,
                    url: buildGoalUrl(goal.id),
                  }
                : null,
              period: goal ? { id: period.id, name: period.name } : null,
              owner: owner
                ? { id: owner.id, name: owner.name, email: owner.email }
                : null,
              actor: { id: actor.id, name: actor.name, email: actor.email },
              org: { id: org.id, name: org.name, slug: org.slug },
              // Legacy flat fields
              id: previousKr.id,
              goal_id: previousKr.goal_id,
              name: previousKr.title,
            },
            request.user!.org_id,
            request.user!.id,
            'user',
          );
        } catch {
          // Fire-and-forget.
        }
      }

      return reply.status(204).send();
    },
  );

  // POST /key-results/:id/value — Set current value
  fastify.post<{ Params: { id: string } }>(
    '/key-results/:id/value',
    {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      preHandler: [requireAuth, shadowOnly('bearing.key_result_value.create'), requireScope('read_write')],
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

      // Emit kr.value_updated as a separate narrow event so Bolt rules can
      // trigger on value changes without diffing `key_result.updated`.
      try {
        const goal = await loadGoalById(kr.goal_id);
        const [actor, org, owner, period] = await Promise.all([
          loadActor(request.user!.id),
          loadOrg(request.user!.org_id),
          loadOwner(kr.owner_id ?? null),
          goal ? loadPeriod(goal.period_id) : Promise.resolve({ id: '', name: null }),
        ]);
        publishBoltEvent(
          'kr.value_updated',
          'bearing',
          {
            key_result: {
              id: kr.id,
              goal_id: kr.goal_id,
              name: kr.title,
              title: kr.title,
              old_value: previousKr ? Number(previousKr.current_value) : null,
              new_value: Number(kr.current_value),
              target: Number(kr.target_value),
              progress_percent: Number(kr.progress),
              previous_progress: previousKr ? Number(previousKr.progress) : null,
              unit: kr.unit,
              owner_id: kr.owner_id,
              url: buildKeyResultUrl(kr.goal_id, kr.id),
              updated_at: kr.updated_at,
            },
            goal: goal
              ? {
                  id: goal.id,
                  title: goal.title,
                  status: goal.status,
                  progress_percent: Number(goal.progress),
                  period_id: goal.period_id,
                  owner_id: goal.owner_id,
                  url: buildGoalUrl(goal.id),
                }
              : null,
            period: goal ? { id: period.id, name: period.name } : null,
            owner: owner
              ? { id: owner.id, name: owner.name, email: owner.email }
              : null,
            actor: { id: actor.id, name: actor.name, email: actor.email },
            org: { id: org.id, name: org.name, slug: org.slug },
            // Legacy flat fields
            id: kr.id,
            goal_id: kr.goal_id,
            old_value: previousKr ? Number(previousKr.current_value) : null,
            new_value: Number(kr.current_value),
          },
          request.user!.org_id,
          request.user!.id,
          'user',
        );
      } catch {
        // Fire-and-forget.
      }

      return reply.send({ data: kr });
    },
  );

  // GET /key-results/:id/links — List links
  fastify.get<{ Params: { id: string } }>(
    '/key-results/:id/links',
    { preHandler: [requireAuth, shadowOnly('bearing.key_result_link.get')] },
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
      preHandler: [requireAuth, shadowOnly('bearing.key_result_link.create'), requireScope('read_write')],
    },
    async (request, reply) => {
      const data = addLinkSchema.parse(request.body);
      const link = await krService.addLink(request.params.id, data, request.user!.org_id);

      try {
        const kr = await loadKeyResultById(request.params.id);
        const goal = kr ? await loadGoalById(kr.goal_id) : null;
        const [actor, org] = await Promise.all([
          loadActor(request.user!.id),
          loadOrg(request.user!.org_id),
        ]);
        publishBoltEvent(
          'kr.linked',
          'bearing',
          {
            key_result: kr
              ? {
                  id: kr.id,
                  goal_id: kr.goal_id,
                  name: kr.title,
                  title: kr.title,
                  url: buildKeyResultUrl(kr.goal_id, kr.id),
                }
              : { id: request.params.id },
            link: {
              link_type: data.link_type,
              target_type: data.target_type,
              target_id: data.target_id,
              linked_entity_id: data.target_id,
              metadata: data.metadata ?? null,
            },
            goal: goal
              ? {
                  id: goal.id,
                  title: goal.title,
                  status: goal.status,
                  period_id: goal.period_id,
                  owner_id: goal.owner_id,
                  url: buildGoalUrl(goal.id),
                }
              : null,
            actor: { id: actor.id, name: actor.name, email: actor.email },
            org: { id: org.id, name: org.name, slug: org.slug },
            // Legacy flat fields
            id: kr?.id ?? request.params.id,
            goal_id: kr?.goal_id ?? null,
            link_type: data.link_type,
            linked_entity_id: data.target_id,
          },
          request.user!.org_id,
          request.user!.id,
          'user',
        );
      } catch {
        // Fire-and-forget.
      }

      return reply.status(201).send({ data: link });
    },
  );

  // DELETE /key-results/:id/links/:linkId — Remove link
  fastify.delete<{ Params: { id: string; linkId: string } }>(
    '/key-results/:id/links/:linkId',
    { preHandler: [requireAuth, shadowOnly('bearing.key_result_link.delete'), requireScope('read_write')] },
    async (request, reply) => {
      await krService.removeLink(request.params.linkId, request.user!.org_id);
      return reply.status(204).send();
    },
  );

  // GET /key-results/:id/history — Snapshot history
  fastify.get<{ Params: { id: string } }>(
    '/key-results/:id/history',
    { preHandler: [requireAuth, shadowOnly('bearing.key_result_history.get')] },
    async (request, reply) => {
      const result = await krService.getHistory(request.params.id, request.user!.org_id);
      return reply.send(result);
    },
  );
}

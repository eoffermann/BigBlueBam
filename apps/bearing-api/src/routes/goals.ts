import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  BearingGoalScope,
  BearingGoalStatus,
} from '@bigbluebam/shared';
import { requireAuth, requireScope } from '../plugins/auth.js';
import {
  requireMinOrgRole,
  requireGoalAccess,
  requireGoalEditAccess,
} from '../middleware/authorize.js';
import * as goalService from '../services/goal.service.js';
import { publishBoltEvent } from '@bigbluebam/shared';
import {
  buildGoalUrl,
  loadActor,
  loadOrg,
  loadOwner,
  loadPeriod,
} from '../lib/bolt-event-enrich.js';

const GOAL_SCOPES = BearingGoalScope.options;
const GOAL_STATUSES = BearingGoalStatus.options;

const createGoalSchema = z.object({
  period_id: z.string().uuid(),
  scope: z.enum(GOAL_SCOPES).optional(),
  project_id: z.string().uuid().nullable().optional(),
  team_name: z.string().max(100).nullable().optional(),
  title: z.string().min(1).max(500),
  description: z.string().max(5000).nullable().optional(),
  icon: z.string().max(50).nullable().optional(),
  color: z.string().max(20).nullable().optional(),
  status: z.enum(GOAL_STATUSES).optional(),
  owner_id: z.string().uuid().nullable().optional(),
});

const updateGoalSchema = z.object({
  period_id: z.string().uuid().optional(),
  scope: z.enum(GOAL_SCOPES).optional(),
  project_id: z.string().uuid().nullable().optional(),
  team_name: z.string().max(100).nullable().optional(),
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(5000).nullable().optional(),
  icon: z.string().max(50).nullable().optional(),
  color: z.string().max(20).nullable().optional(),
  status: z.enum(GOAL_STATUSES).optional(),
  owner_id: z.string().uuid().nullable().optional(),
});

const listGoalsQuerySchema = z.object({
  period_id: z.string().uuid().optional(),
  scope: z.enum(GOAL_SCOPES).optional(),
  project_id: z.string().uuid().optional(),
  owner_id: z.string().uuid().optional(),
  status: z.enum(GOAL_STATUSES).optional(),
  search: z.string().max(500).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const statusOverrideSchema = z.object({
  status: z.enum(GOAL_STATUSES),
});

const createUpdateSchema = z.object({
  status: z.enum(GOAL_STATUSES),
  body: z.string().max(10000).nullable().optional(),
});

export default async function goalRoutes(fastify: FastifyInstance) {
  // GET /goals — List goals (filterable)
  fastify.get(
    '/goals',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const query = listGoalsQuerySchema.parse(request.query);
      const result = await goalService.listGoals({
        orgId: request.user!.org_id,
        periodId: query.period_id,
        scope: query.scope,
        projectId: query.project_id,
        ownerId: query.owner_id,
        status: query.status,
        search: query.search,
        cursor: query.cursor,
        limit: query.limit,
      });
      return reply.send(result);
    },
  );

  // POST /goals — Create goal
  fastify.post(
    '/goals',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      preHandler: [requireAuth, requireMinOrgRole('member'), requireScope('read_write')],
    },
    async (request, reply) => {
      const data = createGoalSchema.parse(request.body);
      const goal = await goalService.createGoal(data, request.user!.id, request.user!.org_id);
      // Fetch related entities in parallel for enriched event payload.
      const [actor, org, owner, period] = await Promise.all([
        loadActor(request.user!.id),
        loadOrg(request.user!.org_id),
        loadOwner(goal.owner_id ?? null),
        loadPeriod(goal.period_id),
      ]);
      publishBoltEvent(
        'goal.created',
        'bearing',
        {
          goal: {
            id: goal.id,
            title: goal.title,
            description: goal.description,
            scope: goal.scope,
            status: goal.status,
            progress_percent: Number(goal.progress),
            period_id: goal.period_id,
            owner_id: goal.owner_id,
            project_id: goal.project_id,
            // TODO: parent_goal_id — not yet modeled in bearing_goals schema
            url: buildGoalUrl(goal.id),
            created_at: goal.created_at,
          },
          period: {
            id: period.id,
            name: period.name,
          },
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
          id: goal.id,
          title: goal.title,
          scope: goal.scope,
          status: goal.status,
          created_by: request.user!.id,
        },
        request.user!.org_id,
        request.user!.id,
        'user',
      );
      return reply.status(201).send({ data: goal });
    },
  );

  // GET /goals/:id — Get goal with KRs
  fastify.get<{ Params: { id: string } }>(
    '/goals/:id',
    { preHandler: [requireAuth, requireGoalAccess()] },
    async (request, reply) => {
      const goal = await goalService.getGoal(
        (request as any).goal.id,
        request.user!.org_id,
        fastify.redis,
      );
      return reply.send({ data: goal });
    },
  );

  // PATCH /goals/:id — Update goal
  fastify.patch<{ Params: { id: string } }>(
    '/goals/:id',
    { preHandler: [requireAuth, requireGoalEditAccess(), requireScope('read_write')] },
    async (request, reply) => {
      const data = updateGoalSchema.parse(request.body);
      // Capture the pre-update row so we can emit a `changes` diff in the
      // enriched Bolt event payload. `requireGoalEditAccess` already loaded
      // the goal onto the request, so no extra query is needed.
      const previousGoal = (request as any).goal as {
        id: string;
        title: string;
        description: string | null;
        scope: string;
        status: string;
        progress: string | number | null;
        period_id: string;
        owner_id: string | null;
        project_id: string | null;
      };
      const goal = await goalService.updateGoal(
        (request as any).goal.id,
        data,
        request.user!.org_id,
        fastify.redis,
      );

      // Build changes diff from the fields the client actually sent.
      const changes: Record<string, { old: unknown; new: unknown }> = {};
      for (const key of Object.keys(data) as (keyof typeof data)[]) {
        const newVal = data[key];
        const oldVal = (previousGoal as Record<string, unknown>)[key];
        if (newVal !== undefined && oldVal !== newVal) {
          changes[key] = { old: oldVal ?? null, new: newVal ?? null };
        }
      }

      const [actor, org, owner, period] = await Promise.all([
        loadActor(request.user!.id),
        loadOrg(request.user!.org_id),
        loadOwner(goal.owner_id ?? null),
        loadPeriod(goal.period_id),
      ]);
      publishBoltEvent(
        'goal.updated',
        'bearing',
        {
          goal: {
            id: goal.id,
            title: goal.title,
            description: goal.description,
            scope: goal.scope,
            status: goal.status,
            progress_percent: Number(goal.progress),
            period_id: goal.period_id,
            owner_id: goal.owner_id,
            project_id: goal.project_id,
            // TODO: parent_goal_id — not yet modeled in bearing_goals schema
            url: buildGoalUrl(goal.id),
            updated_at: goal.updated_at,
          },
          period: {
            id: period.id,
            name: period.name,
          },
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
          changes,
          // Legacy flat fields (backwards compat with any existing rules)
          id: goal.id,
          title: goal.title,
          scope: goal.scope,
          status: goal.status,
          updated_by: request.user!.id,
        },
        request.user!.org_id,
        request.user!.id,
        'user',
      );
      return reply.send({ data: goal });
    },
  );

  // DELETE /goals/:id — Delete goal
  fastify.delete<{ Params: { id: string } }>(
    '/goals/:id',
    { preHandler: [requireAuth, requireGoalEditAccess(), requireScope('read_write')] },
    async (request, reply) => {
      await goalService.deleteGoal((request as any).goal.id, request.user!.org_id);
      return reply.status(204).send();
    },
  );

  // POST /goals/:id/status — Override status
  fastify.post<{ Params: { id: string } }>(
    '/goals/:id/status',
    { preHandler: [requireAuth, requireGoalEditAccess(), requireScope('read_write')] },
    async (request, reply) => {
      const { status } = statusOverrideSchema.parse(request.body);
      const goal = await goalService.overrideStatus(
        (request as any).goal.id,
        status,
        request.user!.org_id,
        fastify.redis,
      );
      return reply.send({ data: goal });
    },
  );

  // GET /goals/:id/updates — List updates
  fastify.get<{ Params: { id: string } }>(
    '/goals/:id/updates',
    { preHandler: [requireAuth, requireGoalAccess()] },
    async (request, reply) => {
      const result = await goalService.listUpdates(
        (request as any).goal.id,
        request.user!.org_id,
      );
      return reply.send(result);
    },
  );

  // POST /goals/:id/updates — Post update
  fastify.post<{ Params: { id: string } }>(
    '/goals/:id/updates',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      preHandler: [requireAuth, requireGoalEditAccess(), requireScope('read_write')],
    },
    async (request, reply) => {
      const data = createUpdateSchema.parse(request.body);
      const update = await goalService.createUpdate(
        (request as any).goal.id,
        data,
        request.user!.id,
        request.user!.org_id,
      );
      return reply.status(201).send({ data: update });
    },
  );

  // GET /goals/:id/watchers — List watchers
  fastify.get<{ Params: { id: string } }>(
    '/goals/:id/watchers',
    { preHandler: [requireAuth, requireGoalAccess()] },
    async (request, reply) => {
      const result = await goalService.listWatchers(
        (request as any).goal.id,
        request.user!.org_id,
      );
      return reply.send(result);
    },
  );

  // POST /goals/:id/watchers — Add watcher
  fastify.post<{ Params: { id: string } }>(
    '/goals/:id/watchers',
    { preHandler: [requireAuth, requireGoalAccess(), requireScope('read_write')] },
    async (request, reply) => {
      const watcher = await goalService.addWatcher(
        (request as any).goal.id,
        request.user!.id,
        request.user!.org_id,
      );
      return reply.status(201).send({ data: watcher });
    },
  );

  // DELETE /goals/:id/watchers/:userId — Remove watcher
  // Users can remove themselves. Goal owner or org admin/owner can remove others.
  fastify.delete<{ Params: { id: string; userId: string } }>(
    '/goals/:id/watchers/:userId',
    { preHandler: [requireAuth, requireGoalAccess(), requireScope('read_write')] },
    async (request, reply) => {
      const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!UUID_REGEX.test(request.params.userId)) {
        return reply.status(400).send({
          error: {
            code: 'BAD_REQUEST',
            message: 'Valid user id is required',
            details: [],
            request_id: request.id,
          },
        });
      }

      const targetUserId = request.params.userId;
      const callerId = request.user!.id;
      const callerRole = request.user!.role;
      const goal = (request as any).goal;

      // Allow: removing yourself, or goal owner removing others, or org admin/owner
      const isSelf = callerId === targetUserId;
      const isGoalOwner = goal.owner_id === callerId;
      const isOrgAdminOrOwner = callerRole === 'admin' || callerRole === 'owner';

      if (!isSelf && !isGoalOwner && !isOrgAdminOrOwner) {
        return reply.status(403).send({
          error: {
            code: 'FORBIDDEN',
            message: 'You can only remove yourself as a watcher unless you are the goal owner or an org admin',
            details: [],
            request_id: request.id,
          },
        });
      }

      await goalService.removeWatcher(
        goal.id,
        targetUserId,
        request.user!.org_id,
      );
      return reply.status(204).send();
    },
  );

  // GET /goals/:id/history — Progress history
  fastify.get<{ Params: { id: string } }>(
    '/goals/:id/history',
    { preHandler: [requireAuth, requireGoalAccess()] },
    async (request, reply) => {
      const result = await goalService.getGoalHistory(
        (request as any).goal.id,
        request.user!.org_id,
      );
      return reply.send(result);
    },
  );
}

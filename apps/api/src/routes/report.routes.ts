import type { FastifyInstance } from 'fastify';
import { eq, and, desc, asc, isNotNull, lt, sql, gte, lte } from 'drizzle-orm';
import { db } from '../db/index.js';
import { sprints } from '../db/schema/sprints.js';
import { tasks } from '../db/schema/tasks.js';
import { phases } from '../db/schema/phases.js';
import { users } from '../db/schema/users.js';
import { timeEntries } from '../db/schema/time-entries.js';
import { requireAuth } from '../plugins/auth.js';
import { requireProjectAccess } from '../middleware/authorize.js';
import { shadowOnly } from '../middleware/dual-read.js';
import {
  buildBurndown,
  buildVelocity,
  buildCfd,
} from '../services/report.service.js';

export default async function reportRoutes(fastify: FastifyInstance) {
  // Velocity report: last N completed sprints with committed vs completed points
  fastify.get<{
    Params: { id: string };
    Querystring: { limit?: string; count?: string };
  }>(
    '/projects/:id/reports/velocity',
    { preHandler: [requireAuth, requireProjectAccess(), shadowOnly('bam.project_report_velocity.get')] },
    async (request, reply) => {
      const raw = request.query.limit ?? request.query.count;
      const limit = raw ? Math.max(1, Math.min(50, Number.parseInt(raw, 10) || 10)) : 10;
      const data = await buildVelocity(request.params.id, limit);
      return reply.send({ data });
    },
  );

  // Sprint burndown report
  fastify.get<{
    Params: { id: string };
    Querystring: { sprint_id?: string };
  }>(
    '/projects/:id/reports/burndown',
    { preHandler: [requireAuth, requireProjectAccess(), shadowOnly('bam.project_report_burndown.get')] },
    async (request, reply) => {
      let sprintId = request.query.sprint_id;
      if (!sprintId) {
        return reply.status(400).send({
          error: {
            code: 'BAD_REQUEST',
            message: 'sprint_id query parameter is required',
            details: [{ field: 'sprint_id', issue: 'required' }],
            request_id: request.id,
          },
        });
      }

      // Support the 'ACTIVE' sentinel used by the project dashboard.
      if (sprintId === 'ACTIVE') {
        const [active] = await db
          .select({ id: sprints.id })
          .from(sprints)
          .where(
            and(
              eq(sprints.project_id, request.params.id),
              eq(sprints.status, 'active'),
            ),
          )
          .orderBy(desc(sprints.start_date))
          .limit(1);
        if (!active) {
          return reply.send({ data: null });
        }
        sprintId = active.id;
      }

      const data = await buildBurndown(sprintId);
      if (!data) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Sprint not found',
            details: [],
            request_id: request.id,
          },
        });
      }
      return reply.send({ data });
    },
  );

  // Cumulative flow diagram
  fastify.get<{
    Params: { id: string };
    Querystring: { sprint_id?: string; days?: string };
  }>(
    '/projects/:id/reports/cfd',
    { preHandler: [requireAuth, requireProjectAccess(), shadowOnly('bam.project_report_cfd.get')] },
    async (request, reply) => {
      const days = request.query.days
        ? Math.max(1, Math.min(180, Number.parseInt(request.query.days, 10) || 30))
        : 30;
      const data = await buildCfd(
        request.params.id,
        request.query.sprint_id ?? null,
        days,
      );
      if (!data) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Sprint not found',
            details: [],
            request_id: request.id,
          },
        });
      }
      return reply.send({ data });
    },
  );

  // Cycle time report
  fastify.get<{ Params: { id: string } }>(
    '/projects/:id/reports/cycle-time',
    { preHandler: [requireAuth, requireProjectAccess(), shadowOnly('bam.project_report_cycle_time.get')] },
    async (request, reply) => {
      // Get completed tasks with created_at and completed_at
      const completedTasks = await db
        .select({
          id: tasks.id,
          human_id: tasks.human_id,
          title: tasks.title,
          created_at: tasks.created_at,
          completed_at: tasks.completed_at,
          story_points: tasks.story_points,
        })
        .from(tasks)
        .where(
          and(
            eq(tasks.project_id, request.params.id),
            isNotNull(tasks.completed_at),
          ),
        )
        .orderBy(desc(tasks.completed_at));

      const cycleTimes = completedTasks.map((t) => {
        const leadTimeMs = t.completed_at!.getTime() - t.created_at.getTime();
        const leadTimeDays = leadTimeMs / (1000 * 60 * 60 * 24);
        return {
          task_id: t.id,
          human_id: t.human_id,
          title: t.title,
          story_points: t.story_points,
          lead_time_days: Math.round(leadTimeDays * 10) / 10,
          created_at: t.created_at.toISOString(),
          completed_at: t.completed_at!.toISOString(),
        };
      });

      const avgLeadTime =
        cycleTimes.length > 0
          ? Math.round(
              (cycleTimes.reduce((sum, t) => sum + t.lead_time_days, 0) /
                cycleTimes.length) *
                10,
            ) / 10
          : 0;

      const medianLeadTime =
        cycleTimes.length > 0
          ? (() => {
              const sorted = [...cycleTimes].sort(
                (a, b) => a.lead_time_days - b.lead_time_days,
              );
              const mid = Math.floor(sorted.length / 2);
              return sorted.length % 2 !== 0
                ? sorted[mid]!.lead_time_days
                : Math.round(
                    ((sorted[mid - 1]!.lead_time_days + sorted[mid]!.lead_time_days) / 2) * 10,
                  ) / 10;
            })()
          : 0;

      return reply.send({
        data: {
          tasks: cycleTimes,
          summary: {
            total_completed: cycleTimes.length,
            average_lead_time_days: avgLeadTime,
            median_lead_time_days: medianLeadTime,
          },
        },
      });
    },
  );

  // ── Overdue tasks report ──────────────────────────────────────────────
  fastify.get<{ Params: { id: string } }>(
    '/projects/:id/reports/overdue',
    { preHandler: [requireAuth, requireProjectAccess(), shadowOnly('bam.project_report_overdue.get')] },
    async (request, reply) => {
      const today = new Date().toISOString().split('T')[0]!;

      const overdueTasks = await db
        .select({
          human_id: tasks.human_id,
          title: tasks.title,
          assignee_name: users.display_name,
          due_date: tasks.due_date,
          priority: tasks.priority,
        })
        .from(tasks)
        .leftJoin(users, eq(tasks.assignee_id, users.id))
        .where(
          and(
            eq(tasks.project_id, request.params.id),
            isNotNull(tasks.due_date),
            lt(tasks.due_date, today),
            sql`${tasks.completed_at} IS NULL`,
          ),
        )
        .orderBy(asc(tasks.due_date));

      const data = overdueTasks.map((t) => {
        const dueDate = new Date(t.due_date!);
        const now = new Date();
        const diffMs = now.getTime() - dueDate.getTime();
        const daysOverdue = Math.floor(diffMs / (1000 * 60 * 60 * 24));

        return {
          human_id: t.human_id,
          title: t.title,
          assignee_name: t.assignee_name ?? null,
          due_date: t.due_date,
          days_overdue: daysOverdue,
          priority: t.priority,
        };
      });

      // Sort by days_overdue descending
      data.sort((a, b) => b.days_overdue - a.days_overdue);

      return reply.send({ data });
    },
  );

  // ── Workload report ───────────────────────────────────────────────────
  fastify.get<{ Params: { id: string } }>(
    '/projects/:id/reports/workload',
    { preHandler: [requireAuth, requireProjectAccess(), shadowOnly('bam.project_report_workload.get')] },
    async (request, reply) => {
      const projectTasks = await db
        .select({
          assignee_id: tasks.assignee_id,
          display_name: users.display_name,
          story_points: tasks.story_points,
          priority: tasks.priority,
        })
        .from(tasks)
        .leftJoin(users, eq(tasks.assignee_id, users.id))
        .where(
          and(
            eq(tasks.project_id, request.params.id),
            sql`${tasks.completed_at} IS NULL`,
          ),
        );

      const workloadMap = new Map<string, {
        user_id: string;
        display_name: string;
        task_count: number;
        total_points: number;
        by_priority: Record<string, number>;
      }>();

      for (const t of projectTasks) {
        const uid = t.assignee_id ?? 'unassigned';
        const name = t.display_name ?? 'Unassigned';

        if (!workloadMap.has(uid)) {
          workloadMap.set(uid, {
            user_id: uid,
            display_name: name,
            task_count: 0,
            total_points: 0,
            by_priority: { critical: 0, high: 0, medium: 0, low: 0 },
          });
        }

        const entry = workloadMap.get(uid)!;
        entry.task_count++;
        entry.total_points += t.story_points ?? 0;
        entry.by_priority[t.priority] = (entry.by_priority[t.priority] ?? 0) + 1;
      }

      return reply.send({ data: Array.from(workloadMap.values()) });
    },
  );

  // ── Time tracking report ──────────────────────────────────────────────
  fastify.get<{
    Params: { id: string };
    Querystring: { from?: string; to?: string };
  }>(
    '/projects/:id/reports/time-tracking',
    { preHandler: [requireAuth, requireProjectAccess(), shadowOnly('bam.project_report_time_tracking.get')] },
    async (request, reply) => {
      const conditions = [
        sql`${timeEntries.task_id} IN (SELECT id FROM tasks WHERE project_id = ${request.params.id})`,
      ];

      if (request.query.from) {
        conditions.push(gte(timeEntries.date, request.query.from));
      }
      if (request.query.to) {
        conditions.push(lte(timeEntries.date, request.query.to));
      }

      const entries = await db
        .select({
          user_id: timeEntries.user_id,
          display_name: users.display_name,
          minutes: timeEntries.minutes,
          date: timeEntries.date,
        })
        .from(timeEntries)
        .innerJoin(users, eq(timeEntries.user_id, users.id))
        .where(and(...conditions));

      // Aggregate by user and week
      const userMap = new Map<string, {
        user_id: string;
        display_name: string;
        weeks: Map<string, number>;
        total_minutes: number;
      }>();

      for (const entry of entries) {
        if (!userMap.has(entry.user_id)) {
          userMap.set(entry.user_id, {
            user_id: entry.user_id,
            display_name: entry.display_name,
            weeks: new Map(),
            total_minutes: 0,
          });
        }

        const userData = userMap.get(entry.user_id)!;
        userData.total_minutes += entry.minutes;

        // Calculate week start (Monday)
        const d = new Date(entry.date);
        const day = d.getDay();
        const diff = d.getDate() - day + (day === 0 ? -6 : 1);
        const weekStart = new Date(d.setDate(diff)).toISOString().split('T')[0]!;

        userData.weeks.set(weekStart, (userData.weeks.get(weekStart) ?? 0) + entry.minutes);
      }

      const data = Array.from(userMap.values()).map((u) => ({
        user_id: u.user_id,
        display_name: u.display_name,
        weeks: Array.from(u.weeks.entries())
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([week_start, minutes]) => ({ week_start, minutes })),
        total_minutes: u.total_minutes,
      }));

      return reply.send({ data });
    },
  );

  // ── Status distribution report ────────────────────────────────────────
  fastify.get<{ Params: { id: string } }>(
    '/projects/:id/reports/status-distribution',
    { preHandler: [requireAuth, requireProjectAccess(), shadowOnly('bam.project_report_status_distribution.get')] },
    async (request, reply) => {
      const projectId = request.params.id;

      // By phase
      const byPhaseResult = await db
        .select({
          name: phases.name,
          count: sql<number>`count(*)::int`,
        })
        .from(tasks)
        .innerJoin(phases, eq(tasks.phase_id, phases.id))
        .where(eq(tasks.project_id, projectId))
        .groupBy(phases.name);

      // By priority
      const byPriorityResult = await db
        .select({
          name: tasks.priority,
          count: sql<number>`count(*)::int`,
        })
        .from(tasks)
        .where(eq(tasks.project_id, projectId))
        .groupBy(tasks.priority);

      // By state (open vs completed)
      const allTasks = await db
        .select({
          completed_at: tasks.completed_at,
        })
        .from(tasks)
        .where(eq(tasks.project_id, projectId));

      const openCount = allTasks.filter((t) => !t.completed_at).length;
      const closedCount = allTasks.filter((t) => t.completed_at).length;

      return reply.send({
        data: {
          by_phase: byPhaseResult,
          by_priority: byPriorityResult,
          by_state: [
            { name: 'open', count: openCount },
            { name: 'closed', count: closedCount },
          ],
        },
      });
    },
  );
}

import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { z } from 'zod';
import type { TaskLink } from '@bigbluebam/shared';
import { db } from '../db/index.js';
import { tasks } from '../db/schema/tasks.js';
import { requireAuth } from '../plugins/auth.js';
import { requireProjectAccess } from '../middleware/authorize.js';
import { shadowOnly } from '../middleware/dual-read.js';

/**
 * Format tasks.links for the CSV export: "title <url>" per entry (just the
 * url when untitled), joined by "; " so round-trips don't lose links
 * (CSV-import plan §4.2).
 */
function formatLinksForCsv(raw: unknown): string {
  if (!Array.isArray(raw)) return '';
  return (raw as TaskLink[])
    .map((link) => (link.title ? `${link.title} <${link.url}>` : link.url))
    .join('; ');
}

export default async function exportRoutes(fastify: FastifyInstance) {
  fastify.post<{ Params: { id: string } }>(
    '/projects/:id/export',
    { preHandler: [requireAuth, requireProjectAccess(), shadowOnly('bam.project.export')], config: { rateLimit: { max: 3, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const schema = z.object({
        format: z.enum(['json', 'csv']),
        sprint_id: z.string().uuid().optional(),
      });
      const data = schema.parse(request.body);

      const conditions = [eq(tasks.project_id, request.params.id)];
      if (data.sprint_id) {
        conditions.push(eq(tasks.sprint_id, data.sprint_id));
      }

      const projectTasks = await db
        .select()
        .from(tasks)
        .where(and(...conditions))
        .limit(50000);

      if (data.format === 'json') {
        return reply.send({
          data: {
            format: 'json',
            task_count: projectTasks.length,
            tasks: projectTasks,
          },
        });
      }

      // CSV format
      if (projectTasks.length === 0) {
        return reply.send({
          data: {
            format: 'csv',
            task_count: 0,
            content: '',
          },
        });
      }

      const headers = [
        'id',
        'human_id',
        'title',
        'priority',
        'story_points',
        'phase_id',
        'state_id',
        'sprint_id',
        'assignee_id',
        'reporter_id',
        'created_at',
        'completed_at',
        'links',
      ];

      const csvRows = [headers.join(',')];
      for (const task of projectTasks) {
        const row = [
          task.id,
          task.human_id,
          `"${(task.title ?? '').replace(/"/g, '""')}"`,
          task.priority,
          task.story_points ?? '',
          task.phase_id ?? '',
          task.state_id ?? '',
          task.sprint_id ?? '',
          task.assignee_id ?? '',
          task.reporter_id ?? '',
          task.created_at.toISOString(),
          task.completed_at?.toISOString() ?? '',
          `"${formatLinksForCsv(task.links).replace(/"/g, '""')}"`,
        ];
        csvRows.push(row.join(','));
      }

      return reply.send({
        data: {
          format: 'csv',
          task_count: projectTasks.length,
          content: csvRows.join('\n'),
        },
      });
    },
  );
}

import type { FastifyInstance } from 'fastify';
import { eq, and, asc } from 'drizzle-orm';
import { z } from 'zod';
import type { TaskLink } from '@bigbluebam/shared';
import { db } from '../db/index.js';
import { tasks } from '../db/schema/tasks.js';
import { customFieldDefinitions } from '../db/schema/custom-fields.js';
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

/** Quote a CSV cell: wrap in double-quotes and double any embedded quotes. */
function csvQuote(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * Render one custom-field value (from tasks.custom_fields JSONB) as a flat CSV
 * cell that the importer can read straight back into a value cell. Arrays
 * (multi_select) join with "; "; booleans (checkbox) emit "true"/"false";
 * null/undefined emit empty (the skip-empty rule applies on re-import).
 */
function formatCustomFieldForCsv(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map((v) => String(v)).join('; ');
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
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

      // Lossless round-trip (CSV-import plan §5.7, Phase 3): the export carries
      // a human_id column (so re-import with duplicate_strategy:'update' matches
      // on it) plus the links column AND one column per custom-field definition,
      // headed `cf:<name>`. The importer maps `cf:<name>` columns back via
      // custom_field_mapping (field_name = the part after `cf:`), and human_id
      // back via mapping.human_id. Header names here are exactly what the
      // importer can map.
      const cfDefs = await db
        .select({ id: customFieldDefinitions.id, name: customFieldDefinitions.name })
        .from(customFieldDefinitions)
        .where(eq(customFieldDefinitions.project_id, request.params.id))
        .orderBy(asc(customFieldDefinitions.position));

      // tasks.custom_fields is canonically keyed by definition id (see the task
      // drawer write path), with a legacy name-keyed fallback. Read both.
      const cfValueOf = (cf: Record<string, unknown>, def: { id: string; name: string }) =>
        cf[def.id] ?? cf[def.name];

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
        ...cfDefs.map((d) => `cf:${d.name}`),
      ];

      const csvRows = [headers.map((h) => csvQuote(h)).join(',')];
      for (const task of projectTasks) {
        const customFields = (task.custom_fields ?? {}) as Record<string, unknown>;
        const row = [
          task.id,
          task.human_id,
          csvQuote(task.title ?? ''),
          task.priority,
          task.story_points ?? '',
          task.phase_id ?? '',
          task.state_id ?? '',
          task.sprint_id ?? '',
          task.assignee_id ?? '',
          task.reporter_id ?? '',
          task.created_at.toISOString(),
          task.completed_at?.toISOString() ?? '',
          csvQuote(formatLinksForCsv(task.links)),
          // Custom fields keyed by definition id in the JSONB blob (with a
          // legacy name-keyed fallback). Quote each so values containing
          // commas/quotes survive the round-trip.
          ...cfDefs.map((d) => csvQuote(formatCustomFieldForCsv(cfValueOf(customFields, d)))),
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

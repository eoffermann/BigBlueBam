import type { FastifyInstance } from 'fastify';
import { eq, and, sql, asc } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { tasks } from '../db/schema/tasks.js';
import { phases } from '../db/schema/phases.js';
import { labels } from '../db/schema/labels.js';
import { users } from '../db/schema/users.js';
import { sprints } from '../db/schema/sprints.js';
import { projects } from '../db/schema/projects.js';
import { comments } from '../db/schema/comments.js';
import { requireAuth, requireMinRole, requireScope } from '../plugins/auth.js';
import { requireProjectRole } from '../middleware/authorize.js';
import { dualReadGate } from '../middleware/dual-read.js';

// ── helpers ─────────────────────────────────────────────────────────────

async function findOrCreatePhase(projectId: string, name: string) {
  const [existing] = await db
    .select()
    .from(phases)
    .where(and(eq(phases.project_id, projectId), eq(phases.name, name)))
    .limit(1);

  if (existing) return existing;

  const maxPos = await db
    .select({ max: sql<number>`coalesce(max(${phases.position}), 0)` })
    .from(phases)
    .where(eq(phases.project_id, projectId));

  const [created] = await db
    .insert(phases)
    .values({
      project_id: projectId,
      name,
      position: (maxPos[0]?.max ?? 0) + 1,
    })
    .returning();

  return created!;
}

async function findOrCreateLabel(projectId: string, name: string, color?: string) {
  const [existing] = await db
    .select()
    .from(labels)
    .where(and(eq(labels.project_id, projectId), eq(labels.name, name)))
    .limit(1);

  if (existing) return existing;

  const [created] = await db
    .insert(labels)
    .values({
      project_id: projectId,
      name,
      color: color ?? null,
    })
    .returning();

  return created!;
}

async function findUserByEmail(email: string) {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, email.toLowerCase().trim()))
    .limit(1);

  return user ?? null;
}

async function findOrCreateSprint(projectId: string, name: string) {
  const [existing] = await db
    .select()
    .from(sprints)
    .where(and(eq(sprints.project_id, projectId), eq(sprints.name, name)))
    .limit(1);

  if (existing) return existing;

  const [created] = await db
    .insert(sprints)
    .values({
      project_id: projectId,
      name,
    })
    .returning();

  return created!;
}

async function getDefaultPhase(projectId: string) {
  const [phase] = await db
    .select()
    .from(phases)
    .where(and(eq(phases.project_id, projectId), eq(phases.is_start, true)))
    .limit(1);

  if (phase) return phase;

  // Fallback: first phase by position
  const [first] = await db
    .select()
    .from(phases)
    .where(eq(phases.project_id, projectId))
    .orderBy(asc(phases.position))
    .limit(1);

  return first ?? null;
}

async function generateHumanId(projectId: string): Promise<string> {
  const [updated] = await db
    .update(projects)
    .set({
      task_id_sequence: sql`${projects.task_id_sequence} + 1`,
    })
    .where(eq(projects.id, projectId))
    .returning({
      task_id_prefix: projects.task_id_prefix,
      task_id_sequence: projects.task_id_sequence,
    });

  if (!updated) throw new Error('Project not found');
  return `${updated.task_id_prefix}-${updated.task_id_sequence}`;
}

async function getNextPosition(phaseId: string): Promise<number> {
  const result = await db
    .select({ maxPos: sql<number>`coalesce(max(${tasks.position}), 0)` })
    .from(tasks)
    .where(eq(tasks.phase_id, phaseId));

  return (result[0]?.maxPos ?? 0) + 1024;
}

// ── priority mapping ────────────────────────────────────────────────────

const JIRA_PRIORITY_MAP: Record<string, string> = {
  'Highest': 'critical',
  'High': 'high',
  'Medium': 'medium',
  'Low': 'low',
  'Lowest': 'low',
};

const VALID_PRIORITIES = ['critical', 'high', 'medium', 'low'];

function normalizePriority(value: string | undefined | null): string {
  if (!value) return 'medium';
  const lower = value.toLowerCase().trim();
  if (VALID_PRIORITIES.includes(lower)) return lower;
  return JIRA_PRIORITY_MAP[value] ?? 'medium';
}

// ── routes ──────────────────────────────────────────────────────────────

export default async function importRoutes(fastify: FastifyInstance) {
  // ── POST /projects/:id/import/csv ─────────────────────────────────────
  fastify.post<{ Params: { id: string } }>(
    '/projects/:id/import/csv',
    { preHandler: [requireAuth, dualReadGate({ legacy: requireMinRole('member'), permission: 'bam.project_import_csv.create' }), requireScope('read_write'), requireProjectRole('admin', 'member')] },
    async (request, reply) => {
      const bodySchema = z.object({
        rows: z.array(z.record(z.string())).max(5000),
        mapping: z.record(z.string()),
      });

      const { rows, mapping } = bodySchema.parse(request.body);
      const projectId = request.params.id;
      const userId = request.user!.id;

      if (!mapping.title) {
        return reply.status(400).send({
          error: {
            code: 'BAD_REQUEST',
            message: 'mapping.title is required',
            details: [],
            request_id: request.id,
          },
        });
      }

      const defaultPhase = await getDefaultPhase(projectId);
      if (!defaultPhase) {
        return reply.status(400).send({
          error: {
            code: 'BAD_REQUEST',
            message: 'Project has no phases configured',
            details: [],
            request_id: request.id,
          },
        });
      }

      let imported = 0;
      let skipped = 0;
      const errors: string[] = [];

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]!;
        try {
          const title = row[mapping.title!]?.trim();
          if (!title) {
            skipped++;
            errors.push(`Row ${i + 1}: missing title`);
            continue;
          }

          // Resolve phase
          let phaseId = defaultPhase.id;
          if (mapping.phase_name && row[mapping.phase_name]) {
            const phase = await findOrCreatePhase(projectId, row[mapping.phase_name]!.trim());
            phaseId = phase.id;
          }

          // Resolve assignee
          let assigneeId: string | null = null;
          if (mapping.assignee_email && row[mapping.assignee_email]) {
            const user = await findUserByEmail(row[mapping.assignee_email]!);
            if (user) assigneeId = user.id;
          }

          // Resolve labels
          let labelIds: string[] = [];
          if (mapping.labels && row[mapping.labels]) {
            const labelNames = row[mapping.labels]!.split(',').map((l) => l.trim()).filter(Boolean);
            for (const name of labelNames) {
              const label = await findOrCreateLabel(projectId, name);
              labelIds.push(label.id);
            }
          }

          const humanId = await generateHumanId(projectId);
          const position = await getNextPosition(phaseId);

          await db.insert(tasks).values({
            project_id: projectId,
            human_id: humanId,
            title,
            description: mapping.description ? (row[mapping.description] ?? null) : null,
            phase_id: phaseId,
            assignee_id: assigneeId,
            reporter_id: userId,
            priority: normalizePriority(mapping.priority ? row[mapping.priority] : undefined),
            story_points: mapping.story_points && row[mapping.story_points]
              ? parseInt(row[mapping.story_points]!, 10) || null
              : null,
            due_date: mapping.due_date && row[mapping.due_date]
              ? row[mapping.due_date]!
              : null,
            labels: labelIds,
            position,
          });

          imported++;
        } catch (err) {
          skipped++;
          errors.push(`Row ${i + 1}: ${err instanceof Error ? err.message : 'Unknown error'}`);
        }
      }

      return reply.send({ data: { imported, skipped, errors } });
    },
  );

  // ── POST /projects/:id/import/trello ──────────────────────────────────
  fastify.post<{ Params: { id: string } }>(
    '/projects/:id/import/trello',
    { preHandler: [requireAuth, dualReadGate({ legacy: requireMinRole('member'), permission: 'bam.project_import_trello.create' }), requireScope('read_write'), requireProjectRole('admin', 'member')] },
    async (request, reply) => {
      const bodySchema = z.object({
        lists: z.array(z.object({
          name: z.string(),
          cards: z.array(z.object({
            name: z.string(),
            desc: z.string().optional().default(''),
            labels: z.array(z.object({
              name: z.string().optional().default(''),
              color: z.string().optional(),
            })).optional().default([]),
            due: z.string().nullable().optional(),
            checklists: z.array(z.object({
              checkItems: z.array(z.object({
                name: z.string(),
                state: z.string().optional(),
              })).optional().default([]),
            })).optional().default([]),
            idMembers: z.array(z.string()).optional().default([]),
          })).max(100),
        })).max(5000),
      });

      const { lists } = bodySchema.parse(request.body);
      const projectId = request.params.id;
      const userId = request.user!.id;

      let imported = 0;
      let skipped = 0;
      const errors: string[] = [];

      for (const list of lists) {
        try {
          const phase = await findOrCreatePhase(projectId, list.name);

          for (const card of list.cards) {
            try {
              if (!card.name.trim()) {
                skipped++;
                continue;
              }

              // Resolve labels
              const labelIds: string[] = [];
              for (const lbl of card.labels) {
                if (lbl.name) {
                  const label = await findOrCreateLabel(projectId, lbl.name, lbl.color);
                  labelIds.push(label.id);
                }
              }

              const humanId = await generateHumanId(projectId);
              const position = await getNextPosition(phase.id);

              const [task] = await db.insert(tasks).values({
                project_id: projectId,
                human_id: humanId,
                title: card.name.trim(),
                description: card.desc || null,
                phase_id: phase.id,
                reporter_id: userId,
                priority: 'medium',
                due_date: card.due ? card.due.split('T')[0]! : null,
                labels: labelIds,
                position,
              }).returning();

              // Create subtasks from checklists
              if (task) {
                let subtaskCount = 0;
                let subtaskDoneCount = 0;
                for (const checklist of card.checklists) {
                  for (const item of checklist.checkItems) {
                    const subHumanId = await generateHumanId(projectId);
                    const subPosition = await getNextPosition(phase.id);
                    const isDone = item.state === 'complete';

                    await db.insert(tasks).values({
                      project_id: projectId,
                      human_id: subHumanId,
                      parent_task_id: task.id,
                      title: item.name,
                      phase_id: phase.id,
                      reporter_id: userId,
                      priority: 'medium',
                      position: subPosition,
                      completed_at: isDone ? new Date() : null,
                    });

                    subtaskCount++;
                    if (isDone) subtaskDoneCount++;
                  }
                }

                if (subtaskCount > 0) {
                  await db.update(tasks).set({
                    subtask_count: subtaskCount,
                    subtask_done_count: subtaskDoneCount,
                  }).where(eq(tasks.id, task.id));
                }
              }

              imported++;
            } catch (err) {
              skipped++;
              errors.push(`Card "${card.name}": ${err instanceof Error ? err.message : 'Unknown error'}`);
            }
          }
        } catch (err) {
          errors.push(`List "${list.name}": ${err instanceof Error ? err.message : 'Unknown error'}`);
        }
      }

      return reply.send({ data: { imported, skipped, errors } });
    },
  );

  // ── POST /projects/:id/import/jira ────────────────────────────────────
  fastify.post<{ Params: { id: string } }>(
    '/projects/:id/import/jira',
    { preHandler: [requireAuth, dualReadGate({ legacy: requireMinRole('member'), permission: 'bam.project_import_jira.create' }), requireScope('read_write'), requireProjectRole('admin', 'member')] },
    async (request, reply) => {
      const bodySchema = z.object({
        rows: z.array(z.record(z.string())).max(5000),
      });

      const { rows } = bodySchema.parse(request.body);
      const projectId = request.params.id;
      const userId = request.user!.id;

      const defaultPhase = await getDefaultPhase(projectId);
      if (!defaultPhase) {
        return reply.status(400).send({
          error: {
            code: 'BAD_REQUEST',
            message: 'Project has no phases configured',
            details: [],
            request_id: request.id,
          },
        });
      }

      let imported = 0;
      let skipped = 0;
      const errors: string[] = [];

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]!;
        try {
          const title = row['Summary']?.trim();
          if (!title) {
            skipped++;
            errors.push(`Row ${i + 1}: missing Summary`);
            continue;
          }

          // Phase from Status
          let phaseId = defaultPhase.id;
          if (row['Status']) {
            const phase = await findOrCreatePhase(projectId, row['Status'].trim());
            phaseId = phase.id;
          }

          // Assignee
          let assigneeId: string | null = null;
          if (row['Assignee']) {
            const user = await findUserByEmail(row['Assignee']);
            if (user) assigneeId = user.id;
          }

          // Label from Issue Type
          const labelIds: string[] = [];
          if (row['Issue Type']) {
            const label = await findOrCreateLabel(projectId, row['Issue Type'].trim());
            labelIds.push(label.id);
          }

          // Sprint
          let sprintId: string | null = null;
          if (row['Sprint']) {
            const sprint = await findOrCreateSprint(projectId, row['Sprint'].trim());
            sprintId = sprint.id;
          }

          const humanId = await generateHumanId(projectId);
          const position = await getNextPosition(phaseId);

          await db.insert(tasks).values({
            project_id: projectId,
            human_id: humanId,
            title,
            description: row['Description'] ?? null,
            phase_id: phaseId,
            sprint_id: sprintId,
            assignee_id: assigneeId,
            reporter_id: userId,
            priority: normalizePriority(row['Priority']),
            story_points: row['Story Points'] ? parseInt(row['Story Points']!, 10) || null : null,
            labels: labelIds,
            position,
          });

          imported++;
        } catch (err) {
          skipped++;
          errors.push(`Row ${i + 1}: ${err instanceof Error ? err.message : 'Unknown error'}`);
        }
      }

      return reply.send({ data: { imported, skipped, errors } });
    },
  );

  // ── POST /projects/:id/import/github ──────────────────────────────────
  fastify.post<{ Params: { id: string } }>(
    '/projects/:id/import/github',
    { preHandler: [requireAuth, dualReadGate({ legacy: requireMinRole('member'), permission: 'bam.project_import_github.create' }), requireScope('read_write'), requireProjectRole('admin', 'member')] },
    async (request, reply) => {
      const bodySchema = z.object({
        issues: z.array(z.object({
          title: z.string(),
          body: z.string().nullable().optional(),
          labels: z.array(z.object({ name: z.string() })).optional().default([]),
          assignees: z.array(z.object({ login: z.string() })).optional().default([]),
          state: z.string().optional().default('open'),
          milestone: z.object({ title: z.string() }).nullable().optional(),
          comments: z.array(z.object({
            body: z.string(),
            user: z.object({ login: z.string() }).optional(),
          })).max(100).optional().default([]),
        })).max(5000),
      });

      const { issues } = bodySchema.parse(request.body);
      const projectId = request.params.id;
      const userId = request.user!.id;

      const defaultPhase = await getDefaultPhase(projectId);
      if (!defaultPhase) {
        return reply.status(400).send({
          error: {
            code: 'BAD_REQUEST',
            message: 'Project has no phases configured',
            details: [],
            request_id: request.id,
          },
        });
      }

      let imported = 0;
      let skipped = 0;
      const errors: string[] = [];

      for (let i = 0; i < issues.length; i++) {
        const issue = issues[i]!;
        try {
          if (!issue.title.trim()) {
            skipped++;
            errors.push(`Issue ${i + 1}: missing title`);
            continue;
          }

          // Labels
          const labelIds: string[] = [];
          for (const lbl of issue.labels) {
            const label = await findOrCreateLabel(projectId, lbl.name);
            labelIds.push(label.id);
          }

          // Assignee (try first assignee by login as email)
          let assigneeId: string | null = null;
          if (issue.assignees.length > 0) {
            // Try to find user by email matching the login
            const user = await findUserByEmail(issue.assignees[0]!.login);
            if (user) assigneeId = user.id;
          }

          // Sprint from milestone
          let sprintId: string | null = null;
          if (issue.milestone?.title) {
            const sprint = await findOrCreateSprint(projectId, issue.milestone.title);
            sprintId = sprint.id;
          }

          const humanId = await generateHumanId(projectId);
          const position = await getNextPosition(defaultPhase.id);

          const [task] = await db.insert(tasks).values({
            project_id: projectId,
            human_id: humanId,
            title: issue.title.trim(),
            description: issue.body ?? null,
            phase_id: defaultPhase.id,
            sprint_id: sprintId,
            assignee_id: assigneeId,
            reporter_id: userId,
            priority: 'medium',
            labels: labelIds,
            position,
            completed_at: issue.state === 'closed' ? new Date() : null,
          }).returning();

          // Import comments
          if (task && issue.comments.length > 0) {
            for (const comment of issue.comments) {
              await db.insert(comments).values({
                task_id: task.id,
                author_id: userId,
                body: comment.body,
              });
            }

            await db.update(tasks).set({
              comment_count: issue.comments.length,
            }).where(eq(tasks.id, task.id));
          }

          imported++;
        } catch (err) {
          skipped++;
          errors.push(`Issue ${i + 1}: ${err instanceof Error ? err.message : 'Unknown error'}`);
        }
      }

      return reply.send({ data: { imported, skipped, errors } });
    },
  );
}

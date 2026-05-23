import type { FastifyRequest, FastifyReply } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { projectMemberships } from '../db/schema/project-memberships.js';
import { projects } from '../db/schema/projects.js';
import { tasks } from '../db/schema/tasks.js';
import { sprints } from '../db/schema/sprints.js';
import { phases } from '../db/schema/phases.js';
import { labels } from '../db/schema/labels.js';
import { epics } from '../db/schema/epics.js';
import { customFieldDefinitions } from '../db/schema/custom-fields.js';
import { taskTemplates } from '../db/schema/task-templates.js';
import { webhooks } from '../db/schema/webhooks.js';
import { comments } from '../db/schema/comments.js';
import { attachments } from '../db/schema/attachments.js';
import { savedViews } from '../db/schema/saved-views.js';
import { commentReactions } from '../db/schema/comment-reactions.js';

// ── Entity → project_id resolution tables ──────────────────────────────

type EntityType =
  | 'task'
  | 'sprint'
  | 'phase'
  | 'label'
  | 'epic'
  | 'custom_field'
  | 'task_template'
  | 'webhook'
  | 'comment'
  | 'attachment'
  | 'saved_view'
  | 'comment_reaction';

/**
 * Given an entity type and its ID, resolve the project_id.
 * For comments and attachments, we first resolve the task_id, then the project_id.
 * For comment_reactions, we resolve comment -> task -> project.
 */
async function resolveProjectId(
  entityType: EntityType,
  entityId: string,
): Promise<string | null> {
  switch (entityType) {
    case 'task': {
      const [row] = await db.select({ project_id: tasks.project_id }).from(tasks).where(eq(tasks.id, entityId)).limit(1);
      return row?.project_id ?? null;
    }
    case 'sprint': {
      const [row] = await db.select({ project_id: sprints.project_id }).from(sprints).where(eq(sprints.id, entityId)).limit(1);
      return row?.project_id ?? null;
    }
    case 'phase': {
      const [row] = await db.select({ project_id: phases.project_id }).from(phases).where(eq(phases.id, entityId)).limit(1);
      return row?.project_id ?? null;
    }
    case 'label': {
      const [row] = await db.select({ project_id: labels.project_id }).from(labels).where(eq(labels.id, entityId)).limit(1);
      return row?.project_id ?? null;
    }
    case 'epic': {
      const [row] = await db.select({ project_id: epics.project_id }).from(epics).where(eq(epics.id, entityId)).limit(1);
      return row?.project_id ?? null;
    }
    case 'custom_field': {
      const [row] = await db.select({ project_id: customFieldDefinitions.project_id }).from(customFieldDefinitions).where(eq(customFieldDefinitions.id, entityId)).limit(1);
      return row?.project_id ?? null;
    }
    case 'task_template': {
      const [row] = await db.select({ project_id: taskTemplates.project_id }).from(taskTemplates).where(eq(taskTemplates.id, entityId)).limit(1);
      return row?.project_id ?? null;
    }
    case 'webhook': {
      const [row] = await db.select({ project_id: webhooks.project_id }).from(webhooks).where(eq(webhooks.id, entityId)).limit(1);
      return row?.project_id ?? null;
    }
    case 'comment': {
      const [row] = await db
        .select({ project_id: tasks.project_id })
        .from(comments)
        .innerJoin(tasks, eq(comments.task_id, tasks.id))
        .where(eq(comments.id, entityId))
        .limit(1);
      return row?.project_id ?? null;
    }
    case 'attachment': {
      const [row] = await db
        .select({ project_id: tasks.project_id })
        .from(attachments)
        .innerJoin(tasks, eq(attachments.task_id, tasks.id))
        .where(eq(attachments.id, entityId))
        .limit(1);
      return row?.project_id ?? null;
    }
    case 'saved_view': {
      const [row] = await db.select({ project_id: savedViews.project_id }).from(savedViews).where(eq(savedViews.id, entityId)).limit(1);
      return row?.project_id ?? null;
    }
    case 'comment_reaction': {
      const [row] = await db
        .select({ project_id: tasks.project_id })
        .from(commentReactions)
        .innerJoin(comments, eq(commentReactions.comment_id, comments.id))
        .innerJoin(tasks, eq(comments.task_id, tasks.id))
        .where(eq(commentReactions.id, entityId))
        .limit(1);
      return row?.project_id ?? null;
    }
    default:
      return null;
  }
}

/**
 * Middleware factory that verifies the user has membership in the project
 * that owns the entity referenced by `:paramName` in the URL.
 *
 * Returns 404 (not 403) when access is denied — prevents enumeration.
 * SuperUsers bypass the check (consistent with other middleware).
 *
 * Caches the resolved project_id on `request.resolvedProjectId` so
 * downstream handlers can use it without re-querying.
 */
export function requireProjectAccessForEntity(
  entityType: EntityType,
  paramName: string = 'id',
) {
  return async function checkProjectAccessForEntity(
    request: FastifyRequest,
    reply: FastifyReply,
  ) {
    if (!request.user) {
      return reply.status(401).send({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
          details: [],
          request_id: request.id,
        },
      });
    }

    if (request.user.is_superuser) return;

    const params = request.params as Record<string, string>;
    const entityId = params?.[paramName];

    if (!entityId) {
      return reply.status(400).send({
        error: {
          code: 'BAD_REQUEST',
          message: `Missing parameter: ${paramName}`,
          details: [],
          request_id: request.id,
        },
      });
    }

    const projectId = await resolveProjectId(entityType, entityId);

    if (!projectId) {
      // Entity does not exist — return 404
      return reply.status(404).send({
        error: {
          code: 'NOT_FOUND',
          message: 'Resource not found',
          details: [],
          request_id: request.id,
        },
      });
    }

    // Verify project belongs to user's org
    const [project] = await db
      .select({ org_id: projects.org_id })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);

    if (!project || project.org_id !== request.user.org_id) {
      return reply.status(404).send({
        error: {
          code: 'NOT_FOUND',
          message: 'Resource not found',
          details: [],
          request_id: request.id,
        },
      });
    }

    // Verify user has membership in this project
    const [membership] = await db
      .select({ user_id: projectMemberships.user_id })
      .from(projectMemberships)
      .where(
        and(
          eq(projectMemberships.project_id, projectId),
          eq(projectMemberships.user_id, request.user.id),
        ),
      )
      .limit(1);

    if (!membership) {
      return reply.status(404).send({
        error: {
          code: 'NOT_FOUND',
          message: 'Resource not found',
          details: [],
          request_id: request.id,
        },
      });
    }

    // Cache for downstream use
    (request as any).resolvedProjectId = projectId;
  };
}

/**
 * Middleware that verifies the user has membership in the project referenced
 * by `:paramName` (default `:id`) and that the project belongs to the user's org.
 *
 * Use this for project-scoped routes like GET /projects/:id/tasks.
 * Membership-only check (no role required). Returns 404 on denial (anti-enumeration).
 */
export function requireProjectAccess(paramName: string = 'id') {
  return async function checkProjectAccess(
    request: FastifyRequest,
    reply: FastifyReply,
  ) {
    if (!request.user) {
      return reply.status(401).send({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
          details: [],
          request_id: request.id,
        },
      });
    }

    if (request.user.is_superuser) return;

    const params = request.params as Record<string, string>;
    const projectId = params?.[paramName];

    if (!projectId) {
      return reply.status(400).send({
        error: {
          code: 'BAD_REQUEST',
          message: `Missing parameter: ${paramName}`,
          details: [],
          request_id: request.id,
        },
      });
    }

    // Verify project belongs to user's org
    const [project] = await db
      .select({ org_id: projects.org_id })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);

    if (!project || project.org_id !== request.user.org_id) {
      return reply.status(404).send({
        error: {
          code: 'NOT_FOUND',
          message: 'Project not found',
          details: [],
          request_id: request.id,
        },
      });
    }

    // Verify user has membership in this project
    const [membership] = await db
      .select({ user_id: projectMemberships.user_id })
      .from(projectMemberships)
      .where(
        and(
          eq(projectMemberships.project_id, projectId),
          eq(projectMemberships.user_id, request.user.id),
        ),
      )
      .limit(1);

    if (!membership) {
      return reply.status(404).send({
        error: {
          code: 'NOT_FOUND',
          message: 'Project not found',
          details: [],
          request_id: request.id,
        },
      });
    }
  };
}


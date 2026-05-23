import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { projects } from '../db/schema/projects.js';
import { projectMemberships } from '../db/schema/project-memberships.js';
import { phases } from '../db/schema/phases.js';
import { taskStates } from '../db/schema/task-states.js';
import { sprints } from '../db/schema/sprints.js';
import type { CreateProjectInput, UpdateProjectInput } from '@bigbluebam/shared';
import { logActivity } from './activity.service.js';
import { enqueueNotification } from './notification-fanout.service.js';

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
}

interface KanbanTemplate {
  phases: Array<{
    name: string;
    color: string;
    position: number;
    is_start: boolean;
    is_terminal: boolean;
  }>;
  states: Array<{
    name: string;
    category: string;
    position: number;
  }>;
}

const TEMPLATES: Record<string, KanbanTemplate> = {
  kanban_standard: {
    phases: [
      { name: 'Backlog', color: '#6B7280', position: 0, is_start: true, is_terminal: false },
      { name: 'To Do', color: '#3B82F6', position: 1, is_start: false, is_terminal: false },
      { name: 'In Progress', color: '#F59E0B', position: 2, is_start: false, is_terminal: false },
      { name: 'Review', color: '#8B5CF6', position: 3, is_start: false, is_terminal: false },
      { name: 'Done', color: '#10B981', position: 4, is_start: false, is_terminal: true },
    ],
    states: [
      { name: 'Not Started', category: 'todo', position: 0 },
      { name: 'In Progress', category: 'active', position: 1 },
      { name: 'Blocked', category: 'blocked', position: 2 },
      { name: 'In Review', category: 'review', position: 3 },
      { name: 'Done', category: 'done', position: 4 },
    ],
  },
  scrum: {
    phases: [
      { name: 'Product Backlog', color: '#6B7280', position: 0, is_start: true, is_terminal: false },
      { name: 'Sprint Backlog', color: '#3B82F6', position: 1, is_start: false, is_terminal: false },
      { name: 'In Progress', color: '#F59E0B', position: 2, is_start: false, is_terminal: false },
      { name: 'In Review', color: '#8B5CF6', position: 3, is_start: false, is_terminal: false },
      { name: 'Done', color: '#10B981', position: 4, is_start: false, is_terminal: true },
    ],
    states: [
      { name: 'Not Started', category: 'todo', position: 0 },
      { name: 'In Progress', category: 'active', position: 1 },
      { name: 'Blocked', category: 'blocked', position: 2 },
      { name: 'In Review', category: 'review', position: 3 },
      { name: 'Done', category: 'done', position: 4 },
    ],
  },
  bug_tracking: {
    phases: [
      { name: 'Reported', color: '#EF4444', position: 0, is_start: true, is_terminal: false },
      { name: 'Triaged', color: '#F59E0B', position: 1, is_start: false, is_terminal: false },
      { name: 'In Progress', color: '#3B82F6', position: 2, is_start: false, is_terminal: false },
      { name: 'Fixed', color: '#8B5CF6', position: 3, is_start: false, is_terminal: false },
      { name: 'Verified', color: '#10B981', position: 4, is_start: false, is_terminal: true },
    ],
    states: [
      { name: 'Open', category: 'todo', position: 0 },
      { name: 'Investigating', category: 'active', position: 1 },
      { name: 'Blocked', category: 'blocked', position: 2 },
      { name: 'Fix Applied', category: 'review', position: 3 },
      { name: 'Closed', category: 'done', position: 4 },
    ],
  },
  minimal: {
    phases: [
      { name: 'To Do', color: '#3B82F6', position: 0, is_start: true, is_terminal: false },
      { name: 'In Progress', color: '#F59E0B', position: 1, is_start: false, is_terminal: false },
      { name: 'Done', color: '#10B981', position: 2, is_start: false, is_terminal: true },
    ],
    states: [
      { name: 'Not Started', category: 'todo', position: 0 },
      { name: 'In Progress', category: 'active', position: 1 },
      { name: 'Done', category: 'done', position: 2 },
    ],
  },
};

export async function createProject(orgId: string, data: CreateProjectInput, creatorUserId: string) {
  const slug = data.slug ?? slugify(data.name);
  const template = data.template ?? 'kanban_standard';

  const result = await db.transaction(async (tx) => {
    const [project] = await tx
      .insert(projects)
      .values({
        org_id: orgId,
        name: data.name,
        slug,
        description: data.description ?? null,
        icon: data.icon ?? null,
        color: data.color ?? null,
        task_id_prefix: data.task_id_prefix,
        default_sprint_duration_days: data.default_sprint_duration_days ?? 14,
        created_by: creatorUserId,
      })
      .returning();

    // Add creator as admin member
    await tx.insert(projectMemberships).values({
      project_id: project!.id,
      user_id: creatorUserId,
      role: 'admin',
    });

    // Apply template
    if (template !== 'none') {
      const tmpl = TEMPLATES[template];
      if (tmpl) {
        // Create task states first
        const createdStates = await tx
          .insert(taskStates)
          .values(
            tmpl.states.map((s) => ({
              project_id: project!.id,
              name: s.name,
              category: s.category,
              position: s.position,
            })),
          )
          .returning();

        // Map state names to IDs for auto_state_on_enter
        const stateMap = new Map(createdStates.map((s) => [s.name, s.id]));

        // Create phases with auto_state_on_enter
        const phaseAutoStateMap: Record<string, string | undefined> = {
          'Backlog': 'Not Started',
          'Product Backlog': 'Not Started',
          'To Do': 'Not Started',
          'Sprint Backlog': 'Not Started',
          'Reported': 'Open',
          'Triaged': 'Investigating',
          'In Progress': 'In Progress',
          'Investigating': 'Investigating',
          'Review': 'In Review',
          'In Review': 'In Review',
          'Fixed': 'Fix Applied',
          'Fix Applied': 'Fix Applied',
          'Done': 'Done',
          'Verified': 'Closed',
        };

        await tx.insert(phases).values(
          tmpl.phases.map((p) => ({
            project_id: project!.id,
            name: p.name,
            color: p.color,
            position: p.position,
            is_start: p.is_start,
            is_terminal: p.is_terminal,
            auto_state_on_enter: stateMap.get(phaseAutoStateMap[p.name] ?? '') ?? null,
          })),
        );
      }
    }

    return project!;
  });

  return result;
}

export async function listProjects(
  orgId: string,
  userId: string,
  bypassMembership = false,
) {
  // SuperUsers (bypassMembership=true) see every non-archived project in the
  // org regardless of project_memberships — they are not auto-enrolled as
  // members when context-switching into another org, so a membership join
  // would exclude them. Their `membership_role` is surfaced as 'owner'
  // to match the SuperUser-privilege model used elsewhere in the UI.
  if (bypassMembership) {
    const result = await db
      .select({
        project: projects,
        membership: projectMemberships,
      })
      .from(projects)
      .leftJoin(
        projectMemberships,
        and(
          eq(projects.id, projectMemberships.project_id),
          eq(projectMemberships.user_id, userId),
        ),
      )
      .where(
        and(
          eq(projects.org_id, orgId),
          eq(projects.is_archived, false),
        ),
      )
      .orderBy(projects.name);

    return result.map((r) => ({
      ...r.project,
      membership_role: r.membership?.role ?? 'owner',
    }));
  }

  const result = await db
    .select({
      project: projects,
      membership: projectMemberships,
    })
    .from(projects)
    .innerJoin(projectMemberships, eq(projects.id, projectMemberships.project_id))
    .where(
      and(
        eq(projects.org_id, orgId),
        eq(projectMemberships.user_id, userId),
        eq(projects.is_archived, false),
      ),
    )
    .orderBy(projects.name);

  return result.map((r) => ({
    ...r.project,
    membership_role: r.membership.role,
  }));
}

export async function getProject(projectId: string) {
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  return project ?? null;
}

export async function updateProject(projectId: string, data: UpdateProjectInput) {
  const [project] = await db
    .update(projects)
    .set({
      ...data,
      updated_at: new Date(),
    })
    .where(eq(projects.id, projectId))
    .returning();

  return project ?? null;
}

export async function archiveProject(projectId: string) {
  const [project] = await db
    .update(projects)
    .set({
      is_archived: true,
      updated_at: new Date(),
    })
    .where(eq(projects.id, projectId))
    .returning();

  return project ?? null;
}

export async function getProjectMembers(projectId: string) {
  const { users: usersTable } = await import('../db/schema/users.js');

  const result = await db
    .select({
      id: usersTable.id,
      email: usersTable.email,
      display_name: usersTable.display_name,
      avatar_url: usersTable.avatar_url,
      role: projectMemberships.role,
      joined_at: projectMemberships.joined_at,
      user_role: usersTable.role,
    })
    .from(projectMemberships)
    .innerJoin(usersTable, eq(projectMemberships.user_id, usersTable.id))
    .where(eq(projectMemberships.project_id, projectId))
    .orderBy(usersTable.display_name);

  return result.map(({ user_role, ...rest }) => ({
    ...rest,
    is_guest: user_role === 'guest',
  }));
}

export async function addProjectMember(
  projectId: string,
  userId: string,
  role: string,
  actorId?: string,
) {
  const [membership] = await db
    .insert(projectMemberships)
    .values({
      project_id: projectId,
      user_id: userId,
      role,
    })
    .returning();

  if (actorId) {
    logActivity(projectId, actorId, 'member.added', membership!.id, { user_id: userId, role }).catch(() => {});

    const { users: usersTable } = await import('../db/schema/users.js');
    Promise.all([
      db.select({ name: projects.name }).from(projects).where(eq(projects.id, projectId)).limit(1),
      db.select({ name: usersTable.display_name }).from(usersTable).where(eq(usersTable.id, actorId)).limit(1),
    ]).then(([[project], [actor]]) => {
      const projectName = project?.name ?? 'a project';
      const actorName = actor?.name ?? 'Someone';
      enqueueNotification({
        user_id: userId,
        project_id: projectId,
        type: 'project.member_added',
        category: 'membership_added',
        source_app: 'bbb',
        title: `Added to project: ${projectName}`,
        body: `${actorName} added you to "${projectName}" as ${role}.`,
        deep_link: `/b3/projects/${projectId}`,
      });
    }).catch(() => {});
  }

  return membership!;
}

/**
 * Returns the project's org_id and the list of user_ids with a membership
 * row. Used by the route layer to know which `bbb:user:*:projects` cache
 * keys to invalidate after a project create/update/archive.
 */
export async function getProjectOrgAndMemberIds(
  projectId: string,
): Promise<{ org_id: string; user_ids: string[] } | null> {
  const [project] = await db
    .select({ org_id: projects.org_id })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) return null;
  const rows = await db
    .select({ user_id: projectMemberships.user_id })
    .from(projectMemberships)
    .where(eq(projectMemberships.project_id, projectId));
  return { org_id: project.org_id, user_ids: rows.map((r) => r.user_id) };
}

export async function getProjectMembership(projectId: string, userId: string) {
  const [membership] = await db
    .select()
    .from(projectMemberships)
    .where(
      and(
        eq(projectMemberships.project_id, projectId),
        eq(projectMemberships.user_id, userId),
      ),
    )
    .limit(1);

  return membership ?? null;
}

export async function getSprint(sprintId: string) {
  const [sprint] = await db
    .select()
    .from(sprints)
    .where(eq(sprints.id, sprintId))
    .limit(1);
  return sprint ?? null;
}

export async function getActiveSprint(projectId: string) {
  const [sprint] = await db
    .select()
    .from(sprints)
    .where(and(eq(sprints.project_id, projectId), eq(sprints.status, 'active')))
    .limit(1);
  return sprint ?? null;
}

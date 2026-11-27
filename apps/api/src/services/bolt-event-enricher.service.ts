// ---------------------------------------------------------------------------
// Bolt event payload enrichment
//
// Phase B / Tier 1 of `docs/bolt-id-mapping-strategy.md`: every Bolt event
// payload that Bam emits must include, for every entity referenced:
//   - all relevant IDs (so downstream actions can chain without lookups)
//   - canonical human-readable names / emails / slugs
//   - deep-link URLs for primary entities
//   - the full `actor` object (not just actor_id)
//   - the full `org` context
//
// These helpers are fire-and-forget friendly: each one does its own
// tolerance-to-missing-data work and returns a plain object to spread into
// the Bolt payload. Callers should await them inside the existing
// `getProjectOrgId(...).then(...)` chain so the producer path is unblocked.
// ---------------------------------------------------------------------------

import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users } from '../db/schema/users.js';
import { projects } from '../db/schema/projects.js';
import { phases } from '../db/schema/phases.js';
import { sprints } from '../db/schema/sprints.js';
import { epics } from '../db/schema/epics.js';
import { labels } from '../db/schema/labels.js';
import { organizations } from '../db/schema/organizations.js';
import { taskUrl, projectUrl, sprintUrl, epicUrl } from '../lib/urls.js';

export interface ActorContext {
  id: string;
  name: string | null;
  email: string | null;
  display_name: string | null;
  avatar_url: string | null;
}

export interface OrgContext {
  id: string;
  name: string | null;
  slug: string | null;
}

/** Fetch a user row by id and shape it as the `actor` object for Bolt events. */
export async function loadActor(actorId: string | null | undefined): Promise<ActorContext | null> {
  if (!actorId) return null;
  const [row] = await db
    .select({
      id: users.id,
      display_name: users.display_name,
      email: users.email,
      avatar_url: users.avatar_url,
    })
    .from(users)
    .where(eq(users.id, actorId))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    name: row.display_name,
    display_name: row.display_name,
    email: row.email,
    avatar_url: row.avatar_url,
  };
}

/** Fetch an organization row by id. */
export async function loadOrg(orgId: string): Promise<OrgContext | null> {
  const [row] = await db
    .select({ id: organizations.id, name: organizations.name, slug: organizations.slug })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  return row ?? null;
}

interface UserLite {
  id: string;
  name: string | null;
  email: string | null;
}

async function loadUserLite(userId: string | null | undefined): Promise<UserLite | null> {
  if (!userId) return null;
  const [row] = await db
    .select({ id: users.id, display_name: users.display_name, email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) return null;
  return { id: row.id, name: row.display_name, email: row.email };
}

interface TaskRow {
  id: string;
  human_id: string;
  project_id: string;
  phase_id: string | null;
  state_id: string | null;
  sprint_id: string | null;
  epic_id: string | null;
  parent_task_id: string | null;
  assignee_id: string | null;
  reporter_id: string | null;
  title: string;
  description?: string | null;
  priority?: string;
  story_points?: number | null;
  start_date?: string | null;
  due_date?: string | null;
  labels?: string[];
}

export interface EnrichedTaskPayload {
  task: Record<string, unknown>;
  /** key is the project's task_id_prefix, which the database allows to be null (#359). */
  project: { id: string; name: string; slug: string; key: string | null } | null;
  phase: { id: string; name: string } | null;
  sprint: { id: string; name: string } | null;
  epic: { id: string; name: string } | null;
  assignee: UserLite | null;
  reporter: UserLite | null;
  label_names: string[];
}

/**
 * Given a task row, fetch the referenced entities in a small batch of
 * lookups and return a fully enriched payload suitable for spreading into a
 * Bolt event. Safe against missing FKs / deleted rows — each lookup degrades
 * gracefully to null.
 */
export async function enrichTask(task: TaskRow): Promise<EnrichedTaskPayload> {
  const [project] = task.project_id
    ? await db
        .select({
          id: projects.id,
          name: projects.name,
          slug: projects.slug,
          task_id_prefix: projects.task_id_prefix,
        })
        .from(projects)
        .where(eq(projects.id, task.project_id))
        .limit(1)
    : [];

  const [phase] = task.phase_id
    ? await db
        .select({ id: phases.id, name: phases.name })
        .from(phases)
        .where(eq(phases.id, task.phase_id))
        .limit(1)
    : [];

  const [sprint] = task.sprint_id
    ? await db
        .select({ id: sprints.id, name: sprints.name })
        .from(sprints)
        .where(eq(sprints.id, task.sprint_id))
        .limit(1)
    : [];

  const [epic] = task.epic_id
    ? await db
        .select({ id: epics.id, name: epics.name })
        .from(epics)
        .where(eq(epics.id, task.epic_id))
        .limit(1)
    : [];

  const [assignee, reporter] = await Promise.all([
    loadUserLite(task.assignee_id ?? undefined),
    loadUserLite(task.reporter_id ?? undefined),
  ]);

  let labelNames: string[] = [];
  if (task.labels && task.labels.length > 0) {
    const rows = await db
      .select({ id: labels.id, name: labels.name })
      .from(labels)
      .where(inArray(labels.id, task.labels));
    // Preserve order from task.labels
    const byId = new Map(rows.map((r) => [r.id, r.name] as const));
    labelNames = task.labels.map((id) => byId.get(id)).filter((n): n is string => Boolean(n));
  }

  const enrichedTask: Record<string, unknown> = {
    id: task.id,
    human_id: task.human_id,
    title: task.title,
    description: task.description ?? null,
    project_id: task.project_id,
    phase_id: task.phase_id,
    state_id: task.state_id,
    sprint_id: task.sprint_id,
    epic_id: task.epic_id,
    parent_task_id: task.parent_task_id,
    assignee_id: task.assignee_id,
    reporter_id: task.reporter_id,
    priority: task.priority ?? null,
    story_points: task.story_points ?? null,
    start_date: task.start_date ?? null,
    due_date: task.due_date ?? null,
    label_ids: task.labels ?? [],
    label_names: labelNames,
    url: taskUrl(task.project_id, task.id),
    project_name: project?.name ?? null,
    project_slug: project?.slug ?? null,
    project_key: project?.task_id_prefix ?? null,
    phase_name: phase?.name ?? null,
    sprint_name: sprint?.name ?? null,
    epic_name: epic?.name ?? null,
    assignee_name: assignee?.name ?? null,
    assignee_email: assignee?.email ?? null,
    reporter_name: reporter?.name ?? null,
    reporter_email: reporter?.email ?? null,
  };

  return {
    task: enrichedTask,
    project: project
      ? { id: project.id, name: project.name, slug: project.slug, key: project.task_id_prefix }
      : null,
    phase: phase ?? null,
    sprint: sprint ?? null,
    epic: epic ?? null,
    assignee,
    reporter,
    label_names: labelNames,
  };
}

/** Fetch a project row and return the common context fields Bolt payloads want. */
export async function loadProjectContext(projectId: string): Promise<{
  id: string;
  name: string;
  slug: string;
  key: string | null;
} | null> {
  const [row] = await db
    .select({
      id: projects.id,
      name: projects.name,
      slug: projects.slug,
      task_id_prefix: projects.task_id_prefix,
    })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!row) return null;
  return { id: row.id, name: row.name, slug: row.slug, key: row.task_id_prefix };
}

/** Fetch a phase row. */
export async function loadPhase(phaseId: string | null | undefined): Promise<{ id: string; name: string } | null> {
  if (!phaseId) return null;
  const [row] = await db
    .select({ id: phases.id, name: phases.name })
    .from(phases)
    .where(eq(phases.id, phaseId))
    .limit(1);
  return row ?? null;
}

/** Fetch a sprint row (with goal/dates/status for sprint.* events). */
export async function loadSprintFull(sprintId: string): Promise<{
  id: string;
  name: string;
  project_id: string;
  goal: string | null;
  start_date: string | null;
  end_date: string | null;
  status: string;
  velocity: number | null;
} | null> {
  const [row] = await db
    .select({
      id: sprints.id,
      name: sprints.name,
      project_id: sprints.project_id,
      goal: sprints.goal,
      start_date: sprints.start_date,
      end_date: sprints.end_date,
      status: sprints.status,
      velocity: sprints.velocity,
    })
    .from(sprints)
    .where(eq(sprints.id, sprintId))
    .limit(1);
  return row ?? null;
}

export { taskUrl, projectUrl, sprintUrl, epicUrl };

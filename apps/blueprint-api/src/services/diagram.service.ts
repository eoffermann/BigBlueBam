/**
 * Diagram-level operations: CRUD on blueprint_diagrams, plus the
 * one-payload graph read (diagrams/:id/graph), archive, version
 * snapshots, star toggle, and collaborator management. Node and edge
 * mutations live in their own services.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  blueprintDiagrams,
  blueprintNodes,
  blueprintEdges,
  blueprintDiagramVersions,
  blueprintCollaborators,
  blueprintComments,
  blueprintStars,
  tasksStub,
  projects,
  projectMemberships,
} from '../db/schema/index.js';
import { inArray } from 'drizzle-orm';
import { ForbiddenError, NotFoundError } from '../lib/errors.js';
import { slugify } from '../lib/slug.js';

export type DiagramRow = typeof blueprintDiagrams.$inferSelect;

export interface ListDiagramsFilter {
  project_id?: string;
  diagram_type?: string;
  starred_by?: string;
  include_archived?: boolean;
}

export async function listDiagrams(orgId: string, actor: DiagramActor, filter: ListDiagramsFilter) {
  const userId = actor.id;
  const whereParts = [eq(blueprintDiagrams.org_id, orgId)];
  if (!filter.include_archived) {
    whereParts.push(eq(blueprintDiagrams.is_archived, false));
  }
  if (filter.project_id) {
    whereParts.push(eq(blueprintDiagrams.project_id, filter.project_id));
  }
  if (filter.diagram_type) {
    whereParts.push(eq(blueprintDiagrams.diagram_type, filter.diagram_type));
  }
  const rows = await db
    .select()
    .from(blueprintDiagrams)
    .where(and(...whereParts))
    .orderBy(desc(blueprintDiagrams.updated_at))
    .limit(500);

  if (filter.starred_by) {
    const stars = await db
      .select({ diagram_id: blueprintStars.diagram_id })
      .from(blueprintStars)
      .where(eq(blueprintStars.user_id, filter.starred_by));
    const starred = new Set(stars.map((s) => s.diagram_id));
    return rows.filter((r) => starred.has(r.id));
  }

  // Drop diagrams the caller cannot see, by the same rule as assertCanRead:
  // creator or collaborator always; otherwise organization visibility, or
  // project visibility on a project the caller can see (#181).
  if (rows.length === 0) return rows;
  const openByVisibility = (r: DiagramRow, projectIds: Set<string> | null) =>
    r.visibility === 'organization' ||
    (r.visibility === 'project' && (!r.project_id || projectIds === null || projectIds.has(r.project_id)));
  if (rows.every((r) => r.visibility === 'organization' || (r.visibility === 'project' && !r.project_id))) {
    return rows;
  }
  const [collabs, projectIds] = await Promise.all([
    db
      .select({ diagram_id: blueprintCollaborators.diagram_id })
      .from(blueprintCollaborators)
      .where(eq(blueprintCollaborators.user_id, userId)),
    projectIdsVisibleTo(actor),
  ]);
  const collabSet = new Set(collabs.map((c) => c.diagram_id));
  return rows.filter(
    (r) => r.created_by === userId || collabSet.has(r.id) || openByVisibility(r, projectIds),
  );
}

export async function getDiagram(orgId: string, diagramId: string): Promise<DiagramRow> {
  const [row] = await db
    .select()
    .from(blueprintDiagrams)
    .where(and(eq(blueprintDiagrams.id, diagramId), eq(blueprintDiagrams.org_id, orgId)))
    .limit(1);
  if (!row) throw new NotFoundError('Diagram not found');
  return row;
}

export async function getDiagramGraph(orgId: string, diagramId: string) {
  const diagram = await getDiagram(orgId, diagramId);
  const [nodes, edges] = await Promise.all([
    db.select().from(blueprintNodes).where(eq(blueprintNodes.diagram_id, diagramId)),
    db.select().from(blueprintEdges).where(eq(blueprintEdges.diagram_id, diagramId)),
  ]);
  return { diagram, nodes, edges };
}

export interface CreateDiagramInput {
  name: string;
  description?: string;
  project_id?: string | null;
  diagram_type?: string;
  layout_algorithm?: string;
  visibility?: 'organization' | 'project' | 'private';
  canvas_settings?: Record<string, unknown>;
  layout_options?: Record<string, unknown>;
  template_id?: string;
}

export async function createDiagram(
  orgId: string,
  userId: string,
  input: CreateDiagramInput,
): Promise<DiagramRow> {
  const slug = input.name ? slugify(input.name) : null;
  const [row] = await db
    .insert(blueprintDiagrams)
    .values({
      org_id: orgId,
      project_id: input.project_id ?? null,
      created_by: userId,
      name: input.name,
      slug,
      description: input.description ?? null,
      diagram_type: input.diagram_type ?? 'flowchart',
      layout_algorithm: input.layout_algorithm ?? 'layered',
      layout_options: (input.layout_options ?? {}) as Record<string, unknown>,
      canvas_settings: (input.canvas_settings ?? {}) as Record<string, unknown>,
      visibility: input.visibility ?? 'project',
    })
    .returning();
  return row!;
}

export interface UpdateDiagramInput {
  name?: string;
  description?: string | null;
  project_id?: string | null;
  diagram_type?: string;
  layout_algorithm?: string;
  layout_options?: Record<string, unknown>;
  canvas_settings?: Record<string, unknown>;
  visibility?: 'organization' | 'project' | 'private';
}

export async function updateDiagram(
  orgId: string,
  diagramId: string,
  input: UpdateDiagramInput,
): Promise<DiagramRow> {
  await getDiagram(orgId, diagramId);
  const patch: Record<string, unknown> = { updated_at: new Date() };
  for (const key of [
    'name',
    'description',
    'project_id',
    'diagram_type',
    'layout_algorithm',
    'layout_options',
    'canvas_settings',
    'visibility',
  ] as const) {
    const value = input[key];
    if (value !== undefined) patch[key] = value;
  }
  if (input.name !== undefined) patch.slug = slugify(input.name);
  const [row] = await db
    .update(blueprintDiagrams)
    .set(patch)
    .where(and(eq(blueprintDiagrams.id, diagramId), eq(blueprintDiagrams.org_id, orgId)))
    .returning();
  if (!row) throw new NotFoundError('Diagram not found');
  return row;
}

export async function archiveDiagram(orgId: string, diagramId: string) {
  const [row] = await db
    .update(blueprintDiagrams)
    .set({ is_archived: true, updated_at: new Date() })
    .where(and(eq(blueprintDiagrams.id, diagramId), eq(blueprintDiagrams.org_id, orgId)))
    .returning();
  if (!row) throw new NotFoundError('Diagram not found');
  return row;
}

// ─── Versions ──────────────────────────────────────────────────────────

export async function listVersions(orgId: string, diagramId: string) {
  await getDiagram(orgId, diagramId);
  return await db
    .select()
    .from(blueprintDiagramVersions)
    .where(eq(blueprintDiagramVersions.diagram_id, diagramId))
    .orderBy(desc(blueprintDiagramVersions.version_number));
}

export async function snapshotVersion(
  orgId: string,
  diagramId: string,
  userId: string,
  label: string | null,
) {
  const graph = await getDiagramGraph(orgId, diagramId);
  const versionRows = (await db.execute(
    sql`SELECT COALESCE(MAX(version_number), 0) + 1 AS next_version
        FROM blueprint_diagram_versions
        WHERE diagram_id = ${diagramId}`,
  )) as unknown as Array<{ next_version: number }>;
  const nextVersion = versionRows[0]?.next_version ?? 1;
  const [row] = await db
    .insert(blueprintDiagramVersions)
    .values({
      diagram_id: diagramId,
      version_number: nextVersion,
      label,
      snapshot: graph as unknown as Record<string, unknown>,
      created_by: userId,
    })
    .returning();
  return row!;
}

export async function restoreVersion(orgId: string, diagramId: string, versionNumber: number) {
  await getDiagram(orgId, diagramId);
  const [version] = await db
    .select()
    .from(blueprintDiagramVersions)
    .where(
      and(
        eq(blueprintDiagramVersions.diagram_id, diagramId),
        eq(blueprintDiagramVersions.version_number, versionNumber),
      ),
    )
    .limit(1);
  if (!version) throw new NotFoundError('Version not found');
  const snap = version.snapshot as unknown as {
    diagram?: Partial<DiagramRow>;
    nodes: Array<typeof blueprintNodes.$inferInsert>;
    edges: Array<typeof blueprintEdges.$inferInsert>;
  };
  await db.transaction(async (tx) => {
    await tx.delete(blueprintEdges).where(eq(blueprintEdges.diagram_id, diagramId));
    await tx.delete(blueprintNodes).where(eq(blueprintNodes.diagram_id, diagramId));
    // The snapshot is JSONB, so its `created_at` / `updated_at` come back as
    // ISO strings. Re-inserting them straight into timestamp columns makes
    // Drizzle call `.toISOString()` on a string and throw, so we drop those
    // server-managed fields and let `defaultNow()` re-stamp them. We KEEP each
    // row's original `id`: nodes and edges are restored together, and edges
    // reference node ids, so the ids must survive for the wiring to resolve.
    if (snap.nodes.length > 0) {
      await tx.insert(blueprintNodes).values(
        snap.nodes.map(({ created_at, updated_at, ...n }) => ({ ...n, diagram_id: diagramId })),
      );
    }
    if (snap.edges.length > 0) {
      await tx.insert(blueprintEdges).values(
        snap.edges.map(({ created_at, updated_at, ...e }) => ({ ...e, diagram_id: diagramId })),
      );
    }
    await tx
      .update(blueprintDiagrams)
      .set({ updated_at: new Date() })
      .where(eq(blueprintDiagrams.id, diagramId));
  });
  return await getDiagramGraph(orgId, diagramId);
}

// ─── Stars ─────────────────────────────────────────────────────────────

export async function starDiagram(orgId: string, userId: string, diagramId: string) {
  await getDiagram(orgId, diagramId);
  await db
    .insert(blueprintStars)
    .values({ diagram_id: diagramId, user_id: userId })
    .onConflictDoNothing();
}

export async function unstarDiagram(orgId: string, userId: string, diagramId: string) {
  await getDiagram(orgId, diagramId);
  await db
    .delete(blueprintStars)
    .where(and(eq(blueprintStars.diagram_id, diagramId), eq(blueprintStars.user_id, userId)));
}

// ─── Collaborators ─────────────────────────────────────────────────────

export async function listCollaborators(orgId: string, diagramId: string) {
  await getDiagram(orgId, diagramId);
  return await db
    .select()
    .from(blueprintCollaborators)
    .where(eq(blueprintCollaborators.diagram_id, diagramId));
}

export async function addCollaborator(
  orgId: string,
  diagramId: string,
  userId: string,
  role: 'owner' | 'editor' | 'commenter' | 'viewer',
) {
  await getDiagram(orgId, diagramId);
  const [row] = await db
    .insert(blueprintCollaborators)
    .values({ diagram_id: diagramId, user_id: userId, role })
    .onConflictDoUpdate({
      target: [blueprintCollaborators.diagram_id, blueprintCollaborators.user_id],
      set: { role },
    })
    .returning();
  return row!;
}

export async function removeCollaborator(orgId: string, diagramId: string, userId: string) {
  await getDiagram(orgId, diagramId);
  await db
    .delete(blueprintCollaborators)
    .where(
      and(
        eq(blueprintCollaborators.diagram_id, diagramId),
        eq(blueprintCollaborators.user_id, userId),
      ),
    );
}

// ─── Comments ──────────────────────────────────────────────────────────

export async function listComments(orgId: string, diagramId: string) {
  await getDiagram(orgId, diagramId);
  return await db
    .select()
    .from(blueprintComments)
    .where(eq(blueprintComments.diagram_id, diagramId))
    .orderBy(blueprintComments.created_at);
}

export async function addComment(
  orgId: string,
  diagramId: string,
  authorId: string,
  body: string,
  bodyPlain: string | null,
  nodeId: string | null,
) {
  await getDiagram(orgId, diagramId);
  const [row] = await db
    .insert(blueprintComments)
    .values({
      diagram_id: diagramId,
      node_id: nodeId,
      author_id: authorId,
      body,
      body_plain: bodyPlain,
    })
    .returning();
  return row!;
}

export async function updateComment(
  orgId: string,
  diagramId: string,
  commentId: string,
  patch: { body?: string; body_plain?: string | null; resolved?: boolean },
  actor: DiagramActor,
) {
  await getDiagram(orgId, diagramId);
  const [existing] = await db
    .select({ author_id: blueprintComments.author_id })
    .from(blueprintComments)
    .where(
      and(eq(blueprintComments.id, commentId), eq(blueprintComments.diagram_id, diagramId)),
    )
    .limit(1);
  if (!existing) throw new NotFoundError('Comment not found');
  // Rewriting a comment's text is the author's call, or the diagram owner's
  // (moderation). Resolving is open to anyone who can comment.
  const editsText = patch.body !== undefined || patch.body_plain !== undefined;
  if (editsText && existing.author_id !== actor.id) {
    await assertCanManage(orgId, actor, diagramId);
  }
  const update: Record<string, unknown> = {};
  if (patch.body !== undefined) {
    update.body = patch.body;
    update.edited_at = new Date();
  }
  if (patch.body_plain !== undefined) update.body_plain = patch.body_plain;
  if (patch.resolved !== undefined) update.resolved = patch.resolved;
  const [row] = await db
    .update(blueprintComments)
    .set(update)
    .where(
      and(eq(blueprintComments.id, commentId), eq(blueprintComments.diagram_id, diagramId)),
    )
    .returning();
  if (!row) throw new NotFoundError('Comment not found');
  return row;
}

// ─── Promote graph to Bam tasks (cross-product) ────────────────────────
//
// Returns the structured plan for converting an entire Blueprint diagram
// into a set of Bam tasks plus parent/child links matching the graph's
// edges. Doesn't actually create anything — the caller (SPA or agent)
// executes the plan via the existing Bam endpoints / MCP tools. This
// keeps task attribution correct (the caller's session creates each
// task, not a service account) and lets the SPA show a progress bar
// without inventing a streaming API.
//
// Edge direction convention:
//   - 'source-parent' (default): edge `A -> B` means A is the parent of
//     B. Matches mindmaps, decision trees, and most flowcharts where the
//     arrow points from broader to narrower work.
//   - 'target-parent': edge `A -> B` means B is the parent of A. Useful
//     for dependency graphs where the arrow points from downstream
//     ("blocked by") to upstream ("blocks").
//   - 'none': skip the parent-link step entirely. Just create the tasks.

export interface PromoteGraphPlanInput {
  project_id: string;
  phase_id?: string | null;
  sprint_id?: string | null;
  edge_direction?: 'source-parent' | 'target-parent' | 'none';
  include_archived?: boolean;
}

export interface PromoteGraphPlanResult {
  diagram_id: string;
  project_id: string;
  edge_direction: 'source-parent' | 'target-parent' | 'none';
  /** One entry per node — the payload to POST to /projects/:id/tasks. */
  tasks_to_create: Array<{
    blueprint_node_id: string;
    payload: {
      title: string;
      description: string | null;
      phase_id: string | null;
      sprint_id: string | null;
      priority: 'medium';
    };
    /** If the node already has ref_entity_type='bam.task', the caller
     *  can skip creating a new task and use this existing id instead. */
    existing_task_id: string | null;
  }>;
  /** One entry per edge that should produce a parent/child link. The
   *  caller resolves blueprint_node_id → task_id via the tasks_to_create
   *  mapping (or existing_task_id when already linked) and then calls
   *  POST /tasks/<child_task_id>/parents { parent_task_id }. */
  parent_links_to_create: Array<{
    source_edge_id: string;
    child_blueprint_node_id: string;
    parent_blueprint_node_id: string;
  }>;
  /** Total count for the UI progress bar. */
  total_steps: number;
}

export async function planPromoteGraph(
  orgId: string,
  diagramId: string,
  input: PromoteGraphPlanInput,
): Promise<PromoteGraphPlanResult> {
  await getDiagram(orgId, diagramId);
  const direction = input.edge_direction ?? 'source-parent';

  const [nodes, edges] = await Promise.all([
    db.select().from(blueprintNodes).where(eq(blueprintNodes.diagram_id, diagramId)),
    db.select().from(blueprintEdges).where(eq(blueprintEdges.diagram_id, diagramId)),
  ]);

  // Verify which already-linked tasks actually still exist in Bam. A
  // node can carry a stale ref_entity_id if its companion task was
  // deleted from Bam after the link was set up. We treat those as
  // "needs re-creation" so the user isn't left with dangling pointers.
  const candidateTaskIds = nodes
    .filter((n) => n.ref_entity_type === 'bam.task' && n.ref_entity_id)
    .map((n) => n.ref_entity_id as string);
  const liveTaskIds = new Set<string>();
  if (candidateTaskIds.length > 0) {
    const rows = await db
      .select({ id: tasksStub.id })
      .from(tasksStub)
      .where(inArray(tasksStub.id, candidateTaskIds));
    for (const r of rows) liveTaskIds.add(r.id);
  }

  const tasks_to_create = nodes.map((n) => ({
    blueprint_node_id: n.id,
    payload: {
      title: n.label || 'Untitled',
      description: n.description,
      phase_id: input.phase_id ?? null,
      sprint_id: input.sprint_id ?? null,
      priority: 'medium' as const,
    },
    existing_task_id:
      n.ref_entity_type === 'bam.task' && n.ref_entity_id && liveTaskIds.has(n.ref_entity_id)
        ? n.ref_entity_id
        : null,
  }));

  const parent_links_to_create =
    direction === 'none'
      ? []
      : edges.map((e) => {
          const parent = direction === 'source-parent' ? e.source_node_id : e.target_node_id;
          const child = direction === 'source-parent' ? e.target_node_id : e.source_node_id;
          return {
            source_edge_id: e.id,
            child_blueprint_node_id: child,
            parent_blueprint_node_id: parent,
          };
        });

  return {
    diagram_id: diagramId,
    project_id: input.project_id,
    edge_direction: direction,
    tasks_to_create,
    parent_links_to_create,
    total_steps: tasks_to_create.length + parent_links_to_create.length,
  };
}

// ─── Visibility check used by every per-diagram route ───────────────────
//
// Who may see a diagram (issues #167, #181):
//   - its creator, and any explicit collaborator (role decides edit/comment);
//   - `organization`: every org member;
//   - `project` with a project_id: whoever may see that Bam project
//     (canSeeBamProject, the platform rule from preflightBamProject);
//   - `project` with no project_id: every org member (nothing narrower to apply);
//   - `private` (or anything else): nobody beyond creator and collaborators.

/** The caller, as the per-diagram ACL needs it. `role` is the org legacy role. */
export interface DiagramActor {
  id: string;
  role?: string | null;
  is_superuser?: boolean;
}

/**
 * Whether `actor` may see Bam project `projectId` (issue #181). Mirrors
 * preflightBamProject in apps/api/src/services/visibility.service.ts: the
 * project must be in the caller's org, and the caller must be an org
 * owner/admin or hold a project_memberships row. Blueprint's one encoding of
 * that fact: generate-from-bam, the per-diagram ACL and the list filter all
 * go through it (or, for the list, through projectIdsVisibleTo below).
 */
export async function canSeeBamProject(orgId: string, actor: DiagramActor, projectId: string): Promise<boolean> {
  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.org_id, orgId)))
    .limit(1);
  if (!project) return false;
  if (isOrgAdmin(actor)) return true;
  const [membership] = await db
    .select({ id: projectMemberships.id })
    .from(projectMemberships)
    .where(and(eq(projectMemberships.project_id, projectId), eq(projectMemberships.user_id, actor.id)))
    .limit(1);
  return membership !== undefined;
}

export async function assertCanSeeBamProject(orgId: string, actor: DiagramActor, projectId: string) {
  if (!(await canSeeBamProject(orgId, actor, projectId))) {
    throw new ForbiddenError('Project not found in this org, or you do not have access.');
  }
}

/** The set form of canSeeBamProject for list filtering; null means every project. */
async function projectIdsVisibleTo(actor: DiagramActor): Promise<Set<string> | null> {
  if (isOrgAdmin(actor)) return null;
  const rows = await db
    .select({ project_id: projectMemberships.project_id })
    .from(projectMemberships)
    .where(eq(projectMemberships.user_id, actor.id));
  return new Set(rows.map((r) => r.project_id));
}

/** True when the diagram's visibility alone admits the caller (no collaborator grant needed). */
async function visibilityAdmits(orgId: string, actor: DiagramActor, diagram: DiagramRow): Promise<boolean> {
  if (diagram.visibility === 'organization') return true;
  if (diagram.visibility === 'project') {
    return diagram.project_id ? canSeeBamProject(orgId, actor, diagram.project_id) : true;
  }
  return false;
}

/**
 * Resolve how the caller reaches a diagram: 'open' (creator or visibility) or
 * their collaborator role, or null for no access at all.
 */
async function accessTo(orgId: string, actor: DiagramActor, diagram: DiagramRow): Promise<'open' | string | null> {
  if (diagram.created_by === actor.id) return 'open';
  if (await visibilityAdmits(orgId, actor, diagram)) return 'open';
  return collaboratorRole(diagram.id, actor.id);
}

export async function assertCanRead(orgId: string, actor: DiagramActor, diagramId: string) {
  const diagram = await getDiagram(orgId, diagramId);
  if ((await accessTo(orgId, actor, diagram)) === null) {
    throw new ForbiddenError('You do not have access to this diagram');
  }
  return diagram;
}

export async function assertCanEdit(orgId: string, actor: DiagramActor, diagramId: string) {
  const diagram = await getDiagram(orgId, diagramId);
  const access = await accessTo(orgId, actor, diagram);
  if (access === null) throw new ForbiddenError('You do not have access to this diagram');
  if (access !== 'open' && access !== 'owner' && access !== 'editor') {
    throw new ForbiddenError('You do not have edit access to this diagram');
  }
  return diagram;
}

async function collaboratorRole(diagramId: string, userId: string): Promise<string | null> {
  const [collab] = await db
    .select({ role: blueprintCollaborators.role })
    .from(blueprintCollaborators)
    .where(
      and(
        eq(blueprintCollaborators.diagram_id, diagramId),
        eq(blueprintCollaborators.user_id, userId),
      ),
    )
    .limit(1);
  return collab?.role ?? null;
}

/**
 * Comment access (issue #167): read access, and on a private diagram any
 * collaborator role except `viewer` (so `commenter` can comment).
 */
export async function assertCanComment(orgId: string, actor: DiagramActor, diagramId: string) {
  const diagram = await getDiagram(orgId, diagramId);
  const access = await accessTo(orgId, actor, diagram);
  if (access === null) throw new ForbiddenError('You do not have access to this diagram');
  if (access === 'viewer') throw new ForbiddenError('You do not have comment access to this diagram');
  return diagram;
}

/** Org owners and admins (and platform SuperUsers) may manage any diagram in the org. */
export function isOrgAdmin(actor: DiagramActor): boolean {
  return actor.is_superuser === true || actor.role === 'owner' || actor.role === 'admin';
}

/**
 * Management access (issue #167): collaborator writes and archive. The caller
 * must be the diagram's creator, a collaborator with role `owner`, or an org
 * owner/admin. Applies regardless of visibility: an organization-visible
 * diagram is editable by everyone but owned by someone.
 */
export async function assertCanManage(orgId: string, actor: DiagramActor, diagramId: string) {
  const diagram = await getDiagram(orgId, diagramId);
  if (diagram.created_by === actor.id || isOrgAdmin(actor)) return diagram;
  if ((await collaboratorRole(diagramId, actor.id)) === 'owner') return diagram;
  throw new ForbiddenError('Only the diagram owner can do this');
}

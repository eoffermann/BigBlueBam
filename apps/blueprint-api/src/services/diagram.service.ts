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
} from '../db/schema/index.js';
import { ForbiddenError, NotFoundError } from '../lib/errors.js';
import { slugify } from '../lib/slug.js';

export type DiagramRow = typeof blueprintDiagrams.$inferSelect;

export interface ListDiagramsFilter {
  project_id?: string;
  diagram_type?: string;
  starred_by?: string;
  include_archived?: boolean;
}

export async function listDiagrams(orgId: string, userId: string, filter: ListDiagramsFilter) {
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

  // Drop diagrams the caller cannot see: private + not creator + not collaborator.
  if (rows.length === 0) return rows;
  const privateIds = rows.filter((r) => r.visibility === 'private').map((r) => r.id);
  if (privateIds.length === 0) return rows;
  const collabs = await db
    .select({ diagram_id: blueprintCollaborators.diagram_id })
    .from(blueprintCollaborators)
    .where(eq(blueprintCollaborators.user_id, userId));
  const collabSet = new Set(collabs.map((c) => c.diagram_id));
  return rows.filter(
    (r) => r.visibility !== 'private' || r.created_by === userId || collabSet.has(r.id),
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
    if (snap.nodes.length > 0) {
      await tx.insert(blueprintNodes).values(
        snap.nodes.map((n) => ({ ...n, diagram_id: diagramId })),
      );
    }
    if (snap.edges.length > 0) {
      await tx.insert(blueprintEdges).values(
        snap.edges.map((e) => ({ ...e, diagram_id: diagramId })),
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
) {
  await getDiagram(orgId, diagramId);
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

// ─── Visibility check used by every per-diagram route ───────────────────

export async function assertCanRead(orgId: string, userId: string, diagramId: string) {
  const diagram = await getDiagram(orgId, diagramId);
  if (diagram.visibility === 'organization' || diagram.visibility === 'project') {
    return diagram;
  }
  // private — must be creator or explicit collaborator
  if (diagram.created_by === userId) return diagram;
  const [collab] = await db
    .select({ id: blueprintCollaborators.id })
    .from(blueprintCollaborators)
    .where(
      and(
        eq(blueprintCollaborators.diagram_id, diagramId),
        eq(blueprintCollaborators.user_id, userId),
      ),
    )
    .limit(1);
  if (!collab) throw new ForbiddenError('You do not have access to this diagram');
  return diagram;
}

export async function assertCanEdit(orgId: string, userId: string, diagramId: string) {
  const diagram = await assertCanRead(orgId, userId, diagramId);
  // Currently the visibility roles do not gate edit vs view at the diagram
  // level; per-diagram collaborator roles do. Future work: refine this.
  if (diagram.visibility === 'private' && diagram.created_by !== userId) {
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
    if (!collab || collab.role === 'viewer' || collab.role === 'commenter') {
      throw new ForbiddenError('You do not have edit access to this diagram');
    }
  }
  return diagram;
}

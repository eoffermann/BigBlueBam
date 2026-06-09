/**
 * Cross-product flows that bridge Blueprint and Bam:
 *   - planPromoteGraph (in diagram.service.ts) — graph → tasks
 *   - generateDiagramFromBam (here)            — tasks → graph
 *
 * Generate-from-bam reads tasks directly from the shared Postgres via
 * Drizzle stubs (apps/blueprint-api/src/db/schema/bam-task-stubs.ts).
 * The blueprint-api never writes to the tasks tables — that path goes
 * through bam's HTTP API so all task side-effects (activity log,
 * Bolt events, WebSocket broadcasts) fire correctly.
 *
 * Edges are drawn from BOTH the legacy `tasks.parent_task_id` self-FK
 * and the new `task_parent_links` many-to-many join table introduced by
 * B3 Frndo Launch, so a subtask with multiple parents shows every
 * relationship correctly.
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  blueprintDiagrams,
  blueprintNodes,
  blueprintEdges,
  tasksStub,
  taskParentLinksStub,
  projects,
} from '../db/schema/index.js';
import { ForbiddenError, NotFoundError } from '../lib/errors.js';
import { slugify } from '../lib/slug.js';
import { applyLayout } from './layout.service.js';

export interface GenerateFromBamInput {
  org_id: string;
  user_id: string;
  project_id: string;
  /** Optional name override; defaults to "<Project name> — tasks". */
  name?: string;
  description?: string | null;
  /** When false (the default), tasks whose phase is terminal are skipped. */
  include_completed?: boolean;
  /** When set, only tasks in this sprint are pulled. */
  sprint_id?: string | null;
  /** Default 'project' so the resulting diagram inherits the project's
   *  member ACL — same model Brief uses. */
  visibility?: 'organization' | 'project' | 'private';
  /** When true (default), runs layered ELK on the generated graph so it
   *  opens already laid out. */
  auto_layout?: boolean;
}

export interface GenerateFromBamResult {
  diagram_id: string;
  node_count: number;
  edge_count: number;
  skipped_completed_count: number;
}

export async function generateDiagramFromBam(
  input: GenerateFromBamInput,
): Promise<GenerateFromBamResult> {
  // 1. Verify the project belongs to the caller's org. The Bam project
  //    visibility/ACL is enforced when the SPA fetches tasks separately;
  //    here we just refuse cross-org reads as a defense in depth.
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, input.project_id), eq(projects.org_id, input.org_id)))
    .limit(1);
  if (!project) {
    throw new ForbiddenError('Project not found in this org, or you do not have access.');
  }

  // 2. Pull every task in the project. Filter completed tasks unless the
  //    caller explicitly opted in. Order by parent_task_id NULLs first
  //    then created_at so the root tasks appear in the upper layers.
  const taskWhere = [eq(tasksStub.project_id, input.project_id)];
  if (input.sprint_id) {
    taskWhere.push(eq(tasksStub.sprint_id, input.sprint_id));
  }
  const allTasks = await db
    .select({
      id: tasksStub.id,
      parent_task_id: tasksStub.parent_task_id,
      title: tasksStub.title,
      description: tasksStub.description,
      human_id: tasksStub.human_id,
      completed_at: tasksStub.completed_at,
      priority: tasksStub.priority,
    })
    .from(tasksStub)
    .where(and(...taskWhere))
    .orderBy(desc(tasksStub.created_at));

  const tasks = input.include_completed
    ? allTasks
    : allTasks.filter((t) => t.completed_at == null);
  const skipped = allTasks.length - tasks.length;
  if (tasks.length === 0) {
    throw new NotFoundError(
      input.include_completed
        ? 'Project has no tasks to materialize.'
        : 'Project has no open tasks. Pass include_completed=true to include completed tasks too.',
    );
  }

  // 3. Pull every task parent link that touches one of our tasks. We need
  //    BOTH the legacy `tasks.parent_task_id` AND the many-to-many
  //    `task_parent_links` so an existing subtask with multiple parents
  //    shows every relationship.
  const taskIds = tasks.map((t) => t.id);
  const taskIdSet = new Set(taskIds);
  const legacyParents = tasks
    .filter((t) => t.parent_task_id && taskIdSet.has(t.parent_task_id))
    .map((t) => ({ child_task_id: t.id, parent_task_id: t.parent_task_id! }));

  const m2mParents = await db
    .select()
    .from(taskParentLinksStub)
    .where(
      and(
        inArray(taskParentLinksStub.task_id, taskIds),
        inArray(taskParentLinksStub.parent_task_id, taskIds),
      ),
    );

  // De-dupe (legacy + m2m may overlap after the B3 Frndo Launch backfill).
  const seenLink = new Set<string>();
  const parentLinks: Array<{ child_task_id: string; parent_task_id: string }> = [];
  for (const link of [
    ...legacyParents,
    ...m2mParents.map((l) => ({ child_task_id: l.task_id, parent_task_id: l.parent_task_id })),
  ]) {
    const k = `${link.child_task_id}<-${link.parent_task_id}`;
    if (seenLink.has(k)) continue;
    seenLink.add(k);
    parentLinks.push(link);
  }

  // 4. Create the diagram + materialize nodes + edges in one transaction.
  const baseName = input.name ?? `${project.name ?? 'Project'} — tasks`;
  const { diagramId, nodeIdByTask } = await db.transaction(async (tx) => {
    const [diagram] = await tx
      .insert(blueprintDiagrams)
      .values({
        org_id: input.org_id,
        project_id: input.project_id,
        created_by: input.user_id,
        name: baseName,
        slug: slugify(baseName),
        description: input.description ?? null,
        diagram_type: 'org_chart',
        layout_algorithm: 'layered',
        canvas_settings: { source: 'bam' },
        visibility: input.visibility ?? 'project',
      })
      .returning();
    if (!diagram) {
      throw new Error('Failed to create diagram');
    }

    const inserted = await tx
      .insert(blueprintNodes)
      .values(
        tasks.map((t) => ({
          diagram_id: diagram.id,
          shape: 'rounded',
          label:
            t.human_id && t.title
              ? `${t.human_id} — ${t.title}`
              : t.title || t.human_id || 'Untitled task',
          description: t.description ?? null,
          width: 220,
          height: 64,
          // Pre-seed with a deterministic grid so the diagram never opens
          // with every node piled on top of each other before ELK runs.
          // We index the offset by position-in-array; ELK will overwrite
          // these values when auto_layout fires.
          position_x: (tasks.indexOf(t) % 6) * 260,
          position_y: Math.floor(tasks.indexOf(t) / 6) * 100,
          style: t.completed_at
            ? { fillColor: '#f4f4f5' as string }
            : ({} as Record<string, unknown>),
          ref_entity_type: 'bam.task' as string,
          ref_entity_id: t.id,
        })),
      )
      .returning({ id: blueprintNodes.id, ref_entity_id: blueprintNodes.ref_entity_id });

    const nodeIdByTask = new Map<string, string>();
    for (const row of inserted) {
      if (row.ref_entity_id) nodeIdByTask.set(row.ref_entity_id, row.id);
    }

    if (parentLinks.length > 0) {
      const edgeRows = parentLinks
        .map((link) => {
          const sourceNode = nodeIdByTask.get(link.parent_task_id);
          const targetNode = nodeIdByTask.get(link.child_task_id);
          if (!sourceNode || !targetNode) return null;
          return {
            diagram_id: diagram.id,
            source_node_id: sourceNode,
            target_node_id: targetNode,
            kind: 'reports_to',
            label: null,
            marker_start: 'none',
            marker_end: 'arrowclosed',
          };
        })
        .filter((r): r is NonNullable<typeof r> => r !== null);
      if (edgeRows.length > 0) {
        await tx.insert(blueprintEdges).values(edgeRows);
      }
    }

    return { diagramId: diagram.id, nodeIdByTask };
  });

  // 5. Auto-layout outside the transaction so the layout engine's reads
  //    don't see uncommitted rows in some Postgres isolation modes.
  if (input.auto_layout !== false) {
    try {
      await applyLayout(diagramId, { algorithm: 'layered', direction: 'DOWN' });
    } catch {
      // Don't fail the whole generate if ELK has a bad hair day; the
      // diagram still ships with the deterministic grid seed positions.
    }
  }

  return {
    diagram_id: diagramId,
    node_count: nodeIdByTask.size,
    edge_count: parentLinks.length,
    skipped_completed_count: skipped,
  };
}

/**
 * Re-resolution helper used by the two-way sync pass: find every
 * blueprint_node that points at a given bam.task. Returns an empty array
 * when nothing is linked. Used by the api's task-update path to push
 * label/description changes into linked diagrams.
 */
export async function findNodesLinkedToTask(taskId: string): Promise<
  Array<{
    id: string;
    diagram_id: string;
    label: string;
    description: string | null;
    org_id: string;
  }>
> {
  const rows = await db
    .select({
      id: blueprintNodes.id,
      diagram_id: blueprintNodes.diagram_id,
      label: blueprintNodes.label,
      description: blueprintNodes.description,
      org_id: blueprintDiagrams.org_id,
    })
    .from(blueprintNodes)
    .innerJoin(blueprintDiagrams, eq(blueprintNodes.diagram_id, blueprintDiagrams.id))
    .where(
      and(
        eq(blueprintNodes.ref_entity_type, 'bam.task'),
        eq(blueprintNodes.ref_entity_id, taskId),
      ),
    );
  return rows;
}

/**
 * Persist a sync-from-bam patch on every linked node. Only writes fields
 * the caller actually supplied — undefined fields stay untouched. Skips
 * nodes whose existing value already matches the incoming value so we
 * don't kick off a redundant blueprint.node.updated broadcast.
 */
export async function applyTaskSyncToNodes(
  taskId: string,
  patch: { title?: string | null; description?: string | null },
): Promise<{ updated: number }> {
  const nodes = await findNodesLinkedToTask(taskId);
  let updated = 0;
  for (const n of nodes) {
    const update: Record<string, unknown> = {};
    if (patch.title !== undefined) {
      const next = patch.title ?? '';
      if (next !== n.label) update.label = next;
    }
    if (patch.description !== undefined) {
      const next = patch.description ?? null;
      if (next !== n.description) update.description = next;
    }
    if (Object.keys(update).length === 0) continue;
    update.updated_at = new Date();
    await db
      .update(blueprintNodes)
      .set(update)
      .where(eq(blueprintNodes.id, n.id));
    updated += 1;
  }
  return { updated };
}

// Suppress sql import-only error if no SQL fragments are used.
void sql;

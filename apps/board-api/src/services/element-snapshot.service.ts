import { eq, and, notInArray, inArray, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { boardElements, boards } from '../db/schema/index.js';
import type { SceneData } from '../ws/persistence.js';

// Design-mandated element count limits (design §10).
export const BOARD_ELEMENT_SOFT_LIMIT = 500;
export const BOARD_ELEMENT_HARD_LIMIT = 2000;

// ---------------------------------------------------------------------------
// Excalidraw element type → board_elements element_type mapping
// ---------------------------------------------------------------------------

function mapExcalidrawType(excalidrawType: string): string {
  switch (excalidrawType) {
    case 'rectangle':
    case 'diamond':
    case 'ellipse':
    case 'freedraw':
      return 'shape';
    case 'text':
      return 'text';
    case 'arrow':
    case 'line':
      return 'connector';
    case 'image':
      return 'image';
    case 'frame':
      return 'frame';
    default:
      return excalidrawType; // pass through unknown types as-is
  }
}

// ---------------------------------------------------------------------------
// Parsed element from an Excalidraw scene
// ---------------------------------------------------------------------------

interface ParsedElement {
  id: string;
  element_type: string;
  text_content: string | null;
  x: number;
  y: number;
  width: number | null;
  height: number | null;
  rotation: number;
  color: string | null;
  frame_id: string | null;
  group_id: string | null;
  arrow_start: unknown | null;
  arrow_end: unknown | null;
  arrow_label: string | null;
}

function parseElement(el: Record<string, unknown>): ParsedElement | null {
  const id = el.id as string | undefined;
  if (!id || typeof id !== 'string') return null;

  const excalidrawType = (el.type as string) ?? 'unknown';
  const elementType = mapExcalidrawType(excalidrawType);

  // Extract text content from text elements or from other elements' text property
  let textContent: string | null = null;
  if (typeof el.text === 'string' && el.text.length > 0) {
    textContent = el.text;
  }

  // Extract arrow binding metadata
  let arrowStart: unknown | null = null;
  let arrowEnd: unknown | null = null;
  const arrowLabel: string | null = null;

  if (elementType === 'connector') {
    if (el.startBinding && typeof el.startBinding === 'object') {
      arrowStart = el.startBinding;
    }
    if (el.endBinding && typeof el.endBinding === 'object') {
      arrowEnd = el.endBinding;
    }
    // Excalidraw arrows can have a label via a bound text element; that comes
    // through as a separate text element, so we don't extract it here.
  }

  // Frame ID (Excalidraw uses frameId)
  const frameId =
    typeof el.frameId === 'string' && el.frameId.length > 0 ? el.frameId : null;

  // Group: Excalidraw uses groupIds (array). Take the first if present.
  let groupId: string | null = null;
  if (Array.isArray(el.groupIds) && el.groupIds.length > 0) {
    groupId = String(el.groupIds[0]);
  }

  return {
    id,
    element_type: elementType,
    text_content: textContent,
    x: typeof el.x === 'number' ? el.x : 0,
    y: typeof el.y === 'number' ? el.y : 0,
    width: typeof el.width === 'number' ? el.width : null,
    height: typeof el.height === 'number' ? el.height : null,
    rotation: typeof el.angle === 'number' ? el.angle : 0,
    color: typeof el.strokeColor === 'string' ? el.strokeColor : null,
    frame_id: frameId,
    group_id: groupId,
    arrow_start: arrowStart,
    arrow_end: arrowEnd,
    arrow_label: arrowLabel,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Synchronize the `board_elements` snapshot table with the current Excalidraw
 * scene JSON.  This is the core "Element Snapshot Service" described in the
 * design doc.
 *
 * Steps:
 *  1. Parse elements from the scene JSON.
 *  2. Remove elements that are marked `isDeleted: true` in the scene.
 *  3. Upsert live (non-deleted) elements into `board_elements`.
 *  4. Delete rows in `board_elements` for element IDs that are no longer in
 *     the scene at all (user may have undone an add, or the element was
 *     removed without the isDeleted flag).
 */
export async function syncElementsFromScene(
  boardId: string,
  sceneJson: SceneData,
  _orgId: string,
): Promise<{ upserted: number; deleted: number; element_count: number }> {
  const rawElements = sceneJson.elements;
  if (!Array.isArray(rawElements) || rawElements.length === 0) {
    // Scene has no elements — clear the snapshot table for this board
    const deleted = await db
      .delete(boardElements)
      .where(eq(boardElements.board_id, boardId))
      .returning({ id: boardElements.id });
    await updateBoardElementCount(boardId, 0);
    return { upserted: 0, deleted: deleted.length, element_count: 0 };
  }

  const liveElements: ParsedElement[] = [];
  const deletedIds: string[] = [];

  for (const raw of rawElements) {
    if (!raw || typeof raw !== 'object') continue;
    const el = raw as Record<string, unknown>;

    // Elements flagged as deleted should be removed from the snapshot
    if (el.isDeleted === true) {
      if (typeof el.id === 'string') deletedIds.push(el.id);
      continue;
    }

    const parsed = parseElement(el);
    if (parsed) liveElements.push(parsed);
  }

  // Collect all live IDs so we can prune stale rows later
  const liveIds = liveElements.map((e) => e.id);

  let totalDeleted = 0;

  // --- Delete elements marked isDeleted in the scene ---
  if (deletedIds.length > 0) {
    const batches = chunkArray(deletedIds, 500);
    for (const batch of batches) {
      const rows = await db
        .delete(boardElements)
        .where(
          and(eq(boardElements.board_id, boardId), inArray(boardElements.id, batch)),
        )
        .returning({ id: boardElements.id });
      totalDeleted += rows.length;
    }
  }

  // --- Delete stale rows (IDs no longer present in scene at all) ---
  if (liveIds.length > 0) {
    const rows = await db
      .delete(boardElements)
      .where(
        and(
          eq(boardElements.board_id, boardId),
          notInArray(boardElements.id, liveIds),
        ),
      )
      .returning({ id: boardElements.id });
    totalDeleted += rows.length;
  }

  // --- Upsert live elements in batches ---
  const BATCH_SIZE = 100;
  let totalUpserted = 0;
  const batches = chunkArray(liveElements, BATCH_SIZE);

  for (const batch of batches) {
    await db
      .insert(boardElements)
      .values(
        batch.map((el) => ({
          id: el.id,
          board_id: boardId,
          element_type: el.element_type,
          text_content: el.text_content,
          x: el.x,
          y: el.y,
          width: el.width,
          height: el.height,
          rotation: el.rotation,
          color: el.color,
          frame_id: el.frame_id,
          group_id: el.group_id,
          arrow_start: el.arrow_start,
          arrow_end: el.arrow_end,
          arrow_label: el.arrow_label,
          updated_at: new Date(),
        })),
      )
      .onConflictDoUpdate({
        target: boardElements.id,
        set: {
          element_type: sql`excluded.element_type`,
          text_content: sql`excluded.text_content`,
          x: sql`excluded.x`,
          y: sql`excluded.y`,
          width: sql`excluded.width`,
          height: sql`excluded.height`,
          rotation: sql`excluded.rotation`,
          color: sql`excluded.color`,
          frame_id: sql`excluded.frame_id`,
          group_id: sql`excluded.group_id`,
          arrow_start: sql`excluded.arrow_start`,
          arrow_end: sql`excluded.arrow_end`,
          arrow_label: sql`excluded.arrow_label`,
          updated_at: sql`now()`,
        },
      });
    totalUpserted += batch.length;
  }

  const liveCount = liveElements.length;
  await updateBoardElementCount(boardId, liveCount);

  return { upserted: totalUpserted, deleted: totalDeleted, element_count: liveCount };
}

/**
 * Update the denormalized `boards.element_count` column after a scene sync.
 *
 * Writes are best-effort: if the column is missing or the update fails, we
 * swallow the error so snapshot sync remains resilient. The limit enforcement
 * (soft 500 / hard 2000) is applied upstream by the caller using the returned
 * element_count, keeping this service side-effect pure apart from the count
 * bookkeeping.
 */
async function updateBoardElementCount(boardId: string, count: number): Promise<void> {
  try {
    await db
      .update(boards)
      .set({ element_count: count, updated_at: new Date() })
      .where(eq(boards.id, boardId));
  } catch {
    // Tolerate transient failures or schema drift — snapshot is still valid.
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

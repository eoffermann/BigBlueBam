import { eq, sql } from 'drizzle-orm';
import { env } from '../env.js';
import { db } from '../db/index.js';
import {
  boards,
  users,
  projects,
  organizations,
  boardTemplates,
} from '../db/schema/index.js';

/**
 * Build an enriched payload for board.* events.
 *
 * Pulls the full board row + joined project, template, creating user, and
 * organization so Bolt rules can reference canonical IDs, names, URLs, and
 * counts without issuing additional MCP tool calls.
 *
 * All lookups are best-effort: if a join fails or the row can't be found,
 * undefined fields are omitted and the rest of the payload still ships.
 * Counts fall back to 0 on error.
 */
export async function buildBoardEventPayload(
  boardId: string,
  orgId: string,
  actorId: string,
  changes?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  // Load the board with project, template, and creator joined.
  const [row] = await db
    .select({
      id: boards.id,
      name: boards.name,
      description: boards.description,
      icon: boards.icon,
      visibility: boards.visibility,
      background: boards.background,
      project_id: boards.project_id,
      template_id: boards.template_id,
      created_by: boards.created_by,
      created_at: boards.created_at,
      updated_at: boards.updated_at,
      project_name: projects.name,
      project_slug: projects.slug,
      template_name: boardTemplates.name,
    })
    .from(boards)
    .leftJoin(projects, eq(boards.project_id, projects.id))
    .leftJoin(boardTemplates, eq(boards.template_id, boardTemplates.id))
    .where(eq(boards.id, boardId))
    .limit(1);

  // Load actor (creator/updater) user row.
  const [actor] = await db
    .select({
      id: users.id,
      display_name: users.display_name,
      email: users.email,
    })
    .from(users)
    .where(eq(users.id, actorId))
    .limit(1);

  // Load org row.
  const [org] = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      slug: organizations.slug,
    })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  // Counts (best-effort, default to 0).
  let elementCount = 0;
  let collaboratorCount = 0;
  try {
    const countRows: any[] = await db.execute(sql`
      SELECT
        (SELECT COUNT(*)::int FROM board_elements WHERE board_id = ${boardId}) AS element_count,
        (SELECT COUNT(*)::int FROM board_collaborators WHERE board_id = ${boardId}) AS collaborator_count
    `);
    const c = countRows[0];
    if (c) {
      elementCount = Number(c.element_count ?? 0);
      collaboratorCount = Number(c.collaborator_count ?? 0);
    }
  } catch {
    // Tolerate transient count failures: leave zeros.
  }

  const boardUrl = `${env.FRONTEND_URL.replace(/\/$/, '')}/board/${boardId}`;

  const payload: Record<string, unknown> = {
    'board.id': boardId,
    'board.url': boardUrl,
    'board.element_count': elementCount,
    'board.collaborator_count': collaboratorCount,
  };

  if (row) {
    payload['board.name'] = row.name;
    payload['board.description'] = row.description ?? null;
    payload['board.icon'] = row.icon ?? null;
    payload['board.visibility'] = row.visibility;
    payload['board.background'] = row.background;
    payload['board.project_id'] = row.project_id ?? null;
    payload['board.project_name'] = row.project_name ?? null;
    payload['board.project_slug'] = row.project_slug ?? null;
    payload['board.template_id'] = row.template_id ?? null;
    payload['board.template_name'] = row.template_name ?? null;
    payload['board.created_by'] = row.created_by;
    payload['board.created_at'] = row.created_at;
    payload['board.updated_at'] = row.updated_at;
  }

  if (actor) {
    payload['actor.id'] = actor.id;
    payload['actor.name'] = actor.display_name;
    payload['actor.email'] = actor.email;
  } else {
    payload['actor.id'] = actorId;
  }

  if (org) {
    payload['org.id'] = org.id;
    payload['org.name'] = org.name;
    payload['org.slug'] = org.slug;
  } else {
    payload['org.id'] = orgId;
  }

  if (changes) {
    payload.changes = changes;
  }

  return payload;
}

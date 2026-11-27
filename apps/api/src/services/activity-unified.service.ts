import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';

/**
 * Unified activity-log query service (AGENTIC_TODO §5, Wave 3).
 *
 * Backs GET /v1/activity/unified and GET /v1/activity/unified/by-actor.
 *
 * Query shape:
 *   - Read from v_activity_unified (migration 0129), a UNION ALL view over
 *     activity_log, bond_activities, and ticket_activity_log.
 *   - Filter by (entity_type, entity_id) OR by (actor_id).
 *   - Apply a cross-app visibility filter so agents running under
 *     service-account keys cannot surface rows the asker could not read.
 *   - Paginate by (created_at, id) cursor.
 *
 * Visibility model (applied as a single big WHERE clause because the view
 * is already narrowed by entity/actor filters; the EXISTS subqueries only
 * evaluate over the small filtered page):
 *
 *   - source_app='bam': caller must be a project_members row on project_id,
 *     OR the caller's role is org-admin/owner on projects.org_id. Bam
 *     activity_log rows always carry project_id, so this is always gated.
 *
 *   - source_app='bond': caller's active_org_id must equal organization_id
 *     on the bond row. (Bond's own per-row role gating is already applied
 *     server-side when writing; the unified view does not re-apply
 *     owner-restricted visibility for "member"/"viewer" roles. Wave 3
 *     accepts this trade-off — activity rows expose less data than the
 *     underlying entity and the org match keeps cross-tenant leaks out.)
 *
 *   - source_app='helpdesk': look up the ticket's project, and require
 *     project membership OR org-admin/owner on that project's org. If the
 *     ticket has no project_id we fall back to "any authed user in the
 *     caller's active org" (same posture as visibility.service.ts for
 *     helpdesk.ticket).
 *
 * The WHERE below is intentionally ugly; it is a single query and lets
 * Postgres plan the whole thing at once. It is NOT evaluated against every
 * row in the union — the caller always supplies either (entity_type,
 * entity_id) or actor_id, which the view indexes can cover.
 */

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export interface UnifiedActivityRow {
  id: string;
  source_app: 'bam' | 'bond' | 'helpdesk';
  entity_type: string;
  entity_id: string | null;
  project_id: string | null;
  organization_id: string | null;
  actor_id: string | null;
  actor_type: 'human' | 'agent' | 'service' | string;
  action: string;
  details: unknown;
  created_at: string;
}

export interface UnifiedActivityPage {
  data: UnifiedActivityRow[];
  meta: {
    next_cursor: string | null;
    has_more: boolean;
  };
}

export interface UnifiedActivityCallerCtx {
  user_id: string;
  active_org_id: string;
}

/**
 * Parse a cursor. Cursors use the (created_at, id) tuple encoded as
 * `<iso-ts>|<uuid>` so pagination remains strictly ordered even when
 * two rows share a created_at (possible across UNION ALL sources).
 */
function parseCursor(cursor: string): { created_at: Date; id: string } | null {
  const idx = cursor.indexOf('|');
  if (idx < 0) return null;
  const ts = cursor.slice(0, idx);
  const id = cursor.slice(idx + 1);
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  if (!id) return null;
  return { created_at: d, id };
}

function makeCursor(row: UnifiedActivityRow): string {
  return `${row.created_at}|${row.id}`;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) {
    return DEFAULT_LIMIT;
  }
  return Math.min(Math.floor(limit), MAX_LIMIT);
}

export interface UnifiedActivityQueryByEntity {
  caller: UnifiedActivityCallerCtx;
  entity_type: string;
  entity_id: string;
  since?: Date;
  cursor?: string;
  limit?: number;
}

export interface UnifiedActivityQueryByActor {
  caller: UnifiedActivityCallerCtx;
  actor_id: string;
  since?: Date;
  cursor?: string;
  limit?: number;
}

/**
 * Build the visibility-gate SQL fragment. Assumes `v.*` is in scope as the
 * alias for v_activity_unified. The caller's id and active_org_id are
 * parameterized.
 *
 * The fragment is identical for by-entity and by-actor queries; both paths
 * must honor the same gate.
 */
function visibilityGate(caller: UnifiedActivityCallerCtx) {
  const callerId = caller.user_id;
  const callerOrg = caller.active_org_id;

  return sql`(
    (
      v.source_app = 'bam'
      AND v.project_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM projects p
         WHERE p.id = v.project_id
           AND p.org_id = ${callerOrg}
           AND (
                 EXISTS (
                   SELECT 1 FROM organization_memberships om
                    WHERE om.user_id = ${callerId}
                      AND om.org_id = p.org_id
                      AND om.role IN ('owner', 'admin')
                 )
              OR EXISTS (
                   SELECT 1 FROM project_memberships pm
                    WHERE pm.project_id = p.id
                      AND pm.user_id = ${callerId}
                 )
           )
      )
    )
    OR (
      v.source_app = 'bond'
      AND v.organization_id = ${callerOrg}
    )
    OR (
      v.source_app = 'helpdesk'
      AND EXISTS (
        SELECT 1 FROM tickets t
         WHERE t.id = v.entity_id
           AND (
                 (
                   t.project_id IS NULL
                   AND EXISTS (
                     SELECT 1 FROM organization_memberships om
                      WHERE om.user_id = ${callerId}
                        AND om.org_id = ${callerOrg}
                   )
                 )
              OR (
                   t.project_id IS NOT NULL
                   AND EXISTS (
                     SELECT 1 FROM projects p2
                      WHERE p2.id = t.project_id
                        AND p2.org_id = ${callerOrg}
                        AND (
                              EXISTS (
                                SELECT 1 FROM organization_memberships om
                                 WHERE om.user_id = ${callerId}
                                   AND om.org_id = p2.org_id
                                   AND om.role IN ('owner', 'admin')
                              )
                           OR EXISTS (
                                SELECT 1 FROM project_memberships pm
                                 WHERE pm.project_id = p2.id
                                   AND pm.user_id = ${callerId}
                              )
                        )
                   )
                 )
           )
      )
    )
  )`;
}

/**
 * Map a raw postgres row returned by db.execute() to the UnifiedActivityRow
 * shape. created_at is returned as a Date by postgres-js; we serialize it
 * to ISO string here so the wire shape is stable regardless of driver.
 */
function mapRow(raw: Record<string, unknown>): UnifiedActivityRow {
  const createdAt = raw.created_at;
  let createdAtStr: string;
  if (createdAt instanceof Date) createdAtStr = createdAt.toISOString();
  else if (typeof createdAt === 'string') createdAtStr = createdAt;
  else createdAtStr = String(createdAt);

  return {
    id: String(raw.id),
    source_app: String(raw.source_app) as 'bam' | 'bond' | 'helpdesk',
    entity_type: String(raw.entity_type),
    entity_id: raw.entity_id == null ? null : String(raw.entity_id),
    project_id: raw.project_id == null ? null : String(raw.project_id),
    organization_id: raw.organization_id == null ? null : String(raw.organization_id),
    actor_id: raw.actor_id == null ? null : String(raw.actor_id),
    actor_type: String(raw.actor_type),
    action: String(raw.action),
    details: raw.details,
    created_at: createdAtStr,
  };
}

/**
 * Query v_activity_unified by (entity_type, entity_id).
 * Applies visibility gating and cursor pagination.
 */
export async function queryByEntity(
  q: UnifiedActivityQueryByEntity,
): Promise<UnifiedActivityPage> {
  const limit = clampLimit(q.limit);
  const gate = visibilityGate(q.caller);

  const sinceClause = q.since
    ? sql`AND v.created_at >= ${q.since.toISOString()}::timestamptz`
    : sql``;

  const parsedCursor = q.cursor ? parseCursor(q.cursor) : null;
  const cursorClause = parsedCursor
    ? sql`AND (v.created_at, v.id) < (${parsedCursor.created_at}, ${parsedCursor.id}::uuid)`
    : sql``;

  const rows = await db.execute(sql`
    SELECT v.id, v.source_app, v.entity_type, v.entity_id, v.project_id,
           v.organization_id, v.actor_id, v.actor_type, v.action, v.details,
           v.created_at
      FROM v_activity_unified v
     WHERE v.entity_type = ${q.entity_type}
       AND v.entity_id = ${q.entity_id}::uuid
       ${sinceClause}
       ${cursorClause}
       AND ${gate}
     ORDER BY v.created_at DESC, v.id DESC
     LIMIT ${limit + 1}
  `);

  // db.execute returns an array of rows with postgres-js driver.
  const raw = (rows as unknown as Record<string, unknown>[]) ?? [];
  const mapped = raw.map(mapRow);
  const hasMore = mapped.length > limit;
  const data = hasMore ? mapped.slice(0, limit) : mapped;
  const nextCursor =
    hasMore && data.length > 0 ? makeCursor(data[data.length - 1]!) : null;

  return { data, meta: { next_cursor: nextCursor, has_more: hasMore } };
}

/**
 * Query v_activity_unified by actor_id. The caller's org must match the
 * target actor's org at the route layer (404 on mismatch) BEFORE this is
 * called — mirrors the agent_audit pattern.
 */
export async function queryByActor(
  q: UnifiedActivityQueryByActor,
): Promise<UnifiedActivityPage> {
  const limit = clampLimit(q.limit);
  const gate = visibilityGate(q.caller);

  const sinceClause = q.since
    ? sql`AND v.created_at >= ${q.since.toISOString()}::timestamptz`
    : sql``;

  const parsedCursor = q.cursor ? parseCursor(q.cursor) : null;
  const cursorClause = parsedCursor
    ? sql`AND (v.created_at, v.id) < (${parsedCursor.created_at}, ${parsedCursor.id}::uuid)`
    : sql``;

  const rows = await db.execute(sql`
    SELECT v.id, v.source_app, v.entity_type, v.entity_id, v.project_id,
           v.organization_id, v.actor_id, v.actor_type, v.action, v.details,
           v.created_at
      FROM v_activity_unified v
     WHERE v.actor_id = ${q.actor_id}::uuid
       ${sinceClause}
       ${cursorClause}
       AND ${gate}
     ORDER BY v.created_at DESC, v.id DESC
     LIMIT ${limit + 1}
  `);

  const raw = (rows as unknown as Record<string, unknown>[]) ?? [];
  const mapped = raw.map(mapRow);
  const hasMore = mapped.length > limit;
  const data = hasMore ? mapped.slice(0, limit) : mapped;
  const nextCursor =
    hasMore && data.length > 0 ? makeCursor(data[data.length - 1]!) : null;

  return { data, meta: { next_cursor: nextCursor, has_more: hasMore } };
}

// ---------------------------------------------------------------------------
// Exports for testing only
// ---------------------------------------------------------------------------

export const __test__ = {
  parseCursor,
  makeCursor,
  clampLimit,
};

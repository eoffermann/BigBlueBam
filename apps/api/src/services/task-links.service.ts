import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { pgTable, uuid as pgUuid, varchar } from 'drizzle-orm/pg-core';
import type { TaskLink, TaskLinkInput } from '@bigbluebam/shared';
import { db } from '../db/index.js';
import { entityLinks } from '../db/schema/entity-links.js';
import { tasks } from '../db/schema/tasks.js';
import { projects } from '../db/schema/projects.js';

/**
 * Task Links field — CSV-import plan Phase 0 (§4.1–§4.3).
 *
 * Owns:
 *   - normalization of incoming link arrays (de-dupe by URL, 50-link cap,
 *     id/added_at/added_by stamping, title_source derivation);
 *   - synchronous title resolution for suite-internal URLs by parsing the
 *     path and reading the owning app's table over the shared DB;
 *   - mirroring resolved internal links into entity_links (kind
 *     `references`) so they join the cross-app graph agents already use.
 *
 * External (non-suite) URLs with no title are left as title=null /
 * title_source='none'; the `task-link-title-fetch` worker job backfills
 * those asynchronously (not in this module's scope).
 */

export const MAX_TASK_LINKS = 50;

// ---------------------------------------------------------------------------
// Read-only peer-app table stubs for title lookup.
//
// The shared peer-app-stubs module (../db/schema/peer-app-stubs) deliberately
// carries only the columns the visibility preflight reads, and `boards` is
// not stubbed there at all. These local declarations follow the same
// "minimal columns, keep in lockstep with the owning app's schema" contract:
//   - brief_documents.title    apps/brief-api/src/db/schema/brief-documents.ts
//   - blueprint_diagrams.name  apps/blueprint-api/src/db/schema/blueprint-diagrams.ts
//   - boards.name              apps/board-api/src/db/schema/boards.ts
// They live outside src/db/schema so the db-check drift guard does not treat
// them as canonical declarations.
// ---------------------------------------------------------------------------

// Org columns are included so every internal-title lookup is org-scoped —
// without it a user could stamp another org's entity title onto their task
// and mint a cross-org entity_links row (the ids are guessable/enumerable).
const briefDocumentsTitleStub = pgTable('brief_documents', {
  id: pgUuid('id').primaryKey(),
  org_id: pgUuid('org_id').notNull(),
  title: varchar('title', { length: 512 }).notNull(),
});

const blueprintDiagramsNameStub = pgTable('blueprint_diagrams', {
  id: pgUuid('id').primaryKey(),
  org_id: pgUuid('org_id').notNull(),
  name: varchar('name', { length: 200 }).notNull(),
});

const boardsNameStub = pgTable('boards', {
  id: pgUuid('id').primaryKey(),
  organization_id: pgUuid('organization_id').notNull(),
  name: varchar('name', { length: 255 }).notNull(),
});

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

export interface NormalizedTaskLinks {
  links: TaskLink[];
  /** True when unique URLs beyond the 50-link cap were dropped. */
  truncated: boolean;
}

/**
 * Normalize a wire-format link array into the canonical stored shape:
 * de-dupe by URL (first occurrence wins), cap at MAX_TASK_LINKS (truncate,
 * surfaced via `truncated`), stamp id / added_at / added_by for entries the
 * client didn't pre-stamp, and derive title_source: 'user' when a title is
 * present (unless the entry round-trips an existing 'fetched' title),
 * 'none' when untitled.
 */
export function normalizeTaskLinks(
  input: TaskLinkInput[],
  addedBy: string | null,
  existing: TaskLink[] = [],
): NormalizedTaskLinks {
  // Provenance (id / added_at / added_by / a 'fetched' title) is only honored
  // when the wire entry's id matches a link ALREADY stored on this task —
  // otherwise a client could forge added_by, backdate added_at, or fake a
  // 'fetched' title. Everything else is restamped server-side. (On create,
  // `existing` is empty, so every link is freshly stamped.)
  const existingById = new Map(existing.map((l) => [l.id, l]));
  const seen = new Set<string>();
  const links: TaskLink[] = [];
  let truncated = false;
  const now = new Date().toISOString();

  for (const raw of input) {
    const url = raw.url.trim();
    if (seen.has(url)) continue;
    seen.add(url);
    if (links.length >= MAX_TASK_LINKS) {
      truncated = true;
      break;
    }
    const prior = raw.id ? existingById.get(raw.id) : undefined;
    const trimmedTitle = raw.title?.trim();
    const title = trimmedTitle ? trimmedTitle : null;

    let titleSource: TaskLink['title_source'];
    if (title === null) {
      titleSource = 'none';
    } else if (prior && prior.title === title && prior.title_source === 'fetched') {
      // Unchanged title that was server-resolved before — keep the marker so
      // we don't re-classify a fetched title as a user one.
      titleSource = 'fetched';
    } else {
      titleSource = 'user';
    }

    links.push({
      id: prior?.id ?? randomUUID(),
      url,
      title,
      title_source: titleSource,
      added_at: prior?.added_at ?? now,
      added_by: prior ? prior.added_by : addedBy,
    });
  }

  return { links, truncated };
}

// ---------------------------------------------------------------------------
// Internal-URL parsing (§4.3 item 2)
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Matches Bam human ids like "MAGE-38" / "FRND-123".
const TASK_REF_RE = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

export type ParsedInternalUrl =
  | { dst_type: 'brief.document' | 'blueprint.diagram' | 'board.board'; id: string }
  | { dst_type: 'bam.task'; ref: string };

function pathSegments(pathname: string): string[] {
  return pathname
    .split('/')
    .filter(Boolean)
    .map((seg) => {
      try {
        return decodeURIComponent(seg);
      } catch {
        return seg;
      }
    });
}

/**
 * Parse a suite-internal URL into the entity it points at. Accepts both
 * absolute URLs (any host — the suite is served behind arbitrary domains)
 * and hostname-relative paths ("/brief/documents/<id>"). Returns null for
 * anything that isn't one of the recognized suite path shapes.
 */
export function parseInternalUrl(url: string): ParsedInternalUrl | null {
  const trimmed = url.trim();
  let pathname: string;
  if (trimmed.startsWith('/')) {
    pathname = trimmed.split(/[?#]/, 1)[0]!;
  } else {
    try {
      pathname = new URL(trimmed).pathname;
    } catch {
      return null;
    }
  }

  const seg = pathSegments(pathname);
  if (seg.length >= 3 && seg[0] === 'brief' && seg[1] === 'documents' && UUID_RE.test(seg[2]!)) {
    return { dst_type: 'brief.document', id: seg[2]!.toLowerCase() };
  }
  if (seg.length >= 3 && seg[0] === 'blueprint' && seg[1] === 'd' && UUID_RE.test(seg[2]!)) {
    return { dst_type: 'blueprint.diagram', id: seg[2]!.toLowerCase() };
  }
  if (seg.length >= 2 && seg[0] === 'board' && UUID_RE.test(seg[1]!)) {
    return { dst_type: 'board.board', id: seg[1]!.toLowerCase() };
  }
  if (seg.length >= 4 && seg[0] === 'b3' && seg[1] === 'tasks' && seg[2] === 'ref' && TASK_REF_RE.test(seg[3]!)) {
    return { dst_type: 'bam.task', ref: seg[3]! };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Title resolution + entity_links mirror
// ---------------------------------------------------------------------------

export interface ResolvedInternalLink {
  title: string;
  dst_type: string;
  dst_id: string;
}

/**
 * Resolve a suite-internal URL to its target entity's display title via a
 * shared-DB lookup, SCOPED TO `orgId`. Returns null when the URL isn't
 * internal, the target row doesn't exist, or the target belongs to another
 * org (prevents cross-tenant title disclosure + cross-org graph edges).
 */
export async function resolveInternalLink(
  url: string,
  orgId: string,
): Promise<ResolvedInternalLink | null> {
  const parsed = parseInternalUrl(url);
  if (!parsed) return null;

  if (parsed.dst_type === 'bam.task') {
    // tasks carry no org_id column — scope via the owning project.
    const [row] = await db
      .select({ id: tasks.id, title: tasks.title })
      .from(tasks)
      .innerJoin(projects, eq(projects.id, tasks.project_id))
      .where(and(eq(tasks.human_id, parsed.ref), eq(projects.org_id, orgId)))
      .limit(1);
    return row ? { title: row.title, dst_type: 'bam.task', dst_id: row.id } : null;
  }
  if (parsed.dst_type === 'brief.document') {
    const [row] = await db
      .select({ title: briefDocumentsTitleStub.title })
      .from(briefDocumentsTitleStub)
      .where(
        and(eq(briefDocumentsTitleStub.id, parsed.id), eq(briefDocumentsTitleStub.org_id, orgId)),
      )
      .limit(1);
    return row ? { title: row.title, dst_type: parsed.dst_type, dst_id: parsed.id } : null;
  }
  if (parsed.dst_type === 'blueprint.diagram') {
    const [row] = await db
      .select({ name: blueprintDiagramsNameStub.name })
      .from(blueprintDiagramsNameStub)
      .where(
        and(
          eq(blueprintDiagramsNameStub.id, parsed.id),
          eq(blueprintDiagramsNameStub.org_id, orgId),
        ),
      )
      .limit(1);
    return row ? { title: row.name, dst_type: parsed.dst_type, dst_id: parsed.id } : null;
  }
  const [row] = await db
    .select({ name: boardsNameStub.name })
    .from(boardsNameStub)
    .where(and(eq(boardsNameStub.id, parsed.id), eq(boardsNameStub.organization_id, orgId)))
    .limit(1);
  return row ? { title: row.name, dst_type: parsed.dst_type, dst_id: parsed.id } : null;
}

export interface TaskLinkMirror {
  dst_type: string;
  dst_id: string;
}

/**
 * Resolve suite-internal links (org-scoped) and collect entity_links mirror
 * targets. Every internal link that resolves contributes a mirror REGARDLESS
 * of whether it already has a title (so user-labeled internal links still
 * join the cross-app graph — §5.2 link_mappings + acceptance line 286). The
 * title is only filled in for links that are still untitled (§4.3 priority:
 * a user title always wins and is never overwritten). Untitled EXTERNAL links
 * pass through for the async worker to backfill.
 */
export async function resolveInternalLinkTitles(
  links: TaskLink[],
  orgId: string,
): Promise<{ links: TaskLink[]; mirrors: TaskLinkMirror[] }> {
  const out: TaskLink[] = [];
  const mirrors: TaskLinkMirror[] = [];
  for (const link of links) {
    let resolved: ResolvedInternalLink | null = null;
    try {
      resolved = await resolveInternalLink(link.url, orgId);
    } catch (err) {
      // Lookup failure must never block the task write; the link simply
      // stays untitled.
      console.error('[task-links.service] internal title resolution failed:', {
        url: link.url,
        err,
      });
    }
    if (!resolved) {
      out.push(link);
      continue;
    }
    // Mirror every resolved internal link; only overwrite the title when the
    // link was untitled.
    mirrors.push({ dst_type: resolved.dst_type, dst_id: resolved.dst_id });
    if (link.title === null) {
      out.push({ ...link, title: resolved.title, title_source: 'fetched' });
    } else {
      out.push(link);
    }
  }
  return { links: out, mirrors };
}

/**
 * Mirror resolved internal links into entity_links (src bam.task → dst
 * <app>.<type>, kind `references`). Direct idempotent insert against the
 * (src, dst, kind) unique index — same on-conflict-do-nothing convention as
 * entity-links.service.createLink, but without its visibility preflight:
 * the dst was just title-resolved from a URL the actor supplied, and
 * board.board is intentionally outside the preflight allowlist (reads
 * tolerate such rows, matching the migration-0132 backfill posture).
 */
export async function mirrorTaskEntityLinks(
  taskId: string,
  orgId: string,
  createdBy: string | null,
  mirrors: TaskLinkMirror[],
): Promise<void> {
  for (const mirror of mirrors) {
    // A task linking to itself is meaningless in the graph.
    if (mirror.dst_type === 'bam.task' && mirror.dst_id === taskId) continue;
    await db
      .insert(entityLinks)
      .values({
        org_id: orgId,
        src_type: 'bam.task',
        src_id: taskId,
        dst_type: mirror.dst_type,
        dst_id: mirror.dst_id,
        link_kind: 'references',
        created_by: createdBy,
      })
      .onConflictDoNothing({
        target: [
          entityLinks.src_type,
          entityLinks.src_id,
          entityLinks.dst_type,
          entityLinks.dst_id,
          entityLinks.link_kind,
        ],
      });
  }
}

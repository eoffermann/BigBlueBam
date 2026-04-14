import crypto from 'node:crypto';
import { eq, and, or, sql, asc, desc, gt, ilike, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  briefDocuments,
  briefStars,
  briefTemplates,
  projectMemberships,
  users,
  projects,
  beaconEntries,
} from '../db/schema/index.js';
import { sanitizeHtml } from '../lib/sanitize.js';
import { publishBoltEvent } from '@bigbluebam/shared';
import { enrichDocumentEventPayload } from '../lib/enrich-document-event.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Escape LIKE/ILIKE metacharacters so user input is treated as literal text. */
export function escapeLike(s: string): string {
  return s.replace(/[%_\\]/g, '\\$&');
}

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 200);
}

async function uniqueSlug(title: string): Promise<string> {
  const base = slugify(title);
  if (!base) return `doc-${crypto.randomBytes(4).toString('hex')}`;

  const [existing] = await db
    .select({ slug: briefDocuments.slug })
    .from(briefDocuments)
    .where(eq(briefDocuments.slug, base))
    .limit(1);

  if (!existing) return base;

  return `${base}-${crypto.randomBytes(4).toString('hex')}`;
}

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export class BriefError extends Error {
  code: string;
  statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = 'BriefError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

// ---------------------------------------------------------------------------
// Project membership helper
// ---------------------------------------------------------------------------

export async function getUserProjectIds(userId: string): Promise<Set<string>> {
  const rows = await db
    .select({ project_id: projectMemberships.project_id })
    .from(projectMemberships)
    .where(eq(projectMemberships.user_id, userId));
  return new Set(rows.map((r) => r.project_id));
}

/**
 * Builds the SQL visibility predicate used by listDocuments, getRecentDocuments,
 * searchDocuments and getStats. A document is visible to `userId` when:
 *   1. visibility = 'organization', OR
 *   2. visibility = 'private' AND user is creator or explicit collaborator, OR
 *   3. visibility = 'project' AND user is creator, collaborator, or a member of
 *      the document's project.
 */
export async function documentVisibilityPredicate(userId: string) {
  const userProjectIds = await getUserProjectIds(userId);
  const userProjectArray = [...userProjectIds];

  return or(
    // Organization visibility — visible to all org members
    sql`${briefDocuments.visibility} = 'organization'`,
    // Private — only creator or collaborator
    and(
      eq(briefDocuments.visibility, 'private'),
      or(
        eq(briefDocuments.created_by, userId),
        sql`${briefDocuments.id} IN (
          SELECT document_id FROM brief_collaborators
          WHERE user_id = ${userId}
        )`,
      ),
    ),
    // Project — creator, collaborator, or project member
    and(
      eq(briefDocuments.visibility, 'project'),
      or(
        eq(briefDocuments.created_by, userId),
        sql`${briefDocuments.id} IN (
          SELECT document_id FROM brief_collaborators
          WHERE user_id = ${userId}
        )`,
        userProjectArray.length > 0
          ? inArray(briefDocuments.project_id, userProjectArray)
          : sql`FALSE`,
      ),
    ),
  )!;
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export interface CreateDocumentInput {
  title?: string;
  plain_text?: string | null;
  project_id?: string | null;
  folder_id?: string | null;
  template_id?: string | null;
  visibility?: 'private' | 'project' | 'organization';
  icon?: string | null;
}

export async function createDocument(
  data: CreateDocumentInput,
  userId: string,
  orgId: string,
) {
  const title = data.title || 'Untitled';
  const slug = await uniqueSlug(title);

  // If a template is specified, copy its content into the new document
  let templateContent: string | null = null;
  let templateIcon: string | null = data.icon ?? null;
  if (data.template_id) {
    const [tmpl] = await db
      .select()
      .from(briefTemplates)
      .where(and(eq(briefTemplates.id, data.template_id), eq(briefTemplates.org_id, orgId)))
      .limit(1);
    if (tmpl) {
      templateContent = tmpl.html_preview;
      if (!data.icon && tmpl.icon) templateIcon = tmpl.icon;
    }
  }

  const plainText = data.plain_text ?? templateContent ?? null;
  const wordCount = plainText
    ? plainText.replace(/<[^>]*>/g, ' ').trim().split(/\s+/).filter(Boolean).length
    : 0;

  const [doc] = await db
    .insert(briefDocuments)
    .values({
      org_id: orgId,
      project_id: data.project_id ?? null,
      folder_id: data.folder_id ?? null,
      title,
      slug,
      plain_text: plainText,
      html_snapshot: templateContent ? sanitizeHtml(templateContent) : null,
      word_count: wordCount,
      template_id: data.template_id ?? null,
      status: 'draft',
      visibility: data.visibility ?? 'project',
      icon: templateIcon,
      created_by: userId,
      updated_by: userId,
    })
    .returning();

  // Bolt workflow event (fire-and-forget)
  enrichDocumentEventPayload(doc!, userId)
    .then((payload) => publishBoltEvent('document.created', 'brief', payload, orgId, userId, 'user'))
    .catch(() => {});

  return doc!;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getDocument(idOrSlug: string, orgId: string) {
  const isUuid = UUID_REGEX.test(idOrSlug);
  const condition = isUuid
    ? eq(briefDocuments.id, idOrSlug)
    : eq(briefDocuments.slug, idOrSlug);

  const [doc] = await db
    .select()
    .from(briefDocuments)
    .where(and(condition, eq(briefDocuments.org_id, orgId)))
    .limit(1);

  return doc ?? null;
}

export async function getDocumentById(id: string, orgId: string) {
  const [doc] = await db
    .select()
    .from(briefDocuments)
    .where(and(eq(briefDocuments.id, id), eq(briefDocuments.org_id, orgId)))
    .limit(1);
  return doc ?? null;
}

export interface ListDocumentsFilters {
  orgId: string;
  userId: string;
  projectId?: string;
  folderId?: string;
  status?: string;
  createdBy?: string;
  search?: string;
  cursor?: string;
  limit?: number;
}

export async function listDocuments(filters: ListDocumentsFilters) {
  const conditions = [eq(briefDocuments.org_id, filters.orgId)];

  if (filters.projectId) {
    conditions.push(eq(briefDocuments.project_id, filters.projectId));
  }

  if (filters.folderId) {
    conditions.push(eq(briefDocuments.folder_id, filters.folderId));
  }

  if (filters.status) {
    conditions.push(eq(briefDocuments.status, filters.status as any));
  }

  if (filters.createdBy) {
    conditions.push(eq(briefDocuments.created_by, filters.createdBy));
  }

  if (filters.search) {
    const escaped = escapeLike(filters.search);
    conditions.push(
      or(
        ilike(briefDocuments.title, `%${escaped}%`),
        ilike(briefDocuments.plain_text, `%${escaped}%`),
      )!,
    );
  }

  // Visibility enforcement
  conditions.push(await documentVisibilityPredicate(filters.userId));

  const limit = Math.min(filters.limit ?? 50, 100);

  if (filters.cursor) {
    conditions.push(gt(briefDocuments.created_at, new Date(filters.cursor)));
  }

  const result = await db
    .select({
      document: briefDocuments,
      creator_name: users.display_name,
      project_name: projects.name,
    })
    .from(briefDocuments)
    .leftJoin(users, eq(users.id, briefDocuments.created_by))
    .leftJoin(projects, eq(projects.id, briefDocuments.project_id))
    .where(and(...conditions))
    .orderBy(asc(briefDocuments.created_at))
    .limit(limit + 1);

  const hasMore = result.length > limit;
  const rows = hasMore ? result.slice(0, limit) : result;
  const data = rows.map((r) => ({
    ...r.document,
    yjs_state: undefined,
    creator_name: r.creator_name ?? null,
    project_name: r.project_name ?? null,
  }));
  const nextCursor =
    hasMore && rows.length > 0
      ? rows[rows.length - 1]!.document.created_at.toISOString()
      : null;

  return {
    data,
    meta: {
      next_cursor: nextCursor,
      has_more: hasMore,
    },
  };
}

export interface UpdateDocumentInput {
  title?: string;
  folder_id?: string | null;
  icon?: string | null;
  cover_image_url?: string | null;
  status?: 'draft' | 'in_review' | 'approved' | 'archived';
  visibility?: 'private' | 'project' | 'organization';
  pinned?: boolean;
  plain_text?: string | null;
  html_snapshot?: string | null;
  yjs_state?: Buffer | null;
  word_count?: number;
  project_id?: string | null;
}

export async function updateDocument(
  id: string,
  data: UpdateDocumentInput,
  userId: string,
  orgId: string,
) {
  const existing = await getDocumentById(id, orgId);
  if (!existing) throw new BriefError('NOT_FOUND', 'Document not found', 404);

  const updateValues: Record<string, unknown> = {
    updated_at: new Date(),
    updated_by: userId,
  };

  if (data.title !== undefined) updateValues.title = data.title;
  if (data.folder_id !== undefined) updateValues.folder_id = data.folder_id;
  if (data.icon !== undefined) updateValues.icon = data.icon;
  if (data.cover_image_url !== undefined) updateValues.cover_image_url = data.cover_image_url;
  if (data.status !== undefined) updateValues.status = data.status;
  if (data.visibility !== undefined) updateValues.visibility = data.visibility;
  if (data.pinned !== undefined) updateValues.pinned = data.pinned;
  if (data.plain_text !== undefined) updateValues.plain_text = data.plain_text;
  if (data.html_snapshot !== undefined) updateValues.html_snapshot = data.html_snapshot ? sanitizeHtml(data.html_snapshot) : data.html_snapshot;
  if (data.yjs_state !== undefined) updateValues.yjs_state = data.yjs_state;
  if (data.word_count !== undefined) updateValues.word_count = data.word_count;
  if (data.project_id !== undefined) updateValues.project_id = data.project_id;

  const [doc] = await db
    .update(briefDocuments)
    .set(updateValues)
    .where(eq(briefDocuments.id, id))
    .returning();

  // Bolt workflow events (fire-and-forget)
  const changedFields = Object.keys(updateValues).filter(
    (f) => f !== 'updated_at' && f !== 'updated_by',
  );
  enrichDocumentEventPayload(doc!, userId, { changed_fields: changedFields })
    .then((payload) => publishBoltEvent('document.updated', 'brief', payload, orgId, userId, 'user'))
    .catch(() => {});

  // Emit document.published when status transitions to approved
  if (data.status === 'approved' && existing.status !== 'approved') {
    enrichDocumentEventPayload(doc!, userId, { previous_status: existing.status })
      .then((payload) =>
        publishBoltEvent('document.published', 'brief', payload, orgId, userId, 'user'),
      )
      .catch(() => {});
  }

  return doc!;
}

export async function archiveDocument(id: string, userId: string, orgId: string) {
  const existing = await getDocumentById(id, orgId);
  if (!existing) throw new BriefError('NOT_FOUND', 'Document not found', 404);

  if (existing.status === 'archived') {
    throw new BriefError('BAD_REQUEST', 'Document is already archived', 400);
  }

  const [doc] = await db
    .update(briefDocuments)
    .set({
      status: 'archived',
      archived_at: new Date(),
      updated_at: new Date(),
      updated_by: userId,
    })
    .where(eq(briefDocuments.id, id))
    .returning();

  return doc!;
}

export async function restoreDocument(id: string, userId: string, orgId: string) {
  const existing = await getDocumentById(id, orgId);
  if (!existing) throw new BriefError('NOT_FOUND', 'Document not found', 404);

  if (existing.status !== 'archived') {
    throw new BriefError(
      'INVALID_TRANSITION',
      `Cannot restore a document with status '${existing.status}'; must be archived`,
    );
  }

  const [doc] = await db
    .update(briefDocuments)
    .set({
      status: 'draft',
      archived_at: null,
      updated_at: new Date(),
      updated_by: userId,
    })
    .where(eq(briefDocuments.id, id))
    .returning();

  return doc!;
}

export async function duplicateDocument(id: string, userId: string, orgId: string) {
  const existing = await getDocumentById(id, orgId);
  if (!existing) throw new BriefError('NOT_FOUND', 'Document not found', 404);

  const newTitle = `${existing.title} (copy)`;
  const slug = await uniqueSlug(newTitle);

  const [doc] = await db
    .insert(briefDocuments)
    .values({
      org_id: orgId,
      project_id: existing.project_id,
      folder_id: existing.folder_id,
      title: newTitle,
      slug,
      yjs_state: existing.yjs_state,
      plain_text: existing.plain_text,
      html_snapshot: existing.html_snapshot,
      icon: existing.icon,
      cover_image_url: existing.cover_image_url,
      template_id: existing.template_id,
      status: 'draft',
      visibility: existing.visibility,
      word_count: existing.word_count,
      created_by: userId,
      updated_by: userId,
    })
    .returning();

  return doc!;
}

export async function toggleStar(documentId: string, userId: string) {
  // Check if already starred
  const [existing] = await db
    .select({ id: briefStars.id })
    .from(briefStars)
    .where(
      and(
        eq(briefStars.document_id, documentId),
        eq(briefStars.user_id, userId),
      ),
    )
    .limit(1);

  if (existing) {
    await db.delete(briefStars).where(eq(briefStars.id, existing.id));
    return { starred: false };
  }

  await db.insert(briefStars).values({
    document_id: documentId,
    user_id: userId,
  });

  return { starred: true };
}

export async function getStarredDocuments(userId: string, orgId: string) {
  const rows = await db
    .select({
      document: briefDocuments,
      creator_name: users.display_name,
      project_name: projects.name,
    })
    .from(briefStars)
    .innerJoin(briefDocuments, eq(briefDocuments.id, briefStars.document_id))
    .leftJoin(users, eq(users.id, briefDocuments.created_by))
    .leftJoin(projects, eq(projects.id, briefDocuments.project_id))
    .where(
      and(
        eq(briefStars.user_id, userId),
        eq(briefDocuments.org_id, orgId),
      ),
    )
    .orderBy(desc(briefStars.created_at));

  return rows.map((r) => ({
    ...r.document,
    yjs_state: undefined,
    creator_name: r.creator_name ?? null,
    project_name: r.project_name ?? null,
  }));
}

export async function getRecentDocuments(userId: string, orgId: string, limit = 20) {
  const userProjectIds = await getUserProjectIds(userId);
  const userProjectArray = [...userProjectIds];

  const conditions = [
    eq(briefDocuments.org_id, orgId),
    or(
      sql`${briefDocuments.visibility} = 'organization'`,
      eq(briefDocuments.created_by, userId),
      sql`${briefDocuments.id} IN (
        SELECT document_id FROM brief_collaborators
        WHERE user_id = ${userId}
      )`,
      userProjectArray.length > 0
        ? and(
            eq(briefDocuments.visibility, 'project'),
            inArray(briefDocuments.project_id, userProjectArray),
          )
        : sql`FALSE`,
    )!,
  ];

  const rows = await db
    .select({
      document: briefDocuments,
      creator_name: users.display_name,
      project_name: projects.name,
    })
    .from(briefDocuments)
    .leftJoin(users, eq(users.id, briefDocuments.created_by))
    .leftJoin(projects, eq(projects.id, briefDocuments.project_id))
    .where(and(...conditions))
    .orderBy(desc(briefDocuments.updated_at))
    .limit(Math.min(limit, 50));

  return rows.map((r) => ({
    ...r.document,
    yjs_state: undefined,
    creator_name: r.creator_name ?? null,
    project_name: r.project_name ?? null,
  }));
}

export async function searchDocuments(
  query: string,
  orgId: string,
  userId: string,
  filters: { projectId?: string; status?: string },
) {
  const escaped = escapeLike(query);
  const userProjectIds = await getUserProjectIds(userId);
  const userProjectArray = [...userProjectIds];

  const conditions = [
    eq(briefDocuments.org_id, orgId),
    or(
      ilike(briefDocuments.title, `%${escaped}%`),
      ilike(briefDocuments.plain_text, `%${escaped}%`),
    )!,
    // Visibility enforcement
    or(
      sql`${briefDocuments.visibility} = 'organization'`,
      eq(briefDocuments.created_by, userId),
      sql`${briefDocuments.id} IN (
        SELECT document_id FROM brief_collaborators
        WHERE user_id = ${userId}
      )`,
      userProjectArray.length > 0
        ? and(
            eq(briefDocuments.visibility, 'project'),
            inArray(briefDocuments.project_id, userProjectArray),
          )
        : sql`FALSE`,
    )!,
  ];

  if (filters.projectId) {
    conditions.push(eq(briefDocuments.project_id, filters.projectId));
  }

  if (filters.status) {
    conditions.push(eq(briefDocuments.status, filters.status as any));
  }

  const rows = await db
    .select({
      document: briefDocuments,
      creator_name: users.display_name,
      project_name: projects.name,
    })
    .from(briefDocuments)
    .leftJoin(users, eq(users.id, briefDocuments.created_by))
    .leftJoin(projects, eq(projects.id, briefDocuments.project_id))
    .where(and(...conditions))
    .orderBy(desc(briefDocuments.updated_at))
    .limit(50);

  return rows.map((r) => ({
    ...r.document,
    yjs_state: undefined,
    creator_name: r.creator_name ?? null,
    project_name: r.project_name ?? null,
  }));
}

export async function getStats(orgId: string, userId: string) {
  const visibility = await documentVisibilityPredicate(userId);

  const [row] = await db
    .select({
      total: sql<number>`COUNT(*)::int`,
      draft: sql<number>`COUNT(*) FILTER (WHERE ${briefDocuments.status} = 'draft')::int`,
      in_review: sql<number>`COUNT(*) FILTER (WHERE ${briefDocuments.status} = 'in_review')::int`,
      approved: sql<number>`COUNT(*) FILTER (WHERE ${briefDocuments.status} = 'approved')::int`,
      archived: sql<number>`COUNT(*) FILTER (WHERE ${briefDocuments.status} = 'archived')::int`,
    })
    .from(briefDocuments)
    .where(and(eq(briefDocuments.org_id, orgId), visibility));

  return {
    total: row?.total ?? 0,
    draft: row?.draft ?? 0,
    in_review: row?.in_review ?? 0,
    approved: row?.approved ?? 0,
    archived: row?.archived ?? 0,
  };
}

export async function promoteToBeacon(id: string, userId: string, orgId: string) {
  const existing = await getDocumentById(id, orgId);
  if (!existing) throw new BriefError('NOT_FOUND', 'Document not found', 404);

  if (existing.promoted_to_beacon_id) {
    throw new BriefError('BAD_REQUEST', 'Document has already been promoted to a Beacon', 400);
  }

  // Create a beacon entry from the document content
  const beaconSlug = `brief-${existing.slug}-${crypto.randomBytes(4).toString('hex')}`;

  const [beacon] = await db
    .insert(beaconEntries)
    .values({
      slug: beaconSlug,
      title: existing.title,
      organization_id: orgId,
      body_html: existing.html_snapshot ?? '',
      body_markdown: existing.plain_text ?? '',
      created_by: userId,
      owned_by: userId,
      status: 'Draft',
      visibility: 'Organization',
    })
    .returning();

  // Update the document to reference the new beacon
  const [doc] = await db
    .update(briefDocuments)
    .set({
      promoted_to_beacon_id: beacon!.id,
      updated_at: new Date(),
      updated_by: userId,
    })
    .where(eq(briefDocuments.id, id))
    .returning();

  return { document: doc!, beacon_id: beacon!.id };
}

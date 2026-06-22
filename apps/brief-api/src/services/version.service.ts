import { eq, and, desc } from 'drizzle-orm';
import { db } from '../db/index.js';
import { briefVersions, briefDocuments, users } from '../db/schema/index.js';

// How often editing auto-creates a version snapshot. The Yjs autosave flush
// fires every ~30s while a doc is being edited; snapshotting on every flush
// would bury real revisions in noise, so we keep at most one auto-snapshot per
// this window. Publishes force a snapshot regardless (see maybeSnapshotVersion).
export const VERSION_SNAPSHOT_THROTTLE_MS = 10 * 60 * 1000;

export class VersionError extends Error {
  code: string;
  statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = 'VersionError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export async function listVersions(documentId: string) {
  const versions = await db
    .select({
      version: briefVersions,
      changed_by_name: users.display_name,
    })
    .from(briefVersions)
    .leftJoin(users, eq(users.id, briefVersions.created_by))
    .where(eq(briefVersions.document_id, documentId))
    .orderBy(desc(briefVersions.version_number));

  // Strip yjs_state from list responses for size; surface the author's name.
  return versions.map((r) => ({
    ...r.version,
    yjs_state: undefined,
    changed_by_name: r.changed_by_name ?? null,
  }));
}

export async function getVersion(documentId: string, versionId: string) {
  const [version] = await db
    .select()
    .from(briefVersions)
    .where(
      and(
        eq(briefVersions.document_id, documentId),
        eq(briefVersions.id, versionId),
      ),
    )
    .limit(1);

  return version ?? null;
}

export interface CreateVersionInput {
  title?: string;
  change_summary?: string | null;
}

export async function createVersion(
  documentId: string,
  data: CreateVersionInput,
  userId: string,
  orgId: string,
) {
  // Get current document state
  const [doc] = await db
    .select()
    .from(briefDocuments)
    .where(and(eq(briefDocuments.id, documentId), eq(briefDocuments.org_id, orgId)))
    .limit(1);

  if (!doc) throw new VersionError('NOT_FOUND', 'Document not found', 404);

  // Determine next version number
  const [latestVersion] = await db
    .select({ version_number: briefVersions.version_number })
    .from(briefVersions)
    .where(eq(briefVersions.document_id, documentId))
    .orderBy(desc(briefVersions.version_number))
    .limit(1);

  const nextVersion = (latestVersion?.version_number ?? 0) + 1;

  const [version] = await db
    .insert(briefVersions)
    .values({
      document_id: documentId,
      version_number: nextVersion,
      title: data.title ?? doc.title,
      yjs_state: doc.yjs_state,
      html_snapshot: doc.html_snapshot,
      plain_text: doc.plain_text,
      word_count: doc.word_count,
      change_summary: data.change_summary ?? null,
      created_by: userId,
    })
    .returning();

  return version!;
}

/**
 * Auto-create a version snapshot of the document's current state, but only if
 * the most recent snapshot is older than VERSION_SNAPSHOT_THROTTLE_MS (so the
 * 30s autosave flush doesn't spam revisions). Pass `force` for milestones like
 * publishing, where a snapshot should always be recorded. Fire-and-forget safe:
 * returns null when throttled or the document is missing, and never throws on
 * the autosave path callers (they should still .catch()).
 */
export async function maybeSnapshotVersion(
  documentId: string,
  userId: string,
  orgId: string,
  opts: { force?: boolean; changeSummary?: string } = {},
) {
  const [doc] = await db
    .select()
    .from(briefDocuments)
    .where(and(eq(briefDocuments.id, documentId), eq(briefDocuments.org_id, orgId)))
    .limit(1);
  if (!doc) return null;

  const [latest] = await db
    .select({
      version_number: briefVersions.version_number,
      created_at: briefVersions.created_at,
    })
    .from(briefVersions)
    .where(eq(briefVersions.document_id, documentId))
    .orderBy(desc(briefVersions.version_number))
    .limit(1);

  if (
    !opts.force &&
    latest &&
    Date.now() - new Date(latest.created_at).getTime() < VERSION_SNAPSHOT_THROTTLE_MS
  ) {
    return null; // a recent snapshot already covers this edit burst
  }

  const nextVersion = (latest?.version_number ?? 0) + 1;
  const [version] = await db
    .insert(briefVersions)
    .values({
      document_id: documentId,
      version_number: nextVersion,
      title: doc.title,
      yjs_state: doc.yjs_state,
      html_snapshot: doc.html_snapshot,
      plain_text: doc.plain_text,
      word_count: doc.word_count,
      change_summary: opts.changeSummary ?? null,
      created_by: userId,
    })
    .returning();

  return version ?? null;
}

export async function restoreVersion(
  documentId: string,
  versionId: string,
  userId: string,
  orgId: string,
) {
  // Verify document exists and belongs to org
  const [doc] = await db
    .select()
    .from(briefDocuments)
    .where(and(eq(briefDocuments.id, documentId), eq(briefDocuments.org_id, orgId)))
    .limit(1);

  if (!doc) throw new VersionError('NOT_FOUND', 'Document not found', 404);

  // Get the version to restore
  const [version] = await db
    .select()
    .from(briefVersions)
    .where(
      and(
        eq(briefVersions.document_id, documentId),
        eq(briefVersions.id, versionId),
      ),
    )
    .limit(1);

  if (!version) throw new VersionError('NOT_FOUND', 'Version not found', 404);

  // Update document with version content
  const [updated] = await db
    .update(briefDocuments)
    .set({
      title: version.title,
      yjs_state: version.yjs_state,
      html_snapshot: version.html_snapshot,
      plain_text: version.plain_text,
      word_count: version.word_count,
      updated_at: new Date(),
      updated_by: userId,
    })
    .where(eq(briefDocuments.id, documentId))
    .returning();

  // Create a new version snapshot to record the restore
  const [latestVersion] = await db
    .select({ version_number: briefVersions.version_number })
    .from(briefVersions)
    .where(eq(briefVersions.document_id, documentId))
    .orderBy(desc(briefVersions.version_number))
    .limit(1);

  const nextVersion = (latestVersion?.version_number ?? 0) + 1;

  await db.insert(briefVersions).values({
    document_id: documentId,
    version_number: nextVersion,
    title: version.title,
    yjs_state: version.yjs_state,
    html_snapshot: version.html_snapshot,
    plain_text: version.plain_text,
    word_count: version.word_count,
    change_summary: `Restored from version ${version.version_number}`,
    created_by: userId,
  });

  return updated!;
}

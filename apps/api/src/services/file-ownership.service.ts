/**
 * Tenant binding for the legacy `/files/` upload prefixes (#142). `uploads/` (Bam POST /upload)
 * and `helpdesk/` (helpdesk-api POST /helpdesk/upload) keys used to be served to any signed-in
 * user of any org. Each upload now records its owning org in file_upload_owners (migration 0310
 * also backfills existing objects from the content that links them), and GET /files serves such
 * a key only to a caller whose active org owns it.
 */
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { fileUploadOwners } from '../db/schema/file-upload-owners.js';

export type UploadSource = 'bam' | 'helpdesk';

/** Record (idempotently) which org owns an uploaded key. */
export async function recordUploadOwner(
  storageKey: string,
  orgId: string,
  source: UploadSource,
  uploadedBy: string | null,
): Promise<void> {
  await db
    .insert(fileUploadOwners)
    .values({ storage_key: storageKey, org_id: orgId, source, uploaded_by: uploadedBy })
    .onConflictDoNothing({ target: fileUploadOwners.storage_key });
}

/** The org that owns `storageKey`, or null when nothing records it. */
export async function uploadOwnerOrg(storageKey: string): Promise<string | null> {
  const [row] = await db
    .select({ org_id: fileUploadOwners.org_id })
    .from(fileUploadOwners)
    .where(eq(fileUploadOwners.storage_key, storageKey))
    .limit(1);
  return row?.org_id ?? null;
}

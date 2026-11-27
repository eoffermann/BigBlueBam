import { randomUUID } from 'node:crypto';
import { eq, asc } from 'drizzle-orm';
import { db } from '../db/index.js';
import { beaconAttachments, beaconEntries, users } from '../db/schema/index.js';
import { uploadFile, deleteFile, getPresignedGetUrl } from '../lib/storage-driver.js';

export class AttachmentError extends Error {
  code: string;
  statusCode: number;
  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = 'AttachmentError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const BLOCKED_MIME_TYPES = ['image/svg+xml'];

export function isAllowedContentType(contentType: string): boolean {
  if (BLOCKED_MIME_TYPES.includes(contentType)) return false;
  if (contentType.startsWith('image/')) return true;
  if (contentType.startsWith('text/')) return true;
  const allowed = [
    'application/pdf',
    'application/json',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/zip',
  ];
  return allowed.includes(contentType);
}

export function buildStorageKey(
  orgId: string,
  beaconId: string,
  filename: string,
): string {
  const uuid = randomUUID();
  const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `beacon-attachments/${orgId}/${beaconId}/${uuid}/${safeFilename}`;
}

/**
 * List attachments for a beacon. Caller is responsible for verifying read
 * access via requireBeaconReadAccess().
 */
export async function listAttachments(beaconId: string) {
  const rows = await db
    .select({
      id: beaconAttachments.id,
      beacon_id: beaconAttachments.beacon_id,
      filename: beaconAttachments.filename,
      content_type: beaconAttachments.content_type,
      size_bytes: beaconAttachments.size_bytes,
      storage_key: beaconAttachments.storage_key,
      sort_order: beaconAttachments.sort_order,
      uploaded_by: beaconAttachments.uploaded_by,
      created_at: beaconAttachments.created_at,
      uploader_name: users.display_name,
      uploader_email: users.email,
    })
    .from(beaconAttachments)
    .leftJoin(users, eq(users.id, beaconAttachments.uploaded_by))
    .where(eq(beaconAttachments.beacon_id, beaconId))
    .orderBy(asc(beaconAttachments.sort_order), asc(beaconAttachments.created_at));

  // Attach a short-lived presigned download URL so the frontend can render
  // image previews or download links without an extra round-trip.
  const withUrls = await Promise.all(
    rows.map(async (row) => ({
      ...row,
      download_url: await getPresignedGetUrl(row.storage_key).catch(
        () => null,
      ),
    })),
  );

  return withUrls;
}

export interface UploadAttachmentInput {
  filename: string;
  contentType: string;
  buffer: Buffer;
  orgId: string;
  beaconId: string;
  uploadedBy: string;
}

export async function uploadAttachment(input: UploadAttachmentInput) {
  if (!isAllowedContentType(input.contentType)) {
    throw new AttachmentError(
      'BAD_REQUEST',
      `Content type '${input.contentType}' is not allowed`,
      400,
    );
  }

  const storageKey = buildStorageKey(input.orgId, input.beaconId, input.filename);

  await uploadFile(storageKey, input.buffer, input.contentType);

  try {
    const rows = await db
      .insert(beaconAttachments)
      .values({
        beacon_id: input.beaconId,
        filename: input.filename,
        content_type: input.contentType,
        size_bytes: input.buffer.length,
        storage_key: storageKey,
        sort_order: 0,
        uploaded_by: input.uploadedBy,
      })
      .returning();
    const inserted = rows[0];
    if (!inserted) {
      await deleteFile(storageKey);
      throw new AttachmentError('INTERNAL_ERROR', 'Failed to insert attachment row', 500);
    }
    return inserted;
  } catch (err) {
    // If the DB insert failed (for example because of the
    // UNIQUE(beacon_id, filename) constraint), roll back the MinIO upload
    // so we don't leak orphaned objects.
    await deleteFile(storageKey);
    const message = err instanceof Error ? err.message : 'Insert failed';
    if (message.toLowerCase().includes('unique') || message.includes('23505')) {
      throw new AttachmentError(
        'CONFLICT',
        `An attachment named '${input.filename}' already exists on this beacon`,
        409,
      );
    }
    throw err;
  }
}

export async function deleteAttachment(
  attachmentId: string,
  userId: string,
  isAdmin: boolean,
) {
  const [existing] = await db
    .select({
      id: beaconAttachments.id,
      storage_key: beaconAttachments.storage_key,
      uploaded_by: beaconAttachments.uploaded_by,
      beacon_id: beaconAttachments.beacon_id,
    })
    .from(beaconAttachments)
    .where(eq(beaconAttachments.id, attachmentId))
    .limit(1);

  if (!existing) {
    throw new AttachmentError('NOT_FOUND', 'Attachment not found', 404);
  }
  if (!isAdmin && existing.uploaded_by !== userId) {
    throw new AttachmentError(
      'FORBIDDEN',
      'You can only delete attachments you uploaded',
      403,
    );
  }

  const [deleted] = await db
    .delete(beaconAttachments)
    .where(eq(beaconAttachments.id, attachmentId))
    .returning();

  // Best-effort MinIO cleanup. The DB row is gone regardless.
  await deleteFile(existing.storage_key);

  return deleted;
}

export async function getAttachmentWithBeacon(attachmentId: string) {
  const rows = await db
    .select({
      attachment: beaconAttachments,
      beacon: beaconEntries,
    })
    .from(beaconAttachments)
    .innerJoin(beaconEntries, eq(beaconEntries.id, beaconAttachments.beacon_id))
    .where(eq(beaconAttachments.id, attachmentId))
    .limit(1);
  return rows[0] ?? null;
}

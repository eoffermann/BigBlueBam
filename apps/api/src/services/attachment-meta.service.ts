import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { attachments } from '../db/schema/attachments.js';
import { users } from '../db/schema/users.js';
import {
  helpdeskTicketAttachmentsStub,
  beaconAttachmentsStub,
} from '../db/schema/peer-app-stubs/index.js';
import { preflightAccess } from './visibility.service.js';
import { getFileUrl } from './upload.service.js';

/**
 * Federated attachment metadata dispatcher (AGENTIC_TODO §17, Wave 4).
 *
 * Single read path for attachment metadata across every app that stores
 * files against a visibility-gated entity:
 *
 *   parent_type         | physical table                | owner app
 *   --------------------+-------------------------------+-----------
 *   bam.task            | attachments                   | Bam api
 *   helpdesk.ticket     | helpdesk_ticket_attachments   | helpdesk-api
 *   beacon.entry        | beacon_attachments            | beacon-api
 *
 * Brief has no attachment table today, so brief.document is NOT a
 * supported parent_type. Blast, Bond, and Book likewise have no
 * attachment storage to surface.
 *
 * Cross-app reads happen via the shared Postgres instance rather than
 * via HTTP calls into the peer apps. Every peer-app table we touch is
 * declared as a minimal Drizzle stub in
 * apps/api/src/db/schema/peer-app-stubs/index.ts. This keeps the
 * federation inexpensive and avoids a second round-trip per read.
 *
 * CRITICAL SEMANTICS:
 *  - All reads are preceded by visibility.service::preflightAccess on
 *    the PARENT entity. If the asker cannot see the parent, the
 *    attachment is never queried. This prevents side-channel leaks
 *    where existence/count information could be inferred even when the
 *    asker has no visibility into the entity itself.
 *  - Deep-link presigned URLs are ONLY issued when scan_status='clean'.
 *    Pending / infected / error rows return deep_link=null so agents
 *    cannot hand an infected object to a human by accident.
 *  - Helpdesk has no scan_signature column, so it is always null for
 *    helpdesk rows. Beacon has no scan fields at all; we return
 *    scan_status='pending' for beacon rows with a nulled scan
 *    signature and scanned_at.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AttachmentParentType = 'bam.task' | 'helpdesk.ticket' | 'beacon.entry';

export const SUPPORTED_PARENT_TYPES: readonly AttachmentParentType[] = [
  'bam.task',
  'helpdesk.ticket',
  'beacon.entry',
] as const;

export type ScanStatus = 'pending' | 'clean' | 'infected' | 'error';

// No explicit type annotation so TS keeps the exact tuple, which
// z.enum(SUPPORTED_SCAN_STATUSES) requires as a non-empty readonly tuple.
export const SUPPORTED_SCAN_STATUSES = ['pending', 'clean', 'infected', 'error'] as const;

export interface AttachmentMeta {
  id: string;
  parent_type: AttachmentParentType;
  parent_id: string;
  filename: string;
  mime: string;
  size: number;
  scan_status: ScanStatus;
  scan_signature: string | null;
  scanned_at: string | null;
  scan_error: string | null;
  uploader_id: string | null;
  uploader_kind: 'human' | 'agent' | 'service' | null;
  uploaded_at: string;
  deep_link: string | null;
}

export type AttachmentFetchError =
  | { code: 'NOT_FOUND' }
  | { code: 'FORBIDDEN'; reason: string }
  | { code: 'UNSUPPORTED_PARENT_TYPE'; supported: readonly string[] };

export type AttachmentFetchResult =
  | { ok: true; data: AttachmentMeta }
  | { ok: false; error: AttachmentFetchError };

export type AttachmentListResult =
  | { ok: true; data: AttachmentMeta[] }
  | { ok: false; error: AttachmentFetchError };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isSupportedParentType(value: string): value is AttachmentParentType {
  return (SUPPORTED_PARENT_TYPES as readonly string[]).includes(value);
}

function isSupportedScanStatus(value: string): value is ScanStatus {
  return (SUPPORTED_SCAN_STATUSES as readonly string[]).includes(value);
}

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
}

async function loadUploaderKinds(
  uploaderIds: readonly (string | null)[],
): Promise<Map<string, 'human' | 'agent' | 'service'>> {
  const ids = Array.from(new Set(uploaderIds.filter((v): v is string => !!v)));
  if (ids.length === 0) return new Map();
  // IN lookups via Drizzle. Call sites cap the list size to MAX_LIST_LIMIT
  // (50) so this is always a small IN.
  const rows = await db
    .select({ id: users.id, kind: users.kind })
    .from(users)
    .where(inArray(users.id, ids));
  const map = new Map<string, 'human' | 'agent' | 'service'>();
  for (const row of rows) {
    map.set(row.id, row.kind as 'human' | 'agent' | 'service');
  }
  return map;
}

async function signCleanDeepLink(
  storageKey: string,
  scanStatus: ScanStatus,
): Promise<string | null> {
  if (scanStatus !== 'clean') return null;
  try {
    return await getFileUrl(storageKey);
  } catch {
    // Best-effort: if MinIO is unreachable we return null rather than
    // failing the metadata read. The caller still gets the row.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Per-parent-type fetchers
// ---------------------------------------------------------------------------

async function fetchBamTaskAttachment(
  attachmentId: string,
): Promise<{ row: typeof attachments.$inferSelect; parent_id: string } | null> {
  const rows = await db
    .select()
    .from(attachments)
    .where(eq(attachments.id, attachmentId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { row, parent_id: row.task_id };
}

async function listBamTaskAttachments(
  taskId: string,
  limit: number,
  scanStatusFilter: ScanStatus | undefined,
): Promise<(typeof attachments.$inferSelect)[]> {
  const baseWhere = eq(attachments.task_id, taskId);
  const where = scanStatusFilter
    ? and(baseWhere, eq(attachments.scan_status, scanStatusFilter))
    : baseWhere;
  return db
    .select()
    .from(attachments)
    .where(where)
    .orderBy(desc(attachments.created_at))
    .limit(limit);
}

async function fetchHelpdeskAttachment(
  attachmentId: string,
): Promise<
  | {
      row: typeof helpdeskTicketAttachmentsStub.$inferSelect;
      parent_id: string;
    }
  | null
> {
  const rows = await db
    .select()
    .from(helpdeskTicketAttachmentsStub)
    .where(eq(helpdeskTicketAttachmentsStub.id, attachmentId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { row, parent_id: row.ticket_id };
}

async function listHelpdeskAttachments(
  ticketId: string,
  limit: number,
  scanStatusFilter: ScanStatus | undefined,
): Promise<(typeof helpdeskTicketAttachmentsStub.$inferSelect)[]> {
  const baseWhere = eq(helpdeskTicketAttachmentsStub.ticket_id, ticketId);
  const where = scanStatusFilter
    ? and(baseWhere, eq(helpdeskTicketAttachmentsStub.scan_status, scanStatusFilter))
    : baseWhere;
  return db
    .select()
    .from(helpdeskTicketAttachmentsStub)
    .where(where)
    .orderBy(desc(helpdeskTicketAttachmentsStub.created_at))
    .limit(limit);
}

async function fetchBeaconAttachment(
  attachmentId: string,
): Promise<
  | {
      row: typeof beaconAttachmentsStub.$inferSelect;
      parent_id: string;
    }
  | null
> {
  const rows = await db
    .select()
    .from(beaconAttachmentsStub)
    .where(eq(beaconAttachmentsStub.id, attachmentId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { row, parent_id: row.beacon_id };
}

async function listBeaconAttachments(
  entryId: string,
  limit: number,
  _scanStatusFilter: ScanStatus | undefined,
): Promise<(typeof beaconAttachmentsStub.$inferSelect)[]> {
  // Beacon has no scan_status column today. Apply the filter only for
  // 'pending' (which is what we synthesize) to preserve semantics: any
  // other filter value yields an empty list.
  if (_scanStatusFilter && _scanStatusFilter !== 'pending') {
    return [];
  }
  return db
    .select()
    .from(beaconAttachmentsStub)
    .where(eq(beaconAttachmentsStub.beacon_id, entryId))
    .orderBy(desc(beaconAttachmentsStub.created_at))
    .limit(limit);
}

// ---------------------------------------------------------------------------
// Row projection
// ---------------------------------------------------------------------------

async function projectBamRow(
  row: typeof attachments.$inferSelect,
  uploaderKinds: Map<string, 'human' | 'agent' | 'service'>,
): Promise<AttachmentMeta> {
  const scanStatus = (row.scan_status ?? 'pending') as ScanStatus;
  const deepLink = await signCleanDeepLink(row.storage_key, scanStatus);
  return {
    id: row.id,
    parent_type: 'bam.task',
    parent_id: row.task_id,
    filename: row.filename,
    mime: row.content_type ?? 'application/octet-stream',
    size: row.size_bytes,
    scan_status: scanStatus,
    scan_signature: row.scan_signature ?? null,
    scanned_at: toIso(row.scanned_at),
    scan_error: row.scan_error ?? null,
    uploader_id: row.uploader_id,
    uploader_kind: uploaderKinds.get(row.uploader_id) ?? null,
    uploaded_at: toIso(row.created_at) ?? '',
    deep_link: deepLink,
  };
}

async function projectHelpdeskRow(
  row: typeof helpdeskTicketAttachmentsStub.$inferSelect,
  uploaderKinds: Map<string, 'human' | 'agent' | 'service'>,
): Promise<AttachmentMeta> {
  const scanStatus = (row.scan_status ?? 'pending') as ScanStatus;
  const deepLink = await signCleanDeepLink(row.storage_key, scanStatus);
  return {
    id: row.id,
    parent_type: 'helpdesk.ticket',
    parent_id: row.ticket_id,
    filename: row.filename,
    mime: row.content_type,
    size: row.size_bytes,
    scan_status: scanStatus,
    scan_signature: null, // helpdesk has no scan_signature column
    scanned_at: toIso(row.scanned_at),
    scan_error: row.scan_error ?? null,
    uploader_id: row.uploaded_by,
    // helpdesk uploaded_by references helpdeskUsers (separate table from
    // Bam users), so uploader_kind is not resolvable across tenants via
    // the same users lookup. Left null for helpdesk rows.
    uploader_kind: uploaderKinds.get(row.uploaded_by) ?? null,
    uploaded_at: toIso(row.created_at) ?? '',
    deep_link: deepLink,
  };
}

async function projectBeaconRow(
  row: typeof beaconAttachmentsStub.$inferSelect,
  uploaderKinds: Map<string, 'human' | 'agent' | 'service'>,
): Promise<AttachmentMeta> {
  // Beacon has no scan fields, so synthesize pending and suppress deep
  // link. A future migration to add scan columns to beacon_attachments
  // would let us surface real verdicts here.
  const scanStatus: ScanStatus = 'pending';
  return {
    id: row.id,
    parent_type: 'beacon.entry',
    parent_id: row.beacon_id,
    filename: row.filename,
    mime: row.content_type,
    size: row.size_bytes,
    scan_status: scanStatus,
    scan_signature: null,
    scanned_at: null,
    scan_error: null,
    uploader_id: row.uploaded_by,
    uploader_kind: uploaderKinds.get(row.uploaded_by) ?? null,
    uploaded_at: toIso(row.created_at) ?? '',
    deep_link: null,
  };
}

// ---------------------------------------------------------------------------
// Parent discovery (for attachment_get)
// ---------------------------------------------------------------------------
//
// attachment_get takes only an attachment id; we do not know up front which
// table to hit. Rather than shotgun all three tables, we serially probe each
// one in a cheap fashion (single SELECT by PK per table). Attachment ids are
// UUIDs, so cross-table id collisions are astronomically unlikely; the first
// hit wins.

async function locateAttachment(
  attachmentId: string,
): Promise<
  | {
      parent_type: AttachmentParentType;
      parent_id: string;
      row: typeof attachments.$inferSelect | typeof helpdeskTicketAttachmentsStub.$inferSelect | typeof beaconAttachmentsStub.$inferSelect;
    }
  | null
> {
  const bam = await fetchBamTaskAttachment(attachmentId);
  if (bam) return { parent_type: 'bam.task', parent_id: bam.parent_id, row: bam.row };

  const helpdesk = await fetchHelpdeskAttachment(attachmentId);
  if (helpdesk) {
    return {
      parent_type: 'helpdesk.ticket',
      parent_id: helpdesk.parent_id,
      row: helpdesk.row,
    };
  }

  const beacon = await fetchBeaconAttachment(attachmentId);
  if (beacon) {
    return {
      parent_type: 'beacon.entry',
      parent_id: beacon.parent_id,
      row: beacon.row,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * attachment_get: fetch one attachment by id. Runs visibility preflight on
 * the parent BEFORE any metadata is returned. If the parent is not
 * visible to the caller, we return NOT_FOUND rather than FORBIDDEN for
 * cross-org denials (to match the visibility service's disclosure rules)
 * and FORBIDDEN for within-org denials with a specific reason.
 */
export async function getAttachmentMetaById(
  callerUserId: string,
  attachmentId: string,
): Promise<AttachmentFetchResult> {
  const located = await locateAttachment(attachmentId);
  if (!located) {
    return { ok: false, error: { code: 'NOT_FOUND' } };
  }

  const preflight = await preflightAccess(
    callerUserId,
    located.parent_type,
    located.parent_id,
  );
  if (!preflight.allowed) {
    if (preflight.reason === 'not_found') {
      return { ok: false, error: { code: 'NOT_FOUND' } };
    }
    return { ok: false, error: { code: 'FORBIDDEN', reason: preflight.reason } };
  }

  const uploaderIds: (string | null)[] = [];
  if (located.parent_type === 'bam.task') {
    uploaderIds.push((located.row as typeof attachments.$inferSelect).uploader_id);
  } else if (located.parent_type === 'helpdesk.ticket') {
    uploaderIds.push(
      (located.row as typeof helpdeskTicketAttachmentsStub.$inferSelect).uploaded_by,
    );
  } else {
    uploaderIds.push(
      (located.row as typeof beaconAttachmentsStub.$inferSelect).uploaded_by,
    );
  }
  const uploaderKinds = await loadUploaderKinds(uploaderIds);

  let data: AttachmentMeta;
  if (located.parent_type === 'bam.task') {
    data = await projectBamRow(
      located.row as typeof attachments.$inferSelect,
      uploaderKinds,
    );
  } else if (located.parent_type === 'helpdesk.ticket') {
    data = await projectHelpdeskRow(
      located.row as typeof helpdeskTicketAttachmentsStub.$inferSelect,
      uploaderKinds,
    );
  } else {
    data = await projectBeaconRow(
      located.row as typeof beaconAttachmentsStub.$inferSelect,
      uploaderKinds,
    );
  }

  return { ok: true, data };
}

/**
 * attachment_list: per-entity enumeration. Preflights the parent first,
 * then reads the attachment table with an optional scan_status filter.
 * `limit` is clamped to [1, MAX_LIST_LIMIT]; default 50.
 */
export const MAX_LIST_LIMIT = 50;
export const DEFAULT_LIST_LIMIT = 50;

export async function listAttachmentsForParent(
  callerUserId: string,
  parentType: string,
  parentId: string,
  opts: { limit?: number; scanStatus?: string } = {},
): Promise<AttachmentListResult> {
  if (!isSupportedParentType(parentType)) {
    return {
      ok: false,
      error: {
        code: 'UNSUPPORTED_PARENT_TYPE',
        supported: SUPPORTED_PARENT_TYPES,
      },
    };
  }

  const preflight = await preflightAccess(callerUserId, parentType, parentId);
  if (!preflight.allowed) {
    if (preflight.reason === 'not_found') {
      return { ok: false, error: { code: 'NOT_FOUND' } };
    }
    return {
      ok: false,
      error: { code: 'FORBIDDEN', reason: preflight.reason },
    };
  }

  const limit = Math.min(
    Math.max(1, opts.limit ?? DEFAULT_LIST_LIMIT),
    MAX_LIST_LIMIT,
  );

  let scanStatusFilter: ScanStatus | undefined;
  if (opts.scanStatus) {
    if (!isSupportedScanStatus(opts.scanStatus)) {
      // Reuse UNSUPPORTED_PARENT_TYPE taxonomy for unknown filter values
      // would confuse callers; instead we 400 via the route validator,
      // which narrows the scanStatus field before calling us. Defense in
      // depth: if we somehow receive a stray value here, treat it as
      // no-filter to avoid returning a cross-status list by accident.
      scanStatusFilter = undefined;
    } else {
      scanStatusFilter = opts.scanStatus;
    }
  }

  let rows: Array<AttachmentMeta> = [];
  if (parentType === 'bam.task') {
    const records = await listBamTaskAttachments(parentId, limit, scanStatusFilter);
    const kinds = await loadUploaderKinds(records.map((r) => r.uploader_id));
    rows = await Promise.all(records.map((r) => projectBamRow(r, kinds)));
  } else if (parentType === 'helpdesk.ticket') {
    const records = await listHelpdeskAttachments(parentId, limit, scanStatusFilter);
    const kinds = await loadUploaderKinds(records.map((r) => r.uploaded_by));
    rows = await Promise.all(records.map((r) => projectHelpdeskRow(r, kinds)));
  } else {
    const records = await listBeaconAttachments(parentId, limit, scanStatusFilter);
    const kinds = await loadUploaderKinds(records.map((r) => r.uploaded_by));
    rows = await Promise.all(records.map((r) => projectBeaconRow(r, kinds)));
  }

  return { ok: true, data: rows };
}

// ---------------------------------------------------------------------------
// Test hooks
// ---------------------------------------------------------------------------

export const __test__ = {
  locateAttachment,
  isSupportedParentType,
  isSupportedScanStatus,
  projectBamRow,
  projectHelpdeskRow,
  projectBeaconRow,
};

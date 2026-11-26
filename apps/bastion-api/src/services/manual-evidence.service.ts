// Uploaded and manual evidence (spec 3.3, 3.4; 5.1 rows 32-41). Every query carries an explicit
// organization_id predicate inside an org-scoped transaction (RLS GUC bound).
//
//   create      a Bin file (copied at attach by scan state) or a written statement; the
//               uploader's statement is required; personal data goes to bastion_personal_data and
//               only its HMAC reaches the immutable row; active items get a ledger entry.
//   link        a manual check this item proves; each link waits for review.
//   review      a second person accepts it or says it shows an exception (small-team rule).
//   withdraw    confirm-gated; the item stops counting, a ledger entry records it.
//   supersede   a newer item replaces it; live links move to the new item for review.
//   redact      owner-only, confirm-gated: personal data blanked; a manual-evidence holder is
//               withdrawn (reason `redacted`) and its bytes deleted when no other holder remains.
//
// Every change that can move a control re-evaluates the linked controls (control-scope runs).

import {
  endOfDayInTz,
  localDateInTz,
  type BastionManualEvidenceCreate,
  type BastionManualEvidenceListQuery,
  type BastionManualEvidenceReview,
} from '@bigbluebam/shared';
import { randomUUID } from 'node:crypto';
import { withStorageTimeout } from '@bigbluebam/storage';
import { auditRaw, viewerKind } from '../lib/audit-raw.js';
import { downloadHeaders } from '../lib/download.js';
import { ConflictError, ForbiddenError, NotFoundError, UnavailableError, ValidationFailure } from '../lib/errors.js';
import { recheckPinnedAsset, resolveBinAssetForEvidence, type ScanDecision } from '../lib/bin-asset-access.js';
import { orgTx, type Tx } from '../engine/context.js';
import {
  abandonStored,
  controlsLinkedTo,
  copyFromBin,
  dropDuplicate,
  type QueuedRun,
  queueControlRuns,
  recordObject,
  type StoredBytes,
  storeBuffer,
} from '../engine/evidence-store.js';
import { EVIDENCE_COPY_LEASE_MS, EVIDENCE_COPY_TIMEOUT_MS, estimateCopyMs } from '../engine/budgets.js';
import { appendLedger } from '../engine/ledger.js';
import { daysLeft } from '../engine/manual.js';
import { enqueueBastionEvent } from '../engine/outbox.js';
import type { SealIdentity } from '../engine/restore.js';
import type { EvidenceDeps } from './evidence-deps.js';
import { beginLedgerBatch, mapAppendError } from './ledger-batch.js';
import type { Viewer } from './types.js';

const DAY_MS = 86_400_000;
export const SMALL_TEAM_HUMANS = 3;
/** Pending-scan retry schedule: 5 min doubling to 6 h; after 24 h, once a day (spec 3.3, 7). */
export function nextScanAttemptAt(createdAt: Date, attempts: number, now: Date): Date {
  if (now.getTime() - createdAt.getTime() >= DAY_MS) return new Date(now.getTime() + DAY_MS);
  const delay = Math.min(5 * 60_000 * 2 ** Math.max(0, attempts), 6 * 3_600_000);
  return new Date(now.getTime() + delay);
}

const UPLOADER_STATEMENT = (source: string) =>
  `I confirm this is a true and unaltered copy of what ${source} produced, and that it is fit to show an auditor.`;

async function orgTimezone(tx: Tx, orgId: string): Promise<string> {
  const r = (await tx`SELECT timezone FROM bastion_org_settings WHERE organization_id = ${orgId}`)[0];
  return String(r?.timezone ?? 'UTC');
}

async function humanCount(tx: Tx, orgId: string): Promise<number> {
  const r = await tx`
    SELECT count(DISTINCT u.id)::int AS n
      FROM organization_memberships m JOIN users u ON u.id = m.user_id
     WHERE m.org_id = ${orgId} AND u.kind = 'human' AND u.is_active`;
  return Number(r[0]?.n ?? 0);
}

async function memberName(tx: Tx, orgId: string, userId: string): Promise<string | null> {
  const r = await tx`
    SELECT u.display_name FROM users u
      JOIN organization_memberships m ON m.user_id = u.id AND m.org_id = ${orgId}
     WHERE u.id = ${userId}`;
  return r[0] ? String(r[0].display_name) : null;
}

/** The manual checks a body may link: confirmed or proposed `manual` assertions in this org. */
async function manualAssertions(tx: Tx, orgId: string, ids: string[]): Promise<Array<{ id: string; control_id: string }>> {
  if (ids.length === 0) return [];
  const rows = await tx`
    SELECT id, control_id FROM bastion_assertions
     WHERE organization_id = ${orgId} AND id = ANY(${ids}::uuid[]) AND kind = 'manual'
       AND review_status IN ('proposed', 'confirmed')`;
  if (rows.length !== new Set(ids).size) {
    throw new ValidationFailure('One of the checks you picked is not a manual evidence check in this organization.', 'NOT_A_MANUAL_CHECK', [
      { field: 'assertion_ids', issue: 'not_manual_check' },
    ]);
  }
  return rows.map((r) => ({ id: String(r.id), control_id: String(r.control_id) }));
}

async function afterCommit(d: EvidenceDeps, runs: QueuedRun[]): Promise<void> {
  if (runs.length > 0) await d.enqueueRuns(runs).catch(() => undefined);
}

// ── Create and supersede ────────────────────────────────────────────────────────────────

interface Prepared {
  stored: StoredBytes | null;
  status: 'active' | 'pending_scan' | 'blocked';
  blocked_reason: string | null;
  scan_label: 'clean' | 'not_scanned' | null;
  bin_asset_id: string | null;
  bin_asset_version_id: string | null;
  size_bytes: number | null;
  content_type: string | null;
}

async function prepareBytes(d: EvidenceDeps, viewer: Viewer, body: BastionManualEvidenceCreate): Promise<Prepared> {
  const engine = d.engine;
  if (body.kind === 'attestation_statement') {
    const stored = await storeBuffer(engine, viewer.org_id, Buffer.from(body.statement, 'utf8'), 'text/plain; charset=utf-8');
    return { stored, status: 'active', blocked_reason: null, scan_label: null, bin_asset_id: null, bin_asset_version_id: null, size_bytes: stored.size_bytes, content_type: stored.content_type };
  }
  const resolved = await orgTx(engine.sql, viewer.org_id, (tx) => resolveBinAssetForEvidence(d.bin(tx), viewer.id, viewer.org_id, body.bin_asset_id));
  const base = {
    bin_asset_id: resolved.asset.id,
    bin_asset_version_id: resolved.version.id,
    size_bytes: resolved.version.size,
    content_type: resolved.version.content_type,
  };
  const dec: ScanDecision = resolved.decision;
  if (dec.action === 'block') return { ...base, stored: null, status: 'blocked', blocked_reason: dec.blocked_reason, scan_label: null };
  if (dec.action === 'wait') return { ...base, stored: null, status: 'pending_scan', blocked_reason: null, scan_label: null };
  const stored = await copyFromBin(engine, d.binStorage, viewer.org_id, resolved.version);
  return { ...base, stored, status: 'active', blocked_reason: null, scan_label: dec.scan_label, size_bytes: stored.size_bytes };
}

/** Insert one manual-evidence item (and its personal data, links, ledger entry and event). */
async function insertItem(
  d: EvidenceDeps,
  tx: Tx,
  viewer: Viewer,
  body: BastionManualEvidenceCreate,
  p: Prepared,
  highest: SealIdentity | null,
  supersedeId: string | null,
): Promise<{ id: string; duplicate_key: string | null; runs: QueuedRun[] }> {
  const orgId = viewer.org_id;
  const now = d.engine.now();
  // Supersede (#213): lock the old item in THIS transaction and re-read its live links here, so a
  // double-submit or a withdraw/redact that landed while the bytes were copying is a 409, never a
  // second active replacement or a replacement of withdrawn evidence.
  const supersedes = supersedeId ? await lockSuperseded(tx, orgId, supersedeId) : null;
  const ownerName = await memberName(tx, orgId, body.owner_user_id);
  if (!ownerName) {
    throw new ValidationFailure('The owner must be a member of this organization.', 'OWNER_NOT_MEMBER', [{ field: 'owner_user_id', issue: 'not_member' }]);
  }
  const tz = await orgTimezone(tx, orgId);
  const validUntil = endOfDayInTz(body.valid_until, tz);
  if (validUntil.getTime() <= now.getTime()) {
    throw new ValidationFailure('This evidence has already expired. Pick a date that has not passed.', 'ALREADY_EXPIRED', [{ field: 'valid_until', issue: 'in_past' }]);
  }
  const links = await manualAssertions(tx, orgId, body.assertion_ids ?? []);
  const uploaderName = (await memberName(tx, orgId, viewer.id)) ?? 'Unknown';
  const pdData = {
    uploaded_by_name: uploaderName,
    owner_name: ownerName,
    uploader_statement: UPLOADER_STATEMENT(body.source_system),
  };
  const pdHmac = d.engine.pdHmac(pdData);

  let objectKey: string | null = null;
  let duplicateKey: string | null = null;
  if (p.stored) {
    const rec = await recordObject(tx, orgId, p.stored);
    objectKey = rec.object_key;
    duplicateKey = rec.duplicate_key;
  }

  const id = randomUUID();
  let ledgerSeq: number | null = null;
  if (p.status === 'active' && p.stored) {
    const [entry] = await appendLedger(
      tx,
      orgId,
      [{ kind: 'manual_evidence', id, content_sha256: p.stored.content_sha256, personal_data_hmac: pdHmac, pd_hmac_key_id: d.engine.pdKeyId }],
      { highest, now },
    );
    ledgerSeq = entry?.seq ?? null;
  }
  await tx`
    INSERT INTO bastion_manual_evidence
      (id, organization_id, kind, title, description, source_system, bin_asset_id, bin_asset_version_id, content_sha256,
       size_bytes, content_type, scan_label, owner_user_id, uploaded_by, produced_on, period_start, period_end, valid_until,
       sensitivity, uploader_statement_at, status, blocked_reason, attempts, next_attempt_at, personal_data_hmac,
       pd_hmac_key_id, ledger_seq)
    VALUES (${id}, ${orgId}, ${body.kind}, ${body.title}, ${body.description ?? null}, ${body.source_system},
            ${p.bin_asset_id}, ${p.bin_asset_version_id}, ${p.stored?.content_sha256 ?? null}, ${p.size_bytes},
            ${p.content_type}, ${p.scan_label}, ${body.owner_user_id}, ${viewer.id}, ${body.produced_on}::date,
            ${body.period_start ?? null}::date, ${body.period_end ?? null}::date, ${validUntil}, ${body.sensitivity},
            ${now}, ${p.status}, ${p.blocked_reason}, 0,
            ${p.status === 'pending_scan' ? nextScanAttemptAt(now, 0, now) : null},
            ${pdHmac}, ${d.engine.pdKeyId}, ${ledgerSeq})`;
  // The holder reads the object by content hash, so a duplicate needs nothing recorded here; its
  // own copy and intent row are removed after commit (dropDuplicate).
  void objectKey;
  await tx`
    INSERT INTO bastion_personal_data (organization_id, holder_kind, holder_id, data, data_hmac, pd_hmac_key_id)
    VALUES (${orgId}, 'manual_evidence', ${id}, ${tx.json(pdData as never)}, ${pdHmac}, ${d.engine.pdKeyId})`;

  const allLinks = new Map<string, string>();
  for (const l of supersedes?.links ?? []) allLinks.set(l.assertion_id, l.control_id);
  for (const l of links) allLinks.set(l.id, l.control_id);
  for (const assertionId of allLinks.keys()) {
    await tx`
      INSERT INTO bastion_manual_evidence_links (organization_id, manual_evidence_id, assertion_id, linked_by, linked_at)
      VALUES (${orgId}, ${id}, ${assertionId}, ${viewer.id}, ${now})
      ON CONFLICT (organization_id, manual_evidence_id, assertion_id) DO NOTHING`;
  }

  let runs: QueuedRun[] = [];
  if (supersedes) {
    const moved = await tx`
      UPDATE bastion_manual_evidence SET status = 'superseded', superseded_by_id = ${id}
       WHERE organization_id = ${orgId} AND id = ${supersedes.id} AND status = 'active'
      RETURNING id`;
    if (moved.length !== 1) throw new ConflictError(NOT_ACTIVE_FOR_SUPERSEDE, 'NOT_ACTIVE');
    await tx`UPDATE bastion_manual_evidence_links SET unlinked_at = ${now}
              WHERE organization_id = ${orgId} AND manual_evidence_id = ${supersedes.id} AND unlinked_at IS NULL`;
    const kind = await viewerKind(tx, viewer);
    runs = await queueControlRuns(tx, orgId, new Set(supersedes.links.map((l) => l.control_id)), now, viewer.id, kind === 'human' ? 'manual' : 'agent');
  }

  await enqueueBastionEvent(
    'evidence.uploaded',
    { manual_evidence_id: id, kind: body.kind, status: p.status, supersedes_id: supersedes?.id ?? null, linked_assertion_count: allLinks.size },
    tx,
    { orgId, idempotencyKey: `evidence.uploaded:${id}`, actorId: viewer.id, actorType: 'user' },
  );
  await auditRaw(tx, viewer, supersedes ? 'manual_evidence.supersede' : 'manual_evidence.create', { type: 'manual_evidence', id }, {
    kind: body.kind,
    status: p.status,
    supersedes_id: supersedes?.id ?? null,
  });
  return { id, duplicate_key: duplicateKey, runs };
}

const NOT_ACTIVE_FOR_SUPERSEDE = 'Only evidence that is in use can be replaced by a newer copy. It may have just been replaced or withdrawn; refresh to see.';

/** Lock the item being replaced and read its live links (inside the inserting transaction, #213). */
async function lockSuperseded(tx: Tx, orgId: string, id: string) {
  const old = (await tx`SELECT status FROM bastion_manual_evidence WHERE organization_id = ${orgId} AND id = ${id} FOR UPDATE`)[0];
  if (!old) throw new NotFoundError('We could not find that evidence.');
  if (old.status !== 'active') throw new ConflictError(NOT_ACTIVE_FOR_SUPERSEDE, 'NOT_ACTIVE');
  const links = await tx`
    SELECT l.assertion_id, a.control_id FROM bastion_manual_evidence_links l
      JOIN bastion_assertions a ON a.id = l.assertion_id AND a.organization_id = l.organization_id
     WHERE l.organization_id = ${orgId} AND l.manual_evidence_id = ${id} AND l.unlinked_at IS NULL`;
  return { id, links: links.map((l) => ({ assertion_id: String(l.assertion_id), control_id: String(l.control_id) })) };
}

async function createOrSupersede(
  d: EvidenceDeps,
  viewer: Viewer,
  body: BastionManualEvidenceCreate,
  supersedeId: string | null,
  canRestricted: boolean,
) {
  const engine = d.engine;
  const orgId = viewer.org_id;
  if (supersedeId) {
    // Early answer before any bytes are copied; insertItem re-checks under a row lock (#213).
    await orgTx(engine.sql, orgId, async (tx) => {
      const old = (await tx`SELECT id, status, sensitivity FROM bastion_manual_evidence WHERE organization_id = ${orgId} AND id = ${supersedeId}`)[0];
      // Nobody replaces (and takes the links of) restricted evidence they may not read (#209).
      if (!old || (old.sensitivity === 'restricted' && !canRestricted)) throw new NotFoundError('We could not find that evidence.');
      if (old.status !== 'active') throw new ConflictError(NOT_ACTIVE_FOR_SUPERSEDE, 'NOT_ACTIVE');
    });
  }
  const highest = await beginLedgerBatch(engine, orgId);
  const prepared = await prepareBytes(d, viewer, body);
  let result: { id: string; duplicate_key: string | null; runs: QueuedRun[] };
  try {
    result = await orgTx(engine.sql, orgId, (tx) => insertItem(d, tx, viewer, body, prepared, highest, supersedeId));
  } catch (err) {
    await abandonStored(engine, orgId, prepared.stored);
    throw mapAppendError(err);
  }
  await dropDuplicate(engine, orgId, result.duplicate_key);
  if (prepared.status === 'pending_scan') await d.enqueueIngest(orgId, result.id).catch(() => undefined);
  await afterCommit(d, result.runs);
  // The new item holds only what this caller just sent (its links start pending, with no review
  // notes), so they get it back in full even when they marked it restricted.
  return getManualEvidence(d, viewer, result.id, true);
}

/** POST /manual-evidence (row 32). */
export function createManualEvidence(d: EvidenceDeps, viewer: Viewer, body: BastionManualEvidenceCreate) {
  return createOrSupersede(d, viewer, body, null, false);
}

/** POST /manual-evidence/:id/supersede (row 40). */
export function supersedeManualEvidence(d: EvidenceDeps, viewer: Viewer, id: string, body: BastionManualEvidenceCreate, canRestricted: boolean) {
  return createOrSupersede(d, viewer, body, id, canRestricted);
}

// ── Reads ───────────────────────────────────────────────────────────────────────────────

const ITEM_SELECT = `e.id, e.kind, e.title, e.description, e.source_system, e.content_sha256, e.size_bytes, e.content_type,
  e.scan_label, e.owner_user_id, ou.display_name AS owner_name, e.uploaded_by, uu.display_name AS uploaded_by_name,
  e.produced_on::text AS produced_on, e.period_start::text AS period_start, e.period_end::text AS period_end, e.valid_until,
  e.sensitivity, e.status, e.blocked_reason, e.attempts, e.next_attempt_at, e.superseded_by_id, e.withdrawn_reason,
  e.withdrawn_at, e.redacted_at, e.ledger_seq, e.created_at, e.updated_at,
  pd.id AS personal_data_id`;

const ITEM_FROM = `FROM bastion_manual_evidence e
  LEFT JOIN users ou ON ou.id = e.owner_user_id
  LEFT JOIN users uu ON uu.id = e.uploaded_by
  LEFT JOIN bastion_personal_data pd ON pd.organization_id = e.organization_id AND pd.holder_kind = 'manual_evidence' AND pd.holder_id = e.id`;

function shape(row: Record<string, unknown>, links: Array<Record<string, unknown>>, now: Date, canRestricted: boolean) {
  const restricted = row.sensitivity === 'restricted';
  const masked = restricted && !canRestricted;
  const validUntil = row.valid_until ? new Date(row.valid_until as string) : null;
  const created = new Date(row.created_at as string);
  const stuck = row.status === 'pending_scan' && now.getTime() - created.getTime() >= DAY_MS;
  return {
    ...row,
    title: masked ? 'Restricted evidence' : row.title,
    description: masked ? null : row.description,
    content_sha256: masked ? null : row.content_sha256,
    restricted,
    masked,
    trust_label: row.kind === 'attestation_statement' ? 'Self-attested' : 'Uploaded evidence',
    scan_note: row.scan_label === 'not_scanned' ? 'Not virus-scanned (scanning is off on this installation)' : null,
    days_left: validUntil ? daysLeft(validUntil, now) : null,
    stuck_scan: stuck,
    links: links.map((l) => ({
      assertion_id: l.assertion_id,
      control_id: l.control_id,
      control_title: l.control_title,
      plain_statement: l.plain_statement,
      review_verdict: l.review_verdict,
      reviewed_by: l.reviewed_by,
      reviewed_by_name: l.reviewed_by_name,
      reviewed_at: l.reviewed_at,
      review_note: masked ? null : l.review_note,
      small_team_self_review: l.small_team_self_review,
      linked_at: l.linked_at,
    })),
  };
}

async function linksFor(tx: Tx, orgId: string, ids: string[]) {
  if (ids.length === 0) return new Map<string, Array<Record<string, unknown>>>();
  const rows = await tx`
    SELECT l.manual_evidence_id, l.assertion_id, a.control_id, c.title AS control_title, a.plain_statement, l.review_verdict,
           l.reviewed_by, ru.display_name AS reviewed_by_name, l.reviewed_at, l.review_note, l.small_team_self_review, l.linked_at
      FROM bastion_manual_evidence_links l
      JOIN bastion_assertions a ON a.id = l.assertion_id AND a.organization_id = l.organization_id
      JOIN bastion_controls c ON c.id = a.control_id AND c.organization_id = a.organization_id
      LEFT JOIN users ru ON ru.id = l.reviewed_by
     WHERE l.organization_id = ${orgId} AND l.manual_evidence_id = ANY(${ids}::uuid[]) AND l.unlinked_at IS NULL
     ORDER BY l.linked_at`;
  const out = new Map<string, Array<Record<string, unknown>>>();
  for (const r of rows) {
    const k = String(r.manual_evidence_id);
    const list = out.get(k) ?? [];
    list.push(r as Record<string, unknown>);
    out.set(k, list);
  }
  return out;
}

/** GET /manual-evidence (row 33). Restricted items are listed but masked without read_restricted. */
export async function listManualEvidence(d: EvidenceDeps, viewer: Viewer, q: BastionManualEvidenceListQuery, canRestricted: boolean) {
  const now = d.engine.now();
  return orgTx(d.engine.sql, viewer.org_id, async (tx) => {
    const rows = (await tx.unsafe(
      `SELECT ${ITEM_SELECT} ${ITEM_FROM}
        WHERE e.organization_id = $1
          AND ($2::text IS NULL OR e.status = $2)
          AND ($3::text IS NULL OR e.kind = $3)
          AND ($4::uuid IS NULL OR EXISTS (SELECT 1 FROM bastion_manual_evidence_links l WHERE l.organization_id = e.organization_id
                                             AND l.manual_evidence_id = e.id AND l.assertion_id = $4 AND l.unlinked_at IS NULL))
          AND ($5::uuid IS NULL OR EXISTS (SELECT 1 FROM bastion_manual_evidence_links l
                                             JOIN bastion_assertions a ON a.id = l.assertion_id AND a.organization_id = l.organization_id
                                            WHERE l.organization_id = e.organization_id AND l.manual_evidence_id = e.id
                                              AND a.control_id = $5 AND l.unlinked_at IS NULL))
          AND ($6::boolean IS NOT TRUE OR (e.status = 'pending_scan' AND e.created_at <= $7::timestamptz))
        ORDER BY e.created_at DESC LIMIT $8`,
      [viewer.org_id, q.status ?? null, q.kind ?? null, q.assertion_id ?? null, q.control_id ?? null, q.stuck ?? null, new Date(now.getTime() - DAY_MS), q.limit],
    )) as unknown as Array<Record<string, unknown>>;
    const links = await linksFor(tx, viewer.org_id, rows.map((r) => String(r.id)));
    const counts = (await tx`
      SELECT count(*) FILTER (WHERE status = 'active')::int AS active,
             count(*) FILTER (WHERE status = 'pending_scan')::int AS pending_scan,
             count(*) FILTER (WHERE status = 'pending_scan' AND created_at <= ${new Date(now.getTime() - DAY_MS)})::int AS stuck,
             count(*) FILTER (WHERE status = 'blocked')::int AS blocked,
             count(*) FILTER (WHERE status = 'active' AND scan_label = 'not_scanned')::int AS not_scanned
        FROM bastion_manual_evidence WHERE organization_id = ${viewer.org_id}`)[0];
    return {
      data: rows.map((r) => shape(r, links.get(String(r.id)) ?? [], now, canRestricted)),
      counts,
      next_cursor: null,
    };
  });
}

/** GET /manual-evidence/:id (row 34). A restricted item is 404 without read_restricted. */
export async function getManualEvidence(d: EvidenceDeps, viewer: Viewer, id: string, canRestricted: boolean) {
  const now = d.engine.now();
  return orgTx(d.engine.sql, viewer.org_id, async (tx) => {
    const rows = (await tx.unsafe(`SELECT ${ITEM_SELECT} ${ITEM_FROM} WHERE e.organization_id = $1 AND e.id = $2`, [viewer.org_id, id])) as unknown as Array<
      Record<string, unknown>
    >;
    const row = rows[0];
    if (!row || (row.sensitivity === 'restricted' && !canRestricted)) throw new NotFoundError('We could not find that evidence.');
    const links = await linksFor(tx, viewer.org_id, [id]);
    return { data: shape(row, links.get(id) ?? [], now, canRestricted) };
  });
}

/** GET /manual-evidence/:id/download (row 35). The route checks read_detail; restricted needs more. */
export async function openManualEvidenceDownload(d: EvidenceDeps, viewer: Viewer, id: string, canRestricted: boolean) {
  const engine = d.engine;
  const row = await orgTx(engine.sql, viewer.org_id, async (tx) => {
    const r = (await tx`
      SELECT e.title, e.kind, e.sensitivity, e.content_sha256, e.content_type, o.object_key, o.bytes_redacted_at, o.size_bytes
        FROM bastion_manual_evidence e
        LEFT JOIN bastion_evidence_objects o ON o.organization_id = e.organization_id AND o.content_sha256 = e.content_sha256
       WHERE e.organization_id = ${viewer.org_id} AND e.id = ${id}`)[0];
    if (!r || (r.sensitivity === 'restricted' && !canRestricted)) throw new NotFoundError('We could not find that evidence.');
    await auditRaw(tx, viewer, 'manual_evidence.download', { type: 'manual_evidence', id });
    return r;
  });
  if (!row.object_key) throw new NotFoundError('There is no file to download for this evidence yet.');
  if (row.bytes_redacted_at) throw new NotFoundError('This file was redacted and can no longer be downloaded.');
  if (!engine.storage) throw new UnavailableError("Evidence storage isn't set up on this installation.", 'STORAGE_NOT_SET_UP');
  let obj: Awaited<ReturnType<typeof engine.storage.getStream>>;
  try {
    obj = await withStorageTimeout('get', engine.storage.getStream(row.object_key as string), engine.putTimeoutMs);
  } catch {
    engine.log.error({ organization_id: viewer.org_id, manual_evidence_id: id }, 'bastion-evidence: evidence file missing from the bucket');
    throw new NotFoundError('Evidence file missing.');
  }
  const ext = row.kind === 'attestation_statement' ? '.txt' : '';
  return {
    stream: obj.stream,
    headers: downloadHeaders({ contentType: row.content_type as string | null, filename: `${row.title as string}${ext}`, size: Number(row.size_bytes ?? obj.size) }),
  };
}

// ── Links and reviews ───────────────────────────────────────────────────────────────────

/**
 * Lock one item. A restricted item is "not found" to a caller without read_restricted (#209), so
 * every mutation behaves like GET /manual-evidence/:id: nobody acts on, or reads back, evidence
 * they may not see. Pass `canRestricted: true` only for system callers (redaction is owner-only).
 */
async function loadItem(tx: Tx, orgId: string, id: string, canRestricted: boolean) {
  const r = (await tx`SELECT id, status, uploaded_by, kind, sensitivity FROM bastion_manual_evidence
                       WHERE organization_id = ${orgId} AND id = ${id} FOR UPDATE`)[0];
  if (!r || (r.sensitivity === 'restricted' && !canRestricted)) throw new NotFoundError('We could not find that evidence.');
  return r;
}

/** POST /manual-evidence/:id/links (row 36). */
export async function linkManualEvidence(d: EvidenceDeps, viewer: Viewer, id: string, assertionId: string, canRestricted: boolean) {
  const now = d.engine.now();
  await orgTx(d.engine.sql, viewer.org_id, async (tx) => {
    const item = await loadItem(tx, viewer.org_id, id, canRestricted);
    if (item.status === 'withdrawn' || item.status === 'superseded') {
      throw new ConflictError('This evidence is no longer in use, so it cannot prove anything new.', 'NOT_ACTIVE');
    }
    const [a] = await manualAssertions(tx, viewer.org_id, [assertionId]);
    const existing = (await tx`SELECT id, unlinked_at FROM bastion_manual_evidence_links
                                 WHERE organization_id = ${viewer.org_id} AND manual_evidence_id = ${id} AND assertion_id = ${assertionId}`)[0];
    if (existing && !existing.unlinked_at) throw new ConflictError('This evidence is already linked to that check.', 'ALREADY_LINKED');
    if (existing) {
      // Re-linking starts a fresh review.
      await tx`UPDATE bastion_manual_evidence_links
                  SET unlinked_at = NULL, review_verdict = 'pending', reviewed_by = NULL, reviewed_at = NULL, review_note = NULL,
                      small_team_self_review = false, linked_by = ${viewer.id}, linked_at = ${now}
                WHERE organization_id = ${viewer.org_id} AND id = ${existing.id as string}`;
    } else {
      await tx`INSERT INTO bastion_manual_evidence_links (organization_id, manual_evidence_id, assertion_id, linked_by, linked_at)
               VALUES (${viewer.org_id}, ${id}, ${assertionId}, ${viewer.id}, ${now})`;
    }
    await auditRaw(tx, viewer, 'manual_evidence.link', { type: 'manual_evidence', id }, { assertion_id: assertionId, control_id: a?.control_id });
  });
  return getManualEvidence(d, viewer, id, canRestricted);
}

/** DELETE /manual-evidence/:id/links/:assertion_id (row 37). The control is re-evaluated. */
export async function unlinkManualEvidence(d: EvidenceDeps, viewer: Viewer, id: string, assertionId: string, canRestricted: boolean) {
  const now = d.engine.now();
  const runs = await orgTx(d.engine.sql, viewer.org_id, async (tx) => {
    await loadItem(tx, viewer.org_id, id, canRestricted);
    const rows = await tx`
      UPDATE bastion_manual_evidence_links l SET unlinked_at = ${now}
        FROM bastion_assertions a
       WHERE l.organization_id = ${viewer.org_id} AND l.manual_evidence_id = ${id} AND l.assertion_id = ${assertionId}
         AND l.unlinked_at IS NULL AND a.id = l.assertion_id AND a.organization_id = l.organization_id
      RETURNING a.control_id, l.review_verdict`;
    if (!rows[0]) throw new NotFoundError('This evidence is not linked to that check.');
    await auditRaw(tx, viewer, 'manual_evidence.unlink', { type: 'manual_evidence', id }, { assertion_id: assertionId });
    // Only a reviewed link can have moved the control; a pending one never counted.
    if (rows[0].review_verdict === 'pending') return [];
    const kind = await viewerKind(tx, viewer);
    return queueControlRuns(tx, viewer.org_id, [String(rows[0].control_id)], now, viewer.id, kind === 'human' ? 'manual' : 'agent');
  });
  await afterCommit(d, runs);
  return { data: { manual_evidence_id: id, assertion_id: assertionId, unlinked: true, reevaluating: runs.length > 0 } };
}

/**
 * POST /manual-evidence/:id/links/:assertion_id/review (row 38; session-only, never impersonated).
 * A reviewer other than the uploader, unless the org has fewer than three humans, in which case a
 * self-review is allowed and labelled `small_team_self_review` (spec 3.3).
 */
export async function reviewManualEvidence(
  d: EvidenceDeps,
  viewer: Viewer,
  id: string,
  assertionId: string,
  body: BastionManualEvidenceReview,
  canRestricted: boolean,
) {
  const now = d.engine.now();
  const runs = await orgTx(d.engine.sql, viewer.org_id, async (tx) => {
    // A reviewer who may not read a restricted item cannot vouch for it (#209).
    const item = await loadItem(tx, viewer.org_id, id, canRestricted);
    if (item.status !== 'active') {
      throw new ConflictError(
        item.status === 'pending_scan'
          ? 'This file is still waiting for its virus scan. You can review it once the scan finishes.'
          : 'Only evidence that is in use can be reviewed.',
        'NOT_ACTIVE',
      );
    }
    let selfReview = false;
    if (item.uploaded_by === viewer.id) {
      const humans = await humanCount(tx, viewer.org_id);
      if (humans >= (d.smallTeamThreshold ?? SMALL_TEAM_HUMANS)) {
        throw new ForbiddenError('Someone other than the person who uploaded this evidence has to review it.', 'SECOND_PERSON_REQUIRED');
      }
      selfReview = true;
    }
    // Stale check (#216): the item row is locked, so reviews serialize; a link that already has a
    // verdict is replaced only by a reviewer who saw that verdict. Otherwise 409 with what it is now.
    const current = (await tx`
      SELECT l.review_verdict, ru.display_name AS reviewed_by_name FROM bastion_manual_evidence_links l
        LEFT JOIN users ru ON ru.id = l.reviewed_by
       WHERE l.organization_id = ${viewer.org_id} AND l.manual_evidence_id = ${id} AND l.assertion_id = ${assertionId} AND l.unlinked_at IS NULL`)[0];
    if (!current) throw new NotFoundError('This evidence is not linked to that check.');
    const seen = body.expected_verdict ?? 'pending';
    if (current.review_verdict !== seen) {
      const who = current.reviewed_by_name ? ` by ${String(current.reviewed_by_name)}` : '';
      throw new ConflictError(
        current.review_verdict === 'pending'
          ? 'This review was cleared since you opened it. Refresh and review it again.'
          : `Someone reviewed this since you opened it (${current.review_verdict === 'accepted' ? 'accepted' : 'marked as showing a problem'}${who}). Refresh to see their review before changing it.`,
        'REVIEW_CHANGED',
      );
    }
    const rows = await tx`
      UPDATE bastion_manual_evidence_links l
         SET review_verdict = ${body.verdict}, reviewed_by = ${viewer.id}, reviewed_at = ${now}, review_note = ${body.note ?? null},
             small_team_self_review = ${selfReview}
        FROM bastion_assertions a
       WHERE l.organization_id = ${viewer.org_id} AND l.manual_evidence_id = ${id} AND l.assertion_id = ${assertionId}
         AND l.unlinked_at IS NULL AND a.id = l.assertion_id AND a.organization_id = l.organization_id
      RETURNING a.control_id`;
    if (!rows[0]) throw new NotFoundError('This evidence is not linked to that check.');
    await auditRaw(tx, viewer, 'manual_evidence.review', { type: 'manual_evidence', id }, {
      assertion_id: assertionId,
      verdict: body.verdict,
      small_team_self_review: selfReview,
    });
    return queueControlRuns(tx, viewer.org_id, [String(rows[0].control_id)], now, viewer.id, 'manual');
  });
  await afterCommit(d, runs);
  return getManualEvidence(d, viewer, id, canRestricted);
}

// ── Withdraw and redact ─────────────────────────────────────────────────────────────────

/** POST /manual-evidence/:id/withdraw (row 39, confirm). */
export async function withdrawManualEvidence(d: EvidenceDeps, viewer: Viewer, id: string, reason: string | null, canRestricted: boolean) {
  const engine = d.engine;
  const now = engine.now();
  const highest = await beginLedgerBatch(engine, viewer.org_id);
  let runs: QueuedRun[];
  try {
    runs = await orgTx(engine.sql, viewer.org_id, async (tx) => {
      const item = await loadItem(tx, viewer.org_id, id, canRestricted);
      if (item.status === 'withdrawn') throw new ConflictError('This evidence was already withdrawn.', 'ALREADY_WITHDRAWN');
      const wasRecorded = item.status === 'active' || item.status === 'superseded';
      const controls = await controlsLinkedTo(tx, viewer.org_id, id);
      await tx`
        UPDATE bastion_manual_evidence
           SET status = 'withdrawn', withdrawn_reason = 'withdrawn', withdrawn_by = ${viewer.id}, withdrawn_at = ${now}
         WHERE organization_id = ${viewer.org_id} AND id = ${id}`;
      if (wasRecorded) {
        await appendLedger(tx, viewer.org_id, [{ kind: 'withdrawal', id, content_sha256: null, personal_data_hmac: null, pd_hmac_key_id: null }], {
          highest,
          now,
        });
      }
      await auditRaw(tx, viewer, 'manual_evidence.withdraw', { type: 'manual_evidence', id }, { reason });
      const kind = await viewerKind(tx, viewer);
      return queueControlRuns(tx, viewer.org_id, controls, now, viewer.id, kind === 'human' ? 'manual' : 'agent');
    });
  } catch (err) {
    throw mapAppendError(err);
  }
  await afterCommit(d, runs);
  return { data: { manual_evidence_id: id, status: 'withdrawn', reevaluating_controls: runs.length } };
}

/**
 * POST /personal-data/:id/redact (row 41). Owner only (the route also requires a session, refuses
 * impersonation and is confirm-gated). Blanks the data; the HMAC commitment stays, so the ledger
 * still verifies and reports `redacted`. A manual-evidence holder is withdrawn with reason
 * `redacted` in the same transaction, its object loses a holder, and the bytes are deleted once
 * no unredacted holder remains; linked controls are re-evaluated.
 */
export async function redactPersonalData(d: EvidenceDeps, viewer: Viewer, pdId: string, reason: string) {
  if (viewer.role !== 'owner') {
    throw new ForbiddenError('Only an owner of this organization can redact personal data.', 'OWNER_REQUIRED');
  }
  const engine = d.engine;
  const now = engine.now();
  const highest = await beginLedgerBatch(engine, viewer.org_id);
  let out: { runs: QueuedRun[]; deleteKey: string | null; holder_kind: string; holder_id: string };
  try {
    out = await orgTx(engine.sql, viewer.org_id, async (tx) => {
      const pd = (await tx`SELECT id, holder_kind, holder_id, redacted_at FROM bastion_personal_data
                             WHERE organization_id = ${viewer.org_id} AND id = ${pdId} FOR UPDATE`)[0];
      if (!pd) throw new NotFoundError('We could not find that personal data.');
      if (pd.redacted_at) throw new ConflictError('This was already redacted.', 'ALREADY_REDACTED');
      const holderKind = String(pd.holder_kind);
      const holderId = String(pd.holder_id);
      await tx`UPDATE bastion_personal_data SET data = '{}'::jsonb, redacted_at = ${now}, redacted_by = ${viewer.id}, redaction_reason = ${reason}
                WHERE organization_id = ${viewer.org_id} AND id = ${pdId}`;
      let runs: QueuedRun[] = [];
      let deleteKey: string | null = null;
      if (holderKind === 'manual_evidence') {
        // Owner-only (checked above): owners always hold read_restricted (spec 5.5 floor).
        const item = await loadItem(tx, viewer.org_id, holderId, true);
        const controls = await controlsLinkedTo(tx, viewer.org_id, holderId);
        if (item.status !== 'withdrawn') {
          await tx`UPDATE bastion_manual_evidence
                      SET status = 'withdrawn', withdrawn_reason = 'redacted', withdrawn_by = ${viewer.id}, withdrawn_at = ${now}, redacted_at = ${now}
                    WHERE organization_id = ${viewer.org_id} AND id = ${holderId}`;
        } else {
          await tx`UPDATE bastion_manual_evidence SET redacted_at = ${now} WHERE organization_id = ${viewer.org_id} AND id = ${holderId}`;
        }
        const sha = (await tx`SELECT content_sha256 FROM bastion_manual_evidence WHERE organization_id = ${viewer.org_id} AND id = ${holderId}`)[0]
          ?.content_sha256 as string | null;
        if (sha) {
          const obj = (await tx`
            UPDATE bastion_evidence_objects SET holder_count = GREATEST(holder_count - 1, 0)
             WHERE organization_id = ${viewer.org_id} AND content_sha256 = ${sha}
            RETURNING holder_count, object_key`)[0];
          if (obj && Number(obj.holder_count) === 0) {
            await tx`UPDATE bastion_evidence_objects SET bytes_redacted_at = ${now}
                      WHERE organization_id = ${viewer.org_id} AND content_sha256 = ${sha}`;
            deleteKey = String(obj.object_key);
            // The durable "these bytes still have to go" marker (#212): removed only once the bucket
            // delete succeeds; until then the evidence-ingest engine retries it.
            await tx`INSERT INTO bastion_object_intents (organization_id, object_key) VALUES (${viewer.org_id}, ${deleteKey})
                     ON CONFLICT (object_key) DO NOTHING`;
          }
        }
        runs = await queueControlRuns(tx, viewer.org_id, controls, now, viewer.id, 'manual');
      }
      await appendLedger(tx, viewer.org_id, [{ kind: 'redaction', id: pdId, content_sha256: null, personal_data_hmac: null, pd_hmac_key_id: null }], {
        highest,
        now,
      });
      await auditRaw(tx, viewer, 'personal_data.redact', { type: 'personal_data', id: pdId }, { holder_kind: holderKind, holder_id: holderId, reason });
      return { runs, deleteKey, holder_kind: holderKind, holder_id: holderId };
    });
  } catch (err) {
    throw mapAppendError(err);
  }
  // Report only what actually happened (#212): deleted, or still pending a retry.
  const bytesDeleted = out.deleteKey ? await deleteRedactedBytes(engine, viewer.org_id, out.deleteKey) : false;
  const bytesDeletePending = out.deleteKey !== null && !bytesDeleted;
  try {
    await orgTx(engine.sql, viewer.org_id, (tx) =>
      enqueueBastionEvent(
        'evidence.redacted',
        { personal_data_id: pdId, holder_kind: out.holder_kind, holder_id: out.holder_id, bytes_deleted: bytesDeleted, bytes_delete_pending: bytesDeletePending },
        tx,
        { orgId: viewer.org_id, idempotencyKey: `evidence.redacted:${pdId}`, actorId: viewer.id, actorType: 'user' },
      ),
    );
  } catch (err) {
    engine.log.warn({ organization_id: viewer.org_id, err: (err as Error).message }, 'bastion-redact: evidence.redacted event not queued');
  }
  await afterCommit(d, out.runs);
  return {
    data: {
      personal_data_id: pdId,
      holder_kind: out.holder_kind,
      holder_id: out.holder_id,
      redacted: true,
      bytes_deleted: bytesDeleted,
      bytes_delete_pending: bytesDeletePending,
      reevaluating_controls: out.runs.length,
    },
  };
}

/**
 * Delete one redacted object's bytes, then its intent row. True only when the bucket delete
 * succeeded. A failure leaves the intent for the evidence-ingest engine to retry (#212).
 */
export async function deleteRedactedBytes(engine: EvidenceDeps['engine'], orgId: string, key: string): Promise<boolean> {
  if (!engine.storage) return false;
  try {
    await withStorageTimeout('delete', engine.storage.delete(key), engine.putTimeoutMs);
  } catch (err) {
    engine.log.warn({ organization_id: orgId, err: (err as Error).message }, 'bastion-redact: bytes not deleted yet; evidence-ingest retries');
    return false;
  }
  await orgTx(engine.sql, orgId, (tx) => tx`DELETE FROM bastion_object_intents WHERE organization_id = ${orgId} AND object_key = ${key}`).catch(
    (err: Error) => engine.log.warn({ organization_id: orgId, err: err.message }, 'bastion-redact: intent row not cleared; the next retry clears it'),
  );
  return true;
}

/**
 * The redacted-bytes retry (#212): every redacted object whose intent row is still open had its
 * bucket delete fail. Retry each; the intent goes only when the delete succeeds.
 */
export async function retryRedactedDeletes(engine: EvidenceDeps['engine'], only?: string): Promise<{ deleted: number; still_pending: number }> {
  const rows = await engine.sql`
    SELECT o.organization_id, o.object_key FROM bastion_evidence_objects o
      JOIN bastion_object_intents i ON i.object_key = o.object_key AND i.organization_id = o.organization_id
     WHERE o.bytes_redacted_at IS NOT NULL ${only ? engine.sql`AND o.organization_id = ${only}` : engine.sql``}
     ORDER BY i.created_at LIMIT 200`;
  let deleted = 0;
  for (const r of rows) {
    if (await deleteRedactedBytes(engine, String(r.organization_id), String(r.object_key))) deleted += 1;
  }
  return { deleted, still_pending: rows.length - deleted };
}

// ── Pending scans (the evidence-ingest engine and Check again) ───────────────────────────

export interface ScanRetryOutcome {
  manual_evidence_id: string;
  /** copy_started: the scan is clean and a large copy runs on under its lease (#222). */
  result: 'copied' | 'copy_started' | 'still_pending' | 'blocked' | 'skipped';
  blocked_reason?: string;
}

/**
 * One retry of one `pending_scan` item. Re-checks the PINNED Bin version: clean or skipped copies
 * now and records the ledger entry; still pending backs off (daily after 24 h); infected or error
 * blocks; a newer version before the scan finished blocks `changed_before_scan`.
 * `copyBudgetMs` (evidence-ingest) bounds a synchronous copy; one that will not fit starts in the
 * background instead (#222). Without it (Check again) the copy runs inline up to its own timeout.
 */
export async function retryPendingScan(
  d: EvidenceDeps,
  orgId: string,
  id: string,
  opts: { force?: boolean; copyBudgetMs?: number } = {},
): Promise<ScanRetryOutcome> {
  const engine = d.engine;
  const now = engine.now();
  const item = await orgTx(engine.sql, orgId, async (tx) => {
    const r = (await tx`SELECT id, status, bin_asset_id, bin_asset_version_id, attempts, next_attempt_at, created_at, uploaded_by
                          FROM bastion_manual_evidence WHERE organization_id = ${orgId} AND id = ${id}`)[0];
    return r ?? null;
  });
  if (!item || item.status !== 'pending_scan') return { manual_evidence_id: id, result: 'skipped' };
  if (!opts.force && item.next_attempt_at && new Date(item.next_attempt_at as string).getTime() > now.getTime()) {
    return { manual_evidence_id: id, result: 'skipped' };
  }
  const check = await orgTx(engine.sql, orgId, (tx) =>
    recheckPinnedAsset(d.bin(tx), orgId, String(item.bin_asset_id), String(item.bin_asset_version_id)),
  );
  const block = async (reason: string) => {
    await orgTx(engine.sql, orgId, (tx) => tx`
      UPDATE bastion_manual_evidence SET status = 'blocked', blocked_reason = ${reason}, attempts = attempts + 1, next_attempt_at = NULL
       WHERE organization_id = ${orgId} AND id = ${id} AND status = 'pending_scan'`);
    return { manual_evidence_id: id, result: 'blocked' as const, blocked_reason: reason };
  };
  if (check.kind === 'gone') return block('scan_failed');
  if (check.kind === 'changed') return block('changed_before_scan');
  const dec = check.decision;
  if (dec.action === 'block') return block(dec.blocked_reason);
  if (dec.action === 'wait') {
    const attempts = Number(item.attempts) + 1;
    await orgTx(engine.sql, orgId, (tx) => tx`
      UPDATE bastion_manual_evidence SET attempts = ${attempts}, next_attempt_at = ${nextScanAttemptAt(new Date(item.created_at as string), attempts, now)}
       WHERE organization_id = ${orgId} AND id = ${id} AND status = 'pending_scan'`);
    return { manual_evidence_id: id, result: 'still_pending' };
  }
  // Claim the item for this copy (#222): push next_attempt_at out by the copy lease with a
  // compare-and-set on `attempts`, so a worker retry, the next tick or another replica sees it as
  // not due and never starts a second copy of the same file. A failed copy hands it back to the
  // normal backoff schedule.
  if (inFlightCopies.has(id)) return { manual_evidence_id: id, result: 'skipped' };
  const claimed = await orgTx(engine.sql, orgId, (tx) => tx`
    UPDATE bastion_manual_evidence SET next_attempt_at = ${new Date(now.getTime() + EVIDENCE_COPY_LEASE_MS)}
     WHERE organization_id = ${orgId} AND id = ${id} AND status = 'pending_scan' AND attempts = ${Number(item.attempts)}
       AND (${opts.force === true}::boolean OR next_attempt_at IS NULL OR next_attempt_at <= ${now})
    RETURNING id`);
  if (claimed.length === 0) return { manual_evidence_id: id, result: 'skipped' };

  const size = Number(check.version.size);
  const sizeText = `${(size / (1024 * 1024)).toFixed(1)} MB`;
  const budget = opts.copyBudgetMs;
  const copy = async (timeoutMs: number): Promise<ScanRetryOutcome> => {
    const started = Date.now();
    engine.log.info({ organization_id: orgId, manual_evidence_id: id, size_bytes: size }, `bastion-evidence-ingest: copying ${sizeText} for ${id}`);
    try {
      const out = await copyAndRecord(d, orgId, id, check.version, dec.scan_label, timeoutMs);
      engine.log.info(
        { organization_id: orgId, manual_evidence_id: id, elapsed_ms: Date.now() - started },
        `bastion-evidence-ingest: copied ${sizeText} for ${id} in ${Date.now() - started} ms`,
      );
      return out;
    } catch (err) {
      engine.log.warn({ organization_id: orgId, manual_evidence_id: id, err: (err as Error).message }, 'bastion-evidence-ingest: copy failed; it stays pending');
      const attempts = Number(item.attempts) + 1;
      await orgTx(engine.sql, orgId, (tx) => tx`
        UPDATE bastion_manual_evidence SET attempts = ${attempts}, next_attempt_at = ${nextScanAttemptAt(new Date(item.created_at as string), attempts, engine.now())}
         WHERE organization_id = ${orgId} AND id = ${id} AND status = 'pending_scan'`).catch(() => undefined);
      throw err;
    }
  };
  // A copy that cannot finish inside the caller's budget runs on in the background under its lease
  // (the async-start pattern), instead of holding the engine call past the worker's timeout.
  if (budget !== undefined && estimateCopyMs(size) > budget) {
    inFlightCopies.add(id);
    void copy(EVIDENCE_COPY_TIMEOUT_MS)
      .catch(() => undefined)
      .finally(() => inFlightCopies.delete(id));
    return { manual_evidence_id: id, result: 'copy_started' };
  }
  inFlightCopies.add(id);
  try {
    return await copy(budget ?? EVIDENCE_COPY_TIMEOUT_MS);
  } finally {
    inFlightCopies.delete(id);
  }
}

/** Copies running in this process (a cheap same-instance guard on top of the DB lease). */
const inFlightCopies = new Set<string>();

async function copyAndRecord(
  d: EvidenceDeps,
  orgId: string,
  id: string,
  version: { object_key: string; size: number; content_type: string },
  scanLabel: 'clean' | 'not_scanned',
  timeoutMs: number,
): Promise<ScanRetryOutcome> {
  const engine = d.engine;
  const now = engine.now();
  const highest = await beginLedgerBatch(engine, orgId);
  const stored = await copyFromBin(engine, d.binStorage, orgId, version, timeoutMs);
  const dec = { scan_label: scanLabel };
  let duplicateKey: string | null = null;
  try {
    duplicateKey = await orgTx(engine.sql, orgId, async (tx) => {
      const cur = (await tx`SELECT status, personal_data_hmac, pd_hmac_key_id FROM bastion_manual_evidence
                              WHERE organization_id = ${orgId} AND id = ${id} FOR UPDATE`)[0];
      if (!cur || cur.status !== 'pending_scan') throw new ConflictError('changed', 'CHANGED');
      const rec = await recordObject(tx, orgId, stored);
      const [entry] = await appendLedger(
        tx,
        orgId,
        [{ kind: 'manual_evidence', id, content_sha256: stored.content_sha256, personal_data_hmac: cur.personal_data_hmac as string | null, pd_hmac_key_id: cur.pd_hmac_key_id as string | null }],
        { highest, now },
      );
      // Content columns are still writable here (the row has not left pending_scan in this statement).
      await tx`
        UPDATE bastion_manual_evidence
           SET content_sha256 = ${stored.content_sha256}, size_bytes = ${stored.size_bytes}, scan_label = ${dec.scan_label},
               ledger_seq = ${entry?.seq ?? null}, status = 'active', attempts = attempts + 1, next_attempt_at = NULL
         WHERE organization_id = ${orgId} AND id = ${id}`;
      await enqueueBastionEvent('evidence.uploaded', { manual_evidence_id: id, kind: 'file', status: 'active', after_scan: true }, tx, {
        orgId,
        idempotencyKey: `evidence.uploaded:${id}:scanned`,
      });
      return rec.duplicate_key;
    });
  } catch (err) {
    await abandonStored(engine, orgId, stored);
    if (err instanceof ConflictError && err.code === 'CHANGED') return { manual_evidence_id: id, result: 'skipped' };
    throw mapAppendError(err);
  }
  await dropDuplicate(engine, orgId, duplicateKey);
  return { manual_evidence_id: id, result: 'copied' };
}

/** POST /manual-evidence/:id/check-again: the review-queue "Check again" (immediate retry). */
export async function checkScanAgain(d: EvidenceDeps, viewer: Viewer, id: string, canRestricted: boolean) {
  const exists = await orgTx(d.engine.sql, viewer.org_id, async (tx) => {
    const r = (await tx`SELECT status, sensitivity FROM bastion_manual_evidence WHERE organization_id = ${viewer.org_id} AND id = ${id}`)[0];
    if (!r || (r.sensitivity === 'restricted' && !canRestricted)) throw new NotFoundError('We could not find that evidence.');
    if (r.status !== 'pending_scan') throw new ConflictError('This evidence is not waiting for a virus scan.', 'NOT_PENDING_SCAN');
    await auditRaw(tx, viewer, 'manual_evidence.check_again', { type: 'manual_evidence', id });
    return true;
  });
  if (!exists) throw new NotFoundError('We could not find that evidence.');
  const outcome = await retryPendingScan(d, viewer.org_id, id, { force: true });
  const item = await getManualEvidence(d, viewer, id, canRestricted);
  return { data: { ...item.data, check_result: outcome.result } };
}

/** The local date `days` days from now in the org zone (used by the seeder and tests). */
export function localDatePlusDays(now: Date, timeZone: string, days: number): string {
  return localDateInTz(new Date(now.getTime() + days * DAY_MS), timeZone);
}

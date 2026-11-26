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

import { endOfDayInTz, localDateInTz, type BastionManualEvidenceCreate, type BastionManualEvidenceListQuery } from '@bigbluebam/shared';
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
  supersedes: { id: string; links: Array<{ assertion_id: string; control_id: string }> } | null,
): Promise<{ id: string; duplicate_key: string | null; runs: QueuedRun[] }> {
  const orgId = viewer.org_id;
  const now = d.engine.now();
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
    await tx`
      UPDATE bastion_manual_evidence SET status = 'superseded', superseded_by_id = ${id}
       WHERE organization_id = ${orgId} AND id = ${supersedes.id} AND status = 'active'`;
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

async function createOrSupersede(d: EvidenceDeps, viewer: Viewer, body: BastionManualEvidenceCreate, supersedeId: string | null) {
  const engine = d.engine;
  const orgId = viewer.org_id;
  let supersedes: { id: string; links: Array<{ assertion_id: string; control_id: string }> } | null = null;
  if (supersedeId) {
    supersedes = await orgTx(engine.sql, orgId, async (tx) => {
      const old = (await tx`SELECT id, status FROM bastion_manual_evidence WHERE organization_id = ${orgId} AND id = ${supersedeId}`)[0];
      if (!old) throw new NotFoundError('We could not find that evidence.');
      if (old.status !== 'active') throw new ConflictError('Only evidence that is in use can be replaced by a newer copy.', 'NOT_ACTIVE');
      const links = await tx`
        SELECT l.assertion_id, a.control_id FROM bastion_manual_evidence_links l
          JOIN bastion_assertions a ON a.id = l.assertion_id AND a.organization_id = l.organization_id
         WHERE l.organization_id = ${orgId} AND l.manual_evidence_id = ${supersedeId} AND l.unlinked_at IS NULL`;
      return { id: supersedeId, links: links.map((l) => ({ assertion_id: String(l.assertion_id), control_id: String(l.control_id) })) };
    });
  }
  const highest = await beginLedgerBatch(engine, orgId);
  const prepared = await prepareBytes(d, viewer, body);
  let result: { id: string; duplicate_key: string | null; runs: QueuedRun[] };
  try {
    result = await orgTx(engine.sql, orgId, (tx) => insertItem(d, tx, viewer, body, prepared, highest, supersedes));
  } catch (err) {
    await abandonStored(engine, orgId, prepared.stored);
    throw mapAppendError(err);
  }
  await dropDuplicate(engine, orgId, result.duplicate_key);
  if (prepared.status === 'pending_scan') await d.enqueueIngest(orgId, result.id).catch(() => undefined);
  await afterCommit(d, result.runs);
  return getManualEvidence(d, viewer, result.id, true);
}

/** POST /manual-evidence (row 32). */
export function createManualEvidence(d: EvidenceDeps, viewer: Viewer, body: BastionManualEvidenceCreate) {
  return createOrSupersede(d, viewer, body, null);
}

/** POST /manual-evidence/:id/supersede (row 40). */
export function supersedeManualEvidence(d: EvidenceDeps, viewer: Viewer, id: string, body: BastionManualEvidenceCreate) {
  return createOrSupersede(d, viewer, body, id);
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

async function loadItem(tx: Tx, orgId: string, id: string) {
  const r = (await tx`SELECT id, status, uploaded_by, kind FROM bastion_manual_evidence WHERE organization_id = ${orgId} AND id = ${id} FOR UPDATE`)[0];
  if (!r) throw new NotFoundError('We could not find that evidence.');
  return r;
}

/** POST /manual-evidence/:id/links (row 36). */
export async function linkManualEvidence(d: EvidenceDeps, viewer: Viewer, id: string, assertionId: string) {
  const now = d.engine.now();
  await orgTx(d.engine.sql, viewer.org_id, async (tx) => {
    const item = await loadItem(tx, viewer.org_id, id);
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
  return getManualEvidence(d, viewer, id, true);
}

/** DELETE /manual-evidence/:id/links/:assertion_id (row 37). The control is re-evaluated. */
export async function unlinkManualEvidence(d: EvidenceDeps, viewer: Viewer, id: string, assertionId: string) {
  const now = d.engine.now();
  const runs = await orgTx(d.engine.sql, viewer.org_id, async (tx) => {
    await loadItem(tx, viewer.org_id, id);
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
  body: { verdict: 'accepted' | 'shows_exception'; note?: string | null },
) {
  const now = d.engine.now();
  const runs = await orgTx(d.engine.sql, viewer.org_id, async (tx) => {
    const item = await loadItem(tx, viewer.org_id, id);
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
  return getManualEvidence(d, viewer, id, true);
}

// ── Withdraw and redact ─────────────────────────────────────────────────────────────────

/** POST /manual-evidence/:id/withdraw (row 39, confirm). */
export async function withdrawManualEvidence(d: EvidenceDeps, viewer: Viewer, id: string, reason: string | null) {
  const engine = d.engine;
  const now = engine.now();
  const highest = await beginLedgerBatch(engine, viewer.org_id);
  let runs: QueuedRun[];
  try {
    runs = await orgTx(engine.sql, viewer.org_id, async (tx) => {
      const item = await loadItem(tx, viewer.org_id, id);
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
        const item = await loadItem(tx, viewer.org_id, holderId);
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
          }
        }
        runs = await queueControlRuns(tx, viewer.org_id, controls, now, viewer.id, 'manual');
      }
      await appendLedger(tx, viewer.org_id, [{ kind: 'redaction', id: pdId, content_sha256: null, personal_data_hmac: null, pd_hmac_key_id: null }], {
        highest,
        now,
      });
      await enqueueBastionEvent(
        'evidence.redacted',
        { personal_data_id: pdId, holder_kind: holderKind, holder_id: holderId, bytes_deleted: deleteKey !== null },
        tx,
        { orgId: viewer.org_id, idempotencyKey: `evidence.redacted:${pdId}`, actorId: viewer.id, actorType: 'user' },
      );
      await auditRaw(tx, viewer, 'personal_data.redact', { type: 'personal_data', id: pdId }, { holder_kind: holderKind, holder_id: holderId, reason });
      return { runs, deleteKey, holder_kind: holderKind, holder_id: holderId };
    });
  } catch (err) {
    throw mapAppendError(err);
  }
  if (out.deleteKey && engine.storage) {
    try {
      await withStorageTimeout('delete', engine.storage.delete(out.deleteKey), engine.putTimeoutMs);
    } catch (err) {
      engine.log.warn({ organization_id: viewer.org_id, err: (err as Error).message }, 'bastion-redact: bytes not deleted yet; the object sweep retries');
    }
  }
  await afterCommit(d, out.runs);
  return {
    data: {
      personal_data_id: pdId,
      holder_kind: out.holder_kind,
      holder_id: out.holder_id,
      redacted: true,
      bytes_deleted: out.deleteKey !== null,
      reevaluating_controls: out.runs.length,
    },
  };
}

// ── Pending scans (the evidence-ingest engine and Check again) ───────────────────────────

export interface ScanRetryOutcome {
  manual_evidence_id: string;
  result: 'copied' | 'still_pending' | 'blocked' | 'skipped';
  blocked_reason?: string;
}

/**
 * One retry of one `pending_scan` item. Re-checks the PINNED Bin version: clean or skipped copies
 * now and records the ledger entry; still pending backs off (daily after 24 h); infected or error
 * blocks; a newer version before the scan finished blocks `changed_before_scan`.
 */
export async function retryPendingScan(
  d: EvidenceDeps,
  orgId: string,
  id: string,
  opts: { force?: boolean } = {},
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
  const highest = await beginLedgerBatch(engine, orgId);
  const stored = await copyFromBin(engine, d.binStorage, orgId, check.version);
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
export async function checkScanAgain(d: EvidenceDeps, viewer: Viewer, id: string) {
  const exists = await orgTx(d.engine.sql, viewer.org_id, async (tx) => {
    const r = (await tx`SELECT status FROM bastion_manual_evidence WHERE organization_id = ${viewer.org_id} AND id = ${id}`)[0];
    if (!r) throw new NotFoundError('We could not find that evidence.');
    if (r.status !== 'pending_scan') throw new ConflictError('This evidence is not waiting for a virus scan.', 'NOT_PENDING_SCAN');
    await auditRaw(tx, viewer, 'manual_evidence.check_again', { type: 'manual_evidence', id });
    return true;
  });
  if (!exists) throw new NotFoundError('We could not find that evidence.');
  const outcome = await retryPendingScan(d, viewer.org_id, id, { force: true });
  const item = await getManualEvidence(d, viewer, id, true);
  return { data: { ...item.data, check_result: outcome.result } };
}

/** The local date `days` days from now in the org zone (used by the seeder and tests). */
export function localDatePlusDays(now: Date, timeZone: string, days: number): string {
  return localDateInTz(new Date(now.getTime() + days * DAY_MS), timeZone);
}

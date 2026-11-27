// M4 read and act surface over the evidence engine: evaluation runs (spec 5.1 rows 22-24),
// evidence snapshots and verification (rows 25-27), seals and restores (rows 29-31).
// Every query carries an explicit organization_id predicate and runs in an org-scoped
// transaction (RLS GUC bound).

import type {
  BastionEvaluationListQuery,
  BastionEvidenceListQuery,
  BastionRestoreAcknowledge,
  BastionRestoreListQuery,
  BastionRunEvaluation,
  BastionSealListQuery,
} from '@bigbluebam/shared';
import { decodeDateCursor, decodeIdCursor, encodeDateCursor, encodeIdCursor, pageOf } from '../lib/cursor.js';
import { createHash } from 'node:crypto';
import { withStorageTimeout } from '@bigbluebam/storage';
import { fieldsOfRow, entryHash, verifyChain, verifySeal, type LedgerRow } from '../lib/ledger-canonical.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationFailure } from '../lib/errors.js';
import { pdHmacKeyId, publishedSealKeyMap, publishedSealKeys } from '../lib/keys.js';
import { enqueueEvaluationRun } from '../lib/queue.js';
import { type EngineDeps, orgTx, sqlstateOf, type Tx } from '../engine/context.js';
import { appendLedger, lockLedger } from '../engine/ledger.js';
import { enqueueBastionEvent } from '../engine/outbox.js';
import { bucketRestoreRecords, refreshSeals, highestSeal, writeRestoreObject } from '../engine/restore.js';
import { probeDefinition } from '../probes/definitions.js';
import type { BastionProbeResult } from '@bigbluebam/shared';
import { auditRaw } from '../lib/audit-raw.js';
import { type CitedRef, labelRefs, labelsFor } from '../lib/ref-labels.js';
import { isAdminViewer, type Viewer } from './types.js';
import { type CanAccess, visibleRefs } from './decisions.service.js';
import { type NameVisible, populationNames, populationVisibility } from '../lib/population-visibility.js';


const RUN_SELECT = `id, trigger, scope, control_id, nightly_for_date::text AS nightly_for_date, as_of, status, partial_reason,
  resume_count, controls_total, controls_done, pass_count, fail_count, unprovable_count, started_by, started_at,
  completed_at, created_at, updated_at`;

// ── Evaluation runs ──────────────────────────────────────────────────────────────────────

/** POST /evaluations: 202 with the queued run. A live run of the same scope answers 409. */
export async function startEvaluation(deps: EngineDeps, viewer: Viewer, body: BastionRunEvaluation) {
  let run: Record<string, unknown>;
  try {
    run = await orgTx(deps.sql, viewer.org_id, async (tx) => {
      if (body.control_id) {
        const c = await tx`SELECT id FROM bastion_controls WHERE organization_id = ${viewer.org_id} AND id = ${body.control_id}`;
        if (!c[0]) throw new NotFoundError('We could not find that control.');
      }
      const kind = (await tx`SELECT kind FROM users WHERE id = ${viewer.id}`)[0]?.kind;
      const trigger = kind === 'agent' || kind === 'service' ? 'agent' : 'manual';
      const rows = await tx.unsafe(
        `INSERT INTO bastion_evaluation_runs (organization_id, trigger, scope, control_id, as_of, status, started_by)
         VALUES ($1, $2, $3, $4, $5, 'queued', $6) RETURNING ${RUN_SELECT}`,
        [viewer.org_id, trigger, body.control_id ? 'control' : 'all', body.control_id ?? null, deps.now().toISOString(), viewer.id],
      );
      const created = rows[0] as Record<string, unknown>;
      await auditRaw(tx, viewer, 'evaluation.start', { type: 'evaluation_run', id: created.id as string }, { scope: created.scope });
      return created;
    });
  } catch (err) {
    if (sqlstateOf(err) === '23505') {
      throw new ConflictError('An evaluation is already running. It will finish on its own; try again when it has.', 'EVALUATION_RUNNING');
    }
    throw err;
  }
  const enqueued = await enqueueEvaluationRun({ organization_id: viewer.org_id, run_id: run.id as string, resume_count: 0 });
  return { data: { ...run, enqueued } };
}

/** GET /evaluations, newest first, keyset-paginated on (created_at, id) (issue #204). */
export async function listEvaluations(deps: EngineDeps, viewer: Viewer, q: BastionEvaluationListQuery) {
  const after = q.cursor ? decodeIdCursor(q.cursor) : null;
  const rows = await orgTx(deps.sql, viewer.org_id, (tx) =>
    tx.unsafe(
      `SELECT ${RUN_SELECT} FROM bastion_evaluation_runs
        WHERE organization_id = $1 AND ($2::text IS NULL OR status = $2)
          AND ($4::uuid IS NULL OR (created_at, id) < (
                SELECT r.created_at, r.id FROM bastion_evaluation_runs r WHERE r.id = $4::uuid AND r.organization_id = $1))
        ORDER BY created_at DESC, id DESC LIMIT $3`,
      [viewer.org_id, q.status ?? null, q.limit + 1, after],
    ),
  );
  return pageOf(rows, q.limit, (r) => encodeIdCursor(r.id as string));
}

export async function getEvaluation(deps: EngineDeps, viewer: Viewer, id: string) {
  const rows = await orgTx(deps.sql, viewer.org_id, (tx) =>
    tx.unsafe(`SELECT ${RUN_SELECT} FROM bastion_evaluation_runs WHERE organization_id = $1 AND id = $2`, [viewer.org_id, id]),
  );
  if (!rows[0]) throw new NotFoundError('We could not find that evaluation run.');
  return { data: rows[0] };
}

// ── Evidence snapshots ───────────────────────────────────────────────────────────────────

export const SNAPSHOT_SELECT = `s.id, s.evaluation_run_id, s.assertion_id, s.control_id, s.outcome, s.unprovable_reason, s.probe_key,
  s.probe_version, s.params, s.query_fingerprint, s.population_checked, s.population_unlisted, s.window_start, s.window_end,
  s.summary, s.cited_refs, s.overflow_count, s.manual_evidence_ids, s.exception_ids, s.feed_record_count,
  s.replica_lag_ms, s.content_sha256, s.ledger_seq, s.created_at`;

async function detailAllowed(tx: Tx, viewer: Viewer, controlId: string): Promise<boolean> {
  if (isAdminViewer(viewer)) return true;
  const c = await tx`SELECT owner_user_id FROM bastion_controls WHERE organization_id = ${viewer.org_id} AND id = ${controlId}`;
  return c[0]?.owner_user_id === viewer.id;
}

/**
 * The summary a counts-only reader gets (#250): scalar facts only (counts, window lengths,
 * statuses, dates). Arrays and objects (summary.repos with repository names and webhook settings,
 * summary.population_missing) are names, not counts, so they are dropped whatever the probe.
 */
export function countsOnlySummary(summary: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(summary ?? {})) {
    if (v === null || typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') out[k] = v;
  }
  return out;
}

const everyName: NameVisible = () => true;

/**
 * Shape one snapshot for a reader. explain() is counts-only unless the viewer may see detail
 * (owner, admin, or the control's owner); cited refs are dropped from the counts-only view, and so
 * is every list of names in the population and the summary (#250). A detail reader sees only the
 * names `visibleName` allows (repositories of Bam projects they can open); the rest are counted
 * in population_hidden_count and named nowhere, including the explanation sentence.
 */
export function present(row: Record<string, unknown>, detail: boolean, visibleName: NameVisible = everyName) {
  const rawSummary = (row.summary as Record<string, unknown> | null) ?? {};
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const checkedAll = strings(row.population_checked);
  const checked = checkedAll.filter(visibleName);
  const unlisted = strings(row.population_unlisted).filter(visibleName);
  const summary: Record<string, unknown> = detail ? { ...rawSummary } : countsOnlySummary(rawSummary);
  if (detail && Array.isArray(rawSummary.repos)) {
    summary.repos = (rawSummary.repos as Array<Record<string, unknown> | null>).filter(
      (r) => typeof r?.repo === 'string' && visibleName(r.repo as string),
    );
  }
  const hiddenPopulation = detail ? checkedAll.length - checked.length : 0;

  const def = row.probe_key ? probeDefinition(row.probe_key as string) : undefined;
  let explanation: string | null = null;
  if (def) {
    // Counts-only readers get the sentence from the full facts with names off (it prints counts
    // only); detail readers get it from the filtered facts plus the hidden count.
    const result = {
      probe_key: row.probe_key,
      probe_version: row.probe_version,
      as_of: '',
      summary: detail ? summary : rawSummary,
      cited_refs: (row.cited_refs as BastionProbeResult['cited_refs']) ?? [],
      cited_count: Number(rawSummary.cited_count ?? 0),
      overflow_count: Number(row.overflow_count ?? 0),
      population_checked: row.population_checked == null ? undefined : detail ? checked : checkedAll,
      population_unlisted: row.population_unlisted == null ? undefined : detail ? unlisted : strings(row.population_unlisted),
      population_missing: (rawSummary.population_missing as string[] | undefined) ?? undefined,
      population_hidden_count: hiddenPopulation,
    } as BastionProbeResult & { population_hidden_count: number };
    explanation = def.explain(result, detail);
  }
  return {
    ...row,
    summary,
    cited_refs: detail ? row.cited_refs : [],
    population_checked: detail && row.population_checked != null ? checked : null,
    population_unlisted: detail && row.population_unlisted != null ? unlisted : null,
    population_hidden_count: hiddenPopulation,
    explanation,
    detail_visible: detail,
  };
}

const refKey = (r: CitedRef) => `${r.entity_type}:${r.entity_id}`;

/**
 * The cited refs a detail viewer may see (spec 2.4, #227). Detail access (owner, admin, the
 * control's owner) opens the evidence, not every row it cites: each ref still passes can_access
 * for this reader, so a control owner sees no PR, key or person from outside their own reach.
 */
async function visibleRefKeys(canAccess: CanAccess, viewer: Viewer, refs: CitedRef[]): Promise<Set<string>> {
  return new Set((await visibleRefs(canAccess, viewer, refs)).map(refKey));
}

function withVisibleRefs(
  row: Record<string, unknown>,
  detail: boolean,
  visible: Set<string>,
  names: Map<string, string>,
  visibleName: NameVisible,
) {
  const shaped = present(row, detail, visibleName);
  const all = detail ? ((row.cited_refs as CitedRef[] | null) ?? []) : [];
  const refs = all.filter((r) => visible.has(refKey(r)));
  return {
    ...shaped,
    cited_refs: detail ? refs : [],
    hidden_citation_count: all.length - refs.length,
    cited_labels: labelsFor(refs, names),
    cited_items: refs.map((ref) => ({ ...ref, label: names.get(refKey(ref)) ?? null })),
  };
}

export async function listControlEvidence(deps: EngineDeps, viewer: Viewer, controlId: string, q: BastionEvidenceListQuery, canAccess: CanAccess) {
  return orgTx(deps.sql, viewer.org_id, async (tx) => {
    const c = await tx`SELECT id FROM bastion_controls WHERE organization_id = ${viewer.org_id} AND id = ${controlId}`;
    if (!c[0]) throw new NotFoundError('We could not find that control.');
    const after = q.cursor ? decodeIdCursor(q.cursor) : null;
    const rows = await tx.unsafe(
      `SELECT ${SNAPSHOT_SELECT} FROM bastion_evidence_snapshots s
        WHERE s.organization_id = $1 AND s.control_id = $2 AND ($3::uuid IS NULL OR s.assertion_id = $3)
          AND ($5::uuid IS NULL OR (s.created_at, s.id) < (
                SELECT p.created_at, p.id FROM bastion_evidence_snapshots p WHERE p.id = $5::uuid AND p.organization_id = $1))
        ORDER BY s.created_at DESC, s.id DESC LIMIT $4`,
      [viewer.org_id, controlId, q.assertion_id ?? null, q.limit + 1, after],
    );
    const detail = await detailAllowed(tx, viewer, controlId);
    const page = pageOf(rows, q.limit, (r) => encodeIdCursor(r.id as string));
    // Named chips for detail viewers (spec 6.2): "PR #42 in rescue-radio-firmware: ...", only for
    // refs that pass can_access for this reader.
    const allRefs = detail ? page.data.flatMap((r) => ((r as Record<string, unknown>).cited_refs as CitedRef[] | null) ?? []) : [];
    const visible = detail ? await visibleRefKeys(canAccess, viewer, allRefs) : new Set<string>();
    const names = detail ? await labelRefs(tx, viewer.org_id, allRefs.filter((r) => visible.has(refKey(r)))) : new Map<string, string>();
    // Repository names pass the same project-membership rule as the PRs they come from (#250).
    const visibleName = detail
      ? await populationVisibility(tx, canAccess, viewer, page.data.flatMap((r) => populationNames(r as Record<string, unknown>)))
      : everyName;
    return {
      ...page,
      data: page.data.map((r) => withVisibleRefs(r as Record<string, unknown>, detail, visible, names, visibleName)),
    };
  });
}

export async function getEvidence(deps: EngineDeps, viewer: Viewer, id: string, canAccess: CanAccess) {
  return orgTx(deps.sql, viewer.org_id, async (tx) => {
    const rows = await tx.unsafe(`SELECT ${SNAPSHOT_SELECT} FROM bastion_evidence_snapshots s WHERE s.organization_id = $1 AND s.id = $2`, [viewer.org_id, id]);
    const row = rows[0] as Record<string, unknown> | undefined;
    if (!row) throw new NotFoundError('We could not find that evidence.');
    const detail = await detailAllowed(tx, viewer, row.control_id as string);
    const refs = detail ? ((row.cited_refs as CitedRef[] | null) ?? []) : [];
    const visible = detail ? await visibleRefKeys(canAccess, viewer, refs) : new Set<string>();
    const names = detail ? await labelRefs(tx, viewer.org_id, refs.filter((r) => visible.has(refKey(r)))) : new Map<string, string>();
    const visibleName = detail ? await populationVisibility(tx, canAccess, viewer, populationNames(row)) : everyName;
    return { data: withVisibleRefs(row, detail, visible, names, visibleName) };
  });
}

// ── Verification (spec 3.4) ──────────────────────────────────────────────────────────────

const VERIFY_WALK_LIMIT = 50_000;

async function readObject(deps: EngineDeps, key: string): Promise<Buffer | null> {
  if (!deps.storage) return null;
  try {
    const { stream } = await withStorageTimeout('get', deps.storage.getStream(key), deps.putTimeoutMs);
    const chunks: Buffer[] = [];
    for await (const c of stream as AsyncIterable<Buffer | string>) chunks.push(typeof c === 'string' ? Buffer.from(c) : c);
    return Buffer.concat(chunks);
  } catch {
    return null;
  }
}

/**
 * Verify one evidence snapshot: the ledger entry's hash, the stored object's bytes, the
 * personal-data commitment, and the chain from the entry to the next seal (whose signature is
 * checked against every published key). Results: intact, hash_mismatch, object_missing
 * (shown as "Evidence file missing"), redacted, pd_mismatch, key_changed.
 */
export async function verifyEvidence(deps: EngineDeps, viewer: Viewer, id: string) {
  const ctx = await orgTx(deps.sql, viewer.org_id, async (tx) => {
    const snap = (await tx`SELECT id, content_sha256, ledger_seq, personal_data_hmac, pd_hmac_key_id
                             FROM bastion_evidence_snapshots WHERE organization_id = ${viewer.org_id} AND id = ${id}`)[0];
    if (!snap) throw new NotFoundError('We could not find that evidence.');
    const entry = (await tx`
      SELECT organization_id, epoch, seq, entry_kind, entry_id, content_sha256, personal_data_hmac, pd_hmac_key_id,
             prev_entry_hash, entry_hash, recorded_at
        FROM bastion_ledger_entries WHERE organization_id = ${viewer.org_id} AND entry_kind = 'snapshot' AND entry_id = ${id}`)[0] as LedgerRow | undefined;
    const object = (await tx`SELECT object_key, bytes_redacted_at FROM bastion_evidence_objects
                              WHERE organization_id = ${viewer.org_id} AND content_sha256 = ${snap.content_sha256 as string}`)[0];
    const pd = (await tx`SELECT data_hmac, pd_hmac_key_id, redacted_at FROM bastion_personal_data
                          WHERE organization_id = ${viewer.org_id} AND holder_kind = 'snapshot' AND holder_id = ${id}`)[0];
    let seal: Record<string, unknown> | undefined;
    let walk: LedgerRow[] = [];
    if (entry) {
      seal = (await tx`SELECT seal_date::text AS seal_date, epoch, head_seq, head_hash, signature, signing_key_id
                         FROM bastion_ledger_seals WHERE organization_id = ${viewer.org_id} AND head_seq >= ${entry.seq}
                        ORDER BY head_seq, seal_date LIMIT 1`)[0];
      if (seal) {
        walk = (await tx`
          SELECT organization_id, epoch, seq, entry_kind, entry_id, content_sha256, personal_data_hmac, pd_hmac_key_id,
                 prev_entry_hash, entry_hash, recorded_at
            FROM bastion_ledger_entries
           WHERE organization_id = ${viewer.org_id} AND seq >= ${entry.seq} AND seq <= ${seal.head_seq as string}
           ORDER BY seq LIMIT ${VERIFY_WALK_LIMIT}`) as unknown as LedgerRow[];
      }
    }
    return { snap, entry, object, pd, seal, walk };
  });

  const checks: string[] = [];
  let result: 'intact' | 'hash_mismatch' | 'object_missing' | 'redacted' | 'pd_mismatch' | 'key_changed' = 'intact';
  const set = (r: typeof result) => {
    if (result === 'intact') result = r;
  };

  if (!ctx.entry) {
    set('hash_mismatch');
    checks.push('No ledger entry records this evidence.');
  } else {
    if (entryHash(fieldsOfRow(ctx.entry)) !== ctx.entry.entry_hash) {
      set('hash_mismatch');
      checks.push('The ledger entry does not match its own hash.');
    }
    if (ctx.entry.content_sha256 !== ctx.snap.content_sha256) {
      set('hash_mismatch');
      checks.push('The evidence hash differs from the ledger entry.');
    }
  }
  if (ctx.object?.bytes_redacted_at) {
    set('redacted');
    checks.push('The evidence file was redacted.');
  } else {
    const bytes = ctx.object ? await readObject(deps, ctx.object.object_key as string) : null;
    if (!bytes) {
      set('object_missing');
      checks.push('Evidence file missing.');
      deps.log.error({ organization_id: viewer.org_id, snapshot_id: id }, 'bastion-verify: evidence object missing from the bucket');
    } else {
      if (createHash('sha256').update(bytes).digest('hex') !== ctx.snap.content_sha256) {
        set('hash_mismatch');
        checks.push('The stored evidence file does not match its recorded hash.');
      }
    }
  }
  if (ctx.snap.personal_data_hmac) {
    if (ctx.pd?.redacted_at) set('redacted');
    else if (ctx.snap.pd_hmac_key_id !== pdHmacKeyId()) set('key_changed');
    else if (!ctx.pd || ctx.pd.data_hmac !== ctx.snap.personal_data_hmac) set('pd_mismatch');
  }

  let sealCheck: Record<string, unknown> | null = null;
  if (ctx.seal) {
    const chain = verifyChain(ctx.walk);
    const sealHead = ctx.walk.find((w) => Number(w.seq) === Number(ctx.seal?.head_seq));
    const signatureOk = verifySeal(
      {
        org: viewer.org_id,
        seal_date: ctx.seal.seal_date as string,
        epoch: Number(ctx.seal.epoch),
        head_seq: Number(ctx.seal.head_seq),
        head_hash: ctx.seal.head_hash as string,
        signing_key_id: ctx.seal.signing_key_id as string,
      },
      ctx.seal.signature as string,
      publishedSealKeyMap(),
    );
    const headOk = !!sealHead && sealHead.entry_hash === ctx.seal.head_hash;
    if (chain.length > 0 || !signatureOk || !headOk) {
      set('hash_mismatch');
      checks.push('The chain from this entry to its seal does not verify.');
    }
    sealCheck = { seal_date: ctx.seal.seal_date, head_seq: Number(ctx.seal.head_seq), signing_key_id: ctx.seal.signing_key_id, signature_valid: signatureOk, chain_intact: chain.length === 0 && headOk };
  } else {
    checks.push('Not sealed yet: seals are written once a day.');
  }

  return {
    data: {
      evidence_id: id,
      result,
      content_sha256: ctx.snap.content_sha256,
      ledger: ctx.entry ? { epoch: Number(ctx.entry.epoch), seq: Number(ctx.entry.seq), entry_hash: ctx.entry.entry_hash } : null,
      seal: sealCheck,
      notes: checks,
    },
  };
}

// ── Seals and restores ───────────────────────────────────────────────────────────────────

/** GET /ledger/seals, newest seal_date first, keyset-paginated on seal_date (issue #204). */
export async function listSeals(deps: EngineDeps, viewer: Viewer, q: BastionSealListQuery = { limit: 90 }) {
  const before = q.cursor ? decodeDateCursor(q.cursor) : null;
  const rows = await orgTx(deps.sql, viewer.org_id, (tx) => tx`
    SELECT seal_date::text AS seal_date, epoch, head_seq, head_hash, signature, signing_key_id, object_written_at, published_at
      FROM bastion_ledger_seals WHERE organization_id = ${viewer.org_id}
       ${before ? tx`AND seal_date < ${before}::date` : tx``}
     ORDER BY seal_date DESC LIMIT ${q.limit + 1}`);
  const page = pageOf(rows, q.limit, (r) => encodeDateCursor(r.seal_date as string));
  return {
    ...page,
    data: page.data.map((r) => ({ ...r, epoch: Number(r.epoch), head_seq: Number(r.head_seq) })),
    signing_keys: publishedSealKeys(),
    canonical_form: 'signature = Ed25519 over canonical JSON (sorted keys, no whitespace) of {org, seal_date, epoch, head_seq, head_hash, signing_key_id}',
  };
}

/**
 * Database rows (newest first, keyset-paginated on (detected_at, id), issue #204) plus every
 * lost range recorded in the bucket that the database no longer holds (they survive a DB
 * rewrite). `bucket_only` is computed against ALL database ids and returned on the first page.
 */
export async function listRestores(deps: EngineDeps, viewer: Viewer, q: BastionRestoreListQuery = { limit: 50 }) {
  const after = q.cursor ? decodeIdCursor(q.cursor) : null;
  const { rows, allIds } = await orgTx(deps.sql, viewer.org_id, async (tx) => ({
    rows: await tx`
      SELECT id, detected_at, db_head_seq, bucket_seal_date::text AS bucket_seal_date, bucket_epoch, bucket_head_seq,
             lost_from_seq, lost_to_seq, provisional_epoch, platform_restore_id, status, resolution, resolved_by, resolved_at
        FROM bastion_ledger_restores WHERE organization_id = ${viewer.org_id}
         ${after
           ? tx`AND (detected_at, id) < (SELECT r.detected_at, r.id FROM bastion_ledger_restores r
                                          WHERE r.id = ${after}::uuid AND r.organization_id = ${viewer.org_id})`
           : tx``}
       ORDER BY detected_at DESC, id DESC LIMIT ${q.limit + 1}`,
    allIds: after ? [] : await tx`SELECT id FROM bastion_ledger_restores WHERE organization_id = ${viewer.org_id}`,
  }));
  const page = pageOf(rows, q.limit, (r) => encodeIdCursor(r.id as string));
  let bucket: Array<Record<string, unknown>> = [];
  let bucketAvailable = true;
  if (!after) {
    try {
      bucket = await bucketRestoreRecords(deps, viewer.org_id);
    } catch {
      bucketAvailable = false;
    }
  }
  const known = new Set(allIds.map((r) => r.id as string));
  const label = (status: unknown, resolution: unknown) =>
    status === 'acknowledged' || resolution === 'restore_acknowledged' ? 'History lost by restore' : 'Unexplained gap';
  return {
    has_more: page.has_more,
    next_cursor: page.next_cursor,
    data: page.data.map((r) => ({
      ...r,
      label: label(r.status, r.resolution),
      appends_blocked: r.resolution === null,
      summary: `${label(r.status, r.resolution)}, epoch ${r.bucket_epoch} seq ${r.lost_from_seq}-${r.lost_to_seq}`,
    })),
    bucket_only: bucket
      .filter((b) => typeof b.id === 'string' && !known.has(b.id as string))
      .map((b) => ({ ...b, label: label(b.status, b.resolution), summary: `${label(b.status, b.resolution)}, epoch ${b.bucket_epoch} seq ${b.lost_from_seq}-${b.lost_to_seq}` })),
    bucket_available: bucketAvailable,
  };
}

/**
 * POST /ledger/restores/:id/acknowledge (spec 3.4 points 4-5). Owner only (the route also
 * requires a session and refuses impersonation). `restore_acknowledged` needs a pending_ack row
 * (a matching platform restore); `continue_unexplained` resumes appends under the provisional
 * epoch and keeps the "Unexplained gap" label forever. Either way a `restore` ledger entry opens
 * the provisional epoch, numbering never changes, and appends resume.
 */
export async function acknowledgeRestore(deps: EngineDeps, viewer: Viewer, id: string, body: BastionRestoreAcknowledge) {
  if (viewer.role !== 'owner') {
    throw new ForbiddenError('Only an owner of this organization can resolve a ledger restore.', 'OWNER_REQUIRED');
  }
  let highest = null;
  try {
    highest = highestSeal((await refreshSeals(deps, viewer.org_id, true)).seals);
  } catch {
    highest = null;
  }
  const updated = await orgTx(deps.sql, viewer.org_id, async (tx) => {
    await lockLedger(tx, viewer.org_id);
    const row = (await tx`SELECT id, status, resolution, provisional_epoch, bucket_epoch, bucket_head_seq, lost_from_seq, lost_to_seq
                            FROM bastion_ledger_restores WHERE organization_id = ${viewer.org_id} AND id = ${id} FOR UPDATE`)[0];
    if (!row) throw new NotFoundError('We could not find that restore record.');
    if (row.resolution !== null) throw new ConflictError('This restore has already been resolved.', 'ALREADY_RESOLVED');
    if (body.resolution === 'restore_acknowledged' && row.status !== 'pending_ack') {
      throw new ValidationFailure(
        'No completed restore lines up with this gap, so it cannot be acknowledged as a restore. You can resume recording and keep it labelled "Unexplained gap".',
        'NO_MATCHING_RESTORE',
        [{ field: 'resolution', issue: 'no_matching_restore' }],
      );
    }
    const status = body.resolution === 'restore_acknowledged' ? 'acknowledged' : row.status;
    await tx`UPDATE bastion_ledger_restores
                SET status = ${status as string}, resolution = ${body.resolution}, resolved_by = ${viewer.id}, resolved_at = ${deps.now()}
              WHERE organization_id = ${viewer.org_id} AND id = ${id}`;
    const [entry] = await appendLedger(
      tx,
      viewer.org_id,
      [{ kind: 'restore', id, content_sha256: null, personal_data_hmac: null, pd_hmac_key_id: null }],
      { highest, now: deps.now(), skipLock: true },
    );
    if (body.resolution === 'restore_acknowledged') {
      await enqueueBastionEvent(
        'ledger.restored',
        { restore_id: id, epoch: entry?.epoch ?? null, lost_from_seq: Number(row.lost_from_seq), lost_to_seq: Number(row.lost_to_seq) },
        tx,
        { orgId: viewer.org_id, idempotencyKey: `ledger.restored:${id}`, orderingKey: `seal:${viewer.org_id}`, actorId: viewer.id, actorType: 'user' },
      );
    }
    await auditRaw(tx, viewer, 'ledger.restore.resolve', { type: 'ledger_restore', id }, { resolution: body.resolution, epoch: entry?.epoch, seq: entry?.seq });
    return { id, status, resolution: body.resolution, provisional_epoch: entry?.epoch ?? null, first_seq: entry?.seq ?? null };
  });
  await writeRestoreObject(deps, viewer.org_id, id);
  return { data: updated };
}

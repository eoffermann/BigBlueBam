// The nightly evaluator (spec 2.2, 3.2, 7.3), one slice per engine call.
//
// A slice claims the run (fenced on claimed_by; a claim whose heartbeat is older than the lease
// may be taken over), checks ledger identity once for the batch, then evaluates assertions that
// have no snapshot in this run yet, stopping new probes at SLICE_START_CUTOFF_MS. Per assertion:
//
//   1. evaluate (probe via runInOrgScopeRead, manual links, or feed);
//   2. write the canonical evidence document to the bucket (intent row first, put with a 5 s
//      budget, outside any transaction);
//   3. one transaction: object row (reference-counted), intent deleted, snapshot, ledger entry
//      (advisory lock, lock_timeout 3 s), and, when this is the control's last missing snapshot
//      for the run, the conditional control status write plus drift rows and outbox events.
//
// Infrastructure failures never drift: a probe_error keeps the stored status (second distinct
// night only: unprovable/probe_error); a bucket or lock failure ends the slice without writing
// and the run stays resumable; a detected restore ends the run `partial` / `restore_pending`.

import { randomUUID } from 'node:crypto';
import type { BastionEvaluateRunSlice, BastionProbeResult } from '@bigbluebam/shared';
import { withStorageTimeout } from '@bigbluebam/storage';
import { canonicalJson, sha256Hex } from '../lib/ledger-canonical.js';
import { decide, probeDefinition, probeWindow } from '../probes/definitions.js';
import { runProbe } from '../probes/run-probe.js';
import { SLICE_START_CUTOFF_MS, SLICE_WRITE_CUTOFF_MS, STALE_HEARTBEAT_MS } from './budgets.js';
import { type EngineDeps, orgTx, sqlstateOf, type Tx } from './context.js';
import { appendLedger, AppendBlockedError, LedgerLockTimeoutError, RestoreDetectedError } from './ledger.js';
import { enqueueBastionEvent } from './outbox.js';
import { decideManual } from './manual.js';
import { checkLedgerIdentity, type SealIdentity, StorageUnavailableError } from './restore.js';
import { aggregateStored, coverageKindOf, infraDecision, isWorsening } from './status.js';

export class RunNotFoundError extends Error {
  constructor() {
    super('We could not find that evaluation run.');
    this.name = 'RunNotFoundError';
  }
}

export class RunLeaseHeldError extends Error {
  constructor(
    public readonly claimedBy: string | null,
    public readonly heartbeatStale: boolean,
  ) {
    super('This evaluation run is being driven by another worker.');
    this.name = 'RunLeaseHeldError';
  }
}

export interface RunRow {
  id: string;
  organization_id: string;
  trigger: 'nightly' | 'manual' | 'agent';
  scope: 'all' | 'control';
  control_id: string | null;
  nightly_for_date: string | null;
  as_of: Date;
  status: string;
  partial_reason: string | null;
  resume_count: number;
  controls_total: number;
  claimed_by: string | null;
  heartbeat_at: Date | null;
  started_by: string | null;
}

/** The shared response contract the worker parses (issue #205). */
export type SliceResult = BastionEvaluateRunSlice;

interface PlannedAssertion {
  id: string;
  control_id: string;
  kind: 'probe' | 'manual' | 'feed';
  probe_key: string | null;
  probe_version: number | null;
  params: Record<string, unknown>;
  predicate: Record<string, unknown>;
  feed_id: string | null;
  manual_evidence_spec: Record<string, unknown> | null;
}

interface Evaluated {
  outcome: 'pass' | 'fail' | 'unprovable';
  unprovable_reason: string | null;
  probe_key: string | null;
  probe_version: number | null;
  query_fingerprint: string | null;
  population_checked: string[] | null;
  population_unlisted: string[] | null;
  window_start: Date | null;
  window_end: Date | null;
  summary: Record<string, unknown>;
  cited_refs: Array<{ entity_type: string; entity_id: string }>;
  overflow_count: number;
  manual_evidence_ids: string[];
  feed_record_count: number;
  replica_lag_ms: number | null;
  error?: string;
}

const RUN_COLUMNS = `id, organization_id, trigger, scope, control_id, nightly_for_date::text AS nightly_for_date, as_of,
  status, partial_reason, resume_count, controls_total, claimed_by, heartbeat_at, started_by`;

// ── Claim and fencing ────────────────────────────────────────────────────────────────────

export async function claimRun(deps: EngineDeps, orgId: string, runId: string, claimant: string): Promise<RunRow | null> {
  const rows = await orgTx(deps.sql, orgId, (tx) =>
    tx.unsafe(
      `UPDATE bastion_evaluation_runs
          SET status = 'running', claimed_by = $3, heartbeat_at = now(), started_at = coalesce(started_at, now())
        WHERE id = $1 AND organization_id = $2 AND status IN ('queued', 'running')
          AND (claimed_by IS NULL OR claimed_by = $3 OR heartbeat_at IS NULL
               OR heartbeat_at < now() - make_interval(secs => $4))
        RETURNING ${RUN_COLUMNS}`,
      [runId, orgId, claimant, deps.leaseMs / 1000],
    ),
  );
  return (rows[0] as unknown as RunRow | undefined) ?? null;
}

async function loadRun(deps: EngineDeps, orgId: string, runId: string): Promise<RunRow | null> {
  const rows = await orgTx(deps.sql, orgId, (tx) =>
    tx.unsafe(`SELECT ${RUN_COLUMNS} FROM bastion_evaluation_runs WHERE id = $1 AND organization_id = $2`, [runId, orgId]),
  );
  return (rows[0] as unknown as RunRow | undefined) ?? null;
}

/** Heartbeat fenced on the claimant. False means the claim was lost (stop at once). */
async function heartbeat(deps: EngineDeps, run: RunRow, claimant: string): Promise<boolean> {
  const rows = await orgTx(deps.sql, run.organization_id, (tx) => tx`
    UPDATE bastion_evaluation_runs SET heartbeat_at = now()
     WHERE id = ${run.id} AND organization_id = ${run.organization_id} AND claimed_by = ${claimant} AND status = 'running'
    RETURNING id`);
  return rows.length > 0;
}

async function endRun(
  deps: EngineDeps,
  run: RunRow,
  claimant: string,
  status: 'succeeded' | 'partial' | 'failed',
  partialReason: string | null,
): Promise<boolean> {
  return orgTx(deps.sql, run.organization_id, async (tx) => {
    const counts = await runCounts(tx, run);
    const rows = await tx`
      UPDATE bastion_evaluation_runs
         SET status = ${status}, partial_reason = ${partialReason}, completed_at = ${status === 'succeeded' ? deps.now() : null},
             claimed_by = NULL, controls_done = ${counts.controls_done}, pass_count = ${counts.pass},
             fail_count = ${counts.fail}, unprovable_count = ${counts.unprovable}
       WHERE id = ${run.id} AND organization_id = ${run.organization_id} AND claimed_by = ${claimant}
      RETURNING id`;
    if (rows.length === 0) return false;
    if (status === 'succeeded') {
      await enqueueBastionEvent(
        'evaluation.completed',
        {
          run_id: run.id,
          trigger: run.trigger,
          scope: run.scope,
          control_id: run.control_id,
          controls_done: counts.controls_done,
          pass_count: counts.pass,
          fail_count: counts.fail,
          unprovable_count: counts.unprovable,
        },
        tx,
        { orgId: run.organization_id, idempotencyKey: `evaluation.completed:${run.id}` },
      );
    }
    return true;
  });
}

// ── Planning ─────────────────────────────────────────────────────────────────────────────

/** In-scope controls: active, with at least one applicable link in a non-archived framework. */
function scopeFilter(run: RunRow) {
  return run.scope === 'control' && run.control_id ? `AND c.id = '${run.control_id}'::uuid` : '';
}

async function plan(tx: Tx, run: RunRow): Promise<{ pending: PlannedAssertion[]; total: number; controlsTotal: number }> {
  if (run.control_id && !/^[0-9a-f-]{36}$/i.test(run.control_id)) throw new Error('bad control id on run');
  const rows = (await tx.unsafe(
    `SELECT a.id, a.control_id, a.kind, a.probe_key, a.probe_version, a.params, a.predicate, a.feed_id, a.manual_evidence_spec,
            EXISTS (SELECT 1 FROM bastion_evidence_snapshots s
                     WHERE s.organization_id = a.organization_id AND s.evaluation_run_id = $2 AND s.assertion_id = a.id) AS done
       FROM bastion_assertions a
       JOIN bastion_controls c ON c.id = a.control_id AND c.organization_id = a.organization_id
      WHERE a.organization_id = $1 AND a.review_status = 'confirmed' AND c.lifecycle = 'active'
        AND EXISTS (SELECT 1 FROM bastion_control_requirements r
                      JOIN bastion_frameworks f ON f.id = r.framework_id AND f.organization_id = r.organization_id
                     WHERE r.organization_id = c.organization_id AND r.control_id = c.id AND r.removed_at IS NULL
                       AND r.applicability = 'applicable' AND f.status <> 'archived')
        ${scopeFilter(run)}
      ORDER BY a.control_id, a.id`,
    [run.organization_id, run.id],
  )) as unknown as Array<PlannedAssertion & { done: boolean }>;
  const controls = new Set(rows.map((r) => r.control_id));
  return {
    pending: rows.filter((r) => !r.done),
    total: rows.length,
    controlsTotal: controls.size,
  };
}

async function runCounts(tx: Tx, run: RunRow) {
  const rows = await tx`
    SELECT count(*) FILTER (WHERE s.outcome = 'pass')::int AS pass,
           count(*) FILTER (WHERE s.outcome = 'fail')::int AS fail,
           count(*) FILTER (WHERE s.outcome = 'unprovable')::int AS unprovable,
           count(*)::int AS done
      FROM bastion_evidence_snapshots s
     WHERE s.organization_id = ${run.organization_id} AND s.evaluation_run_id = ${run.id}`;
  const done = await tx`
    SELECT count(*)::int AS n FROM (
      SELECT s.control_id
        FROM bastion_evidence_snapshots s
       WHERE s.organization_id = ${run.organization_id} AND s.evaluation_run_id = ${run.id}
       GROUP BY s.control_id
      HAVING count(*) >= (SELECT count(*) FROM bastion_assertions a
                           WHERE a.organization_id = ${run.organization_id} AND a.control_id = s.control_id
                             AND a.review_status = 'confirmed')
    ) x`;
  const r = rows[0] ?? {};
  return {
    pass: Number(r.pass ?? 0),
    fail: Number(r.fail ?? 0),
    unprovable: Number(r.unprovable ?? 0),
    assertions_done: Number(r.done ?? 0),
    controls_done: Number(done[0]?.n ?? 0),
  };
}

// ── Evaluating one assertion ─────────────────────────────────────────────────────────────

const fingerprints = new Map<string, string>();

async function fingerprintOf(deps: EngineDeps, fn: string): Promise<string | null> {
  if (fingerprints.size === 0) {
    const rows = await deps.sql.unsafe(
      `SELECT p.proname AS name, encode(sha256(convert_to(pg_get_functiondef(p.oid), 'UTF8')), 'hex') AS fp
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname LIKE 'bastion_probe_%' AND p.prokind = 'f'`,
    );
    for (const r of rows) fingerprints.set(String(r.name), String(r.fp));
  }
  return fingerprints.get(fn) ?? null;
}

function blank(): Omit<Evaluated, 'outcome' | 'unprovable_reason'> {
  return {
    probe_key: null,
    probe_version: null,
    query_fingerprint: null,
    population_checked: null,
    population_unlisted: null,
    window_start: null,
    window_end: null,
    summary: {},
    cited_refs: [],
    overflow_count: 0,
    manual_evidence_ids: [],
    feed_record_count: 0,
    replica_lag_ms: null,
  };
}

async function evaluateProbe(deps: EngineDeps, run: RunRow, key: string, params: Record<string, unknown>, predicate: Record<string, unknown>): Promise<Evaluated> {
  const def = probeDefinition(key);
  const base = blank();
  if (!def) return { ...base, outcome: 'unprovable', unprovable_reason: 'probe_error', probe_key: key, error: `unknown probe ${key}` };
  base.probe_key = def.key;
  base.probe_version = def.version;
  const parsedParams = def.paramsSchema.safeParse(params ?? {});
  const parsedPredicate = def.predicateSchema.safeParse(predicate ?? {});
  if (!parsedParams.success || !parsedPredicate.success) {
    return { ...base, outcome: 'unprovable', unprovable_reason: 'probe_error', error: 'stored parameters no longer validate' };
  }
  const fn = `bastion_probe_${def.key.replace(/\./g, '_')}_v${def.version}`;
  base.query_fingerprint = await fingerprintOf(deps, fn);
  const asOf = new Date(run.as_of);
  const res = await runProbe(deps.runRead, def, run.organization_id, asOf, parsedParams.data as Record<string, unknown>);
  if (!res.ok) return { ...base, outcome: 'unprovable', unprovable_reason: 'probe_error', error: res.error };
  const result: BastionProbeResult = res.result;
  const decision = decide(def, result, parsedPredicate.data as Record<string, unknown>);
  const window = probeWindow(result, asOf);
  return {
    ...base,
    outcome: decision.outcome,
    unprovable_reason: decision.outcome === 'unprovable' ? decision.reason : null,
    population_checked: result.population_checked ?? null,
    population_unlisted: result.population_unlisted ?? null,
    window_start: window.start,
    window_end: window.end,
    summary: { ...result.summary, cited_count: result.cited_count, population_missing: result.population_missing ?? undefined },
    cited_refs: result.cited_refs,
    overflow_count: result.overflow_count,
    replica_lag_ms: res.replica_lag_ms,
  };
}

/**
 * Manual evidence (spec 3.3): the pure decision table in ./manual.ts over the assertion's active,
 * still-linked items. The window is the assertion's cadence_days (manual_evidence_spec).
 */
async function evaluateManual(deps: EngineDeps, run: RunRow, a: PlannedAssertion): Promise<Evaluated> {
  const rows = await orgTx(deps.sql, run.organization_id, (tx) => tx`
    SELECT e.id, e.kind, e.status, e.valid_until, e.produced_on::text AS produced_on, e.period_end::text AS period_end,
           e.uploaded_by, l.review_verdict, l.reviewed_by, l.small_team_self_review
      FROM bastion_manual_evidence_links l
      JOIN bastion_manual_evidence e ON e.id = l.manual_evidence_id AND e.organization_id = l.organization_id
     WHERE l.organization_id = ${run.organization_id} AND l.assertion_id = ${a.id} AND l.unlinked_at IS NULL
       AND e.status = 'active'
     ORDER BY e.created_at, e.id`);
  const asOf = new Date(run.as_of);
  const cadence = Number((a.manual_evidence_spec as { cadence_days?: number } | null)?.cadence_days ?? 365);
  const d = decideManual(
    rows.map((r) => ({
      id: String(r.id),
      kind: r.kind as 'file' | 'attestation_statement',
      status: String(r.status),
      valid_until: r.valid_until ? new Date(r.valid_until as string) : null,
      produced_on: (r.produced_on as string | null) ?? null,
      period_end: (r.period_end as string | null) ?? null,
      uploaded_by: String(r.uploaded_by),
      review_verdict: r.review_verdict as 'pending' | 'accepted' | 'shows_exception',
      reviewed_by: (r.reviewed_by as string | null) ?? null,
      small_team_self_review: r.small_team_self_review === true,
    })),
    asOf,
    cadence,
  );
  return {
    ...blank(),
    manual_evidence_ids: d.item_ids,
    window_start: new Date(asOf.getTime() - cadence * 86_400_000),
    window_end: asOf,
    outcome: d.outcome,
    unprovable_reason: d.unprovable_reason,
    summary: {
      items_considered: d.item_ids.length,
      items_passing: d.passing_ids.length,
      self_attested_only: d.self_attested_only,
      small_team_self_review: d.small_team_self_review,
      expires_at: d.expires_at ? d.expires_at.toISOString() : null,
    },
  };
}

async function evaluateAssertion(deps: EngineDeps, run: RunRow, a: PlannedAssertion): Promise<Evaluated> {
  if (a.kind === 'probe' && a.probe_key) return evaluateProbe(deps, run, a.probe_key, a.params, a.predicate);
  if (a.kind === 'feed') {
    if (!a.feed_id) return { ...blank(), outcome: 'unprovable', unprovable_reason: 'no_evidence_source' };
    const ev = await evaluateProbe(deps, run, 'feed.fresh', { ...(a.params ?? {}), feed_id: a.feed_id }, a.predicate);
    return { ...ev, feed_record_count: Number(ev.summary.records_in_cadence ?? 0) };
  }
  if (a.kind === 'manual') return evaluateManual(deps, run, a);
  return { ...blank(), outcome: 'unprovable', unprovable_reason: 'no_evidence_source' };
}

/** The canonical evidence document that is hashed, stored and chained (spec 2.2). */
export function evidenceDocument(run: RunRow, a: PlannedAssertion, ev: Evaluated) {
  return {
    schema: 'bastion.evidence.v1',
    org: run.organization_id,
    evaluation_run_id: run.id,
    assertion_id: a.id,
    control_id: a.control_id,
    as_of: new Date(run.as_of).toISOString(),
    outcome: ev.outcome,
    unprovable_reason: ev.unprovable_reason,
    probe_key: ev.probe_key,
    probe_version: ev.probe_version,
    params: a.params ?? {},
    query_fingerprint: ev.query_fingerprint,
    population_checked: ev.population_checked,
    population_unlisted: ev.population_unlisted,
    window_start: ev.window_start ? ev.window_start.toISOString() : null,
    window_end: ev.window_end ? ev.window_end.toISOString() : null,
    summary: JSON.parse(JSON.stringify(ev.summary ?? {})) as Record<string, unknown>,
    cited_refs: ev.cited_refs,
    overflow_count: ev.overflow_count,
    manual_evidence_ids: ev.manual_evidence_ids,
    feed_record_count: ev.feed_record_count,
  };
}

// ── Writing one snapshot ─────────────────────────────────────────────────────────────────

async function putEvidence(deps: EngineDeps, orgId: string, sha: string, body: Buffer): Promise<string> {
  const storage = deps.storage;
  if (!storage) throw new StorageUnavailableError();
  const key = `evidence/${orgId}/${sha}.json`;
  // The intent row is committed before the put, so the object sweep can reconcile a put whose
  // object row never landed.
  await orgTx(deps.sql, orgId, (tx) => tx`
    INSERT INTO bastion_object_intents (organization_id, object_key) VALUES (${orgId}, ${key})
    ON CONFLICT (object_key) DO NOTHING`);
  try {
    await withStorageTimeout('put', storage.put(key, body, { contentType: 'application/json', size: body.length }), deps.putTimeoutMs);
  } catch (err) {
    throw new StorageUnavailableError(`Writing evidence to storage failed: ${(err as Error).message}`);
  }
  return key;
}

async function writeSnapshot(
  deps: EngineDeps,
  run: RunRow,
  a: PlannedAssertion,
  ev: Evaluated,
  highest: SealIdentity | null,
): Promise<void> {
  const doc = evidenceDocument(run, a, ev);
  const bytes = Buffer.from(canonicalJson(doc));
  const sha = sha256Hex(bytes);
  const key = await putEvidence(deps, run.organization_id, sha, bytes);
  const snapshotId = randomUUID();
  await orgTx(deps.sql, run.organization_id, async (tx) => {
    const [entry] = await appendLedger(
      tx,
      run.organization_id,
      [{ kind: 'snapshot', id: snapshotId, content_sha256: sha, personal_data_hmac: null, pd_hmac_key_id: null }],
      { highest, now: deps.now() },
    );
    await tx`
      INSERT INTO bastion_evidence_objects (organization_id, content_sha256, object_key, size_bytes, content_type, holder_count)
      VALUES (${run.organization_id}, ${sha}, ${key}, ${bytes.length}, 'application/json', 1)
      ON CONFLICT (organization_id, content_sha256) DO UPDATE SET holder_count = bastion_evidence_objects.holder_count + 1`;
    await tx`DELETE FROM bastion_object_intents WHERE object_key = ${key}`;
    await tx`
      INSERT INTO bastion_evidence_snapshots
        (id, organization_id, evaluation_run_id, assertion_id, control_id, outcome, unprovable_reason, probe_key,
         probe_version, params, query_fingerprint, population_checked, population_unlisted, window_start, window_end,
         summary, cited_refs, overflow_count, manual_evidence_ids, exception_ids, feed_record_count, replica_lag_ms,
         content_sha256, personal_data_hmac, pd_hmac_key_id, ledger_seq)
      VALUES (${snapshotId}, ${run.organization_id}, ${run.id}, ${a.id}, ${a.control_id}, ${ev.outcome},
              ${ev.unprovable_reason}, ${ev.probe_key}, ${ev.probe_version}, ${tx.json((a.params ?? {}) as never)},
              ${ev.query_fingerprint}, ${ev.population_checked ? tx.json(ev.population_checked as never) : null},
              ${ev.population_unlisted ? tx.json(ev.population_unlisted as never) : null}, ${ev.window_start}, ${ev.window_end},
              ${tx.json(doc.summary as never)}, ${tx.json(ev.cited_refs as never)}, ${ev.overflow_count},
              ${ev.manual_evidence_ids}::uuid[], '{}'::uuid[], ${ev.feed_record_count}, ${ev.replica_lag_ms},
              ${sha}, NULL, NULL, ${entry?.seq ?? null})`;
    await maybeAggregateControl(deps, tx, run, a.control_id);
  });
}

// ── Aggregating a control ────────────────────────────────────────────────────────────────

async function maybeAggregateControl(deps: EngineDeps, tx: Tx, run: RunRow, controlId: string): Promise<void> {
  const counts = await tx`
    SELECT (SELECT count(*) FROM bastion_assertions a
             WHERE a.organization_id = ${run.organization_id} AND a.control_id = ${controlId} AND a.review_status = 'confirmed')::int AS needed,
           (SELECT count(*) FROM bastion_evidence_snapshots s
              JOIN bastion_assertions a ON a.id = s.assertion_id AND a.organization_id = s.organization_id
             WHERE s.organization_id = ${run.organization_id} AND s.evaluation_run_id = ${run.id}
               AND s.control_id = ${controlId} AND a.review_status = 'confirmed')::int AS have`;
  const needed = Number(counts[0]?.needed ?? 0);
  const have = Number(counts[0]?.have ?? 0);
  if (needed === 0 || have < needed) return;
  await aggregateControl(deps, tx, run, controlId);
}

export async function aggregateControl(deps: EngineDeps, tx: Tx, run: RunRow, controlId: string): Promise<void> {
  const asOf = new Date(run.as_of);
  const control = (
    await tx`SELECT id, title, status, status_reason, consecutive_error_nights, last_error_night::text AS last_error_night,
                    last_evaluated_at
               FROM bastion_controls WHERE organization_id = ${run.organization_id} AND id = ${controlId} FOR UPDATE`
  )[0];
  if (!control) return;
  // Conditional write: an older as_of can never overwrite a newer evaluation (spec 7.3).
  if (control.last_evaluated_at && new Date(control.last_evaluated_at as string).getTime() >= asOf.getTime()) return;

  const snaps = (await tx`
    SELECT s.id, s.outcome, s.unprovable_reason, a.kind, a.manual_evidence_spec->>'kind' AS manual_kind
      FROM bastion_evidence_snapshots s
      JOIN bastion_assertions a ON a.id = s.assertion_id AND a.organization_id = s.organization_id
     WHERE s.organization_id = ${run.organization_id} AND s.evaluation_run_id = ${run.id} AND s.control_id = ${controlId}
       AND a.review_status = 'confirmed'
     ORDER BY s.created_at, s.id`) as unknown as Array<{
    id: string;
    outcome: 'pass' | 'fail' | 'unprovable';
    unprovable_reason: string | null;
    kind: 'probe' | 'manual' | 'feed';
    manual_kind: string | null;
  }>;
  const agg = aggregateStored(snaps);
  const coverage = coverageKindOf(
    snaps.map((s) => (s.kind === 'manual' && s.manual_kind === 'attestation_statement' ? 'self_attested' : s.kind)),
  );
  const from = control.status as 'pass' | 'fail' | 'unprovable';

  if (agg.infra) {
    const d = infraDecision(
      {
        status: from,
        status_reason: control.status_reason as string | null,
        consecutive_error_nights: Number(control.consecutive_error_nights),
        last_error_night: control.last_error_night as string | null,
      },
      run.trigger === 'nightly' ? run.nightly_for_date : null,
    );
    // Before the second distinct night the stored status and last_evaluated_at are kept, so the
    // control reads "hasn't been checked since {date}" once it goes stale, never a false drift.
    const settled = d.consecutive_error_nights >= 2;
    await tx`
      UPDATE bastion_controls
         SET status = ${d.status}, status_reason = ${d.status_reason}, stale_reason = 'probe_error',
             consecutive_error_nights = ${d.consecutive_error_nights}, last_error_night = ${d.last_error_night}::date,
             last_evaluated_at = CASE WHEN ${settled} THEN ${asOf}::timestamptz ELSE last_evaluated_at END,
             status_changed_at = CASE WHEN ${d.status_changed} THEN ${asOf}::timestamptz ELSE status_changed_at END,
             coverage_kind = ${coverage}
       WHERE organization_id = ${run.organization_id} AND id = ${controlId}`;
    return;
  }

  const to = agg.status;
  await tx`
    UPDATE bastion_controls
       SET status = ${to}, status_reason = ${agg.reason}, stale_reason = NULL, consecutive_error_nights = 0,
           last_error_night = NULL, last_evaluated_at = ${asOf},
           status_changed_at = CASE WHEN status IS DISTINCT FROM ${to} OR status_reason IS DISTINCT FROM ${agg.reason}
                                    THEN ${asOf}::timestamptz ELSE status_changed_at END,
           coverage_kind = ${coverage}
     WHERE organization_id = ${run.organization_id} AND id = ${controlId}`;

  if (isWorsening(from, to)) {
    const settings = (await tx`SELECT compliance_project_id, remediation_tasks FROM bastion_org_settings
                                 WHERE organization_id = ${run.organization_id}`)[0];
    const taskStatus = !settings?.compliance_project_id ? 'no_project' : settings.remediation_tasks === 'propose' ? 'proposed' : 'pending';
    const firstBad = snaps.find((s) => s.outcome === to);
    const reason = to === 'fail' ? 'failed' : (agg.reason ?? 'unprovable');
    const inserted = await tx`
      INSERT INTO bastion_drift_events (organization_id, control_id, evaluation_run_id, from_status, to_status, reason, snapshot_id, task_status, detected_at)
      VALUES (${run.organization_id}, ${controlId}, ${run.id}, ${from}, ${to}, ${reason}, ${firstBad?.id ?? null}, ${taskStatus}, ${deps.now()})
      ON CONFLICT (organization_id, evaluation_run_id, control_id) DO NOTHING
      RETURNING id`;
    const driftId = inserted[0]?.id as string | undefined;
    if (driftId) {
      await enqueueBastionEvent(
        'control.drifted',
        { control_id: controlId, drift_id: driftId, run_id: run.id, from_status: from, to_status: to, reason },
        tx,
        { orgId: run.organization_id, idempotencyKey: `control.drifted:${driftId}`, orderingKey: `control:${controlId}` },
      );
    }
  } else if (to === 'pass' && from !== 'pass' && control.status_reason !== 'not_yet_confirmed') {
    await enqueueBastionEvent(
      'control.recovered',
      { control_id: controlId, run_id: run.id, from_status: from },
      tx,
      { orgId: run.organization_id, idempotencyKey: `control.recovered:${run.id}:${controlId}`, orderingKey: `control:${controlId}` },
    );
  }
}

// ── The slice ────────────────────────────────────────────────────────────────────────────

async function orgLabel(deps: EngineDeps, orgId: string): Promise<string> {
  const rows = await deps.sql`SELECT name FROM organizations WHERE id = ${orgId}`;
  return String(rows[0]?.name ?? orgId);
}

export async function runEvaluationSlice(
  deps: EngineDeps,
  input: { organization_id: string; run_id: string; claimant: string },
): Promise<SliceResult> {
  const started = Date.now();
  const { organization_id: orgId, run_id: runId, claimant } = input;
  const run = await claimRun(deps, orgId, runId, claimant);
  if (!run) {
    const cur = await loadRun(deps, orgId, runId);
    if (!cur) throw new RunNotFoundError();
    if (cur.status === 'succeeded' || cur.status === 'partial' || cur.status === 'failed') {
      return {
        done: true,
        status: cur.status,
        partial_reason: cur.partial_reason,
        assertions_done: 0,
        assertions_total: 0,
        controls_done: 0,
        controls_total: cur.controls_total,
        pass: 0,
        fail: 0,
        unprovable: 0,
        slice_ms: Date.now() - started,
      };
    }
    const stale = !cur.heartbeat_at || Date.now() - new Date(cur.heartbeat_at).getTime() > STALE_HEARTBEAT_MS;
    throw new RunLeaseHeldError(cur.claimed_by, stale);
  }

  const label = await orgLabel(deps, orgId);
  let lastTotal = 0;

  /**
   * End the slice. `end` finishes the run (succeeded or partial); `continue` leaves it running so
   * the worker polls again (time budget reached, or a transient bucket / lock problem: the run is
   * resumable and nothing half-written is left behind).
   */
  const finish = async (
    mode: { end: 'succeeded' | 'partial'; reason: string | null } | { continue: true; waiting?: SliceResult['waiting'] },
  ): Promise<SliceResult> => {
    const ending = 'end' in mode;
    if (ending) await endRun(deps, run, claimant, mode.end, mode.reason);
    const counts = await orgTx(deps.sql, orgId, async (tx) => {
      const c = await runCounts(tx, run);
      await tx`
        UPDATE bastion_evaluation_runs SET controls_done = ${c.controls_done}, pass_count = ${c.pass},
               fail_count = ${c.fail}, unprovable_count = ${c.unprovable}
         WHERE id = ${run.id} AND organization_id = ${orgId}`;
      return c;
    });
    const waiting = ending ? undefined : mode.waiting;
    const result: SliceResult = {
      done: ending,
      status: ending ? mode.end : 'running',
      partial_reason: ending ? mode.reason : null,
      assertions_done: counts.assertions_done,
      assertions_total: lastTotal,
      controls_done: counts.controls_done,
      controls_total: run.controls_total,
      pass: counts.pass,
      fail: counts.fail,
      unprovable: counts.unprovable,
      slice_ms: Date.now() - started,
      waiting,
    };
    deps.log.info(
      { run_id: run.id, organization_id: orgId, status: result.status, partial_reason: result.partial_reason, waiting },
      `bastion-evaluate: org '${label}' controls ${counts.controls_done}/${run.controls_total} assertions ${counts.assertions_done}/${lastTotal} (pass ${counts.pass}, fail ${counts.fail}, unprovable ${counts.unprovable}) slice_ms=${result.slice_ms} resume=${run.resume_count} status=${result.status}${result.partial_reason ? ` reason=${result.partial_reason}` : ''}${waiting ? ` waiting=${waiting}` : ''}`,
    );
    return result;
  };

  if (!deps.storage) return finish({ end: 'partial', reason: 'storage_unavailable' });

  let highest: SealIdentity | null = null;
  try {
    const ident = await checkLedgerIdentity(deps, orgId);
    if (ident.blockedBy) return finish({ end: 'partial', reason: 'restore_pending' });
    highest = ident.highest;
  } catch (err) {
    if (err instanceof StorageUnavailableError) return finish({ continue: true, waiting: 'storage' });
    throw err;
  }

  const planned = await orgTx(deps.sql, orgId, (tx) => plan(tx, run));
  lastTotal = planned.total;
  if (run.controls_total !== planned.controlsTotal) {
    run.controls_total = planned.controlsTotal;
    await orgTx(deps.sql, orgId, (tx) => tx`
      UPDATE bastion_evaluation_runs SET controls_total = ${planned.controlsTotal}
       WHERE id = ${run.id} AND organization_id = ${orgId} AND claimed_by = ${claimant}`);
  }

  for (const a of planned.pending) {
    // Stop STARTING probes at the cutoff: worst case 12 + probe 8 + put 5 + lock 3 < 30 s.
    if (Date.now() - started >= SLICE_START_CUTOFF_MS) return finish({ continue: true });
    const ev = await evaluateAssertion(deps, run, a);
    // A probe can come back late when it waited for an engine connection (that wait is outside
    // the statement timeout). Writing it now could outrun the worker's engine timeout, so it is
    // dropped and re-run in the next slice (issue #201).
    if (Date.now() - started >= SLICE_WRITE_CUTOFF_MS) {
      deps.log.warn(
        { run_id: run.id, assertion_id: a.id, elapsed_ms: Date.now() - started },
        'bastion-evaluate: a check finished past the write cutoff (likely a connection wait); re-running it next slice',
      );
      return finish({ continue: true });
    }
    if (ev.error) deps.log.warn({ run_id: run.id, assertion_id: a.id, probe_key: ev.probe_key, error: ev.error }, 'bastion-evaluate: a check could not run');
    try {
      await writeSnapshot(deps, run, a, ev, highest);
    } catch (err) {
      if (err instanceof AppendBlockedError || err instanceof RestoreDetectedError) {
        return finish({ end: 'partial', reason: 'restore_pending' });
      }
      if (err instanceof StorageUnavailableError) return finish({ continue: true, waiting: 'storage' });
      if (err instanceof LedgerLockTimeoutError) return finish({ continue: true, waiting: 'ledger_lock' });
      if (sqlstateOf(err) === '23505') continue; // a concurrent slice wrote this snapshot first
      throw err;
    }
    if (!(await heartbeat(deps, run, claimant))) {
      deps.log.warn({ run_id: run.id, claimant }, 'bastion-evaluate: lost the claim mid-slice; stopping');
      throw new RunLeaseHeldError(null, false);
    }
  }
  return finish({ end: 'succeeded', reason: null });
}

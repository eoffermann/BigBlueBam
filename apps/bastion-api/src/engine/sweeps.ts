// The scheduled engines the worker's thin jobs call (spec 7). Each processes orgs one at a
// time, each org in its own transaction(s), so no single org's conflict can abort the batch
// (spec 7.3, #187). Every one logs a start line and per-org progress through deps.log.

import { BASTION_DAY_MS, type BastionEvaluateTickResult, type BastionTickRun } from '@bigbluebam/shared';
import { compareEpochSeq, signSeal, verifyChain, verifySeal, type LedgerRow, type SealPayload } from '../lib/ledger-canonical.js';
import { MAX_RESUMES, ORPHAN_REQUEUE_AFTER_MS } from './budgets.js';
import { type EngineDeps, localClock, orgTx, sqlstateOf, utcDate } from './context.js';
import { enqueueBastionEvent, enqueueOutbox } from './outbox.js';
import { checkLedgerIdentity, sealObjectKey, type SealIdentity, StorageUnavailableError, writeRestoreObject } from './restore.js';
import { loadReadinessNumbers } from './numbers.js';
import { orphanedCompileRuns, reapCompileRuns } from '../services/compile-ai.service.js';

interface OrgRow {
  organization_id: string;
  name: string;
  timezone: string;
  evaluation_hour_local: number;
  evaluation_minute_offset: number;
}

/** Orgs Bastion evaluates: a settings row and at least one live framework. */
async function bastionOrgs(deps: EngineDeps, only?: string): Promise<OrgRow[]> {
  const rows = await deps.sql`
    SELECT s.organization_id, o.name, s.timezone, s.evaluation_hour_local, s.evaluation_minute_offset
      FROM bastion_org_settings s
      JOIN organizations o ON o.id = s.organization_id
     WHERE EXISTS (SELECT 1 FROM bastion_frameworks f WHERE f.organization_id = s.organization_id AND f.status <> 'archived')
       ${only ? deps.sql`AND s.organization_id = ${only}` : deps.sql``}
     ORDER BY s.organization_id`;
  return rows as unknown as OrgRow[];
}

// ── evaluate-tick ────────────────────────────────────────────────────────────────────────

/** The shared response contract the worker parses (issue #205). */
export type RunToEnqueue = BastionTickRun;

/** Is the nightly slot for this org due at `now`? Pure; tested. */
export function nightlyDue(now: Date, org: Pick<OrgRow, 'timezone' | 'evaluation_hour_local' | 'evaluation_minute_offset'>) {
  const clock = localClock(now, org.timezone || 'UTC');
  const slot = org.evaluation_hour_local * 60 + org.evaluation_minute_offset;
  return { due: clock.minutes >= slot, nightly_for_date: clock.date };
}

/**
 * Claims due nightly runs (INSERT ... ON CONFLICT DO NOTHING with no conflict target, so the
 * one-full-run and one-nightly-per-date indexes are both absorbed); resumes today's `partial`
 * nightly run in place ONLY through bastion_resume_partial_run (0283, #187), which returns false
 * instead of raising while a full run is live or a restore is unresolved; and re-enqueues every
 * `queued` run idle for more than two minutes, so a released run is never orphaned.
 */
export async function evaluateTick(deps: EngineDeps, opts: { organization_id?: string } = {}) {
  const now = deps.now();
  const out: RunToEnqueue[] = [];
  const orgs = await bastionOrgs(deps, opts.organization_id);
  deps.log.info({ orgs: orgs.length }, `bastion-evaluate-tick: checking ${orgs.length} organizations`);
  for (const org of orgs) {
    const { due, nightly_for_date } = nightlyDue(now, org);
    if (!due) continue;
    try {
      await orgTx(deps.sql, org.organization_id, async (tx) => {
        const created = await tx`
          INSERT INTO bastion_evaluation_runs (organization_id, trigger, scope, nightly_for_date, as_of, status)
          VALUES (${org.organization_id}, 'nightly', 'all', ${nightly_for_date}::date, ${now}, 'queued')
          ON CONFLICT DO NOTHING
          RETURNING id, resume_count`;
        if (created[0]) {
          out.push({ organization_id: org.organization_id, run_id: created[0].id as string, resume_count: 0, generation: 0, why: 'nightly_created' });
          return;
        }
        const partial = await tx`
          SELECT id FROM bastion_evaluation_runs
           WHERE organization_id = ${org.organization_id} AND trigger = 'nightly'
             AND nightly_for_date = ${nightly_for_date}::date AND status = 'partial'`;
        if (partial[0]) {
          const resumed = await tx`SELECT bastion_resume_partial_run(${partial[0].id as string}) AS ok`;
          if (resumed[0]?.ok) {
            const r = await tx`SELECT resume_count FROM bastion_evaluation_runs WHERE id = ${partial[0].id as string}`;
            out.push({ organization_id: org.organization_id, run_id: partial[0].id as string, resume_count: Number(r[0]?.resume_count ?? 0), generation: 0, why: 'nightly_resumed' });
          }
        }
      });
    } catch (err) {
      deps.log.warn({ organization_id: org.organization_id, err: (err as Error).message, sqlstate: sqlstateOf(err) }, 'bastion-evaluate-tick: skipped one organization this tick');
    }
  }
  const idle = await deps.sql`
    SELECT id, organization_id, resume_count FROM bastion_evaluation_runs
     WHERE status = 'queued' AND updated_at < ${new Date(now.getTime() - ORPHAN_REQUEUE_AFTER_MS)}
       ${opts.organization_id ? deps.sql`AND organization_id = ${opts.organization_id}` : deps.sql``}
     ORDER BY updated_at LIMIT 200`;
  const generation = Math.floor(now.getTime() / ORPHAN_REQUEUE_AFTER_MS);
  for (const r of idle) {
    if (out.some((o) => o.run_id === r.id)) continue;
    out.push({ organization_id: r.organization_id as string, run_id: r.id as string, resume_count: Number(r.resume_count), generation, why: 'orphan_requeue' });
  }
  // M7: queued AI compile runs nobody picked up (a dropped enqueue, or a run released by a deploy)
  // go back to the bastion-compile queue under a generation-stamped job id (spec 7 orphan rule).
  const compileRuns = (await orphanedCompileRuns(deps, new Date(now.getTime() - ORPHAN_REQUEUE_AFTER_MS), opts.organization_id)).map((r) => ({
    ...r,
    generation,
  }));
  deps.log.info({ enqueue: out.length, compile: compileRuns.length }, `bastion-evaluate-tick: ${out.length} runs and ${compileRuns.length} compile runs to drive`);
  const result: BastionEvaluateTickResult = { runs: out, compile_runs: compileRuns };
  return result;
}

// ── run-reaper ───────────────────────────────────────────────────────────────────────────

/**
 * Releases claims whose heartbeat exceeded the lease: back to `queued` with resume_count + 1 on
 * every release, up to MAX_RESUMES; only then `partial` (lease_expired).
 */
export async function runReaper(deps: EngineDeps, opts: { organization_id?: string } = {}) {
  const cutoff = new Date(deps.now().getTime() - deps.leaseMs);
  const released = await deps.sql`
    UPDATE bastion_evaluation_runs
       SET status = 'queued', claimed_by = NULL, heartbeat_at = NULL, resume_count = resume_count + 1
     WHERE status = 'running' AND (heartbeat_at IS NULL OR heartbeat_at < ${cutoff}) AND resume_count < ${MAX_RESUMES}
       ${opts.organization_id ? deps.sql`AND organization_id = ${opts.organization_id}` : deps.sql``}
    RETURNING id, organization_id, resume_count`;
  const parked = await deps.sql`
    UPDATE bastion_evaluation_runs
       SET status = 'partial', partial_reason = 'lease_expired', claimed_by = NULL
     WHERE status = 'running' AND (heartbeat_at IS NULL OR heartbeat_at < ${cutoff}) AND resume_count >= ${MAX_RESUMES}
       ${opts.organization_id ? deps.sql`AND organization_id = ${opts.organization_id}` : deps.sql``}
    RETURNING id`;
  // Inline (in-request) compile runs are never resumed by a worker, so an expired one is marked
  // `failed`, never released to `queued`: a queued row would hold the one-active slot forever
  // (issue #193). The compile itself is one transaction now, so only a run left by an earlier
  // build can be here.
  const inlineFailed = await deps.sql`
    UPDATE bastion_compile_runs
       SET status = 'failed', completed_at = ${deps.now()},
           error = 'This setup run stopped before it finished (the server restarted or lost its connection), so it was released.'
     WHERE claimed_by = 'bastion-api:inline' AND status IN ('queued', 'running')
       AND (heartbeat_at IS NULL OR heartbeat_at < ${cutoff})
       ${opts.organization_id ? deps.sql`AND organization_id = ${opts.organization_id}` : deps.sql``}
    RETURNING id`;
  // M7: worker-driven AI compile runs follow the evaluation rule (released, then parked).
  const compiles = await reapCompileRuns(deps, cutoff, opts.organization_id);
  deps.log.info(
    { released: released.length, parked: parked.length, inline_compiles_failed: inlineFailed.length, compiles },
    `bastion-run-reaper: released ${released.length}, parked ${parked.length}, failed ${inlineFailed.length} stale inline compile runs; compile runs released ${compiles.released}, parked ${compiles.parked}`,
  );
  return {
    released: released.map((r) => ({ run_id: r.id as string, organization_id: r.organization_id as string, resume_count: Number(r.resume_count) })),
    parked: parked.length,
    inline_compiles_failed: inlineFailed.length,
    compile_runs_released: compiles.released,
    compile_runs_parked: compiles.parked,
  };
}

// ── ledger-seal ──────────────────────────────────────────────────────────────────────────

export type SealOutcome =
  | { organization_id: string; result: 'sealed'; seal_date: string; epoch: number; head_seq: number }
  | { organization_id: string; result: 'already_sealed' | 'empty' | 'blocked' | 'storage_unavailable' }
  | { organization_id: string; result: 'refused_below_bucket_seal'; head: { epoch: number; seq: number }; bucket: { epoch: number; seq: number } };

/** Seal one org. Refuses to sign a head below the highest bucket-sealed (epoch, head_seq). */
export async function sealOrg(deps: EngineDeps, orgId: string): Promise<SealOutcome> {
  let highest: SealIdentity | null = null;
  try {
    const ident = await checkLedgerIdentity(deps, orgId);
    highest = ident.highest;
    // Retry any restore record object that could not be written when it was detected.
    const missing = await orgTx(deps.sql, orgId, (tx) => tx`
      SELECT id FROM bastion_ledger_restores WHERE organization_id = ${orgId} AND object_key IS NULL`);
    for (const m of missing) await writeRestoreObject(deps, orgId, m.id as string);
  } catch (err) {
    if (err instanceof StorageUnavailableError) return { organization_id: orgId, result: 'storage_unavailable' };
    throw err;
  }
  const now = deps.now();
  const sealDate = utcDate(now);
  return orgTx(deps.sql, orgId, async (tx) => {
    const head = (
      await tx`SELECT epoch, seq, entry_hash FROM bastion_ledger_entries WHERE organization_id = ${orgId} ORDER BY seq DESC LIMIT 1`
    )[0];
    if (!head) return { organization_id: orgId, result: 'empty' } as const;
    const headId = { epoch: Number(head.epoch), seq: Number(head.seq) };
    if (highest && compareEpochSeq(headId, { epoch: highest.epoch, seq: highest.head_seq }) < 0) {
      deps.log.error(
        { organization_id: orgId, head: headId, bucket: { epoch: highest.epoch, seq: highest.head_seq } },
        'bastion-ledger-seal: refusing to seal a head below the highest bucket seal',
      );
      return { organization_id: orgId, result: 'refused_below_bucket_seal', head: headId, bucket: { epoch: highest.epoch, seq: highest.head_seq } } as const;
    }
    const payload: SealPayload = {
      org: orgId,
      seal_date: sealDate,
      epoch: headId.epoch,
      head_seq: headId.seq,
      head_hash: head.entry_hash as string,
      signing_key_id: deps.signer.keyId,
    };
    const signature = signSeal(payload, deps.signer);
    const inserted = await tx`
      INSERT INTO bastion_ledger_seals (organization_id, seal_date, epoch, head_seq, head_hash, signature, signing_key_id)
      VALUES (${orgId}, ${sealDate}::date, ${payload.epoch}, ${payload.head_seq}, ${payload.head_hash}, ${signature}, ${payload.signing_key_id})
      ON CONFLICT (organization_id, seal_date) DO NOTHING
      RETURNING seal_date`;
    if (inserted.length === 0) return { organization_id: orgId, result: 'already_sealed' } as const;
    const key = sealObjectKey(orgId, sealDate);
    await enqueueOutbox(tx, {
      orgId,
      kind: 'seal_object',
      orderingKey: `seal:${orgId}`,
      idempotencyKey: `seal_object:${orgId}:${sealDate}`,
      payload: {
        object_key: key,
        seal_date: sealDate,
        seal: { ...payload, signature, public_key_hex: deps.signer.publicKeyHex, sealed_at: now.toISOString() },
      },
    });
    await enqueueBastionEvent(
      'ledger.sealed',
      { seal_date: sealDate, epoch: payload.epoch, head_seq: payload.head_seq, signing_key_id: payload.signing_key_id },
      tx,
      { orgId, idempotencyKey: `ledger.sealed:${orgId}:${sealDate}`, orderingKey: `seal:${orgId}` },
    );
    return { organization_id: orgId, result: 'sealed', seal_date: sealDate, epoch: payload.epoch, head_seq: payload.head_seq } as const;
  });
}

export async function ledgerSeal(deps: EngineDeps, opts: { organization_id?: string } = {}) {
  const orgs = await bastionOrgs(deps, opts.organization_id);
  const results: SealOutcome[] = [];
  for (const [i, org] of orgs.entries()) {
    try {
      results.push(await sealOrg(deps, org.organization_id));
    } catch (err) {
      deps.log.error({ organization_id: org.organization_id, err: (err as Error).message }, 'bastion-ledger-seal: sealing failed for one organization');
    }
    deps.log.info({}, `bastion-ledger-seal: checked ${i + 1}/${orgs.length}`);
  }
  return { results };
}

// ── ledger-verify ────────────────────────────────────────────────────────────────────────

const VERIFY_BUDGET_ROWS = 20_000;

/** Budgeted re-hash with a resume cursor; seal signatures re-verified with every published key. */
export async function ledgerVerify(deps: EngineDeps, keys: Map<string, string>, opts: { organization_id?: string } = {}) {
  const orgs = await bastionOrgs(deps, opts.organization_id);
  const out: Array<{ organization_id: string; checked: number; problems: number; bad_seals: number; complete: boolean }> = [];
  for (const org of orgs) {
    const cursorKey = `bastion:ledger-verify:${org.organization_id}`;
    const from = Number((await deps.cursors.get(cursorKey)) ?? '0');
    const res = await orgTx(deps.sql, org.organization_id, async (tx) => {
      const prevRow = from > 0
        ? (await tx`SELECT entry_hash FROM bastion_ledger_entries WHERE organization_id = ${org.organization_id} AND seq = ${from}`)[0]
        : undefined;
      const rows = (await tx`
        SELECT organization_id, epoch, seq, entry_kind, entry_id, content_sha256, personal_data_hmac, pd_hmac_key_id,
               prev_entry_hash, entry_hash, recorded_at
          FROM bastion_ledger_entries WHERE organization_id = ${org.organization_id} AND seq > ${from}
         ORDER BY seq LIMIT ${VERIFY_BUDGET_ROWS}`) as unknown as LedgerRow[];
      const problems = verifyChain(rows, prevRow ? (prevRow.entry_hash as string) : undefined);
      const seals = await tx`SELECT seal_date::text AS seal_date, epoch, head_seq, head_hash, signature, signing_key_id
                               FROM bastion_ledger_seals WHERE organization_id = ${org.organization_id}`;
      let badSeals = 0;
      for (const s of seals) {
        const ok = verifySeal(
          { org: org.organization_id, seal_date: s.seal_date as string, epoch: Number(s.epoch), head_seq: Number(s.head_seq), head_hash: s.head_hash as string, signing_key_id: s.signing_key_id as string },
          s.signature as string,
          keys,
        );
        if (!ok) badSeals += 1;
      }
      for (const p of problems) {
        await enqueueBastionEvent('evidence.integrity_failed', { seq: p.seq, cause: p.problem }, tx, {
          orgId: org.organization_id,
          idempotencyKey: `evidence.integrity_failed:chain:${org.organization_id}:${p.seq}:${p.problem}`,
        });
      }
      const last = rows.length > 0 ? Number(rows[rows.length - 1]?.seq) : from;
      return { checked: rows.length, problems: problems.length, badSeals, last, complete: rows.length < VERIFY_BUDGET_ROWS };
    });
    await deps.cursors.set(cursorKey, res.complete ? '0' : String(res.last));
    deps.log.info(
      { organization_id: org.organization_id, ...res },
      `bastion-ledger-verify: org '${org.name}' checked ${res.checked} entries, ${res.problems} problems, ${res.badSeals} bad seals, budget remaining ${VERIFY_BUDGET_ROWS - res.checked}`,
    );
    out.push({ organization_id: org.organization_id, checked: res.checked, problems: res.problems, bad_seals: res.badSeals, complete: res.complete });
  }
  return { orgs: out };
}

// ── evaluation-missed ────────────────────────────────────────────────────────────────────

const MISSED_AFTER_MS = 26 * 3_600_000;

/** Once per org per missed period: keyed `evaluation_missed:<org>:<last_completed_at>`. */
export async function evaluationMissed(deps: EngineDeps, opts: { organization_id?: string } = {}) {
  const now = deps.now();
  const orgs = await bastionOrgs(deps, opts.organization_id);
  let fired = 0;
  for (const org of orgs) {
    await orgTx(deps.sql, org.organization_id, async (tx) => {
      const r = (
        await tx`SELECT max(completed_at) AS last FROM bastion_evaluation_runs
                  WHERE organization_id = ${org.organization_id} AND status = 'succeeded' AND scope = 'all'`
      )[0];
      const adopted = (
        await tx`SELECT min(coalesce(adopted_at, created_at)) AS at FROM bastion_frameworks
                  WHERE organization_id = ${org.organization_id} AND status <> 'archived'`
      )[0];
      const last = r?.last ? new Date(r.last as string) : null;
      const since = last ?? (adopted?.at ? new Date(adopted.at as string) : null);
      if (!since || now.getTime() - since.getTime() <= MISSED_AFTER_MS) return;
      const stamp = last ? last.toISOString() : 'never';
      const inserted = await enqueueBastionEvent(
        'evaluation.missed',
        { last_completed_at: last ? last.toISOString() : null, hours_since: Math.floor((now.getTime() - since.getTime()) / 3_600_000) },
        tx,
        { orgId: org.organization_id, idempotencyKey: `evaluation_missed:${org.organization_id}:${stamp}` },
      );
      if (inserted) fired += 1;
    });
  }
  deps.log.info({ fired }, `bastion-evaluation-missed: ${fired} organizations missed their nightly check`);
  return { fired };
}

// ── weekly-readiness ─────────────────────────────────────────────────────────────────────

export async function weeklyReadiness(deps: EngineDeps, opts: { organization_id?: string } = {}) {
  const now = deps.now();
  const week = utcDate(now);
  const orgs = await bastionOrgs(deps, opts.organization_id);
  let sent = 0;
  for (const org of orgs) {
    await orgTx(deps.sql, org.organization_id, async (tx) => {
      const n = await loadReadinessNumbers(tx, org.organization_id, now);
      const inserted = await enqueueBastionEvent('readiness.weekly', { ...n, week_of: week }, tx, {
        orgId: org.organization_id,
        idempotencyKey: `readiness.weekly:${org.organization_id}:${week}`,
      });
      if (inserted) sent += 1;
    });
  }
  deps.log.info({ sent }, `bastion-weekly-readiness: queued ${sent} weekly summaries`);
  return { sent };
}

// ── retention ────────────────────────────────────────────────────────────────────────────

const DAY_MS = BASTION_DAY_MS;
/** Delivered / superseded outbox rows and finished inbox rows. */
export const RETENTION_DONE_DAYS = 30;
/**
 * Inbox rows nothing consumed (status pending, issue #206). Until the M5/M6 processors exist
 * nothing claims them; afterwards a row this old is far past any reconcile window (the M6
 * proposal reconcile re-reads agent_proposals, feeds report staleness through feed.fresh).
 */
export const RETENTION_UNCONSUMED_INBOX_DAYS = 30;
/** Dead outbox rows: kept well past an operator's re-drive and audit window, then pruned. */
export const RETENTION_DEAD_OUTBOX_DAYS = 90;
const RETENTION_BATCH = 5_000;

/** Delete in bounded batches with a progress line per batch, so a large backlog never stalls silently. */
async function pruneInBatches(
  deps: EngineDeps,
  label: string,
  batch: () => PromiseLike<ArrayLike<unknown>>,
): Promise<number> {
  let total = 0;
  for (let i = 0; i < 10_000; i++) {
    const n = (await batch()).length;
    total += n;
    if (n > 0) deps.log.info({ phase: label, batch: n, total }, `bastion-retention: ${label}: pruned ${total} so far`);
    if (n < RETENTION_BATCH) break;
  }
  return total;
}

export async function retention(deps: EngineDeps, opts: { organization_id?: string } = {}) {
  const now = deps.now().getTime();
  const doneCutoff = new Date(now - RETENTION_DONE_DAYS * DAY_MS);
  const unconsumedCutoff = new Date(now - RETENTION_UNCONSUMED_INBOX_DAYS * DAY_MS);
  const deadCutoff = new Date(now - RETENTION_DEAD_OUTBOX_DAYS * DAY_MS);
  const orgFilter = () => (opts.organization_id ? deps.sql`AND organization_id = ${opts.organization_id}` : deps.sql``);
  deps.log.info({ organization_id: opts.organization_id ?? null }, 'bastion-retention: starting (outbox, inbox, access log)');

  const outbox = await pruneInBatches(deps, 'outbox delivered/superseded', () => deps.sql`
    DELETE FROM bastion_outbox WHERE id IN (
      SELECT id FROM bastion_outbox
       WHERE status IN ('delivered', 'superseded') AND coalesce(delivered_at, created_at) < ${doneCutoff} ${orgFilter()}
       LIMIT ${RETENTION_BATCH})
    RETURNING id`);
  const outboxDead = await pruneInBatches(deps, 'outbox dead', () => deps.sql`
    DELETE FROM bastion_outbox WHERE id IN (
      SELECT id FROM bastion_outbox
       WHERE status = 'dead' AND created_at < ${deadCutoff} ${orgFilter()}
       LIMIT ${RETENTION_BATCH})
    RETURNING id`);
  const ingest = await pruneInBatches(deps, 'inbox done/failed/dead', () => deps.sql`
    DELETE FROM bastion_ingest_events WHERE id IN (
      SELECT id FROM bastion_ingest_events
       WHERE status IN ('done', 'failed', 'dead') AND updated_at < ${doneCutoff} ${orgFilter()}
       LIMIT ${RETENTION_BATCH})
    RETURNING id`);
  const ingestUnconsumed = await pruneInBatches(deps, 'inbox unconsumed', () => deps.sql`
    DELETE FROM bastion_ingest_events WHERE id IN (
      SELECT id FROM bastion_ingest_events
       WHERE status = 'pending' AND created_at < ${unconsumedCutoff} ${orgFilter()}
       LIMIT ${RETENTION_BATCH})
    RETURNING id`);

  const orgs = await bastionOrgs(deps, opts.organization_id);
  let purged = 0;
  for (const [i, org] of orgs.entries()) {
    const r = await orgTx(deps.sql, org.organization_id, (tx) => tx`SELECT bastion_purge_access_log(${org.organization_id}::uuid) AS n`);
    purged += Number(r[0]?.n ?? 0);
    deps.log.info({ organization_id: org.organization_id }, `bastion-retention: access log ${i + 1}/${orgs.length}`);
  }
  const out = {
    outbox_pruned: outbox,
    outbox_dead_pruned: outboxDead,
    ingest_pruned: ingest,
    ingest_unconsumed_pruned: ingestUnconsumed,
    access_log_purged: purged,
  };
  deps.log.info(out, 'bastion-retention: pruned');
  return out;
}

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { bastionEvaluateRunSliceSchema, bastionEvaluateTickResultSchema } from '@bigbluebam/shared';
import type { EngineDeps } from '../../src/engine/context.js';
import { runEvaluationSlice } from '../../src/engine/evaluator.js';
import { drainOutbox, enqueueOutbox, OUTBOX_MAX_ATTEMPTS, type Deliverer } from '../../src/engine/outbox.js';
import { evaluateTick, runReaper } from '../../src/engine/sweeps.js';
import { clock, DATABASE_URL, fakeBucket, makeDeps, seedOrg, wipeOrg } from './engine-harness.js';

/**
 * M4 run-lifecycle gates against a real migrated database and the real engine (spec 7.3, 11.2):
 *
 *   kill mid-slice: a worker claims tonight's run, writes one snapshot and dies holding the claim;
 *   the reaper releases it after the lease (resume_count + 1), the tick re-enqueues the idle queued
 *   run, a second worker completes it without redoing the written snapshot, and the next night's
 *   run is still created;
 *   resume against a live full run (#187): a partial nightly run is resumed in place only through
 *   bastion_resume_partial_run, and the tick neither raises nor resumes while a manual full run is
 *   queued;
 *   outbox ordering: only the oldest pending row per ordering_key is delivered, a backing-off row
 *   blocks its key, and a dead row stops blocking it.
 *
 * SKIPS LOUDLY without DATABASE_URL.
 */

if (!DATABASE_URL) {
  console.warn('[bastion-api/m4-runs] SKIPPING: DATABASE_URL is not set. Point it at a migrated database.');
}

vi.setConfig({ testTimeout: 180_000, hookTimeout: 60_000 });

const MIN = 60_000;

describe.skipIf(!DATABASE_URL)('M4 evaluation runs and the outbox (live database)', () => {
  let sql: postgres.Sql;
  const orgs: string[] = [];

  beforeAll(() => {
    sql = postgres(DATABASE_URL!, { max: 4, onnotice: () => {} });
  });

  afterAll(async () => {
    if (!sql) return;
    for (const org of orgs) await wipeOrg(sql, org);
    await sql.end();
  });

  async function drive(deps: EngineDeps, org: string, runId: string, claimant: string) {
    let last;
    for (let i = 0; i < 30; i++) {
      last = await runEvaluationSlice(deps, { organization_id: org, run_id: runId, claimant });
      if (last.done) break;
    }
    return last!;
  }

  it('kill mid-slice: reaper releases, tick re-enqueues, the run completes, and the next night is created', async () => {
    const s = await seedOrg(sql, 'kill', 2, 2);
    orgs.push(s.org);
    const c = clock();
    const deps = makeDeps(sql, { clock: c });

    // Tonight's run (slot 00:00 UTC, so it is due now).
    const t0 = await evaluateTick(deps, { organization_id: s.org });
    expect(t0.runs).toHaveLength(1);
    expect(t0.runs[0]).toMatchObject({ why: 'nightly_created', resume_count: 0 });
    const runId = t0.runs[0]!.run_id;

    // Worker A writes one snapshot, then the bucket stops answering and A dies holding the claim.
    const flaky = fakeBucket();
    let puts = 0;
    const realPut = flaky.put.bind(flaky);
    flaky.put = async (k, b, o) => {
      puts += 1;
      if (puts > 1) throw new Error('worker A was killed');
      return realPut(k, b, o);
    };
    const depsA = makeDeps(sql, { clock: c, bucket: flaky });
    const a = await runEvaluationSlice(depsA, { organization_id: s.org, run_id: runId, claimant: 'worker:A' });
    expect(a).toMatchObject({ done: false, waiting: 'storage', assertions_done: 1, assertions_total: 4 });
    const [held] = await sql`SELECT status, claimed_by FROM bastion_evaluation_runs WHERE id = ${runId}`;
    expect(held).toMatchObject({ status: 'running', claimed_by: 'worker:A' });

    // While A's lease is live, another worker cannot take the run.
    await expect(runEvaluationSlice(deps, { organization_id: s.org, run_id: runId, claimant: 'worker:B' })).rejects.toMatchObject({
      name: 'RunLeaseHeldError',
    });

    // After the lease, the reaper releases the claim: queued, resume_count 1.
    c.offsetMs = 6 * MIN;
    const reaped = await runReaper(deps, { organization_id: s.org });
    expect(reaped.released).toEqual([{ run_id: runId, organization_id: s.org, resume_count: 1 }]);

    // The tick re-enqueues the idle queued run (orphan rule) with a job id the old one cannot shadow.
    c.offsetMs = 9 * MIN;
    const t1 = await evaluateTick(deps, { organization_id: s.org });
    expect(t1.runs.map((r) => [r.run_id, r.why, r.resume_count])).toEqual([[runId, 'orphan_requeue', 1]]);
    expect(t1.runs[0]!.generation).toBeGreaterThan(0);

    // Worker B completes it; A's snapshot is kept and not redone.
    const done = await drive(deps, s.org, runId, 'worker:B');
    expect(done).toMatchObject({ done: true, status: 'succeeded', assertions_done: 4, controls_done: 2 });
    const snaps = await sql`SELECT assertion_id FROM bastion_evidence_snapshots WHERE evaluation_run_id = ${runId}`;
    expect(new Set(snaps.map((x) => x.assertion_id)).size).toBe(4);
    expect(snaps).toHaveLength(4);
    const controls = await sql`SELECT status, last_evaluated_at FROM bastion_controls WHERE organization_id = ${s.org}`;
    expect(controls.every((x) => x.last_evaluated_at !== null)).toBe(true);

    // The next night's run is created (the finished run holds no unique index against it).
    c.offsetMs = 24 * 60 * MIN;
    const t2 = await evaluateTick(deps, { organization_id: s.org });
    expect(t2.runs.map((r) => r.why)).toEqual(['nightly_created']);
    expect(t2.runs[0]!.run_id).not.toBe(runId);
    const nights = await sql`SELECT nightly_for_date::text AS d FROM bastion_evaluation_runs WHERE organization_id = ${s.org} AND trigger = 'nightly' ORDER BY d`;
    expect(nights).toHaveLength(2);
  });

  it('poll-cap handover: the successor under the inherited claimant continues a LIVE claim at once, resume_count unchanged (#201)', async () => {
    const s = await seedOrg(sql, 'handover', 1, 3);
    orgs.push(s.org);
    const c = clock();
    const deps = makeDeps(sql, { clock: c });
    const t0 = await evaluateTick(deps, { organization_id: s.org });
    const runId = t0.runs[0]!.run_id;

    // The predecessor job drove one slice and stopped polling at the cap; its heartbeat is fresh.
    const slow = fakeBucket();
    let puts = 0;
    const realPut = slow.put.bind(slow);
    slow.put = async (k, b, o) => {
      puts += 1;
      if (puts > 1) throw new Error('slow bucket (test)');
      return realPut(k, b, o);
    };
    const first = await runEvaluationSlice(makeDeps(sql, { clock: c, bucket: slow }), { organization_id: s.org, run_id: runId, claimant: 'worker:j1' });
    expect(first).toMatchObject({ done: false, assertions_done: 1 });
    // The real engine output is exactly what the worker parses (#205).
    expect(bastionEvaluateTickResultSchema.safeParse(t0).success).toBe(true);
    expect(bastionEvaluateRunSliceSchema.safeParse(first).success).toBe(true);

    // A job under a DIFFERENT claimant (the old per-job-id behavior) is refused, not stale.
    await expect(runEvaluationSlice(deps, { organization_id: s.org, run_id: runId, claimant: 'worker:r-r0-g99' })).rejects.toMatchObject({
      name: 'RunLeaseHeldError',
      heartbeatStale: false,
    });
    // The successor carrying the inherited claimant takes over immediately and finishes.
    const done = await drive(deps, s.org, runId, 'worker:j1');
    expect(done).toMatchObject({ done: true, status: 'succeeded', assertions_done: 3 });
    const [row] = await sql`SELECT resume_count FROM bastion_evaluation_runs WHERE id = ${runId}`;
    expect(Number(row!.resume_count)).toBe(0);
  });

  it('a partial nightly run resumes in place only via bastion_resume_partial_run, never against a live full run (#187)', async () => {
    const s = await seedOrg(sql, 'resume');
    orgs.push(s.org);
    const c = clock();
    // No bucket: the run ends partial / storage_unavailable.
    const noBucket = makeDeps(sql, { clock: c, bucket: null });
    const t0 = await evaluateTick(noBucket, { organization_id: s.org });
    const runId = t0.runs[0]!.run_id;
    expect(await drive(noBucket, s.org, runId, 'w1')).toMatchObject({ status: 'partial', partial_reason: 'storage_unavailable' });

    // A manual full run is queued: the tick must neither raise nor resume (resume returns false).
    const [manual] = await sql`INSERT INTO bastion_evaluation_runs (organization_id, trigger, scope, as_of, status)
                               VALUES (${s.org}, 'manual', 'all', now(), 'queued') RETURNING id`;
    const deps = makeDeps(sql, { clock: c });
    const blocked = await evaluateTick(deps, { organization_id: s.org });
    expect(blocked.runs.filter((r) => r.run_id === runId)).toEqual([]);
    const [still] = await sql`SELECT status, resume_count FROM bastion_evaluation_runs WHERE id = ${runId}`;
    expect(still).toMatchObject({ status: 'partial', resume_count: 0 });

    // The manual run finishes; the next tick resumes the partial nightly run in place.
    await drive(deps, s.org, manual!.id as string, 'w2');
    const resumed = await evaluateTick(deps, { organization_id: s.org });
    expect(resumed.runs.find((r) => r.run_id === runId)).toMatchObject({ why: 'nightly_resumed', resume_count: 1 });
    expect(await drive(deps, s.org, runId, 'w3')).toMatchObject({ status: 'succeeded' });

    // A manual run of the same scope while one is live is refused by the index (the route answers 409).
    await sql`INSERT INTO bastion_evaluation_runs (organization_id, trigger, scope, as_of, status) VALUES (${s.org}, 'manual', 'all', now(), 'queued')`;
    await expect(
      sql`INSERT INTO bastion_evaluation_runs (organization_id, trigger, scope, as_of, status) VALUES (${s.org}, 'agent', 'all', now(), 'queued')`,
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('outbox ordering within ONE transaction: the seal object is delivered before its ledger.sealed event', async () => {
    // Found live: both rows are enqueued in the seal transaction; with created_at = now() they
    // tied and the order fell to a random uuid, so ledger.sealed could go before its object.
    const s = await seedOrg(sql, 'outbox-tx', 1, 1);
    orgs.push(s.org);
    const deps = makeDeps(sql);
    for (let i = 0; i < 5; i++) {
      await sql.begin(async (raw) => {
        const tx = raw as unknown as postgres.Sql;
        for (const k of ['first', 'second', 'third']) {
          await enqueueOutbox(tx, { orgId: s.org, kind: 'bolt_event', orderingKey: `seal:${i}`, idempotencyKey: `${k}-${i}`, payload: { event_type: 'ledger.sealed', payload: {} } });
        }
      });
    }
    const order: string[] = [];
    await drainOutbox(deps, { deliver: async (row) => (order.push(row.idempotency_key), { ok: true }) }, { orgId: s.org, claimant: 't' });
    for (let i = 0; i < 5; i++) {
      expect(order.filter((k) => k.endsWith(`-${i}`))).toEqual([`first-${i}`, `second-${i}`, `third-${i}`]);
    }
  });

  it('outbox ordering: oldest pending row per key, a backing-off row blocks its key, a dead row stops blocking', async () => {
    const s = await seedOrg(sql, 'outbox', 1, 1);
    orgs.push(s.org);
    const c = clock();
    const deps = makeDeps(sql, { clock: c });
    const put = (key: string, idem: string) =>
      sql.begin(async (raw) => {
        const tx = raw as unknown as postgres.Sql;
        await enqueueOutbox(tx, { orgId: s.org, kind: 'bolt_event', orderingKey: key, idempotencyKey: idem, payload: { event_type: 'control.drifted', payload: {} } });
      });
    await put('control:A', 'a1');
    await put('control:A', 'a2');
    await put('control:B', 'b1');
    await put('control:A', 'a1'); // a repeated idempotency key is a no-op
    expect(Number((await sql`SELECT count(*)::int AS n FROM bastion_outbox WHERE organization_id = ${s.org}`)[0]!.n)).toBe(3);

    const delivered: string[] = [];
    const failing = new Set(['a1']);
    const deliverer: Deliverer = {
      async deliver(row) {
        if (failing.has(row.idempotency_key)) return { ok: false, error: 'bolt-api down (test)' };
        delivered.push(row.idempotency_key);
        return { ok: true };
      },
    };

    // a1 fails and backs off; a2 waits behind it; b1 is delivered.
    const first = await drainOutbox(deps, deliverer, { orgId: s.org, claimant: 't' });
    expect(first).toMatchObject({ delivered: 1, failed: 1, dead: 0 });
    expect(delivered).toEqual(['b1']);
    const a1 = (await sql`SELECT attempts, next_attempt_at, status FROM bastion_outbox WHERE organization_id = ${s.org} AND idempotency_key = 'a1'`)[0]!;
    expect(a1).toMatchObject({ attempts: 1, status: 'pending' });
    expect(new Date(a1.next_attempt_at as string).getTime()).toBeGreaterThan(c.now().getTime());

    // Still backing off: nothing behind it moves.
    await drainOutbox(deps, deliverer, { orgId: s.org, claimant: 't' });
    expect(delivered).toEqual(['b1']);

    // Its last attempt fails: dead, and a2 proceeds in the same drain.
    await sql`UPDATE bastion_outbox SET attempts = ${OUTBOX_MAX_ATTEMPTS - 1}, next_attempt_at = now() - interval '1 second'
               WHERE organization_id = ${s.org} AND idempotency_key = 'a1'`;
    const last = await drainOutbox(deps, deliverer, { orgId: s.org, claimant: 't' });
    expect(last).toMatchObject({ dead: 1, delivered: 1 });
    expect(delivered).toEqual(['b1', 'a2']);
    const statuses = await sql`SELECT idempotency_key, status FROM bastion_outbox WHERE organization_id = ${s.org} ORDER BY idempotency_key`;
    expect(statuses.map((r) => [r.idempotency_key, r.status])).toEqual([
      ['a1', 'dead'],
      ['a2', 'delivered'],
      ['b1', 'delivered'],
    ]);
  });

  it('a permanent refusal (4xx) goes dead on its first attempt with the reason, and the next row on its key proceeds in the same drain (#203)', async () => {
    const s = await seedOrg(sql, 'outbox-4xx', 1, 1);
    orgs.push(s.org);
    const deps = makeDeps(sql, { clock: clock() });
    for (const idem of ['p1', 'p2']) {
      await sql.begin(async (raw) => {
        const tx = raw as unknown as postgres.Sql;
        await enqueueOutbox(tx, { orgId: s.org, kind: 'bolt_event', orderingKey: `org:${s.org}`, idempotencyKey: idem, payload: { event_type: 'evaluation.completed', payload: {} } });
      });
    }
    const delivered: string[] = [];
    const deliverer: Deliverer = {
      async deliver(row) {
        if (row.idempotency_key === 'p1') return { ok: false, error: 'bolt-api ingest returned 400', status: 400, permanent: true };
        delivered.push(row.idempotency_key);
        return { ok: true };
      },
    };
    const res = await drainOutbox(deps, deliverer, { orgId: s.org, claimant: 't' });
    expect(res).toMatchObject({ dead: 1, delivered: 1, failed: 0 });
    expect(delivered).toEqual(['p2']);
    const [p1] = await sql`SELECT status, attempts, last_error FROM bastion_outbox WHERE organization_id = ${s.org} AND idempotency_key = 'p1'`;
    expect(p1).toMatchObject({ status: 'dead', attempts: 1 });
    expect(p1!.last_error).toMatch(/^permanent failure \(HTTP 400\)/);
  });
});

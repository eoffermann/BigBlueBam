import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import type { EngineDeps } from '../../src/engine/context.js';
import { runEvaluationSlice } from '../../src/engine/evaluator.js';
import { defaultDeliverer, drainOutbox, type Deliverer } from '../../src/engine/outbox.js';
import { checkLedgerIdentity } from '../../src/engine/restore.js';
import { sealOrg } from '../../src/engine/sweeps.js';
import { clock, DATABASE_URL, fakeBucket, makeDeps, rewindLedger, seedOrg, wipeOrg, type Clock, type FakeBucket, type SeededOrg } from './engine-harness.js';

/**
 * The M4 restore gates (spec 3.4, 11.2), against a real migrated database and the real engine:
 *
 *   restore WITH restart: seal, append, seal, rewind the database to the first dump, boot a fresh
 *   engine (cold seal cache), expect ledger.restore_detected with pending_ack only when a matching
 *   completed platform restore exists (else unmatched plus evidence.integrity_failed); appends
 *   blocked until resolved; the seal run refuses a head below the highest bucket seal; after
 *   resolution appends resume in the provisional epoch, no sealed (epoch, seq) is ever reused, and
 *   the gap is still reported from the restores/ bucket object once the database row is gone.
 *
 *   restore IN PLACE (no restart): the same warm engine sees a completed platform restore appear,
 *   the next evaluation ends `partial` / `restore_pending` and writes no ledger entry.
 *
 * The "dump restore" rewinds the org's ledger, snapshots and seals with triggers bypassed, which
 * is what restoring an earlier pg_dump into a fresh database leaves behind; the bucket (an
 * in-memory driver here, MinIO in production) is untouched, as it would be.
 * SKIPS LOUDLY without DATABASE_URL.
 */

if (!DATABASE_URL) {
  console.warn('[bastion-api/m4-restore] SKIPPING: DATABASE_URL is not set. Point it at a migrated database.');
}

const DAY = 86_400_000;

// Each scenario drives several real evaluation slices and seals; through a local forwarder that
// is tens of seconds, far above vitest's 5 s default.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 60_000 });

type Evidence = typeof import('../../src/services/evidence.service.js');

describe.skipIf(!DATABASE_URL)('M4 restore detection (live database)', () => {
  let sql: postgres.Sql;
  let evidence: Evidence;
  const orgs: string[] = [];
  const platformRestores: string[] = [];

  beforeAll(async () => {
    const hex = 'a'.repeat(64);
    Object.assign(process.env, {
      SESSION_SECRET: process.env.SESSION_SECRET ?? 's'.repeat(40),
      INTERNAL_SERVICE_SECRET: process.env.INTERNAL_SERVICE_SECRET ?? 'i'.repeat(40),
      BASTION_SEAL_SIGNING_KEY: process.env.BASTION_SEAL_SIGNING_KEY ?? '5'.repeat(64),
      BASTION_PD_HMAC_KEY: process.env.BASTION_PD_HMAC_KEY ?? hex,
      BASTION_ROOM_IP_SALT: process.env.BASTION_ROOM_IP_SALT ?? hex,
      BASTION_FEED_KEY_PEPPER: process.env.BASTION_FEED_KEY_PEPPER ?? hex,
    });
    sql = postgres(DATABASE_URL!, { max: 4, onnotice: () => {} });
    evidence = await import('../../src/services/evidence.service.js');
  });

  afterAll(async () => {
    if (!sql) return;
    for (const id of platformRestores) await sql`DELETE FROM platform_restores WHERE id = ${id}`;
    for (const org of orgs) await wipeOrg(sql, org);
    await sql.end();
    const db = await import('../../src/db/index.js');
    await db.connection.end();
  });

  /** Bolt events are recorded, seal objects go to the (fake) bucket. */
  function deliverer(deps: EngineDeps, bucket: FakeBucket, events: string[]): Deliverer {
    const real = defaultDeliverer({ sql: deps.sql, storage: bucket, putTimeoutMs: 2000 });
    return {
      async deliver(row) {
        if (row.kind === 'bolt_event') {
          events.push(String(row.payload.event_type));
          return { ok: true };
        }
        return real.deliver(row);
      },
    };
  }

  async function runToEnd(deps: EngineDeps, s: SeededOrg, c: Clock, claimant = 'test') {
    const [r] = await sql`INSERT INTO bastion_evaluation_runs (organization_id, trigger, scope, as_of, status)
                          VALUES (${s.org}, 'manual', 'all', ${c.now()}, 'queued') RETURNING id`;
    let last;
    for (let i = 0; i < 20; i++) {
      last = await runEvaluationSlice(deps, { organization_id: s.org, run_id: r!.id as string, claimant });
      if (last.done) break;
    }
    return { runId: r!.id as string, slice: last! };
  }

  const maxSeq = async (org: string) => Number((await sql`SELECT coalesce(max(seq), 0) AS s FROM bastion_ledger_entries WHERE organization_id = ${org}`)[0]!.s);
  const viewer = (s: SeededOrg) => ({ id: s.owner, org_id: s.org, role: 'owner', is_superuser: false, impersonator_id: null, auth_method: 'session' as const });

  /** Two sealed days in the bucket: (1,1) on day 0 and (1,2) on day 1. */
  async function twoSealedDays(deps: EngineDeps, s: SeededOrg, c: Clock, bucket: FakeBucket, events: string[]) {
    await runToEnd(deps, s, c);
    expect(await maxSeq(s.org)).toBe(1);
    const d0 = await sealOrg(deps, s.org);
    expect(d0).toMatchObject({ result: 'sealed', epoch: 1, head_seq: 1 });
    await drainOutbox(deps, deliverer(deps, bucket, events), { orgId: s.org, claimant: 't' });
    c.offsetMs += DAY;
    await runToEnd(deps, s, c);
    expect(await maxSeq(s.org)).toBe(2);
    const d1 = await sealOrg(deps, s.org);
    expect(d1).toMatchObject({ result: 'sealed', epoch: 1, head_seq: 2 });
    await drainOutbox(deps, deliverer(deps, bucket, events), { orgId: s.org, claimant: 't' });
    const sealKeys = [...bucket.objects.keys()].filter((k) => k.startsWith(`seals/${s.org}/`));
    expect(sealKeys).toHaveLength(2);
    return { d0Date: (d0 as { seal_date: string }).seal_date, d1Date: (d1 as { seal_date: string }).seal_date };
  }

  it('restore with restart, matched by a completed platform restore: pending_ack, blocked, acknowledged, resumes in epoch 2', async () => {
    const s = await seedOrg(sql, 'restart-matched');
    orgs.push(s.org);
    const c = clock();
    const bucket = fakeBucket();
    const events: string[] = [];
    const deps = makeDeps(sql, { bucket, clock: c });
    const { d0Date } = await twoSealedDays(deps, s, c, bucket, events);
    expect(events).toContain('ledger.sealed');

    // The platform restore of the day-0 dump completed after the day-1 seal was written.
    await rewindLedger(sql, s.org, 1, [d0Date]);
    const [pr] = await sql`INSERT INTO platform_restores (status, started_at, completed_at, confirmation_phrase)
                           VALUES ('completed', ${c.now()}, ${new Date(c.now().getTime() + 60_000)}, 'm4 test restore') RETURNING id`;
    platformRestores.push(pr!.id as string);

    // Boot: a fresh engine with a cold seal cache.
    c.offsetMs += 2 * 3_600_000;
    const booted = makeDeps(sql, { bucket, clock: c });
    const ident = await checkLedgerIdentity(booted, s.org);
    expect(ident.opened).toBeTruthy();
    expect(ident.blockedBy).toBe(ident.opened);
    const [row] = await sql`SELECT * FROM bastion_ledger_restores WHERE id = ${ident.opened!}`;
    expect(row).toMatchObject({ status: 'pending_ack', platform_restore_id: pr!.id, provisional_epoch: 2, resolution: null });
    // platform_restores is platform-wide: remove it now so it cannot line up with another test's gap.
    await sql`DELETE FROM platform_restores WHERE id = ${pr!.id as string}`;
    expect(Number(row!.lost_from_seq)).toBe(2);
    expect(Number(row!.lost_to_seq)).toBe(2);
    expect(bucket.objects.has(`restores/${s.org}/${ident.opened}.json`)).toBe(true);
    const outboxEvents = (await sql`SELECT payload->>'event_type' AS e FROM bastion_outbox WHERE organization_id = ${s.org} AND kind = 'bolt_event'`).map((r) => r.e);
    expect(outboxEvents).toContain('ledger.restore_detected');
    expect(outboxEvents).not.toContain('evidence.integrity_failed');

    // A second check does not open a second row.
    expect((await checkLedgerIdentity(booted, s.org)).opened).toBeNull();

    // The seal run refuses to sign a head below the highest bucket seal.
    expect(await sealOrg(booted, s.org)).toMatchObject({ result: 'refused_below_bucket_seal', head: { epoch: 1, seq: 1 }, bucket: { epoch: 1, seq: 2 } });

    // Appends are blocked: the run ends partial / restore_pending and writes nothing.
    const blocked = await runToEnd(booted, s, c);
    expect(blocked.slice).toMatchObject({ done: true, status: 'partial', partial_reason: 'restore_pending' });
    expect(await maxSeq(s.org)).toBe(1);

    // An owner acknowledges: a `restore` entry opens epoch 2 ABOVE the highest sealed seq.
    const ack = await evidence.acknowledgeRestore(booted, viewer(s), ident.opened!, { resolution: 'restore_acknowledged', confirm: true });
    expect(ack.data).toMatchObject({ status: 'acknowledged', provisional_epoch: 2, first_seq: 3 });

    // Appends resume.
    await runToEnd(booted, s, c);
    const entries = await sql`SELECT epoch, seq, entry_kind FROM bastion_ledger_entries WHERE organization_id = ${s.org} ORDER BY seq`;
    expect(entries.map((e) => [Number(e.epoch), Number(e.seq), e.entry_kind])).toEqual([
      [1, 1, 'snapshot'],
      [2, 3, 'restore'],
      [2, 4, 'snapshot'],
    ]);

    // Seal again: the new seal is in epoch 2 and the identity check is clean afterwards.
    c.offsetMs += DAY;
    expect(await sealOrg(booted, s.org)).toMatchObject({ result: 'sealed', epoch: 2, head_seq: 4 });
    await drainOutbox(booted, deliverer(booted, bucket, events), { orgId: s.org, claimant: 't' });
    const after = await checkLedgerIdentity(makeDeps(sql, { bucket, clock: c }), s.org);
    expect(after).toMatchObject({ opened: null, blockedBy: null });
    expect(after.highest).toMatchObject({ epoch: 2, head_seq: 4 });

    // No sealed (epoch, seq) was reused: every seal object either still matches the DB or its seq
    // is absent, and no entry of epoch 2 sits at or below a seq sealed in epoch 1.
    for (const [key, obj] of bucket.objects) {
      if (!key.startsWith(`seals/${s.org}/`)) continue;
      const seal = JSON.parse(obj.body.toString());
      const [e] = await sql`SELECT epoch, entry_hash FROM bastion_ledger_entries WHERE organization_id = ${s.org} AND seq = ${seal.head_seq}`;
      if (e) expect([Number(e.epoch), e.entry_hash]).toEqual([seal.epoch, seal.head_hash]);
    }
    expect(entries.filter((e) => Number(e.epoch) === 2).every((e) => Number(e.seq) > 2)).toBe(true);

    // The next day the database loses the restore row again; the gap is still reported from the
    // restores/ bucket object.
    await sql.begin(async (raw) => {
      const tx = raw as unknown as postgres.Sql;
      await tx`SET LOCAL session_replication_role = replica`;
      await tx`DELETE FROM bastion_ledger_restores WHERE organization_id = ${s.org}`;
    });
    const listed = await evidence.listRestores(booted, viewer(s));
    expect(listed.data).toEqual([]);
    expect(listed.bucket_only.map((b) => b.id)).toEqual([ident.opened]);
    expect(listed.bucket_only[0]!.summary).toBe('History lost by restore, epoch 1 seq 2-2');
  });

  it('restore with restart and NO matching platform restore: unmatched, integrity_failed, only continue_unexplained', async () => {
    const s = await seedOrg(sql, 'restart-unmatched');
    orgs.push(s.org);
    const c = clock();
    const bucket = fakeBucket();
    const deps = makeDeps(sql, { bucket, clock: c });
    const { d0Date } = await twoSealedDays(deps, s, c, bucket, []);
    await rewindLedger(sql, s.org, 1, [d0Date]);

    const booted = makeDeps(sql, { bucket, clock: c });
    const ident = await checkLedgerIdentity(booted, s.org);
    const [row] = await sql`SELECT status, platform_restore_id FROM bastion_ledger_restores WHERE id = ${ident.opened!}`;
    expect(row).toMatchObject({ status: 'unmatched', platform_restore_id: null });
    const outboxEvents = (await sql`SELECT payload->>'event_type' AS e FROM bastion_outbox WHERE organization_id = ${s.org} AND kind = 'bolt_event'`).map((r) => r.e);
    expect(outboxEvents).toEqual(expect.arrayContaining(['ledger.restore_detected', 'evidence.integrity_failed']));

    await expect(evidence.acknowledgeRestore(booted, viewer(s), ident.opened!, { resolution: 'restore_acknowledged', confirm: true })).rejects.toMatchObject({
      code: 'NO_MATCHING_RESTORE',
    });
    await expect(
      evidence.acknowledgeRestore(booted, { ...viewer(s), role: 'admin' }, ident.opened!, { resolution: 'continue_unexplained', confirm: true }),
    ).rejects.toMatchObject({ code: 'OWNER_REQUIRED' });
    const ok = await evidence.acknowledgeRestore(booted, viewer(s), ident.opened!, { resolution: 'continue_unexplained', confirm: true });
    expect(ok.data).toMatchObject({ status: 'unmatched', resolution: 'continue_unexplained', provisional_epoch: 2, first_seq: 3 });
    await runToEnd(booted, s, c);
    expect(await maxSeq(s.org)).toBe(4);
    const listed = await evidence.listRestores(booted, viewer(s));
    expect(listed.data[0]).toMatchObject({ label: 'Unexplained gap', appends_blocked: false });
  });

  it('restore in place (no restart): the warm engine notices the platform restore on the next append batch', async () => {
    const s = await seedOrg(sql, 'in-place');
    orgs.push(s.org);
    const c = clock();
    const bucket = fakeBucket();
    const deps = makeDeps(sql, { bucket, clock: c });
    const { d0Date } = await twoSealedDays(deps, s, c, bucket, []);
    // Warm the cache with both seal objects, as a long-running bastion-api would have.
    await checkLedgerIdentity(deps, s.org);

    // The Backup app restores the day-0 dump while bastion-api keeps running.
    await rewindLedger(sql, s.org, 1, [d0Date]);
    const [pr] = await sql`INSERT INTO platform_restores (status, started_at, completed_at, confirmation_phrase)
                           VALUES ('completed', ${c.now()}, ${new Date(c.now().getTime() + 60_000)}, 'm4 in-place restore') RETURNING id`;
    platformRestores.push(pr!.id as string);

    const run = await runToEnd(deps, s, c);
    expect(run.slice).toMatchObject({ done: true, status: 'partial', partial_reason: 'restore_pending' });
    const [r] = await sql`SELECT status, partial_reason FROM bastion_evaluation_runs WHERE id = ${run.runId}`;
    expect(r).toMatchObject({ status: 'partial', partial_reason: 'restore_pending' });
    const restores = await sql`SELECT status FROM bastion_ledger_restores WHERE organization_id = ${s.org}`;
    expect(restores.map((x) => x.status)).toEqual(['pending_ack']);
    await sql`DELETE FROM platform_restores WHERE id = ${pr!.id as string}`;
    // No sequence number was reused: nothing was appended at all.
    expect(await maxSeq(s.org)).toBe(1);
  });
});

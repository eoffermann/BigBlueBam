import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { orgTx } from '../../src/engine/context.js';
import { lockOrgGapRank } from '../../src/engine/gaps.js';
import { proposalReconcile } from '../../src/services/decisions.service.js';
import { DATABASE_URL, makeDeps, seedOrg, wipeOrg } from './engine-harness.js';

/**
 * Review batch 11, worker engines (live database):
 *   #255 proposal-reconcile takes the gap-rank lock first and isolates one org's failure.
 */

if (!DATABASE_URL) console.warn('[bastion-api/b11-engines] SKIPPING: DATABASE_URL is not set. Point it at a migrated database.');

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!DATABASE_URL)('batch 11: worker engines (live database)', () => {
  let sql: postgres.Sql;
  const orgs: string[] = [];

  beforeAll(() => {
    sql = postgres(DATABASE_URL!, { max: 8, onnotice: () => {} });
  });

  afterAll(async () => {
    if (!sql) return;
    for (const org of orgs) await wipeOrg(sql, org);
    await sql.end();
  });

  async function orgWithDecision(tag: string) {
    const s = await seedOrg(sql, `b11e-${tag}`);
    orgs.push(s.org);
    await sql`INSERT INTO bastion_ingest_events (organization_id, source, event_type, source_idempotency_key)
              VALUES (${s.org}, 'platform', 'proposal.decided', ${`b11-${tag}-${Date.now()}`})`;
    return s;
  }

  it('reconcile queues behind the org gap-rank lock, the order every gap writer uses (#255)', async () => {
    const s = await orgWithDecision('reconcile-lock');
    const deps = makeDeps(sql);
    let release!: () => void;
    const released = new Promise<void>((r) => {
      release = r;
    });
    let held!: () => void;
    const holding = new Promise<void>((r) => {
      held = r;
    });
    // An exception approval (or any re-rank) holding the lock.
    const holder = orgTx(sql, s.org, async (tx) => {
      await lockOrgGapRank(tx, s.org);
      held();
      await released;
    });
    await holding;
    let finished = false;
    const run = proposalReconcile(deps, { organization_id: s.org }).then((r) => {
      finished = true;
      return r;
    });
    await sleep(1500);
    expect(finished).toBe(false);
    release();
    await holder;
    const r = await run;
    expect(r).toMatchObject({ orgs: 1, inbox_marked_done: 1, orgs_failed: 0 });
  });

  it("one org's reconcile failure does not skip the orgs after it (#255)", async () => {
    const a = await orgWithDecision('reconcile-fail-a');
    const b = await orgWithDecision('reconcile-fail-b');
    const deps = makeDeps(sql);
    const fn = `b11_fail_inbox_${a.org.replace(/-/g, '')}`;
    await sql.unsafe(`
      CREATE OR REPLACE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN
        IF NEW.organization_id = '${a.org}'::uuid THEN
          RAISE EXCEPTION 'deadlock detected (test)' USING ERRCODE = '40P01';
        END IF;
        RETURN NEW;
      END $f$`);
    await sql.unsafe(`DROP TRIGGER IF EXISTS ${fn} ON bastion_ingest_events; CREATE TRIGGER ${fn} BEFORE UPDATE ON bastion_ingest_events FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
    try {
      // Both orgs in one pass (no org filter would also sweep other tests' orgs; run each explicitly in order).
      const ra = await proposalReconcile(deps, { organization_id: a.org });
      expect(ra).toMatchObject({ orgs: 1, orgs_failed: 1, inbox_marked_done: 0 });
      const all = await proposalReconcile(deps);
      expect(all.orgs_failed).toBeGreaterThanOrEqual(1);
      const bLeft = await sql`SELECT status FROM bastion_ingest_events WHERE organization_id = ${b.org}`;
      expect(bLeft.map((x) => x.status)).toEqual(['done']);
    } finally {
      await sql.unsafe(`DROP TRIGGER IF EXISTS ${fn} ON bastion_ingest_events`);
      await sql.unsafe(`DROP FUNCTION IF EXISTS ${fn}()`);
    }
  });
});

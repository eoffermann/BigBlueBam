import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { orgTx } from '../../src/engine/context.js';
import { gapRank, lockOrgGapRank, rankOrgGaps } from '../../src/engine/gaps.js';
import { DATABASE_URL, makeDeps, seedOrg, wipeOrg } from './engine-harness.js';

/**
 * #230: every gap re-rank for one org is serialized by a transaction-scoped advisory lock taken
 * before the inputs are read; the daily all-org pass skips an org another pass is ranking, stops
 * on its time budget and resumes from a cursor.
 */

if (!DATABASE_URL) console.warn('[bastion-api/m6-gap-rank-lock] SKIPPING: DATABASE_URL is not set. Point it at a migrated database.');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!DATABASE_URL)('gap ranking is serialized per org (#230, live database)', () => {
  let sql: postgres.Sql;
  const orgs: string[] = [];

  beforeAll(() => {
    sql = postgres(DATABASE_URL!, { max: 6, onnotice: () => {} });
  });

  afterAll(async () => {
    if (!sql) return;
    for (const org of orgs) await wipeOrg(sql, org);
    await sql.end();
  });

  /** Hold the org's gap-rank lock in an open transaction until `release` is called. */
  function holdLock(org: string) {
    let release!: () => void;
    const released = new Promise<void>((r) => {
      release = r;
    });
    let acquired!: () => void;
    const held = new Promise<void>((r) => {
      acquired = r;
    });
    const done = orgTx(sql, org, async (tx) => {
      await lockOrgGapRank(tx, org);
      acquired();
      await released;
    });
    return { held, release, done };
  }

  it('a second re-rank of the same org waits for the first to commit', async () => {
    const s = await seedOrg(sql, 'gaplock-wait');
    orgs.push(s.org);
    const deps = makeDeps(sql);
    const h = holdLock(s.org);
    try {
      await h.held;
      let finished = false;
      const second = orgTx(sql, s.org, (tx) => rankOrgGaps(tx, s.org, deps.now())).then(() => {
        finished = true;
      });
      await sleep(500);
      expect(finished).toBe(false);
      h.release();
      await h.done;
      await second;
      expect(finished).toBe(true);
    } finally {
      h.release();
      await h.done.catch(() => undefined);
    }
  });

  it('the post-run pass (one org) waits; the daily pass skips a busy org and ranks the rest', async () => {
    const busy = await seedOrg(sql, 'gaplock-busy');
    const free = await seedOrg(sql, 'gaplock-free');
    orgs.push(busy.org, free.org);
    const deps = makeDeps(sql);
    const h = holdLock(busy.org);
    try {
      await h.held;
      // The daily pass walks every org in the database, including ones other test files are
      // setting up and wiping right now, so only what this test owns is asserted.
      const daily = await gapRank(deps, {});
      expect(daily.complete).toBe(true);
      expect(daily.skipped_busy).toBeGreaterThanOrEqual(1);

      let single = false;
      const post = gapRank(deps, { organization_id: busy.org }).then((r) => {
        single = true;
        return r;
      });
      await sleep(500);
      expect(single).toBe(false);
      h.release();
      await h.done;
      expect((await post).ranked).toBe(1);
    } finally {
      // Never leave the lock-holding transaction open (it would block the cleanup).
      h.release();
      await h.done.catch(() => undefined);
    }
  });

  it('the daily pass stops on its budget and resumes from the cursor until complete', async () => {
    for (const tag of ['gapbudget-a', 'gapbudget-b', 'gapbudget-c']) orgs.push((await seedOrg(sql, tag)).org);
    const deps = makeDeps(sql);
    // Other test files set orgs up and wipe them concurrently, so count only what is stable: the
    // three orgs this test owns are ranked, one call at a time, and the pass ends.
    const total = 3;
    let calls = 0;
    let ranked = 0;
    let last: Awaited<ReturnType<typeof gapRank>> | undefined;
    do {
      last = await gapRank(deps, { budgetMs: 0 });
      calls += 1;
      ranked += last.ranked + last.skipped_busy;
    } while (!last.complete && calls < 500);
    expect(last.complete).toBe(true);
    // Budget 0 still ranks one org per call, so the pass makes progress and covers every org.
    expect(calls).toBeGreaterThanOrEqual(total);
    expect(ranked).toBeGreaterThanOrEqual(total);
    // The pass's cursor ends empty (#256: the cursor names its pass).
    expect(JSON.parse((await deps.cursors.get('bastion:gap-rank:all')) ?? '{}')).toMatchObject({ after: '' });
  });
});

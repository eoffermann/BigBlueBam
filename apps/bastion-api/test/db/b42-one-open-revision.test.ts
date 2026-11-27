import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { decideFix } from '../../src/services/fixes.service.js';
import type { DecisionDeps } from '../../src/services/decisions.service.js';
import type { Viewer } from '../../src/services/types.js';
import { REVISION_PENDING_MESSAGE } from '../../src/lib/revision-rule.js';
import { clock, DATABASE_URL, makeDeps, seedOrg, wipeOrg } from './engine-harness.js';

/**
 * Review batch 42, #401 (live database). After #393 a revision locks the check it revises, but a
 * CONFIRMED check stays in force until its revision is confirmed, so two revisions of it (one after
 * the other, or at the same moment) each filed a proposed successor and both waited to replace the
 * same check. The rule now: one open revision per check. A second revision is refused with
 * REVISION_PENDING; revising the waiting revision replaces it and still retires the confirmed check
 * when confirmed; once the waiting one is rejected a new revision is allowed. The population-drift
 * fix approval, the other writer of revisions, follows the same rule.
 */

if (!DATABASE_URL) console.warn('[bastion-api/b42-one-open-revision] SKIPPING: DATABASE_URL is not set. Point it at a migrated database.');

const viewer = (org: string, id: string): Viewer => ({
  id,
  org_id: org,
  role: 'owner',
  is_superuser: false,
  impersonator_id: null,
  auth_method: 'session',
});

describe.skipIf(!DATABASE_URL)('batch 42: one open revision per check (live database)', () => {
  let sql: postgres.Sql;
  const orgs: string[] = [];
  let assertions: typeof import('../../src/services/assertions.service.js');

  beforeAll(async () => {
    // env.ts validates at import (the assertion services use the drizzle pool).
    const hex = 'a'.repeat(64);
    Object.assign(process.env, {
      SESSION_SECRET: process.env.SESSION_SECRET ?? 's'.repeat(40),
      INTERNAL_SERVICE_SECRET: process.env.INTERNAL_SERVICE_SECRET ?? 'i'.repeat(40),
      BASTION_SEAL_SIGNING_KEY: process.env.BASTION_SEAL_SIGNING_KEY ?? hex,
      BASTION_PD_HMAC_KEY: process.env.BASTION_PD_HMAC_KEY ?? hex,
      BASTION_ROOM_IP_SALT: process.env.BASTION_ROOM_IP_SALT ?? hex,
      BASTION_FEED_KEY_PEPPER: process.env.BASTION_FEED_KEY_PEPPER ?? hex,
    });
    sql = postgres(String(DATABASE_URL), { max: 6, onnotice: () => {} });
    assertions = await import('../../src/services/assertions.service.js');
  });

  afterAll(async () => {
    if (!sql) return;
    for (const org of orgs) await wipeOrg(sql, org);
    await sql.end();
    const db = await import('../../src/db/index.js');
    for (const c of db.allConnections()) await c.end();
  });

  /** An org with one control and one CONFIRMED check on it. */
  async function seedConfirmed(tag: string) {
    const s = await seedOrg(sql, tag, 0, 0);
    orgs.push(s.org);
    const [ctl] = await sql`INSERT INTO bastion_controls (organization_id, control_key, title, owner_user_id, risk_weight)
                            VALUES (${s.org}, 'policy.security_policy', 'A security policy exists and people have read it', ${s.owner}, 4) RETURNING id`;
    const control = String(ctl?.id);
    const [a] = await sql`
      INSERT INTO bastion_assertions (organization_id, control_id, kind, probe_key, probe_version, params, predicate,
                                      plain_statement, proposed_by, review_status, confirmed_by, confirmed_at)
      VALUES (${s.org}, ${control}, 'probe', 'policy.attested', 1, '{}'::jsonb, '{}'::jsonb, 'Everyone has read the policy.',
              'library', 'confirmed', ${s.owner}, now())
      RETURNING id`;
    return { ...s, control, check: String(a?.id) };
  }

  const rows = (org: string, control: string) => sql`
    SELECT id, review_status, supersedes_id FROM bastion_assertions
     WHERE organization_id = ${org} AND control_id = ${control} ORDER BY created_at, id`;
  const waitingOn = (org: string, id: string) =>
    sql`SELECT id FROM bastion_assertions WHERE organization_id = ${org} AND supersedes_id = ${id} AND review_status = 'proposed'`;

  /** Hold `ids` FOR UPDATE on a second connection while `race` runs; release once `waiters` sessions block. */
  async function whileHeld<T>(ids: string[], waiters: number, race: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const released = new Promise<void>((r) => {
      release = r;
    });
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => {
      locked = r;
    });
    const holder = sql.begin(async (tx) => {
      await (tx as unknown as postgres.Sql)`SELECT id FROM bastion_assertions WHERE id = ANY(${ids}::uuid[]) FOR UPDATE`;
      locked();
      await released;
    });
    await isLocked;
    const running = race();
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const [w] = await sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
      if (Number(w?.n ?? 0) >= waiters) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    release();
    await holder;
    return running;
  }

  it('a second revision of a confirmed check, one after the other, is refused with REVISION_PENDING', async () => {
    const s = await seedConfirmed('b42-seq');
    const owner = viewer(s.org, s.owner);
    const first = (await assertions.reviseAssertion(owner, s.check, { plain_statement: 'Everyone has read the island policy.' })).data;
    expect(first).toMatchObject({ review_status: 'proposed', supersedes_id: s.check });

    await expect(assertions.reviseAssertion(owner, s.check, { plain_statement: 'Everyone has read the lagoon policy.' })).rejects.toMatchObject({
      code: 'REVISION_PENDING',
      message: REVISION_PENDING_MESSAGE,
    });
    expect(await waitingOn(s.org, s.check)).toHaveLength(1);
    // The confirmed check is still the one in force.
    const [orig] = await sql`SELECT review_status FROM bastion_assertions WHERE id = ${s.check}`;
    expect(orig?.review_status).toBe('confirmed');
  });

  it('two revisions of one confirmed check at the same moment: one files, the other gets REVISION_PENDING', async () => {
    const s = await seedConfirmed('b42-race');
    const owner = viewer(s.org, s.owner);
    const results = await whileHeld([s.check], 2, () =>
      Promise.allSettled([
        assertions.reviseAssertion(owner, s.check, { plain_statement: 'Everyone has read the island policy.' }),
        assertions.reviseAssertion(owner, s.check, { plain_statement: 'Everyone has read the lagoon policy.' }),
      ]),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
    expect(lost?.reason).toMatchObject({ code: 'REVISION_PENDING' });
    expect(await waitingOn(s.org, s.check)).toHaveLength(1);
  });

  it('revising the waiting revision replaces it, and confirming the newest retires the confirmed check', async () => {
    const s = await seedConfirmed('b42-chain');
    const owner = viewer(s.org, s.owner);
    const r1 = (await assertions.reviseAssertion(owner, s.check, { plain_statement: 'Everyone has read the island policy.' })).data;
    const r2 = (await assertions.reviseAssertion(owner, r1.id, { plain_statement: 'Everyone has read the island policy this year.' })).data;
    // r2 is the one open revision, waiting to replace the confirmed check (not the superseded r1).
    expect(r2).toMatchObject({ review_status: 'proposed', supersedes_id: s.check });
    expect((await waitingOn(s.org, s.check)).map((r) => String(r.id))).toEqual([r2.id]);
    expect((await sql`SELECT review_status FROM bastion_assertions WHERE id = ${r1.id}`)[0]?.review_status).toBe('superseded');
    // The superseded r1 cannot be revised again into a second branch.
    await expect(assertions.reviseAssertion(owner, r1.id, { plain_statement: 'fork' })).rejects.toMatchObject({ code: 'ASSERTION_SUPERSEDED' });

    await assertions.confirmAssertion(owner, r2.id, {});
    const live = (await rows(s.org, s.control)).filter((r) => r.review_status === 'proposed' || r.review_status === 'confirmed');
    expect(live.map((r) => String(r.id))).toEqual([r2.id]);
    const [audit] = await sql`SELECT details FROM bastion_audit_log WHERE organization_id = ${s.org} AND action = 'assertion.revise' AND subject_id = ${r2.id}`;
    expect(audit?.details).toMatchObject({ supersedes_id: s.check, revises_id: r1.id });
  });

  it('once the waiting revision is rejected, a new revision of the confirmed check is allowed', async () => {
    const s = await seedConfirmed('b42-reject');
    const owner = viewer(s.org, s.owner);
    const r1 = (await assertions.reviseAssertion(owner, s.check, { plain_statement: 'Everyone has read the island policy.' })).data;
    await assertions.rejectAssertion(owner, r1.id, { reason: 'Wrong policy' });
    const r2 = (await assertions.reviseAssertion(owner, s.check, { plain_statement: 'Everyone has read the lagoon policy.' })).data;
    expect(r2).toMatchObject({ review_status: 'proposed', supersedes_id: s.check });
    expect(await waitingOn(s.org, s.check)).toHaveLength(1);
  });

  it('approving a population-drift fix follows the same rule: refused while a revision waits, files one when none does', async () => {
    const s = await seedConfirmed('b42-fix');
    const owner = viewer(s.org, s.owner);
    const d: DecisionDeps = { engine: makeDeps(sql, { clock: clock() }), canAccess: async () => true };
    const fixFor = async () => {
      const [gap] = await sql`INSERT INTO bastion_gaps (organization_id, control_id, assertion_id, gap_kind, status)
                              VALUES (${s.org}, ${s.control}, ${s.check}, 'population_drift', 'proposed') RETURNING id`;
      const [draft] = await sql`
        INSERT INTO bastion_fix_drafts (organization_id, gap_id, template, title, payload, created_by)
        VALUES (${s.org}, ${String(gap?.id)}, 'config_change', 'Add the new radio repository',
                ${sql.json({ add_members: ['castaways/rescue-radio-firmware'] })}, ${s.owner})
        RETURNING id`;
      return String(draft?.id);
    };

    const r1 = (await assertions.reviseAssertion(owner, s.check, { plain_statement: 'Everyone has read the island policy.' })).data;
    const blocked = await fixFor();
    await expect(decideFix(d, owner, blocked, { decision: 'approve' }, false)).rejects.toMatchObject({ code: 'REVISION_PENDING' });
    // Nothing was decided or filed.
    expect((await sql`SELECT status FROM bastion_fix_drafts WHERE id = ${blocked}`)[0]?.status).toBe('proposed');
    expect((await waitingOn(s.org, s.check)).map((r) => String(r.id))).toEqual([r1.id]);

    await assertions.rejectAssertion(owner, r1.id, {});
    const decided = await decideFix(d, owner, blocked, { decision: 'approve' }, false);
    expect(decided.data.status).toBe('approved');
    expect(await waitingOn(s.org, s.check)).toHaveLength(1);
  });
});

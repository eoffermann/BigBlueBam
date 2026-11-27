import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { createPolicy, PIN_PROBLEM_MESSAGE, type PolicyDeps } from '../../src/services/policies.service.js';
import type { Viewer } from '../../src/services/types.js';
import { clock, DATABASE_URL, makeDeps, seedOrg, wipeOrg } from './engine-harness.js';

/**
 * Review batch 39, #393 (live database). Linking a policy pins the security policy control's two
 * checks to it. That pin ran outside any lock: two links at the same moment both chose the same
 * unpinned control, both revised the same proposed check and both marked it superseded, leaving
 * two live proposals per check pinned to different policies. And a pin that failed after the
 * policy committed failed the whole POST, so a retry hit a policy that already existed.
 *
 * Each race here is made deterministic with a second connection: the test holds the original
 * checks FOR UPDATE while both requests run, waits until both are blocked, then lets go.
 */

if (!DATABASE_URL) console.warn('[bastion-api/b39-policy-pin-race] SKIPPING: DATABASE_URL is not set. Point it at a migrated database.');

const viewer = (org: string, id: string): Viewer => ({
  id,
  org_id: org,
  role: 'owner',
  is_superuser: false,
  impersonator_id: null,
  auth_method: 'session',
});

const KEYS = ['policy.attested', 'policy.current'] as const;

describe.skipIf(!DATABASE_URL)('batch 39: linking a policy pins the policy control once, whatever races it (live database)', () => {
  let sql: postgres.Sql;
  const orgs: string[] = [];
  const entries: string[] = [];
  let pins: typeof import('../../src/services/policy-pins.js');
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
    pins = await import('../../src/services/policy-pins.js');
    assertions = await import('../../src/services/assertions.service.js');
  });

  afterAll(async () => {
    if (!sql) return;
    for (const org of orgs) await sql`DELETE FROM entity_links WHERE org_id = ${org}`;
    for (const e of entries) {
      await sql`DELETE FROM beacon_versions WHERE beacon_id = ${e}`;
      await sql`DELETE FROM beacon_entries WHERE id = ${e}`;
    }
    for (const org of orgs) await wipeOrg(sql, org);
    await sql.end();
    const db = await import('../../src/db/index.js');
    for (const c of db.allConnections()) await c.end();
  });

  /** An org with the policy control and its two checks, proposed and pinned to nothing. */
  async function seedPolicyControl(tag: string) {
    const s = await seedOrg(sql, tag, 0, 0);
    orgs.push(s.org);
    const [ctl] = await sql`INSERT INTO bastion_controls (organization_id, control_key, title, owner_user_id, risk_weight)
                            VALUES (${s.org}, 'policy.security_policy', 'A security policy exists and people have read it', ${s.owner}, 4) RETURNING id`;
    const control = String(ctl?.id);
    const original: string[] = [];
    for (const probe of KEYS) {
      const [a] = await sql`
        INSERT INTO bastion_assertions (organization_id, control_id, kind, probe_key, probe_version, params, predicate,
                                        plain_statement, proposed_by, review_status)
        VALUES (${s.org}, ${control}, 'probe', ${probe}, 1, '{}'::jsonb, '{}'::jsonb, ${`check ${probe}`}, 'library', 'proposed')
        RETURNING id`;
      original.push(String(a?.id));
    }
    return { ...s, control, original };
  }

  async function article(org: string, owner: string, title: string): Promise<string> {
    const [e] = await sql`
      INSERT INTO beacon_entries (slug, title, body_markdown, version, status, visibility, created_by, owned_by, organization_id, expires_at, last_verified_at)
      VALUES (${`b39-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`}, ${title}, 'live', 1, 'Active', 'Organization',
              ${owner}, ${owner}, ${org}, now() + interval '200 days', now())
      RETURNING id`;
    const id = String(e?.id);
    entries.push(id);
    await sql`INSERT INTO beacon_versions (beacon_id, version, title, body_markdown) VALUES (${id}, 1, ${title}, '# Policy')`;
    return id;
  }

  /**
   * Hold the given assertion rows FOR UPDATE on a separate connection, run `race` while they are
   * held, release once `waiters` sessions are blocked on a lock (or after 10 s), return its result.
   */
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

  const liveChecks = (org: string, control: string) => sql`
    SELECT id, probe_key, review_status, params->>'policy_id' AS policy_id, supersedes_id FROM bastion_assertions
     WHERE organization_id = ${org} AND control_id = ${control} AND probe_key IN ('policy.attested', 'policy.current')
       AND review_status IN ('proposed', 'confirmed')`;

  it('two policies linked at the same moment leave ONE live proposal per check, pinned to one policy', async () => {
    const s = await seedPolicyControl('b39-race');
    const owner = viewer(s.org, s.owner);
    const d: PolicyDeps = { engine: makeDeps(sql, { clock: clock() }), canAccess: async () => true, enqueueRuns: async () => {}, pinChecks: pins.pinPolicyChecks };
    const a1 = await article(s.org, s.owner, 'Island Information Security Policy');
    const a2 = await article(s.org, s.owner, 'Lagoon Acceptable Use Policy');

    const results = await whileHeld(s.original, 2, () =>
      Promise.allSettled([
        createPolicy(d, owner, { beacon_entry_id: a1, audience: { kind: 'all' }, cadence_days: 365 }),
        createPolicy(d, owner, { beacon_entry_id: a2, audience: { kind: 'all' }, cadence_days: 365 }),
      ]),
    );
    // Both links succeed (a pin never fails a link) and neither reports a pin problem.
    for (const r of results) expect(r.status).toBe('fulfilled');
    const created = results.map((r) => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof createPolicy>>>).value.data);
    for (const c of created) expect(c.pin_problem).toBeNull();
    // Exactly one of them pinned the control; the other found it already pinned.
    expect(created.map((c) => c.proposed_assertion_ids.length).sort()).toEqual([0, 2]);
    const winner = created.find((c) => c.proposed_assertion_ids.length === 2);

    const live = await liveChecks(s.org, s.control);
    for (const key of KEYS) {
      const forKey = live.filter((a) => a.probe_key === key);
      expect(forKey, `live ${key} checks`).toHaveLength(1);
      expect(forKey[0]).toMatchObject({ review_status: 'proposed', policy_id: winner?.id });
    }
    // Each original was superseded exactly once: no second successor forked off it.
    const successors = await sql`SELECT supersedes_id, count(*)::int AS n FROM bastion_assertions
                                  WHERE organization_id = ${s.org} AND supersedes_id = ANY(${s.original}::uuid[]) GROUP BY supersedes_id`;
    expect(successors.map((r) => Number(r.n))).toEqual([1, 1]);
  });

  it('two revisions of one proposed check at the same moment: one wins, the other is told it was replaced', async () => {
    const s = await seedPolicyControl('b39-revise');
    const owner = viewer(s.org, s.owner);
    const target = String(s.original[0]);
    const results = await whileHeld([target], 2, () =>
      Promise.allSettled([
        assertions.reviseAssertion(owner, target, { plain_statement: 'Everyone has read the island policy.' }),
        assertions.reviseAssertion(owner, target, { plain_statement: 'Everyone has read the lagoon policy.' }),
      ]),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
    expect(lost?.reason).toMatchObject({ code: 'ASSERTION_SUPERSEDED' });
    const successors = await sql`SELECT id FROM bastion_assertions WHERE organization_id = ${s.org} AND supersedes_id = ${target}`;
    expect(successors).toHaveLength(1);
    const live = (await liveChecks(s.org, s.control)).filter((a) => a.probe_key === KEYS[0]);
    expect(live).toHaveLength(1);
  });

  it('a pin that fails after the policy commits does not fail the link; the reason is recorded; a retry never duplicates it', async () => {
    const s = await seedPolicyControl('b39-pinfail');
    const owner = viewer(s.org, s.owner);
    const entry = await article(s.org, s.owner, 'Island Information Security Policy');
    const failing: PolicyDeps = {
      engine: makeDeps(sql, { clock: clock() }),
      canAccess: async () => true,
      enqueueRuns: async () => {},
      pinChecks: async () => {
        throw new Error('connection reset while pinning (test)');
      },
    };

    const created = await createPolicy(failing, owner, { beacon_entry_id: entry, audience: { kind: 'all' }, cadence_days: 365 });
    expect(created.data.proposed_assertion_ids).toEqual([]);
    expect(created.data.pin_problem).toBe(PIN_PROBLEM_MESSAGE);
    const policies = async () => sql`SELECT id FROM bastion_policies WHERE organization_id = ${s.org} AND beacon_entry_id = ${entry}`;
    expect(await policies()).toHaveLength(1);
    const [logged] = await sql`SELECT subject_id, details FROM bastion_audit_log WHERE organization_id = ${s.org} AND action = 'policy.pin_failed'`;
    expect(logged?.subject_id).toBe(created.data.id);
    expect((logged?.details as { reason?: string }).reason).toBe('connection reset while pinning (test)');
    // The checks were left as they were.
    expect((await liveChecks(s.org, s.control)).map((a) => String(a.id)).sort()).toEqual([...s.original].sort());

    // A client retry of the same link: refused as already linked, still one policy.
    const working: PolicyDeps = { ...failing, pinChecks: pins.pinPolicyChecks };
    await expect(createPolicy(working, owner, { beacon_entry_id: entry, audience: { kind: 'all' }, cadence_days: 365 })).rejects.toMatchObject({
      code: 'POLICY_ALREADY_LINKED',
    });
    expect(await policies()).toHaveLength(1);

    // Pinning that policy later works, and pinning it again is a no-op.
    const first = await pins.pinPolicyChecks(owner, null, created.data.id);
    expect(first).toMatchObject({ control_id: s.control });
    expect(first.proposed).toHaveLength(2);
    const again = await pins.pinPolicyChecks(owner, s.control, created.data.id);
    expect(again.proposed).toEqual([]);
    const live = await liveChecks(s.org, s.control);
    expect(live).toHaveLength(2);
    for (const a of live) expect(a.policy_id).toBe(created.data.id);
  });
});

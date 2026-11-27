import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { createPolicy, type PolicyDeps } from '../../src/services/policies.service.js';
import type { Viewer } from '../../src/services/types.js';
import { clock, DATABASE_URL, makeDeps, seedOrg, wipeOrg } from './engine-harness.js';

/**
 * Review batch 43, #404 (live database). The #393 policy pin locked the control and then each
 * policy check FOR UPDATE. An evaluator snapshot insert key-shares the check and then the control
 * through its FKs, and then locks the control FOR UPDATE to aggregate it. FOR UPDATE conflicts with
 * FOR KEY SHARE, so a pin holding the control while the evaluator held the check deadlocked (40P01).
 * The locks are now FOR NO KEY UPDATE, which still serializes two pins or two revisers but does not
 * conflict with the KEY SHARE an FK insert takes. And a pin that does hit a transient error is
 * retried instead of being recorded as `policy.pin_failed`.
 *
 * The interleaving is forced with a third connection: it holds the first policy check FOR SHARE
 * (which blocks the pin's check lock but not an FK key-share), so the pin is parked holding the
 * control while the evaluator-style transaction inserts its snapshot. Then the holder lets go.
 */

if (!DATABASE_URL) console.warn('[bastion-api/b43-policy-pin-deadlock] SKIPPING: DATABASE_URL is not set. Point it at a migrated database.');

const viewer = (org: string, id: string): Viewer => ({
  id,
  org_id: org,
  role: 'owner',
  is_superuser: false,
  impersonator_id: null,
  auth_method: 'session',
});

const KEYS = ['policy.attested', 'policy.current'] as const;
const SHA = 'c'.repeat(64);

describe.skipIf(!DATABASE_URL)('batch 43: a policy pin and an evaluator snapshot never deadlock (live database)', () => {
  let sql: postgres.Sql;
  const orgs: string[] = [];
  const entries: string[] = [];
  let pins: typeof import('../../src/services/policy-pins.js');

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

  /** An org with the policy control and its two checks, both confirmed and pinned to nothing. */
  async function seedPolicyControl(tag: string) {
    const s = await seedOrg(sql, tag, 0, 0);
    orgs.push(s.org);
    const [ctl] = await sql`INSERT INTO bastion_controls (organization_id, control_key, title, owner_user_id, risk_weight)
                            VALUES (${s.org}, 'policy.security_policy', 'A security policy exists and people have read it', ${s.owner}, 4) RETURNING id`;
    const control = String(ctl?.id);
    const checks: string[] = [];
    for (const probe of KEYS) {
      const [a] = await sql`
        INSERT INTO bastion_assertions (organization_id, control_id, kind, probe_key, probe_version, params, predicate,
                                        plain_statement, proposed_by, review_status, confirmed_by, confirmed_at)
        VALUES (${s.org}, ${control}, 'probe', ${probe}, 1, '{}'::jsonb, '{}'::jsonb, ${`check ${probe}`}, 'library', 'confirmed', ${s.owner}, now())
        RETURNING id`;
      checks.push(String(a?.id));
    }
    return { ...s, control, checks };
  }

  async function article(org: string, owner: string, title: string): Promise<string> {
    const [e] = await sql`
      INSERT INTO beacon_entries (slug, title, body_markdown, version, status, visibility, created_by, owned_by, organization_id, expires_at, last_verified_at)
      VALUES (${`b43-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`}, ${title}, 'live', 1, 'Active', 'Organization',
              ${owner}, ${owner}, ${org}, now() + interval '200 days', now())
      RETURNING id`;
    const id = String(e?.id);
    entries.push(id);
    await sql`INSERT INTO beacon_versions (beacon_id, version, title, body_markdown) VALUES (${id}, 1, ${title}, '# Policy')`;
    return id;
  }

  /** A linked policy with no pin yet (no pinChecks), so the test drives the pin itself. */
  async function linkedPolicy(s: { org: string; owner: string }): Promise<string> {
    const d: PolicyDeps = { engine: makeDeps(sql, { clock: clock() }), canAccess: async () => true, enqueueRuns: async () => {} };
    const entry = await article(s.org, s.owner, 'Island Information Security Policy');
    const created = await createPolicy(d, viewer(s.org, s.owner), { beacon_entry_id: entry, audience: { kind: 'all' }, cadence_days: 365 });
    return created.data.id;
  }

  /** Poll until `pid` is blocked on a lock (by anyone, or by `byPid` when given); false after 10 s. */
  async function waitBlocked(pid: number, byPid?: number): Promise<boolean> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const [r] = await sql`SELECT pg_blocking_pids(${pid}::int) AS b`;
      const blockers = (r?.b as number[] | null) ?? [];
      if (byPid === undefined ? blockers.length > 0 : blockers.includes(byPid)) return true;
      await new Promise((res) => setTimeout(res, 25));
    }
    return false;
  }

  /** Poll until some backend other than `except` is blocked by `holderPid`; returns its pid. */
  async function waitBlockedBy(holderPid: number): Promise<number | null> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const [r] = await sql`SELECT pid FROM pg_stat_activity WHERE ${holderPid}::int = ANY(pg_blocking_pids(pid)) LIMIT 1`;
      if (r?.pid) return Number(r.pid);
      await new Promise((res) => setTimeout(res, 25));
    }
    return null;
  }

  it('a pin holding the control and a snapshot insert for its check both commit, with no 40P01', async () => {
    const s = await seedPolicyControl('b43-deadlock');
    const owner = viewer(s.org, s.owner);
    const policyId = await linkedPolicy(s);
    const [attested, current] = s.checks as [string, string];
    const [run] = await sql`INSERT INTO bastion_evaluation_runs (organization_id, trigger, scope, control_id, as_of, status)
                            VALUES (${s.org}, 'manual', 'control', ${s.control}, now(), 'running') RETURNING id`;
    const runId = String(run?.id);

    // 1. The holder parks the pin: FOR SHARE on the first check blocks the pin's check lock (any
    //    strength) but not the FOR KEY SHARE an FK insert takes.
    let releaseHolder!: () => void;
    const holderReleased = new Promise<void>((r) => {
      releaseHolder = r;
    });
    let holderPid = 0;
    let holderReady!: () => void;
    const holderLocked = new Promise<void>((r) => {
      holderReady = r;
    });
    const holder = sql.begin(async (raw) => {
      const tx = raw as unknown as postgres.Sql;
      holderPid = Number((await tx`SELECT pg_backend_pid() AS pid`)[0]?.pid);
      await tx`SELECT id FROM bastion_assertions WHERE id = ${attested} FOR SHARE`;
      holderReady();
      await holderReleased;
    });
    await holderLocked;

    // 2. The pin: takes the per-org lock and the control lock, then waits on the holder.
    const pin = pins.pinPolicyChecks(owner, s.control, policyId);
    const pinOutcome = pin.then(
      (v) => ({ ok: true as const, v }),
      (err: unknown) => ({ ok: false as const, err }),
    );
    const pinPid = await waitBlockedBy(holderPid);
    expect(pinPid, 'the pin is parked on the held check, holding the control').not.toBeNull();

    // 3. An evaluator-style snapshot transaction for the confirmed policy.current check: the
    //    snapshot insert key-shares the check and the control, then the control is locked to
    //    aggregate it (evaluator.ts writeSnapshot -> aggregateControl).
    let evalPid = 0;
    let evalReady!: () => void;
    const evalStarted = new Promise<void>((r) => {
      evalReady = r;
    });
    const evaluator = sql
      .begin(async (raw) => {
        const tx = raw as unknown as postgres.Sql;
        evalPid = Number((await tx`SELECT pg_backend_pid() AS pid`)[0]?.pid);
        evalReady();
        await tx`INSERT INTO bastion_evidence_snapshots (organization_id, evaluation_run_id, assertion_id, control_id, outcome, probe_key, cited_refs, content_sha256)
                  VALUES (${s.org}, ${runId}, ${current}, ${s.control}, 'pass', 'policy.current', '[]'::jsonb, ${SHA})`;
        await tx`SELECT id FROM bastion_controls WHERE organization_id = ${s.org} AND id = ${s.control} FOR UPDATE`;
      })
      .then(
        () => ({ ok: true as const }),
        (err: unknown) => ({ ok: false as const, err }),
      );
    await evalStarted;
    // The evaluator ends up waiting on the pin's control lock (or, before #404, on the snapshot
    // insert's key share of that same control).
    expect(await waitBlocked(evalPid, pinPid ?? undefined), 'the evaluator waits on the pin').toBe(true);

    // 4. Let the pin go on to lock its checks. Before #404 it then wanted FOR UPDATE on
    //    policy.current, which the evaluator key-shares: a lock cycle, and Postgres aborted one side.
    releaseHolder();
    await holder;
    const [p, e] = await Promise.all([pinOutcome, evaluator]);

    const codeOf = (r: { ok: boolean; err?: unknown }) => (r.ok ? null : ((r.err as { code?: string }).code ?? String(r.err)));
    expect(codeOf(p), 'the pin committed').toBeNull();
    expect(codeOf(e), 'the snapshot transaction committed').toBeNull();
    if (p.ok) expect(p.v.proposed).toHaveLength(2);

    const [snap] = await sql`SELECT count(*)::int AS n FROM bastion_evidence_snapshots WHERE organization_id = ${s.org} AND evaluation_run_id = ${runId}`;
    expect(Number(snap?.n)).toBe(1);
    const proposals = await sql`
      SELECT probe_key, params->>'policy_id' AS policy_id, supersedes_id FROM bastion_assertions
       WHERE organization_id = ${s.org} AND control_id = ${s.control} AND review_status = 'proposed'`;
    expect(proposals).toHaveLength(2);
    for (const a of proposals) expect(a.policy_id).toBe(policyId);
  });

  it('a pin that hits a transient database error is retried, not recorded as pin_failed', async () => {
    const s = await seedPolicyControl('b43-retry');
    const owner = viewer(s.org, s.owner);
    const entry = await article(s.org, s.owner, 'Lagoon Acceptable Use Policy');
    let calls = 0;
    const d: PolicyDeps = {
      engine: makeDeps(sql, { clock: clock() }),
      canAccess: async () => true,
      enqueueRuns: async () => {},
      pinChecks: async (v, controlId, policyId) => {
        calls++;
        if (calls === 1) throw Object.assign(new Error('deadlock detected (test)'), { code: '40P01' });
        return pins.pinPolicyChecks(v, controlId, policyId);
      },
    };

    const created = await createPolicy(d, owner, { beacon_entry_id: entry, control_id: s.control, audience: { kind: 'all' }, cadence_days: 365 });
    expect(calls).toBe(2);
    expect(created.data.pin_problem).toBeNull();
    expect(created.data.proposed_assertion_ids).toHaveLength(2);
    const failed = await sql`SELECT 1 FROM bastion_audit_log WHERE organization_id = ${s.org} AND action = 'policy.pin_failed'`;
    expect(failed).toHaveLength(0);
  });
});

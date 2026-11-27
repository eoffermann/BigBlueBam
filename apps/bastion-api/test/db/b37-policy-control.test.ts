import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { orgTx } from '../../src/engine/context.js';
import { runEvaluationSlice } from '../../src/engine/evaluator.js';
import { queueControlRuns } from '../../src/engine/evidence-store.js';
import { rankOrgGaps } from '../../src/engine/gaps.js';
import { readinessSummary } from '../../src/services/coverage.service.js';
import { attest, createPolicy, getPolicyBody, type PolicyDeps } from '../../src/services/policies.service.js';
import type { Viewer } from '../../src/services/types.js';
import { clock, DATABASE_URL, makeDeps, seedOrg, wipeOrg } from './engine-harness.js';

/**
 * Review batch 37, #387 (live database): in GILLIGAN, "A security policy exists and people have
 * read it" appeared twice among the Readiness top gaps, both "Nothing can prove this yet", while
 * the policy was read by 5 of 7. The policy had been linked without naming the control (the
 * Policies page never names one), so the control's policy.current and policy.attested checks were
 * never pinned to it: each said "No policy is linked to this check yet" and each stored its own
 * no_source gap, which Readiness listed as two rows for one control.
 *
 * Here: unpinned, the two gaps show as ONE Readiness row; linking the policy without a control
 * pins both checks to it (as proposals, confirmed by a person); with the policy read by a majority
 * but not everyone the control is Not met with a `failing` gap, and no `no_source` gap is left.
 */

if (!DATABASE_URL) console.warn('[bastion-api/b37-policy-control] SKIPPING: DATABASE_URL is not set. Point it at a migrated database.');

const viewer = (org: string, id: string): Viewer => ({
  id,
  org_id: org,
  role: 'owner',
  is_superuser: false,
  impersonator_id: null,
  auth_method: 'session',
});

describe.skipIf(!DATABASE_URL)('batch 37: the policy control is proven against the linked policy, listed once (live database)', () => {
  let sql: postgres.Sql;
  const orgs: string[] = [];
  const entries: string[] = [];
  let pins: typeof import('../../src/services/policy-pins.js');
  let assertions: typeof import('../../src/services/assertions.service.js');
  let rls: typeof import('../../src/plugins/rls.js');
  // The unpinned policy control as policy-pins.ts chooses it (#393: one implementation, drizzle pool).
  const unpinned = (org: string) => rls.runInOrgScope(org, (tx) => pins.unpinnedPolicyControl(tx, org));

  beforeAll(async () => {
    // env.ts validates at import (the assertion services use the drizzle pool); never used here.
    const hex = 'a'.repeat(64);
    Object.assign(process.env, {
      SESSION_SECRET: process.env.SESSION_SECRET ?? 's'.repeat(40),
      INTERNAL_SERVICE_SECRET: process.env.INTERNAL_SERVICE_SECRET ?? 'i'.repeat(40),
      BASTION_SEAL_SIGNING_KEY: process.env.BASTION_SEAL_SIGNING_KEY ?? hex,
      BASTION_PD_HMAC_KEY: process.env.BASTION_PD_HMAC_KEY ?? hex,
      BASTION_ROOM_IP_SALT: process.env.BASTION_ROOM_IP_SALT ?? hex,
      BASTION_FEED_KEY_PEPPER: process.env.BASTION_FEED_KEY_PEPPER ?? hex,
    });
    sql = postgres(DATABASE_URL!, { max: 6, onnotice: () => {} });
    pins = await import('../../src/services/policy-pins.js');
    assertions = await import('../../src/services/assertions.service.js');
    rls = await import('../../src/plugins/rls.js');
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

  it('two no_source gaps on one control are one Readiness row; linking without a control pins it; a majority read is Not met', async () => {
    const s = await seedOrg(sql, 'b37-policy', 0, 0);
    orgs.push(s.org);
    const c = clock();
    const engine = makeDeps(sql, { clock: c });
    const owner = viewer(s.org, s.owner);

    // Two more castaways: an audience of three, two of whom will read the policy.
    const people = [s.owner];
    for (let i = 0; i < 2; i++) {
      const [u] = await sql`INSERT INTO users (org_id, email, display_name, password_hash, kind)
                            VALUES (${s.org}, ${`b37-${i}-${Date.now()}@bigbluebam.internal`}, ${`Castaway ${i}`}, '!', 'human') RETURNING id`;
      await sql`INSERT INTO organization_memberships (user_id, org_id) VALUES (${u!.id as string}, ${s.org})`;
      people.push(u!.id as string);
    }

    // The library's policy control with its two unpinned checks, as the compile leaves them.
    const [ctl] = await sql`INSERT INTO bastion_controls (organization_id, control_key, title, owner_user_id, risk_weight)
                            VALUES (${s.org}, 'policy.security_policy', 'A security policy exists and people have read it', ${s.owner}, 4) RETURNING id`;
    const control = ctl!.id as string;
    await sql`INSERT INTO bastion_control_requirements (organization_id, control_id, framework_id, ref_code, requirement_title, applicability)
              VALUES (${s.org}, ${control}, ${s.framework}, 'CC1.4', 'Requirement', 'applicable')`;
    const original: string[] = [];
    for (const probe of ['policy.current', 'policy.attested']) {
      const [a] = await sql`
        INSERT INTO bastion_assertions (organization_id, control_id, kind, probe_key, probe_version, params, predicate,
                                        plain_statement, proposed_by, review_status, confirmed_by, confirmed_at)
        VALUES (${s.org}, ${control}, 'probe', ${probe}, 1, '{}'::jsonb, '{}'::jsonb, ${`check ${probe}`}, 'library', 'confirmed', ${s.owner}, now())
        RETURNING id`;
      original.push(a!.id as string);
    }

    async function checkAndRank() {
      // An attestation already queues a run for the control it proves; otherwise queue one.
      await orgTx(sql, s.org, (tx) => queueControlRuns(tx, s.org, [control], engine.now(), s.owner));
      const live = await sql`SELECT id FROM bastion_evaluation_runs
                              WHERE organization_id = ${s.org} AND control_id = ${control} AND status IN ('queued', 'running')`;
      expect(live).toHaveLength(1);
      for (let i = 0; i < 30; i++) {
        const r = await runEvaluationSlice(engine, { organization_id: s.org, run_id: String(live[0]?.id), claimant: 'b37' });
        if (r.done) break;
      }
      await orgTx(sql, s.org, (tx) => rankOrgGaps(tx, s.org, engine.now()));
    }
    const openGaps = async () =>
      (await sql`SELECT gap_kind FROM bastion_gaps WHERE organization_id = ${s.org} AND control_id = ${control} AND status = 'open'`).map((g) => String(g.gap_kind));
    const topRows = async () =>
      (await readinessSummary(engine, owner, undefined, { storage_ok: true, offsite_backup_configured: true })).data.top_gaps.filter((g) => g.control_id === control);

    // Before any policy: both checks say "no policy linked", two stored gaps, ONE Readiness row.
    await checkAndRank();
    expect((await openGaps()).sort()).toEqual(['no_source', 'no_source']);
    expect(await topRows()).toHaveLength(1);
    expect(await unpinned(s.org)).toBe(control);

    // The policy article, shared with everyone, current in Beacon.
    const [e] = await sql`
      INSERT INTO beacon_entries (slug, title, body_markdown, version, status, visibility, created_by, owned_by, organization_id, expires_at, last_verified_at)
      VALUES (${`b37-policy-${Date.now()}`}, 'Island Information Security Policy', 'live', 1, 'Active', 'Organization',
              ${s.owner}, ${s.owner}, ${s.org}, now() + interval '200 days', now())
      RETURNING id`;
    const entry = e!.id as string;
    entries.push(entry);
    await sql`INSERT INTO beacon_versions (beacon_id, version, title, body_markdown)
              VALUES (${entry}, 1, 'Island Information Security Policy', ${'# Island policy\n\nLock the radio shack.'})`;

    // Linked the way the Policies page links it: no control named.
    const d: PolicyDeps = {
      engine,
      canAccess: async () => true,
      enqueueRuns: async () => {},
      pinChecks: pins.pinPolicyChecks,
    };
    const created = await createPolicy(d, owner, { beacon_entry_id: entry, audience: { kind: 'users', user_ids: people }, cadence_days: 365 });
    const policyId = created.data.id;
    expect(created.data.proposed_assertion_ids).toHaveLength(2);
    const proposed = await sql`SELECT id, probe_key, params, review_status, supersedes_id FROM bastion_assertions
                                WHERE organization_id = ${s.org} AND id = ANY(${created.data.proposed_assertion_ids}::uuid[])`;
    for (const a of proposed) {
      expect(a).toMatchObject({ review_status: 'proposed', params: { policy_id: policyId } });
      expect(original).toContain(a.supersedes_id);
    }
    // A person confirms them; the pinned checks replace the unpinned ones.
    for (const a of proposed) await assertions.confirmAssertion(owner, String(a.id), {});
    // Once pinned, a second policy linked without a control proves nothing by default.
    expect(await unpinned(s.org)).toBeNull();

    // Two of three read and acknowledge it.
    for (const person of people.slice(0, 2)) {
      const me = viewer(s.org, person);
      const body = await getPolicyBody(d, me, policyId);
      await attest(d, me, policyId, { beacon_version: body.data.beacon_version, body_sha256: body.data.body_sha256 });
    }

    await checkAndRank();
    const latest = await sql`
      SELECT DISTINCT ON (a.probe_key) a.probe_key, s.outcome, s.unprovable_reason
        FROM bastion_assertions a JOIN bastion_evidence_snapshots s ON s.assertion_id = a.id AND s.organization_id = a.organization_id
       WHERE a.organization_id = ${s.org} AND a.control_id = ${control} AND a.review_status = 'confirmed'
       ORDER BY a.probe_key, s.created_at DESC`;
    expect(latest.find((r) => r.probe_key === 'policy.attested')).toMatchObject({ outcome: 'fail', unprovable_reason: null });
    expect(latest.find((r) => r.probe_key === 'policy.current')?.unprovable_reason ?? null).toBeNull();
    const kinds = await openGaps();
    expect(kinds).toContain('failing');
    expect(kinds).not.toContain('no_source');
    const rows = await topRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.gap_kind).toBe('failing');
    const status = await sql`SELECT status FROM bastion_controls WHERE id = ${control}`;
    expect(status[0]?.status).toBe('fail');
  });
});

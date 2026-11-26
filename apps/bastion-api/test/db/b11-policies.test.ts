import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { evaluationMissed, retention } from '../../src/engine/sweeps.js';
import {
  attest,
  attestationNudge,
  createPolicy,
  getPolicyBody,
  listPolicies,
  myAttestations,
  type PolicyDeps,
  requestAttestations,
} from '../../src/services/policies.service.js';
import type { Viewer } from '../../src/services/types.js';
import { clock, DATABASE_URL, makeDeps, seedOrg, wipeOrg } from './engine-harness.js';

/**
 * Review batch 11, policies (live database): attesting is idempotent under a double submit
 * (#245).
 */

if (!DATABASE_URL) console.warn('[bastion-api/b11-policies] SKIPPING: DATABASE_URL is not set. Point it at a migrated database.');

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

const viewer = (org: string, id: string): Viewer => ({
  id,
  org_id: org,
  role: 'owner',
  is_superuser: false,
  impersonator_id: null,
  auth_method: 'session',
});

describe.skipIf(!DATABASE_URL)('batch 11: policies and attestation (live database)', () => {
  let sql: postgres.Sql;
  const orgs: string[] = [];
  const entries: string[] = [];

  beforeAll(() => {
    sql = postgres(DATABASE_URL!, { max: 8, onnotice: () => {} });
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
  });

  async function setUp(tag: string) {
    const s = await seedOrg(sql, `b11-${tag}`, 1, 1);
    orgs.push(s.org);
    const people: string[] = [];
    for (let i = 0; i < 2; i++) {
      const [u] = await sql`INSERT INTO users (org_id, email, display_name, password_hash, kind)
                            VALUES (${s.org}, ${`b11-${tag}-${i}-${Date.now()}@bigbluebam.internal`}, ${`Castaway ${i}`}, '!', 'human') RETURNING id`;
      people.push(u!.id as string);
      await sql`INSERT INTO organization_memberships (user_id, org_id) VALUES (${u!.id as string}, ${s.org})`;
    }
    const [e] = await sql`
      INSERT INTO beacon_entries (slug, title, body_markdown, version, status, visibility, created_by, owned_by, organization_id, expires_at, last_verified_at)
      VALUES (${`b11-policy-${tag}-${Date.now()}`}, 'Lagoon Acceptable Use Policy', 'live', 1, 'Active', 'Organization',
              ${s.owner}, ${s.owner}, ${s.org}, now() + interval '200 days', now())
      RETURNING id`;
    const entry = e!.id as string;
    entries.push(entry);
    await sql`INSERT INTO beacon_versions (beacon_id, version, title, body_markdown)
              VALUES (${entry}, 1, 'Lagoon Acceptable Use Policy', ${'# Lagoon policy\n\nNo swimming after dark.'})`;
    return { ...s, people, entry };
  }

  function deps(): PolicyDeps {
    return {
      engine: makeDeps(sql, { clock: clock() }),
      canAccess: async () => true,
      enqueueRuns: async () => {},
    };
  }

  /** Mark this org's outbox delivered 40 days ago and let bastion-retention prune it (as production does). */
  async function deliverAndPrune(org: string, engine: ReturnType<typeof makeDeps>) {
    await sql`UPDATE bastion_outbox SET status = 'delivered', delivered_at = now() - interval '40 days' WHERE organization_id = ${org}`;
    await retention(engine, { organization_id: org });
    expect(await sql`SELECT 1 FROM bastion_outbox WHERE organization_id = ${org}`).toHaveLength(0);
  }

  it('the nudge stays once per cadence after retention prunes the delivered outbox rows (#243)', async () => {
    const s = await setUp('nudge-retention');
    const c = clock();
    const d = { ...deps(), engine: makeDeps(sql, { clock: c }) };
    const owner = viewer(s.org, s.owner);
    await createPolicy(d, owner, { beacon_entry_id: s.entry, audience: { kind: 'all' }, cadence_days: 365 });
    // Keep the article inside its Beacon review date for the whole simulated year (#244).
    await sql`UPDATE beacon_entries SET expires_at = now() + interval '1000 days' WHERE id = ${s.entry}`;

    expect((await attestationNudge(d.engine, { organization_id: s.org })).nudged).toBe(3);
    await deliverAndPrune(s.org, d.engine);
    // A month later the outbox keys are gone; the durable markers still say "already nudged".
    c.offsetMs = 31 * 86_400_000;
    expect((await attestationNudge(d.engine, { organization_id: s.org })).nudged).toBe(0);
    c.offsetMs = 200 * 86_400_000;
    expect((await attestationNudge(d.engine, { organization_id: s.org })).nudged).toBe(0);
    // A full cadence after the last nudge (anchored to it, not to an epoch bucket): nudged again.
    c.offsetMs = 366 * 86_400_000;
    expect((await attestationNudge(d.engine, { organization_id: s.org })).nudged).toBe(3);
    expect((await attestationNudge(d.engine, { organization_id: s.org })).nudged).toBe(0);
  });

  it('evaluation.missed fires once per missed period however long it lasts, past outbox retention (#243)', async () => {
    const s = await setUp('missed');
    const c = clock();
    const engine = makeDeps(sql, { clock: c });
    c.offsetMs = 2 * 86_400_000;
    expect((await evaluationMissed(engine, { organization_id: s.org })).fired).toBe(1);
    await deliverAndPrune(s.org, engine);
    c.offsetMs = 40 * 86_400_000;
    expect((await evaluationMissed(engine, { organization_id: s.org })).fired).toBe(0);
  });

  it('a retired, expired or deleted Beacon article nudges nobody and accepts no attestation (#244)', async () => {
    const s = await setUp('article-state');
    const d = deps();
    const owner = viewer(s.org, s.owner);
    const policyId = (await createPolicy(d, owner, { beacon_entry_id: s.entry, audience: { kind: 'all' }, cadence_days: 365 })).data.id;
    const body = await getPolicyBody(d, owner, policyId);
    const good = { beacon_version: 1, body_sha256: body.data.body_sha256 };

    // Retired in Beacon after linking.
    await sql`UPDATE beacon_entries SET status = 'Retired' WHERE id = ${s.entry}`;
    const listed = (await listPolicies(d, owner, { status: 'active' })).data[0]!;
    expect(listed).toMatchObject({ article_state: 'retired', not_attested_count: 0, attestation_label: null });
    expect(listed.article_problem).toContain('retired or archived in Beacon');
    const nudge = await attestationNudge(d.engine, { organization_id: s.org });
    expect(nudge).toMatchObject({ nudged: 0, due_people: 0, unreadable_policies: 1 });
    await expect(attest(d, owner, policyId, good)).rejects.toMatchObject({ code: 'POLICY_ARTICLE_RETIRED' });
    await expect(getPolicyBody(d, owner, policyId)).rejects.toMatchObject({ code: 'POLICY_ARTICLE_RETIRED' });
    await expect(requestAttestations(d, owner, policyId, {})).rejects.toMatchObject({ code: 'POLICY_ARTICLE_RETIRED' });
    expect((await myAttestations(d, owner)).data[0]).toMatchObject({ due: false, article_state: 'retired' });
    expect(await sql`SELECT 1 FROM bastion_policy_attestations WHERE organization_id = ${s.org}`).toHaveLength(0);

    // Active again but past its Beacon review date.
    await sql`UPDATE beacon_entries SET status = 'Active', expires_at = now() - interval '1 day' WHERE id = ${s.entry}`;
    await expect(attest(d, owner, policyId, good)).rejects.toMatchObject({ code: 'POLICY_ARTICLE_EXPIRED' });
    expect((await attestationNudge(d.engine, { organization_id: s.org })).nudged).toBe(0);

    // Current again: everything works as before.
    await sql`UPDATE beacon_entries SET expires_at = now() + interval '100 days' WHERE id = ${s.entry}`;
    expect((await listPolicies(d, owner, { status: 'active' })).data[0]).toMatchObject({ article_state: 'current', article_problem: null, not_attested_count: 3 });
    expect((await attest(d, owner, policyId, good)).data.created).toBe(true);

    // Deleted in Beacon: a NULL version no longer makes the whole audience due.
    await sql`DELETE FROM beacon_versions WHERE beacon_id = ${s.entry}`;
    await sql`DELETE FROM beacon_entries WHERE id = ${s.entry}`;
    const gone = (await listPolicies(d, owner, { status: 'active' })).data[0]!;
    expect(gone).toMatchObject({ article_state: 'missing', not_attested_count: 0 });
    expect((await attestationNudge(d.engine, { organization_id: s.org })).nudged).toBe(0);
    const probe = (await sql.begin(async (raw) => {
      const tx = raw as unknown as postgres.Sql;
      await tx`SELECT set_config('app.current_org_id', ${s.org}, true)`;
      return tx`SELECT bastion_probe_policy_attested_v2(${s.org}::uuid, now(), ${JSON.stringify({ policy_id: policyId })}::text::jsonb) AS f`;
    }))[0]!.f as { summary: Record<string, unknown>; cited_count: number };
    expect(probe.summary).toMatchObject({ policy_found: true, article_state: 'missing' });
    expect(probe.cited_count).toBe(0);
  });

  it('a double submit of one attestation answers both requests, once created and once not, never a 500 (#245)', async () => {
    const s = await setUp('double');
    const d = deps();
    const owner = viewer(s.org, s.owner);
    const policyId = (await createPolicy(d, owner, { beacon_entry_id: s.entry, audience: { kind: 'all' }, cadence_days: 365 })).data.id;
    const body = await getPolicyBody(d, owner, policyId);
    const good = { beacon_version: 1, body_sha256: body.data.body_sha256 };

    const results = await Promise.allSettled([attest(d, owner, policyId, good), attest(d, owner, policyId, good), attest(d, owner, policyId, good)]);
    const failures = results.filter((r) => r.status === 'rejected').map((r) => String((r as PromiseRejectedResult).reason));
    expect(failures).toEqual([]);
    const values = results.map((r) => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof attest>>>).value.data);
    expect(values.filter((v) => v.created)).toHaveLength(1);
    expect(new Set(values.map((v) => (v as { id?: string }).id)).size).toBe(1);
    const rows = await sql`SELECT id FROM bastion_policy_attestations WHERE organization_id = ${s.org} AND policy_id = ${policyId}`;
    expect(rows).toHaveLength(1);
    // Exactly one ledger entry for the one attestation.
    const ledger = await sql`SELECT 1 FROM bastion_ledger_entries WHERE organization_id = ${s.org} AND entry_kind = 'attestation'`;
    expect(ledger).toHaveLength(1);
  });
});

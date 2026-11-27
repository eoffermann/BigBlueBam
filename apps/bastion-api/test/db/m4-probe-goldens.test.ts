import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { BASTION_PROBE_KEYS } from '@bigbluebam/shared';
import { makeRunInOrgScopeRead, type RunInOrgScopeRead } from '../../src/engine/read-scope.js';
import { decide, probeDefinition } from '../../src/probes/definitions.js';
import { runProbe } from '../../src/probes/run-probe.js';
import { DATABASE_URL, wipeOrg } from './engine-harness.js';

/**
 * Probe goldens, run three ways (spec 3.1, 11.2) with identical outcomes required:
 *
 *   1. as today: the primary pool, whose role bypasses RLS;
 *   2. RLS on: every probe transaction runs SET LOCAL ROLE to a NOBYPASSRLS role, so the 0116
 *      policies bind (they hide the sessions of users with no membership in the org, which is
 *      exactly the row access.departed_still_holding must see; the definer functions see it);
 *   3. a separate read pool (DATABASE_READ_URL pointing elsewhere), so the org guard is exercised
 *      through runInOrgScopeRead's own transaction, with the replica-lag check (NULL replay = 0).
 *
 * Fixture (committed, removed afterwards): an owner with a 120-day-old API key, a departed person
 * whose membership was removed but who still has a live session in the org, an enabled GitHub
 * integration whose subscribed_events is NULL with one unreviewed merge, and a population check
 * listing a repository that is not connected.
 * SKIPS LOUDLY without DATABASE_URL.
 */

if (!DATABASE_URL) {
  console.warn('[bastion-api/m4-probe-goldens] SKIPPING: DATABASE_URL is not set. Point it at a migrated database.');
}

const ROLE = 'bastion_rls_golden_test';
const REPO = 'castaway/lagoon-booking-site';
const MISSING_REPO = 'castaway/coral-reef-booking';

interface Case {
  key: string;
  params: Record<string, unknown>;
}

const CASES: Case[] = [
  ...BASTION_PROBE_KEYS.map((key) => ({ key, params: {} as Record<string, unknown> })),
  { key: 'change.merge_reviewed', params: { expected_population: [REPO] } },
  { key: 'change.merge_reviewed', params: { expected_population: [REPO, MISSING_REPO] } },
];

describe.skipIf(!DATABASE_URL)('M4 probe goldens three ways (live database)', () => {
  let sql: postgres.Sql;
  let readPool: postgres.Sql;
  let org = '';
  let owner = '';
  let departed = '';
  let staleKey = '';
  let mergeEvent = '';

  beforeAll(async () => {
    sql = postgres(DATABASE_URL!, { max: 4, onnotice: () => {} });
    readPool = postgres(DATABASE_URL!, { max: 2, onnotice: () => {} });
    const stamp = Date.now();
    org = (await sql`INSERT INTO organizations (name, slug) VALUES ('Bastion goldens', ${`bastion-goldens-${stamp}`}) RETURNING id`)[0]!.id as string;
    owner = (await sql`INSERT INTO users (org_id, email, display_name, password_hash, kind)
                       VALUES (${org}, ${`goldens-owner-${stamp}@bigbluebam.internal`}, 'Skipper', '!', 'human') RETURNING id`)[0]!.id as string;
    departed = (await sql`INSERT INTO users (org_id, email, display_name, password_hash, kind)
                          VALUES (${org}, ${`goldens-gone-${stamp}@bigbluebam.internal`}, 'Gone', '!', 'human') RETURNING id`)[0]!.id as string;
    await sql`INSERT INTO organization_memberships (user_id, org_id) VALUES (${owner}, ${org})`;
    // The departed person's membership was removed; their session in the org is still live.
    await sql`INSERT INTO sessions (id, user_id, expires_at, active_org_id, created_at)
              VALUES (${`goldens-${stamp}`}, ${departed}, now() + interval '7 days', ${org}, now() - interval '1 day')`;
    staleKey = (await sql`INSERT INTO api_keys (user_id, name, key_hash, key_prefix, org_id, created_at, last_used_at)
                          VALUES (${owner}, 'old', 'x', 'bbam_old', ${org}, now() - interval '120 days', now() - interval '1 day')
                          RETURNING id`)[0]!.id as string;
    const project = (await sql`INSERT INTO projects (org_id, name, slug) VALUES (${org}, 'Lagoon', ${`lagoon-${stamp}`}) RETURNING id`)[0]!.id as string;
    const integration = (await sql`INSERT INTO github_integrations (project_id, repo_owner, repo_name, webhook_secret, subscribed_events)
                                   VALUES (${project}, 'castaway', 'lagoon-booking-site', 'x', NULL) RETURNING id`)[0]!.id as string;
    mergeEvent = (await sql`
      INSERT INTO github_pr_events (org_id, integration_id, project_id, repo_owner, repo_name, delivery_id, event_type, action,
                                    pr_number, pr_author_login, base_ref, default_branch, merged, merged_at, task_refs, occurred_at)
      VALUES (${org}, ${integration}, ${project}, 'castaway', 'lagoon-booking-site', ${`m-${stamp}`}, 'pull_request', 'closed',
              42, 'gilligan', 'main', 'main', true, now() - interval '2 days', '{}', now() - interval '2 days')
      RETURNING id`)[0]!.id as string;
    await sql.unsafe(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROLE}') THEN
                        CREATE ROLE ${ROLE} NOLOGIN NOBYPASSRLS; END IF; END $$`);
    await sql.unsafe(`GRANT USAGE ON SCHEMA public TO ${ROLE}`);
    await sql.unsafe(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${ROLE}`);
    await sql.unsafe(`GRANT SELECT ON sessions, organization_memberships TO ${ROLE}`);
  });

  afterAll(async () => {
    if (!sql) return;
    if (org) {
      await sql`DELETE FROM github_pr_events WHERE org_id = ${org}`;
      await sql`DELETE FROM github_integrations WHERE project_id IN (SELECT id FROM projects WHERE org_id = ${org})`;
      await sql`DELETE FROM projects WHERE org_id = ${org}`;
      await sql`DELETE FROM sessions WHERE user_id = ${departed}`;
      await wipeOrg(sql, org);
    }
    await sql.unsafe(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROLE}') THEN
                        EXECUTE 'DROP OWNED BY ${ROLE}'; EXECUTE 'DROP ROLE ${ROLE}'; END IF; END $$`);
    await readPool.end();
    await sql.end();
  });

  async function runAll(runRead: RunInOrgScopeRead) {
    const out: Record<string, unknown> = {};
    const asOf = new Date();
    for (const [i, c] of CASES.entries()) {
      const def = probeDefinition(c.key)!;
      const res = await runProbe(runRead, def, org, asOf, c.params);
      if (!res.ok) throw new Error(`${c.key}: ${res.error}`);
      out[`${i}:${c.key}`] = {
        decision: decide(def, res.result, {}),
        cited: res.result.cited_refs.map((r) => r.entity_id).sort(),
        population_missing: res.result.population_missing ?? null,
      };
    }
    return out;
  }

  it('identical outcomes as today, with RLS enforced, and through a separate read pool', async () => {
    const plain = await runAll(makeRunInOrgScopeRead({ primary: sql, read: sql, statementTimeoutMs: 8000 }));
    const rlsOn = await runAll(
      makeRunInOrgScopeRead({
        primary: sql,
        read: sql,
        statementTimeoutMs: 8000,
        onBegin: async (tx) => {
          await tx.unsafe(`SET LOCAL ROLE ${ROLE}`);
        },
      }),
    );
    const separate = makeRunInOrgScopeRead({ primary: sql, read: readPool, statementTimeoutMs: 8000 });
    const viaReadPool = await runAll(separate);
    expect(rlsOn).toEqual(plain);
    expect(viaReadPool).toEqual(plain);

    // The read pool is a primary here (NULL replay timestamp), so lag is zero and it stays on it.
    const probe = await separate(org, new Date(), async () => 1);
    expect(probe).toMatchObject({ pool: 'read', replica_lag_ms: 0 });

    // The goldens themselves.
    expect(plain['2:access.departed_still_holding']).toMatchObject({ decision: { outcome: 'fail' }, cited: [departed] });
    expect(plain['0:keys.max_age']).toMatchObject({ decision: { outcome: 'fail' }, cited: [staleKey] });
    const reviewedIdx = CASES.findIndex((c) => c.key === 'change.merge_reviewed' && (c.params.expected_population as string[] | undefined)?.length === 1);
    expect(plain[`${reviewedIdx}:change.merge_reviewed`]).toMatchObject({ decision: { outcome: 'fail' }, cited: [mergeEvent] });
    const missingIdx = CASES.length - 1;
    expect(plain[`${missingIdx}:change.merge_reviewed`]).toMatchObject({
      decision: { outcome: 'unprovable', reason: 'source_not_connected' },
      population_missing: [MISSING_REPO],
    });
  });

  // Migration 0311 (#105) made sessions a per-user credential table with no org policy and RLS off,
  // so the RLS role now reads the departed user's session too; this used to assert it was hidden.
  // The probes stay definer functions for the org-scoped tables they also read.
  it('sessions are not org-scoped (0311): the RLS role sees the same session as the owner', async () => {
    const counts = await sql.begin(async (raw) => {
      const tx = raw as unknown as postgres.Sql;
      const asOwner = await tx`SELECT count(*)::int AS n FROM sessions WHERE user_id = ${departed}`;
      await tx.unsafe(`SET LOCAL ROLE ${ROLE}`);
      await tx`SELECT set_config('app.current_org_id', ${org}, true)`;
      const asRole = await tx`SELECT count(*)::int AS n FROM sessions WHERE user_id = ${departed}`;
      return { asOwner: asOwner[0]!.n, asRole: asRole[0]!.n };
    });
    expect(counts).toEqual({ asOwner: 1, asRole: 1 });
  });

  it('the org guard refuses a probe for another organization, whichever pool runs it', async () => {
    const other = '00000000-0000-4000-8000-0000ba57ffff';
    await expect(
      readPool.begin(async (raw) => {
        const tx = raw as unknown as postgres.Sql;
        await tx`SELECT set_config('app.current_org_id', ${org}, true)`;
        await tx.unsafe('SELECT bastion_probe_keys_max_age_v1($1::uuid, now(), $2::text::jsonb)', [other, '{}']);
      }),
    ).rejects.toThrow(/BASTION_PROBE_ORG_SCOPE/);
  });
});

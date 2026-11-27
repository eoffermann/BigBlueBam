import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { bastionEvidenceListQuerySchema, bastionEvidenceSnapshotListResponseSchema } from '@bigbluebam/shared';
import type { EngineDeps } from '../../src/engine/context.js';
import { runEvaluationSlice } from '../../src/engine/evaluator.js';
import { clock, DATABASE_URL, makeDeps, seedOrg, wipeOrg, type Clock, type SeededOrg } from './engine-harness.js';
import { expectWire } from './wire.js';

/**
 * Review batch 42, #403 (live database). Every evaluation run stores one snapshot per check, so
 * Control detail, which listed GET /controls/:id/evidence, showed each check once per run (the
 * GILLIGAN re-seeds start a run each, so "API keys" listed the same two results several times).
 * `latest=true` returns the newest snapshot of each confirmed check, once; the plain list keeps
 * the full history, which assertion_id narrows to one check.
 */

if (!DATABASE_URL) console.warn('[bastion-api/b42-evidence-latest] SKIPPING: DATABASE_URL is not set. Point it at a migrated database.');

const DAY = 86_400_000;

describe.skipIf(!DATABASE_URL)('batch 42: Control detail shows each check once (live database)', () => {
  let sql: postgres.Sql;
  const orgs: string[] = [];
  let evidence: typeof import('../../src/services/evidence.service.js');

  beforeAll(async () => {
    // env.ts validates at import (evidence.service reaches it through lib/keys).
    const hex = 'a'.repeat(64);
    Object.assign(process.env, {
      SESSION_SECRET: process.env.SESSION_SECRET ?? 's'.repeat(40),
      INTERNAL_SERVICE_SECRET: process.env.INTERNAL_SERVICE_SECRET ?? 'i'.repeat(40),
      BASTION_SEAL_SIGNING_KEY: process.env.BASTION_SEAL_SIGNING_KEY ?? hex,
      BASTION_PD_HMAC_KEY: process.env.BASTION_PD_HMAC_KEY ?? hex,
      BASTION_ROOM_IP_SALT: process.env.BASTION_ROOM_IP_SALT ?? hex,
      BASTION_FEED_KEY_PEPPER: process.env.BASTION_FEED_KEY_PEPPER ?? hex,
    });
    sql = postgres(String(DATABASE_URL), { max: 4, onnotice: () => {} });
    evidence = await import('../../src/services/evidence.service.js');
  });

  afterAll(async () => {
    if (!sql) return;
    for (const org of orgs) await wipeOrg(sql, org);
    await sql.end();
    const db = await import('../../src/db/index.js');
    for (const c of db.allConnections()) await c.end();
  });

  async function runToEnd(deps: EngineDeps, s: SeededOrg, c: Clock) {
    const [r] = await sql`INSERT INTO bastion_evaluation_runs (organization_id, trigger, scope, as_of, status)
                          VALUES (${s.org}, 'manual', 'all', ${c.now()}, 'queued') RETURNING id`;
    for (let i = 0; i < 20; i++) {
      const slice = await runEvaluationSlice(deps, { organization_id: s.org, run_id: r!.id as string, claimant: 'b42' });
      if (slice.done) break;
    }
    return r!.id as string;
  }

  it('three runs over two checks: latest lists each check once, from the newest run; history keeps all six', async () => {
    const s = await seedOrg(sql, 'b42-latest', 1, 2);
    orgs.push(s.org);
    const c = clock();
    const deps = makeDeps(sql, { clock: c });
    const runs: string[] = [];
    for (let i = 0; i < 3; i++) {
      runs.push(await runToEnd(deps, s, c));
      c.offsetMs += DAY;
    }
    const control = s.controls[0]!;
    const v = { id: s.owner, org_id: s.org, role: 'owner', is_superuser: false, impersonator_id: null, auth_method: 'session' as const };
    const all = async () => true;

    const history = await evidence.listControlEvidence(deps, v, control, { limit: 50 }, all);
    expect(history.data).toHaveLength(6);
    expect(new Set(history.data.map((r) => r.evaluation_run_id))).toEqual(new Set(runs));

    const query = bastionEvidenceListQuerySchema.parse({ latest: 'true' });
    const latest = await evidence.listControlEvidence(deps, v, control, query, all);
    expect(latest.data).toHaveLength(2);
    expect(latest.data.map((r) => r.assertion_id).sort()).toEqual([...s.assertions].sort());
    for (const r of latest.data) expect(r.evaluation_run_id).toBe(runs[2]);
    expect(latest.next_cursor).toBeNull();
    expectWire(bastionEvidenceSnapshotListResponseSchema, latest);

    // A check's own history: all three runs, newest first.
    const one = await evidence.listControlEvidence(deps, v, control, { assertion_id: s.assertions[0], limit: 50 }, all);
    expect(one.data.map((r) => r.evaluation_run_id)).toEqual([...runs].reverse());

    // A check that is no longer confirmed drops out of "latest"; its history stays.
    await sql`UPDATE bastion_assertions SET review_status = 'superseded' WHERE id = ${s.assertions[1]!}`;
    const after = await evidence.listControlEvidence(deps, v, control, query, all);
    expect(after.data.map((r) => r.assertion_id)).toEqual([s.assertions[0]]);
    expect((await evidence.listControlEvidence(deps, v, control, { limit: 50 }, all)).data).toHaveLength(6);
  });
});

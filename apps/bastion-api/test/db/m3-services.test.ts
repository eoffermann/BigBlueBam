import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import postgres from 'postgres';
import { templateControlKeys, crosswalk } from '../../src/library/index.js';
import { SOC2 } from '../../src/library/soc2.js';
import { ISO27001 } from '../../src/library/iso27001.js';

/**
 * The M3 gate against a real migrated database: SOC 2 then ISO 27001 share controls; the
 * deterministic compile proposes; per-requirement applicability completes the Statement of
 * Applicability; a population check needs "This is the complete list"; archiving retires only
 * single-framework controls.
 *
 * DB-backed: runs in CI's test job against the migrated service container; SKIPS LOUDLY without
 * DATABASE_URL. Uses a throwaway org (deleted afterwards; the org cascade removes every row).
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.warn('[bastion-api/m3-services] SKIPPING: DATABASE_URL is not set. Point it at a migrated database.');
}

const ORG = '00000000-0000-4000-8000-0000ba573001';
const USER = '00000000-0000-4000-8000-0000ba573002';

type Services = {
  frameworks: typeof import('../../src/services/frameworks.service.js');
  controls: typeof import('../../src/services/controls.service.js');
  assertions: typeof import('../../src/services/assertions.service.js');
  compile: typeof import('../../src/services/compile.service.js');
  setup: typeof import('../../src/services/setup.service.js');
};

// Generous per-test timeout: each case runs several org-scoped transactions, and under a loaded
// runner (parallel DB suites) a 5 s default produced timing-only failures.
describe.skipIf(!DATABASE_URL)('Bastion M3 services (live database)', { timeout: 60_000 }, () => {
  let sql: postgres.Sql;
  let s: Services;
  const viewer = {
    id: USER,
    org_id: ORG,
    role: 'owner',
    is_superuser: false,
    impersonator_id: null,
    auth_method: 'session' as const,
  };

  beforeAll(async () => {
    // env.ts validates at import; give it the secrets it insists on (never used here).
    const hex = 'a'.repeat(64);
    Object.assign(process.env, {
      SESSION_SECRET: process.env.SESSION_SECRET ?? 's'.repeat(40),
      INTERNAL_SERVICE_SECRET: process.env.INTERNAL_SERVICE_SECRET ?? 'i'.repeat(40),
      BASTION_SEAL_SIGNING_KEY: process.env.BASTION_SEAL_SIGNING_KEY ?? hex,
      BASTION_PD_HMAC_KEY: process.env.BASTION_PD_HMAC_KEY ?? hex,
      BASTION_ROOM_IP_SALT: process.env.BASTION_ROOM_IP_SALT ?? hex,
      BASTION_FEED_KEY_PEPPER: process.env.BASTION_FEED_KEY_PEPPER ?? hex,
    });
    sql = postgres(DATABASE_URL!, { max: 2 });
    await sql`DELETE FROM organizations WHERE id = ${ORG}`;
    await sql`INSERT INTO organizations (id, name, slug) VALUES (${ORG}, 'Bastion M3 Test', 'bastion-m3-test')`;
    await sql`INSERT INTO users (id, org_id, email, display_name, password_hash, is_active, is_superuser, email_verified, kind)
              VALUES (${USER}, ${ORG}, 'bastion-m3@bigbluebam.internal', 'M3', '!', true, false, true, 'human')`;
    s = {
      frameworks: await import('../../src/services/frameworks.service.js'),
      controls: await import('../../src/services/controls.service.js'),
      assertions: await import('../../src/services/assertions.service.js'),
      compile: await import('../../src/services/compile.service.js'),
      setup: await import('../../src/services/setup.service.js'),
    };
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`DELETE FROM users WHERE id = ${USER}`;
    await sql`DELETE FROM organizations WHERE id = ${ORG}`;
    await sql.end();
    const db = await import('../../src/db/index.js');
    for (const c of db.allConnections()) await c.end();
  });

  let soc2Id = '';
  let isoId = '';

  it('adopts SOC 2 and compiles proposed checks for every control', async () => {
    const adopted = await s.frameworks.adoptFramework(viewer, { template_key: 'soc2' });
    soc2Id = adopted.data.id;
    expect(adopted.data.controls_created).toBe(templateControlKeys(SOC2).length);
    const run = await s.compile.compileFramework(viewer, soc2Id);
    expect(run.data.status).toBe('succeeded');
    expect(run.data.used_fallback).toBe(true);
    expect(run.data.assertions_dropped).toBe(0);
    const list = await s.controls.listControls(viewer, { framework_id: soc2Id });
    expect(list.counts.not_set_up).toBe(templateControlKeys(SOC2).length);
    expect(list.data.every((c) => c.assertion_counts.proposed > 0)).toBe(true);
    // A second compile proposes nothing new.
    const again = await s.compile.compileFramework(viewer, soc2Id);
    expect(again.data.assertions_proposed).toBe(0);
  });

  it('adopting ISO 27001 second reuses the shared controls (the crosswalk)', async () => {
    const adopted = await s.frameworks.adoptFramework(viewer, { template_key: 'iso27001' });
    isoId = adopted.data.id;
    const isoKeys = templateControlKeys(ISO27001);
    const socKeys = new Set(templateControlKeys(SOC2));
    expect(adopted.data.controls_reused).toBe(isoKeys.filter((k) => socKeys.has(k)).length);
    expect(adopted.data.controls_created).toBe(isoKeys.filter((k) => !socKeys.has(k)).length);
    expect(crosswalk().length).toBe(adopted.data.controls_reused);
    await s.compile.compileFramework(viewer, isoId);

    const all = await s.controls.listControls(viewer, {});
    const mfa = all.data.find((c) => c.control_key === 'auth.mfa')!;
    expect(mfa.requirements.map((r) => r.ref_code)).toEqual(expect.arrayContaining(['CC6.1', 'A.5.17']));
  });

  it('completes the Statement of Applicability only when every Annex A requirement is decided', async () => {
    const before = await s.frameworks.getFramework(viewer, isoId);
    expect(before.data.statement_of_applicability?.complete).toBe(false);
    const physical = ['A.7.1', 'A.7.2', 'A.7.3', 'A.7.4', 'A.7.5', 'A.7.6', 'A.7.8', 'A.7.11', 'A.7.12', 'A.7.13'];
    await s.frameworks.decideApplicability(viewer, isoId, {
      decisions: ISO27001.requirements.map((r) =>
        physical.includes(r.ref_code)
          ? { ref_code: r.ref_code, applicability: 'not_applicable' as const, not_applicable_reason: 'No server room' }
          : { ref_code: r.ref_code, applicability: 'applicable' as const },
      ),
    });
    const after = await s.frameworks.getFramework(viewer, isoId);
    expect(after.data.statement_of_applicability?.complete).toBe(true);
    const iso = await s.controls.listControls(viewer, { framework_id: isoId });
    expect(iso.counts.not_applicable).toBe(1); // physical.premises: every ISO link excluded
    const soc = await s.controls.listControls(viewer, { framework_id: soc2Id });
    expect(soc.counts.not_applicable).toBe(0); // still applicable through CC6.4
    const csv = await s.frameworks.statementOfApplicabilityCsv(viewer, isoId);
    expect(csv.csv).toContain('A.7.1,');
    expect(csv.csv).toContain('No server room');
  });

  it('a population check needs a non-empty list and "This is the complete list"', async () => {
    const list = await s.controls.listControls(viewer, {});
    const peer = list.data.find((c) => c.control_key === 'change.peer_review')!;
    const as = await s.controls.listControlAssertions(viewer, peer.id);
    const proposed = as.data.find((a) => a.review_status === 'proposed')!;
    await expect(s.assertions.confirmAssertion(viewer, proposed.id, { population_confirmed: true })).rejects.toMatchObject({
      code: 'POPULATION_EMPTY',
    });
    const revised = await s.assertions.reviseAssertion(viewer, proposed.id, {
      expected_population: ['castaways/rescue-radio-firmware', 'castaways/lagoon-booking-site'],
    });
    await expect(s.assertions.confirmAssertion(viewer, revised.data.id, {})).rejects.toMatchObject({
      code: 'POPULATION_CONFIRMATION_REQUIRED',
    });
    const ok = await s.assertions.confirmAssertion(viewer, revised.data.id, { population_confirmed: true });
    expect(ok.data.review_status).toBe('confirmed');
    expect(ok.data.population?.confirmed_by).toBe(USER);
    expect(ok.data.population?.members).toHaveLength(2);
    await expect(s.assertions.confirmAssertion(viewer, revised.data.id, {})).rejects.toMatchObject({
      code: 'ASSERTION_NOT_PROPOSED',
    });
    const counts = (await s.controls.listControls(viewer, { framework_id: soc2Id })).counts;
    expect(counts.set_up).toBe(1);
  });

  it('#193: a committed inline run with an old heartbeat is released and the next compile succeeds', async () => {
    const [stale] = await sql`
      INSERT INTO bastion_compile_runs (organization_id, framework_id, status, used_fallback, claimed_by, heartbeat_at, started_by, started_at)
      VALUES (${ORG}, ${soc2Id}, 'running', true, 'bastion-api:inline', now() - interval '1 hour', ${USER}, now() - interval '1 hour')
      RETURNING id`;
    const run = await s.compile.compileFramework(viewer, soc2Id);
    expect(run.data.status).toBe('succeeded');
    const [after] = await sql`SELECT status, error, completed_at FROM bastion_compile_runs WHERE id = ${stale!.id}`;
    expect(after!.status).toBe('failed');
    expect(after!.completed_at).not.toBeNull();
    expect(String(after!.error)).toMatch(/stopped before it finished/);
  });

  it('#193: a live inline run (fresh heartbeat) still blocks a second compile with 409', async () => {
    const [live] = await sql`
      INSERT INTO bastion_compile_runs (organization_id, framework_id, status, used_fallback, claimed_by, heartbeat_at, started_by, started_at)
      VALUES (${ORG}, ${soc2Id}, 'running', true, 'bastion-api:inline', now(), ${USER}, now())
      RETURNING id`;
    try {
      await expect(s.compile.compileFramework(viewer, soc2Id)).rejects.toMatchObject({ code: 'COMPILE_RUNNING' });
      // The refused attempt left no row of its own behind.
      const [{ n }] = (await sql`
        SELECT count(*)::int AS n FROM bastion_compile_runs
         WHERE framework_id = ${soc2Id} AND status IN ('queued', 'running')`) as unknown as [{ n: number }];
      expect(n).toBe(1);
    } finally {
      await sql`UPDATE bastion_compile_runs SET status = 'failed', completed_at = now() WHERE id = ${live!.id}`;
    }
  });

  it('#193: a refused compile (unknown framework) records nothing and leaves nothing running', async () => {
    // The failure-after-claim path (rollback, failed run recorded, a failed record logged) is
    // unit-tested with a stubbed transaction in test/compile-atomic.test.ts.
    const warn = vi.fn();
    const before = (await sql`SELECT count(*)::int AS n FROM bastion_compile_runs WHERE organization_id = ${ORG}`)[0]!.n;
    await expect(
      s.compile.compileFramework(viewer, '00000000-0000-4000-8000-00000000dead', { warn }),
    ).rejects.toMatchObject({ name: 'NotFoundError' });
    const after = (await sql`SELECT count(*)::int AS n FROM bastion_compile_runs WHERE organization_id = ${ORG}`)[0]!.n;
    expect(after).toBe(before);
    expect(warn).not.toHaveBeenCalled();
    const active = await sql`SELECT id FROM bastion_compile_runs WHERE organization_id = ${ORG} AND status IN ('queued', 'running')`;
    expect(active).toHaveLength(0);
  });

  it('#193: compile-run history is cursor-paginated and says when there is more', async () => {
    const first = await s.compile.listCompileRuns(viewer, soc2Id, { limit: 2 });
    expect(first.data).toHaveLength(2);
    expect(first.has_more).toBe(true);
    expect(first.next_cursor).toEqual(expect.any(String));
    const all = await s.compile.listCompileRuns(viewer, soc2Id, { limit: 200 });
    expect(all.has_more).toBe(false);
    expect(all.next_cursor).toBeNull();
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await s.compile.listCompileRuns(viewer, soc2Id, { limit: 2, cursor });
      seen.push(...page.data.map((r) => r.id));
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual(all.data.map((r) => r.id));
    await expect(s.compile.listCompileRuns(viewer, soc2Id, { cursor: 'not-a-cursor' })).rejects.toMatchObject({
      code: 'INVALID_CURSOR',
    });
  });

  it('#191: linking a Compliance project needs membership of it (SuperUser bypass), else the same 404', async () => {
    const [restricted] = await sql`
      INSERT INTO projects (org_id, name, slug) VALUES (${ORG}, 'M&A Project Falcon', 'bastion-m3-falcon') RETURNING id`;
    const [mine] = await sql`
      INSERT INTO projects (org_id, name, slug) VALUES (${ORG}, 'Compliance', 'bastion-m3-compliance') RETURNING id`;
    await sql`INSERT INTO project_memberships (project_id, user_id, role) VALUES (${mine!.id}, ${USER}, 'admin')`;
    // #229: a project with no open phase cannot take tasks, so it is refused in plain words.
    await expect(s.setup.setComplianceProject(viewer, { project_id: mine!.id })).rejects.toMatchObject({ code: 'PROJECT_HAS_NO_OPEN_PHASE' });
    await sql`INSERT INTO phases (project_id, name, position, is_start) VALUES (${mine!.id}, 'To do', 0, true), (${restricted!.id}, 'To do', 0, true)`;
    const notMember = s.setup.setComplianceProject(viewer, { project_id: restricted!.id });
    await expect(notMember).rejects.toMatchObject({ name: 'NotFoundError' });
    await expect(notMember).rejects.toThrow('We could not find that project in your organization.');
    await expect(
      s.setup.setComplianceProject(viewer, { project_id: '00000000-0000-4000-8000-00000000beef' }),
    ).rejects.toThrow('We could not find that project in your organization.');
    const ok = await s.setup.setComplianceProject(viewer, { project_id: mine!.id });
    expect(ok.data.compliance_project.name).toBe('Compliance');
    const su = await s.setup.setComplianceProject({ ...viewer, is_superuser: true }, { project_id: restricted!.id });
    expect(su.data.compliance_project.id).toBe(restricted!.id);
    await s.setup.setComplianceProject(viewer, { project_id: mine!.id });
  });

  it('#195: an app list accepts only the org\'s tracked apps and labels them by name', async () => {
    const [app] = await sql`
      INSERT INTO blip_tracked_apps (org_id, name) VALUES (${ORG}, 'Lagoon Booking Site') RETURNING id`;
    const list = await s.controls.listControls(viewer, {});
    let target: { id: string } | undefined;
    for (const c of list.data) {
      const as = await s.controls.listControlAssertions(viewer, c.id);
      target = as.data.find((a) => a.review_status === 'proposed' && a.population?.kind === 'blip_apps');
      if (target) break;
    }
    expect(target).toBeDefined();
    await expect(
      s.assertions.reviseAssertion(viewer, target!.id, { expected_population: ['00000000-0000-4000-8000-00000000cafe'] }),
    ).rejects.toMatchObject({ code: 'UNKNOWN_POPULATION_MEMBER' });
    const revised = await s.assertions.reviseAssertion(viewer, target!.id, { expected_population: [app!.id] });
    expect(revised.data.population?.members).toEqual([{ value: app!.id, label: 'Lagoon Booking Site' }]);
    // Removing the only member is a revision too; confirming an empty list stays refused.
    const emptied = await s.assertions.reviseAssertion(viewer, revised.data.id, { expected_population: [] });
    expect(emptied.data.population?.members).toEqual([]);
    await expect(s.assertions.confirmAssertion(viewer, emptied.data.id, { population_confirmed: true })).rejects.toMatchObject({
      code: 'POPULATION_EMPTY',
    });
  });

  it('#195: a repository list refuses anything that is not owner/name', async () => {
    const list = await s.controls.listControls(viewer, {});
    let target: { id: string } | undefined;
    for (const c of list.data) {
      const as = await s.controls.listControlAssertions(viewer, c.id);
      target = as.data.find((a) => a.review_status === 'proposed' && a.population?.kind === 'github_repos');
      if (target) break;
    }
    expect(target).toBeDefined();
    await expect(
      s.assertions.reviseAssertion(viewer, target!.id, { expected_population: ['not a repo'] }),
    ).rejects.toMatchObject({ code: 'INVALID_POPULATION_MEMBER' });
    const ok = await s.assertions.reviseAssertion(viewer, target!.id, { expected_population: ['Castaways/Radio-Relay'] });
    expect(ok.data.population?.members).toEqual([{ value: 'castaways/radio-relay', label: 'Castaways/Radio-Relay' }]);
  });

  it('archiving SOC 2 retires only the controls nothing else needs', async () => {
    const socKeys = templateControlKeys(SOC2);
    const isoKeys = new Set(templateControlKeys(ISO27001));
    const archived = await s.frameworks.archiveFramework(viewer, soc2Id);
    expect(archived.data.controls_retired).toBe(socKeys.filter((k) => !isoKeys.has(k)).length);
    const retired = await s.controls.listControls(viewer, { lifecycle: 'retired' });
    expect(retired.data.map((c) => c.control_key)).toContain('risk.assessment');
  });
});

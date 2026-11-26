import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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

describe.skipIf(!DATABASE_URL)('Bastion M3 services (live database)', () => {
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
    await db.connection.end();
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

  it('archiving SOC 2 retires only the controls nothing else needs', async () => {
    const socKeys = templateControlKeys(SOC2);
    const isoKeys = new Set(templateControlKeys(ISO27001));
    const archived = await s.frameworks.archiveFramework(viewer, soc2Id);
    expect(archived.data.controls_retired).toBe(socKeys.filter((k) => !isoKeys.has(k)).length);
    const retired = await s.controls.listControls(viewer, { lifecycle: 'retired' });
    expect(retired.data.map((c) => c.control_key)).toContain('risk.assessment');
  });
});

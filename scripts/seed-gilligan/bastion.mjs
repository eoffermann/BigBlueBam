/**
 * Gilligan's Island themed Bastion (continuous compliance evidence) seed, M3 rows.
 *
 * Gilligan Travel Ltd is preparing for its first SOC 2 review (Thurston Howell III's holding
 * company insists) and Howell's European subsidiary has asked about ISO 27001 too. Skipper owns
 * the program. This seeder drives bastion-api THROUGH ITS API as Skipper:
 *   - adopts SOC 2, runs the setup compile, answers the ten profile questions;
 *   - creates (or reuses) the "Compliance" Bam project and records it as Bastion's task project;
 *   - adopts ISO 27001 second (it reuses the shared controls), compiles, and decides all 93
 *     Annex A requirements, marking the ten premises requirements not applicable;
 *   - confirms every proposed check except on four controls, so "Not set up yet: 4" shows,
 *     including the GitHub population of two repositories confirmed as the complete list.
 *
 * Confirming is a vouching act: bastion-api refuses API keys there (403 SESSION_REQUIRED), so
 * the seeder signs in as Skipper (POST /auth/login on the Bam API) and confirms with that real
 * cookie session. Everything else uses Skipper's API key from GKEYS.
 *
 * Runs INSIDE the api container (`docker compose exec -T api node -`), registered LAST in
 * run-all.mjs (phase "Compliance") because it needs Bam and Blip data from earlier phases.
 * run-all injects BASTION_EXPECTATIONS (scripts/seed-gilligan/bastion.expectations.mjs), the one
 * source for the numbers; this seeder reads the counts back and exits non-zero on a mismatch.
 * Idempotent: every step is find-or-create. Gilligan org only; never the generic e2e org.
 */

import postgres from 'postgres';

const BASTION = 'http://bastion-api:4024/v1';
const BAM = 'http://localhost:4000';
const KEYS = JSON.parse(process.env.GKEYS || '{}');
const EXP = JSON.parse(process.env.BASTION_EXPECTATIONS || '{}');
const PASSWORD = 'Castaway2026!';

if (!EXP.frameworks) {
  console.error('BASTION_EXPECTATIONS is missing. Run this through scripts/seed-gilligan/run-all.mjs.');
  process.exit(1);
}
if (!KEYS.skipper) {
  console.error('GKEYS has no key for skipper. Run this through scripts/seed-gilligan/run-all.mjs.');
  process.exit(1);
}

const t0 = Date.now();
const log = (msg) => console.log(`[bastion +${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);

let sessionCookie = null;

async function call(base, method, path, body, { session = false } = {}) {
  const headers = {};
  if (session) headers.Cookie = sessionCookie;
  else headers.Authorization = `Bearer ${KEYS.skipper}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  return { ok: r.ok, status: r.status, json, code: json?.error?.code ?? null };
}

const bastion = (method, path, body, opts) => call(BASTION, method, path, body, opts);
const bam = (method, path, body) => call(BAM, method, path, body);

function must(res, what) {
  if (!res.ok) {
    throw new Error(`${what} failed (${res.status} ${res.code ?? ''}): ${JSON.stringify(res.json).slice(0, 300)}`);
  }
  return res.json;
}

async function login() {
  const r = await fetch(`${BAM}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EXP.actorEmail, password: PASSWORD }),
  });
  const raw =
    typeof r.headers.getSetCookie === 'function'
      ? r.headers.getSetCookie()
      : r.headers.get('set-cookie')
        ? [r.headers.get('set-cookie')]
        : [];
  for (const line of raw) {
    const [pair] = line.split(';');
    if (pair.startsWith('session=')) sessionCookie = pair.trim();
  }
  if (!r.ok || !sessionCookie) {
    throw new Error(`Skipper could not sign in (${r.status}); confirming checks needs a real session.`);
  }
}

async function adoptAndCompile(templateKey) {
  const setup = must(await bastion('GET', '/setup'), 'GET /setup').data;
  let fw = setup.frameworks.find((f) => f.template_key === templateKey);
  if (!fw) {
    log(`adopting ${templateKey}...`);
    const r = await bastion('POST', '/frameworks', { template_key: templateKey });
    if (r.status === 409 && r.code === 'FRAMEWORK_ALREADY_ADOPTED') {
      fw = must(await bastion('GET', '/frameworks'), 'GET /frameworks').data.find((f) => f.template_key === templateKey);
    } else {
      fw = must(r, `adopt ${templateKey}`).data;
    }
  } else {
    log(`${templateKey} already adopted`);
  }
  const latest = setup.frameworks.find((f) => f.id === fw.id)?.latest_compile_run;
  if (latest?.status === 'succeeded') {
    log(`${templateKey} already compiled`);
  } else {
    log(`compiling ${templateKey} (deterministic, a few seconds)...`);
    const run = must(await bastion('POST', `/frameworks/${fw.id}/compile`, {}), `compile ${templateKey}`).data;
    log(`  ${run.assertions_proposed} checks proposed, ${run.assertions_dropped} dropped`);
  }
  return fw.id;
}

async function ensureComplianceProject() {
  log('Compliance project...');
  const list = must(await bam('GET', '/projects'), 'GET /projects').data ?? [];
  let project = list.find((p) => p.name === EXP.complianceProject.name);
  if (!project) {
    project = must(
      await bam('POST', '/projects', {
        name: EXP.complianceProject.name,
        task_id_prefix: EXP.complianceProject.taskIdPrefix,
        description: 'Tasks Bastion files when a control needs attention.',
      }),
      'create Compliance project',
    ).data;
    log(`  created project "${project.name}"`);
  } else {
    log(`  reusing project "${project.name}"`);
  }
  must(await bastion('POST', '/setup/compliance-project', { project_id: project.id }), 'set compliance project');
}

async function decideIsoApplicability(isoId) {
  log('ISO applicability (93 decisions)...');
  const reqs = must(await bastion('GET', `/frameworks/${isoId}/requirements`), 'GET requirements');
  if (reqs.statement_of_applicability?.complete) {
    log('  already decided');
    return;
  }
  const na = new Set(EXP.iso.notApplicableRefs);
  const decisions = reqs.data.map((r) =>
    na.has(r.ref_code)
      ? { ref_code: r.ref_code, applicability: 'not_applicable', not_applicable_reason: EXP.iso.notApplicableReason }
      : { ref_code: r.ref_code, applicability: 'applicable' },
  );
  must(await bastion('POST', `/frameworks/${isoId}/applicability`, { decisions }), 'decide applicability');
}

async function blipAppsLabels() {
  const sql = postgres(process.env.DATABASE_URL, { max: 1 });
  try {
    const rows = await sql`
      SELECT a.id::text AS value, a.name AS label
        FROM blip_tracked_apps a JOIN organizations o ON o.id = a.org_id
       WHERE o.slug = ${EXP.org.slug}
       ORDER BY a.name`;
    return rows;
  } finally {
    await sql.end();
  }
}

/** Revise a population check to `members` if it differs, and return the id to confirm. */
async function settlePopulation(assertion, members) {
  const have = (assertion.population?.members ?? []).map((m) => m.value).sort();
  const want = members.map((m) => m.value).sort();
  if (JSON.stringify(have) === JSON.stringify(want)) return assertion.id;
  const revised = must(
    await bastion('POST', `/assertions/${assertion.id}/revise`, {
      expected_population: want,
      params: { population_labels: Object.fromEntries(members.map((m) => [m.value, m.label])) },
    }),
    'revise population',
  ).data;
  return revised.id;
}

async function confirmChecks() {
  log('confirming proposed checks as Skipper (session)...');
  const controls = must(await bastion('GET', '/controls'), 'GET /controls').data;
  const left = new Set(EXP.leftUnconfirmed);
  const repoMembers = EXP.githubPopulation.repos.map((r) => ({ value: r, label: r }));
  let confirmed = 0;
  for (const c of controls) {
    if (left.has(c.control_key) || c.assertion_counts.proposed === 0) continue;
    const list = must(await bastion('GET', `/controls/${c.id}/assertions`), 'GET assertions').data;
    for (const a of list.filter((x) => x.review_status === 'proposed')) {
      let id = a.id;
      let body = {};
      if (a.population) {
        let members;
        if (a.population.kind === 'github_repos') {
          members = repoMembers;
        } else if (a.population.members.length > 0) {
          members = a.population.members;
        } else {
          members = await blipAppsLabels();
          if (members.length === 0) {
            throw new Error('No Blip tracked apps exist for Gilligan Travel Ltd; run blip.mjs before bastion.mjs.');
          }
        }
        id = await settlePopulation(a, members);
        body = { population_confirmed: true };
      }
      const r = await bastion('POST', `/assertions/${id}/confirm`, body, { session: true });
      if (r.status === 409 && r.code === 'ASSERTION_NOT_PROPOSED') continue;
      must(r, `confirm check on ${c.control_key}`);
      confirmed += 1;
    }
  }
  log(`  ${confirmed} checks confirmed`);
}

async function verify(ids) {
  const problems = [];
  const parts = [];
  for (const f of EXP.frameworks) {
    const r = must(await bastion('GET', `/controls?framework_id=${ids[f.templateKey]}`), 'GET /controls').counts;
    parts.push(`${f.name}: ${r.set_up} set up, not set up ${r.not_set_up}, not applicable ${r.not_applicable}`);
    if (r.not_set_up !== f.notSetUp) problems.push(`${f.name} not set up ${r.not_set_up}, expected ${f.notSetUp}`);
    if (r.not_applicable !== f.notApplicable) problems.push(`${f.name} not applicable ${r.not_applicable}, expected ${f.notApplicable}`);
    if (r.set_up !== f.setUp) problems.push(`${f.name} set up ${r.set_up}, expected ${f.setUp}`);
  }
  log(parts.join(' | '));
  if (problems.length) throw new Error(`seeded numbers do not match BASTION_SEED_EXPECTATIONS: ${problems.join('; ')}`);
}

async function main() {
  log('Bastion seed (M3) starting...');
  await login();
  const ids = {};
  ids.soc2 = await adoptAndCompile('soc2');
  log('company profile (ten answers)...');
  must(await bastion('PATCH', '/setup/profile', EXP.companyProfile), 'save profile');
  await ensureComplianceProject();
  ids.iso27001 = await adoptAndCompile('iso27001');
  await decideIsoApplicability(ids.iso27001);
  await confirmChecks();
  await verify(ids);
  log('Bastion seed done');
}

main().catch((err) => {
  console.error(`[bastion] FAILED: ${err.message}`);
  process.exit(1);
});

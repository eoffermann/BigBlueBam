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
 * M5 rows (spec 10.2):
 *   - the Professor uploads the Google Workspace 2-Step Verification report to Bin and attaches
 *     it (valid 12 more days); Skipper accepts it, so two-step sign-in is "Proven by evidence you
 *     provided" and the report shows "expires in 12 days";
 *   - Mary Ann writes the background-check statement (self-attested); Skipper accepts it;
 *   - laptop encryption gets nothing, so it stays "Can't prove yet";
 *   - the "Crew roster export" feed gets a key and one record per castaway;
 *   - one full evaluation so Readiness shows real numbers.
 * Uploading and accepting are vouching acts too, so the Professor, Mary Ann and Skipper each sign
 * in for theirs.
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

async function call(base, method, path, body, { session = false, as = 'skipper' } = {}) {
  const headers = {};
  // `session` is true (Skipper's signed-in session) or a cookie string for another castaway.
  if (session) headers.Cookie = session === true ? sessionCookie : session;
  else headers.Authorization = `Bearer ${KEYS[as]}`;
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

/** Sign a castaway in on the Bam API and return the session cookie (vouching needs a session). */
async function loginAs(email) {
  const r = await fetch(`${BAM}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const raw =
    typeof r.headers.getSetCookie === 'function'
      ? r.headers.getSetCookie()
      : r.headers.get('set-cookie')
        ? [r.headers.get('set-cookie')]
        : [];
  let cookie = null;
  for (const line of raw) {
    const [pair] = line.split(';');
    if (pair.startsWith('session=')) cookie = pair.trim();
  }
  if (!r.ok || !cookie) {
    throw new Error(`${email} could not sign in (${r.status}); vouching for evidence needs a real session.`);
  }
  return cookie;
}

async function login() {
  sessionCookie = await loginAs(EXP.actorEmail);
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

// ── M5: uploaded and self-attested evidence, the feed, a fresh evaluation ─────────────────

const BIN = 'http://bin-api:4016/v1';
const BASTION_INTERNAL = 'http://bastion-api:4024/v1/internal';

async function withDb(fn) {
  const sql = postgres(process.env.DATABASE_URL, { max: 1 });
  try {
    return await fn(sql);
  } finally {
    await sql.end();
  }
}

/** The local date `days` from now in the org's Bastion time zone (valid_until is a local date). */
async function localDatePlus(days) {
  const tz = await withDb(async (sql) => {
    const r = await sql`SELECT s.timezone FROM bastion_org_settings s JOIN organizations o ON o.id = s.organization_id WHERE o.slug = ${EXP.org.slug}`;
    return r[0]?.timezone ?? 'UTC';
  });
  const at = new Date(Date.now() + days * 86_400_000);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** The confirmed manual check on a control (the M3 compile proposed it from the library). */
async function manualCheckOf(controlKey) {
  const controls = must(await bastion('GET', '/controls'), 'GET /controls').data;
  const control = controls.find((c) => c.control_key === controlKey);
  if (!control) throw new Error(`control ${controlKey} is missing; run the M3 part first`);
  const list = must(await bastion('GET', `/controls/${control.id}/assertions`), 'GET assertions').data;
  const check = list.find((a) => a.kind === 'manual' && a.review_status === 'confirmed');
  if (!check) throw new Error(`control ${controlKey} has no confirmed manual check`);
  return { control, check };
}

/** The Professor uploads the report bytes to Bin (as a seed file it is marked clean, as bin.mjs does). */
async function uploadToBin(role, name, text) {
  const auth = { Authorization: `Bearer ${KEYS[role]}` };
  const cr = await fetch(`${BIN}/assets`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, content_type: 'application/pdf', visibility: 'organization', tags: ['compliance'] }),
  });
  const cd = await cr.json().catch(() => ({}));
  if (!cr.ok) throw new Error(`Bin POST /assets -> ${cr.status} ${JSON.stringify(cd).slice(0, 200)}`);
  const fd = new FormData();
  fd.append('file', new Blob([text], { type: 'application/pdf' }), name);
  const ur = await fetch(`${BIN}/assets/${cd.data.id}/upload`, { method: 'POST', headers: auth, body: fd });
  const ud = await ur.json().catch(() => ({}));
  if (!ur.ok) throw new Error(`Bin upload -> ${ur.status} ${JSON.stringify(ud).slice(0, 200)}`);
  await withDb((sql) => sql`UPDATE bin_assets SET scan_status = 'clean' WHERE id = ${cd.data.id}`);
  return cd.data.id;
}

/** Find the current item for a check by title, or null. */
async function currentItem(checkId, title) {
  const list = must(await bastion('GET', `/manual-evidence?assertion_id=${checkId}`), 'GET /manual-evidence').data;
  return list.find((e) => e.title === title && (e.status === 'active' || e.status === 'pending_scan')) ?? null;
}

async function acceptAsSkipper(item, checkId) {
  const link = item.links.find((l) => l.assertion_id === checkId);
  if (link?.review_verdict === 'accepted') return;
  must(
    await bastion('POST', `/manual-evidence/${item.id}/links/${checkId}/review`, { verdict: 'accepted', note: 'Checked against the source system.' }, { session: true }),
    `Skipper accepts "${item.title}"`,
  );
}

async function seedTwoStep() {
  const t = EXP.m5.twoStep;
  log('2-Step report (the Professor uploads, Skipper accepts)...');
  const { check } = await manualCheckOf(t.controlKey);
  let item = await currentItem(check.id, t.title);
  if (item && item.days_left === t.daysLeft) {
    log('  already uploaded with the expected expiry');
  } else {
    const professor = await loginAs(t.uploaderEmail);
    const assetId = await uploadToBin(
      t.uploaderRole,
      t.fileName,
      '%PDF-1.4 Google Workspace admin report: 2-Step Verification enrollment and enforcement. Users: 7. Enrolled: 7. Enforced: 7.',
    );
    const body = {
      kind: 'file',
      bin_asset_id: assetId,
      title: t.title,
      description: 'Admin console export showing 2-Step Verification enforced for every account.',
      source_system: t.sourceSystem,
      owner_user_id: (await withDb((sql) => sql`SELECT id FROM users WHERE email = ${t.uploaderEmail}`))[0].id,
      produced_on: await localDatePlus(-t.producedDaysAgo),
      period_start: await localDatePlus(-30),
      period_end: await localDatePlus(-t.producedDaysAgo),
      valid_until: await localDatePlus(t.daysLeft),
      sensitivity: 'standard',
      uploader_statement: true,
      assertion_ids: [check.id],
    };
    // A re-seed on a later day replaces the old copy so the story's "12 days" holds again.
    const path = item ? `/manual-evidence/${item.id}/supersede` : '/manual-evidence';
    item = must(await bastion('POST', path, body, { session: professor }), 'upload the 2-Step report').data;
    log(`  uploaded (${item.status}), expires in ${item.days_left} days`);
  }
  await acceptAsSkipper(item, check.id);
}

async function seedBackgroundChecks() {
  const b = EXP.m5.backgroundChecks;
  log("Mary Ann's background-check statement (self-attested, Skipper accepts)...");
  const { check } = await manualCheckOf(b.controlKey);
  let item = await currentItem(check.id, b.title);
  if (!item) {
    const mary = await loginAs(b.authorEmail);
    item = must(
      await bastion(
        'POST',
        '/manual-evidence',
        {
          kind: 'attestation_statement',
          statement: b.statement,
          title: b.title,
          source_system: b.sourceSystem,
          owner_user_id: (await withDb((sql) => sql`SELECT id FROM users WHERE email = ${b.authorEmail}`))[0].id,
          produced_on: await localDatePlus(0),
          valid_until: await localDatePlus(b.validDays),
          sensitivity: 'standard',
          uploader_statement: true,
          assertion_ids: [check.id],
        },
        { session: mary },
      ),
      'write the background-check statement',
    ).data;
  } else {
    log('  already written');
  }
  await acceptAsSkipper(item, check.id);
}

async function seedFeed() {
  const f = EXP.m5.feed;
  log('"Crew roster export" feed with a key...');
  const feeds = must(await bastion('GET', '/feeds'), 'GET /feeds').data;
  let feed = feeds.find((x) => x.feed_key === f.feedKey);
  if (!feed) {
    feed = must(
      await bastion('POST', '/feeds', { feed_key: f.feedKey, label: f.label, feed_kind: f.feedKind, source_kind: 'api_push', cadence_days: f.cadenceDays }),
      'create the feed',
    ).data;
  }
  const records = must(await bastion('GET', `/feeds/${feed.id}/records?limit=50`), 'GET feed records').data;
  const keys = must(await bastion('GET', `/feeds/${feed.id}/keys`), 'GET feed keys').data;
  if (records.length >= f.records.length && keys.some((k) => k.usable)) {
    log(`  already has a key and ${records.length} records`);
    return;
  }
  // The token is shown once, so a re-seed that needs to push mints a fresh one (the old key
  // stays usable for its seven-day grace window).
  const key = must(await bastion('POST', `/feeds/${feed.id}/keys`, { label: f.keyLabel }), 'mint a feed key').data;
  const castaways = await withDb(
    (sql) => sql`SELECT u.email, u.display_name FROM users u JOIN organizations o ON o.id = u.org_id WHERE o.slug = ${EXP.org.slug}`,
  );
  const byPrefix = (role) => castaways.find((c) => c.email.startsWith(`${role}@`));
  const occurred = new Date().toISOString();
  const r = await fetch(`${BASTION}/feeds/${f.feedKey}/records`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      records: f.records.map((role) => ({
        idempotency_key: `crew-${role}`,
        occurred_at: occurred,
        subject: byPrefix(role)?.email ?? `${role}@gilligantravel.example`,
        attributes: { name: byPrefix(role)?.display_name ?? role, on_roster: true },
      })),
    }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`feed push -> ${r.status} ${JSON.stringify(body).slice(0, 200)}`);
  log(`  pushed: ${body.data.accepted} new, ${body.data.duplicates} already there`);
}

/**
 * Evaluate everything once so Readiness shows real numbers. The worker drives the run; if it is
 * not running (or still on an older image), the seeder drives the same engine through the
 * service-to-service route, exactly as the worker would.
 */
async function evaluateNow() {
  log('evaluating every control once (a few seconds per control)...');
  let run = null;
  const r = await bastion('POST', '/evaluations', {});
  if (r.status === 409) {
    run = must(await bastion('GET', '/evaluations?limit=10'), 'GET /evaluations').data.find((x) => x.scope === 'all' && (x.status === 'queued' || x.status === 'running'));
  } else {
    run = must(r, 'start an evaluation').data;
  }
  if (!run) return;
  const orgId = (await withDb((sql) => sql`SELECT id FROM organizations WHERE slug = ${EXP.org.slug}`))[0].id;
  const secret = process.env.INTERNAL_SERVICE_SECRET;
  const started = Date.now();
  while (Date.now() - started < 10 * 60_000) {
    const cur = must(await bastion('GET', `/evaluations/${run.id}`), 'GET evaluation').data;
    if (['succeeded', 'partial', 'failed'].includes(cur.status)) {
      log(`  evaluation ${cur.status}: pass ${cur.pass_count}, fail ${cur.fail_count}, can't prove ${cur.unprovable_count}`);
      break;
    }
    if (secret && Date.now() - started > 20_000) {
      const er = await fetch(`${BASTION_INTERNAL}/engines/evaluate-run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': secret },
        body: JSON.stringify({ organization_id: orgId, run_id: run.id, claimant: 'gilligan-seed' }),
      });
      const ed = await er.json().catch(() => ({}));
      if (er.ok) log(`  driving the run: ${ed.data?.assertions_done ?? '?'} of ${ed.data?.assertions_total ?? '?'} checks done`);
    } else {
      log(`  waiting for the worker (${cur.status}, ${cur.controls_done}/${cur.controls_total} controls)...`);
    }
    await new Promise((res) => setTimeout(res, 5_000));
  }
  // Control-scope runs queued by the reviews: let the same path finish them.
  for (const q of must(await bastion('GET', '/evaluations?limit=25'), 'GET /evaluations').data.filter((x) => x.scope === 'control' && (x.status === 'queued' || x.status === 'running'))) {
    if (!secret) break;
    for (let i = 0; i < 10; i++) {
      const er = await fetch(`${BASTION_INTERNAL}/engines/evaluate-run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': secret },
        body: JSON.stringify({ organization_id: orgId, run_id: q.id, claimant: 'gilligan-seed' }),
      });
      const ed = await er.json().catch(() => ({}));
      if (!er.ok || ed.data?.done) break;
    }
  }
}

async function verifyM5(ids) {
  const problems = [];
  for (const f of EXP.frameworks) {
    const s = must(await bastion('GET', `/summary?framework_id=${ids[f.templateKey]}`), 'GET /summary').data;
    log(`${f.name}: ${s.headline}; proven by the suite ${s.numbers.proven_by_suite}, by evidence you provided ${s.numbers.proven_by_evidence}, ${s.not_met_label}, can't prove yet ${s.numbers.cant_prove}`);
    if (s.numbers.not_set_up !== f.notSetUp) problems.push(`${f.name} not set up ${s.numbers.not_set_up}, expected ${f.notSetUp}`);
    if (s.numbers.total !== f.controlsInView) problems.push(`${f.name} denominator ${s.numbers.total}, expected ${f.controlsInView}`);
    if (s.numbers.proven_by_evidence !== EXP.m5.provenByEvidence) {
      problems.push(`${f.name} proven by evidence ${s.numbers.proven_by_evidence}, expected ${EXP.m5.provenByEvidence}`);
    }
  }
  const { check } = await manualCheckOf(EXP.m5.twoStep.controlKey);
  const twoStep = await currentItem(check.id, EXP.m5.twoStep.title);
  if (twoStep?.days_left !== EXP.m5.twoStep.daysLeft) problems.push(`2-Step report days left ${twoStep?.days_left}, expected ${EXP.m5.twoStep.daysLeft}`);
  if (problems.length) throw new Error(`seeded M5 numbers do not match BASTION_SEED_EXPECTATIONS: ${problems.join('; ')}`);
}

async function main() {
  log('Bastion seed (M3 and M5) starting...');
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
  await seedTwoStep();
  await seedBackgroundChecks();
  await seedFeed();
  await evaluateNow();
  await verifyM5(ids);
  log('Bastion seed done');
}

main().catch((err) => {
  console.error(`[bastion] FAILED: ${err.message}`);
  process.exit(1);
});

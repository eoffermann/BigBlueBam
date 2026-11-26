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
 * M6 rows (spec 10.2):
 *   - Gilligan replaces API keys yearly (both key checks revised to 365 days); the long-lived
 *     "Radio Relay" service key is older than that, so it is the one failing item;
 *   - Rescue Radio Firmware and Coral Reef Booking are connected to Bam's GitHub integration; PR #42
 *     merged without a second review; Lagoon Booking Site is on the list but not connected, and
 *     Coral Reef Booking is connected but not on it (a population gap);
 *   - the Professor owns the technical controls; the Professor proposes the Radio Relay exception
 *     and Skipper approves it in Bastion ("Not met, risk accepted"); Skipper drafts the evidence
 *     request for the expiring 2-Step report (to the Professor); drift tasks reach the Compliance
 *     project through the outbox; laptop encryption is the top gap.
 * M7 rows (spec 10.2):
 *   - "Island Information Security Policy" written once in Gilligan's Beacon (shared with the whole
 *     organization), linked as a policy for the seven castaways, and read and acknowledged by five
 *     of them (each in their own session: acknowledging is a vouching act); Gilligan and Ginger
 *     have not, so the Policies page reads "5 of 7 have read the current version".
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
    // use_ai: false keeps the seed deterministic (BASTION_SEED_EXPECTATIONS is derived from the
    // library); since M7 a compile with an AI provider would be queued and tailored on the worker.
    log(`compiling ${templateKey} (deterministic library suggestions, a few seconds)...`);
    const run = must(await bastion('POST', `/frameworks/${fw.id}/compile`, { use_ai: false }), `compile ${templateKey}`).data;
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

// ── M6: the key policy, the Radio Relay key, GitHub history, owners, exception, fixes ──────

async function controlByKey(controlKey) {
  const controls = must(await bastion('GET', '/controls'), 'GET /controls').data;
  const c = controls.find((x) => x.control_key === controlKey);
  if (!c) throw new Error(`control ${controlKey} is missing; run the M3 part first`);
  return c;
}

async function userIdByEmail(email) {
  return (await withDb((sql) => sql`SELECT id FROM users WHERE email = ${email}`))[0]?.id ?? null;
}

/** Gilligan replaces API keys yearly: revise both key checks to 365 days and confirm (session). */
async function seedKeyPolicy() {
  const m = EXP.m6;
  log(`key policy: keys are replaced and used at least every ${m.keyPolicyDays} days...`);
  const c = await controlByKey(m.radioRelay.controlKey);
  const list = must(await bastion('GET', `/controls/${c.id}/assertions`), 'GET assertions').data;
  const wanted = {
    'keys.max_age': { params: { max_age_days: m.keyPolicyDays }, plain_statement: `No API key is older than ${m.keyPolicyDays} days.` },
    'keys.unused_active': { params: { unused_days: m.keyPolicyDays }, plain_statement: `No working API key has gone unused for ${m.keyPolicyDays} days.` },
  };
  for (const [probe, body] of Object.entries(wanted)) {
    const cur = list.find((a) => a.probe_key === probe && (a.review_status === 'confirmed' || a.review_status === 'proposed'));
    if (!cur) continue;
    const key = probe === 'keys.max_age' ? 'max_age_days' : 'unused_days';
    let id = cur.id;
    if (Number(cur.params?.[key]) !== m.keyPolicyDays) {
      id = must(await bastion('POST', `/assertions/${cur.id}/revise`, body), `revise ${probe}`).data.id;
    }
    const r = await bastion('POST', `/assertions/${id}/confirm`, {}, { session: true });
    if (!(r.status === 409 && r.code === 'ASSERTION_NOT_PROPOSED')) must(r, `confirm ${probe}`);
  }
}

/** The long-lived "Radio Relay" service key (spec 10.2): older than the yearly policy. */
async function seedRadioRelayKey() {
  const m = EXP.m6.radioRelay;
  log(`"${m.keyName}" key (${m.ageDays} days old)...`);
  const owner = await userIdByEmail(m.proposerEmail);
  await withDb(async (sql) => {
    const org = (await sql`SELECT id FROM organizations WHERE slug = ${EXP.org.slug}`)[0].id;
    const have = await sql`SELECT id FROM api_keys WHERE org_id = ${org} AND name = ${m.keyName}`;
    if (have.length > 0) return;
    // A record of the radio's key, not a usable credential (the hash verifies nothing).
    await sql`INSERT INTO api_keys (user_id, name, key_hash, key_prefix, org_id, created_at, last_used_at)
              VALUES (${owner}, ${m.keyName}, 'radio-relay-not-a-usable-key', 'bbam_radio', ${org},
                      now() - make_interval(days => ${m.ageDays}), now() - interval '1 day')`;
  });
}

/** Two repositories connected to Bam, one merge without a second review (spec 10.2, story 5). */
async function seedGithubHistory() {
  const g = EXP.m6.codeReview;
  log('GitHub: Rescue Radio Firmware and Coral Reef Booking connected; PR #42 merged without review...');
  const projects = must(await bam('GET', '/projects'), 'GET /projects').data ?? [];
  for (const i of g.integrations) {
    const p = projects.find((x) => x.name === i.project);
    if (!p) throw new Error(`project "${i.project}" is missing; run the Bam seed first`);
    const cur = await bam('GET', `/projects/${p.id}/github-integration`);
    if (cur.ok && cur.json?.data?.repo_name === i.repo) continue;
    must(await bam('PUT', `/projects/${p.id}/github-integration`, { repo_owner: g.owner, repo_name: i.repo }), `connect ${i.repo}`);
  }
  // Deliveries GitHub sent (the webhook stores them in github_pr_events); idempotent on delivery id.
  await withDb(async (sql) => {
    const org = (await sql`SELECT id FROM organizations WHERE slug = ${EXP.org.slug}`)[0].id;
    const integ = (await sql`SELECT gi.id, gi.project_id FROM github_integrations gi WHERE gi.repo_owner = ${g.owner} AND gi.repo_name = ${g.prRepo}`)[0];
    const rows = [
      // PR #41: reviewed by the Professor before it merged.
      { delivery: 'gilligan-seed-pr-41-review', type: 'pull_request_review', action: 'submitted', n: 41, title: 'Add the battery gauge', author: 'gilligan', merged: false, mergedAgo: null, review: 'approved', reviewer: 'professor-hinkley', at: 12 },
      { delivery: 'gilligan-seed-pr-41', type: 'pull_request', action: 'closed', n: 41, title: 'Add the battery gauge', author: 'gilligan', merged: true, mergedAgo: 11, review: null, reviewer: null, at: 11 },
      // PR #42: merged without anyone else approving it.
      { delivery: 'gilligan-seed-pr-42', type: 'pull_request', action: 'closed', n: g.prNumber, title: g.prTitle, author: 'gilligan', merged: true, mergedAgo: 10, review: null, reviewer: null, at: 10 },
    ];
    for (const r of rows) {
      await sql`
        INSERT INTO github_pr_events (org_id, integration_id, project_id, repo_owner, repo_name, delivery_id, event_type, action, pr_number,
                                      pr_title, pr_author_login, base_ref, default_branch, merged, merged_at, review_id, review_state,
                                      reviewer_login, review_submitted_at, occurred_at)
        VALUES (${org}, ${integ?.id ?? null}, ${integ?.project_id ?? null}, ${g.owner}, ${g.prRepo}, ${r.delivery}, ${r.type}, ${r.action}, ${r.n},
                ${r.title}, ${r.author}, 'main', 'main', ${r.merged}, ${r.mergedAgo === null ? null : new Date(Date.now() - r.mergedAgo * 86_400_000)},
                ${r.review ? 4100 + r.n : null}, ${r.review}, ${r.reviewer}, ${r.review ? new Date(Date.now() - r.at * 86_400_000) : null},
                ${new Date(Date.now() - r.at * 86_400_000)})
        ON CONFLICT (repo_owner, repo_name, delivery_id) WHERE delivery_id IS NOT NULL DO NOTHING`;
    }
  });
}

/** The Professor owns the technical controls the M6 stories use; Skipper's risk calibration. */
async function seedOwnersAndWeights() {
  const m = EXP.m6;
  const professor = await userIdByEmail(m.laptop.ownerEmail);
  for (const key of m.professorOwns) {
    const c = await controlByKey(key);
    must(await bastion('PATCH', `/controls/${c.id}`, { owner_user_id: professor }), `owner of ${key}`);
  }
  for (const [key, weight] of Object.entries(m.riskWeights)) {
    const c = await controlByKey(key);
    must(await bastion('PATCH', `/controls/${c.id}`, { risk_weight: weight }), `risk weight of ${key}`);
  }
}

async function internalEngine(name, orgId) {
  const secret = process.env.INTERNAL_SERVICE_SECRET;
  if (!secret) return null;
  const r = await fetch(`${BASTION_INTERNAL}/engines/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': secret },
    body: JSON.stringify({ organization_id: orgId }),
  });
  return r.ok ? (await r.json().catch(() => ({}))).data : null;
}

/** The Professor proposes the Radio Relay exception; Skipper approves it in Bastion (session). */
async function seedRadioRelayException() {
  const m = EXP.m6.radioRelay;
  log('Radio Relay exception (the Professor proposes, Skipper approves in Bastion)...');
  const c = await controlByKey(m.controlKey);
  const existing = must(await bastion('GET', `/exceptions?control_id=${c.id}`), 'GET /exceptions').data;
  let ex = existing.find((e) => e.reason === m.reason && (e.status === 'active' || e.status === 'proposed'));
  if (!ex) {
    const evidence = must(await bastion('GET', `/controls/${c.id}/evidence?limit=20`), 'GET evidence').data;
    const item = evidence
      .filter((s) => s.outcome === 'fail')
      .flatMap((s) => s.cited_items ?? [])
      .find((i) => i.label === `API key "${m.keyName}"`);
    if (!item) throw new Error(`the "${m.keyName}" key is not among the failing items of ${m.controlKey}; is the key policy ${EXP.m6.keyPolicyDays} days?`);
    ex = must(
      await bastion(
        'POST',
        '/exceptions',
        {
          control_id: c.id,
          scope: 'entity',
          cited_entity_type: item.entity_type,
          cited_entity_id: item.entity_id,
          reason: m.reason,
          compensating_note: m.compensatingNote,
          expires_on: await localDatePlus(m.expiresInDays),
        },
        { as: m.proposerRole },
      ),
      'propose the Radio Relay exception',
    ).data;
  }
  if (ex.status === 'proposed') {
    must(await bastion('POST', `/exceptions/${ex.id}/decide`, { decision: 'approve', confirm: true }, { session: true }), 'approve the exception');
  }
}

/** Skipper drafts the evidence request for the expiring 2-Step report (to the Professor). */
async function seedEvidenceRequestFix() {
  const m = EXP.m6.evidenceRequest;
  const c = await controlByKey(m.controlKey);
  const gaps = must(await bastion('GET', `/gaps?control_id=${c.id}&status=all`), 'GET /gaps').data;
  const gap = gaps.find((g) => g.gap_kind === m.gapKind);
  if (!gap) throw new Error(`no ${m.gapKind} gap on ${m.controlKey}; gaps are ranked after the evaluation`);
  if (gap.status === 'open') {
    log('evidence request for the 2-Step report (to the Professor)...');
    must(await bastion('POST', `/gaps/${gap.id}/propose-fix`, {}), 'draft the evidence request');
  }
}

/** Gilligan weighs laptops highest: lower any other gap ranked above them (Skipper's calibration). */
async function calibrateTopGap() {
  const m = EXP.m6.laptop;
  for (let i = 0; i < 10; i++) {
    const top = must(await bastion('GET', '/gaps?limit=1'), 'GET /gaps').data[0];
    if (!top || top.control_title === m.title) return;
    const c = must(await bastion('GET', `/controls/${top.control_id}`), 'GET control').data;
    if (c.control_key === m.controlKey || (c.risk_weight ?? 3) <= 3) return;
    log(`  Skipper rates "${c.title}" below laptops (risk weight 3)`);
    must(await bastion('PATCH', `/controls/${c.id}`, { risk_weight: 3 }), 'calibrate risk weight');
    await internalEngine('gap-rank', (await withDb((sql) => sql`SELECT id FROM organizations WHERE slug = ${EXP.org.slug}`))[0].id);
  }
}

async function verifyM6() {
  const m = EXP.m6;
  const problems = [];
  const relay = await controlByKey(m.radioRelay.controlKey);
  const map = must(await bastion('GET', '/coverage'), 'GET /coverage').data;
  const row = map.find((r) => r.control_id === relay.id);
  if (row?.state_words !== m.radioRelay.stateWords) problems.push(`${m.radioRelay.controlKey} reads "${row?.state_words}", expected "${m.radioRelay.stateWords}"`);
  const s = must(await bastion('GET', '/summary'), 'GET /summary').data;
  if (s.numbers.risk_accepted !== m.riskAccepted) problems.push(`risk accepted ${s.numbers.risk_accepted}, expected ${m.riskAccepted}`);
  const top = must(await bastion('GET', '/gaps?limit=1'), 'GET /gaps').data[0];
  if (top?.control_title !== m.laptop.title) problems.push(`top gap is "${top?.control_title}", expected "${m.laptop.title}"`);
  const code = await controlByKey(m.codeReview.controlKey);
  const codeGaps = must(await bastion('GET', `/gaps?control_id=${code.id}`), 'GET /gaps').data.map((g) => g.gap_kind);
  if (!codeGaps.includes('population_drift')) problems.push(`no population_drift gap on ${m.codeReview.controlKey} (gaps: ${codeGaps.join(', ')})`);
  const drift = must(await bastion('GET', '/drift?limit=50'), 'GET /drift').data;
  if (!drift.some((d) => d.bam_task_human_id)) problems.push('no drift row has a Bam task yet (is the worker draining the outbox?)');
  log(`M6: ${s.not_met_label}; top gap "${top?.control_title}"; ${drift.length} drift rows`);
  if (problems.length) throw new Error(`seeded M6 rows do not match BASTION_SEED_EXPECTATIONS: ${problems.join('; ')}`);
}

// ── M7: the Island Information Security Policy, read by 5 of 7 ────────────────────────────

const BEACON = 'http://beacon-api:4004/v1';
const POLICY_BODY = `# Island Information Security Policy

This policy applies to everyone on the island who uses Gilligan Travel Ltd systems.

## What we protect

- Guest bookings for the charter fleet, including names, dates and payment details.
- The rescue radio, its firmware and the Radio Relay key.
- The crew roster and anything the Howells hand us for safekeeping.

## What everyone does

1. Use two-step sign-in on every company account. No exceptions, not even for the Skipper.
2. Keep laptops encrypted and with you. A laptop left on the beach is a laptop lost to the tide.
3. Never share an API key, a password or the radio code by coconut, note or shouting across the lagoon.
4. Report anything odd to the Professor straight away: strange sign-ins, a missing laptop, or a radio that hums when it should not.

## Leaving the island

When someone leaves, their access ends the same day. The Skipper confirms it and the Professor checks it.

## Review

The Skipper reviews this policy every year, or sooner after anything goes wrong.
`;

/** The policy article in Gilligan's Beacon: created once (an upsert would add a version each run). */
async function ensurePolicyArticle() {
  const m = EXP.m7.policy;
  const existing = (await withDb((sql) => sql`SELECT id, status::text AS status, visibility::text AS visibility FROM beacon_entries WHERE slug = ${m.slug}`))[0];
  if (existing) {
    log(`  "${m.title}" already in Beacon (${existing.status}, shared with ${existing.visibility})`);
    return existing.id;
  }
  log(`  writing "${m.title}" in Beacon as Skipper...`);
  const up = must(
    await call(BEACON, 'POST', '/entries/upsert', {
      slug: m.slug,
      title: m.title,
      summary: 'What everyone at Gilligan Travel does to keep bookings, the radio and the crew roster safe.',
      body_markdown: POLICY_BODY,
      visibility: 'Organization',
      change_note: 'Bastion M7 seed: the security policy castaways acknowledge',
    }),
    'create the policy article',
  );
  const entry = up.data ?? up;
  const pub = await call(BEACON, 'POST', `/beacons/${entry.id}/publish`);
  if (!pub.ok) log(`  publish answered ${pub.status} (${pub.code ?? 'no code'}); continuing`);
  return entry.id;
}

/** Link the article as a policy for the seven castaways, then five of them read and acknowledge it. */
async function seedPolicy() {
  const m = EXP.m7.policy;
  log('M7: the Island Information Security Policy...');
  const entryId = await ensurePolicyArticle();
  const audience = [];
  for (const email of m.audienceEmails) {
    const id = await userIdByEmail(email);
    if (!id) throw new Error(`${email} is not a user; run the platform seed first`);
    audience.push(id);
  }
  let policy = must(await bastion('GET', '/policies?status=all'), 'GET /policies').data.find((p) => p.beacon_entry_id === entryId);
  if (!policy) {
    policy = must(
      await bastion('POST', '/policies', { beacon_entry_id: entryId, audience: { kind: 'users', user_ids: audience }, cadence_days: m.cadenceDays }),
      'link the policy',
    ).data;
    log(`  linked as a policy for ${audience.length} castaways`);
  }
  for (const email of m.attestedEmails) {
    const cookie = email === EXP.actorEmail ? sessionCookie : await loginAs(email);
    const body = must(await bastion('GET', `/policies/${policy.id}/body`, undefined, { session: cookie }), `read the policy as ${email}`).data;
    if (!body.due) {
      log(`  ${email} already acknowledged version ${body.beacon_version}`);
      continue;
    }
    must(
      await bastion('POST', `/policies/${policy.id}/attest`, { beacon_version: body.beacon_version, body_sha256: body.body_sha256 }, { session: cookie }),
      `acknowledge the policy as ${email}`,
    );
    log(`  ${email} read and acknowledged version ${body.beacon_version}`);
  }
}

async function verifyM7() {
  const m = EXP.m7.policy;
  const p = must(await bastion('GET', '/policies'), 'GET /policies').data.find((x) => x.title === m.title);
  const problems = [];
  if (!p) problems.push(`no policy titled "${m.title}"`);
  else {
    if (p.attestation_label !== m.label) problems.push(`the policy reads "${p.attestation_label}", expected "${m.label}"`);
    if (!p.shared_with_everyone) problems.push('the policy article is not shared with everyone');
  }
  log(`M7: ${p?.title}: ${p?.attestation_label}`);
  if (problems.length) throw new Error(`seeded M7 rows do not match BASTION_SEED_EXPECTATIONS: ${problems.join('; ')}`);
}

async function main() {
  log('Bastion seed (M3, M5, M6 and M7) starting...');
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
  // M6 rows that must exist before the evaluation sees them.
  await seedKeyPolicy();
  await seedRadioRelayKey();
  await seedGithubHistory();
  await seedOwnersAndWeights();
  await seedTwoStep();
  await seedBackgroundChecks();
  await seedFeed();
  await evaluateNow();
  await verifyM5(ids);
  // M6 rows that need the evaluation: rank, deliver the drift tasks, exception, fixes.
  const orgId = (await withDb((sql) => sql`SELECT id FROM organizations WHERE slug = ${EXP.org.slug}`))[0].id;
  log('ranking gaps and delivering drift tasks to the Compliance project...');
  await internalEngine('gap-rank', orgId);
  await seedRadioRelayException();
  await seedEvidenceRequestFix();
  await calibrateTopGap();
  for (let i = 0; i < 5; i++) {
    const d = await internalEngine('outbox-drain', orgId);
    if (!d || d.candidates === 0) break;
    log(`  delivered ${d.delivered}, waiting ${d.failed}, dead ${d.dead}`);
  }
  await verifyM6();
  // M7: the security policy, read and acknowledged by five castaways (each with their own session).
  await seedPolicy();
  await verifyM7();
  log('Bastion seed done');
}

main().catch((err) => {
  console.error(`[bastion] FAILED: ${err.message}`);
  process.exit(1);
});

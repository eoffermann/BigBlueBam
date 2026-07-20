#!/usr/bin/env node
/**
 * Gilligan's Island seed ORCHESTRATOR.
 *
 * One command to seed the whole themed dataset into a running local stack:
 *
 *     pnpm seed:gilligan          (from the repo root)
 *     node scripts/seed-gilligan/run-all.mjs
 *
 * What it does, idempotently:
 *   1. Bootstraps the "Gilligan Travel Ltd" org (slug gilligan-travel-ltd) and
 *      the 7 castaway users at the EXACT fixed UUIDs the individual seeders
 *      hardcode — so those 31 seeders run unchanged. Inserts org memberships,
 *      role group memberships, and default priorities (mirrors what
 *      `cli create-admin`/`create-user` do, but with deterministic ids).
 *   2. Mints a read_write API key per castaway (and best-effort admin keys for
 *      the SMTP step) and assembles the GKEYS map the seeders expect.
 *   3. Runs all 31 seeders in dependency order inside the `api` container
 *      (`docker compose exec -T -e GKEYS=… api node - < <file>`), which is how
 *      they reach the internal app hosts and the DATABASE_URL/REDIS_URL/S3 env.
 *
 * Prerequisites: the stack is up (`docker compose up -d`) and migrations are
 * applied. Re-running is safe — every seeder is find-or-create; the bootstrap
 * uses ON CONFLICT DO NOTHING. (Each run does mint fresh API keys; revoke old
 * "gilligan-seed" keys in Settings if they accumulate.)
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import argon2 from 'argon2';
import { BURSAR_SEED_EXPECTATIONS } from './bursar.expectations.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const t0 = Date.now();
const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const log = (msg) => process.stdout.write(`[gilligan +${elapsed()}] ${msg}\n`);

// ── Canonical roster (UUIDs MUST match the ids hardcoded in the seeders) ──
const ORG = { id: '57db0001-3f0e-463f-b514-1cd14fd14241', name: 'Gilligan Travel Ltd', slug: 'gilligan-travel-ltd' };
const PASSWORD = 'Castaway2026!';
const GROUP = {
  owner: '11111111-1111-4111-8111-111111111111',
  admin: '22222222-2222-4222-8222-222222222222',
  member: '33333333-3333-4333-8333-333333333333',
};
const CAST = [
  { role: 'skipper',   id: '415a22d7-7ffa-4ffc-a07f-128a25989ece', email: 'skipper@gilligantravel.example',   name: 'The Skipper',         group: GROUP.owner },
  { role: 'howell',    id: '414d283d-f13b-4608-91db-dfd024db4064', email: 'howell@gilligantravel.example',    name: 'Thurston Howell III', group: GROUP.admin },
  { role: 'professor', id: '685d424e-ceb1-453a-b605-c66aa1c6d8cf', email: 'professor@gilligantravel.example', name: 'The Professor',       group: GROUP.member },
  { role: 'gilligan',  id: '0f47c55f-4c7d-4100-a00b-ca131a1e864d', email: 'gilligan@gilligantravel.example',  name: 'Gilligan',            group: GROUP.member },
  { role: 'maryann',   id: 'd2835cc4-8ee9-4a27-b43e-84ab19a21450', email: 'maryann@gilligantravel.example',   name: 'Mary Ann Summers',    group: GROUP.member },
  { role: 'ginger',    id: 'c8926754-2a93-4bd6-bf20-5b1f87e27385', email: 'ginger@gilligantravel.example',    name: 'Ginger Grant',        group: GROUP.member },
  { role: 'lovey',     id: '0ddd0b3e-4de3-4077-a905-07878dc43960', email: 'lovey@gilligantravel.example',     name: 'Lovey Howell',        group: GROUP.member },
];

// ── Seeder run order (8 phases). Phase 1 is fatal; later phases are best-effort
//    so one app's hiccup doesn't abort the rest. board-luau.mjs is excluded
//    (it is a base64 asset generator, not a seeder). ──
const PHASES = [
  { name: 'Foundation', fatal: true, files: ['bam.mjs', 'bond.mjs'] },
  // blank.mjs / blank-submissions.mjs post to the PUBLIC form-submit endpoint,
  // which has a fixed anti-spam cap of 10 submissions/hour/form (blank-api
  // public.routes.ts) that the global permissive-rate-limit flag does NOT relax.
  // Forms still seed; the sample submissions beyond the cap are expected to be
  // rate-limited, so those two are marked soft (won't fail the overall run).
  { name: 'Communication', soft: ['blank.mjs', 'blank-submissions.mjs'], files: ['banter.mjs', 'banter-supplement.mjs', 'blank.mjs', 'blank-submissions.mjs', 'brief.mjs'] },
  { name: 'Knowledge & analytics', files: ['beacon.mjs', 'beacon-fixup.mjs', 'bench.mjs', 'bench-supplement.mjs', 'bin.mjs', 'bay.mjs'] },
  // bursar.mjs runs here because it needs bond.mjs companies and bill.mjs expenses;
  // it drives its own bursar-api (vendors, request, offers, award) and imports observed
  // spend that the detectors key off. run-all injects BURSAR_EXPECTATIONS so the seeder
  // and the Playwright suite read one canonical number set (spec 19.3).
  { name: 'Billing', files: ['bill.mjs', 'bill-supplement.mjs', 'bill-recurring.mjs', 'bursar.mjs'] },
  { name: 'Spatial & async', files: ['board.mjs', 'book.mjs', 'book-connections.mjs', 'bureau.mjs', 'bureau-presence.mjs'] },
  // basis.mjs runs here because it defines governed metrics OVER data that must
  // already exist: bam.tasks (Foundation) and bill.invoices (Billing), both of
  // which have run by this phase. Its definitions resolve through Bench.
  { name: 'Diagrams & automation', files: ['blueprint.mjs', 'blueprint-collab.mjs', 'bolt.mjs', 'bearing.mjs', 'basis.mjs'] },
  // blip.mjs is placed here because it runs AFTER both banter.mjs (Communication)
  // and bolt.mjs (Diagrams & automation): its seeded watches emit entry.matched,
  // and a seeded Bolt rule fans that into a real castaway Banter channel, so both
  // targets must already exist. Its live-path ingest proof is soft internally.
  { name: 'Campaigns & detail', files: ['blast.mjs', 'blast-blueprint-fixup.mjs', 'blip.mjs', 'detail-fixup.mjs'] },
  { name: 'Support & email', files: ['helpdesk.mjs', 'smtp.mjs'] },
];

// ── docker compose helpers ────────────────────────────────────────────
function dc(args, opts = {}) {
  return spawnSync('docker', ['compose', ...args], { encoding: 'utf8', ...opts });
}
function psql(sql) {
  const r = dc(['exec', '-T', 'postgres', 'psql', '-U', 'bigbluebam', '-d', 'bigbluebam', '-v', 'ON_ERROR_STOP=1'], { input: sql });
  if (r.status !== 0) throw new Error(`psql failed: ${(r.stderr || r.stdout || '').slice(0, 500)}`);
  return r.stdout;
}
function sqlStr(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

// ── 1. Bootstrap org + cast (idempotent) ──────────────────────────────
async function bootstrap() {
  log('Bootstrapping org + castaway users…');
  const hash = await argon2.hash(PASSWORD);
  const userValues = CAST.map(
    (c) => `(${sqlStr(c.id)}, ${sqlStr(ORG.id)}, ${sqlStr(c.email)}, ${sqlStr(c.name)}, ${sqlStr(hash)}, false)`,
  ).join(',\n      ');
  const memValues = CAST.map((c) => `(${sqlStr(c.id)}, ${sqlStr(ORG.id)}, true)`).join(',\n      ');
  const grpValues = CAST.map((c) => `(${sqlStr(c.id)}, ${sqlStr(c.group)}, 'org', ${sqlStr(ORG.id)})`).join(',\n      ');

  psql(`
    INSERT INTO organizations (id, name, slug)
      VALUES (${sqlStr(ORG.id)}, ${sqlStr(ORG.name)}, ${sqlStr(ORG.slug)})
      ON CONFLICT DO NOTHING;

    INSERT INTO users (id, org_id, email, display_name, password_hash, is_superuser)
      VALUES
      ${userValues}
      ON CONFLICT (id) DO UPDATE SET
        email = EXCLUDED.email,
        display_name = EXCLUDED.display_name,
        password_hash = EXCLUDED.password_hash;

    INSERT INTO organization_memberships (user_id, org_id, is_default)
      VALUES
      ${memValues}
      ON CONFLICT DO NOTHING;

    INSERT INTO account_group_memberships (user_id, group_id, scope_type, scope_id)
      VALUES
      ${grpValues}
      ON CONFLICT DO NOTHING;

    INSERT INTO priorities (org_id, value, name, color, icon, position, is_default)
      VALUES
      (${sqlStr(ORG.id)}, 'critical', 'Critical', '#dc2626', 'alert-triangle', 0, false),
      (${sqlStr(ORG.id)}, 'high',     'High',     '#f97316', 'arrow-up',       1, false),
      (${sqlStr(ORG.id)}, 'medium',   'Medium',   '#eab308', 'minus',          2, true),
      (${sqlStr(ORG.id)}, 'low',      'Low',      '#60a5fa', 'arrow-down',     3, false),
      (${sqlStr(ORG.id)}, 'none',     'None',     '#a1a1aa', NULL,             4, false)
      ON CONFLICT (org_id, value) DO NOTHING;
  `);
  log(`Org "${ORG.name}" + ${CAST.length} castaways ready (login password: ${PASSWORD}).`);
}

// ── 2. Mint API keys ──────────────────────────────────────────────────
function mintKey(email, name, scope, orgSlug) {
  const r = dc([
    'exec', '-T', 'api', 'node', 'dist/cli.js', 'create-api-key',
    '--email', email, '--name', name, '--scope', scope, '--org-slug', orgSlug,
  ]);
  const token = (r.stdout || '').match(/bbam_[A-Za-z0-9_-]+/);
  if (r.status !== 0 || !token) {
    log(`  ! key mint failed for ${email} (${(r.stderr || r.stdout || '').trim().split('\n').pop()})`);
    return null;
  }
  return token[0];
}

function mintAllKeys() {
  log('Minting castaway API keys…');
  const gkeys = {};
  for (const c of CAST) {
    const k = mintKey(c.email, 'gilligan-seed', 'read_write', ORG.slug);
    if (!k) throw new Error(`could not mint a key for ${c.role}; cannot seed without it`);
    gkeys[c.role] = k;
  }
  log(`  minted ${Object.keys(gkeys).length} read_write keys.`);
  // Best-effort admin keys for the SMTP seeder (skipped gracefully if absent).
  const orgAdminKey = mintKey('skipper@gilligantravel.example', 'gilligan-smtp-orgadmin', 'admin', ORG.slug);
  const suKey = mintKey('eddie@bigblueceiling.com', 'gilligan-smtp-su', 'admin', 'big-blue-ceiling');
  return { gkeys, orgAdminKey, suKey };
}

// ── 3. Run a seeder inside the api container (with 429 retry) ──────────
function execSeeder(file, env) {
  const src = readFileSync(join(HERE, file), 'utf8');
  const envArgs = Object.entries(env).flatMap(([k, v]) => (v ? ['-e', `${k}=${v}`] : []));
  return dc(['exec', '-T', ...envArgs, 'api', 'node', '-'], { input: src });
}

function sleepSync(ms) {
  // Block the orchestrator briefly between retries (it's a sequential CLI tool).
  const sab = spawnSync(process.execPath, ['-e', `setTimeout(()=>{}, ${ms})`]);
  return sab;
}

function runSeeder(file, env) {
  // Some app APIs (notably banter) apply a short transient rate limit. The
  // seeders are idempotent, so on a 429 we wait out the window and re-run the
  // whole seeder, up to a couple of times. The public form-submit cap (blank)
  // is an hour long and is deliberately NOT waited out — those are soft.
  const MAX_TRIES = 3;
  let r;
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    r = execSeeder(file, env);
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    if (r.status === 0) break;
    const m = out.match(/retry in (\d+) (second|minute)/i);
    const waitS = m ? Number(m[1]) * (m[2].toLowerCase() === 'minute' ? 60 : 1) : 0;
    const is429 = /\b429\b|rate limit/i.test(out);
    if (!is429 || attempt === MAX_TRIES || waitS === 0 || waitS > 90) break; // give up / not transient
    log(`    ↻ ${file} rate-limited; waiting ${waitS + 2}s then retrying (attempt ${attempt + 1}/${MAX_TRIES})…`);
    sleepSync((waitS + 2) * 1000);
  }
  const ok = r.status === 0;
  const tail = (r.stdout || '').trim().split('\n').slice(-2).join(' | ');
  if (ok) log(`  ✓ ${file}${tail ? ` — ${tail}` : ''}`);
  else log(`  ✗ ${file} FAILED: ${(r.stderr || r.stdout || '').trim().split('\n').slice(-3).join(' | ')}`);
  return ok;
}

// ── Main ──────────────────────────────────────────────────────────────
async function main() {
  // Fail fast if the stack isn't up.
  const ping = dc(['ps', '--status', 'running', '--format', '{{.Service}}']);
  if (ping.status !== 0 || !/\bapi\b/.test(ping.stdout || '')) {
    log('ERROR: the `api` service is not running. Start the stack first: docker compose up -d');
    process.exit(1);
  }

  await bootstrap();
  const { gkeys, orgAdminKey, suKey } = mintAllKeys();
  const GKEYS = JSON.stringify(gkeys);

  const results = [];
  for (const phase of PHASES) {
    log(`── Phase: ${phase.name} ──`);
    for (const file of phase.files) {
      const env = { GKEYS };
      if (file === 'smtp.mjs') {
        env.SU_KEY = suKey;
        env.ORG_ADMIN_KEY = orgAdminKey;
      }
      if (file === 'bursar.mjs') {
        env.BURSAR_EXPECTATIONS = JSON.stringify(BURSAR_SEED_EXPECTATIONS);
      }
      const soft = (phase.soft || []).includes(file);
      const ok = runSeeder(file, env);
      results.push({ file, ok, soft });
      if (!ok && phase.fatal) {
        log(`FATAL: ${file} failed in the foundation phase; aborting (later seeders depend on it).`);
        printSummary(results);
        process.exit(1);
      }
    }
  }
  printSummary(results);
  // Soft failures (the blank public-submit hourly cap) don't fail the run.
  const hardFailed = results.filter((r) => !r.ok && !r.soft);
  process.exit(hardFailed.length ? 1 : 0);
}

function printSummary(results) {
  const ok = results.filter((r) => r.ok).length;
  const hardFailed = results.filter((r) => !r.ok && !r.soft);
  const softFailed = results.filter((r) => !r.ok && r.soft);
  log('────────────────────────────────────────────────');
  log(`Done in ${elapsed()}: ${ok}/${results.length} seeders OK.`);
  if (hardFailed.length) log(`  ✗ failed: ${hardFailed.map((f) => f.file).join(', ')}`);
  if (softFailed.length) {
    log(`  ⚠ partial (expected): ${softFailed.map((f) => f.file).join(', ')} — the public form-submit endpoint caps at 10 submissions/hour/form; the forms themselves are seeded.`);
  }
  if (!hardFailed.length) {
    log(`Sign in at /b3/login as skipper@gilligantravel.example (password ${PASSWORD}) to explore the castaways' org.`);
  }
}

main().catch((err) => {
  log(`ERROR: ${err.message}`);
  process.exit(1);
});

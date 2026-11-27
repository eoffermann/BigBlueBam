// node --test scripts/lib/claude-md-coverage.test.mjs
//
// #376: CLAUDE.md is the first thing every agent reads, and its auth-core entry and db:check
// "Drift guard" section lagged the code by several batches. This guard fails when a new
// auth-core module or a new db-check rule lands without a CLAUDE.md mention.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const claude = readFileSync(join(ROOT, 'CLAUDE.md'), 'utf8');

test('the auth-core package entry names every auth-core module', () => {
  const line = claude.split('\n').find((l) => /^\s+auth-core\/\s/.test(l));
  assert.ok(line, 'CLAUDE.md has no packages/auth-core entry');
  const modules = readdirSync(join(ROOT, 'packages', 'auth-core', 'src'))
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'index.ts' && f !== 'rows.ts');
  const missing = modules.filter((f) => !line.includes(f));
  assert.deepEqual(missing, [], `name these modules in the CLAUDE.md auth-core entry: ${missing.join(', ')}`);
  for (const fact of ['key_lookup', 'MAX_VERIFY_CANDIDATES', 'resolveOrgContext', 'requireKeyProjectChecked', 'refuseProjectRestrictedKey', 'auth-core-single-source.test.mjs']) {
    assert.ok(line.includes(fact), `CLAUDE.md auth-core entry should mention ${fact}`);
  }
});

// ---------------------------------------------------------------------------
// #407: inventory facts that went stale (migration tip, migrate dependents,
// stateless containers, nginx routes, Bolt catalog size).
// ---------------------------------------------------------------------------

/** { serviceName: blockText } for the top-level `services:` map of docker-compose.yml. */
function composeServices() {
  const lines = readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8').split(/\r?\n/);
  const start = lines.indexOf('services:');
  assert.ok(start >= 0, 'docker-compose.yml has no services: map');
  const out = {};
  let cur = null;
  for (const l of lines.slice(start + 1)) {
    if (/^\S/.test(l)) break;
    const m = l.match(/^ {2}([a-z0-9-]+):\s*$/);
    if (m) { cur = m[1]; out[cur] = ''; continue; }
    if (cur) out[cur] += `${l}\n`;
  }
  return out;
}

/** Both compose depends_on shapes: `migrate: { condition: ... }` and the nested map. */
function waitsOnMigrate(block) {
  return /^\s+migrate:\s*(\{\s*condition:\s*service_completed_successfully\s*\}|\n\s+condition:\s*service_completed_successfully)/m.test(block);
}

/** The comma list inside the first "(...)" after `label` in CLAUDE.md. */
function claudeList(label) {
  const at = claude.indexOf(label);
  assert.ok(at >= 0, `CLAUDE.md has no "${label}" sentence`);
  const open = claude.indexOf('(', at);
  return claude.slice(open + 1, claude.indexOf(')', open)).split(',').map((s) => s.trim());
}

test('CLAUDE.md records no migration count or tip that disagrees with the tree', () => {
  const files = readdirSync(join(ROOT, 'infra', 'postgres', 'migrations')).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
  const tip = files[files.length - 1];
  for (const m of claude.matchAll(/\btip `?(\d{4}_[a-z0-9_]+\.sql)/g)) {
    assert.equal(m[1], tip, `CLAUDE.md names migration tip ${m[1]}; the tree's tip is ${tip}`);
  }
  for (const m of claude.matchAll(/\b(\d+) (?:migration )?files (?:as of|with) tip\b/g)) {
    assert.equal(Number(m[1]), files.length, `CLAUDE.md says ${m[0]}; the tree has ${files.length}`);
  }
  assert.match(claude, /ls infra\/postgres\/migrations\/\*\.sql \| tail -1/, 'CLAUDE.md should say how to read the tip');
});

test('the migrate paragraph matches the services that wait on migrate in docker-compose.yml', () => {
  assert.match(claude, /dependency of every DB-using service in `docker-compose\.yml`: `api`, every `\*-api` service, `worker`, and `seed`/);
  const services = composeServices();
  const expected = Object.keys(services).filter((s) => s === 'api' || s.endsWith('-api') || s === 'worker' || s === 'seed').sort();
  const actual = Object.keys(services).filter((s) => waitsOnMigrate(services[s])).sort();
  assert.deepEqual(actual, expected, 'docker-compose.yml migrate dependents differ from the CLAUDE.md sentence');
});

test('every compose service is an application, data, or one-shot/infrastructure container in CLAUDE.md', () => {
  const app = claudeList('Application containers');
  const data = claudeList('Data services');
  const infra = claudeList('one-shot or infrastructure containers');
  const unclassified = Object.keys(composeServices()).filter(
    (s) => !(s.endsWith('-api') && app.some((a) => a.includes('`*-api`'))) && !app.includes(s) && !data.includes(s) && !infra.includes(s),
  );
  assert.deepEqual(unclassified, [], `classify these compose services in CLAUDE.md: ${unclassified.join(', ')}`);
});

test('the nginx route list names every app SPA, API, WebSocket, and ingest route', () => {
  const conf = readFileSync(join(ROOT, 'infra', 'nginx', 'nginx.conf'), 'utf8');
  const paths = new Set([...conf.matchAll(/^\s*location\s+(?:[=^~]+\s+)?(\/[a-z0-9-]+\/(?:api\/|ws|ingest\/)?)\s*\{/gm)].map((m) => m[1]));
  const apps = [...paths].filter((p) => /^\/[a-z0-9]+\/api\/$/.test(p)).map((p) => p.split('/')[1]);
  const missing = [...paths]
    .filter((p) => apps.includes(p.split('/')[1]))
    .filter((p) => !claude.includes(`\`http://DOMAIN${p}\``));
  assert.deepEqual(missing, [], `add these nginx routes to the CLAUDE.md route list: ${missing.join(', ')}`);
});

test('CLAUDE.md does not pin a Bolt catalog event count', () => {
  assert.doesNotMatch(claude, /\b\d+ events registered\b/, 'run scripts/check-bolt-catalog.mjs for the count instead');
});

test('the Drift guard section documents every db:check rule', () => {
  const start = claude.indexOf('### Drift guard');
  const end = claude.indexOf('### ', start + 5);
  assert.ok(start >= 0, 'CLAUDE.md has no Drift guard section');
  const section = claude.slice(start, end);
  const src = readFileSync(join(ROOT, 'scripts', 'db-check.mjs'), 'utf8');
  for (const m of src.matchAll(/export const ([A-Z_]+_ALLOWLIST)\b/g)) {
    assert.ok(section.includes(m[1]), `Drift guard section should explain ${m[1]}`);
  }
  for (const fn of src.matchAll(/export function (diff[A-Z]\w+)\(/g)) {
    const topic = { diffForeignKeys: /foreign key/i, diffNullability: /nullability/i }[fn[1]];
    if (topic) assert.match(section, topic, `Drift guard section should explain ${fn[1]}`);
  }
  assert.match(section, /stub/i, 'Drift guard section should say reference stubs must agree too');
});

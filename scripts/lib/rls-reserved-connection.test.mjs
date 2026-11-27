// #365: a postgres.js reserved connection has no begin()/savepoint() and no `options`, so a
// drizzle instance bound straight onto one fails every db.transaction ("this.client.begin is not
// a function") and, without options, every query. apps/api was fixed in #364; basis-api,
// braid-api and bulwark-api carried copies of the same rls plugin with the same defect. The fix
// lives once in @bigbluebam/rls-connection: reserveOrgConnection returns a connection that has the
// org bound, transaction support and the pool's options, and requestRlsBinding is the per-request
// Fastify binding built on it.
//
// This guard fails when service or package source reserves a connection itself (`.reserve()`)
// instead of going through the package, when the transaction shim is defined again elsewhere, or
// when a service uses the package without depending on it and building it in its Dockerfile.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PKG = '@bigbluebam/rls-connection';
const PKG_DIR = 'packages/rls-connection';

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(name) && !/\.test\.(ts|tsx|mjs|js)$/.test(name)) out.push(p);
  }
  return out;
}

const rel = (p) => relative(repoRoot, p).replaceAll('\\', '/');

function sourceRoots(base) {
  const dir = join(repoRoot, base);
  return readdirSync(dir)
    .map((name) => ({ name, src: join(dir, name, 'src') }))
    .filter(({ src }) => existsSync(src) && statSync(src).isDirectory());
}

const apps = sourceRoots('apps');
const appSources = apps.flatMap(({ src }) => walk(src));
const packageSources = sourceRoots('packages')
  .filter(({ name }) => name !== 'rls-connection')
  .flatMap(({ src }) => walk(src));

/** Source files that reserve a pooled connection or define the reserved-transaction shim. */
function reserveOffenders(files, read = (f) => readFileSync(f, 'utf8')) {
  const out = [];
  for (const f of files) {
    const src = read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    if (/\.reserve\s*\(\s*\)/.test(src)) out.push(`${rel(f)}: calls .reserve() (use reserveOrgConnection or requestRlsBinding from ${PKG})`);
    if (/function\s+withReservedTransactions\b|const\s+withReservedTransactions\s*=/.test(src)) {
      out.push(`${rel(f)}: defines withReservedTransactions (import it from ${PKG})`);
    }
  }
  return out;
}

test('no service or shared package reserves a postgres connection outside @bigbluebam/rls-connection', () => {
  assert.ok(appSources.length > 100, 'expected to scan the app sources');
  const offenders = reserveOffenders([...appSources, ...packageSources]);
  assert.deepEqual(offenders, [], `Reserve request connections through ${PKG}:\n${offenders.join('\n')}`);
});

test('every service that uses @bigbluebam/rls-connection depends on it and builds it in its Dockerfile', () => {
  const users = apps.filter(({ src }) => walk(src).some((f) => readFileSync(f, 'utf8').includes(`'${PKG}'`)));
  assert.ok(
    ['api', 'basis-api', 'braid-api', 'bulwark-api'].every((a) => users.some((u) => u.name === a)),
    `expected api, basis-api, braid-api and bulwark-api to bind requests through ${PKG}; found ${users.map((u) => u.name).join(', ')}`,
  );
  const problems = [];
  for (const { name } of users) {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'apps', name, 'package.json'), 'utf8'));
    if (!pkg.dependencies?.[PKG]) problems.push(`apps/${name}/package.json: no dependency on ${PKG}`);
    const dockerfile = join(repoRoot, 'apps', name, 'Dockerfile');
    if (!existsSync(dockerfile)) continue;
    const text = readFileSync(dockerfile, 'utf8');
    if (!text.includes(`COPY ${PKG_DIR}/package.json ./${PKG_DIR}/`)) {
      problems.push(`apps/${name}/Dockerfile: deps stage does not COPY ${PKG_DIR}/package.json`);
    }
    if (!text.includes(`COPY ${PKG_DIR}/ ./${PKG_DIR}/`)) problems.push(`apps/${name}/Dockerfile: does not COPY ${PKG_DIR}/`);
    if (!text.includes(`pnpm --filter ${PKG} build`)) problems.push(`apps/${name}/Dockerfile: does not build ${PKG}`);
  }
  assert.deepEqual(problems, []);
});

test('the detector catches the shapes it guards against', () => {
  const fake = {
    'a.ts': 'const reserved = await queryClient.reserve();',
    'b.ts': 'export function withReservedTransactions(r) { return r; }',
    'c.ts': "import { reserveOrgConnection } from '@bigbluebam/rls-connection';",
    'd.ts': '// queryClient.reserve() is only mentioned in a comment',
    'e.ts': '/* readClient.reserve() in a block comment */',
  };
  const hits = reserveOffenders(Object.keys(fake).map((k) => join(repoRoot, k)), (f) => fake[rel(f)]);
  assert.deepEqual(
    hits.map((h) => h.split(':')[0]),
    ['a.ts', 'b.ts'],
  );
});

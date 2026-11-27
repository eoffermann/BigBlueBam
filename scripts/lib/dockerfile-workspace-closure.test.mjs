// A Dockerfile that copies a workspace package must also copy every workspace package that
// package depends on (transitively), in the deps stage (package.json) and the build stage
// (sources), and build it. Otherwise `pnpm install` inside the image fails with
// ERR_PNPM_WORKSPACE_PKG_NOT_FOUND, which CI never sees because CI does not build images.
// Found 2026-11-27: packages/permissions gained @bigbluebam/auth-core (#352) and the
// mcp-server image stopped building; the other services happened to copy auth-core already.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** name -> directory name under packages/ for every workspace package. */
function workspacePackages() {
  const out = new Map();
  for (const dir of readdirSync(join(repoRoot, 'packages'))) {
    const pj = join(repoRoot, 'packages', dir, 'package.json');
    if (!existsSync(pj)) continue;
    const { name } = JSON.parse(readFileSync(pj, 'utf8'));
    if (name) out.set(name, dir);
  }
  return out;
}

/** Workspace deps (dependencies + devDependencies + peer) of a package.json. */
function workspaceDeps(pkgJsonPath, known) {
  const pj = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
  const all = { ...pj.dependencies, ...pj.devDependencies, ...pj.peerDependencies };
  return Object.entries(all)
    .filter(([name, spec]) => typeof spec === 'string' && spec.startsWith('workspace:') && known.has(name))
    .map(([name]) => name);
}

/** packages/<dir> names a Dockerfile copies (either package.json or the whole dir). */
export function copiedPackageDirs(dockerfileText) {
  const dirs = new Set();
  for (const m of dockerfileText.matchAll(/^\s*COPY\s+(?:--\S+\s+)*packages\/([a-z0-9-]+)\//gim)) dirs.add(m[1]);
  return dirs;
}

/** Missing workspace-dependency directories for one Dockerfile. */
export function missingClosure(dockerfileText, known, depsOf) {
  const copied = copiedPackageDirs(dockerfileText);
  const dirToName = new Map([...known].map(([n, d]) => [d, n]));
  const missing = new Set();
  const seen = new Set();
  const queue = [...copied].map((d) => dirToName.get(d)).filter(Boolean);
  while (queue.length) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    for (const dep of depsOf(name)) {
      const dir = known.get(dep);
      if (!copied.has(dir)) missing.add(dir);
      queue.push(dep);
    }
  }
  return [...missing].sort();
}

test('every Dockerfile copies the full workspace-dependency closure of the packages it copies', () => {
  const known = workspacePackages();
  const depsOf = (name) => workspaceDeps(join(repoRoot, 'packages', known.get(name), 'package.json'), known);
  const problems = [];
  for (const app of readdirSync(join(repoRoot, 'apps'))) {
    const df = join(repoRoot, 'apps', app, 'Dockerfile');
    if (!existsSync(df)) continue;
    const text = readFileSync(df, 'utf8');
    const missing = missingClosure(text, known, depsOf);
    // The app's own direct workspace deps must be copied too.
    const appPj = join(repoRoot, 'apps', app, 'package.json');
    if (existsSync(appPj) && /pnpm install/.test(text)) {
      for (const dep of workspaceDeps(appPj, known)) {
        const dir = known.get(dep);
        if (!copiedPackageDirs(text).has(dir) && !missing.includes(dir)) missing.push(dir);
      }
    }
    if (missing.length) problems.push(`apps/${app}/Dockerfile does not copy packages/${missing.join(', packages/')}`);
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('the closure check catches a package whose dependency is not copied', () => {
  const known = new Map([
    ['@x/permissions', 'permissions'],
    ['@x/auth-core', 'auth-core'],
    ['@x/shared', 'shared'],
  ]);
  const deps = { '@x/permissions': ['@x/auth-core'], '@x/auth-core': ['@x/shared'], '@x/shared': [] };
  const df = 'COPY packages/shared/package.json ./packages/shared/\nCOPY packages/permissions/ ./packages/permissions/\n';
  assert.deepEqual(missingClosure(df, known, (n) => deps[n]), ['auth-core']);
  const fixed = `${df}COPY packages/auth-core/ ./packages/auth-core/\n`;
  assert.deepEqual(missingClosure(fixed, known, (n) => deps[n]), []);
});

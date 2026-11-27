import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The worker image runs dist/worker.js, built by tsup (ESM) and shipped with
// `pnpm deploy --prod`. tsup inlines every package that is NOT in `dependencies`,
// and an inlined CommonJS package that does `require('stream')` (or any node
// builtin) throws "Dynamic require ... is not supported" inside the ESM bundle.
// jszip as a devDependency hit exactly that: its support probe caught the throw,
// set nodestream = false, and every Bastion audit packet failed on the stack
// while the source-level tests (real require) passed. So: anything the runtime
// source imports must be a real dependency.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  devDependencies?: Record<string, string>;
};

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.[cm]?ts$/.test(name) && !/\.(test|spec)\.[cm]?ts$/.test(name) && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/** Package names a file imports at runtime (type-only imports are erased and do not count). */
function runtimeImports(text: string): string[] {
  const names: string[] = [];
  const re = /^\s*(?:import|export)\s+(?!type\b)[^'"]*?from\s+['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s+['"]([^'"]+)['"]/gm;
  for (const m of text.matchAll(re)) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (!spec || spec.startsWith('.') || spec.startsWith('node:')) continue;
    const parts = spec.split('/');
    names.push(spec.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]!);
  }
  return names;
}

describe('worker runtime dependencies', () => {
  it('no runtime source file imports a devDependency (it would be inlined into the ESM bundle)', () => {
    const dev = new Set(Object.keys(pkg.devDependencies ?? {}));
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      for (const name of runtimeImports(readFileSync(file, 'utf8'))) {
        if (dev.has(name)) offenders.push(`${relative(ROOT, file)} imports ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('jszip, which the audit packet job streams with, is a runtime dependency', () => {
    const deps = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).dependencies ?? {};
    expect(deps.jszip).toBeTruthy();
  });
});

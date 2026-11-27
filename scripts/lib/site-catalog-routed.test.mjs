// #397: site/src/content/docs-catalog.generated.json is regenerated on every app
// build (pnpm docs:catalog) and the new-app checklist edits the page that renders
// it, but from e07f1abe (2026-06-18) that page (DocsPage, site/src/pages/docs.tsx)
// was imported by nothing: /docs routed to the Manual. This guard fails when a
// page that renders the catalog is not reachable from a route in site/src/app.tsx,
// including when an earlier, broader prefix branch shadows its route.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..');
const PAGES = join(ROOT, 'site', 'src', 'pages');
const APP = join(ROOT, 'site', 'src', 'app.tsx');

/** Ordered route branches of app.tsx: [{ prefix, components: [...] }]. */
function routeBranches(src) {
  const branches = [];
  const re = /if \(path\.startsWith\('([^']+)'\)\) \{([\s\S]*?)\n {2}\}/g;
  for (const m of src.matchAll(re)) {
    branches.push({ prefix: m[1], components: [...m[2].matchAll(/<([A-Z]\w*)\s*\/>/g)].map((c) => c[1]) });
  }
  return branches;
}

test('every page that renders the docs catalog is reachable from a site route', () => {
  const appSrc = readFileSync(APP, 'utf8');
  const branches = routeBranches(appSrc);
  assert.ok(branches.length > 0, 'parsed no route branches from site/src/app.tsx; update the parser');

  const renderers = readdirSync(PAGES)
    .filter((f) => /\.tsx$/.test(f))
    .filter((f) => readFileSync(join(PAGES, f), 'utf8').includes('content/docs-catalog.generated.json'));
  assert.ok(renderers.length > 0, 'no page under site/src/pages renders docs-catalog.generated.json');

  for (const file of renderers) {
    const page = file.replace(/\.tsx$/, '');
    const src = readFileSync(join(PAGES, file), 'utf8');
    const exported = [...src.matchAll(/export (?:default )?function ([A-Z]\w*)/g)].map((m) => m[1]);
    // app.tsx lazy-imports the page and names the local component.
    const lazy = new RegExp(`const ([A-Z]\\w*) = lazy\\(\\(\\) => import\\('@/pages/${page}'\\)`).exec(appSrc);
    assert.ok(lazy, `site/src/app.tsx does not import @/pages/${page} (exports ${exported.join(', ')})`);
    const local = lazy[1];

    const idx = branches.findIndex((b) => b.components.includes(local));
    assert.ok(idx !== -1, `<${local} /> (site/src/pages/${file}) is not rendered by any route in site/src/app.tsx`);
    const { prefix } = branches[idx];
    const shadow = branches.slice(0, idx).find((b) => prefix.startsWith(b.prefix));
    assert.equal(
      shadow,
      undefined,
      `route '${prefix}' for <${local} /> is shadowed by the earlier branch '${shadow?.prefix}' in site/src/app.tsx`,
    );
  }
});

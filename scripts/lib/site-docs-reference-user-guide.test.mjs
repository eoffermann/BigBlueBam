// #399: /docs/reference (site/src/pages/docs.tsx, DocsPage) carried a hand-written
// "User Guide" tab that covered 9 of the 25 apps and had no generator or drift
// guard, while the Manual at /docs is generated from every docs/apps/<app>/help.md
// and guarded by docs:manual:check. The per-app user guide has one home, the
// Manual. This fails if a hand-written guide section returns to DocsPage or the
// sidebar stops pointing at the Manual route.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..');
const DOCS = readFileSync(join(ROOT, 'site', 'src', 'pages', 'docs.tsx'), 'utf8');
const APP = readFileSync(join(ROOT, 'site', 'src', 'app.tsx'), 'utf8');

test('DocsPage has no hand-written User Guide section', () => {
  const union = DOCS.match(/type SectionId = ([^;]+);/);
  assert.ok(union, 'could not find the SectionId union in docs.tsx; update this test');
  assert.doesNotMatch(
    union[1],
    /'user-guide'/,
    'DocsPage must not have a user-guide section; link to the Manual',
  );
  assert.doesNotMatch(DOCS, /function UserGuideContent\b/);
});

test('DocsPage links to the Manual, and /docs renders the Manual', () => {
  const href = DOCS.match(/const MANUAL_HREF = '([^']+)';/);
  assert.ok(href, 'docs.tsx must define MANUAL_HREF for the sidebar User Manual link');
  assert.match(DOCS, /href=\{MANUAL_HREF\}/);
  const branch = new RegExp(
    `if \\(path\\.startsWith\\('${href[1]}'\\)\\) \\{[\\s\\S]*?<ManualPage />`,
  );
  assert.match(APP, branch, `site/src/app.tsx must render <ManualPage /> for '${href[1]}'`);
});

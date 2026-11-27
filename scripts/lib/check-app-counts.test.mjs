// node:test suite for scripts/check-app-counts.mjs (issue #129).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  faqAnswer,
  findStaleAppCounts,
  findStaleToolCounts,
  missingFaqNames,
  moduleToolCounts,
  parseCount,
  PUBLISHED,
  toolCountFiles,
} from '../check-app-counts.mjs';
import { REPO_ROOT } from './bolt-sources.mjs';

test('parseCount reads digits and spelled-out numbers', () => {
  assert.equal(parseCount('24'), 24);
  assert.equal(parseCount('Twenty-four'), 24);
  assert.equal(parseCount('Nineteen'), 19);
  assert.equal(parseCount('thirty'), 30);
  assert.equal(parseCount('apple'), null);
});

test('findStaleAppCounts flags every published form of a wrong count', () => {
  const text = [
    '<img src="https://img.shields.io/badge/apps-23-blueviolet" />',
    '23 apps, one workspace; all 23 live under one roof.',
    'Nineteen apps that behave like one product.',
    'BigBlueBam ships twenty-three integrated applications.',
  ].join('\n');
  const stale = findStaleAppCounts(text, 24, 'x');
  assert.equal(stale.length, 5, stale.join('\n'));
});

test('findStaleAppCounts accepts the right count and ignores small numbers', () => {
  const text = 'the 24 apps; Twenty-four apps; apps-24; works across two apps; 3 apps';
  assert.deepEqual(findStaleAppCounts(text, 24, 'x'), []);
});

test('the suite introduction files are checked, including the meta.json app_count (issue #143)', () => {
  for (const rel of [
    'docs/apps/introduction/help.md',
    'docs/apps/introduction/help-index.json',
    'docs/apps/introduction/guide.md',
    'docs/apps/introduction/_narrative.md',
    'docs/apps/introduction/_marketing_hook.md',
    'docs/apps/introduction/meta.json',
  ]) {
    assert.ok(PUBLISHED.includes(rel), rel);
  }
  const old = ['## The sixteen apps', 'Sixteen apps that behave like one product.', '  "app_count": 16,'].join('\n');
  assert.equal(findStaleAppCounts(old, 24, 'x').length, 3);
});

test('the MCP server reference and the Comprehensive Overview are checked (issue #406)', () => {
  for (const rel of ['docs/reference/mcp-server.md', 'docs/BIGBLUEBAM_COMPREHENSIVE_OVERVIEW.md']) {
    assert.ok(PUBLISHED.includes(rel), rel);
    assert.ok(readFileSync(join(REPO_ROOT, 'scripts/check-tool-return-coverage.mjs'), 'utf8').includes(`'${rel}'`), rel);
  }
  const old = '**340 tools across 43 modules.** The suite is **sixteen apps under one auth**.';
  assert.equal(findStaleAppCounts(old, 25, 'x').length, 1);
});

test('missingFaqNames finds catalog apps the FAQ prose forgot', () => {
  const tsx = "  {\n    question: 'How many apps are included?',\n    answer: `Bam (x), Banter (y)`,\n  },\n";
  assert.deepEqual(missingFaqNames(faqAnswer(tsx), ['Bam', 'Banter', 'Bursar']), ['Bursar']);
});

const APPS = [
  { id: 'b3', name: 'Bam', toolCount: 128 },
  { id: 'bastion', name: 'Bastion', toolCount: 67 },
  { id: 'burn', name: 'Burn', toolCount: 18 },
];
const MODULES = { 'bastion-tools': 67, 'task-tools': 19 };

test('findStaleToolCounts flags every published form of a stale per-app count (issue #405)', () => {
  const text = [
    '- **Bastion (66 tools), compliance readiness.**',
    "'66 bastion_* MCP tools let an AI agent read readiness'",
    'Agents drive it through over 30 `burn_*` MCP tools.',
    'MCP module(s): `apps/mcp-server/src/tools/bastion-tools.ts` (66 tools, registered at M11)',
    '952 tools across 55 modules (128 Bam core + 66 Bastion + 18 Burn)',
    'Burn exposes 17 MCP tools plus one deprecated alias.',
  ].join('\n');
  const stale = findStaleToolCounts(text, { apps: APPS, modules: MODULES, label: 'x' });
  assert.equal(stale.length, 6, stale.join('\n'));
});

test('findStaleToolCounts accepts current counts and ignores small and suite-wide numbers', () => {
  const text = [
    '- **Bastion (67 tools), compliance readiness.** It works across 2 tools.',
    '`${APP_TOOL_COUNTS.bastion} bastion_* MCP tools`',
    '`bastion-tools.ts` (67 tools), `task-tools.ts` (19)',
    'The suite has 952 tools (128 Bam core + 67 Bastion + 18 Burn).',
  ].join('\n');
  assert.deepEqual(findStaleToolCounts(text, { apps: APPS, modules: MODULES, label: 'x' }), []);
});

test('a per-app file, or a heading that names an app, scopes bare "N MCP tools" to that app', () => {
  const scoped = findStaleToolCounts('Its 30 tools let agents act.\n"mcp_tool_count": 66', {
    apps: APPS, modules: MODULES, scopeApp: APPS[1], label: 'x',
  });
  assert.equal(scoped.length, 2, scoped.join('\n'));
  const sectioned = ['### Burn', '**AI agent surface:** 17 MCP tools.', '### Bastion', '67 MCP tools.'].join('\n');
  const stale = findStaleToolCounts(sectioned, { apps: APPS, modules: MODULES, label: 'x' });
  assert.deepEqual(stale, ['x:2 says "17 MCP tools" (expected 18)']);
});

test('every per-app doc folder and per-app site section is scanned', () => {
  const catalog = JSON.parse(
    readFileSync(join(REPO_ROOT, 'site/src/content/docs-catalog.generated.json'), 'utf8'),
  );
  const apps = catalog.filter((p) => p.id !== 'platform');
  const files = toolCountFiles(apps, REPO_ROOT);
  const byRel = new Map(files.map((f) => [f.rel, f.scopeApp?.id ?? null]));
  assert.equal(byRel.get('docs/apps/bastion/help.md'), 'bastion');
  assert.equal(byRel.get('docs/apps/bam/help.md'), 'b3');
  assert.equal(byRel.get('site/src/components/sections/bastion-section.tsx'), 'bastion');
  assert.equal(byRel.get('site/src/components/sections/banter-stub.tsx'), 'banter');
  assert.equal(byRel.get('CLAUDE.md'), null);
  assert.equal(byRel.get('docs/reference/mcp-endpoint-mapping.md'), null);
  const modules = moduleToolCounts(REPO_ROOT);
  for (const f of files) {
    const text = readFileSync(join(REPO_ROOT, f.rel), 'utf8');
    assert.deepEqual(
      findStaleToolCounts(text, { apps, modules, scopeApp: f.scopeApp, label: f.rel }),
      [],
      f.rel,
    );
  }
});

test('the committed published files agree with the committed catalog', () => {
  const catalog = JSON.parse(
    readFileSync(join(REPO_ROOT, 'site/src/content/docs-catalog.generated.json'), 'utf8'),
  );
  const apps = catalog.filter((p) => p.id !== 'platform');
  for (const rel of PUBLISHED) {
    const text = readFileSync(join(REPO_ROOT, rel), 'utf8');
    assert.deepEqual(findStaleAppCounts(text, apps.length, rel), [], rel);
  }
  const answer = faqAnswer(readFileSync(join(REPO_ROOT, 'site/src/pages/docs.tsx'), 'utf8'));
  assert.deepEqual(missingFaqNames(answer, apps.map((p) => p.name)), []);
});

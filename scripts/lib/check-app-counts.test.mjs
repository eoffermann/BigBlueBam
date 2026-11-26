// node:test suite for scripts/check-app-counts.mjs (issue #129).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  faqAnswer,
  findStaleAppCounts,
  missingFaqNames,
  parseCount,
  PUBLISHED,
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

test('missingFaqNames finds catalog apps the FAQ prose forgot', () => {
  const tsx = "  {\n    question: 'How many apps are included?',\n    answer: `Bam (x), Banter (y)`,\n  },\n";
  assert.deepEqual(missingFaqNames(faqAnswer(tsx), ['Bam', 'Banter', 'Bursar']), ['Bursar']);
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

#!/usr/bin/env node
/**
 * check-app-counts.mjs (issue #129)
 *
 * The number of apps in the suite is one fact: the non-`platform` entries of
 * site/src/content/docs-catalog.generated.json (generated from LAUNCHPAD_CATALOG
 * by `pnpm docs:catalog`, kept current by `pnpm docs:catalog:check`). This is the
 * same derivation as APP_COUNT in site/src/lib/facts.ts.
 *
 * Checks:
 *   1. Every app-count literal in the PUBLISHED files equals that count
 *      ("apps-24" badges, "24 apps", "Twenty-four applications", "all 24 live").
 *      Numbers below 10 are ignored ("two apps" in prose is not the suite total).
 *   2. Every catalog app name appears in the docs.tsx FAQ answer to
 *      "How many apps are included?", which is hand-written prose.
 *
 * Run alongside scripts/check-tool-return-coverage.mjs in the db-drift workflow.
 * Exits 0 when clean, 1 on any violation.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG = join(ROOT, 'site/src/content/docs-catalog.generated.json');

export const PUBLISHED = [
  'README.md',
  'site/index.html',
  'site/src/content/apps/introduction.md',
  'docs/apps/introduction/marketing.md',
  'site/src/pages/docs.tsx',
  'site/src/lib/facts.ts',
];

const ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen',
  'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

/** "24" -> 24, "twenty-four" -> 24, "Nineteen" -> 19; null if not a number. */
export function parseCount(token) {
  if (/^\d+$/.test(token)) return Number(token);
  const t = token.toLowerCase();
  const ones = ONES.indexOf(t);
  if (ones > 0) return ones;
  const [tens, unit] = t.split('-');
  const ti = TENS.indexOf(tens);
  if (ti < 2) return null;
  if (unit === undefined) return ti * 10;
  const ui = ONES.indexOf(unit);
  return ui > 0 && ui < 10 ? ti * 10 + ui : null;
}

const NUM = `(\\d{1,3}|(?:${[...ONES.slice(1), ...TENS.slice(2)].join('|')})(?:-(?:${ONES.slice(1, 10).join('|')}))?)`;

export const APP_COUNT_PATTERNS = [
  /\bapps-(\d+)\b/gi,
  new RegExp(`\\b${NUM} (?:integrated |connected |first-party )?(?:apps|applications)\\b`, 'gi'),
  new RegExp(`\\ball ${NUM} live\\b`, 'gi'),
];

export function findStaleAppCounts(text, expected, label) {
  const stale = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const re of APP_COUNT_PATTERNS) {
      for (const m of lines[i].matchAll(re)) {
        const n = parseCount(m[1]);
        if (n === null || n < 10) continue;
        if (n !== expected) stale.push(`${label}:${i + 1} says "${m[0]}" (expected ${expected})`);
      }
    }
  }
  return stale;
}

/** The FAQ answer text for the "How many apps are included?" question. */
export function faqAnswer(docsTsx) {
  const q = docsTsx.indexOf("question: 'How many apps are included?'");
  if (q < 0) return null;
  const a = docsTsx.indexOf('answer:', q);
  const end = docsTsx.indexOf('\n  },', a);
  return docsTsx.slice(a, end < 0 ? undefined : end);
}

export function missingFaqNames(answer, names) {
  return names.filter((name) => !new RegExp(`\\b${name}\\b`).test(answer));
}

function main() {
  const catalog = JSON.parse(readFileSync(CATALOG, 'utf8'));
  const apps = catalog.filter((p) => p.id !== 'platform');
  const expected = apps.length;
  let failed = false;

  const stale = [];
  for (const rel of PUBLISHED) {
    stale.push(...findStaleAppCounts(readFileSync(join(ROOT, rel), 'utf8'), expected, rel));
  }
  console.log(`catalog apps:          ${expected}`);
  console.log(`published app counts:  ${stale.length} stale (expected 0)`);
  if (stale.length) {
    failed = true;
    console.error(`FAIL: published app counts differ from the ${expected} catalog apps:`);
    for (const s of stale) console.error(`  ${s}`);
    console.error('');
  }

  const answer = faqAnswer(readFileSync(join(ROOT, 'site/src/pages/docs.tsx'), 'utf8'));
  if (answer === null) {
    failed = true;
    console.error('FAIL: docs.tsx has no "How many apps are included?" FAQ to check');
  } else {
    const missing = missingFaqNames(answer, apps.map((p) => p.name));
    console.log(`FAQ app names missing: ${missing.length} (expected 0)`);
    if (missing.length) {
      failed = true;
      console.error(`FAIL: the docs.tsx "How many apps are included?" FAQ does not name: ${missing.join(', ')}`);
    }
  }

  if (!failed) console.log('PASS: every published app count matches the catalog, and the FAQ names every app.');
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();

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
 *   3. (issue #405) Every per-app MCP tool count in the published files, the
 *      per-app docs folders and the per-app site sections equals that app's
 *      `toolCount` in the catalog, and every "`<module>-tools.ts` (N" equals the
 *      registerTool() calls in that module. The site sections read the number
 *      from APP_TOOL_COUNTS in site/src/lib/facts.ts rather than hard-coding it.
 *
 * Run alongside scripts/check-tool-return-coverage.mjs in the db-drift workflow.
 * Exits 0 when clean, 1 on any violation.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG = join(ROOT, 'site/src/content/docs-catalog.generated.json');

export const PUBLISHED = [
  'README.md',
  'site/index.html',
  'docs/apps/introduction/marketing.md',
  'site/src/pages/docs.tsx',
  'site/src/lib/facts.ts',
  // Issue #143: the suite introduction (in-app Help Center, guide, manual sources).
  'docs/apps/introduction/help.md',
  'docs/apps/introduction/help-index.json',
  'docs/apps/introduction/guide.md',
  'docs/apps/introduction/_narrative.md',
  'docs/apps/introduction/_marketing_hook.md',
  'docs/apps/introduction/meta.json',
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
  /"app_count":\s*(\d+)/g,
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

// ---------------------------------------------------------------------------
// Per-app MCP tool counts (issue #405)
// ---------------------------------------------------------------------------
// Each app's tool count is one fact: its `toolCount` in the generated catalog.
// A tool module's count is the number of registerTool() calls in its file.
// Published prose repeats both ("Bastion (67 tools)", "67 bastion_* MCP tools",
// "`bastion-tools.ts` (67 tools)", "+ 67 Bastion +"), and those copies went
// stale silently because only the suite total was checked.

/** Extra published files that state per-app or per-module tool counts. */
export const TOOL_COUNT_EXTRA = [
  'CLAUDE.md',
  'docs/reference/mcp-endpoint-mapping.md',
];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The docs/apps/<dir> folder for a catalog id (Bam's id is b3). */
export function docDirFor(id) {
  return id === 'b3' ? 'bam' : id;
}

/** The tool-name prefix an app's tools share ("bastion" for bastion_*); Bam has none. */
export function toolPrefixFor(id) {
  return id === 'b3' ? null : id;
}

/** "### Bastion (app)" / "## 4. Board" -> the app it introduces, or null. */
export function headingApp(line, apps) {
  const h = line.match(/^#{1,6}\s+(?:[\d.]+\s+)?([A-Z][A-Za-z]+)\b/);
  if (!h) return undefined;
  return apps.find((a) => a.name === h[1]) ?? null;
}

/**
 * Find per-app and per-module tool counts in `text` that disagree with the code.
 *   apps:      [{ id, name, toolCount }]
 *   modules:   { 'bastion-tools': 67, ... } (registerTool calls per file)
 *   scopeApp:  the app this whole file is about (docs/apps/<app>/..., <app>-section.tsx),
 *              or null for a suite-wide file, where a markdown heading naming an app
 *              scopes the lines under it.
 */
export function findStaleToolCounts(text, { apps, modules, scopeApp = null, label }) {
  const stale = [];
  const report = (i, said, expected) => stale.push(`${label}:${i + 1} says "${said}" (expected ${expected})`);
  const lines = text.split('\n');
  let sectionApp = null;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (!scopeApp) {
      const h = headingApp(line, apps);
      if (h !== undefined) sectionApp = h;
    }
    const scope = scopeApp ?? sectionApp;

    // Module counts: "`bastion-tools.ts` (67 tools", "`project-tools.ts` (25)".
    line = line.replace(/`(?:[\w./-]*\/)?([\w-]+-tools)\.ts`,? \((\d+)(?: MCP)?(?: tools?)?(?=[,)])/g, (m, mod, n) => {
      if (mod in modules && Number(n) !== modules[mod]) report(i, m, modules[mod]);
      return ' '.repeat(m.length);
    });

    for (const app of apps) {
      const name = escapeRe(app.name);
      const forms = [
        new RegExp(`\\b${name} \\((\\d+) (?:MCP )?tools\\)`, 'g'),
        new RegExp(`\\b${name} (?:exposes|has|ships|registers) (?:over |more than |about )?(\\d+) (?:MCP )?tools\\b`, 'g'),
      ];
      if (/\btools\b|\bMCP\b/.test(line)) forms.push(new RegExp(`(?:\\(|\\+ )(\\d+) ${name}\\b`, 'g'));
      const prefix = toolPrefixFor(app.id);
      if (prefix) forms.push(new RegExp(`\\b(?:over |more than |about )?(\\d+) \`?${prefix}_\\*\`? (?:MCP )?tools\\b`, 'g'));
      for (const re of forms) {
        line = line.replace(re, (m, n) => {
          if (Number(n) !== app.toolCount) report(i, m, app.toolCount);
          return ' '.repeat(m.length);
        });
      }
    }

    if (scope) {
      const forms = [/\b(?:over |more than |about )?(\d{1,3})\+? (?:MCP |agent )?tools\b/g];
      if (scopeApp) forms.push(/"mcp_tool_count":\s*(\d+)/g);
      for (const re of forms) {
        for (const m of line.matchAll(re)) {
          const n = Number(m[1]);
          if (n >= 10 && n !== scope.toolCount) report(i, m[0], scope.toolCount);
        }
      }
    }
  }
  return stale;
}

/** registerTool() calls per tool module basename ('bastion-tools' -> 67). */
export function moduleToolCounts(root = ROOT) {
  const dir = join(root, 'apps/mcp-server/src/tools');
  const out = {};
  for (const f of readdirSync(dir).filter((x) => x.endsWith('-tools.ts'))) {
    out[f.slice(0, -3)] = (readFileSync(join(dir, f), 'utf8').match(/registerTool\s*\(\s*server\s*,/g) || []).length;
  }
  return out;
}

/** [{ rel, scopeApp }] for every published file that may state a tool count. */
export function toolCountFiles(apps, root = ROOT) {
  const files = [...PUBLISHED, ...TOOL_COUNT_EXTRA].map((rel) => ({ rel, scopeApp: null }));
  for (const app of apps) {
    const dir = join(root, 'docs/apps', docDirFor(app.id));
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.md') || x.endsWith('.json')).sort()) {
      files.push({ rel: `docs/apps/${docDirFor(app.id)}/${f}`, scopeApp: app });
    }
  }
  for (const sub of ['site/src/components/sections', 'site/src/pages']) {
    for (const f of readdirSync(join(root, sub)).filter((x) => x.endsWith('.tsx')).sort()) {
      const id = sub.endsWith('sections') ? f.match(/^([a-z]+)-(?:section|stub)\.tsx$/)?.[1] : undefined;
      const rel = `${sub}/${f}`;
      if (files.some((x) => x.rel === rel)) continue;
      files.push({ rel, scopeApp: apps.find((a) => a.id === id) ?? null });
    }
  }
  return files;
}

function main() {
  const catalog = JSON.parse(readFileSync(CATALOG, 'utf8'));
  const apps = catalog.filter((p) => p.id !== 'platform');
  const expected = apps.length;
  let failed = false;

  const modules = moduleToolCounts();
  const staleTools = [];
  const toolFiles = toolCountFiles(apps);
  for (const { rel, scopeApp } of toolFiles) {
    staleTools.push(...findStaleToolCounts(readFileSync(join(ROOT, rel), 'utf8'), { apps, modules, scopeApp, label: rel }));
  }
  console.log(`tool-count files:      ${toolFiles.length}`);
  console.log(`per-app tool counts:   ${staleTools.length} stale (expected 0)`);
  if (staleTools.length) {
    failed = true;
    console.error('FAIL: published per-app or per-module MCP tool counts differ from the catalog / tool sources:');
    for (const s of staleTools) console.error(`  ${s}`);
    console.error('');
  }

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

#!/usr/bin/env node

/**
 * check-app-completeness.mjs
 *
 * HARD GATE - the Launchpad is the suite's "ready for consumption" contract.
 * An app is only allowed to appear in LAUNCHPAD_CATALOG once it is complete to
 * the suite-common standard. An incomplete app that leaks into the Launchpad
 * (its entry landed before the build finished, or the build died mid-flight) is
 * a consumer-facing defect: a user can click it from the Launchpad grid and land
 * on a half-built app, and an agent can see it advertised with no tools to drive.
 *
 * This script is the enforcement. For EVERY app registered in LAUNCHPAD_CATALOG
 * it verifies the suite-common completeness dimensions and exits non-zero if any
 * app is missing any of them. That non-zero exit fails CI (wired into the lint
 * workflow next to docs:catalog:check), which is exactly what the maintainer
 * asked for: landing an incomplete app should hard error and fail tests.
 *
 * The dimensions checked (all are objective filesystem facts):
 *   - MCP tools      : APP_TOOL_MODULES mapping whose module file(s) exist on
 *                      disk (the AI-first parity contract - agents must be able
 *                      to drive every app).
 *   - Help doc       : docs/apps/<app>/help.md (the in-app Help Center source).
 *   - Help index     : docs/apps/<app>/help-index.json (derived TOC/search).
 *   - Marketing      : site/src/components/sections/<app>-section.tsx registered
 *                      on a marketing page (the public site must show the app).
 *   - Screenshots    : site/public/screenshots/<app>/ with at least one PNG
 *                      (captured from the app's User Stories, gilligan data).
 *
 * When this gate fails in the autonomous loop, the failing app is NOT tolerated
 * or de-listed silently: the autonomous-cycle / close-out skills treat a failing
 * completeness gate as a trigger to RESUME automated engineering on that app
 * (finish the missing milestones, per its APP_DESIGN spec) and to run an agentic
 * readiness review of its plan + functionality before it is allowed to stand.
 *
 * Usage:
 *   node scripts/check-app-completeness.mjs           # report + exit 1 on any gap
 *   node scripts/check-app-completeness.mjs --json     # machine-readable report
 *
 * There is no --fix and no generated artifact: this is a pure gate.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT,
  readLaunchpadCatalog,
  APP_TOOL_MODULES,
  TOOLS_DIR,
  docDirForAppId,
} from './docs/lib/tool-source.mjs';

const asJson = process.argv.includes('--json');

function fileExists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

function dirHasMatch(rel, re) {
  const dir = path.join(ROOT, rel);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return false;
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        if (walk(full)) return true;
      } else if (re.test(entry.name)) {
        return true;
      }
    }
    return false;
  };
  return walk(dir);
}

/** MCP tools: the app has a module mapping and every mapped module file exists. */
function hasMcpTools(appId) {
  const modules = APP_TOOL_MODULES[appId];
  if (!modules || modules.length === 0) return false;
  return modules.every((m) => fs.existsSync(path.join(TOOLS_DIR, `${m}.ts`)));
}

// Bam is the CORE product (id "b3"). It is marketed by the entire marketing
// homepage (hero + kanban/sprint/views showcases), not a single per-app
// <app>-section.tsx, so it is exempt from the marketing-section requirement.
// Every OTHER app must have its own registered marketing section.
const CORE_MARKETED_BY_HOMEPAGE = new Set(['b3']);

// The README app-catalog region, read once. This is the generated block that
// gives GitHub visitors the whole suite (scripts/docs/publish.mjs). A Launchpad
// app must appear here too, so the repo front door never lags the Launchpad.
let _readmeCatalog = null;
function readmeCatalogText() {
  if (_readmeCatalog !== null) return _readmeCatalog;
  try {
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf-8');
    const start = readme.indexOf('<!-- AUTODOCS:APP_SECTIONS:START -->');
    const end = readme.indexOf('<!-- AUTODOCS:APP_SECTIONS:END -->');
    _readmeCatalog =
      start !== -1 && end !== -1 && end > start
        ? readme.slice(start, end)
        : '';
  } catch {
    _readmeCatalog = '';
  }
  return _readmeCatalog;
}

/** README catalog: the app has a card in the generated AUTODOCS:APP_SECTIONS region. */
function inReadmeCatalog(appId) {
  return readmeCatalogText().includes(`docs/apps/${docDirForAppId(appId)}/`);
}

/** Marketing: a registered per-app section (or a deliberate "coming soon" stub). */
function hasMarketingSection(appId) {
  if (CORE_MARKETED_BY_HOMEPAGE.has(appId)) return true;
  const dir = docDirForAppId(appId);
  return (
    fileExists(`site/src/components/sections/${appId}-section.tsx`) ||
    fileExists(`site/src/components/sections/${dir}-section.tsx`) ||
    fileExists(`site/src/components/sections/${appId}-stub.tsx`)
  );
}

/** The completeness dimensions, in report order. */
const DIMENSIONS = [
  {
    key: 'mcp_tools',
    label: 'MCP tools',
    check: (id) => hasMcpTools(id),
    hint: (id) =>
      `map "${id}" in APP_TOOL_MODULES (scripts/docs/lib/tool-source.mjs) to an existing apps/mcp-server/src/tools/${id}-tools.ts`,
  },
  {
    key: 'help_doc',
    label: 'Help doc',
    check: (id) => fileExists(`docs/apps/${docDirForAppId(id)}/help.md`),
    hint: (id) =>
      `author docs/apps/${docDirForAppId(id)}/help.md (help-doc-authoring skill)`,
  },
  {
    key: 'help_index',
    label: 'Help index',
    check: (id) => fileExists(`docs/apps/${docDirForAppId(id)}/help-index.json`),
    hint: (id) =>
      `build docs/apps/${docDirForAppId(id)}/help-index.json (node scripts/help/build-help-index.mjs --apps ${id})`,
  },
  {
    key: 'marketing',
    label: 'Marketing section',
    check: (id) => hasMarketingSection(id),
    hint: (id) =>
      `add site/src/components/sections/${id}-section.tsx and register it on a marketing page`,
  },
  {
    key: 'screenshots',
    label: 'Screenshots',
    check: (id) =>
      dirHasMatch(`site/public/screenshots/${docDirForAppId(id)}`, /\.png$/i),
    hint: (id) =>
      `capture User-Story screenshots into site/public/screenshots/${docDirForAppId(id)}/ (gilligan project only)`,
  },
  {
    key: 'readme_catalog',
    label: 'README catalog entry',
    check: (id) => inReadmeCatalog(id),
    hint: () =>
      `regenerate the README app catalog (pnpm docs:readme) so this app appears in the AUTODOCS:APP_SECTIONS region`,
  },
];

function main() {
  const apps = readLaunchpadCatalog();
  const report = [];

  for (const app of apps) {
    const missing = [];
    for (const dim of DIMENSIONS) {
      let ok = false;
      try {
        ok = dim.check(app.id);
      } catch {
        ok = false;
      }
      if (!ok) missing.push(dim);
    }
    report.push({ id: app.id, name: app.name, missing });
  }

  const incomplete = report.filter((r) => r.missing.length > 0);

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          total: report.length,
          incomplete: incomplete.map((r) => ({
            id: r.id,
            name: r.name,
            missing: r.missing.map((d) => d.key),
          })),
        },
        null,
        2,
      ),
    );
    process.exit(incomplete.length > 0 ? 1 : 0);
  }

  console.log('Checking Launchpad app completeness');
  console.log(`  Launchpad apps: ${report.length}`);
  console.log(`  Dimensions: ${DIMENSIONS.map((d) => d.label).join(', ')}`);
  console.log('');

  for (const r of report) {
    if (r.missing.length === 0) {
      console.log(`  PASS  ${r.name} (${r.id})`);
    } else {
      console.log(
        `  FAIL  ${r.name} (${r.id}): missing ${r.missing.map((d) => d.label).join(', ')}`,
      );
    }
  }

  if (incomplete.length === 0) {
    console.log(`\nAll ${report.length} Launchpad apps are complete.`);
    return;
  }

  console.error(
    `\nINCOMPLETE APPS IN THE LAUNCHPAD (${incomplete.length}) - refusing to pass:`,
  );
  for (const r of incomplete) {
    console.error(`\n  ${r.name} (${r.id}):`);
    for (const dim of r.missing) {
      console.error(`    - missing ${dim.label}: ${dim.hint(r.id)}`);
    }
  }
  console.error(
    '\nThe Launchpad is the suite\'s "ready for consumption" contract. An app\n' +
      'appears there only once it is complete. Either finish the missing pieces\n' +
      '(resume the build per its docs/brainstorming/*_APP_DESIGN_<app>.md spec) or,\n' +
      'if the app is being pulled, remove its LAUNCHPAD_CATALOG entry. Do not\n' +
      'weaken this gate to make it pass.',
  );
  process.exit(1);
}

main();

#!/usr/bin/env node

/**
 * build-docs-catalog.mjs
 *
 * Generates the machine-readable MCP tool catalog that the marketing site's
 * /docs page renders. This is what makes /docs impossible to drift: every app
 * in LAUNCHPAD_CATALOG and every tool it registers is derived directly from the
 * mcp-server tool source at generation time, then committed as JSON that the
 * site build imports (the site Docker build context is only `site/`, so it
 * cannot run monorepo scripts - generation happens here, the JSON is committed,
 * exactly like manual.generated.json).
 *
 * Source of truth:
 *   - App roster + order + name/description: LAUNCHPAD_CATALOG in
 *     apps/api/src/routes/system-settings.routes.ts (read at run time).
 *   - Per-app tools: apps/mcp-server/src/tools/<module>.ts, mapped via
 *     APP_TOOL_MODULES in scripts/docs/lib/tool-source.mjs.
 *
 * Output (deterministic; re-running produces no diff):
 *   site/src/content/docs-catalog.generated.json
 *   An ordered array of:
 *     { id, name, description, toolCount,
 *       categories: [{ name, tools: [{ name, description }] }] }
 *
 * Usage:
 *   node scripts/docs/build-docs-catalog.mjs [--dry-run]
 *   node scripts/docs/build-docs-catalog.mjs --check   # fail (exit 1) if the
 *                                                        # committed JSON is stale
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT,
  readLaunchpadCatalog,
  parseAppModules,
  parseModules,
  listPlatformModules,
  isStructuralWarning,
} from './lib/tool-source.mjs';

const dryRun = process.argv.includes('--dry-run');
const checkMode = process.argv.includes('--check');

const OUT_FILE = path.join(
  ROOT,
  'site',
  'src',
  'content',
  'docs-catalog.generated.json',
);

function main() {
  console.log('Building MCP tool catalog for /docs');
  console.log(`  Root: ${ROOT}`);

  const apps = readLaunchpadCatalog();
  console.log(`  Launchpad apps: ${apps.length}`);

  const warnings = [];
  const products = [];

  for (const app of apps) {
    const groups = parseAppModules(app.id, warnings);

    // Build categories. Multi-module apps keep one category per module with a
    // friendly label; single-module apps collapse to one "Tools" category so
    // the section header is not redundant with the product name.
    let categories;
    if (groups.length === 1) {
      const tools = [...groups[0].tools].sort((a, b) =>
        a.name.localeCompare(b.name),
      );
      categories = [{ name: 'Tools', tools: stripParams(tools) }];
    } else {
      categories = groups
        .filter((g) => g.tools.length > 0)
        .map((g) => ({
          name: g.label,
          tools: stripParams(
            [...g.tools].sort((a, b) => a.name.localeCompare(b.name)),
          ),
        }));
    }

    const toolCount = categories.reduce((sum, c) => sum + c.tools.length, 0);
    if (toolCount === 0) {
      warnings.push(`App "${app.id}" produced zero tools`);
    }

    products.push({
      id: app.id,
      name: app.name,
      description: app.description,
      toolCount,
      categories,
    });

    console.log(
      `  ${app.name} (${app.id}): ${toolCount} tools across ${categories.length} categor${
        categories.length === 1 ? 'y' : 'ies'
      }`,
    );
  }

  // Platform product: every tool module NOT claimed by an app. This makes the
  // /docs total equal the true count of registered tools (matching CLAUDE.md +
  // the marketing site), tracking the cross-cutting agent/platform tools as one
  // "Platform" product rather than silently dropping them.
  const platformGroups = parseModules(listPlatformModules(), warnings, 'platform')
    .filter((g) => g.tools.length > 0)
    .map((g) => ({
      name: g.label,
      tools: stripParams([...g.tools].sort((a, b) => a.name.localeCompare(b.name))),
    }));
  if (platformGroups.length > 0) {
    const platformToolCount = platformGroups.reduce((s, c) => s + c.tools.length, 0);
    products.push({
      id: 'platform',
      name: 'Platform',
      description:
        'Cross-cutting agent and platform tools available across every app: identity, audit, heartbeat, agent policies, proposals, visibility preflight, unified activity, cross-app search, resolvers, composite views, entity links, attachments, dedupe, expertise, webhooks, and more.',
      toolCount: platformToolCount,
      categories: platformGroups,
    });
    console.log(
      `  Platform (platform): ${platformToolCount} tools across ${platformGroups.length} categories`,
    );
  }

  const totalTools = products.reduce((sum, p) => sum + p.toolCount, 0);
  console.log(`  Total: ${products.length} products, ${totalTools} tools`);

  // Split warnings into structural (fatal - the catalog is likely mis-counting)
  // and soft (informational, e.g. a genuinely tool-less app).
  const structural = warnings.filter(isStructuralWarning);
  const soft = warnings.filter((w) => !isStructuralWarning(w));

  if (soft.length > 0) {
    console.log('\nWarnings:');
    for (const w of soft) console.log(`  - ${w}`);
  }

  if (structural.length > 0) {
    console.error(
      '\nSTRUCTURAL ERRORS (the tool catalog would be mis-counted; refusing to continue):',
    );
    for (const w of structural) console.error(`  - ${w}`);
    console.error(
      '\nFix the app->module mapping in scripts/docs/lib/tool-source.mjs (APP_TOOL_MODULES)\n' +
        'and/or the tool source, then re-run. The output file was NOT written.',
    );
    process.exit(1);
  }

  const json = JSON.stringify(products, null, 2) + '\n';

  // --check: regenerate in memory and compare to the committed file, so CI can
  // prove the "impossible to drift" guarantee. Compare line-ending agnostically
  // - a Windows (autocrlf) checkout stores the JSON as CRLF while we emit LF,
  // which would otherwise report an up-to-date file as stale.
  if (checkMode) {
    const norm = (s) => s.replace(/\r\n?/g, '\n');
    const prev = fs.existsSync(OUT_FILE)
      ? fs.readFileSync(OUT_FILE, 'utf-8')
      : null;
    if (prev === null) {
      console.error(
        `\n[stale] ${path.relative(ROOT, OUT_FILE)} does not exist. Run: pnpm docs:catalog`,
      );
      process.exit(1);
    }
    if (norm(prev) !== norm(json)) {
      console.error(
        `\n[stale] ${path.relative(ROOT, OUT_FILE)} is out of date.\n` +
          'Run: pnpm docs:catalog  (then commit the regenerated JSON).',
      );
      process.exit(1);
    }
    console.log(`\n${path.relative(ROOT, OUT_FILE)} is current.`);
    return;
  }

  if (dryRun) {
    console.log('\n[dry-run] Not writing output.');
    return;
  }
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, json, 'utf-8');
  console.log(`\nWrote ${path.relative(ROOT, OUT_FILE)}`);
}

/** Drop the internal `params` field; the catalog only needs name + description. */
function stripParams(tools) {
  return tools.map((t) => ({ name: t.name, description: t.description }));
}

main();

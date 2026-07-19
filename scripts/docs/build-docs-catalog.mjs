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
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT,
  readLaunchpadCatalog,
  parseAppModules,
} from './lib/tool-source.mjs';

const dryRun = process.argv.includes('--dry-run');

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

  const totalTools = products.reduce((sum, p) => sum + p.toolCount, 0);
  console.log(`  Total: ${products.length} products, ${totalTools} tools`);

  if (warnings.length > 0) {
    console.log('\nWarnings:');
    for (const w of warnings) console.log(`  - ${w}`);
  }

  const json = JSON.stringify(products, null, 2) + '\n';
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

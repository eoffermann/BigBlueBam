#!/usr/bin/env node
/**
 * bbam-shots — populated-screenshot capture CLI.
 *
 * Usage:
 *   bbam-shots                       # every recipe, against the local stack
 *   bbam-shots --apps board,bond     # only these apps
 *   bbam-shots --ids board-kanban    # only these recipe ids
 *   bbam-shots --list                # list resolved recipes, capture nothing
 *   bbam-shots --env raw             # raw-local base URL (SHOTS_BASE_URL)
 *
 * Environment: see environment.ts. Output: <repo>/screenshots/<app>/<id>.png
 * plus <repo>/screenshots/manifest.json. Production capture is deferred.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveEnvironment } from './environment.js';
import { loadRecipes } from './recipe.js';
import { runRecipes } from './runner.js';

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(PKG_DIR, '..', '..');
const DEFAULT_RECIPES_DIR = path.join(PKG_DIR, 'recipes');
const DEFAULT_OUT_ROOT = path.join(REPO_ROOT, 'screenshots');

function parseArgs(argv: string[]): {
  apps?: string[];
  ids?: string[];
  recipesDir: string;
  outRoot: string;
  env?: string;
  list: boolean;
} {
  const out = {
    recipesDir: process.env.SHOTS_RECIPES_DIR || DEFAULT_RECIPES_DIR,
    outRoot: process.env.SHOTS_OUT_ROOT || DEFAULT_OUT_ROOT,
    list: false,
  } as ReturnType<typeof parseArgs>;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apps') out.apps = argv[++i]?.split(',').map((s) => s.trim().toLowerCase());
    else if (a === '--ids') out.ids = argv[++i]?.split(',').map((s) => s.trim());
    else if (a === '--recipes-dir') out.recipesDir = path.resolve(argv[++i]!);
    else if (a === '--out') out.outRoot = path.resolve(argv[++i]!);
    else if (a === '--env') out.env = argv[++i];
    else if (a === '--list') out.list = true;
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const recipes = loadRecipes({ recipesDir: args.recipesDir, apps: args.apps, ids: args.ids });

  if (recipes.length === 0) {
    console.error('No recipes matched. Check --apps/--ids and the recipes directory.');
    process.exit(1);
  }

  if (args.list) {
    console.log(`Resolved ${recipes.length} recipe(s):`);
    for (const { recipe, file } of recipes) {
      console.log(`  ${recipe.app}/${recipe.id}  [${recipe.capture.theme} ${recipe.capture.viewport}]  — ${recipe.demonstrates}`);
      console.log(`      ${path.relative(REPO_ROOT, file)}`);
    }
    return;
  }

  const env = await resolveEnvironment({ target: args.env });
  console.log(`\n=== Populated Screenshot Capture ===`);
  console.log(`Environment: ${env.name} (${env.baseUrl})`);
  console.log(`Recipes:     ${recipes.length}`);
  console.log(`Output:      ${args.outRoot}\n`);

  const results = await runRecipes(recipes, { env, outRoot: args.outRoot, log: (m) => console.log(m) });

  const ok = results.filter((r) => r.ok).length;
  const failed = results.length - ok;
  console.log(`\n=== Summary ===\n  captured: ${ok}\n  failed:   ${failed}\n`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});

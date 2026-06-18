/**
 * Recipe schema + loader for the populated-screenshot-capture skill.
 *
 * A "recipe" is the declarative description of one screenshot: which app and
 * route, who to act as, what content the view needs (so we never shoot an empty
 * state), the interaction steps to reach the exact state, and how to capture it.
 * Recipes are authored as YAML under `recipes/<app>/*.yaml`; this module parses
 * and validates them with Zod so a malformed recipe fails loudly at load time
 * rather than mid-capture.
 */

import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Viewport presets
// ---------------------------------------------------------------------------

/** Named viewport presets recipes reference by key (keeps recipes terse). */
export const VIEWPORTS = {
  'desktop-1440': { width: 1440, height: 900 },
  'desktop-1280': { width: 1280, height: 800 },
  'tablet-768': { width: 768, height: 1024 },
  'mobile-390': { width: 390, height: 844 },
} as const;

export type ViewportPreset = keyof typeof VIEWPORTS;

// ---------------------------------------------------------------------------
// Interaction steps
// ---------------------------------------------------------------------------

/**
 * One ordered UI step. `action` selects the verb; the other fields are
 * interpreted per-verb (see the runner). Prefer `role=`/`data-testid=`
 * selectors over brittle CSS.
 */
export const InteractionStepSchema = z.object({
  action: z.enum([
    'navigate', // go to `url` (relative to app base)
    'click',
    'hover',
    'fill', // type `value` into `selector`
    'press', // press keyboard `value` (e.g. "Enter")
    'select', // pick `value` in a <select> / listbox at `selector`
    'scrollTo', // scroll `selector` into view
    'waitFor', // wait for `selector` visible
    'waitForNetworkIdle',
    'wait', // fixed `ms` pause (use sparingly; prefer waitFor)
  ]),
  selector: z.string().optional(),
  value: z.string().optional(),
  url: z.string().optional(),
  ms: z.number().int().positive().optional(),
  /** Don't fail the run if this step can't complete (best-effort setup). */
  optional: z.boolean().optional(),
  /**
   * Skip this step entirely when the named env var is unset/empty. Lets a
   * recipe carry an optional credentialed leg (e.g. a separate-portal login)
   * that simply no-ops — degrading to a clean public capture — until an
   * operator supplies the secret. `value`/`url` support `${ENV_VAR}`
   * interpolation, so credentials are never hardcoded in recipes.
   */
  skipIfEnvUnset: z.string().optional(),
}).strict();

export type InteractionStep = z.infer<typeof InteractionStepSchema>;

// ---------------------------------------------------------------------------
// Content preconditions (drives seeding — see seeding.ts)
// ---------------------------------------------------------------------------

/**
 * Declarative content preconditions. `kind` names a fixture builder the
 * seeding module knows how to satisfy (e.g. "board", "bond-pipeline"); `spec`
 * is the free-form shape passed to that builder. `force_seed` always (re)seeds
 * even if the view looks populated.
 */
export const ContentSchema = z.object({
  kind: z.string(),
  spec: z.record(z.unknown()).optional().default({}),
  force_seed: z.boolean().optional().default(false),
}).strict();

export type Content = z.infer<typeof ContentSchema>;

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

export const CaptureSchema = z.object({
  /** `fullPage`, a CSS/role selector (element shot), or "x,y,w,h" clip rect. */
  target: z.string().default('fullPage'),
  viewport: z.enum(['desktop-1440', 'desktop-1280', 'tablet-768', 'mobile-390']).default('desktop-1440'),
  theme: z.enum(['light', 'dark']).default('light'),
  /** 1 for docs, 2 for retina/marketing. */
  deviceScaleFactor: z.number().int().min(1).max(3).default(1),
}).strict();

export type Capture = z.infer<typeof CaptureSchema>;

// ---------------------------------------------------------------------------
// Recipe
// ---------------------------------------------------------------------------

export const RecipeSchema = z.object({
  /** Stable slug — output filename + manifest key. */
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'id must be kebab-case'),
  /** App slug (bam, board, bond, …) — selects base URL + output dir. */
  app: z.string().regex(/^[a-z][a-z0-9-]*$/),
  /** Human description of what the shot shows (drives content evaluation). */
  demonstrates: z.string().min(1),
  /** Route relative to the app base URL, e.g. "/board/". */
  route: z.string().startsWith('/'),
  /** Seeded identity to act as (resolved by the environment config). */
  identity: z.string().default('admin'),
  /** Optional content preconditions; omitted = assume the view is populated. */
  content: ContentSchema.optional(),
  /** Ordered interaction steps after navigation. */
  interactions: z.array(InteractionStepSchema).default([]),
  capture: CaptureSchema.default({}),
  /**
   * Verification BEFORE capture — proves the recipe actually reached the
   * intended view. Each entry is a selector (or `text=…`) that MUST be visible;
   * if any is missing the recipe FAILS and no (misleading) image is written.
   * Strongly recommended on every recipe, and required on any that depend on
   * auth / interactions / seeded data.
   */
  expect: z.union([z.string(), z.array(z.string())]).optional(),
  /**
   * Selectors/text that must NOT be present at capture time (e.g. an error
   * banner, or the login form on a view that should be authenticated). If any
   * is present the recipe FAILS. A built-in guard already fails on common
   * error states (invalid-credentials, page-not-found, error boundary).
   */
  expectNot: z.union([z.string(), z.array(z.string())]).optional(),
  /** Selectors whose contents are redacted/frozen before capture. */
  masks: z.array(z.string()).default([]),
  /** Optional output path override (relative to the shared screenshots root). */
  output: z.string().optional(),
  /**
   * Opt-in marker that this capture is a curated doc/marketing image. When set,
   * `scripts/docs/bridge.mjs` copies the shot into
   * `docs/apps/<app>/screenshots/<theme>/<NN>-<slug>.png` and regenerates the
   * per-app `meta.json`. `order` is the ordinal (give a light recipe and its
   * `-dark` sibling the SAME order so they pair into light/ and dark/); `label`
   * is the human caption stored in meta.json. Recipes without `doc` are still
   * captured but are NOT published into the docs.
   */
  doc: z
    .object({
      order: z.number().int().positive(),
      label: z.string().min(1),
    })
    .strict()
    .optional(),
}).strict();

export type Recipe = z.infer<typeof RecipeSchema>;

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export interface LoadOptions {
  /** Root dir holding `<app>/*.yaml` recipe files. */
  recipesDir: string;
  /** Restrict to these app slugs. */
  apps?: string[];
  /** Restrict to these recipe ids. */
  ids?: string[];
}

/** A recipe paired with the file it came from (for error messages). */
export interface LoadedRecipe {
  recipe: Recipe;
  file: string;
}

/**
 * Load + validate every YAML recipe under `recipesDir/<app>/*.yaml`.
 *
 * A YAML file may contain a single recipe (mapping) or a list of recipes
 * (sequence). The file's parent directory name must match each recipe's `app`
 * field, catching copy-paste mistakes. Throws an aggregated error listing every
 * invalid recipe rather than failing on the first.
 */
export function loadRecipes(opts: LoadOptions): LoadedRecipe[] {
  const { recipesDir } = opts;
  if (!fs.existsSync(recipesDir)) {
    throw new Error(`Recipes directory not found: ${recipesDir}`);
  }

  const appFilter = opts.apps?.map((a) => a.toLowerCase());
  const idFilter = opts.ids ? new Set(opts.ids) : null;
  const loaded: LoadedRecipe[] = [];
  const errors: string[] = [];
  const seenIds = new Map<string, string>();

  const appDirs = fs
    .readdirSync(recipesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((app) => !appFilter || appFilter.includes(app.toLowerCase()))
    .sort();

  for (const app of appDirs) {
    const appDir = path.join(recipesDir, app);
    const files = fs
      .readdirSync(appDir)
      .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
      .sort();

    for (const file of files) {
      const full = path.join(appDir, file);
      let raw: unknown;
      try {
        raw = parseYaml(fs.readFileSync(full, 'utf8'));
      } catch (err) {
        errors.push(`${full}: YAML parse error — ${(err as Error).message}`);
        continue;
      }

      const entries = Array.isArray(raw) ? raw : [raw];
      for (const entry of entries) {
        const result = RecipeSchema.safeParse(entry);
        if (!result.success) {
          errors.push(`${full}: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
          continue;
        }
        const recipe = result.data;
        if (recipe.app !== app) {
          errors.push(`${full}: recipe.app "${recipe.app}" does not match its directory "${app}"`);
          continue;
        }
        const dupe = seenIds.get(recipe.id);
        if (dupe) {
          errors.push(`${full}: duplicate recipe id "${recipe.id}" (also in ${dupe})`);
          continue;
        }
        seenIds.set(recipe.id, full);
        if (idFilter && !idFilter.has(recipe.id)) continue;
        loaded.push({ recipe, file: full });
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`Recipe validation failed:\n  - ${errors.join('\n  - ')}`);
  }
  return loaded;
}

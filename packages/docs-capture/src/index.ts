// Legacy scene-based helpers (used by scripts/docs/capture.mjs).
export { createDocPage, setTheme, ensureOrg, snap, runScenes } from './helpers.js';
export type { SceneResult } from './helpers.js';
export type { Scene, SnapOptions, RunScenesOptions, Theme, ScreenshotMeta } from './types.js';

// Recipe-driven capture engine (the populated-screenshot-capture skill).
export {
  loadRecipes,
  RecipeSchema,
  VIEWPORTS,
  type Recipe,
  type LoadedRecipe,
  type InteractionStep,
  type Content,
  type Capture,
  type ViewportPreset,
} from './recipe.js';
export { resolveEnvironment, type ResolvedEnvironment, type Identity } from './environment.js';
export {
  FROZEN_TIME_ISO,
  disableAnimations,
  installFrozenClock,
  newDeterministicContext,
  resolveMasks,
} from './determinism.js';
export { ManifestWriter, resolveGitSha, type ManifestEntry } from './manifest.js';
export {
  ensureContent,
  registerFixture,
  getFixture,
  apiGet,
  apiPost,
  sqlSeed,
  type FixtureBuilder,
  type SeedContext,
} from './seeding.js';
export { runRecipes, type RunOptions, type RunResult } from './runner.js';

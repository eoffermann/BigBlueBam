/**
 * The per-app files under docs/apps/<app>/ that the docs pipeline generates,
 * and which stage owns each one (#400). One file, one writer:
 *
 *   meta.json         written ONLY by scripts/docs/extract.mjs. An object of
 *                     route/schema/MCP-tool counts plus the API source hash
 *                     (`{ app, route_files, schema_modules, mcp_tool_count,
 *                     src_hash, ... }`). Read by compose, publish (README
 *                     cards), check-app-counts and the docs book.
 *   screenshots.json  written only by the legacy scene capture
 *                     (scripts/docs/capture.mjs and docs-capture runScenes):
 *                     an array of `{ id, label, theme, file, sha256, width,
 *                     height, captured_at }`, one per screenshot.
 *
 * scripts/docs/bridge.mjs (the recipe engine's path) writes neither: it only
 * copies PNGs into docs/apps/<app>/screenshots/<theme>/, and the per-shot
 * record stays in screenshots/manifest.json.
 *
 * Before #400 the screenshot stages also wrote meta.json, so its shape
 * depended on which stage ran last. Every path to these files goes through
 * the helpers below; the literal file names live only here (the
 * packages/docs-capture TypeScript writer mirrors APP_SCREENSHOTS_FILE, and
 * scripts/lib/docs-app-files.test.mjs checks that it does).
 */

import fs from 'node:fs';
import path from 'node:path';

export const APP_META_FILE = 'meta.json';
export const APP_SCREENSHOTS_FILE = 'screenshots.json';

/** docs/apps/<app>/meta.json under `root`. Only extract.mjs writes it. */
export function appMetaPath(root, app) {
  return path.join(root, 'docs', 'apps', app, APP_META_FILE);
}

/** docs/apps/<app>/screenshots.json under `root`. Only the screenshot stages write it. */
export function appScreenshotsPath(root, app) {
  return path.join(root, 'docs', 'apps', app, APP_SCREENSHOTS_FILE);
}

/** True when `value` has the extract-owned meta.json shape (an object with a string `app`). */
export function isAppMeta(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && typeof value.app === 'string';
}

/**
 * Parse docs/apps/<app>/meta.json. Throws, naming the owning stage, when the
 * file is not the extract shape (for example a screenshot array left by an
 * older bridge run), so a reader never silently renders "undefined routes".
 */
export function readAppMeta(root, app) {
  const file = appMetaPath(root, app);
  const value = JSON.parse(fs.readFileSync(file, 'utf-8'));
  if (!isAppMeta(value)) {
    throw new Error(
      `${path.relative(root, file)} is not the extract.mjs counts object (got ${Array.isArray(value) ? 'an array' : typeof value}). ` +
        `Rerun \`node scripts/docs/extract.mjs\`; screenshot lists belong in ${APP_SCREENSHOTS_FILE}.`,
    );
  }
  return value;
}

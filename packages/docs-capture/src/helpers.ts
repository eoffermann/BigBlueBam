import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Browser, Page } from 'playwright';
import type { RunScenesOptions, Scene, ScreenshotMeta, SnapOptions, Theme } from './types.js';

/**
 * Per-app screenshot list file under docs/apps/<app>/. Mirrors
 * APP_SCREENSHOTS_FILE in scripts/docs/lib/app-doc-files.mjs (this package
 * cannot import that .mjs module); scripts/lib/docs-app-files.test.mjs fails
 * if the two drift. meta.json is extract.mjs's file and is never written here.
 */
export const APP_SCREENSHOTS_FILE = 'screenshots.json';

const VIEWPORT = { width: 1440, height: 900 };
const DEFAULT_BASE_URL = 'http://localhost';
const DEFAULT_TIMEOUT = 15_000;
const SETTLE_DELAY = 1500;

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

const AUTH_STATE_PATH = path.resolve('apps/e2e/.auth/admin.json');

function authStateIsFresh(): boolean {
  try {
    const stat = fs.statSync(AUTH_STATE_PATH);
    // Consider fresh if less than 30 minutes old
    return Date.now() - stat.mtimeMs < 30 * 60 * 1000;
  } catch {
    return false;
  }
}

/**
 * Create an authenticated Playwright page for documentation capture.
 *
 * Reuses the E2E auth state file when fresh; otherwise performs a UI login
 * using DOCS_CAPTURE_USER / DOCS_CAPTURE_PASSWORD env vars.
 */
export async function createDocPage(
  browser: Browser,
  opts: { theme?: Theme; app?: string } = {},
): Promise<Page> {
  const baseURL = process.env.DOCS_CAPTURE_BASE_URL || DEFAULT_BASE_URL;
  const useSavedState = authStateIsFresh();

  const context = await browser.newContext({
    viewport: VIEWPORT,
    ...(useSavedState ? { storageState: AUTH_STATE_PATH } : {}),
  });

  const page = await context.newPage();
  page.setDefaultTimeout(DEFAULT_TIMEOUT);

  if (!useSavedState) {
    const email = process.env.DOCS_CAPTURE_USER || 'admin@example.com';
    const password = process.env.DOCS_CAPTURE_PASSWORD || 'BigBlueBam-2026-dev-pw';

    await page.goto(`${baseURL}/b3/login`, { waitUntil: 'networkidle', timeout: 20_000 });
    await page.fill('input[name=email]', email);
    await page.fill('input[name=password]', password);

    const loginResponse = page.waitForResponse(
      (r) => r.url().includes('/b3/api/auth/login') && r.request().method() === 'POST',
      { timeout: 15_000 },
    );
    await page.click('button[type=submit]');
    await loginResponse;

    await page.waitForFunction(() => !window.location.pathname.endsWith('/login'), undefined, {
      timeout: 10_000,
    });
    await page.waitForTimeout(SETTLE_DELAY);
  }

  if (opts.theme) {
    await setTheme(page, opts.theme);
  }

  return page;
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

/**
 * Set the app theme to light or dark.
 *
 * Writes the canonical `bbam-theme` localStorage key and toggles the `dark`
 * class on `document.documentElement`, then reloads so every SPA picks it up.
 */
export async function setTheme(page: Page, theme: Theme): Promise<void> {
  await page.evaluate((t) => {
    localStorage.setItem('bbam-theme', t);
    if (t === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, theme);

  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(SETTLE_DELAY);

  // Re-apply class after reload in case the SPA reset it before hydrating
  await page.evaluate((t) => {
    if (t === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, theme);
}

// ---------------------------------------------------------------------------
// Org
// ---------------------------------------------------------------------------

/**
 * Ensure the page is operating under the correct org context.
 *
 * Navigates to the Bam app and attempts to switch to the org matching `slug`.
 * This is best-effort; if the switcher is not visible the function returns
 * silently (the seeded dev stack typically has a single org).
 */
export async function ensureOrg(page: Page, slug: string): Promise<void> {
  const baseURL = process.env.DOCS_CAPTURE_BASE_URL || DEFAULT_BASE_URL;
  await page.goto(`${baseURL}/b3/`, { waitUntil: 'networkidle', timeout: 20_000 });

  const switchBtn = page.locator('button[title="Switch organization"]').first();
  if ((await switchBtn.count()) === 0) return;

  await switchBtn.click();
  await page.waitForTimeout(400);

  const orgItem = page.locator(`[role=menuitem]:has-text("${slug}"), button:has-text("${slug}")`).first();
  if ((await orgItem.count()) > 0) {
    await orgItem.click();
    await page.waitForTimeout(2000);
  } else {
    await page.keyboard.press('Escape');
  }
}

// ---------------------------------------------------------------------------
// Snap
// ---------------------------------------------------------------------------

/**
 * Take a single screenshot and return its metadata.
 */
export async function snap(page: Page, opts: SnapOptions): Promise<ScreenshotMeta> {
  if (opts.waitFor) {
    await page.locator(opts.waitFor).first().waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT }).catch(() => {
      // If the selector never appears, capture what we have
      console.warn(`[snap] waitFor selector "${opts.waitFor}" not found, capturing anyway`);
    });
  }

  // Small settle for animations
  await page.waitForTimeout(500);

  const dir = path.dirname(opts.file);
  fs.mkdirSync(dir, { recursive: true });

  const buffer = await page.screenshot({ path: opts.file, type: 'png' });
  const sha256 = createHash('sha256').update(buffer).digest('hex');

  // Read dimensions from PNG header (bytes 16-23 are width/height as 4-byte big-endian)
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);

  return {
    id: path.basename(opts.file, '.png'),
    label: opts.label,
    theme: opts.file.includes('/dark/') ? 'dark' : 'light',
    file: opts.file,
    sha256,
    width,
    height,
    captured_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Scene runner
// ---------------------------------------------------------------------------

export interface SceneResult {
  scene: Scene;
  theme: Theme;
  success: boolean;
  meta?: ScreenshotMeta;
  error?: string;
}

/**
 * Run a list of scenes for a given app, capturing each scene in both light
 * and dark themes.
 *
 * Returns per-scene results and writes the per-app `screenshots.json` list
 * beside the screenshots.
 */
export async function runScenes(
  browser: Browser,
  app: string,
  scenes: Scene[],
  options: RunScenesOptions = {},
): Promise<SceneResult[]> {
  const baseURL = options.baseURL || DEFAULT_BASE_URL;
  const outputRoot = options.outputDir || path.resolve('docs/apps');
  const themes: Theme[] = ['light', 'dark'];
  const results: SceneResult[] = [];
  const allMeta: ScreenshotMeta[] = [];

  for (const theme of themes) {
    const page = await createDocPage(browser, { theme });

    for (const scene of scenes) {
      const screenshotAfter = scene.screenshot_after !== false;
      const outDir = path.join(outputRoot, app, 'screenshots', theme);
      const outFile = path.join(outDir, `${scene.id}.png`);

      try {
        // Navigate
        await page.goto(`${baseURL}${scene.route}`, {
          waitUntil: 'networkidle',
          timeout: 20_000,
        });
        await page.waitForTimeout(SETTLE_DELAY);

        // Re-apply theme class after navigation (SPAs sometimes reset it)
        await page.evaluate((t) => {
          if (t === 'dark') {
            document.documentElement.classList.add('dark');
          } else {
            document.documentElement.classList.remove('dark');
          }
        }, theme);

        // Run custom setup if provided
        if (scene.setup) {
          await scene.setup(page);
        }

        if (screenshotAfter) {
          const meta = await snap(page, {
            file: outFile,
            label: scene.label,
            waitFor: scene.waitFor,
          });
          allMeta.push(meta);
          results.push({ scene, theme, success: true, meta });
        } else {
          results.push({ scene, theme, success: true });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[FAIL] ${app}/${scene.id} (${theme}): ${message}`);
        results.push({ scene, theme, success: false, error: message });
      }
    }

    await page.context().close();
  }

  // Write the screenshot list (never meta.json, which is extract.mjs's counts file, #400)
  const metaPath = path.join(outputRoot, app, APP_SCREENSHOTS_FILE);
  fs.mkdirSync(path.dirname(metaPath), { recursive: true });
  fs.writeFileSync(metaPath, JSON.stringify(allMeta, null, 2) + '\n');

  return results;
}

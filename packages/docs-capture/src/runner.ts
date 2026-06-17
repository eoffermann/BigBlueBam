/**
 * Capture runner — turns a validated recipe into a finished screenshot.
 *
 * Pipeline (per recipe): authenticate as the recipe identity (storageState
 * cached per identity across a run) → evaluate + seed content → navigate +
 * run interaction steps → apply determinism (frozen clock is on the context,
 * animations disabled here, masks applied at capture) → wait for a stable
 * render → capture (full page / element / clip) → write the image to the
 * shared tree + a manifest entry.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, chromium } from 'playwright';
import { disableAnimations, FROZEN_TIME_ISO, hideVolatileOverlays, newDeterministicContext, resolveMasks } from './determinism.js';
import type { ResolvedEnvironment } from './environment.js';
import { ManifestWriter, resolveGitSha } from './manifest.js';
import { type InteractionStep, type LoadedRecipe, type Recipe, VIEWPORTS } from './recipe.js';
import { ensureContent, type SeedContext } from './seeding.js';
import { toArray, verifyBeforeCapture } from './verify.js';

const SETTLE_MS = 1200;

export interface RunOptions {
  env: ResolvedEnvironment;
  /** Absolute path to the shared screenshots root (screenshots/). */
  outRoot: string;
  /** console-style logger. */
  log?: (msg: string) => void;
}

export interface RunResult {
  id: string;
  app: string;
  ok: boolean;
  file?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Auth (storageState cached per identity)
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Is a Playwright storageState's session likely still valid (has a session cookie)? */
function stateLooksUsable(state: { cookies?: { name: string }[] }): boolean {
  return Boolean(state.cookies?.some((c) => /session|sid|connect/i.test(c.name)));
}

async function authenticate(
  browser: Browser,
  env: ResolvedEnvironment,
  identity: string,
): Promise<Record<string, unknown>> {
  // Fast path: reuse the E2E suite's maintained storageState (no cred needed).
  // Only for local/raw — never trust a checked-in session against production.
  // SHOTS_FRESH_LOGIN=1 forces a UI login with the configured creds instead
  // (used to capture a curated demo org, e.g. the Gilligan workspace).
  if (env.name !== 'production' && process.env.SHOTS_FRESH_LOGIN !== '1') {
    const stateFile = path.join(REPO_ROOT, 'apps/e2e/.auth', `${identity}.json`);
    if (fs.existsSync(stateFile)) {
      try {
        const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        if (stateLooksUsable(state)) return state as Record<string, unknown>;
      } catch {
        /* fall through to UI login */
      }
    }
  }

  const creds = env.identities[identity];
  if (!creds) throw new Error(`unknown identity "${identity}" (configure it in screenshots.config.json)`);

  const context = await browser.newContext({ viewport: VIEWPORTS['desktop-1440'], ignoreHTTPSErrors: true });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  await page.goto(`${env.baseUrl}/b3/login`, { waitUntil: 'domcontentloaded', timeout: 25_000 });

  if (page.url().includes('/login')) {
    await page.fill('input[name=email]', creds.email);
    await page.fill('input[name=password]', creds.password);
    const resp = page.waitForResponse(
      (r) => r.url().includes('/b3/api/auth/login') && r.request().method() === 'POST',
      { timeout: 20_000 },
    );
    await page.click('button[type=submit]');
    await resp;
    await page.waitForFunction(() => !window.location.pathname.endsWith('/login'), undefined, { timeout: 15_000 });
  }
  const state = await context.storageState();
  await context.close();
  return state as unknown as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Interaction step executor
// ---------------------------------------------------------------------------

async function runStep(
  page: import('playwright').Page,
  step: InteractionStep,
  baseUrl: string,
): Promise<void> {
  // Skip a credentialed/optional leg when its required env var is unset.
  if (step.skipIfEnvUnset && !process.env[step.skipIfEnvUnset]) return;
  // ${ENV_VAR} interpolation so credentials are never hardcoded in recipes.
  const interp = (s: string | undefined): string =>
    (s ?? '').replace(/\$\{(\w+)\}/g, (_, k: string) => process.env[k] ?? '');

  const run = async () => {
    switch (step.action) {
      case 'navigate':
        await page.goto(`${baseUrl}${interp(step.url)}`, { waitUntil: 'domcontentloaded', timeout: 25_000 });
        break;
      case 'click':
        await page.locator(step.selector!).first().click({ timeout: 15_000 });
        break;
      case 'hover':
        await page.locator(step.selector!).first().hover({ timeout: 15_000 });
        break;
      case 'fill':
        await page.locator(step.selector!).first().fill(interp(step.value));
        break;
      case 'press':
        await page.locator(step.selector!).first().press(interp(step.value) || 'Enter');
        break;
      case 'select':
        await page.locator(step.selector!).first().selectOption(interp(step.value));
        break;
      case 'scrollTo':
        await page.locator(step.selector!).first().scrollIntoViewIfNeeded();
        break;
      case 'waitFor':
        await page.locator(step.selector!).first().waitFor({ state: 'visible', timeout: 30_000 });
        break;
      case 'waitForNetworkIdle':
        await page.waitForLoadState('networkidle', { timeout: 15_000 });
        break;
      case 'wait':
        await page.waitForTimeout(step.ms ?? 500);
        break;
    }
  };
  try {
    await run();
  } catch (err) {
    if (step.optional) return;
    throw new Error(`step ${step.action}${step.selector ? ` (${step.selector})` : ''}: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Theme (mirror of the existing helper, inlined to keep the runner standalone)
// ---------------------------------------------------------------------------

async function applyTheme(page: import('playwright').Page, theme: 'light' | 'dark'): Promise<void> {
  await page.evaluate((t) => {
    localStorage.setItem('bbam-theme', t);
    document.documentElement.classList.toggle('dark', t === 'dark');
  }, theme);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(400);
  await page.evaluate((t) => {
    document.documentElement.classList.toggle('dark', t === 'dark');
  }, theme);
}

// ---------------------------------------------------------------------------
// Capture one recipe
// ---------------------------------------------------------------------------

function outputFileFor(recipe: Recipe, outRoot: string): string {
  const rel = recipe.output ?? path.join(recipe.app, `${recipe.id}.png`);
  return path.join(outRoot, rel);
}

async function captureRecipe(
  browser: Browser,
  loaded: LoadedRecipe,
  opts: RunOptions,
  storageState: Record<string, unknown>,
  manifest: ManifestWriter,
  gitSha: string,
): Promise<RunResult> {
  const { recipe } = loaded;
  const { env, outRoot } = opts;
  const log = opts.log ?? (() => {});
  const viewport = VIEWPORTS[recipe.capture.viewport];

  const context = await newDeterministicContext(browser, {
    deviceScaleFactor: recipe.capture.deviceScaleFactor,
    storageState: undefined,
    viewport,
  });
  // Inject cached auth.
  await context.addCookies(((storageState.cookies as never[]) ?? []) as Parameters<typeof context.addCookies>[0]);

  const page = await context.newPage();
  page.setDefaultTimeout(20_000);

  try {
    // 3-4: content evaluation + seeding (before navigating to the final view).
    const seedCtx: SeedContext = {
      api: context.request,
      page,
      baseUrl: env.baseUrl,
      workspaceSlug: env.workspaceSlug,
      spec: recipe.content?.spec ?? {},
      identity: recipe.identity,
    };
    const seedResult = await ensureContent(recipe.content, seedCtx);
    if (seedResult.status !== 'no-content') log(`    content: ${seedResult.status}${seedResult.detail ? ` — ${seedResult.detail}` : ''}`);

    // 5: navigate + interact.
    await page.goto(`${env.baseUrl}${recipe.route}`, { waitUntil: 'domcontentloaded', timeout: 25_000 });
    await applyTheme(page, recipe.capture.theme);
    await disableAnimations(page);
    for (const step of recipe.interactions) {
      await runStep(page, step, env.baseUrl);
    }

    // 6-7: stabilize + capture.
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(SETTLE_MS);
    await disableAnimations(page); // re-assert after any interaction-driven DOM swaps
    await hideVolatileOverlays(page); // drop the floating Bureau presence widget etc.

    const file = outputFileFor(recipe, outRoot);

    // VERIFY we reached the intended view before snapping. A failure here means
    // the recipe must NOT produce a (misleading) image — fail loudly and delete
    // any stale asset from a prior run so it can't linger as a wrong capture.
    const verdict = await verifyBeforeCapture(page, toArray(recipe.expect), toArray(recipe.expectNot));
    if (!verdict.ok) {
      if (fs.existsSync(file)) fs.rmSync(file);
      throw new Error(`pre-capture verification failed — ${verdict.reason}`);
    }

    fs.mkdirSync(path.dirname(file), { recursive: true });
    const mask = resolveMasks(page, recipe.masks);
    const target = recipe.capture.target;

    let buffer: Buffer;
    if (target === 'fullPage') {
      buffer = await page.screenshot({ path: file, type: 'png', fullPage: true, mask, maskColor: '#E5E7EB', animations: 'disabled' });
    } else if (/^\d+,\d+,\d+,\d+$/.test(target)) {
      const [x = 0, y = 0, width = 0, height = 0] = target.split(',').map(Number);
      buffer = await page.screenshot({ path: file, type: 'png', clip: { x, y, width, height }, mask, maskColor: '#E5E7EB', animations: 'disabled' });
    } else {
      buffer = await page.locator(target).first().screenshot({ path: file, type: 'png', mask, maskColor: '#E5E7EB', animations: 'disabled' });
    }

    const sha256 = createHash('sha256').update(buffer).digest('hex');
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    manifest.add({
      id: recipe.id,
      app: recipe.app,
      file: path.relative(outRoot, file).split(path.sep).join('/'),
      demonstrates: recipe.demonstrates,
      environment: env.name,
      theme: recipe.capture.theme,
      viewport: recipe.capture.viewport,
      deviceScaleFactor: recipe.capture.deviceScaleFactor,
      width,
      height,
      sha256,
      frozenTime: FROZEN_TIME_ISO,
      gitSha,
      capturedAt: new Date().toISOString(),
      ...(recipe.doc ? { doc: recipe.doc } : {}),
    });
    log(`  [OK]   ${recipe.app}/${recipe.id}.png  (${width}x${height})`);
    return { id: recipe.id, app: recipe.app, ok: true, file };
  } catch (err) {
    log(`  [FAIL] ${recipe.app}/${recipe.id}  ${(err as Error).message}`);
    return { id: recipe.id, app: recipe.app, ok: false, error: (err as Error).message };
  } finally {
    await context.close();
  }
}

// ---------------------------------------------------------------------------
// Run a batch of recipes
// ---------------------------------------------------------------------------

export async function runRecipes(recipes: LoadedRecipe[], opts: RunOptions): Promise<RunResult[]> {
  const log = opts.log ?? (() => {});
  const gitSha = resolveGitSha();
  const manifest = new ManifestWriter(opts.outRoot);
  const results: RunResult[] = [];

  const browser = await chromium.launch({ headless: true });
  try {
    // Authenticate each distinct identity once; reuse the storageState.
    const identities = [...new Set(recipes.map((r) => r.recipe.identity))];
    const authByIdentity = new Map<string, Record<string, unknown>>();
    for (const id of identities) {
      log(`[auth] ${id}`);
      authByIdentity.set(id, await authenticate(browser, opts.env, id));
    }

    for (const loaded of recipes) {
      const state = authByIdentity.get(loaded.recipe.identity)!;
      let result = await captureRecipe(browser, loaded, opts, state, manifest, gitSha);
      if (!result.ok) {
        // One retry: most failures are transient load/timeout races under
        // fresh-login + back-to-back captures, not real recipe faults. A genuinely
        // broken recipe (missing data, bad selector) simply fails twice.
        log(`  [retry] ${loaded.recipe.app}/${loaded.recipe.id}`);
        result = await captureRecipe(browser, loaded, opts, state, manifest, gitSha);
      }
      results.push(result);
    }
  } finally {
    await browser.close();
  }

  manifest.flush();
  log(`[manifest] ${manifest.manifestPath}`);
  return results;
}

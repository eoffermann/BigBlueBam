/**
 * Capture the Burn screenshots against the GILLIGAN scenario (the hard CLAUDE.md
 * rule). The seeded flagship scenario is the "Castaway Rescue Platform SOW"
 * engagement (scoped to the Island Infrastructure project) with a confirmed,
 * priced "Rescue Beacon Buildout" deliverable ($5,000 envelope).
 *
 * Writes light + dark into BOTH the docs tree and the marketing-site tree:
 *   docs/apps/burn/screenshots/<theme>/<name>.png
 *   site/public/screenshots/burn/<theme>/<name>.png
 *
 * Light: portfolio-board, gate-console, unscoped-queue, engagement-detail,
 *        cost-rates, rules
 * Dark:  portfolio-board
 *
 * Run against a live local stack (nginx on :80) AFTER the Burn SPA is deployed:
 *   pnpm --filter @bigbluebam/e2e exec node ../../scripts/screenshots/capture-burn-marketing.mjs
 *
 * Creds default to the gilligan admin (skipper); override with
 * DOCS_CAPTURE_USER / DOCS_CAPTURE_PASSWORD. Emits flushed progress.
 */
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS_ROOT = resolve(__dirname, '../../docs/apps/burn/screenshots');
const SITE_ROOT = resolve(__dirname, '../../site/public/screenshots/burn');
const BASE = process.env.SHOTS_BASE_URL || 'http://localhost';
const EMAIL = process.env.DOCS_CAPTURE_USER || 'skipper@gilligantravel.example';
const PASSWORD = process.env.DOCS_CAPTURE_PASSWORD || 'Castaway2026!';
const ENGAGEMENT_ID = process.env.BURN_ENGAGEMENT_ID || 'b0b0b0b0-0000-4000-8000-000000000001';

const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

async function login(page) {
  await page.goto(`${BASE}/b3/login`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  if (page.url().includes('/login')) {
    await page.fill('input[name=email]', EMAIL);
    await page.fill('input[name=password]', PASSWORD);
    await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes('/b3/api/auth/login') && r.request().method() === 'POST',
        { timeout: 20_000 },
      ),
      page.click('button[type=submit]'),
    ]);
    await page.waitForFunction(() => !window.location.pathname.endsWith('/login'), undefined, {
      timeout: 20_000,
    });
  }
}

/** Screenshot to BOTH the docs and site trees under <theme>/<name>.png. */
function shot(page, theme, name) {
  const docsDir = resolve(DOCS_ROOT, theme);
  const siteDir = resolve(SITE_ROOT, theme);
  mkdirSync(docsDir, { recursive: true });
  mkdirSync(siteDir, { recursive: true });
  return page
    .screenshot({ path: resolve(docsDir, `${name}.png`), fullPage: false })
    .then(() => page.screenshot({ path: resolve(siteDir, `${name}.png`), fullPage: false }));
}

async function gotoAndHeading(page, path, heading) {
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.getByRole('heading', { name: heading }).first().waitFor({ timeout: 20_000 });
  await page.waitForTimeout(800);
}

async function captureTheme(browser, theme, only) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: theme,
  });
  await context.addInitScript((t) => localStorage.setItem('bbam-theme', t), theme);
  const page = await context.newPage();
  log(`[${theme}] logging in ...`);
  await login(page);

  // Portfolio Board (always).
  log(`[${theme}] portfolio-board ...`);
  await gotoAndHeading(page, '/burn/', 'Portfolio Board');
  await shot(page, theme, 'portfolio-board');

  if (!only || only === 'all') {
    log(`[${theme}] gate-console ...`);
    await gotoAndHeading(page, '/burn/gate', 'Gate Console');
    await shot(page, theme, 'gate-console');

    log(`[${theme}] unscoped-queue ...`);
    await gotoAndHeading(page, '/burn/unscoped', 'Unscoped Queue');
    await shot(page, theme, 'unscoped-queue');

    log(`[${theme}] engagement-detail ...`);
    await gotoAndHeading(page, `/burn/engagements/${ENGAGEMENT_ID}`, 'Castaway Rescue Platform SOW');
    await shot(page, theme, 'engagement-detail');

    log(`[${theme}] cost-rates ...`);
    await gotoAndHeading(page, '/burn/settings/cost-rates', 'Cost Rates');
    await shot(page, theme, 'cost-rates');

    log(`[${theme}] rules ...`);
    await gotoAndHeading(page, '/burn/settings/rules', 'Attribution Rules');
    await shot(page, theme, 'rules');
  }

  await context.close();
  log(`[${theme}] done.`);
}

async function main() {
  log(`launching chromium; base=${BASE} docs=${DOCS_ROOT} site=${SITE_ROOT}`);
  const browser = await chromium.launch();
  await captureTheme(browser, 'light', 'all');
  await captureTheme(browser, 'dark', 'board'); // dark: portfolio-board only
  await browser.close();
  log('all themes done.');
}

main().catch((err) => {
  console.error('capture failed:', err);
  process.exit(1);
});

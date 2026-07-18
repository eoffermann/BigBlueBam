/**
 * Reshoot the Basis screenshots against the GILLIGAN project (the hard CLAUDE.md
 * rule). Captures both LIGHT and DARK themes (dark proves the dropdown-readability
 * fix) and three screens per theme:
 *   site/public/screenshots/basis/<theme>/catalog.png
 *   site/public/screenshots/basis/<theme>/metric-detail.png
 *   site/public/screenshots/basis/<theme>/builder.png
 *
 * Run against a live local stack (nginx on :80) AFTER the Basis SPA is deployed:
 *   pnpm --filter @bigbluebam/e2e exec node ../../scripts/screenshots/capture-basis-marketing.mjs
 *
 * Creds default to the gilligan cast; override with DOCS_CAPTURE_USER /
 * DOCS_CAPTURE_PASSWORD. Emits flushed progress so a stall is obvious.
 */
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../../site/public/screenshots/basis');
const BASE = process.env.SHOTS_BASE_URL || 'http://localhost';
const EMAIL = process.env.DOCS_CAPTURE_USER || 'skipper@gilligantravel.example';
const PASSWORD = process.env.DOCS_CAPTURE_PASSWORD || 'E2eTestP@ss123!';

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

async function captureTheme(browser, theme) {
  const outDir = resolve(ROOT, theme);
  mkdirSync(outDir, { recursive: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: theme,
  });
  await context.addInitScript((t) => localStorage.setItem('bbam-theme', t), theme);
  const page = await context.newPage();
  log(`[${theme}] logging in ...`);
  await login(page);

  // Catalog
  log(`[${theme}] catalog ...`);
  await page.goto(`${BASE}/basis/`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.getByRole('heading', { name: 'Metric Catalog' }).waitFor({ timeout: 20_000 });
  await page.locator('[data-testid=metrics-table]').waitFor({ timeout: 20_000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: resolve(outDir, 'catalog.png'), fullPage: false });

  // Builder: select a real source so the measure/agg/time-column dropdowns
  // populate, then frame the builder panel (proves the field pickers + dark-mode
  // readability).
  log(`[${theme}] builder ...`);
  await page.getByTestId('field-source').selectOption('bam/tasks');
  await page.getByTestId('field-measure').selectOption('id');
  await page.getByTestId('field-agg').selectOption('count');
  await page.getByTestId('field-timecol').selectOption('created_at');
  await page.getByTestId('field-dimension').selectOption('priority');
  await page.getByTestId('field-name').fill('Rescue Sightings');
  await page.getByTestId('create-metric').scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  await page.screenshot({ path: resolve(outDir, 'builder.png'), fullPage: false });

  // Detail: a themed certified metric with version history + a live value.
  log(`[${theme}] detail ...`);
  await page.goto(`${BASE}/basis/`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.locator('[data-testid=metrics-table]').waitFor({ timeout: 20_000 });
  await page.locator('[data-testid=metric-row]').first().waitFor({ timeout: 20_000 });
  const preferred = page.locator('[data-testid=metric-row]', { hasText: 'Daily Coconut Count' });
  const target = (await preferred.count()) > 0 ? preferred.first() : page.locator('[data-testid=metric-row]').first();
  if ((await target.count()) > 0) {
    await target.click();
    await page.locator('[data-testid=metric-name]').waitFor({ timeout: 20_000 });
    // Wait for the value to resolve (not the loading dots).
    await page.locator('[data-testid=metric-value], [data-testid=value-error]').first().waitFor({ timeout: 20_000 }).catch(() => {});
    await page.waitForTimeout(600);
    await page.screenshot({ path: resolve(outDir, 'metric-detail.png'), fullPage: false });
  } else {
    log(`[${theme}] WARNING: no metric-row found; skipping detail (seed gilligan basis metrics first)`);
  }

  await context.close();
  log(`[${theme}] done.`);
}

async function main() {
  log(`launching chromium; base=${BASE} out=${ROOT}`);
  const browser = await chromium.launch();
  for (const theme of ['light', 'dark']) {
    await captureTheme(browser, theme);
  }
  await browser.close();
  log('all themes done.');
}

main().catch((err) => {
  console.error('capture failed:', err);
  process.exit(1);
});

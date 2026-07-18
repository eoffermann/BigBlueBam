/**
 * Reshoot the Basis marketing screenshots against the GILLIGAN project (the hard
 * CLAUDE.md rule) after the SPA adopted the shared suite shell. Writes the two
 * PNGs the marketing section imports:
 *   site/public/screenshots/basis/light/catalog.png
 *   site/public/screenshots/basis/light/metric-detail.png
 *
 * Run against a live local stack (nginx on :80) AFTER the frontend image that
 * bakes the new Basis SPA is deployed:
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
const OUT_DIR = resolve(__dirname, '../../site/public/screenshots/basis/light');
const BASE = process.env.SHOTS_BASE_URL || 'http://localhost';
const EMAIL = process.env.DOCS_CAPTURE_USER || 'skipper@gilligantravel.example';
const PASSWORD = process.env.DOCS_CAPTURE_PASSWORD || 'E2eTestP@ss123!';

const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  log(`launching chromium; base=${BASE} out=${OUT_DIR}`);
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  // Force the shared light theme regardless of OS setting.
  await context.addInitScript(() => localStorage.setItem('bbam-theme', 'light'));
  const page = await context.newPage();

  log('logging in as gilligan admin ...');
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
  log('authenticated.');

  // --- Catalog (shows the shared sidebar + top bar + metric table) ----------
  log('capturing catalog ...');
  await page.goto(`${BASE}/basis/`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.getByRole('heading', { name: 'Metric Catalog' }).waitFor({ timeout: 20_000 });
  await page.locator('[data-testid=metrics-table]').waitFor({ timeout: 20_000 });
  await page.waitForTimeout(900);
  await page.screenshot({ path: resolve(OUT_DIR, 'catalog.png'), fullPage: false });
  log('wrote catalog.png');

  // --- Metric detail (open the first catalog row) ---------------------------
  log('capturing metric detail ...');
  const firstRow = page.locator('[data-testid=metric-row]').first();
  if ((await firstRow.count()) > 0) {
    await firstRow.click();
    await page.locator('[data-testid=metric-name]').waitFor({ timeout: 20_000 });
    await page.waitForTimeout(700);
    await page.screenshot({ path: resolve(OUT_DIR, 'metric-detail.png'), fullPage: false });
    log('wrote metric-detail.png');
  } else {
    log('WARNING: no metric-row found; skipping metric-detail.png (seed gilligan basis metrics first)');
  }

  await browser.close();
  log('done.');
}

main().catch((err) => {
  console.error('capture failed:', err);
  process.exit(1);
});

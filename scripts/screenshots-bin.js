const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const IMAGES_DIR = path.resolve(__dirname, '..', 'images');
fs.mkdirSync(IMAGES_DIR, { recursive: true });

// Screenshots come from the GILLIGAN project ONLY (see CLAUDE.md). Login is the
// gilligan cast; the assets are the themed island records seeded by
// scripts/seed-gilligan/bin.mjs.
const SKIPPER_EMAIL = 'skipper@gilligantravel.example';
const SKIPPER_PASSWORD = process.env.GILLIGAN_PASSWORD || 'Castaway2026!';

const captured = [];
const skipped = [];

async function snap(page, filename, label) {
  try {
    await page.screenshot({ path: path.join(IMAGES_DIR, filename) });
    captured.push(filename);
    console.log('[OK]  ' + filename + '  ' + (label || ''));
  } catch (e) {
    skipped.push({ filename, reason: e.message });
    console.error('[SKIP] ' + filename + ' — ' + e.message);
  }
}

async function safe(label, fn) {
  try {
    await fn();
  } catch (e) {
    console.error('[WARN] step failed: ' + label + ' — ' + e.message);
  }
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(12000);

  // ===== LOGIN via Bam as the GILLIGAN cast (Bin shares the session cookie) =====
  await safe('login', async () => {
    await page.goto('http://localhost/b3/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);
    if (page.url().includes('/login') || (await page.locator('input[name=email]').count()) > 0) {
      console.log('[AUTH] Logging in via Bam as the Skipper...');
      await page.fill('input[name=email]', SKIPPER_EMAIL);
      await page.fill('input[name=password]', SKIPPER_PASSWORD);
      await page.click('button[type=submit]');
      await page.waitForTimeout(3000);
      console.log('[AUTH] Logged in, URL:', page.url());
    } else {
      console.log('[AUTH] Already logged in');
    }
  });

  async function openAssetByName(name) {
    await page.goto('http://localhost/bin/', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(1200);
    const row = page.locator('table tbody tr', { hasText: name }).first();
    await row.click();
    await page.waitForTimeout(1600);
  }

  // ===== BIN: Asset library =====
  await safe('bin asset library', async () => {
    await page.goto('http://localhost/bin/', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(1800);
    await snap(page, 'bin-asset-library.png', 'Bin asset library (Gilligan island records)');
  });

  // ===== BIN: Record grid (CSV) =====
  await safe('bin record grid', async () => {
    await openAssetByName('daily-coconut-count.csv');
    await snap(page, 'bin-data-grid.png', 'Bin structured-data grid — Daily Coconut Count');
  });

  // ===== BIN: Tree view (JSON) =====
  await safe('bin tree view', async () => {
    await openAssetByName('minnow-manifest.json');
    await snap(page, 'bin-data-tree.png', 'Bin structured-data tree — S.S. Minnow manifest');
  });

  await browser.close();

  // No flat copy into site/public: the site and manual read Bin screenshots from
  // site/public/screenshots/bin/<theme>/, synced from docs/apps/bin/screenshots
  // by scripts/docs/sync-site-screenshots.mjs (#380).

  console.log('\n=== SUMMARY ===');
  console.log(`Captured: ${captured.length}`);
  console.log(`Skipped:  ${skipped.length}`);
  for (const s of skipped) console.log(`  [SKIP] ${s.filename}: ${s.reason}`);
})();

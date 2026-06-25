const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const IMAGES_DIR = path.resolve(__dirname, '..', 'images');
const SITE_DIR = path.resolve(__dirname, '..', 'site', 'public', 'screenshots');
fs.mkdirSync(IMAGES_DIR, { recursive: true });
fs.mkdirSync(SITE_DIR, { recursive: true });

// Screenshots come from the GILLIGAN project ONLY (see CLAUDE.md).
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
  page.setDefaultTimeout(15000);

  await safe('login', async () => {
    await page.goto('http://localhost/b3/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);
    if (await page.locator('input[name=email]').count()) {
      console.log('[AUTH] Logging in via Bam as the Skipper...');
      await page.fill('input[name=email]', SKIPPER_EMAIL);
      await page.fill('input[name=password]', SKIPPER_PASSWORD);
      await page.click('button[type=submit]');
      await page.waitForTimeout(3000);
    }
  });

  // ===== BAY: Review library =====
  await safe('bay review library', async () => {
    await page.goto('http://localhost/bay/', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(1800);
    await snap(page, 'bay-review-library.png', 'Bay review library (Gilligan rescue creative)');
  });

  // ===== BAY: Review page (open the poster image — real preview + capture toolbar) =====
  await safe('bay review page', async () => {
    await page.goto('http://localhost/bay/', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(1200);
    const row = page.locator('table tbody tr', { hasText: 'rescue-beacon-promo' }).first();
    if (await row.count()) {
      await row.click();
    } else {
      await page.locator('table tbody tr').first().click();
    }
    await page.waitForTimeout(2200);
    await snap(page, 'bay-review-page.png', 'Bay review — image preview, capture toolbar, annotations, decisions');
  });

  // ===== BAY: Audio review (real WAV preview + timecode annotations) =====
  await safe('bay audio review page', async () => {
    await page.goto('http://localhost/bay/', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(1200);
    const row = page.locator('table tbody tr', { hasText: 'coconut-radio-jingle' }).first();
    if (await row.count()) {
      await row.click();
      await page.waitForTimeout(2000);
      await snap(page, 'bay-review-audio.png', 'Bay audio review (no crash, timecode annotations, names)');
    }
  });

  await browser.close();
  for (const f of captured) {
    fs.copyFileSync(path.join(IMAGES_DIR, f), path.join(SITE_DIR, f));
  }
  console.log('\n=== SUMMARY ===');
  console.log(`Captured: ${captured.length}`);
  console.log(`Skipped:  ${skipped.length}`);
  for (const s of skipped) console.log(`  [SKIP] ${s.filename}: ${s.reason}`);
})();

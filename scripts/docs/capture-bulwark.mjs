#!/usr/bin/env node
/**
 * Full Bulwark screenshot set (gilligan only).
 * Models scripts/docs/capture-braid.mjs (same login + theme handling) and emits the
 * full docs + marketing filename set:
 *   ledger.png, contract-detail.png (+ obligation-detail.png alias),
 *   radar.png, notice-queue.png (+ approval-queue.png alias),
 *   compliance.png, settings.png  (light for all)
 *   ledger.png, radar.png         (dark)
 * to BOTH docs/apps/bulwark/screenshots/{light,dark}/ and
 *          site/public/screenshots/bulwark/{light,dark}/
 *
 * Requires a running stack at http://localhost with the gilligan Bulwark scenario
 * seeded (the "Castaway Rescue Subcontract"). Auth uses the gilligan admin
 * (skipper@gilligantravel.example) via DOCS_CAPTURE_USER/PASSWORD env.
 */
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const BASE_URL = process.env.DOCS_CAPTURE_BASE_URL || 'http://localhost';
const VIEWPORT = { width: 1440, height: 900 };
const SETTLE = 1600;
// The seeded gilligan "Castaway Rescue Subcontract" (Island Infrastructure job).
const CONTRACT = process.env.BULWARK_CONTRACT_ID || 'a362cf57-8336-40d5-aa4a-cf4c3456e471';

const log = (...a) => console.log(`[bulwark-shots +${((Date.now() - START) / 1000).toFixed(1)}s]`, ...a);
const START = Date.now();

// name -> route. `aliases` writes the same PNG under extra filenames so the
// marketing site's existing src paths keep resolving.
// Which scenes get dark captures is controlled by DARK_SCENES below.
const SCENES = [
  { name: 'ledger', route: '/bulwark/', waitFor: 'main' },
  { name: 'contract-detail', route: `/bulwark/contracts/${CONTRACT}`, waitFor: 'main', aliases: ['obligation-detail'] },
  { name: 'radar', route: '/bulwark/radar', waitFor: 'main' },
  { name: 'notice-queue', route: '/bulwark/notices', waitFor: 'main', aliases: ['approval-queue'] },
  { name: 'compliance', route: '/bulwark/compliance', waitFor: 'main' },
  { name: 'settings', route: '/bulwark/settings', waitFor: 'main' },
];
const DARK_SCENES = new Set(['ledger', 'radar']);

const DEST_DOCS = (theme) => path.join(ROOT, 'docs', 'apps', 'bulwark', 'screenshots', theme);
const DEST_SITE = (theme) => path.join(ROOT, 'site', 'public', 'screenshots', 'bulwark', theme);

async function login(page) {
  const email = process.env.DOCS_CAPTURE_USER || 'skipper@gilligantravel.example';
  const password = process.env.DOCS_CAPTURE_PASSWORD || 'Castaway2026!';
  log('login: navigating to /b3/login');
  await page.goto(`${BASE_URL}/b3/login`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
  if (!page.url().includes('/login')) { log('already authenticated'); return; }
  await page.fill('input[name=email]', email);
  await page.fill('input[name=password]', password);
  const resp = page.waitForResponse(
    (r) => r.url().includes('/b3/api/auth/login') && r.request().method() === 'POST',
    { timeout: 15_000 },
  );
  await page.click('button[type=submit]');
  const r = await resp;
  log('login response', r.status());
  await page.waitForFunction(() => !window.location.pathname.endsWith('/login'), undefined, { timeout: 10_000 });
  await page.waitForTimeout(SETTLE);
}

async function applyTheme(page, theme) {
  if (!page.url().startsWith('http')) {
    await page.goto(`${BASE_URL}/bulwark/`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    await page.waitForTimeout(SETTLE);
  }
  await page.evaluate((t) => {
    localStorage.setItem('bbam-theme', t);
    document.documentElement.classList.toggle('dark', t === 'dark');
  }, theme);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(SETTLE);
  await page.evaluate((t) => document.documentElement.classList.toggle('dark', t === 'dark'), theme);
}

async function capture(page, scene, theme) {
  log(`capture ${theme}/${scene.name} -> ${scene.route}`);
  await page.goto(`${BASE_URL}${scene.route}`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
  await page.waitForTimeout(SETTLE);
  await page.evaluate((t) => document.documentElement.classList.toggle('dark', t === 'dark'), theme);
  // Drop the floating Bureau presence widget so it doesn't clutter the corner.
  await page.addStyleTag({
    content: '[data-bureau-docked-box],section[aria-label="Bureau"],[data-testid="bureau-presence-widget"]{display:none!important;visibility:hidden!important}',
  }).catch(() => {});
  if (scene.waitFor) {
    await page.locator(scene.waitFor).first().waitFor({ state: 'visible', timeout: 10_000 }).catch(() => log('  waitFor timed out (continuing)'));
  }
  await page.waitForTimeout(900);
  const buf = await page.screenshot({ type: 'png' });
  const names = [scene.name, ...(scene.aliases ?? [])];
  for (const dir of [DEST_DOCS(theme), DEST_SITE(theme)]) {
    fs.mkdirSync(dir, { recursive: true });
    for (const name of names) fs.writeFileSync(path.join(dir, `${name}.png`), buf);
  }
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  log(`  wrote ${names.map((n) => `${n}.png`).join(', ')} (${w}x${h}, ${(buf.length / 1024).toFixed(0)}KB) to docs + site`);
}

const browser = await chromium.launch({ headless: true });
let storageState;
{
  const ctx = await browser.newContext({ viewport: VIEWPORT, ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  page.setDefaultTimeout(15_000);
  await login(page);
  storageState = await ctx.storageState();
  await ctx.close();
}
try {
  for (const theme of ['light', 'dark']) {
    const scenes = SCENES.filter((s) => theme === 'light' || DARK_SCENES.has(s.name));
    const ctx = await browser.newContext({ viewport: VIEWPORT, ignoreHTTPSErrors: true, storageState });
    const page = await ctx.newPage();
    page.setDefaultTimeout(15_000);
    try {
      await applyTheme(page, theme);
      for (const s of scenes) await capture(page, s, theme);
    } finally {
      await ctx.close();
    }
  }
} finally {
  await browser.close();
}
log('done.');

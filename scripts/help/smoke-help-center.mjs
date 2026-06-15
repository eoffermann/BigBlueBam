#!/usr/bin/env node
/**
 * Live smoke for the suite Help Center (packages/ui/help-center.tsx).
 * Logs into Bam, opens the "(?)" Help Center, and proves: overlay opens,
 * TOC renders, search returns results, cross-references render, a TOC deep-link
 * scrolls to a real heading id, and the right-click resolver matches a live
 * index label. Writes a screenshot. Run against the local stack only.
 *
 *   node scripts/help/smoke-help-center.mjs
 */
import { chromium } from 'playwright';

const BASE = process.env.DOCS_CAPTURE_BASE_URL || 'http://localhost';
const EMAIL = process.env.DOCS_CAPTURE_USER || 'admin@example.com';
const PASSWORD = process.env.DOCS_CAPTURE_PASSWORD || 'BigBlueBam-2026-dev-pw';
const OUT = process.argv[2] || 'D:/Documents/GitHub/BigBlueBam/docs/.help-build/help-center-smoke.png';

const checks = [];
const ok = (name, cond, detail = '') => {
  checks.push({ name, pass: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

try {
  // ── Login ───────────────────────────────────────────────────────────────
  await page.goto(`${BASE}/b3/login`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  if (page.url().includes('/login')) {
    await page.fill('input[name=email]', EMAIL);
    await page.fill('input[name=password]', PASSWORD);
    const resp = page.waitForResponse(
      (r) => r.url().includes('/b3/api/auth/login') && r.request().method() === 'POST',
      { timeout: 20000 },
    );
    await page.click('button[type=submit]');
    await resp;
    await page.waitForFunction(() => !window.location.pathname.endsWith('/login'), undefined, { timeout: 20000 });
  }
  await page.goto(`${BASE}/b3/`, { waitUntil: 'domcontentloaded', timeout: 20000 });

  // ── (?) icon present ──────────────────────────────────────────────────────
  const helpBtn = page.locator('header button[aria-label="Help"]');
  await helpBtn.waitFor({ state: 'visible', timeout: 15000 });
  ok('Help "(?)" icon renders in the top bar', await helpBtn.count() === 1);
  ok('Help icon tooltip is "Help"', (await helpBtn.getAttribute('title')) === 'Help');

  // ── Opens the overlay ─────────────────────────────────────────────────────
  await helpBtn.click();
  const dialog = page.locator('[role=dialog][aria-label*="elp"]');
  await dialog.waitFor({ state: 'visible', timeout: 10000 });
  ok('Clicking "(?)" opens the Help Center overlay', await dialog.isVisible());

  // ── Content loaded (markdown rendered) ────────────────────────────────────
  await page.locator('.help-center-content h2, .help-center-content h3').first().waitFor({ timeout: 10000 });
  const headingCount = await page.locator('.help-center-content h2, .help-center-content h3').count();
  ok('Help content renders headings (help.md fetched + rendered)', headingCount > 3, `${headingCount} headings`);

  // ── TOC sidebar ───────────────────────────────────────────────────────────
  const tocBtns = page.locator('nav[aria-label="Help contents"] button');
  const tocCount = await tocBtns.count();
  ok('TOC sidebar lists sections', tocCount > 5, `${tocCount} TOC entries`);

  // ── Cross-references ──────────────────────────────────────────────────────
  const relatedHdr = page.getByText('Related apps', { exact: false });
  ok('Cross-references ("Related apps") render', (await relatedHdr.count()) >= 1);

  // ── Deep-link: click a TOC entry, the matching heading id must exist ──────
  // Pull the index to choose a real anchor deterministically.
  const idx = await page.evaluate(async () => {
    const r = await fetch('/docs/apps/bam/help-index.json');
    return r.json();
  });
  const target = idx.toc.find((t) => t.level === 2) || idx.toc[0];
  await tocBtns.filter({ hasText: target.title }).first().click();
  await page.waitForTimeout(400);
  const anchorExists = await page.locator(`.help-center-content #${cssEscape(target.anchor)}`).count();
  ok('TOC deep-link anchor resolves to a rendered heading id', anchorExists === 1, `#${target.anchor}`);

  // ── Search ────────────────────────────────────────────────────────────────
  const sample = (idx.toc[1]?.title || 'task').split(' ')[0];
  await page.locator('[role=dialog] input[type=search]').fill(sample);
  await page.waitForTimeout(300);
  const resultBtns = page.locator('nav[aria-label="Help contents"] button');
  ok('Search returns results', (await resultBtns.count()) >= 1, `query "${sample}"`);
  await page.locator('[role=dialog] input[type=search]').fill('');

  // ── Right-click resolver against the live index ───────────────────────────
  // Inject a button whose text is a real documented label, dispatch contextmenu,
  // assert the "Help: <label>" item appears (proves the resolver + labels map).
  const label = Object.keys(idx.labels)[0];
  const sawHelpItem = await page.evaluate(async (lbl) => {
    const btn = document.createElement('button');
    btn.textContent = lbl;
    btn.style.position = 'fixed';
    btn.style.top = '300px';
    btn.style.left = '300px';
    document.body.appendChild(btn);
    btn.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 305, clientY: 305 }));
    await new Promise((r) => setTimeout(r, 250));
    const hit = Array.from(document.querySelectorAll('[role=menuitem]')).some((el) =>
      (el.textContent || '').startsWith('Help:'),
    );
    btn.remove();
    return hit;
  }, label);
  ok('Right-click on a documented label shows "Help: <label>"', sawHelpItem, `label "${label}"`);

  // Re-open clean for the screenshot.
  await page.keyboard.press('Escape');
  await helpBtn.click();
  await dialog.waitFor({ state: 'visible', timeout: 5000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: OUT });
  console.log(`\nScreenshot: ${OUT}`);
} finally {
  await browser.close();
}

function cssEscape(s) {
  return s.replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c);
}

const failed = checks.filter((c) => !c.pass);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);

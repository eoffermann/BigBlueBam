/**
 * Pre-capture verification — the skill must prove it actually navigated to the
 * view it intends to shoot, never snap a misleading image (e.g. an "Invalid
 * email or password" login screen mislabeled as a ticket list).
 *
 * Two layers, both run immediately before `page.screenshot`:
 *  1. A built-in error-state guard (always on) that fails on common failure
 *     pages — invalid credentials, "page not found", error boundaries, etc.
 *  2. The recipe's own `expect` (selectors/text that MUST be visible) and
 *     `expectNot` (must be absent). A recipe that depends on auth / seeded data
 *     / interactions should always declare `expect` so a failure to reach the
 *     view fails the recipe loudly instead of producing a wrong asset.
 */

import type { Page } from 'playwright';

/** Sentences that should never appear in a good capture (case-insensitive). */
const ERROR_PHRASES = [
  'invalid email or password',
  'invalid credentials',
  'incorrect email or password',
  'incorrect password',
  'something went wrong',
  'an unexpected error',
  'unexpected error occurred',
  'this page could not be found',
  'page not found',
  'application error',
  'failed to load',
  'access denied',
  'you do not have permission',
];

export interface VerifyResult {
  ok: boolean;
  reason?: string;
}

export function toArray(v: string | string[] | undefined): string[] {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

export async function verifyBeforeCapture(
  page: Page,
  expect: string[],
  expectNot: string[],
): Promise<VerifyResult> {
  // 1. Built-in error-state guard.
  const bodyText = (await page.evaluate(() => document.body?.innerText ?? '').catch(() => '')).toLowerCase();
  for (const phrase of ERROR_PHRASES) {
    if (bodyText.includes(phrase)) {
      return { ok: false, reason: `error state on page (matched "${phrase}")` };
    }
  }

  // 2a. expect — each must be visible (short grace wait).
  for (const sel of expect) {
    const loc = page.locator(sel).first();
    const visible =
      (await loc.isVisible().catch(() => false)) ||
      (await loc
        .waitFor({ state: 'visible', timeout: 5000 })
        .then(() => true)
        .catch(() => false));
    if (!visible) return { ok: false, reason: `expected element not visible: ${sel}` };
  }

  // 2b. expectNot — each must be absent/hidden.
  for (const sel of expectNot) {
    const present = await page
      .locator(sel)
      .first()
      .isVisible()
      .catch(() => false);
    if (present) return { ok: false, reason: `unexpected element present: ${sel}` };
  }

  return { ok: true };
}

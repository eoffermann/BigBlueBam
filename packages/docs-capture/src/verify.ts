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

/**
 * Shipped captures must show only demo identities. These are the reserved
 * demo/test domains (RFC 2606 / 6761); any other email domain is treated as a
 * real person and fails the capture. Incident of record: on 2026-06-24 the
 * Brief and Banter captures shipped real names and addresses because the
 * workspace still had real members and nothing checked the image's content.
 */
const DEMO_EMAIL_DOMAIN = /(\.example|\.test|\.invalid|\.localhost|\.local|^example\.(com|org|net))$/i;
const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g;

export function isDemoEmail(email: string): boolean {
  const domain = email.split('@')[1] ?? '';
  return DEMO_EMAIL_DOMAIN.test(domain.toLowerCase());
}

/** Every email address in `text` whose domain is not a reserved demo domain. */
export function findRealEmails(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(EMAIL)) {
    if (!isDemoEmail(m[0])) found.add(m[0]);
  }
  return [...found];
}

/** First path segment, e.g. "/brief/documents/x" -> "brief". */
export function firstSegment(pathname: string): string {
  return pathname.split('/').filter(Boolean)[0] ?? '';
}

export interface VerifyOptions {
  /**
   * The app the recipe is for, as the first segment of its route (e.g. "brief").
   * When set, the page must still be inside that app at capture time. Catches
   * a click chain that silently lands in another app (the 2026-06-24 Brief
   * "editor" capture was actually the Bam People page).
   */
  appSegment?: string;
}

export function toArray(v: string | string[] | undefined): string[] {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

export async function verifyBeforeCapture(
  page: Page,
  expect: string[],
  expectNot: string[],
  opts: VerifyOptions = {},
): Promise<VerifyResult> {
  // 0. Still inside the recipe's own app.
  if (opts.appSegment) {
    const here = firstSegment(new URL(page.url()).pathname);
    if (here !== opts.appSegment) {
      return { ok: false, reason: `left the app: expected /${opts.appSegment}/, page is at ${new URL(page.url()).pathname}` };
    }
  }

  // 1. Built-in error-state guard.
  const rawText = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
  const bodyText = rawText.toLowerCase();
  for (const phrase of ERROR_PHRASES) {
    if (bodyText.includes(phrase)) {
      return { ok: false, reason: `error state on page (matched "${phrase}")` };
    }
  }

  // 1b. No real person's email address may appear in a shipped capture.
  const real = findRealEmails(rawText);
  if (real.length > 0) {
    return { ok: false, reason: `real email address on page (${real.length} found; only demo domains are allowed)` };
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

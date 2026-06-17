/**
 * Determinism controls so re-running a recipe yields a near-identical image
 * (the property that later lets these double as visual-regression coverage).
 *
 *  - Frozen clock: client-side `Date`/`performance.now` are pinned to a fixed
 *    instant via Playwright's clock API, so "today", "2h ago", countdowns, etc.
 *    render the same every run. Server-sent absolute timestamps that the client
 *    doesn't recompute are handled by `masks` instead.
 *  - No animation: the browser context uses `reducedMotion: 'reduce'` and we
 *    inject a stylesheet that zeroes transitions/animations/caret blink.
 *  - Masks: selectors listed on a recipe are passed to Playwright's screenshot
 *    `mask` option, which paints an opaque box over each — for any volatile UI
 *    seeding + the frozen clock don't already make stable (presence dots, live
 *    relative times, random avatars).
 */

import type { Browser, BrowserContext, Locator, Page } from 'playwright';

/**
 * The instant every capture pretends "now" is. Fixed + in the recent past so
 * relative times read naturally ("yesterday", "2 days ago"). Pass a different
 * value via `SHOTS_FROZEN_TIME` for a one-off run.
 */
export const FROZEN_TIME_ISO = process.env.SHOTS_FROZEN_TIME || '2026-06-15T16:20:00.000Z';

const NO_MOTION_CSS = `
  *, *::before, *::after {
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    animation-iteration-count: 1 !important;
    scroll-behavior: auto !important;
    caret-color: transparent !important;
  }
`;

/** Context options that should be set when the browser context is created. */
export function deterministicContextOptions(deviceScaleFactor = 1): {
  reducedMotion: 'reduce';
  deviceScaleFactor: number;
  ignoreHTTPSErrors: true;
} {
  return { reducedMotion: 'reduce', deviceScaleFactor, ignoreHTTPSErrors: true };
}

/**
 * Install the frozen clock on a context BEFORE any page navigates. Uses
 * `clock.install` + `setFixedTime` so every `Date`/`Date.now()` read returns
 * the frozen instant. Best-effort: older Playwright builds without `clock`
 * degrade gracefully (masks still cover volatile times).
 */
export async function installFrozenClock(context: BrowserContext): Promise<void> {
  const time = new Date(FROZEN_TIME_ISO);
  const clock = (context as unknown as { clock?: { install: (o: { time: Date }) => Promise<void>; setFixedTime: (t: Date) => Promise<void> } }).clock;
  if (!clock) return;
  try {
    await clock.install({ time });
    await clock.setFixedTime(time);
  } catch {
    /* clock API unavailable — masks remain the fallback for volatile times */
  }
}

/** Inject the no-animation stylesheet. Call after each navigation. */
export async function disableAnimations(page: Page): Promise<void> {
  await page.addStyleTag({ content: NO_MOTION_CSS }).catch(() => {});
}

/**
 * Hide cross-app volatile overlays that float over every Bam-suite page and
 * would otherwise pollute / destabilize captures — chiefly the Bureau presence
 * widget (live "who's here", connecting…, mic/cam controls), which mounts as a
 * fixed `<section data-bureau-docked-box>` from the embedded micro-frontend.
 * Best-effort CSS hide (no-op when nothing matches). Extra selectors come from
 * `SHOTS_HIDE_SELECTORS` (comma-separated).
 */
export async function hideVolatileOverlays(page: Page): Promise<void> {
  const extra = (process.env.SHOTS_HIDE_SELECTORS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const selectors = [
    '[data-bureau-docked-box]',
    'section[aria-label="Bureau"]',
    '[data-testid="bureau-presence-widget"]',
    ...extra,
  ];
  await page
    .addStyleTag({ content: `${selectors.join(',')} { display: none !important; visibility: hidden !important; }` })
    .catch(() => {});
}

// Masks paint an opaque box over an element. They're only warranted for
// genuinely NON-deterministic UI — live presence, typing, live-connection
// status, hover tooltips, and secrets. Timestamps/dates/rollup numbers are
// deterministic under the frozen clock, so masking them just redacts real data
// with an ugly box (the fuchsia/gray bars). Any declared mask that isn't on this
// allowlist is dropped, so recipes can keep their historical mask lists while
// captures show the real seeded data.
const LIVE_MASK_TOKENS = [
  'presence', // presence-indicator / presence-dot / presence-avatars
  'typing-indicator',
  'recharts-tooltip',
  'api-key-secret',
  'text-emerald-600', // live WS "Live" connection chip
  'text-amber-600', // live WS "connecting/reconnecting" chip
  'lucide-users', // live occupant count
];

/** Resolve a recipe's mask selectors to locators, keeping only genuinely-live ones. */
export function resolveMasks(page: Page, selectors: string[]): Locator[] {
  return selectors
    .filter((sel) => LIVE_MASK_TOKENS.some((tok) => sel.includes(tok)))
    .map((sel) => page.locator(sel));
}

/**
 * Create a fully deterministic context (frozen clock + reduced motion +
 * device scale), optionally seeded with a saved auth `storageState`.
 */
export async function newDeterministicContext(
  browser: Browser,
  opts: { deviceScaleFactor?: number; storageState?: string; viewport: { width: number; height: number } },
): Promise<BrowserContext> {
  const context = await browser.newContext({
    ...deterministicContextOptions(opts.deviceScaleFactor ?? 1),
    viewport: opts.viewport,
    ...(opts.storageState ? { storageState: opts.storageState } : {}),
  });
  await installFrozenClock(context);
  return context;
}

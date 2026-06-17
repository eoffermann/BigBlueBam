import {
  test,
  expect,
  request as playwrightRequest,
  type BrowserContextOptions,
} from '@playwright/test';
import { loginViaUI, loginViaAPI, readCsrfTokenFromCookies } from '../../../auth/auth.helper';
import { TEST_USERS } from '../../../auth/test-users';

/**
 * First-Time User Experience (FTUE).
 *
 * The b3 project's admin is marked `ftue_completed` in auth.setup.ts, so the
 * guided tour never hijacks the functional specs. Here we exercise the tour
 * itself against the otherwise-unused MEMBER account in its own browser context,
 * resetting the member's flag first so the test is idempotent and never races
 * the admin-based specs running in parallel.
 */

const EMPTY_STORAGE: BrowserContextOptions['storageState'] = { cookies: [], origins: [] };

/** Set (or clear) the member's account-level FTUE flag via a member-authed API
 *  context. `completed=false` clears `notification_prefs` so the tour fires. */
async function setMemberFtue(baseURL: string, completed: boolean): Promise<void> {
  const ctx = await playwrightRequest.newContext({ baseURL, ignoreHTTPSErrors: true });
  try {
    await loginViaAPI(ctx, baseURL, TEST_USERS.member);
    const storage = await ctx.storageState();
    const csrf = readCsrfTokenFromCookies(storage.cookies) ?? '';
    const res = await ctx.patch('/b3/api/auth/me', {
      headers: { 'X-CSRF-Token': csrf },
      data: { notification_prefs: completed ? { ftue_completed: true } : {} },
    });
    if (!res.ok()) {
      throw new Error(`reset member FTUE failed: ${res.status()} ${await res.text()}`);
    }
  } finally {
    await ctx.dispose();
  }
}

test.describe('FTUE', () => {
  test('a returning user is NOT sent to the tour', async ({ page }) => {
    // The b3 context is the admin, marked complete in setup.
    await page.goto('/b3/');
    await page.waitForLoadState('networkidle');
    await expect(page).not.toHaveURL(/\/b3\/settings/);
    await expect(page.getByText('Getting started', { exact: false })).toHaveCount(0);
  });

  test('a first-time user is walked through Settings, then pointed at the Launchpad', async ({
    browser,
    baseURL,
  }) => {
    // Un-onboard the member so the tour fires; isolated from admin-based specs.
    await setMemberFtue(baseURL!, false);

    const context = await browser.newContext({
      storageState: EMPTY_STORAGE,
      ignoreHTTPSErrors: true,
    });
    const page = await context.newPage();
    try {
      await loginViaUI(page, TEST_USERS.member);

      // First login → redirected to Settings with the guided tour open.
      await expect(page).toHaveURL(/\/b3\/settings/, { timeout: 15_000 });
      await expect(page.getByText('Set your display name')).toBeVisible();

      // Step through: profile (name → timezone) → appearance → notifications.
      await page.getByRole('button', { name: 'Next' }).click();
      await expect(page.getByText('Pick your timezone')).toBeVisible();
      await page.getByRole('button', { name: 'Next' }).click();
      await expect(page.getByText('Choose your appearance')).toBeVisible();
      await page.getByRole('button', { name: 'Next' }).click();
      await expect(page.getByText('Tune your notifications')).toBeVisible();
      await page.getByRole('button', { name: 'Next' }).click();

      // Final step points at the topbar Launchpad button (matched by its FTUE
      // anchor — there's also a "Launchpad" tab button in the Settings nav).
      await expect(page.getByText('Find your apps')).toBeVisible();
      await expect(page.locator('[data-ftue="launchpad"]')).toBeVisible();
      await page.getByRole('button', { name: 'Finish' }).click();

      // Tour dismissed and the flag persists — a reload doesn't re-trigger it.
      await expect(page.getByText('Set your display name')).toHaveCount(0);
      await page.reload();
      await page.waitForLoadState('networkidle');
      await expect(page.getByText('Getting started', { exact: false })).toHaveCount(0);
    } finally {
      // Leave the member marked complete regardless of outcome.
      await setMemberFtue(baseURL!, true).catch(() => {});
      await context.close();
    }
  });
});

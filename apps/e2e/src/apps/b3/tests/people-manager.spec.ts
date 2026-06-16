import { test, expect } from '@playwright/test';

/**
 * People Manager v2 (/b3/people-manager) — interaction tests.
 *
 * These exist because M2–M5 were shipped build-verified but not click-verified,
 * and the M5 bulk bar was dead-by-default: every membership verb stayed
 * `disabled` until the roster Org filter was pinned to a single org, so the bar
 * "appeared but did nothing". The fix resolves the bulk org context from the
 * filter, a single common org, or an in-bar pick. This spec drives the real UI.
 */
test.describe('People Manager v2', () => {
  test('roster renders and the detail page opens', async ({ page }) => {
    await page.goto('/b3/people-manager');
    await expect(page.getByRole('heading', { name: 'People Manager' })).toBeVisible();
    const view = page.getByRole('button', { name: 'View' }).first();
    await expect(view).toBeVisible({ timeout: 15_000 });
    // The only roster person here is the admin themselves; you cannot delete
    // your own account, so the red per-row "Delete account" must NOT appear on
    // the roster (caps.delete_account is false for self).
    await expect(page.getByRole('button', { name: 'Delete account' })).toHaveCount(0);
    await view.click();
    await expect(page).toHaveURL(/\/people-manager\/[0-9a-f-]{8}/);
    // Same gating on the detail Danger zone.
    await expect(page.getByRole('button', { name: 'Delete account' })).toHaveCount(0);
  });

  test('detail Overview timezone is a global dropdown, not a raw text field', async ({ page }) => {
    await page.goto('/b3/people-manager');
    const view = page.getByRole('button', { name: 'View' }).first();
    await expect(view).toBeVisible({ timeout: 15_000 });
    await view.click();
    await expect(page).toHaveURL(/\/people-manager\/[0-9a-f-]{8}/);
    // The timezone renders as an offset-prefixed label ("(UTC+00:00) UTC"),
    // which a raw text field showing "UTC" would never produce.
    await expect(page.getByText(/\(UTC\+00:00\)\s*UTC/).first()).toBeVisible();
    // It's a real dropdown: open it and the curated global cities appear,
    // spanning both hemispheres and east/west.
    const tz = page.getByRole('combobox').filter({ hasText: 'UTC' }).first();
    await tz.click();
    await expect(page.getByText('(UTC-08:00) Los Angeles')).toBeVisible();
    await expect(page.getByText('(UTC+10:00) Sydney')).toBeVisible();
  });

  test('detail Memberships tab can add to an organization', async ({ page }) => {
    await page.goto('/b3/people-manager');
    const view = page.getByRole('button', { name: 'View' }).first();
    await expect(view).toBeVisible({ timeout: 15_000 });
    await view.click();
    await expect(page).toHaveURL(/\/people-manager\/[0-9a-f-]{8}/);
    await page.getByRole('button', { name: 'Memberships' }).click();
    // The Add-to-organization affordance is present and opens its dialog.
    await page.getByRole('button', { name: 'Add to organization' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Add to organization')).toBeVisible();
  });

  test('bulk bar appears on select and membership verbs are USABLE (M5 dead-by-default fix)', async ({
    page,
  }) => {
    await page.goto('/b3/people-manager');
    const selectAll = page.getByRole('checkbox', { name: 'Select all' });
    await expect(selectAll).toBeVisible({ timeout: 15_000 });
    await selectAll.check();

    // The floating bulk bar appears.
    await expect(page.getByRole('button', { name: 'Clear selection' })).toBeVisible();

    // CORE REGRESSION: the membership verbs must be ENABLED once a selection's
    // org resolves (single-org admin → auto-resolved; the bug left these
    // permanently disabled because the Org filter defaults to "all").
    await expect(page.getByRole('button', { name: 'Disable' })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Enable' })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Remove from org' })).toBeEnabled();

    // The "Change role" verb opens its menu (not a dead control).
    await page.getByRole('button', { name: 'Change role' }).click();
    await expect(page.getByText('Viewer', { exact: true }).last()).toBeVisible();
  });

  test('legacy /superuser/people redirects to /people-manager', async ({ page }) => {
    await page.goto('/b3/superuser/people');
    // parseRoute renders People Manager for the retired path; the effect
    // canonicalizes the address bar to /people-manager.
    await expect(page.getByRole('heading', { name: 'People Manager' })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page).toHaveURL(/\/b3\/people-manager$/);
  });

  test('invite dialog opens and lists an org the admin administers', async ({ page }) => {
    await page.goto('/b3/people-manager');
    // NOTE: the Bureau docked-box also renders an "Invite…" button, so match the
    // People Manager header button exactly ("Invite", not "Invite…").
    await page.getByRole('button', { name: 'Invite', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Invite people')).toBeVisible();
    // The admin's own org appears as a selectable invite target (listMyAdminOrgs).
    await expect(dialog.getByText('E2E Test Organization')).toBeVisible();
  });
});

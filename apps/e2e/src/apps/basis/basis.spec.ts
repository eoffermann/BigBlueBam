import { test, expect } from '../../../fixtures/base.fixture';

// Basis user-story E2E: define a governed metric in the UI, see it in the
// catalog, then run the certification lifecycle. Uses the default authenticated
// context (.auth/admin.json). Self-cleaning: the metric is deprecated at the end
// so re-runs stay deterministic, and the slug is unique per run.
test.describe('Basis — governed metric layer', () => {
  test('define a metric, list it, certify then deprecate it', async ({ page }) => {
    const slug = `e2e_metric_${Date.now()}`;
    const name = `E2E Metric ${Date.now()}`;

    // 1. Land on the catalog.
    await page.goto('/basis/');
    await expect(page.getByRole('heading', { name: 'Metric Catalog' })).toBeVisible();

    // 2. Define a draft metric via the form.
    await page.getByTestId('field-slug').fill(slug);
    await page.getByTestId('field-name').fill(name);
    await page.getByTestId('field-source_product').fill('bill');
    await page.getByTestId('field-source_entity').fill('invoices');
    await page.getByTestId('field-field').fill('amount');
    await page.getByTestId('field-time_column').fill('created_at');
    await page.getByTestId('create-metric').click();

    // 3. Redirects to the detail page for the new draft.
    await expect(page.getByTestId('metric-name')).toHaveText(name);
    await expect(page.getByTestId('cert-badge')).toHaveText('draft');

    // 4. Certify it -> badge flips to certified.
    await page.getByTestId('certify').click();
    await expect(page.getByTestId('cert-badge')).toHaveText('certified');

    // 5. It appears in the catalog, filterable by certified.
    await page.goto('/basis/');
    await page.getByTestId('cert-filter').selectOption('certified');
    await expect(page.getByRole('cell', { name }).or(page.getByText(name))).toBeVisible();

    // 6. Clean up: open it and deprecate (self-cleaning).
    await page.getByText(name).click();
    await expect(page.getByTestId('metric-name')).toHaveText(name);
    await page.getByTestId('deprecate').click();
    await expect(page.getByTestId('cert-badge')).toHaveText('deprecated');
  });
});

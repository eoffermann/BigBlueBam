import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '../../../fixtures/base.fixture';

// Bastion M11 user story 16 (spec 11.4): Bastion appears on the Launchpad and opens /bastion/;
// the marketing /docs page lists the Bastion MCP tools.
//
// The tool count is not hard-coded: it comes from the committed, generated catalog
// (site/src/content/docs-catalog.generated.json, built by `pnpm docs:catalog` from
// apps/mcp-server/src/tools/bastion-tools.ts), the same file the /docs page renders from.
//
// Auth: the default authenticated context (.auth/admin.json) as Skipper. Read-only.
// The marketing site is not behind the app nginx; it serves itself on SITE_PORT (default 3000),
// so its URL is E2E_SITE_URL (default http://localhost:3000).
//
// Passes only once the api image carries the LAUNCHPAD_CATALOG row and the site image carries
// the regenerated catalog.

const SITE_URL = process.env.E2E_SITE_URL || 'http://localhost:3000';

interface CatalogEntry {
  id: string;
  name: string;
  icon_name: string;
  path: string;
}

function bastionToolCount(): number {
  const file = path.resolve(__dirname, '../../../../../../site/src/content/docs-catalog.generated.json');
  const products = JSON.parse(fs.readFileSync(file, 'utf8')) as Array<{ id: string; categories: Array<{ tools: unknown[] }> }>;
  const bastion = products.find((p) => p.id === 'bastion');
  if (!bastion) throw new Error('bastion is missing from docs-catalog.generated.json; run pnpm docs:catalog');
  return bastion.categories.reduce((n, c) => n + c.tools.length, 0);
}

test.describe('Bastion - Launchpad and docs (M11)', () => {
  test('16. Bastion appears on the Launchpad, opens /bastion/, and /docs lists its tools', async ({ page, request }) => {
    // Backend: the api serves the Launchpad row.
    const res = await request.get('/b3/api/launchpad/apps');
    expect(res.ok()).toBe(true);
    const body = (await res.json()) as { data: { catalog: string[]; catalog_detail: CatalogEntry[]; enabled: string[] } };
    expect(body.data.catalog).toContain('bastion');
    const row = body.data.catalog_detail.find((a) => a.id === 'bastion');
    expect(row).toMatchObject({ name: 'Bastion', icon_name: 'castle', path: '/bastion/' });

    // UI: open the Launchpad from Bam and follow the Bastion tile.
    await page.goto('/b3/');
    await page.locator('[data-ftue="launchpad"]').first().click();
    const tile = page.locator('a[href="/bastion/"]').filter({ hasText: 'Bastion' });
    await expect(tile).toBeVisible();
    await expect(tile).toContainText('Compliance Readiness');
    await tile.click();
    await expect(page).toHaveURL(/\/bastion\/$/);
    await expect(page.getByRole('heading', { name: 'Readiness', level: 1 })).toBeVisible();

    // And back: the Bastion Launchpad lists every app, Bastion marked as current.
    await page.locator('[data-ftue="launchpad"]').first().click();
    await expect(page.locator('a[href="/b3/"]').filter({ hasText: 'Bam' })).toBeVisible();
    await page.keyboard.press('Escape');

    // Marketing /docs: the MCP tool catalog lists Bastion with its generated count.
    const count = bastionToolCount();
    expect(count).toBeGreaterThan(0);
    await page.goto(`${SITE_URL}/docs`);
    await expect(page.getByRole('heading', { name: new RegExp(`^Bastion\\s*\\(${count} tools\\)$`) })).toBeVisible();
    await expect(page.locator('a[href="#bastion"]')).toContainText(String(count));
  });
});

import { expect, test } from '@playwright/test';

test('mobile layout: no page-level horizontal scroll, grid scrolls, transport works by tap', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('.step');
  const widths = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.client);

  const grid = page.locator('.grid-scroll');
  const gridWidths = await grid.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
  expect(gridWidths.scroll).toBeGreaterThan(gridWidths.client); // grid scrolls inside its panel

  // Track names stay visible (sticky) when the grid is scrolled.
  await grid.evaluate((el) => (el.scrollLeft = 300));
  await expect(page.locator('.grid-row[data-track="kick"] .track-name')).toBeInViewport();

  await page.locator('.grid-row[data-track="kick"] .step[data-step="2"]').tap();
  await expect(page.locator('.grid-row[data-track="kick"] .step[data-step="2"]')).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Play', exact: true }).tap();
  await expect(page.locator('.audio-pill')).toHaveText('Audio on');
  await page.getByRole('button', { name: 'Stop' }).tap();
});

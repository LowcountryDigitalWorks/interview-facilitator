import { test, expect, type Page } from '@playwright/test';

// All captured material is deliberately synthetic, public-safe and offline.
const output = 'artifacts/visual-review';
const viewports = [
  { name: 'mobile-390', width: 390, height: 820 },
  { name: 'desktop-1440', width: 1440, height: 900 },
] as const;
const appearances = ['dark', 'light'] as const;

async function capture(page: Page, name: string): Promise<void> {
  await page.screenshot({
    path: output + '/' + name + '.png',
    fullPage: true,
    animations: 'disabled',
    caret: 'hide',
  });
}

async function openPrivateReview(page: Page): Promise<void> {
  for (let step = 0; step < 40; step += 1) {
    const review = page.getByRole('button', { name: 'Review interview' });
    if (await review.isVisible()) {
      await review.click();
      await expect(page.getByRole('button', { name: 'Exit presentation' })).toBeVisible();
      await page.getByRole('button', { name: 'Exit presentation' }).click();
      return;
    }
    await page.getByRole('button', { name: 'Continue' }).click();
  }
  throw new Error('Synthetic interview did not reach Review.');
}

for (const viewport of viewports) {
  for (const appearance of appearances) {
    test('synthetic visual review ' + viewport.name + ' ' + appearance, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('/');
      if (appearance === 'light') {
        await page.getByRole('button', { name: 'Light' }).click();
      }
      await expect(page.locator('html')).toHaveAttribute('data-appearance', appearance);
      const prefix = appearance + '-' + viewport.name;
      await expect(page.getByText('Lowcountry Digital Works', { exact: true })).toBeVisible();
      await capture(page, prefix + '-home');

      await page.getByRole('button', { name: 'New interview' }).click();
      await page.getByLabel('Project or client label').fill('Synthetic Fieldnotes Demo');
      await page.getByRole('button', { name: 'Start interview' }).click();
      await expect(page.locator('#answer')).toBeVisible();
      await page.locator('#answer').fill('Fictional objective: simplify a sample website contact journey.');
      await expect(page.locator('html')).toHaveAttribute('data-appearance', appearance);
      await capture(page, prefix + '-interview');

      await openPrivateReview(page);
      await expect(page.locator('.app-header').getByText('Private review', { exact: true })).toBeVisible();
      const glance = page.locator('[data-private-outcome-glance]');
      if (await glance.count()) {
        await glance.locator('summary').click();
        await expect(glance).toHaveAttribute('open', '');
      }
      await expect(page.locator('html')).toHaveAttribute('data-appearance', appearance);
      await capture(page, prefix + '-private-review');
    });
  }
}


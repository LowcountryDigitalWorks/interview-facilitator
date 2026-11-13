import { expect, test } from '@playwright/test';

const APPEARANCE_KEY = 'ldw.interview-facilitator.appearance.v1';
const VIEWPORTS = [
  { width: 320, height: 720 },
  { width: 360, height: 740 },
  { width: 375, height: 812 },
  { width: 390, height: 820 },
  { width: 768, height: 1024 },
  { width: 1024, height: 800 },
  { width: 1440, height: 900 },
] as const;

async function clearLocalState(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/');
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase('ldw-interview-facilitator');
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    });
    try {
      localStorage.removeItem('ldw.interview-facilitator.appearance.v1');
    } catch {
      // ignore
    }
  });
}

test.beforeEach(async ({ page }) => {
  await clearLocalState(page);
});

test('clean install defaults to dark regardless of stored preference absence', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.getByRole('group', { name: 'Appearance' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Dark', pressed: true })).toBeVisible();
  const appearance = await page.evaluate(() => document.documentElement.dataset.appearance);
  expect(appearance).toBe('dark');
  const scheme = await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme);
  expect(scheme).toBe('dark');
  const bodyBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bodyBg).toMatch(/rgb\(17,\s*24,\s*32\)|#111820/i);
});

test('light toggle persists for next visit', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Light' }).click();
  await expect(page.getByRole('button', { name: 'Light', pressed: true })).toBeVisible();
  const stored = await page.evaluate((key) => localStorage.getItem(key), APPEARANCE_KEY);
  expect(stored).toBe('light');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Light', pressed: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.dataset.appearance)).toBe('light');
});

test('theme toggle during interview does not replace answer control or lose typed value', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.getByRole('button', { name: 'New interview' }).click();
  await page.getByLabel('Project or client label').fill('Synthetic Appearance');
  await page.getByRole('button', { name: 'Start interview' }).click();
  const answer = page.locator('#answer');
  await answer.fill('Synthetic partial theme toggle');
  const nodeBefore = await answer.evaluate((el) => el);
  await page.getByRole('button', { name: 'Light' }).click();
  const sameNode = await page.evaluate(() => {
    const el = document.querySelector('#answer');
    return { present: Boolean(el), value: (el as HTMLInputElement | HTMLTextAreaElement | null)?.value ?? '' };
  });
  expect(sameNode.value).toBe('Synthetic partial theme toggle');
  const nodeAfter = await answer.evaluate((el) => el);
  expect(nodeAfter).toBe(nodeBefore);
  await page.getByRole('button', { name: 'Dark' }).click();
  await expect(answer).toHaveValue('Synthetic partial theme toggle');
});

async function openSyntheticReview(page: import('@playwright/test').Page): Promise<void> {
  for (let step = 0; step < 40; step += 1) {
    const review = page.getByRole('button', { name: 'Review interview' });
    if (await review.isVisible()) {
      await review.click();
      await expect(page.getByRole('heading', { name: /Read back what matters/ })).toBeVisible();
      return;
    }
    await page.getByRole('button', { name: 'Continue' }).click();
  }
  throw new Error('Review interview control did not appear.');
}

test('presentation keeps private evidence lens hidden but allows appearance toggle', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 820 });
  await page.goto('/');
  await page.getByRole('button', { name: 'New interview' }).click();
  await page.getByLabel('Project or client label').fill('Synthetic Appearance Privacy');
  await page.getByRole('button', { name: 'Start interview' }).click();
  await page.locator('#answer').fill('Private detail');
  await openSyntheticReview(page);
  // Completing the pack opens read-back in Presentation by design (see main.ts review navigation).
  await expect(page.getByRole('button', { name: 'Exit presentation' })).toBeVisible();
  await expect(page.locator('[data-evidence-lens]')).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Appearance' })).toBeVisible();
  await page.getByRole('button', { name: 'Light' }).click();
  await expect(page.locator('[data-evidence-lens]')).toHaveCount(0);
});

test('localStorage write failure keeps in-memory light until reload', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function patchedSetItem(key: string, value: string) {
      if (key === 'ldw.interview-facilitator.appearance.v1') {
        throw new DOMException('quota', 'QuotaExceededError');
      }
      return original.call(this, key, value);
    };
  });
  await page.getByRole('button', { name: 'Light' }).click();
  await expect(page.getByRole('button', { name: 'Light', pressed: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.dataset.appearance)).toBe('light');
});

for (const viewport of VIEWPORTS) {
  test(`layout ${viewport.width}px: no horizontal overflow and 44px primary targets`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/');
    const metrics = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
    const newInterview = page.getByRole('button', { name: 'New interview' });
    const box = await newInterview.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    await expect(page.getByRole('group', { name: 'Appearance' })).toBeVisible();
  });
}

test('forced-colors and reduced-transparency media queries are defined', async ({ page }) => {
  await page.goto('/');
  const hasForcedColorsRule = await page.evaluate(() => {
    return [...document.styleSheets].some((sheet) => {
      try {
        return [...sheet.cssRules].some((rule) => rule.cssText.includes('forced-colors'));
      } catch {
        return false;
      }
    });
  });
  expect(hasForcedColorsRule).toBe(true);
});

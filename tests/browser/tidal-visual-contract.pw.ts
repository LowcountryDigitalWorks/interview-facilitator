import { expect, test } from '@playwright/test';

/**
 * GM08 synthetic geometry/a11y floor for Tidal coastal chrome.
 * Not physical iOS/VoiceOver certification; uses live app shell + empty DB only.
 */

const VIEWPORT_WIDTHS = [320, 360, 375, 390, 768, 1440] as const;

const DB_NAME = 'ldw-interview-facilitator';

async function clearLocalState(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/');
  await page.evaluate(async ({ dbName }) => {
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase(dbName);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    });
  }, { dbName: DB_NAME });
}

test.beforeEach(async ({ page }) => {
  await clearLocalState(page);
});

for (const width of VIEWPORT_WIDTHS) {
  test(`Tidal chrome geometry at ${width}px — no overlap, opaque hero, 44px targets`, async ({ page }) => {
    await page.setViewportSize({ width, height: 820 });
    await page.goto('/');
    await expect(page.locator('.app-header')).toBeVisible();
    await expect(page.getByRole('button', { name: 'New interview' })).toBeVisible();

    const layout = await page.evaluate(() => {
      const doc = document.documentElement;
      const header = document.querySelector('.app-header');
      const hero = document.querySelector('.hero-card');
      const newBtn = Array.from(document.querySelectorAll('button')).find(
        (b) => b.textContent?.trim() === 'New interview',
      );
      const primaryButtons = Array.from(document.querySelectorAll('.primary, .secondary, .icon-button, .text-button'));
      const sizes = primaryButtons.map((el) => {
        const r = el.getBoundingClientRect();
        return { w: r.width, h: r.height };
      });
      const headerStyle = header ? getComputedStyle(header) : null;
      const heroStyle = hero ? getComputedStyle(hero) : null;
      return {
        clientWidth: doc.clientWidth,
        scrollWidth: doc.scrollWidth,
        headerMinHeight: header ? header.getBoundingClientRect().height : 0,
        heroBackground: heroStyle?.backgroundColor ?? '',
        heroOpacity: heroStyle?.opacity ?? '1',
        headerHasBackdrop: headerStyle ? headerStyle.backdropFilter !== 'none' : false,
        newInterviewHeight: newBtn ? newBtn.getBoundingClientRect().height : 0,
        undersizedTargets: sizes.filter((s) => s.h > 0 && s.h < 44).length,
      };
    });

    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth + 1);
    expect(layout.headerMinHeight).toBeGreaterThanOrEqual(44);
    expect(layout.newInterviewHeight).toBeGreaterThanOrEqual(44);
    expect(layout.undersizedTargets).toBe(0);
    expect(layout.heroOpacity).toBe('1');
  });
}

test('Interview flow: action dock and header coexist without horizontal scroll at 375px', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 720 });
  await page.goto('/');
  await page.getByRole('button', { name: 'New interview' }).click();
  await page.getByLabel('Project or client label').fill('Synthetic Tidal Geometry');
  await page.getByRole('button', { name: 'Start interview' }).click();
  await expect(page.locator('.action-dock')).toBeVisible();

  const layout = await page.evaluate(() => {
    const dock = document.querySelector('.action-dock');
    const header = document.querySelector('.app-header');
    const doc = document.documentElement;
    const dockRect = dock?.getBoundingClientRect();
    const headerRect = header?.getBoundingClientRect();
    return {
      scrollWidth: doc.scrollWidth,
      clientWidth: doc.clientWidth,
      dockHeight: dockRect?.height ?? 0,
      headerBottom: headerRect?.bottom ?? 0,
      dockTop: dockRect?.top ?? 0,
    };
  });

  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth + 1);
  expect(layout.dockHeight).toBeGreaterThanOrEqual(44);
  expect(layout.dockTop).toBeGreaterThan(layout.headerBottom - 2);
});

test('forced-colors: chrome uses system Canvas (high-contrast fallback)', async ({ page }) => {
  await page.emulateMedia({ forcedColors: 'active' });
  await page.setViewportSize({ width: 390, height: 720 });
  await page.goto('/');
  const chrome = await page.evaluate(() => {
    const header = document.querySelector('.app-header');
    if (!header) return null;
    const headerCs = getComputedStyle(header);
    return {
      headerBg: headerCs.backgroundColor,
      headerColor: headerCs.color,
      headerBackdrop: headerCs.backdropFilter,
    };
  });
  expect(chrome).not.toBeNull();
  expect(chrome!.headerBackdrop).toBe('none');
  expect(chrome!.headerBg).toMatch(/^rgb\(\d+, \d+, \d+\)$/);
  expect(chrome!.headerColor).toMatch(/^rgb\(\d+, \d+, \d+\)$/);
});

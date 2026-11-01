import { expect, test } from '@playwright/test';
import { expectNoSeriousOrCriticalAxeViolations } from './helpers/axe';
import {
  appendIndexedDbRows,
  buildMalformedSessionRow,
  buildSyntheticSession,
  clearLocalAppStorage,
  readIndexedDbRowCount,
  resetAndSeedIndexedDb,
  SHELL_CACHE_NAME,
  waitForOfflineShellReady,
} from './helpers/storage';

test.describe('TEST-ACCEPT-001 phase A', () => {
  test.beforeEach(async ({ context }) => {
    await context.clearPermissions();
  });

  test('A — home empty store shows empty state with New and Import enabled', async ({ page }) => {
    await clearLocalAppStorage(page);
    await expect(page.getByText('No saved interviews yet.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'New interview' })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Import session JSON' })).toBeEnabled();
    await expect(page.getByText('Storage unavailable')).toHaveCount(0);
  });

  test('B — quarantined malformed IndexedDB row keeps healthy sessions listable', async ({ page }) => {
    const healthy = buildSyntheticSession('Acceptance Healthy Client');
    healthy.sessionId = 'acceptance-healthy-session-id';
    await resetAndSeedIndexedDb(page, [healthy]);
    await appendIndexedDbRows(page, [buildMalformedSessionRow()]);
    await page.reload();
    await expect.poll(() => readIndexedDbRowCount(page)).toBe(2);
    await page.getByRole('button', { name: 'New interview' }).click();
    await page.getByRole('button', { name: '← Back' }).click();
    await expect(page.getByText('1 local interview could not be read.')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('It was not deleted.')).toBeVisible();
    await expect(page.locator('[data-session-id="acceptance-healthy-session-id"]')).toBeVisible();
    await expect(page.getByRole('button', { name: 'New interview' })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Import session JSON' })).toBeEnabled();
    await expect(page.getByText('Storage unavailable')).toHaveCount(0);
    await expect(page.getByText('No saved interviews yet.')).toHaveCount(0);
  });

  test('C — primary answer field keeps focus and caret after autosave', async ({ page }) => {
    const session = buildSyntheticSession('Focus Caret Client');
    session.sessionId = 'acceptance-focus-caret-session';
    await resetAndSeedIndexedDb(page, [session]);

    await page.locator('[data-session-id="acceptance-focus-caret-session"]').click();
    const answer = page.locator('#answer');
    await answer.fill('0123456789');
    await answer.focus();
    await answer.evaluate((element) => {
      const field = element as HTMLTextAreaElement;
      field.setSelectionRange(2, 5);
    });
    await page.keyboard.press('a');
    const caretAfterEdit = await answer.evaluate((element) => {
      const field = element as HTMLTextAreaElement;
      return {
        active: document.activeElement === field,
        start: field.selectionStart,
        end: field.selectionEnd,
      };
    });
    await expect(page.locator('[data-save-indicator]').first()).toHaveText(/Saved/, { timeout: 5_000 });

    await expect.poll(async () =>
      answer.evaluate((element) => {
        const field = element as HTMLTextAreaElement;
        return {
          active: document.activeElement === field,
          start: field.selectionStart,
          end: field.selectionEnd,
        };
      }),
    ).toEqual(caretAfterEdit);
  });

  test('D — offline reload still renders production app shell', async ({ page, context }) => {
    await page.goto('/');
    await waitForOfflineShellReady(page);
    await expect(page.getByText('Interview Facilitator')).toBeVisible();
    await expect(page.getByText('No saved interviews yet.')).toBeVisible();

    await context.setOffline(true);
    await page.evaluate(() => window.location.reload());
    await page.waitForLoadState('domcontentloaded');
    await expect(page.getByText('Interview Facilitator')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#main')).toBeVisible();
    await expect(page.getByText('No saved interviews yet.')).toBeVisible();
  });

  test('E — unknown same-origin path is not added to shell cache', async ({ page }) => {
    await clearLocalAppStorage(page);
    await waitForOfflineShellReady(page);
    const unknownPath = '/acceptance-unknown-route-guard';

    await page.evaluate(async (path) => {
      try {
        await fetch(path, { cache: 'no-cache' });
      } catch {
        // Network failure is acceptable; cache guard is the invariant under test.
      }
    }, unknownPath);

    const cached = await page.evaluate(
      async ({ cacheName, path }) => {
        const cache = await caches.open(cacheName);
        const match = await cache.match(path);
        return match !== undefined;
      },
      { cacheName: SHELL_CACHE_NAME, path: unknownPath },
    );

    expect(cached).toBe(false);
  });

  test('F — axe baseline on home and populated interview', async ({ page }) => {
    await clearLocalAppStorage(page);
    await expect(page.getByText('No saved interviews yet.')).toBeVisible();
    await expectNoSeriousOrCriticalAxeViolations(page);

    const session = buildSyntheticSession('Axe Populated Client');
    session.sessionId = 'acceptance-axe-populated-session';
    await resetAndSeedIndexedDb(page, [session]);
    await page.locator('[data-session-id="acceptance-axe-populated-session"]').click();
    await expect(page.locator('#answer')).toBeVisible();
    await expectNoSeriousOrCriticalAxeViolations(page);
  });
});

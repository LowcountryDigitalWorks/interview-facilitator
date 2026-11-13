import { expect, test, type Page } from '@playwright/test';

// Browser-engine coverage only. WebKit on a Linux runner is NOT iOS Safari,
// VoiceOver, or an offline/disaster-recovery certification.
async function hasSyntheticPersistedAnswer(page: Page, label: string, answer: string): Promise<boolean> {
  return page.evaluate(async ({ label, answer }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('ldw-interview-facilitator');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      if (!db.objectStoreNames.contains('sessions')) return false;
      const records = await new Promise<unknown[]>((resolve, reject) => {
        const tx = db.transaction('sessions', 'readonly');
        const request = tx.objectStore('sessions').getAll();
        request.onsuccess = () => resolve(request.result as unknown[]);
        request.onerror = () => reject(request.error);
        tx.onabort = () => reject(tx.error);
      });
      return records.some((raw) => {
        if (typeof raw !== 'object' || raw === null) return false;
        const row = raw as { clientLabel?: string; answers?: Record<string, { value?: unknown }> };
        return row.clientLabel === label && row.answers?.['existing-presence']?.value === answer;
      });
    } finally {
      db.close();
    }
  }, { label, answer });
}

test('WebKit synthetic: Fieldnotes appearance, keyboard note, and local persistence at 390', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 820 });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-appearance', 'dark');
  await expect(page.getByText('Lowcountry Digital Works', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Light' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-appearance', 'light');

  const label = 'Synthetic WebKit Fieldnotes Local';
  const answer = 'Fictional website discovery objective for WebKit smoke.';
  await page.getByRole('button', { name: 'New interview' }).click();
  await page.getByLabel('Project or client label').fill(label);
  await page.getByRole('button', { name: 'Start interview' }).click();
  const input = page.locator('#answer');
  await input.fill(answer);
  await expect(input).toHaveValue(answer);

  // Follow the actual keyboard path; programmatic .focus() alone cannot
  // establish a usable Tab order or browser-driven scroll into view.
  const privateNote = page.locator('#question-note');
  await input.focus();
  await expect(input).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(privateNote).toBeFocused();
  // The focused note and sticky dock must both fit within the visual viewport
  // and the note must not sit behind the dock. A missing dock is a failure.
  let lastKeyboardGeometry: unknown;
  try {
    await expect.poll(async () => page.evaluate(() => {
    const field = document.querySelector('#question-note')?.getBoundingClientRect();
    const dock = document.querySelector('.action-dock')?.getBoundingClientRect();
    const width = document.documentElement.clientWidth;
    const height = document.documentElement.clientHeight;
    const tolerance = 2;
    return {
      fieldWithinViewport: Boolean(field
        && field.left >= -tolerance && field.right <= width + tolerance
        && field.top >= -tolerance && field.bottom <= height + tolerance),
      dockWithinViewport: Boolean(dock
        && dock.left >= -tolerance && dock.right <= width + tolerance
        && dock.top >= -tolerance && dock.bottom <= height + tolerance),
      noOverlap: Boolean(field && dock && field.bottom <= dock.top + tolerance),
      geometry: {
        viewport: [width, height],
        field: field && [field.left, field.top, field.right, field.bottom].map(Math.round),
        dock: dock && [dock.left, dock.top, dock.right, dock.bottom].map(Math.round),
      },
    };
    }).then((measurement) => {
      lastKeyboardGeometry = measurement;
      return measurement;
    })).toMatchObject({
      fieldWithinViewport: true,
      dockWithinViewport: true,
      noOverlap: true,
    });
  } catch (error) {
    console.error('WebKit keyboard focus viewport geometry: ' + JSON.stringify(lastKeyboardGeometry));
    throw error;
  }

  // A visible "Saved" label alone is not an autosave-idle proof: read the
  // actual existing IndexedDB session row and require the captured value.
  await expect.poll(async () => hasSyntheticPersistedAnswer(page, label, answer)).toBe(true);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-appearance', 'light');
  await expect.poll(async () => hasSyntheticPersistedAnswer(page, label, answer)).toBe(true);
});

test('WebKit synthetic: private outcome glance absent in Presentation, present in private Review', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.getByRole('button', { name: 'New interview' }).click();
  await page.getByLabel('Project or client label').fill('Synthetic WebKit Private Boundary');
  await page.getByRole('button', { name: 'Start interview' }).click();
  await page.locator('#answer').fill('Fictional discovery priority.');

  let foundReview = false;
  for (let index = 0; index < 40; index += 1) {
    const review = page.getByRole('button', { name: 'Review interview' });
    if (await review.isVisible()) {
      await review.click();
      foundReview = true;
      break;
    }
    await page.getByRole('button', { name: 'Continue' }).click();
  }
  expect(foundReview).toBe(true);
  await expect(page.getByRole('button', { name: 'Exit presentation' })).toBeVisible();
  await expect(page.locator('[data-private-outcome-glance]')).toHaveCount(0);

  await page.getByRole('button', { name: 'Exit presentation' }).click();
  const glance = page.locator('[data-private-outcome-glance]');
  await expect(glance).toHaveCount(1);
  await glance.locator('summary').click();
  await expect(glance).toHaveAttribute('open', '');
  await expect(glance.getByText('Private interviewer glance only')).toBeVisible();

  await page.getByRole('button', { name: 'Presentation view', exact: true }).click();
  await expect(page.locator('[data-private-outcome-glance]')).toHaveCount(0);
});

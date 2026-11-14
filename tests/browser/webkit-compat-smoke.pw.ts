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

test('WebKit synthetic: compact 320px dark mode supports forward and reverse keyboard navigation', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-appearance', 'dark');

  await page.getByRole('button', { name: 'New interview' }).click();
  await page.getByLabel('Project or client label').fill('Synthetic Compact Keyboard');
  await page.getByRole('button', { name: 'Start interview' }).click();

  const answer = page.locator('#answer');
  const note = page.locator('#question-note');
  await answer.fill('Fictional small-screen interview answer');
  await answer.focus();
  await expect(answer).toBeFocused();

  await page.keyboard.press('Tab');
  await expect(note).toBeFocused();
  // Fail if WebKit scrolls the active control above the viewport, behind the
  // dock, or off the narrow screen. A missing note or dock cannot pass.
  await expect.poll(async () => page.evaluate(() => {
    const field = document.querySelector('#question-note')?.getBoundingClientRect();
    const dock = document.querySelector('.action-dock')?.getBoundingClientRect();
    const root = document.documentElement;
    const width = root.clientWidth;
    const height = root.clientHeight;
    const tolerance = 2;
    return {
      fieldVisible: Boolean(field && field.top >= -tolerance
        && field.bottom <= height + tolerance
        && field.left >= -tolerance && field.right <= width + tolerance),
      dockVisible: Boolean(dock && dock.top >= -tolerance
        && dock.bottom <= height + tolerance
        && dock.left >= -tolerance && dock.right <= width + tolerance),
      notCovered: Boolean(field && dock && field.bottom <= dock.top + tolerance),
      noHorizontalOverflow: root.scrollWidth <= width + tolerance,
    };
  })).toEqual({
    fieldVisible: true,
    dockVisible: true,
    notCovered: true,
    noHorizontalOverflow: true,
  });

  await page.keyboard.press('Shift+Tab');
  await expect(answer).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(note).toBeFocused();
});

test('WebKit synthetic: manual JSON transfer restores a local interview in a separate browser profile', async ({ page, browser }) => {
  // Separate Playwright browser contexts have distinct IndexedDB stores. This
  // exercises the real shipped 1.3 export and import controls, not a secret
  // test-only restore hook, provider, remote sync, or revision-history archive.
  await page.setViewportSize({ width: 390, height: 820 });
  await page.goto('/');
  const label = 'Synthetic WebKit Manual Transfer';
  const answer = 'Fictional cross-profile transfer answer.';
  const privateNote = 'SYNTHETIC PRIVATE NOTE FOR OFFLINE OPERATOR ONLY';
  await page.getByRole('button', { name: 'New interview' }).click();
  await page.getByLabel('Project or client label').fill(label);
  await page.getByRole('button', { name: 'Start interview' }).click();
  await page.locator('#answer').fill(answer);
  await page.locator('#question-note').fill(privateNote);
  await expect.poll(async () => hasSyntheticPersistedAnswer(page, label, answer)).toBe(true);

  let reachedReview = false;
  for (let step = 0; step < 40; step += 1) {
    const review = page.getByRole('button', { name: 'Review interview' });
    if (await review.isVisible()) {
      await review.click();
      reachedReview = true;
      break;
    }
    await page.getByRole('button', { name: 'Continue' }).click();
  }
  expect(reachedReview).toBe(true);
  await expect(page.getByRole('button', { name: 'Exit presentation' })).toBeVisible();
  // The default Presentation intentionally hides private backup/export controls.
  await expect(page.getByRole('button', { name: 'Export full JSON backup' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Exit presentation' }).click();

  const pendingDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export full JSON backup' }).click();
  const download = await pendingDownload;
  expect(download.suggestedFilename()).toBe('interview.json');
  expect(await download.failure()).toBeNull();
  const downloadedPath = await download.path();
  if (!downloadedPath) throw new Error('WebKit synthetic manual export did not produce a file.');
  const stream = await download.createReadStream();
  if (!stream) throw new Error('WebKit synthetic export download stream unavailable.');
  const decoder = new TextDecoder();
  let exportedText = '';
  for await (const chunk of stream) exportedText += decoder.decode(chunk as Uint8Array, { stream: true });
  exportedText += decoder.decode();
  const exported = JSON.parse(exportedText) as {
    sessionSchemaVersion: string; clientLabel: string;
    sessionId: string; answers: Record<string, { value: string | null; note: string }>;
  };
  expect(exported.sessionSchemaVersion).toBe('1.3.0');
  expect(exported.clientLabel).toBe(label);
  expect(exported.answers['existing-presence']).toMatchObject({ value: answer, note: privateNote });

  const destination = await browser.newContext({ viewport: { width: 390, height: 820 } });
  try {
    const restored = await destination.newPage();
    await restored.goto('/');
    await expect(restored.getByText('No saved interviews yet.')).toBeVisible();
    expect(await hasSyntheticPersistedAnswer(restored, label, answer)).toBe(false);
    // Real hidden file chooser: setInputFiles dispatches a native File change;
    // the normal application import validator and IndexedDB writer own commit.
    await restored.locator('#import-file').setInputFiles(downloadedPath);
    await expect.poll(async () => hasSyntheticPersistedAnswer(restored, label, answer)).toBe(true);
    await restored.reload();
    await expect.poll(async () => hasSyntheticPersistedAnswer(restored, label, answer)).toBe(true);
    const restoredNote = await restored.evaluate(async (sessionId) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('ldw-interview-facilitator');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        const record = await new Promise<{ sessionId: string; answers: Record<string, { note: string }> } | undefined>(
          (resolve, reject) => {
            const tx = db.transaction('sessions', 'readonly');
            const request = tx.objectStore('sessions').get(sessionId);
            request.onsuccess = () => resolve(request.result as { sessionId: string; answers: Record<string, { note: string }> } | undefined);
            request.onerror = () => reject(request.error);
          },
        );
        return record?.answers['existing-presence']?.note ?? null;
      } finally {
        db.close();
      }
    }, exported.sessionId);
    expect(restoredNote).toBe(privateNote);
  } finally {
    await destination.close();
  }
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

import { expect, test, type Page } from '@playwright/test';

// Read the actual local session row. UI save badges alone cannot prove durability.
async function hasSavedValues(page: Page, label: string, answer: string, note?: string): Promise<boolean> {
  return page.evaluate(async ({ label, answer, note }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('ldw-interview-facilitator');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      if (!db.objectStoreNames.contains('sessions')) return false;
      const rows = await new Promise<unknown[]>((resolve, reject) => {
        const tx = db.transaction('sessions', 'readonly');
        const request = tx.objectStore('sessions').getAll();
        request.onsuccess = () => resolve(request.result as unknown[]);
        request.onerror = () => reject(request.error);
        tx.onabort = () => reject(tx.error);
      });
      return rows.some((raw) => {
        if (typeof raw !== 'object' || raw === null) return false;
        const row = raw as {
          clientLabel?: string;
          answers?: Record<string, { value?: unknown; note?: unknown }>;
        };
        const captured = row.answers?.['existing-presence'];
        return row.clientLabel === label && captured?.value === answer
          && (note === undefined || captured.note === note);
      });
    } finally {
      db.close();
    }
  }, { label, answer, note });
}

test.beforeAll(async ({ browser }) => {
  // This is the actual branded system Edge version supplied by the Windows VM.
  console.log('HOSTED_WINDOWS_EDGE_BROWSER_VERSION=' + browser.version());
});

test('Windows hosted Edge: real SW-controlled offline shell and IndexedDB save/reload', async ({ page, context }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'New interview' })).toBeVisible();

  // Require the real production service worker to finish installation.
  // A controlled page is a prerequisite; an ordinary cached browser tab is not enough.
  await expect.poll(async () => page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    return registration?.active?.state === 'activated';
  }), { timeout: 20_000 }).toBe(true);
  await page.reload();
  await expect.poll(async () => page.evaluate(
    () => navigator.serviceWorker.controller !== null,
  )).toBe(true);

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('button', { name: 'New interview' })).toBeVisible();
  const label = 'SYNTHETIC HOSTED WINDOWS EDGE OFFLINE';
  const answer = 'Fictional discovery answer saved fully offline.';
  await page.getByRole('button', { name: 'New interview' }).click();
  await page.getByLabel('Project or client label').fill(label);
  await page.getByRole('button', { name: 'Start interview' }).click();
  await page.locator('#answer').fill(answer);
  await expect.poll(async () => hasSavedValues(page, label, answer)).toBe(true);
  await page.reload();
  await expect(page.getByRole('button', { name: 'New interview' })).toBeVisible();
  await expect.poll(async () => hasSavedValues(page, label, answer)).toBe(true);
  // No external API, remote sync, installed PWA, or physical-device behavior is inferred.
});

test('Windows hosted Edge: actual downloaded JSON restores into a separate Edge context', async ({ page, browser }) => {
  await page.setViewportSize({ width: 390, height: 820 });
  await page.goto('/');
  const label = 'SYNTHETIC HOSTED WINDOWS EDGE TRANSFER';
  const answer = 'Fictional cross-profile Windows Edge transfer answer.';
  const note = 'SYNTHETIC PRIVATE NOTE NEVER FOR PRESENTATION';

  await page.getByRole('button', { name: 'New interview' }).click();
  await page.getByLabel('Project or client label').fill(label);
  await page.getByRole('button', { name: 'Start interview' }).click();
  await page.locator('#answer').fill(answer);
  await page.locator('#question-note').fill(note);
  await expect.poll(async () => hasSavedValues(page, label, answer, note)).toBe(true);

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
  await expect(page.getByRole('button', { name: 'Export full JSON backup' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Exit presentation' }).click();

  const downloadWait = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export full JSON backup' }).click();
  const download = await downloadWait;
  expect(download.suggestedFilename()).toBe('interview.json');
  expect(await download.failure()).toBeNull();
  // This is a real Playwright-managed file on Windows, not only a click event.
  const path = await download.path();
  if (!path) throw new Error('No actual Windows Edge download file was produced.');
  const stream = await download.createReadStream();
  if (!stream) throw new Error('Windows Edge download stream was not readable.');
  const decoder = new TextDecoder();
  let text = '';
  for await (const chunk of stream) text += decoder.decode(chunk as Uint8Array, { stream: true });
  text += decoder.decode();
  const parsed = JSON.parse(text) as {
    sessionSchemaVersion: string;
    sessionId: string;
    clientLabel: string;
    answers: Record<string, { value: unknown; note: unknown }>;
  };
  expect(parsed.sessionSchemaVersion).toBe('1.3.0');
  expect(parsed.clientLabel).toBe(label);
  expect(parsed.answers['existing-presence']).toMatchObject({ value: answer, note });

  const separateContext = await browser.newContext({ viewport: { width: 390, height: 820 } });
  try {
    const secondPage = await separateContext.newPage();
    await secondPage.goto('/');
    await expect(secondPage.getByText('No saved interviews yet.')).toBeVisible();
    expect(await hasSavedValues(secondPage, label, answer, note)).toBe(false);
    await secondPage.locator('#import-file').setInputFiles(path);
    await expect.poll(async () => hasSavedValues(secondPage, label, answer, note)).toBe(true);
    await secondPage.reload();
    await expect.poll(async () => hasSavedValues(secondPage, label, answer, note)).toBe(true);
  } finally {
    await separateContext.close();
  }
});

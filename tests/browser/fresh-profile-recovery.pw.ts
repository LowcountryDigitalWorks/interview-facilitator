import { expect, test, type Download, type Page } from '@playwright/test';
import type { SemanticInterviewSession } from '../../src/semantic-session';
import { validateSemanticSessionRecord } from '../../src/semantic-session';

/**
 * #35 / #105: two separate Chromium browser profiles, not two tabs sharing
 * IndexedDB. Every record and file is synthetic. This proves the existing
 * local 1.3 JSON backup + actual Home Import flow preserve meaningful
 * interview data across fresh storage; NOT physical-device/Safari, remote
 * encrypted archival, customer authority, or a private-handoff-v1 importer.
 */
const DB = 'ldw-interview-facilitator';

async function storedSessions(page: Page): Promise<SemanticInterviewSession[]> {
  return page.evaluate(async (name) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, 4);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<SemanticInterviewSession[]>((resolve, reject) => {
        const tx = db.transaction('sessions', 'readonly');
        const request = tx.objectStore('sessions').getAll();
        request.onsuccess = () => resolve(request.result as SemanticInterviewSession[]);
        request.onerror = () => reject(request.error);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  }, DB);
}

async function downloadedText(download: Download): Promise<string> {
  const stream = await download.createReadStream();
  if (!stream) throw new Error('Synthetic backup download stream is unavailable.');
  const decoder = new TextDecoder();
  let text = '';
  for await (const chunk of stream) text += decoder.decode(chunk as Uint8Array, { stream: true });
  return text + decoder.decode();
}

test('existing private 1.3 JSON backup restores in a fresh browser profile with notes and drafts preserved', async ({ browser }) => {
  const sourceContext = await browser.newContext({ acceptDownloads: true });
  const destinationContext = await browser.newContext({ acceptDownloads: true });
  try {
    const sourcePage = await sourceContext.newPage();
    const destinationPage = await destinationContext.newPage();

    await sourcePage.goto('/');
    await sourcePage.getByRole('button', { name: 'New interview' }).click();
    await sourcePage.getByLabel('Project or client label').fill('SYNTHETIC PORTABLE RECOVERY');
    await sourcePage.getByRole('button', { name: 'Start interview' }).click();

    const action = 'SYNTHETIC OWNER-REVIEWED FOLLOW-UP PROPOSAL';
    const owner = 'SYNTHETIC OWNER';
    // Legacy free-text due suggestions remain intact in canonical backup;
    // a future workflow must reject/normalize before assigning any task.
    const date = 'after synthetic review / TBD';
    const questionNote = 'SYNTHETIC CONFIDENTIAL QUESTION NOTE';
    const runningNotes = 'SYNTHETIC PRIVATE PARKING LOT — NEVER IN OWNER CONSOLE';
    await sourcePage.getByLabel('Proposed follow-up action').fill(action);
    await sourcePage.getByLabel('Suggested owner').fill(owner);
    await sourcePage.getByLabel('Suggested due date').fill(date);
    await sourcePage.locator('#question-note').fill(questionNote);
    await sourcePage.locator('#running-notes').fill(runningNotes);

    await expect.poll(async () => {
      const rows = await storedSessions(sourcePage);
      return rows[0]?.runningNotes;
    }, { timeout: 10_000 }).toBe(runningNotes);
    await expect.poll(async () => {
      const rows = await storedSessions(sourcePage);
      return rows[0]?.answers['existing-presence']?.followUp?.action;
    }, { timeout: 10_000 }).toBe(action);

    // Presentation must not expose backup controls. Explicitly leave it
    // before exporting the actual local canonical JSON backup.
    await sourcePage.locator('[data-question-id="must-have"]').click();
    await sourcePage.getByRole('button', { name: 'Review interview' }).click();
    await expect(sourcePage.getByRole('button', { name: 'Export full JSON backup' })).toHaveCount(0);
    await sourcePage.getByRole('button', { name: 'Exit presentation' }).click();
    const downloadStarted = sourcePage.waitForEvent('download');
    await sourcePage.getByRole('button', { name: 'Export full JSON backup' }).click();
    const backupDownload = await downloadStarted;
    const backupText = await downloadedText(backupDownload);
    const backupPath = await backupDownload.path();
    const source = await validateSemanticSessionRecord(JSON.parse(backupText) as unknown);
    expect(source.sessionSchemaVersion).toBe('1.3.0');
    expect(source.clientLabel).toBe('SYNTHETIC PORTABLE RECOVERY');
    expect(source.runningNotes).toBe(runningNotes);
    expect(source.answers['existing-presence']?.note).toBe(questionNote);
    expect(source.answers['existing-presence']?.followUp).toEqual({ action, owner, dueDate: date });

    // The second context is entirely separate: it has no source IndexedDB
    // rows or access to the source context's storage partition.
    await destinationPage.goto('/');
    expect(await storedSessions(destinationPage)).toEqual([]);
    await expect(destinationPage.getByText('No saved interviews yet.')).toBeVisible();
    // Reuse the real downloaded temporary JSON file, not an in-memory
    // fabricated payload or shared browser storage.
    await destinationPage.locator('#import-file').setInputFiles(backupPath);
    await expect(destinationPage.locator('.app-header')).toContainText('SYNTHETIC PORTABLE RECOVERY');
    await expect.poll(async () => (await storedSessions(destinationPage)).length).toBe(1);
    const restored = (await storedSessions(destinationPage))[0]!;
    expect(restored.sessionId).toBe(source.sessionId);
    expect(restored.packIdentity).toEqual(source.packIdentity);
    expect(restored.packSnapshot).toEqual(source.packSnapshot);
    expect(restored.answers).toEqual(source.answers);
    expect(restored.knownFacts).toEqual(source.knownFacts);
    expect(restored.runningNotes).toEqual(runningNotes);
    expect(restored.clientLabel).toBe(source.clientLabel);
    // The existing import uses saveSession, so it deliberately starts a NEW
    // local revision and does not preserve the exported revision ID exactly.
    // Do not claim byte-exact restore or complete revision-lineage recovery.
    expect(restored.revisionId).not.toBe(source.revisionId);
    expect(restored.parentRevisionId).toBeNull();

    await destinationPage.reload();
    await destinationPage.getByRole('button', { name: /SYNTHETIC PORTABLE RECOVERY/ }).click();
    await destinationPage.locator('[data-question-id="existing-presence"]').click();
    await expect(destinationPage.getByLabel('Proposed follow-up action')).toHaveValue(action);
    await expect(destinationPage.getByLabel('Suggested owner')).toHaveValue(owner);
    await expect(destinationPage.getByLabel('Suggested due date')).toHaveValue(date);
    await expect(destinationPage.locator('#question-note')).toHaveValue(questionNote);
    await expect(destinationPage.locator('#running-notes')).toHaveValue(runningNotes);
    // A successful synthetic restore has no effect on the original profile.
    expect((await storedSessions(sourcePage))[0]?.runningNotes).toBe(runningNotes);
  } finally {
    await destinationContext.close();
    await sourceContext.close();
  }
});

test('a malformed pinned pack backup fails closed in a distinct clean profile', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto('/');
    const alerts: string[] = [];
    page.on('dialog', dialog => {
      alerts.push(dialog.message());
      void dialog.accept();
    });
    // This test uses a valid synthetic 1.3 record, then deliberately corrupts
    // the pinned pack digest. It does NOT claim unsigned JSON protects against
    // a malicious author who recomputes their own digest.
    const { syntheticSemanticSession } = await import('./synthetic-session');
    const source = await syntheticSemanticSession({ clientLabel: 'SYNTHETIC INVALID BACKUP' });
    source.packIdentity.digest = '0'.repeat(64);
    // Browser-native File + change event exercises the real Home import
    // listener without introducing Node typings or writing a temp fixture.
    await page.evaluate((text) => {
      const input = document.querySelector<HTMLInputElement>('#import-file');
      if (!input) throw new Error('Synthetic import picker unavailable.');
      const dt = new DataTransfer();
      dt.items.add(new File([text], 'synthetic-corrupted-pack.json', {
        type: 'application/json',
      }));
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, JSON.stringify(source));
    await expect.poll(() => alerts.length).toBe(1);
    expect(alerts[0]).toMatch(/pack|digest|identity/i);
    await expect(page.getByText('No saved interviews yet.')).toBeVisible();
    expect(await storedSessions(page)).toEqual([]);
  } finally {
    await context.close();
  }
});

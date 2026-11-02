import { expect, test } from '@playwright/test';
import type { InterviewSession } from '../../src/domain';
import { syntheticPinnedSession } from './synthetic-session';
import {
  clearLocalState,
  installIdbFaultInjection,
  listRevisionHistoryKeys,
  listStoredSessionIds,
  navigateHomeKeepingActiveSession,
  openPrivateReview,
  openSeededInterviewOnLastQuestion,
  overwriteRevisionHistory,
  overwriteStoredSession,
  putRawSession,
  readRevisionHistory,
  readStoredAnswer,
  readStoredSession,
  setIdbFault,
  startFreshInterview,
  startNewInterviewWhileActive,
} from './fault-injection.mjs';

function syntheticSession(sessionId = 'synthetic-valid-session', clientLabel = 'Synthetic Browser Test'): Promise<InterviewSession> {
  return syntheticPinnedSession({ sessionId, clientLabel, currentQuestionId: 'must-have' });
}

async function importSessionFile(page: import('@playwright/test').Page, session: unknown): Promise<void> {
  await page.locator('#import-file').waitFor({ state: 'attached' });
  await page.evaluate(({ json }) => {
    const input = document.querySelector('#import-file');
    if (!(input instanceof HTMLInputElement)) throw new Error('Import input not found.');
    const file = new File([json], 'synthetic-import.json', { type: 'application/json' });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, { json: JSON.stringify(session) });
}

test.beforeEach(async ({ page }) => {
  await installIdbFaultInjection(page);
  await clearLocalState(page);
});

test('forced IndexedDB open failure shows storage recovery and retry succeeds', async ({ page }) => {
  await putRawSession(page, await syntheticSession('seed-session'));
  await setIdbFault(page, { blockOpen: true, blockRead: false });
  await page.reload();

  await expect(page.getByText('Storage unavailable')).toBeVisible();
  await expect(page.getByText('Local interviews could not be read.')).toBeVisible();
  await expect(page.getByText('No saved interviews yet.')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'New interview' })).toBeDisabled();

  await setIdbFault(page, { blockOpen: false, blockRead: false });
  await page.getByRole('button', { name: 'Retry local storage' }).click();
  await expect(page.getByRole('button', { name: /Synthetic Browser Test/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New interview' })).toBeEnabled();
});

test('outgoing flush failure blocks session switch and keeps active session recoverable', async ({ page }) => {
  await openSeededInterviewOnLastQuestion(page, 'Active Session', await syntheticSession('seed-active-session', 'Active Session'));
  await setIdbFault(page, { blockWrite: true });
  await page.locator('#answer').fill('Dirty active edit');
  await navigateHomeKeepingActiveSession(page);

  await startNewInterviewWhileActive(page, 'Replacement Session');

  await expect(page.getByText('Local save failed.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Return to active interview' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export active backup' })).toBeVisible();
  await page.getByRole('button', { name: 'Return to active interview' }).click();
  await expect(page.locator('#answer')).toHaveValue('Dirty active edit');
});

test('overlapping session switch attempts do not silently drop the active interview', async ({ page }) => {
  await putRawSession(page, await syntheticSession('session-a', 'Active Session'));
  await putRawSession(page, await syntheticSession('session-b', 'Other Session'));
  await page.reload();
  await page.getByRole('button', { name: /Active Session/ }).click();
  await setIdbFault(page, { blockWrite: true });
  await page.locator('#answer').fill('Still mine');
  await navigateHomeKeepingActiveSession(page);

  await setIdbFault(page, { blockWrite: true });
  const otherCard = page.getByRole('button', { name: /Other Session/ });
  await Promise.all([
    otherCard.click(),
    otherCard.click(),
  ]);

  await expect(page.getByText('Local save failed.')).toBeVisible();
  await page.getByRole('button', { name: 'Return to active interview' }).click();
  await expect(page.locator('#answer')).toHaveValue('Still mine');
});

test('same-ID identical import is a no-op with no revision or history churn', async ({ page }) => {
  const sessionId = 'import-identical-session';
  const current = await syntheticSession(sessionId, 'Identical Import Test');
  await putRawSession(page, current);
  await page.reload();

  const imported = structuredClone(current);
  imported.revisionId = crypto.randomUUID();
  imported.parentRevisionId = crypto.randomUUID();
  imported.updatedAt = '2026-11-02T01:45:00.000Z';
  await importSessionFile(page, imported);
  await expect(page.locator('#answer')).toBeVisible();

  const stored = await readStoredSession(page, sessionId);
  expect(stored.revisionId).toBe(current.revisionId);
  expect(stored.parentRevisionId).toBe(current.parentRevisionId);
  expect(await listRevisionHistoryKeys(page)).toEqual([]);
});

test('invalid import is fully rejected before collision handling or storage mutation', async ({ page }) => {
  const sessionId = 'import-invalid-session';
  const current = await syntheticSession(sessionId, 'Invalid Import Test');
  await putRawSession(page, current);
  await page.reload();
  const invalid = structuredClone(current);
  invalid.runningNotes = 'Invalid replacement attempt';
  invalid.packIdentity.digest = '0'.repeat(64);

  const dialogPromise = page.waitForEvent('dialog');
  await importSessionFile(page, invalid);
  const dialog = await dialogPromise;
  expect(dialog.type()).toBe('alert');
  await dialog.dismiss();

  expect(await readStoredSession(page, sessionId)).toEqual(current);
  expect(await listRevisionHistoryKeys(page)).toEqual([]);
  await expect(page.getByRole('button', { name: /Invalid Import Test/ })).toBeVisible();
});

test('different same-ID import defaults to copy and preserves both independent lineages', async ({ page }) => {
  const sessionId = 'import-copy-session';
  const current = await syntheticSession(sessionId, 'Import Copy Test');
  await putRawSession(page, current);
  await page.reload();

  const imported = structuredClone(current);
  imported.runningNotes = 'Imported copy content';
  imported.revisionId = 'imported-foreign-revision';
  imported.parentRevisionId = 'imported-foreign-parent';
  imported.updatedAt = '2026-11-02T01:46:00.000Z';
  await importSessionFile(page, imported);
  await expect(page.getByRole('button', { name: 'Import as copy' })).toBeVisible();
  await page.getByRole('button', { name: 'Import as copy' }).click();
  await expect(page.locator('#answer')).toBeVisible();

  const ids = await listStoredSessionIds(page);
  expect(ids).toHaveLength(2);
  expect(ids).toContain(sessionId);
  const copyId = ids.find((id: string) => id !== sessionId);
  expect(copyId).toBeTruthy();
  const kept = await readStoredSession(page, sessionId);
  const copied = await readStoredSession(page, copyId!);
  expect(kept.revisionId).toBe(current.revisionId);
  expect(copied.sessionId).toBe(copyId);
  expect(copied.sessionId).not.toBe(imported.sessionId);
  expect(copied.revisionId).not.toBe(imported.revisionId);
  expect(copied.parentRevisionId).toBeNull();
  expect(copied.runningNotes).toBe('Imported copy content');
  expect(await listRevisionHistoryKeys(page)).toEqual([]);
});

test('explicit replace retains the exact prior revision and writes a fresh parent-linked current revision', async ({ page }) => {
  const sessionId = 'import-replace-session';
  const current = await syntheticSession(sessionId, 'Import Replace Test');
  await putRawSession(page, current);
  await page.reload();

  const imported = structuredClone(current);
  imported.runningNotes = 'Replacement content';
  imported.revisionId = 'foreign-revision';
  imported.parentRevisionId = 'foreign-parent';
  imported.updatedAt = '2026-11-02T01:47:00.000Z';
  await importSessionFile(page, imported);
  await expect(page.getByRole('button', { name: 'Replace existing' })).toBeVisible();
  await page.getByRole('button', { name: 'Replace existing' }).click();
  await expect(page.locator('#answer')).toBeVisible();

  const stored = await readStoredSession(page, sessionId);
  expect(stored.revisionId).not.toBe(current.revisionId);
  expect(stored.revisionId).not.toBe(imported.revisionId);
  expect(stored.parentRevisionId).toBe(current.revisionId);
  expect(stored.runningNotes).toBe('Replacement content');
  const historyKey = `${sessionId}|${current.revisionId}`;
  expect(await listRevisionHistoryKeys(page)).toEqual([historyKey]);
  expect(await readRevisionHistory(page, historyKey)).toEqual(current);
});

test('explicit replace preserves an identical pre-existing history record', async ({ page }) => {
  const sessionId = 'import-existing-history-session';
  const current = await syntheticSession(sessionId, 'Import Existing History Test');
  await putRawSession(page, current);
  await page.reload();
  const historyKey = `${sessionId}|${current.revisionId}`;
  await overwriteRevisionHistory(page, historyKey, current);
  const imported = structuredClone(current);
  imported.runningNotes = 'Replacement after existing history';

  await importSessionFile(page, imported);
  await page.getByRole('button', { name: 'Replace existing' }).click();
  await expect(page.locator('#answer')).toBeVisible();

  const stored = await readStoredSession(page, sessionId);
  expect(stored.parentRevisionId).toBe(current.revisionId);
  expect(stored.runningNotes).toBe('Replacement after existing history');
  expect(await listRevisionHistoryKeys(page)).toEqual([historyKey]);
  expect(await readRevisionHistory(page, historyKey)).toEqual(current);
});

test('conflicting pre-existing history fails closed without changing current or history', async ({ page }) => {
  const sessionId = 'import-conflicting-history-session';
  const current = await syntheticSession(sessionId, 'Import Conflicting History Test');
  await putRawSession(page, current);
  await page.reload();
  const historyKey = `${sessionId}|${current.revisionId}`;
  const conflictingHistory = structuredClone(current);
  conflictingHistory.runningNotes = 'Conflicting retained data';
  await overwriteRevisionHistory(page, historyKey, conflictingHistory);
  const imported = structuredClone(current);
  imported.runningNotes = 'Replacement must not commit';

  await importSessionFile(page, imported);
  await page.getByRole('button', { name: 'Replace existing' }).click();
  await expect(page.getByText('Existing local interviews and retained revision history were left unchanged.')).toBeVisible();

  expect(await readStoredSession(page, sessionId)).toEqual(current);
  expect(await listRevisionHistoryKeys(page)).toEqual([historyKey]);
  expect(await readRevisionHistory(page, historyKey)).toEqual(conflictingHistory);
});

test('cancelled same-ID collision keeps the current row and history unchanged', async ({ page }) => {
  const sessionId = 'import-cancel-session';
  const current = await syntheticSession(sessionId, 'Import Cancel Test');
  await putRawSession(page, current);
  await page.reload();
  const imported = structuredClone(current);
  imported.runningNotes = 'Do not import me';

  await importSessionFile(page, imported);
  await expect(page.getByRole('button', { name: 'Cancel — keep current' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel — keep current' }).click();
  await expect(page.getByRole('button', { name: /Import Cancel Test/ })).toBeVisible();
  expect(await readStoredSession(page, sessionId)).toEqual(current);
  expect(await listRevisionHistoryKeys(page)).toEqual([]);
});

test('stale explicit replace decision is rejected with zero history mutation', async ({ page }) => {
  const sessionId = 'import-stale-replace-session';
  const current = await syntheticSession(sessionId, 'Import Stale Replace Test');
  await putRawSession(page, current);
  await page.reload();
  const imported = structuredClone(current);
  imported.runningNotes = 'Stale replacement content';

  await importSessionFile(page, imported);
  await expect(page.getByRole('button', { name: 'Replace existing' })).toBeVisible();
  const newer = structuredClone(current);
  newer.parentRevisionId = current.revisionId;
  newer.revisionId = crypto.randomUUID();
  newer.runningNotes = 'Newer local content';
  newer.updatedAt = '2026-11-02T01:48:00.000Z';
  await overwriteStoredSession(page, newer);
  await page.getByRole('button', { name: 'Replace existing' }).click();

  await expect(page.getByText('Another tab changed this interview after the import decision.')).toBeVisible();
  expect(await readStoredSession(page, sessionId)).toEqual(newer);
  expect(await listRevisionHistoryKeys(page)).toEqual([]);
});

test('history write failure rolls back both retained history and replacement current', async ({ page }) => {
  const sessionId = 'import-history-failure-session';
  const current = await syntheticSession(sessionId, 'Import History Failure Test');
  await putRawSession(page, current);
  await page.reload();
  const imported = structuredClone(current);
  imported.runningNotes = 'Replacement that must roll back';

  await importSessionFile(page, imported);
  await expect(page.getByRole('button', { name: 'Replace existing' })).toBeVisible();
  await setIdbFault(page, { blockHistoryWrite: true });
  await page.getByRole('button', { name: 'Replace existing' }).click();

  await expect(page.getByText('Existing local interviews and retained revision history were left unchanged.')).toBeVisible();
  expect(await readStoredSession(page, sessionId)).toEqual(current);
  expect(await listRevisionHistoryKeys(page)).toEqual([]);
});

test('failed same-ID import flush keeps dirty active session authoritative', async ({ page }) => {
  const sessionId = 'import-active-session';
  const active = await syntheticSession(sessionId, 'Active Import Test');
  await putRawSession(page, active);
  await page.reload();
  await page.getByRole('button', { name: /Active Import Test/ }).click();
  await setIdbFault(page, { blockWrite: true });
  await page.locator('#answer').fill('Keep this authoritative answer');
  await navigateHomeKeepingActiveSession(page);

  const replacement = await syntheticSession(sessionId, 'Imported Replacement Label');
  replacement.answers['existing-presence'] = { value: 'Imported overwrite attempt', status: null, note: '' };
  await importSessionFile(page, replacement);

  await expect(page.getByText('Pending local edits could not be saved')).toBeVisible();
  await page.getByRole('button', { name: 'Return to active interview' }).click();
  await expect(page.locator('#answer')).toHaveValue('Keep this authoritative answer');
  await expect(await readStoredAnswer(page, sessionId)).not.toBe('Imported overwrite attempt');
  expect(await listRevisionHistoryKeys(page)).toEqual([]);
});

test('delete clears current and retained history even when autosave was recently scheduled', async ({ page }) => {
  const sessionId = 'seed-delete-resurrection-test';
  const seeded = await syntheticSession(sessionId, 'Delete Resurrection Test');
  await openSeededInterviewOnLastQuestion(page, 'Delete Resurrection Test', seeded);
  await overwriteRevisionHistory(page, `${sessionId}|retained-old-revision`, { ...seeded, revisionId: 'retained-old-revision' });
  await page.locator('#answer').fill('Pending delete proof');
  await page.waitForTimeout(50);
  await openPrivateReview(page);

  page.once('dialog', (dialog) => dialog.accept());
  const deleteButton = page.getByRole('button', { name: 'Delete local session' });
  await deleteButton.scrollIntoViewIfNeeded();
  await deleteButton.click();
  await expect(page.getByText('No saved interviews yet.')).toBeVisible();
  expect(await listStoredSessionIds(page)).toEqual([]);
  expect(await listRevisionHistoryKeys(page)).toEqual([]);
});

test('stale delete decision cannot remove a newer local revision or its retained history', async ({ page }) => {
  const sessionId = 'stale-delete-session';
  const current = await syntheticSession(sessionId, 'Stale Delete Test');
  await openSeededInterviewOnLastQuestion(page, 'Stale Delete Test', current);
  await page.getByRole('button', { name: 'Review interview' }).click();
  await page.getByRole('button', { name: 'Exit presentation' }).click();
  await page.getByRole('button', { name: 'Delete local session' }).waitFor({ state: 'visible', timeout: 10_000 });

  const historyKey = `${sessionId}|${current.revisionId}`;
  await overwriteRevisionHistory(page, historyKey, current);
  const newer = structuredClone(current);
  newer.parentRevisionId = current.revisionId;
  newer.revisionId = crypto.randomUUID();
  newer.runningNotes = 'Newer local state';
  newer.updatedAt = '2026-11-02T01:55:00.000Z';
  await overwriteStoredSession(page, newer);

  let alertText = '';
  page.on('dialog', async (dialog) => {
    if (dialog.type() === 'confirm') await dialog.accept();
    else {
      alertText = dialog.message();
      await dialog.dismiss();
    }
  });
  await page.getByRole('button', { name: 'Delete local session' }).click();
  await expect.poll(() => alertText).toContain('changed in another tab');
  expect(await readStoredSession(page, sessionId)).toEqual(newer);
  expect(await listRevisionHistoryKeys(page)).toEqual([historyKey]);
  expect(await readRevisionHistory(page, historyKey)).toEqual(current);
});

test('pagehide best-effort flush persists a dirty edit before debounce when async completion is allowed', async ({ page }) => {
  await startFreshInterview(page, 'Pagehide Flush Test');
  await page.locator('#answer').fill('Pagehide persisted edit');
  await page.waitForTimeout(40);

  const [sessionId] = await listStoredSessionIds(page);
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));
  });
  await page.waitForTimeout(400);

  await expect.poll(async () => readStoredAnswer(page, sessionId)).toBe('Pagehide persisted edit');
});

test('retry after save failure clears stale error UI once the current generation saves', async ({ page }) => {
  await startFreshInterview(page, 'Retry Save Test');
  await setIdbFault(page, { blockWrite: true });
  await page.locator('#answer').fill('First failing generation');
  await expect(page.locator('[data-save-indicator]')).toContainText(/Local save failed/, { timeout: 10_000 });

  await setIdbFault(page, { blockWrite: false });
  await page.locator('#answer').fill('Second successful generation');
  await page.waitForTimeout(320);
  await expect(page.locator('[data-save-indicator]')).not.toContainText(/Local save failed/);
  await expect(page.locator('[data-save-alert]')).toHaveText('');
});

test('two tabs reject a stale revision after the first tab commits', async ({ page }) => {
  const sessionId = 'synthetic-two-tab-revision-guard';
  const r1 = await syntheticSession(sessionId, 'Two Tab Revision Proof');
  r1.currentQuestionId = 'existing-presence';
  await putRawSession(page, r1);
  await page.reload();
  const tabB = await page.context().newPage();
  try {
    await tabB.goto('/');
    const cardA = page.getByRole('button', { name: /Two Tab Revision Proof/ });
    const cardB = tabB.getByRole('button', { name: /Two Tab Revision Proof/ });
    await expect(cardA).toBeVisible();
    await expect(cardB).toBeVisible();
    await cardA.click();
    await cardB.click();

    const revisionA = await page.evaluate(async (id) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('ldw-interview-facilitator', 4);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const row = await new Promise<{ revisionId: string }>((resolve, reject) => {
        const request = db.transaction('sessions').objectStore('sessions').get(id);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      db.close();
      return row.revisionId;
    }, sessionId);
    expect(revisionA).toBe(r1.revisionId);

    await page.locator('#answer').fill('Committed by tab A');
    await expect.poll(async () => readStoredAnswer(page, sessionId)).toBe('Committed by tab A');
    const revisionBPage = tabB.locator('#answer');
    await revisionBPage.fill('Stale overwrite from tab B');
    await expect(tabB.locator('[data-save-indicator]')).toContainText('Local save failed');
    await expect(tabB.locator('[data-save-alert]')).toContainText('Another tab saved a newer revision');

    const current = await page.evaluate(async (id) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('ldw-interview-facilitator', 4);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const row = await new Promise<{ revisionId: string; parentRevisionId: string | null; answers: Record<string, { value: string | null }> }>((resolve, reject) => {
        const request = db.transaction('sessions').objectStore('sessions').get(id);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      db.close();
      return row;
    }, sessionId);
    expect(current.revisionId).not.toBe(revisionA);
    expect(current.parentRevisionId).toBe(revisionA);
    expect(Object.values(current.answers).some((answer) => answer.value === 'Committed by tab A')).toBe(true);
    expect(Object.values(current.answers).some((answer) => answer.value === 'Stale overwrite from tab B')).toBe(false);
  } finally {
    await tabB.close();
  }
});

test('database layout upgrade assigns revision metadata to existing current sessions', async ({ page }) => {
  const legacy = await syntheticSession('synthetic-revision-layout-upgrade', 'Revision Layout Upgrade');
  delete (legacy as Partial<InterviewSession>).revisionId;
  delete (legacy as Partial<InterviewSession>).parentRevisionId;
  await page.evaluate(async ({ row }) => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase('ldw-interview-facilitator');
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Database deletion was blocked.'));
    });
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('ldw-interview-facilitator', 2);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('sessions', { keyPath: 'sessionId' });
        request.result.createObjectStore('legacy-session-archive');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('sessions', 'readwrite');
      transaction.objectStore('sessions').put(row);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    db.close();
  }, { row: legacy });

  await page.reload();
  await expect(page.getByRole('button', { name: /Revision Layout Upgrade/ })).toBeVisible();
  const migrated = await page.evaluate(async (id) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('ldw-interview-facilitator', 4);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const row = await new Promise<{ revisionId: string; parentRevisionId: string | null }>((resolve, reject) => {
      const request = db.transaction('sessions').objectStore('sessions').get(id);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return row;
  }, legacy.sessionId);
  expect(migrated.revisionId).toMatch(/^[-\w:]+$/);
  expect(migrated.parentRevisionId).toBeNull();
});

import { expect, test } from '@playwright/test';
import type { InterviewSession } from '../../src/domain';
import {
  clearLocalState,
  installIdbFaultInjection,
  listStoredSessionIds,
  navigateHomeKeepingActiveSession,
  openPrivateReview,
  openSeededInterviewOnLastQuestion,
  putRawSession,
  readStoredAnswer,
  setIdbFault,
  startFreshInterview,
  startNewInterviewWhileActive,
} from './fault-injection.mjs';

function syntheticSession(sessionId = 'synthetic-valid-session', clientLabel = 'Synthetic Browser Test'): InterviewSession {
  const timestamp = '2026-10-31T20:00:00.000Z';
  return {
    sessionSchemaVersion: '1.0.0',
    sessionId,
    interviewPackId: 'general-discovery',
    interviewPackVersion: '1.0.0',
    clientLabel,
    interviewerLabel: 'Test Operator',
    interviewMode: 'Conversation',
    createdAt: timestamp,
    updatedAt: timestamp,
    currentQuestionId: 'must-have',
    knownFacts: [],
    answers: {
      'existing-presence': { value: null, status: null, note: '' },
      'primary-goal': { value: null, status: null, note: '' },
      'needs-booking': { value: null, status: null, note: '' },
      'booking-process': { value: null, status: null, note: '' },
      'must-have': { value: null, status: null, note: '' },
    },
    runningNotes: '',
  };
}

test.beforeEach(async ({ page }) => {
  await installIdbFaultInjection(page);
  await clearLocalState(page);
});

test('forced IndexedDB open failure shows storage recovery and retry succeeds', async ({ page }) => {
  await putRawSession(page, syntheticSession('seed-session'));
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
  await openSeededInterviewOnLastQuestion(page, 'Active Session');
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
  await putRawSession(page, syntheticSession('session-a', 'Active Session'));
  await putRawSession(page, syntheticSession('session-b', 'Other Session'));
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

test('same-id import replacement failure keeps dirty active session authoritative', async ({ page }) => {
  const sessionId = 'import-active-session';
  const active = syntheticSession(sessionId, 'Active Import Test');
  await putRawSession(page, active);
  await page.reload();
  await page.getByRole('button', { name: /Active Import Test/ }).click();
  await setIdbFault(page, { blockWrite: true });
  await page.locator('#answer').fill('Keep this authoritative answer');
  await navigateHomeKeepingActiveSession(page);

  const replacement = syntheticSession(sessionId, 'Imported Replacement Label');
  replacement.answers['existing-presence'] = { value: 'Imported overwrite attempt', status: null, note: '' };

  await setIdbFault(page, { blockWrite: true });
  page.once('dialog', (dialog) => dialog.accept());

  await page.locator('#import-file').waitFor({ state: 'attached' });
  const importPath = `import-${sessionId}.json`;
  await page.evaluate(({ json, fileName }) => {
    const input = document.querySelector('#import-file');
    if (!(input instanceof HTMLInputElement)) throw new Error('Import input not found.');
    const file = new File([json], fileName, { type: 'application/json' });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, { json: JSON.stringify(replacement), fileName: importPath });

  await expect(page.getByText('Local save failed.')).toBeVisible();
  await page.getByRole('button', { name: 'Return to active interview' }).click();
  await expect(page.locator('#answer')).toHaveValue('Keep this authoritative answer');
  await expect(await readStoredAnswer(page, sessionId)).not.toBe('Imported overwrite attempt');
});

test('delete clears IndexedDB even when autosave was recently scheduled', async ({ page }) => {
  await openSeededInterviewOnLastQuestion(page, 'Delete Resurrection Test');
  await page.locator('#answer').fill('Pending delete proof');
  await page.waitForTimeout(50);
  await openPrivateReview(page);

  page.once('dialog', (dialog) => dialog.accept());
  const deleteButton = page.getByRole('button', { name: 'Delete local session' });
  await deleteButton.scrollIntoViewIfNeeded();
  await deleteButton.click();
  await expect(page.getByText('No saved interviews yet.')).toBeVisible();
  expect(await listStoredSessionIds(page)).toEqual([]);
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

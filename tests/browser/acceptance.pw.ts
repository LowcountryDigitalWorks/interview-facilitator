import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import type { InterviewSession } from '../../src/domain';

const DB_NAME = 'ldw-interview-facilitator';
const STORE = 'sessions';

async function clearLocalState(page: Page): Promise<void> {
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

async function putRawSession(page: Page, row: unknown): Promise<void> {
  await page.evaluate(async ({ dbName, store, row }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(dbName, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(store)) request.result.createObjectStore(store, { keyPath: 'sessionId' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).put(row);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    db.close();
  }, { dbName: DB_NAME, store: STORE, row });
}

function syntheticSession(sessionId = 'synthetic-valid-session'): InterviewSession {
  const timestamp = '2026-10-31T20:00:00.000Z';
  return {
    sessionSchemaVersion: '1.0.0',
    sessionId,
    interviewPackId: 'general-discovery',
    interviewPackVersion: '1.0.0',
    clientLabel: 'Synthetic Browser Test',
    interviewerLabel: 'Test Operator',
    interviewMode: 'Conversation',
    createdAt: timestamp,
    updatedAt: timestamp,
    currentQuestionId: 'existing-presence',
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
  await clearLocalState(page);
});

test('Home distinguishes a legitimate empty database and meets the initial axe floor', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('No saved interviews yet.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'New interview' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Import session JSON' })).toBeEnabled();

  const results = await new AxeBuilder({ page }).analyze();
  const consequential = results.violations.filter((violation) => violation.impact === 'critical' || violation.impact === 'serious');
  expect(consequential).toEqual([]);
});

test('one malformed IndexedDB row does not hide a healthy local interview', async ({ page }) => {
  await page.goto('/');
  await putRawSession(page, syntheticSession());
  await putRawSession(page, { sessionId: 'synthetic-malformed-session', updatedAt: null });
  await page.reload();

  await expect(page.getByRole('button', { name: /Synthetic Browser Test/ })).toBeVisible();
  await expect(page.getByText('1 local interview could not be read.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'New interview' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Import session JSON' })).toBeEnabled();
});

test('answer, question note, and running note keep focus and selection through autosave', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New interview' }).click();
  await page.getByLabel('Project or client label').fill('Synthetic Focus Test');
  await page.getByRole('button', { name: 'Start interview' }).click();

  for (const selector of ['#answer', '#question-note', '#running-notes']) {
    const field = page.locator(selector);
    await field.fill('abcdefghij');
    await field.focus();
    await field.evaluate((element) => (element as HTMLTextAreaElement).setSelectionRange(2, 7));
    await page.waitForTimeout(260);
    await expect(field).toBeFocused();
    const selection = await field.evaluate((element) => ({
      start: (element as HTMLTextAreaElement).selectionStart,
      end: (element as HTMLTextAreaElement).selectionEnd,
    }));
    expect(selection).toEqual({ start: 2, end: 7 });
  }

  await expect(page.locator('[data-save-indicator]')).toContainText(/Saved/);
});

test('an already-cached production shell reloads while offline', async ({ page, context }) => {
  await page.goto('/');
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload();
  await expect(page.getByRole('button', { name: 'New interview' })).toBeVisible();

  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('button', { name: 'New interview' })).toBeVisible();
  await expect(page.getByText(/Offline/)).toBeVisible();
});

test('Presentation read-back stays public across Change and masks retained deferred values', async ({ page }) => {
  await page.goto('/');
  const row = syntheticSession('synthetic-presentation-session');
  row.currentQuestionId = 'must-have';
  row.answers['existing-presence'] = { value: 'stale internal detail', status: 'SKIP', note: 'private question note' };
  row.answers['primary-goal'] = { value: 'stale not-applicable detail', status: 'N_A', note: '' };
  row.answers['must-have'] = { value: 'Public launch requirement', status: 'ANSWERED', note: '' };
  row.runningNotes = 'private running note';
  await putRawSession(page, row);
  await page.reload();

  await page.getByRole('button', { name: /Synthetic Browser Test/ }).click();
  await page.getByRole('button', { name: 'Presentation view' }).click();
  await expect(page.getByRole('button', { name: 'Exit presentation' })).toBeVisible();
  await expect(page.getByText('Question notes')).toHaveCount(0);
  await expect(page.locator('.context-rail')).toHaveCount(0);
  await expect(page.getByText('Question status')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Export backup' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Review interview' }).click();
  await expect(page.getByText('Presentation read-back')).toBeVisible();
  await expect(page.getByText('Deferred / not captured')).toBeVisible();
  await expect(page.getByText('Not applicable').first()).toBeVisible();
  await expect(page.getByText('stale internal detail')).toHaveCount(0);
  await expect(page.getByText('stale not-applicable detail')).toHaveCount(0);
  await expect(page.getByText('private question note')).toHaveCount(0);
  await expect(page.getByText('private running note')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Export full JSON backup' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Export internal Markdown' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Delete local session' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Home' })).toHaveCount(0);
  await expect(page.getByText(/cannot guarantee that free-text answers themselves contain no sensitive information/)).toBeVisible();

  const readBackAxe = await new AxeBuilder({ page }).analyze();
  const readBackConsequential = readBackAxe.violations.filter((violation) => violation.impact === 'critical' || violation.impact === 'serious');
  expect(readBackConsequential).toEqual([]);

  const change = page.getByRole('button', { name: 'Change What is already in place today?' });
  await expect(change).toBeVisible();
  await change.click();
  await expect(page.getByRole('button', { name: 'Exit presentation' })).toBeVisible();
  await expect(page.getByText('Question notes')).toHaveCount(0);
  await expect(page.locator('.context-rail')).toHaveCount(0);
  await expect(page.locator('#question-prompt')).toBeFocused();
});

async function startSyntheticInterview(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'New interview' }).click();
  await page.getByLabel('Project or client label').fill('Synthetic A11y Test');
  await page.getByRole('button', { name: 'Start interview' }).click();
}

test('active Interview names the text answer from the visible prompt', async ({ page }) => {
  await startSyntheticInterview(page);
  const answer = page.locator('#answer');
  await expect(answer).toHaveAccessibleName('What is already in place today?');
  await expect(answer).toHaveAttribute('aria-describedby', 'question-help');
  await expect(page.getByLabel('Question notes')).toBeVisible();
  await expect(page.getByLabel('Running notes')).toBeVisible();

  const results = await new AxeBuilder({ page }).analyze();
  const consequential = results.violations.filter((violation) => violation.impact === 'critical' || violation.impact === 'serious');
  expect(consequential).toEqual([]);
});

test('status radio change does not replace the focused control', async ({ page }) => {
  await startSyntheticInterview(page);
  const answered = page.getByRole('radio', { name: 'Answered' });
  await answered.focus();
  await page.keyboard.press('Space');
  await expect(answered).toBeChecked();
  await expect(answered).toBeFocused();
});

test('Continue and Back move focus to the active question prompt', async ({ page }) => {
  await startSyntheticInterview(page);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.locator('#question-prompt')).toBeFocused();
  await expect(page.locator('#question-prompt')).toHaveText('What outcome matters most from this work?');
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.locator('#question-prompt')).toBeFocused();
  await expect(page.locator('#question-prompt')).toHaveText('What is already in place today?');

  await page.getByRole('button', { name: 'Presentation view' }).click();
  await page.getByRole('button', { name: 'Exit presentation' }).click();
  await expect(page.locator('#question-prompt')).toBeFocused();
});

test('phone Coverage and Context dialogs restore focus and keep state reachable', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await startSyntheticInterview(page);
  await expect(page.locator('[data-save-indicator]')).toBeVisible();
  await expect(page.locator('[data-connectivity-indicator]')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);

  const coverage = page.getByRole('button', { name: /^Coverage / });
  await coverage.click();
  await expect(coverage).toHaveAttribute('aria-expanded', 'true');
  const coverageDialog = page.getByRole('dialog', { name: 'Coverage' });
  await expect(coverageDialog).toBeVisible();
  await expect(coverageDialog.getByRole('button', { name: 'Close' })).toBeFocused();
  expect(await page.locator('header').evaluate((element) => (element as HTMLElement).inert)).toBe(true);
  expect(await page.locator('.question-stage').evaluate((element) => (element as HTMLElement).inert)).toBe(true);

  const context = page.getByRole('button', { name: /^Context / });
  await context.evaluate((element) => (element as HTMLButtonElement).click());
  await expect(coverage).toHaveAttribute('aria-expanded', 'false');
  await expect(context).toHaveAttribute('aria-expanded', 'true');
  const contextDialog = page.getByRole('dialog', { name: 'Known context' });
  await expect(contextDialog.getByRole('button', { name: 'Close' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(context).toHaveAttribute('aria-expanded', 'false');
  await expect(context).toBeFocused();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('private read-back Change actions include the question topic', async ({ page }) => {
  await startSyntheticInterview(page);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Review interview' }).click();
  const change = page.getByRole('button', { name: 'Change What is already in place today?' });
  await expect(change).toBeVisible();
  await change.click();
  await expect(page.locator('#question-prompt')).toBeFocused();
  await expect(page.locator('#question-prompt')).toHaveText('What is already in place today?');
});

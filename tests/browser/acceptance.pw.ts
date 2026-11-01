import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import type { InterviewSession } from '../../src/domain';
import { syntheticPinnedSession } from './synthetic-session';

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
      const request = indexedDB.open(dbName, 2);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(store)) request.result.createObjectStore(store, { keyPath: 'sessionId' });
        if (!request.result.objectStoreNames.contains('legacy-session-archive')) request.result.createObjectStore('legacy-session-archive');
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

function syntheticSession(sessionId = 'synthetic-valid-session'): Promise<InterviewSession> {
  return syntheticPinnedSession({ sessionId });
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
  await putRawSession(page, await syntheticSession());
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
  const row = await syntheticSession('synthetic-presentation-session');
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

});

async function startFreshInterview(page: Page, clientLabel = 'Synthetic Browser Test'): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'New interview' }).click();
  await page.getByLabel('Project or client label').fill(clientLabel);
  await page.getByRole('button', { name: 'Start interview' }).click();
}

async function advanceToQuestion(page: Page, prompt: string): Promise<void> {
  for (let step = 0; step < 8; step += 1) {
    if (await page.getByRole('heading', { name: prompt, level: 1 }).isVisible()) return;
    const continueButton = page.getByRole('button', { name: 'Continue' });
    if (!(await continueButton.isEnabled())) break;
    await continueButton.click();
  }
}

test('Interview cockpit meets axe floor on the active question view', async ({ page }) => {
  await startFreshInterview(page);
  const results = await new AxeBuilder({ page }).analyze();
  const consequential = results.violations.filter((violation) => violation.impact === 'critical' || violation.impact === 'serious');
  expect(consequential).toEqual([]);
});

test('textarea answer exposes prompt and helper in its accessible name and description', async ({ page }) => {
  await startFreshInterview(page);
  const answer = page.locator('#answer');
  await expect(answer).toHaveAccessibleName('What is already in place today?');
  await expect(answer).toHaveAccessibleDescription('Confirm the known context or capture what has changed.');
});

test('status radio keeps focus and node identity through autosave update', async ({ page }) => {
  await startFreshInterview(page);
  const answered = page.locator('label.status-chip', { hasText: 'Answered' }).locator('input');
  await page.locator('label.status-chip', { hasText: 'Answered' }).click();
  await page.waitForTimeout(280);
  await expect(answered).toBeFocused();
  await expect(answered).toBeChecked();
  const nodeId = await answered.evaluate((element) => element.outerHTML);
  await page.waitForTimeout(280);
  await expect(answered).toBeFocused();
  expect(await answered.evaluate((element) => element.outerHTML)).toBe(nodeId);
});

test('single-choice answer keeps focus when conditional visibility is unchanged', async ({ page }) => {
  await startFreshInterview(page);
  await advanceToQuestion(page, 'Do people need to request or book time?');
  const notSure = page.getByRole('radio', { name: 'Not sure' });
  await notSure.check();
  await page.waitForTimeout(280);
  await expect(notSure).toBeFocused();
  const yes = page.getByRole('radio', { name: 'Yes' });
  await yes.check();
  await page.waitForTimeout(280);
  await expect(yes).toBeFocused();
  await expect(page.getByRole('heading', { name: 'Do people need to request or book time?', level: 1 })).toBeVisible();
});

test('single-choice answer rerenders when conditional visibility changes', async ({ page }) => {
  await startFreshInterview(page);
  await advanceToQuestion(page, 'Do people need to request or book time?');
  await page.getByRole('radio', { name: 'Yes' }).check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'How should booking or scheduling work?', level: 1 })).toBeVisible();
  await page.locator('[data-action="back"]').click();
  await page.locator('fieldset.choice-group input[value="No"]').check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'What absolutely has to be true for the first version to feel successful?', level: 1 })).toBeVisible();
});

test('Continue and Back land focus on the next or previous answer control', async ({ page }) => {
  await startFreshInterview(page);
  await page.locator('#answer').fill('Current state summary');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.locator('#answer')).toBeFocused({ timeout: 5000 });
  await page.locator('[data-action="back"]').click();
  await expect(page.locator('#answer')).toBeFocused({ timeout: 5000 });
});

test('320px phone coverage and context panels expose dialog semantics and isolate background', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await startFreshInterview(page);
  await expect(page.locator('[data-save-indicator]')).toBeVisible();
  await expect(page.locator('[data-connectivity-indicator]').first()).toBeVisible();

  const coverageTrigger = page.locator('#coverage-mobile-trigger');
  const contextTrigger = page.locator('#context-mobile-trigger');
  await coverageTrigger.click();
  await expect(coverageTrigger).toHaveAttribute('aria-expanded', 'true');
  await expect(contextTrigger).toHaveAttribute('aria-expanded', 'false');
  const coveragePanel = page.locator('#coverage-mobile-panel');
  await expect(coveragePanel).toHaveAttribute('role', 'dialog');
  await expect(page.locator('.question-stage')).toHaveJSProperty('inert', true);
  await expect(page.getByRole('button', { name: 'Close coverage' })).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(coverageTrigger).toHaveAttribute('aria-expanded', 'false');
  await expect(coverageTrigger).toBeFocused();

  await contextTrigger.click();
  await expect(contextTrigger).toHaveAttribute('aria-expanded', 'true');
  await expect(coverageTrigger).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#context-mobile-panel')).toHaveAttribute('role', 'dialog');
  await page.getByRole('button', { name: 'Close context' }).click();
  await expect(contextTrigger).toBeFocused();

  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
});

test('review Change control keeps contextual accessible name', async ({ page }) => {
  await page.goto('/');
  const row = await syntheticSession('synthetic-review-a11y');
  row.answers['existing-presence'] = { value: 'Baseline answer', status: 'ANSWERED', note: '' };
  row.currentQuestionId = 'must-have';
  await putRawSession(page, row);
  await page.reload();
  await page.getByRole('button', { name: /Synthetic Browser Test/ }).click();
  await page.getByRole('button', { name: 'Review interview' }).click();
  await expect(page.getByRole('button', { name: 'Change What is already in place today?' })).toBeVisible();
});

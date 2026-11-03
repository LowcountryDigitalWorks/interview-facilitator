import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import type { InterviewSession } from '../../src/domain';
import { canonicalizeJson, sha256Hex } from '../../src/pack-identity';
import { validateSemanticSessionRecord, type SemanticInterviewSession } from '../../src/semantic-session';
import { syntheticPinned12Session, syntheticSemanticSession } from './synthetic-session';

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
      const request = indexedDB.open(dbName, 4);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(store)) request.result.createObjectStore(store, { keyPath: 'sessionId' });
        if (!request.result.objectStoreNames.contains('legacy-session-archive')) request.result.createObjectStore('legacy-session-archive');
        if (!request.result.objectStoreNames.contains('revision-history')) request.result.createObjectStore('revision-history');
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

async function readStorageSnapshot(page: Page): Promise<{ rows: unknown[]; archives: unknown[]; archiveKeys: IDBValidKey[] }> {
  return page.evaluate(async ({ dbName }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(dbName, 4);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = db.transaction(['sessions', 'legacy-session-archive'], 'readonly');
    const completed = new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
      transaction.onerror = () => reject(transaction.error);
    });
    const rowsRequest = transaction.objectStore('sessions').getAll();
    const archivesRequest = transaction.objectStore('legacy-session-archive').getAll();
    const archiveKeysRequest = transaction.objectStore('legacy-session-archive').getAllKeys();
    const read = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const [rows, archives, archiveKeys] = await Promise.all([
      read(rowsRequest),
      read(archivesRequest),
      read(archiveKeysRequest),
    ]);
    await completed;
    db.close();
    return { rows, archives, archiveKeys };
  }, { dbName: DB_NAME });
}

function syntheticSession(sessionId = 'synthetic-valid-session'): Promise<SemanticInterviewSession> {
  return syntheticSemanticSession({ sessionId });
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
  row.answers['existing-presence'] = { value: 'stale internal detail', resolution: 'deferred', source: 'client-statement', needsConfirmation: false, confirmation: null, followUp: null, note: 'private question note' };
  row.answers['primary-goal'] = { value: 'stale not-applicable detail', resolution: 'not-applicable', source: 'client-statement', needsConfirmation: false, confirmation: null, followUp: null, note: '' };
  row.answers['must-have'] = { value: 'Public launch requirement', resolution: 'captured', source: 'client-statement', needsConfirmation: false, confirmation: null, followUp: null, note: '' };
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
  await page.locator('#answer').fill('Current state summary');
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

test('status chips are re-derived from persisted semantic state after status and answer edits', async ({ page }) => {
  await startFreshInterview(page);
  const alreadyKnown = page.locator('label.status-chip', { hasText: 'Already known' }).locator('input');
  const answered = page.locator('label.status-chip', { hasText: 'Answered' }).locator('input');

  await page.locator('label.status-chip', { hasText: 'Already known' }).click();
  await expect(alreadyKnown).not.toBeChecked();
  await expect(page.locator('input[name="status"]:checked')).toHaveCount(0);

  await page.locator('#answer').fill('Client supplied current state');
  await expect(answered).toBeChecked();
  await expect(page.locator('label.status-chip', { hasText: 'Answered' })).toHaveClass(/selected/);
});

test('N/A coverage is visible in summaries and counts toward disposed mobile coverage', async ({ page }) => {
  await startFreshInterview(page);
  await page.locator('label.status-chip', { hasText: 'N/A' }).click();

  await expect(page.locator('[data-coverage-resolved]')).toContainText('0 current');
  await expect(page.locator('[data-coverage-resolved]')).toContainText('1 N/A');
  await expect(page.locator('[data-coverage-mobile]')).toHaveText('Coverage 1/5');
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

test('semantic branching keeps pending visible, ignores deferred/N-A raw values, and reviews reactivated evidence', async ({ page }) => {
  await startFreshInterview(page, 'Semantic Branching Test');
  await advanceToQuestion(page, 'Do people need to request or book time?');

  // Unknown parent evidence is pending, so the dependent objective remains visible rather than collapsing to No.
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'How should booking or scheduling work?', level: 1 })).toBeVisible();
  await page.locator('#answer').fill('Retained booking detail');
  await page.locator('[data-action="back"]').click();

  // Authoritative No makes the child irrelevant.
  await page.locator('fieldset.choice-group input[value="No"]').check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'What absolutely has to be true for the first version to feel successful?', level: 1 })).toBeVisible();
  await page.locator('[data-action="back"]').click();

  // Reactivating Yes restores the retained value for human review, not silent completion.
  await page.locator('fieldset.choice-group input[value="Yes"]').check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'How should booking or scheduling work?', level: 1 })).toBeVisible();
  await expect(page.locator('#answer')).toHaveValue('Retained booking detail');
  await expect(page.locator('label.status-chip', { hasText: 'Must confirm' }).locator('input')).toBeChecked();
  await page.locator('[data-action="back"]').click();

  // A retained raw Yes under N/A is not effective evidence. Unknown/pending is not implicit No,
  // so the child remains visible but its coverage bucket must be open rather than confirmed.
  await page.locator('fieldset.choice-group input[value="Yes"]').check();
  await page.locator('label.status-chip', { hasText: 'N/A' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'How should booking or scheduling work?', level: 1 })).toBeVisible();
  await expect(page.locator('[data-question-id="booking-process"]')).not.toHaveClass(/confirm/);
  await page.locator('[data-action="back"]').click();

  // Deferred behaves the same way: retained raw Yes remains pending/non-authoritative.
  await page.locator('label.status-chip', { hasText: 'Skip' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'How should booking or scheduling work?', level: 1 })).toBeVisible();
  await expect(page.locator('[data-question-id="booking-process"]')).not.toHaveClass(/confirm/);
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
  row.answers['existing-presence'] = { value: 'Baseline answer', resolution: 'captured', source: 'client-statement', needsConfirmation: false, confirmation: null, followUp: null, note: '' };
  row.currentQuestionId = 'must-have';
  await putRawSession(page, row);
  await page.reload();
  await page.getByRole('button', { name: /Synthetic Browser Test/ }).click();
  await page.getByRole('button', { name: 'Review interview' }).click();
  await expect(page.getByRole('button', { name: 'Change What is already in place today?' })).toBeVisible();
});

test('mixed Home records support explicit upgrade and recovery backup', async ({ page }) => {
  await page.goto('/');
  const current = await syntheticSession('synthetic-current-mixed');
  const legacy = await syntheticPinned12Session({ sessionId: 'synthetic-legacy-mixed' });
  legacy.sessionSchemaVersion = '1.1.0';
  delete legacy.packSnapshot.ruleSemanticsVersion;
  legacy.packIdentity.digest = await sha256Hex(canonicalizeJson(legacy.packSnapshot));
  const unsupported = { sessionId: 'synthetic-future-mixed', sessionSchemaVersion: '9.0.0', futurePayload: { retained: true } };
  const malformed = structuredClone(current);
  malformed.sessionId = 'synthetic-malformed-mixed';
  malformed.packIdentity.digest = '0'.repeat(64);
  const unsafeMalformed = { sessionId: 'synthetic-unsafe-malformed-mixed', sessionSchemaVersion: null, unsafeValue: Number.NaN };
  for (const row of [current, legacy, unsupported, malformed, unsafeMalformed]) await putRawSession(page, row);
  const seededSnapshot = await readStorageSnapshot(page);
  await page.reload();
  await expect(page.getByRole('button', { name: /Synthetic Browser Test/ })).toBeVisible();
  await expect(page.getByText('Older interview format')).toBeVisible();
  await expect(page.getByText('Unsupported interview format')).toBeVisible();
  await expect(page.getByText('An interview record could not be read.')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Upgrade' })).toHaveCount(1);
  await expect(page.locator('[data-recovery-id="synthetic-future-mixed"]')).toBeVisible();
  await expect(page.locator('[data-recovery-id="synthetic-malformed-mixed"]')).toBeVisible();
  await expect(page.locator('[data-recovery-id="synthetic-unsafe-malformed-mixed"]')).toHaveCount(0);
  await expect(page.locator('[data-session-id="synthetic-malformed-mixed"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Upgrade' })).toHaveCount(1);
  await expect(page.getByText('5 local interviews could not be read.')).toHaveCount(0);
  const homeSnapshot = await readStorageSnapshot(page);
  expect(homeSnapshot).toEqual(seededSnapshot);
  expect(homeSnapshot.rows).toHaveLength(5);
  expect(homeSnapshot.archives).toHaveLength(0);
  expect(homeSnapshot.archiveKeys).toHaveLength(0);
  const currentBefore = await page.evaluate(async (sessionId) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('ldw-interview-facilitator', 4); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const value = await new Promise<unknown>((resolve, reject) => { const request = db.transaction('sessions').objectStore('sessions').get(sessionId); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    db.close(); return value;
  }, legacy.sessionId);
  expect(currentBefore).toMatchObject({ sessionSchemaVersion: '1.1.0' });
  const upgradedCard = page.locator('[data-session-id="synthetic-legacy-mixed"]');
  await page.getByRole('button', { name: 'Upgrade' }).click();
  await expect(page.getByText('Older interview format')).toHaveCount(0);
  await expect(upgradedCard).toBeVisible();
  const upgraded = await page.evaluate(async (sessionId) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('ldw-interview-facilitator', 4); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const transaction = db.transaction(['sessions', 'legacy-session-archive']);
    const read = (storeName: string, key: IDBValidKey) => new Promise<unknown>((resolve, reject) => { const request = transaction.objectStore(storeName).get(key); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const values = {
      active: await read('sessions', sessionId),
      archive11: await read('legacy-session-archive', `${sessionId}|1.1.0|pinned-1.1-to-1.2`),
      archive12: await read('legacy-session-archive', `${sessionId}|1.2.0|pinned-1.2-to-1.3`),
    };
    db.close(); return values;
  }, legacy.sessionId);
  expect(upgraded.active).toMatchObject({ sessionSchemaVersion: '1.3.0', packSnapshot: { ruleSemanticsVersion: 'effective-evidence-equals-v2' } });
  expect(upgraded.archive11).toEqual(legacy);
  expect(upgraded.archive12).toMatchObject({
    sessionSchemaVersion: '1.2.0',
    parentRevisionId: (currentBefore as InterviewSession).revisionId,
    packSnapshot: { ruleSemanticsVersion: 'condition-equals-v1' },
  });
  expect((upgraded.active as SemanticInterviewSession).parentRevisionId).toBe((upgraded.archive12 as InterviewSession).revisionId);
  expect(await validateSemanticSessionRecord(upgraded.active)).toEqual(upgraded.active);
  const download = page.waitForEvent('download');
  await page.locator('[data-recovery-id="synthetic-future-mixed"]').click();
  const recoveryDownload = await download;
  expect(recoveryDownload.suggestedFilename()).toBe('interview-facilitator-recovery-backup.json');
  const recoveryStream = await recoveryDownload.createReadStream();
  if (!recoveryStream) throw new Error('Recovery download stream was unavailable.');
  recoveryStream.setEncoding('utf8');
  let recoveryJson = '';
  for await (const chunk of recoveryStream) recoveryJson += chunk;
  const recoveryBackup = JSON.parse(recoveryJson) as { backupType: string; formatVersion: string; record: unknown };
  expect(recoveryBackup).toMatchObject({ backupType: 'interview-facilitator-recovery-internal', formatVersion: '1' });
  expect(recoveryBackup.record).toEqual(unsupported);

  const malformedDownload = page.waitForEvent('download');
  await page.locator('[data-recovery-id="synthetic-malformed-mixed"]').click();
  const quarantinedDownload = await malformedDownload;
  const quarantinedStream = await quarantinedDownload.createReadStream();
  if (!quarantinedStream) throw new Error('Quarantined recovery stream was unavailable.');
  quarantinedStream.setEncoding('utf8');
  let quarantinedJson = '';
  for await (const chunk of quarantinedStream) quarantinedJson += chunk;
  const quarantinedBackup = JSON.parse(quarantinedJson) as { record: unknown };
  expect(quarantinedBackup.record).toEqual(malformed);

  const snapshot = await readStorageSnapshot(page);
  expect(snapshot.rows).toHaveLength(5);
  expect(snapshot.archives).toHaveLength(2);
  expect(snapshot.archiveKeys).toEqual([
    'synthetic-legacy-mixed|1.1.0|pinned-1.1-to-1.2',
    'synthetic-legacy-mixed|1.2.0|pinned-1.2-to-1.3',
  ]);
  expect(snapshot.rows).toContainEqual(current);
  expect(snapshot.rows).toContainEqual(unsupported);
  expect(snapshot.rows).toContainEqual(malformed);
  expect(snapshot.rows).toContainEqual(unsafeMalformed);
  expect(snapshot.rows).toContainEqual(upgraded.active);
  expect(snapshot.archives).toContainEqual(legacy);
  expect(snapshot.archives).toContainEqual(upgraded.archive12);

  const healthyCurrentCard = page.locator('[data-session-id="synthetic-current-mixed"]');
  await expect(healthyCurrentCard).toBeVisible();
  await healthyCurrentCard.click();
  await expect(page.getByRole('heading', { name: 'What is already in place today?' })).toBeVisible();
  await page.goto('/');
  await expect(upgradedCard).toBeVisible();
  await upgradedCard.click();
  await expect(page.getByRole('heading', { name: 'What is already in place today?' })).toBeVisible();
});

test('failed legacy upgrade aborts its transaction and preserves source and archive', async ({ page }) => {
  await page.goto('/');
  const legacy = await syntheticPinned12Session({ sessionId: 'synthetic-legacy-abort' });
  legacy.sessionSchemaVersion = '1.1.0';
  delete legacy.packSnapshot.ruleSemanticsVersion;
  legacy.packIdentity.digest = await sha256Hex(canonicalizeJson(legacy.packSnapshot));
  await putRawSession(page, legacy);
  await page.reload();
  await expect(page.getByText('Older interview format')).toBeVisible();

  await page.evaluate((sessionId) => {
    const state = window as Window & { __legacyMigrationAbortObserved?: boolean };
    state.__legacyMigrationAbortObserved = false;
    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      const [value] = args;
      if (this.name === 'sessions' && value && typeof value === 'object' && (value as { sessionId?: string }).sessionId === sessionId) {
        throw new DOMException('Synthetic legacy-upgrade put failure.', 'DataError');
      }
      return originalPut.apply(this, args);
    };
    const originalAbort = IDBTransaction.prototype.abort;
    IDBTransaction.prototype.abort = function () {
      this.addEventListener('abort', () => { state.__legacyMigrationAbortObserved = true; }, { once: true });
      return originalAbort.call(this);
    };
  }, legacy.sessionId);

  await page.getByRole('button', { name: 'Upgrade' }).click();
  await expect(page.getByText(/^Upgrade did not complete\..*The original interview and any prior recovery record were preserved\.$/)).toBeVisible();
  await expect(page.getByText('Older interview format')).toBeVisible();
  expect(await page.evaluate(() => (window as Window & { __legacyMigrationAbortObserved?: boolean }).__legacyMigrationAbortObserved)).toBe(true);

  const snapshot = await readStorageSnapshot(page);
  expect(snapshot.rows).toEqual([legacy]);
  expect(snapshot.archives).toEqual([]);
  expect(snapshot.archiveKeys).toEqual([]);
});

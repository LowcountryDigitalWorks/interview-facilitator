import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Download, type Page } from '@playwright/test';
import type { InterviewSession } from '../../src/domain';
import { canonicalizeJson, sha256Hex } from '../../src/pack-identity';
import { validateSemanticSessionRecord, type SemanticInterviewSession } from '../../src/semantic-session';
import { migrateSemantic13ToKnownFact14 } from '../../src/known-fact-session';
import { syntheticPinned12Session, syntheticSemanticSession } from './synthetic-session';

async function readDownloadJson(download: Download): Promise<unknown> {
  const stream = await download.createReadStream();
  if (!stream) throw new Error('Download stream unavailable.');
  const decoder = new TextDecoder();
  let text = '';
  for await (const chunk of stream) text += decoder.decode(chunk as Uint8Array, { stream: true });
  text += decoder.decode();
  return JSON.parse(text) as unknown;
}

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

test('validated 1.4 local interview is read-only and exports full canonical evidence without modifying storage', async ({ page }) => {
  const source14 = await migrateSemantic13ToKnownFact14(await syntheticSession('synthetic-readonly-14'));
  await page.goto('/');
  await putRawSession(page, source14);
  await page.reload();

  await expect(page.getByText('Synthetic Browser Test — 1.4 interview (read-only)')).toBeVisible();
  await expect(page.getByText('No saved interviews yet.')).toHaveCount(0);
  await expect(page.locator('[data-session-id="synthetic-readonly-14"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'New interview' })).toBeEnabled();

  const downloadStarted = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export full 1.4 JSON backup' }).click();
  const artifact = await downloadStarted;
  expect(artifact.suggestedFilename()).toContain('-1.4-backup.json');
  expect(await artifact.failure()).toBeNull();
  const exported = await readDownloadJson(artifact) as unknown;
  expect(exported).toEqual(source14);
  expect((exported as typeof source14).knownFactLedger).toEqual(source14.knownFactLedger);

  const stored = await readStorageSnapshot(page);
  expect(stored.rows).toEqual([source14]);
  expect(stored.archives).toEqual([]);
});


test('1.4 home warning is explicit about this build not restoring a 1.4 JSON backup', async ({ page }) => {
  const source14 = await migrateSemantic13ToKnownFact14(await syntheticSession('synthetic-warning-14'));
  await page.goto('/');
  await putRawSession(page, source14);
  await page.reload();
  await expect(page.getByText('Editing and importing 1.4 JSON are not supported in this build.', { exact: false })).toBeVisible();
  await expect(page.getByText('this build cannot restore that backup', { exact: false })).toBeVisible();
  expect((await readStorageSnapshot(page)).rows).toEqual([source14]);
});

test('1.4 export refuses a stale deleted row and explains disappearance without mutating storage', async ({ page }) => {
  const source14 = await migrateSemantic13ToKnownFact14(await syntheticSession('synthetic-disappeared-14'));
  await page.goto('/');
  await putRawSession(page, source14);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Export full 1.4 JSON backup' })).toBeVisible();
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('ldw-interview-facilitator', 4);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('sessions', 'readwrite');
      tx.objectStore('sessions').delete('synthetic-disappeared-14');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    db.close();
  });
  await page.getByRole('button', { name: 'Export full 1.4 JSON backup' }).click();
  await expect(page.getByText('This 1.4 interview is no longer on this device', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export full 1.4 JSON backup' })).toHaveCount(0);
  expect((await readStorageSnapshot(page)).rows).toEqual([]);
});

test('hostile 1.4 client labels are rendered as text and downloaded under a sanitized filename', async ({ page }) => {
  const source14 = await migrateSemantic13ToKnownFact14(await syntheticSession('synthetic-hostile-label-14'));
  source14.clientLabel = '<img src=x onerror=alert(1)>';
  await page.goto('/');
  await putRawSession(page, source14);
  await page.reload();
  await expect(page.getByText('<img src=x onerror=alert(1)> — 1.4 interview (read-only)')).toBeVisible();
  await expect(page.locator('.session-list img')).toHaveCount(0);
  const started = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export full 1.4 JSON backup' }).click();
  const artifact = await started;
  expect(artifact.suggestedFilename()).toMatch(/^[a-z0-9-]+-1\.4-backup\.json$/);
  expect(artifact.suggestedFilename()).not.toContain('<');
  expect(await readDownloadJson(artifact)).toEqual(source14);
  expect((await readStorageSnapshot(page)).rows).toEqual([source14]);
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

test('Read-back Change returns to the originating row and preserves Presentation disclosure boundary', async ({ page }) => {
  await page.goto('/');
  const row = await syntheticSession('synthetic-change-return-presentation');
  row.currentQuestionId = 'must-have';
  row.answers['existing-presence'] = {
    value: 'Previously agreed synthetic detail', resolution: 'captured', source: 'client-statement',
    needsConfirmation: false, confirmation: null, followUp: null, note: 'private question note',
  };
  row.runningNotes = 'private running note';
  await putRawSession(page, row);
  await page.reload();
  await page.getByRole('button', { name: /Synthetic Browser Test/ }).click();
  await page.getByRole('button', { name: 'Presentation view' }).click();
  await page.getByRole('button', { name: 'Review interview' }).click();

  const change = page.getByRole('button', { name: 'Change What is already in place today?' });
  await change.click();
  await expect(page.getByRole('heading', { name: 'What is already in place today?', level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Exit presentation' })).toBeVisible();
  await expect(page.locator('.context-rail')).toHaveCount(0);
  await expect(page.getByText('private question note')).toHaveCount(0);
  await page.locator('#answer').fill('Updated public synthetic detail');

  await page.getByRole('button', { name: 'Return to Read-back' }).click();
  await expect(change).toBeFocused();
  await expect(page.locator('.summary-row', { hasText: 'What is already in place today?' }))
    .toContainText('Updated public synthetic detail');
  await expect(page.getByRole('button', { name: 'Exit presentation' })).toBeVisible();
  await expect(page.locator('.context-rail')).toHaveCount(0);
  await expect(page.getByText('private question note')).toHaveCount(0);
  await expect(page.getByText('private running note')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Export full JSON backup' })).toHaveCount(0);
});

test('Change and Return to Read-back work on a 320px phone without stale return controls', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await startFreshInterview(page, 'Synthetic Phone Read-back');
  await advanceToQuestion(page, 'What absolutely has to be true for the first version to feel successful?');
  await page.getByRole('button', { name: 'Review interview' }).click();
  await page.getByRole('button', { name: 'Exit presentation' }).click();
  const change = page.getByRole('button', { name: 'Change What is already in place today?' });
  await change.click();

  const returnButton = page.getByRole('button', { name: 'Return to Read-back' });
  await expect(returnButton).toBeVisible();
  await page.locator('#answer').fill('Synthetic mobile correction');
  await returnButton.click();
  await expect(change).toBeFocused();
  await expect(page.locator('.summary-row', { hasText: 'What is already in place today?' }))
    .toContainText('Synthetic mobile correction');
  const viewport = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.clientWidth + 1);

  await page.getByRole('button', { name: 'Return to interview' }).click();
  await expect(page.getByRole('button', { name: 'Return to Read-back' })).toHaveCount(0);
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

test('pending conditional evidence is read back as Open rather than Current', async ({ page }) => {
  await page.goto('/');
  const row = await syntheticSession('synthetic-pending-readback');
  row.currentQuestionId = 'must-have';
  row.answers['needs-booking'] = {
    value: 'Yes', resolution: 'not-applicable', source: 'client-statement', needsConfirmation: false,
    confirmation: null, followUp: null, note: '',
  };
  row.answers['booking-process'] = {
    value: 'Retained pending booking detail', resolution: 'captured', source: 'client-statement', needsConfirmation: false,
    confirmation: null, followUp: null, note: '',
  };
  await putRawSession(page, row);
  await page.reload();

  await page.getByRole('button', { name: /Synthetic Browser Test/ }).click();
  await page.getByRole('button', { name: 'Presentation view' }).click();
  await page.getByRole('button', { name: 'Review interview' }).click();

  const presentationRow = page.locator('.summary-row', { hasText: 'How should booking or scheduling work?' });
  await expect(presentationRow).toContainText('Retained pending booking detail');
  await expect(presentationRow.locator('small')).toHaveText('Open');
  await expect(presentationRow.locator('small')).not.toHaveText('Current');

  await page.getByRole('button', { name: 'Exit presentation' }).click();
  const privateRow = page.locator('.summary-row', { hasText: 'How should booking or scheduling work?' });
  await expect(privateRow.locator('small')).toHaveText('Open');
});

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

test('render boundary preflight retains answer node, focus and caret during synthetic IME input and autosave', async ({ page }) => {
  await startFreshInterview(page, 'Synthetic IME Boundary');
  const answer = page.locator('#answer');
  await answer.fill('abcdefghij');
  await answer.focus();
  await answer.evaluate((element) => {
    const field = element as HTMLTextAreaElement;
    (window as Window & { __ldw36Answer?: HTMLTextAreaElement }).__ldw36Answer = field;
    field.setSelectionRange(2, 7);
    // Synthetic composition events test the DOM render boundary, not physical keyboard IME compatibility.
    field.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: 'あ' }));
    field.dispatchEvent(new InputEvent('input', {
      bubbles: true, inputType: 'insertCompositionText', data: 'あ', isComposing: true,
    }));
  });

  await expect(page.locator('[data-save-indicator]')).toContainText(/Saved/, { timeout: 5000 });
  const snapshot = await page.evaluate(() => {
    const original = (window as Window & { __ldw36Answer?: HTMLTextAreaElement }).__ldw36Answer;
    const current = document.querySelector<HTMLTextAreaElement>('#answer');
    return {
      sameNode: original === current,
      connected: original?.isConnected ?? false,
      focused: document.activeElement === current,
      value: current?.value,
      selectionStart: current?.selectionStart,
      selectionEnd: current?.selectionEnd,
    };
  });
  expect(snapshot).toEqual({
    sameNode: true, connected: true, focused: true,
    value: 'abcdefghij', selectionStart: 2, selectionEnd: 7,
  });
  await answer.evaluate((element) => {
    element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'あ' }));
  });
  await expect(answer).toBeFocused();
});

test('render boundary preflight preserves capture and context nodes across status and note updates', async ({ page }) => {
  await startFreshInterview(page, 'Synthetic Context Boundary');
  const answer = page.locator('#answer');
  const runningNotes = page.locator('#running-notes');
  await answer.fill('Existing synthetic context');
  await answer.evaluate((element) => {
    const field = element as HTMLTextAreaElement;
    field.setSelectionRange(4, 9);
    (window as Window & { __ldw36Answer?: HTMLTextAreaElement }).__ldw36Answer = field;
  });
  await runningNotes.evaluate((element) => {
    (window as Window & { __ldw36Running?: HTMLTextAreaElement }).__ldw36Running = element as HTMLTextAreaElement;
  });

  await page.locator('label.status-chip', { hasText: 'N/A' }).click();
  await expect(page.locator('[data-coverage-resolved]')).toContainText('1 N/A');
  await page.locator('#question-note').fill('Synthetic private question note');
  await runningNotes.fill('Synthetic private running note');
  await expect(page.locator('[data-save-indicator]')).toContainText(/Saved/, { timeout: 5000 });

  const snapshot = await page.evaluate(() => {
    const windowRefs = window as Window & {
      __ldw36Answer?: HTMLTextAreaElement;
      __ldw36Running?: HTMLTextAreaElement;
    };
    const currentAnswer = document.querySelector<HTMLTextAreaElement>('#answer');
    const currentRunning = document.querySelector<HTMLTextAreaElement>('#running-notes');
    return {
      sameAnswer: windowRefs.__ldw36Answer === currentAnswer,
      sameRunning: windowRefs.__ldw36Running === currentRunning,
      focusedRunning: document.activeElement === currentRunning,
      answerValue: currentAnswer?.value,
      answerSelectionStart: currentAnswer?.selectionStart,
      answerSelectionEnd: currentAnswer?.selectionEnd,
      questionNote: document.querySelector<HTMLTextAreaElement>('#question-note')?.value,
      runningNote: currentRunning?.value,
    };
  });
  expect(snapshot).toEqual({
    sameAnswer: true, sameRunning: true, focusedRunning: true,
    answerValue: 'Existing synthetic context', answerSelectionStart: 4, answerSelectionEnd: 9,
    questionNote: 'Synthetic private question note', runningNote: 'Synthetic private running note',
  });
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

  await advanceToQuestion(page, 'What absolutely has to be true for the first version to feel successful?');
  await page.getByRole('button', { name: 'Review interview' }).click();
  await page.getByRole('button', { name: 'Exit presentation' }).click();
  await expect(page.locator('.review-stats')).toContainText('0 current');
  await expect(page.locator('.review-stats')).toContainText('1 N/A');
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

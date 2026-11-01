import { Buffer } from 'node:buffer';
import { expect, test, type Page } from '@playwright/test';
import type { InterviewSession } from '../../src/domain';

const DB_NAME = 'ldw-interview-facilitator';
const STORE = 'sessions';

type FaultOptions = {
  failOpen?: boolean;
  failPut?: boolean;
  debounceMs?: number | null;
};

type FaultState = {
  failOpen: boolean;
  failPut: boolean;
  debounceMs: number | null;
};

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

async function installFaultHooks(page: Page, options: FaultOptions = {}): Promise<void> {
  await page.addInitScript(({ failOpen, failPut, debounceMs }) => {
    const state = {
      failOpen: Boolean(failOpen),
      failPut: Boolean(failPut),
      debounceMs: debounceMs ?? null,
    };
    (window as typeof window & { __ldwFault?: typeof state }).__ldwFault = state;

    const originalOpen = IDBFactory.prototype.open;
    IDBFactory.prototype.open = function (...args: Parameters<IDBFactory['open']>): IDBOpenDBRequest {
      if (state.failOpen) throw new Error('Synthetic IndexedDB open failure');
      return Reflect.apply(originalOpen, this, args) as IDBOpenDBRequest;
    };

    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore['put']>): IDBRequest<IDBValidKey> {
      if (state.failPut) throw new DOMException('Synthetic IndexedDB write failure', 'QuotaExceededError');
      return Reflect.apply(originalPut, this, args) as IDBRequest<IDBValidKey>;
    };

    const originalSetTimeout = window.setTimeout.bind(window);
    window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: any[]) => {
      const effective = timeout === 180 && state.debounceMs !== null ? state.debounceMs : timeout;
      return originalSetTimeout(handler, effective, ...args);
    }) as typeof window.setTimeout;
  }, {
    failOpen: options.failOpen ?? false,
    failPut: options.failPut ?? false,
    debounceMs: options.debounceMs ?? null,
  });
}

async function setFaultState(page: Page, update: Partial<FaultState>): Promise<void> {
  await page.evaluate((next) => {
    const state = (window as typeof window & { __ldwFault?: FaultState }).__ldwFault;
    if (!state) throw new Error('Synthetic fault hooks are not installed.');
    Object.assign(state, next);
  }, update);
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

async function readRawSessions(page: Page): Promise<unknown[]> {
  return page.evaluate(async ({ dbName, store }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(dbName, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(store)) request.result.createObjectStore(store, { keyPath: 'sessionId' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<unknown[]>((resolve, reject) => {
        const request = db.transaction(store, 'readonly').objectStore(store).getAll();
        request.onsuccess = () => resolve(request.result as unknown[]);
        request.onerror = () => reject(request.error);
      });
    } finally {
      db.close();
    }
  }, { dbName: DB_NAME, store: STORE });
}

function syntheticSession(sessionId: string, clientLabel: string): InterviewSession {
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

async function startFreshInterview(page: Page, label: string): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'New interview' }).click();
  await page.getByLabel('Project or client label').fill(label);
  await page.getByRole('button', { name: 'Start interview' }).click();
  await expect(page.getByRole('heading', { name: 'What is already in place today?' })).toBeVisible();
}

async function goHomeWithActiveSession(page: Page): Promise<void> {
  await page.locator('[data-question-id="must-have"]').click();
  await page.getByRole('button', { name: 'Review interview' }).click();
  await page.getByRole('button', { name: 'Home' }).click();
  await expect(page.getByRole('heading', { name: 'Recent interviews' })).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await clearLocalState(page);
});

test('global IndexedDB open failure is not rendered as an empty database and Retry recovers', async ({ page }) => {
  await installFaultHooks(page, { failOpen: true });
  await page.reload();

  await expect(page.getByText('Local interviews could not be read.')).toBeVisible();
  await expect(page.getByText('Storage unavailable')).toBeVisible();
  await expect(page.getByText('No saved interviews yet.')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'New interview' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Import session JSON' })).toBeDisabled();

  await setFaultState(page, { failOpen: false });
  await page.getByRole('button', { name: 'Retry local storage' }).click();

  await expect(page.getByText('No saved interviews yet.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'New interview' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Import session JSON' })).toBeEnabled();
});

test('failed outgoing save blocks switching and recovery stays available until a durable retry succeeds', async ({ page }) => {
  await installFaultHooks(page, { debounceMs: 5_000 });
  await page.reload();
  await putRawSession(page, syntheticSession('synthetic-session-b', 'Synthetic Session B'));
  await page.reload();

  await page.getByRole('button', { name: 'New interview' }).click();
  await page.getByLabel('Project or client label').fill('Synthetic Dirty A');
  await page.getByRole('button', { name: 'Start interview' }).click();
  await page.locator('#answer').fill('Dirty A latest answer');
  await goHomeWithActiveSession(page);

  await setFaultState(page, { failPut: true });
  await page.getByRole('button', { name: /Synthetic Session B/ }).click();

  await expect(page.getByRole('alert').filter({ hasText: 'Local save failed.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Return to active interview' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export active backup' })).toBeVisible();
  await expect(page.getByText('Synthetic Session B', { exact: true })).not.toBeVisible();

  await setFaultState(page, { failPut: false, debounceMs: 50 });
  await page.getByRole('button', { name: 'Return to active interview' }).click();
  await page.locator('[data-question-id="existing-presence"]').click();
  await expect(page.locator('#answer')).toHaveValue('Dirty A latest answer');
  await expect(page.locator('[data-save-indicator]')).toContainText('Local save failed');

  await page.locator('#running-notes').fill('Recovered durable write');
  await expect(page.locator('[data-save-indicator]')).toContainText('Saved', { timeout: 2_000 });

  const rows = await readRawSessions(page);
  const saved = rows.find((row) => (row as InterviewSession).clientLabel === 'Synthetic Dirty A') as InterviewSession | undefined;
  expect(saved?.answers['existing-presence']?.value).toBe('Dirty A latest answer');
  expect(saved?.runningNotes).toBe('Recovered durable write');
});

test('same-ID import write failure leaves dirty active state recoverable and does not overwrite stored data', async ({ page }) => {
  await installFaultHooks(page, { debounceMs: 5_000 });
  await page.reload();

  const stored = syntheticSession('synthetic-import-same-id', 'Synthetic Import Original');
  stored.answers['existing-presence'] = { value: 'Stored original answer', status: 'ANSWERED', note: '' };
  await putRawSession(page, stored);
  await page.reload();
  await page.getByRole('button', { name: /Synthetic Import Original/ }).click();
  await page.locator('#answer').fill('Dirty in-memory answer');
  await goHomeWithActiveSession(page);

  const imported = structuredClone(stored);
  imported.clientLabel = 'Synthetic Imported Replacement';
  imported.answers['existing-presence'] = { value: 'Imported replacement answer', status: 'ANSWERED', note: '' };

  await setFaultState(page, { failPut: true });
  await page.locator('#import-file').setInputFiles({
    name: 'synthetic-import.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(imported)),
  });

  await expect(page.getByRole('alert').filter({ hasText: 'Local save failed.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Return to active interview' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export active backup' })).toBeVisible();

  let rows = await readRawSessions(page);
  let row = rows.find((candidate) => (candidate as InterviewSession).sessionId === stored.sessionId) as InterviewSession | undefined;
  expect(row?.clientLabel).toBe('Synthetic Import Original');
  expect(row?.answers['existing-presence']?.value).toBe('Stored original answer');

  await setFaultState(page, { failPut: false, debounceMs: 50 });
  await page.getByRole('button', { name: 'Return to active interview' }).click();
  await expect(page.locator('#answer')).toHaveValue('Dirty in-memory answer');
  await page.locator('#answer').fill('Dirty in-memory answer recovered');
  await expect(page.locator('[data-save-indicator]')).toContainText('Saved', { timeout: 2_000 });

  rows = await readRawSessions(page);
  row = rows.find((candidate) => (candidate as InterviewSession).sessionId === stored.sessionId) as InterviewSession | undefined;
  expect(row?.clientLabel).toBe('Synthetic Import Original');
  expect(row?.answers['existing-presence']?.value).toBe('Dirty in-memory answer recovered');
});

test('delete cancels a pending autosave so the removed session cannot resurrect', async ({ page }) => {
  await installFaultHooks(page, { debounceMs: 500 });
  await page.reload();
  await startFreshInterview(page, 'Synthetic Delete Race');
  await page.locator('#answer').fill('Pending edit that must not resurrect');
  await page.locator('[data-question-id="must-have"]').click();
  await page.getByRole('button', { name: 'Review interview' }).click();

  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: 'Delete local session' }).click();
  await expect(page.getByText('No saved interviews yet.')).toBeVisible();

  await page.waitForTimeout(700);
  const rows = await readRawSessions(page);
  expect(rows.some((row) => (row as InterviewSession).clientLabel === 'Synthetic Delete Race')).toBe(false);
});

test('pagehide triggers a best-effort flush before the delayed debounce would otherwise run', async ({ page }) => {
  await installFaultHooks(page, { debounceMs: 10_000 });
  await page.reload();
  await startFreshInterview(page, 'Synthetic Pagehide Flush');
  await page.locator('#answer').fill('Latest pagehide-protected edit');

  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));

  await expect.poll(async () => {
    const rows = await readRawSessions(page);
    const row = rows.find((candidate) => (candidate as InterviewSession).clientLabel === 'Synthetic Pagehide Flush') as InterviewSession | undefined;
    return row?.answers['existing-presence']?.value ?? null;
  }, { timeout: 2_000, intervals: [25, 50, 100] }).toBe('Latest pagehide-protected edit');
});

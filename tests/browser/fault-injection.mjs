/** @typedef {import('@playwright/test').Page} Page */

export const DB_NAME = 'ldw-interview-facilitator';
export const STORE = 'sessions';

/**
 * Install deterministic IndexedDB fault hooks before app scripts run.
 * @param {Page} page
 */
export async function installIdbFaultInjection(page) {
  await page.addInitScript(({ dbName, store }) => {
    const persistKey = 'ldw-idb-fault-flags';
    const readPersisted = () => {
      try {
        const raw = sessionStorage.getItem(persistKey);
        return raw ? JSON.parse(raw) : {};
      } catch {
        return {};
      }
    };
    const state = {
      blockOpen: false,
      blockWrite: false,
      blockRead: false,
      ...readPersisted(),
    };
    window.__ldwIdbFault = state;
    window.__ldwIdbFaultPersist = (patch) => {
      Object.assign(state, patch);
      sessionStorage.setItem(persistKey, JSON.stringify({
        blockOpen: state.blockOpen,
        blockWrite: state.blockWrite,
        blockRead: state.blockRead,
      }));
    };

    const factory = indexedDB;
    const nativeOpen = factory.open.bind(factory);
    const nativeProtoTransaction = IDBDatabase.prototype.transaction;

    function patchDatabase(db, faultState) {
      if (db.__ldwWritePatchApplied) return;
      db.__ldwWritePatchApplied = true;
      const nativeTransaction = nativeProtoTransaction.bind(db);
      db.__ldwPatchedTransaction = (storeNames, mode, options) => {
        const tx = nativeTransaction(storeNames, mode, options);
        const nativeObjectStore = tx.objectStore.bind(tx);
        tx.objectStore = (storeName) => {
          const objectStore = nativeObjectStore(storeName);
          if (storeName !== store) return objectStore;

          if (faultState.blockWrite && mode === 'readwrite') {
            const nativePut = objectStore.put.bind(objectStore);
            const nativeDelete = objectStore.delete.bind(objectStore);
            objectStore.put = (...args) => {
              const request = nativePut(...args);
              try {
                tx.abort();
              } catch {
                // ignore
              }
              return request;
            };
            objectStore.delete = (...args) => {
              const request = nativeDelete(...args);
              try {
                tx.abort();
              } catch {
                // ignore
              }
              return request;
            };
            return objectStore;
          }

          if (faultState.blockRead && mode === 'readonly') {
            const nativeGetAll = objectStore.getAll.bind(objectStore);
            objectStore.getAll = (...args) => {
              const request = nativeGetAll(...args);
              try {
                tx.abort();
              } catch {
                // ignore
              }
              return request;
            };
          }

          return objectStore;
        };
        return tx;
      };
    }

    IDBDatabase.prototype.transaction = function (...args) {
      if (this.name === dbName) patchDatabase(this, state);
      if (this.__ldwPatchedTransaction) return this.__ldwPatchedTransaction(...args);
      return nativeProtoTransaction.apply(this, args);
    };

    factory.open = (name, version) => {
      if (state.blockOpen && name === dbName) {
        let onerrorHandler = null;
        const request = {
          result: undefined,
          error: new DOMException('Forced IndexedDB open failure', 'UnknownError'),
          onsuccess: null,
          set onerror(handler) {
            onerrorHandler = handler;
          },
          get onerror() {
            return onerrorHandler;
          },
          onupgradeneeded: null,
          addEventListener() {},
          removeEventListener() {},
          dispatchEvent() {
            return true;
          },
        };
        queueMicrotask(() => {
          if (typeof request.onerror === 'function') {
            request.onerror(new Event('error'));
          }
        });
        return request;
      }

      const request = nativeOpen(name, version);
      if (name !== dbName) return request;

      request.addEventListener('success', () => {
        patchDatabase(request.result, state);
      }, { capture: true });

      return request;
    };
  }, { dbName: DB_NAME, store: STORE });
}

/** @param {Page} page @param {Partial<{ blockOpen: boolean, blockWrite: boolean, blockRead: boolean }>} patch */
export async function setIdbFault(page, patch) {
  await page.evaluate((next) => {
    if (typeof window.__ldwIdbFaultPersist === 'function') {
      window.__ldwIdbFaultPersist(next);
      return;
    }
    Object.assign(window.__ldwIdbFault, next);
  }, patch);
}

/** @param {Page} page */
export async function clearLocalState(page) {
  await page.goto('/');
  await page.evaluate(async ({ dbName }) => {
    sessionStorage.removeItem('ldw-idb-fault-flags');
    if (typeof window.__ldwIdbFaultPersist === 'function') {
      window.__ldwIdbFaultPersist({ blockOpen: false, blockWrite: false, blockRead: false });
    }
    await new Promise((resolve) => {
      const request = indexedDB.deleteDatabase(dbName);
      request.onsuccess = () => resolve(undefined);
      request.onerror = () => resolve(undefined);
      request.onblocked = () => resolve(undefined);
    });
  }, { dbName: DB_NAME });
}

/** @param {Page} page @param {unknown} row */
export async function putRawSession(page, row) {
  await page.evaluate(async ({ dbName, store, row: value }) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(store)) {
          request.result.createObjectStore(store, { keyPath: 'sessionId' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).put(value);
      tx.oncomplete = () => resolve(undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    db.close();
  }, { dbName: DB_NAME, store: STORE, row });
}

/** @param {Page} page */
export async function listStoredSessionIds(page) {
  return page.evaluate(async ({ dbName, store }) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(store)) {
          request.result.createObjectStore(store, { keyPath: 'sessionId' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const rows = await new Promise((resolve, reject) => {
      const request = db.transaction(store, 'readonly').objectStore(store).getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return rows.map((row) => row.sessionId);
  }, { dbName: DB_NAME, store: STORE });
}

/** @param {Page} page @param {string} sessionId */
export async function readStoredAnswer(page, sessionId) {
  return page.evaluate(async ({ dbName, store, sessionId: id }) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName, 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const row = await new Promise((resolve, reject) => {
      const request = db.transaction(store, 'readonly').objectStore(store).get(id);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return row?.answers?.['existing-presence']?.value ?? null;
  }, { dbName: DB_NAME, store: STORE, sessionId });
}

/** @param {Page} page */
export async function startFreshInterview(page, clientLabel = 'Synthetic Fault Test') {
  await page.goto('/');
  await page.getByRole('button', { name: 'New interview' }).click();
  await page.getByLabel('Project or client label').fill(clientLabel);
  await page.getByRole('button', { name: 'Start interview' }).click();
  await page.locator('#answer').waitFor({ state: 'visible', timeout: 15_000 });
}

/** @param {Page} page @param {string} clientLabel */
export async function openSeededInterviewOnLastQuestion(page, clientLabel) {
  await putRawSession(page, {
    sessionSchemaVersion: '1.0.0',
    sessionId: `seed-${clientLabel.replace(/\s+/g, '-').toLowerCase()}`,
    interviewPackId: 'general-discovery',
    interviewPackVersion: '1.0.0',
    clientLabel,
    interviewerLabel: 'Test Operator',
    interviewMode: 'Conversation',
    createdAt: '2026-10-31T20:00:00.000Z',
    updatedAt: '2026-10-31T20:00:00.000Z',
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
  });
  await page.reload();
  await page.getByRole('button', { name: new RegExp(clientLabel) }).click();
}

/** @param {Page} page */
export async function openPrivateReview(page) {
  for (let step = 0; step < 24; step += 1) {
    const review = page.getByRole('button', { name: 'Review interview' });
    if (await review.isVisible()) {
      await review.click();
      const exitPresentation = page.getByRole('button', { name: 'Exit presentation' });
      if (await exitPresentation.isVisible()) {
        await exitPresentation.click();
      }
      await page.getByRole('button', { name: 'Delete local session' }).waitFor({ state: 'visible', timeout: 10_000 });
      return;
    }
    const next = page.locator('[data-action="next"]');
    if (!(await next.isVisible())) break;
    await next.click();
  }
  throw new Error('Could not reach private review.');
}

/** @param {Page} page */
export async function navigateHomeKeepingActiveSession(page) {
  await openPrivateReview(page);
  await page.getByRole('button', { name: 'Home' }).click();
}

/** @param {Page} page */
export async function startNewInterviewWhileActive(page, clientLabel = 'Replacement Active Session') {
  await page.getByRole('button', { name: 'New interview' }).click();
  await page.getByLabel('Project or client label').fill(clientLabel);
  await page.getByRole('button', { name: 'Start interview' }).click();
}

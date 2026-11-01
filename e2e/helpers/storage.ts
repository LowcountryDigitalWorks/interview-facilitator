import type { InterviewSession } from '../../src/domain';
import { createSession } from '../../src/domain';
import { generalDiscoveryPack as pack } from '../../src/pack';

export const INDEXED_DB_NAME = 'ldw-interview-facilitator';
export const INDEXED_DB_STORE = 'sessions';
export const SHELL_CACHE_NAME = 'interview-facilitator-shell-v2';

export function buildSyntheticSession(clientLabel: string, at = new Date('2026-10-31T12:00:00.000Z')): InterviewSession {
  return createSession(pack, { clientLabel }, at);
}

export function buildMalformedSessionRow(): Record<string, string> {
  return {
    sessionId: 'acceptance-malformed-row',
    sessionSchemaVersion: '9.9.9',
    updatedAt: '2026-10-31T12:00:00.000Z',
  };
}

export async function clearLocalAppStorage(page: import('@playwright/test').Page): Promise<void> {
  await resetAndSeedIndexedDb(page, []);
}

export async function resetAndSeedIndexedDb(page: import('@playwright/test').Page, rows: unknown[]): Promise<void> {
  await page.goto('/');
  await page.evaluate(
    async ({ dbName, store, serializedRows }) => {
      const seedRows: unknown[] = serializedRows ? JSON.parse(serializedRows) : [];
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(dbName);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error ?? new Error('Unable to delete IndexedDB.'));
        request.onblocked = () => resolve();
      });
      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(keys.filter((key) => key.startsWith('interview-facilitator-shell')).map((key) => caches.delete(key)));
      }
      if (!seedRows.length) return;
      await new Promise<void>((resolve, reject) => {
        const open = indexedDB.open(dbName, 1);
        open.onupgradeneeded = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains(store)) {
            db.createObjectStore(store, { keyPath: 'sessionId' });
          }
        };
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction(store, 'readwrite');
          const objectStore = tx.objectStore(store);
          for (const row of seedRows) objectStore.put(row);
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error ?? new Error('Unable to seed IndexedDB.'));
        };
        open.onerror = () => reject(open.error ?? new Error('Unable to open IndexedDB.'));
      });
    },
    { dbName: INDEXED_DB_NAME, store: INDEXED_DB_STORE, serializedRows: rows.length ? JSON.stringify(rows) : '' },
  );
  await page.goto('/');
  await page.getByText('Interview Facilitator').waitFor({ state: 'visible', timeout: 15_000 });
}

export async function appendIndexedDbRows(page: import('@playwright/test').Page, rows: unknown[]): Promise<void> {
  await page.evaluate(
    async ({ dbName, store, serializedRows }) => {
      const seedRows: unknown[] = JSON.parse(serializedRows);
      await new Promise<void>((resolve, reject) => {
        const open = indexedDB.open(dbName, 1);
        open.onupgradeneeded = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains(store)) {
            db.createObjectStore(store, { keyPath: 'sessionId' });
          }
        };
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction(store, 'readwrite');
          const objectStore = tx.objectStore(store);
          for (const row of seedRows) objectStore.put(row);
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error ?? new Error('Unable to append IndexedDB rows.'));
        };
        open.onerror = () => reject(open.error ?? new Error('Unable to open IndexedDB.'));
      });
    },
    { dbName: INDEXED_DB_NAME, store: INDEXED_DB_STORE, serializedRows: JSON.stringify(rows) },
  );
}

export async function seedIndexedDbRows(page: import('@playwright/test').Page, rows: unknown[]): Promise<void> {
  await resetAndSeedIndexedDb(page, rows);
}

export async function readIndexedDbRowCount(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(
    async ({ dbName, store }) =>
      new Promise<number>((resolve, reject) => {
        const open = indexedDB.open(dbName, 1);
        open.onsuccess = () => {
          const db = open.result;
          const request = db.transaction(store, 'readonly').objectStore(store).getAll();
          request.onsuccess = () => {
            db.close();
            resolve((request.result as unknown[]).length);
          };
          request.onerror = () => reject(request.error ?? new Error('Unable to read IndexedDB rows.'));
        };
        open.onerror = () => reject(open.error ?? new Error('Unable to open IndexedDB.'));
      }),
    { dbName: INDEXED_DB_NAME, store: INDEXED_DB_STORE },
  );
}

export async function waitForOfflineShellReady(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => 'serviceWorker' in navigator);
  await page.reload();
  await page.waitForFunction(async () => {
    if (!('serviceWorker' in navigator)) return false;
    const registration = await navigator.serviceWorker.ready;
    if (!registration.active) return false;
    const shellPaths = ['/', '/index.html', '/manifest.webmanifest', '/icon.svg', '/assets/app.js', '/assets/app.css'];
    const matches = await Promise.all(shellPaths.map((path) => caches.match(path)));
    return matches.every((response) => response !== undefined);
  });
}

import type { InterviewSession } from './domain';
import { validateSessionRecord } from './pack-identity';

const DB_NAME = 'ldw-interview-facilitator';
const STORE = 'sessions';
const DB_VERSION = 1;

export type StoredSessionList = {
  sessions: InterviewSession[];
  unreadableCount: number;
};

export async function partitionStoredSessionRows(rows: unknown[]): Promise<StoredSessionList> {
  let unreadableCount = 0;
  const sessions: InterviewSession[] = [];
  for (const row of rows) {
    try {
      sessions.push(await validateSessionRecord(row));
    } catch {
      unreadableCount += 1;
    }
  }
  sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { sessions, unreadableCount };
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'sessionId' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Unable to open local storage.'));
  });
}

function writeTransaction(db: IDBDatabase): IDBTransaction {
  try {
    return db.transaction(STORE, 'readwrite', { durability: 'strict' });
  } catch {
    return db.transaction(STORE, 'readwrite');
  }
}

export async function saveSession(session: InterviewSession): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = writeTransaction(db);
      tx.objectStore(STORE).put(session);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('Unable to save session.'));
      tx.onabort = () => reject(tx.error ?? new Error('Local save was aborted.'));
    });
  } finally {
    db.close();
  }
}

export async function deleteSession(sessionId: string): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = writeTransaction(db);
      tx.objectStore(STORE).delete(sessionId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('Unable to delete local session.'));
      tx.onabort = () => reject(tx.error ?? new Error('Local delete was aborted.'));
    });
  } finally {
    db.close();
  }
}

export async function loadSession(sessionId: string): Promise<InterviewSession | undefined> {
  const db = await openDb();
  try {
    const raw = await new Promise<unknown>((resolve, reject) => {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(sessionId);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Unable to load session.'));
    });
    if (raw === undefined) return undefined;
    return await validateSessionRecord(raw);
  } finally {
    db.close();
  }
}

export async function listSessions(): Promise<StoredSessionList> {
  const db = await openDb();
  try {
    const rows = await new Promise<unknown[]>((resolve, reject) => {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
      request.onsuccess = () => resolve(request.result as unknown[]);
      request.onerror = () => reject(request.error ?? new Error('Unable to list sessions.'));
    });
    return await partitionStoredSessionRows(rows);
  } finally {
    db.close();
  }
}

export async function requestPersistentStorage(): Promise<boolean | null> {
  if (!navigator.storage?.persist) return null;
  if (await navigator.storage.persisted()) return true;
  return navigator.storage.persist();
}

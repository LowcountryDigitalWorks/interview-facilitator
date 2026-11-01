import { validateSessionForPack, type InterviewSession } from './domain';
import { canonicalizeJson, assertPackIdentity, validateSessionRecord } from './pack-identity';
import { INDEXED_DB_LAYOUT_VERSION, legacyArchiveKey, planLegacyMigration } from './session-migration';

const DB_NAME = 'ldw-interview-facilitator';
export const SESSIONS_STORE = 'sessions';
export const LEGACY_ARCHIVE_STORE = 'legacy-session-archive';
const STORE = SESSIONS_STORE;
const DB_VERSION = INDEXED_DB_LAYOUT_VERSION;

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
      if (!db.objectStoreNames.contains(LEGACY_ARCHIVE_STORE)) db.createObjectStore(LEGACY_ARCHIVE_STORE);
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
  validateSessionForPack(session);
  await assertPackIdentity(session);
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

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Local storage request failed.'));
  });
}

function openTransaction(db: IDBDatabase, stores: string[], mode: IDBTransactionMode): IDBTransaction {
  try {
    return db.transaction(stores, mode, { durability: 'strict' });
  } catch {
    return db.transaction(stores, mode);
  }
}

export type LegacyMigrationResult =
  | { kind: 'migrated'; session: InterviewSession }
  | { kind: 'already-migrated'; session: InterviewSession }
  | { kind: 'missing' }
  | { kind: 'stale' }
  | { kind: 'aborted' }
  | { kind: 'unsupported'; reason: string }
  | { kind: 'invalid'; reason: string }
  | { kind: 'conflict'; reason: string }
  | { kind: 'not-legacy' };

export async function migrateLegacySession(sessionId: string): Promise<LegacyMigrationResult> {
  const db = await openDb();
  try {
    const raw = await requestResult(db.transaction(STORE, 'readonly').objectStore(STORE).get(sessionId));
    if (raw === undefined) return { kind: 'missing' };
    const plan = await planLegacyMigration(raw);
    if (plan.kind === 'unsupported' || plan.kind === 'invalid') return plan;
    if (plan.kind === 'current') return await confirmAlreadyMigrated(db, sessionId, raw);
    return await commitLegacyMigration(db, sessionId, plan.session, plan.fingerprint);
  } finally {
    db.close();
  }
}

async function confirmAlreadyMigrated(db: IDBDatabase, sessionId: string, raw: unknown): Promise<LegacyMigrationResult> {
  const archived = await requestResult(db.transaction(LEGACY_ARCHIVE_STORE, 'readonly').objectStore(LEGACY_ARCHIVE_STORE).get(legacyArchiveKey(sessionId)));
  if (archived === undefined) return { kind: 'not-legacy' };
  const replay = await planLegacyMigration(archived);
  if (replay.kind !== 'ready') return { kind: 'conflict', reason: 'The archived legacy row cannot be migrated again.' };
  const current = await validateSessionRecord(raw);
  if (canonicalizeJson(current) !== canonicalizeJson(replay.session)) {
    return { kind: 'conflict', reason: 'The archived legacy row does not match the current session.' };
  }
  return { kind: 'already-migrated', session: current };
}

function commitLegacyMigration(db: IDBDatabase, sessionId: string, session: InterviewSession, fingerprint: string): Promise<LegacyMigrationResult> {
  return new Promise((resolve) => {
    const tx = openTransaction(db, [STORE, LEGACY_ARCHIVE_STORE], 'readwrite');
    let settled = false;
    let failure: LegacyMigrationResult | null = null;
    const finish = (result: LegacyMigrationResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const fail = (result: LegacyMigrationResult) => {
      failure = result;
      tx.abort();
    };
    tx.oncomplete = () => finish({ kind: 'migrated', session });
    tx.onabort = () => finish(failure ?? { kind: 'aborted' });
    const currentRequest = tx.objectStore(STORE).get(sessionId);
    currentRequest.onerror = () => fail({ kind: 'aborted' });
    currentRequest.onsuccess = () => {
      try {
        if (canonicalizeJson(currentRequest.result) !== fingerprint) {
          fail({ kind: 'stale' });
          return;
        }
        const archivePut = tx.objectStore(LEGACY_ARCHIVE_STORE).put(structuredClone(currentRequest.result), legacyArchiveKey(sessionId));
        archivePut.onerror = () => fail({ kind: 'aborted' });
        const sessionPut = tx.objectStore(STORE).put(session);
        sessionPut.onerror = () => fail({ kind: 'aborted' });
      } catch {
        fail({ kind: 'aborted' });
      }
    };
  });
}

export async function requestPersistentStorage(): Promise<boolean | null> {
  if (!navigator.storage?.persist) return null;
  if (await navigator.storage.persisted()) return true;
  return navigator.storage.persist();
}

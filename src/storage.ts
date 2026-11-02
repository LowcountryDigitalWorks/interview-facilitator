import { validateSessionForPack, type InterviewSession } from './domain';
import { canonicalizeJson, assertPackIdentity, validateSessionRecord } from './pack-identity';
import { INDEXED_DB_LAYOUT_VERSION, LEGACY_TO_PINNED_MIGRATION_ID, PINNED_11_TO_12_MIGRATION_ID, legacyArchiveKey, planCurrentMigration } from './session-migration';

const DB_NAME = 'ldw-interview-facilitator';
export const SESSIONS_STORE = 'sessions';
export const LEGACY_ARCHIVE_STORE = 'legacy-session-archive';
const STORE = SESSIONS_STORE;
const DB_VERSION = INDEXED_DB_LAYOUT_VERSION;
const MAX_RECOVERY_STRING_BYTES = 256_000;
const MAX_RECOVERY_TOTAL_STRING_BYTES = 1_000_000;
const MAX_RECOVERY_OUTPUT_BYTES = 2_000_000;

export type StoredSessionList = {
  sessions: InterviewSession[];
  unreadableCount: number;
  rows?: ClassifiedStoredRow[];
};

export type ClassifiedStoredRow =
  | { sessionId: string; classification: 'current'; raw: unknown; session: InterviewSession }
  | { sessionId: string; classification: 'legacy-migratable'; raw: unknown; plan: Extract<Awaited<ReturnType<typeof planCurrentMigration>>, { kind: 'ready' }> }
  | { sessionId: string; classification: 'unsupported-recoverable'; raw: unknown; reason: string }
  | { sessionId: string; classification: 'malformed-unreadable'; reason: string; recoveryAvailable: boolean };

function assertRecoveryJson(value: unknown): void {
  const ancestors = new Set<object>();
  let visited = 0;
  let stringBytes = 0;
  const encoder = new TextEncoder();
  const checkString = (value: string): void => {
    const bytes = encoder.encode(value).byteLength;
    stringBytes += bytes;
    if (bytes > MAX_RECOVERY_STRING_BYTES || stringBytes > MAX_RECOVERY_TOTAL_STRING_BYTES) throw new Error('Recovery data exceeds safe string limits.');
  };
  const visit = (item: unknown, depth: number): void => {
    if (++visited > 100_000 || depth > 100) throw new Error('Recovery data exceeds safe JSON limits.');
    if (item === null || typeof item === 'boolean') return;
    if (typeof item === 'string') { checkString(item); return; }
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new Error('Recovery data contains a non-finite number.');
      if (Object.is(item, -0)) throw new Error('Recovery data contains negative zero, which JSON cannot preserve.');
      return;
    }
    if (typeof item !== 'object') throw new Error('Recovery data contains a value JSON cannot preserve.');
    if (ancestors.has(item)) throw new Error('Recovery data contains a cycle.');
    ancestors.add(item);
    try {
      if (Array.isArray(item)) {
        if (Object.getPrototypeOf(item) !== Array.prototype) throw new Error('Recovery data contains a non-plain array.');
        const keys = Reflect.ownKeys(item);
        if (keys.length !== item.length + 1 || keys.some((key) => key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= item.length))) {
          throw new Error('Recovery data contains array properties JSON cannot preserve.');
        }
        for (let index = 0; index < item.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
          if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw new Error('Recovery data contains a sparse or accessor array entry.');
          visit(descriptor.value, depth + 1);
        }
        return;
      }
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) throw new Error('Recovery data contains a non-plain object.');
      for (const key of Reflect.ownKeys(item)) {
        if (typeof key !== 'string') throw new Error('Recovery data contains symbol properties.');
        checkString(key);
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw new Error('Recovery data contains properties JSON cannot preserve.');
        visit(descriptor.value, depth + 1);
      }
    } finally {
      ancestors.delete(item);
    }
  };
  visit(value, 0);
}

export function buildRecoveryBackup(raw: unknown): string {
  try {
    assertRecoveryJson(raw);
    const output = canonicalizeJson({ backupType: 'interview-facilitator-recovery-internal', formatVersion: '1', record: JSON.parse(canonicalizeJson(raw)) });
    if (new TextEncoder().encode(output).byteLength > MAX_RECOVERY_OUTPUT_BYTES) throw new Error('Recovery backup exceeds safe output size.');
    return output;
  } catch {
    throw new Error('Recovery backup could not be safely created. The stored interview was left unchanged.');
  }
}

export async function buildUnsupportedRecoveryBackup(raw: unknown, expectedSessionId?: string): Promise<string> {
  const candidate = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  const sessionId = candidate?.sessionId;
  const schemaVersion = candidate?.sessionSchemaVersion;
  if (typeof sessionId !== 'string' || !sessionId.trim() || (expectedSessionId !== undefined && sessionId !== expectedSessionId)
    || typeof schemaVersion !== 'string' || !/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.test(schemaVersion)) {
    throw new Error('Stored row lacks a recognizable session identity or version.');
  }
  const plan = await planCurrentMigration(raw);
  if (plan.kind !== 'unsupported') throw new Error('Stored row is not an unsupported recoverable interview.');
  return buildRecoveryBackup(raw);
}

function hasStableRecoveryIdentity(raw: unknown, expectedSessionId?: string): raw is Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const sessionId = (raw as Record<string, unknown>).sessionId;
  return typeof sessionId === 'string' && sessionId.trim().length > 0
    && (expectedSessionId === undefined || sessionId === expectedSessionId);
}

async function buildStoredRecoveryBackup(raw: unknown, expectedSessionId: string): Promise<string> {
  if (!hasStableRecoveryIdentity(raw, expectedSessionId)) throw new Error('Stored row lacks a stable recovery identity.');
  const plan = await planCurrentMigration(raw);
  if (plan.kind === 'unsupported') return buildUnsupportedRecoveryBackup(raw, expectedSessionId);
  if (plan.kind !== 'invalid') throw new Error('Stored row is not eligible for recovery backup.');
  return buildRecoveryBackup(raw);
}

export async function classifyStoredSessionRows(rows: unknown[]): Promise<ClassifiedStoredRow[]> {
  const classified: ClassifiedStoredRow[] = [];
  for (const raw of rows) {
    const candidate = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
    const sessionId = candidate && typeof candidate.sessionId === 'string'
      ? candidate.sessionId : `unreadable-${classified.length + 1}`;
    try {
      const plan = await planCurrentMigration(raw);
      if (plan.kind === 'current') {
        classified.push({ sessionId, classification: 'current', raw, session: plan.session });
      } else if (plan.kind === 'ready') classified.push({ sessionId, classification: 'legacy-migratable', raw, plan });
      else if (plan.kind === 'unsupported') {
        await buildUnsupportedRecoveryBackup(raw);
        classified.push({ sessionId, classification: 'unsupported-recoverable', raw, reason: plan.reason });
      } else {
        const recoveryAvailable = hasStableRecoveryIdentity(raw);
        if (recoveryAvailable) {
          try { buildRecoveryBackup(raw); }
          catch { classified.push({ sessionId, classification: 'malformed-unreadable', reason: plan.reason, recoveryAvailable: false }); continue; }
        }
        classified.push({ sessionId, classification: 'malformed-unreadable', reason: plan.reason, recoveryAvailable });
      }
    } catch {
      classified.push({ sessionId, classification: 'malformed-unreadable', reason: 'Stored row is not safely classifiable.', recoveryAvailable: false });
    }
  }
  return classified;
}

export async function partitionStoredSessionRows(rows: unknown[]): Promise<StoredSessionList> {
  const classified = await classifyStoredSessionRows(rows);
  const sessions = classified.flatMap((row) => row.classification === 'current' ? [row.session] : []);
  sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { sessions, unreadableCount: classified.filter((row) => row.classification === 'malformed-unreadable').length, rows: classified };
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

export async function exportRecoveryBackup(sessionId: string): Promise<string> {
  const db = await openDb();
  try {
    const raw = await requestResult(db.transaction(STORE, 'readonly').objectStore(STORE).get(sessionId));
    return await buildStoredRecoveryBackup(raw, sessionId);
  } catch {
    throw new Error('Recovery backup could not be safely created. The stored interview was left unchanged.');
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
    const plan = await planCurrentMigration(raw);
    if (plan.kind === 'unsupported' || plan.kind === 'invalid') return plan;
    if (plan.kind === 'current') return await confirmAlreadyMigrated(db, sessionId, raw);
    return await commitLegacyMigration(db, sessionId, plan.session, plan.fingerprint, plan.raw, plan.sourceSchemaVersion, plan.migrationId);
  } finally {
    db.close();
  }
}

async function confirmAlreadyMigrated(db: IDBDatabase, sessionId: string, raw: unknown): Promise<LegacyMigrationResult> {
  const archiveStore = db.transaction(LEGACY_ARCHIVE_STORE, 'readonly').objectStore(LEGACY_ARCHIVE_STORE);
  const archives = await Promise.all([
    requestResult(archiveStore.get(legacyArchiveKey(sessionId, '1.0.0', LEGACY_TO_PINNED_MIGRATION_ID))),
    requestResult(archiveStore.get(legacyArchiveKey(sessionId, '1.1.0', PINNED_11_TO_12_MIGRATION_ID))),
  ]);
  // Prefer the immediate 1.1 source archive when both generations exist: an accepted 1.0→1.1 session may have been edited before 1.1→1.2.
  const archived = archives[1] ?? archives[0];
  if (archived === undefined) return { kind: 'not-legacy' };
  const replay = await planCurrentMigration(archived);
  if (replay.kind !== 'ready') return { kind: 'conflict', reason: 'The archived legacy row cannot be migrated again.' };
  const current = await validateSessionRecord(raw);
  if (canonicalizeJson(current) !== canonicalizeJson(replay.session)) {
    return { kind: 'conflict', reason: 'The archived legacy row does not match the current session.' };
  }
  return { kind: 'already-migrated', session: current };
}

function commitLegacyMigration(db: IDBDatabase, sessionId: string, session: InterviewSession, fingerprint: string, raw: unknown, sourceSchemaVersion: string, migrationId: string): Promise<LegacyMigrationResult> {
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
        const archiveStore = tx.objectStore(LEGACY_ARCHIVE_STORE);
        const archiveRequest = archiveStore.get(legacyArchiveKey(sessionId, sourceSchemaVersion, migrationId));
        archiveRequest.onerror = () => fail({ kind: 'aborted' });
        archiveRequest.onsuccess = () => {
          try {
            if (archiveRequest.result !== undefined) {
              if (canonicalizeJson(archiveRequest.result) !== fingerprint) {
                fail({ kind: 'conflict', reason: 'An existing archive contains different legacy data.' });
                return;
              }
            } else {
              const archivePut = archiveStore.put(structuredClone(raw), legacyArchiveKey(sessionId, sourceSchemaVersion, migrationId));
              archivePut.onerror = () => fail({ kind: 'aborted' });
            }
            const sessionPut = tx.objectStore(STORE).put(session);
            sessionPut.onerror = () => fail({ kind: 'aborted' });
          } catch {
            fail({ kind: 'aborted' });
          }
        };
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

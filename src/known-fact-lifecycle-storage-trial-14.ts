import { canonicalizeJson, sha256Hex } from './pack-identity';
import {
  validateKnownFactLifecycle14, type KnownFactLifecycle14,
} from './known-fact-lifecycle-14';

/**
 * #34 trial ONLY. Separate, intentionally non-production IndexedDB database.
 * This module is not imported by main.ts and never opens the live 1.3 database.
 * It proves atomic coordination before a separate, reviewed integration design.
 */
export const LIFECYCLE_TRIAL_DB_NAME = 'ldw-interview-lifecycle-14-trial-only' as const;
export const LIFECYCLE_TRIAL_DB_VERSION = 1 as const;
export const LIFECYCLE_TRIAL_BACKUP_KIND = 'ldw-lifecycle-1.4-trial-backup-v1' as const;
const MAX_BACKUP_LENGTH = 5_000_000;
const STORES = ['trial-session', 'trial-lifecycle', 'trial-history', 'trial-backup'] as const;
type TrialStore = (typeof STORES)[number];

export interface LifecycleTrialRecord14 {
  format: 'ldw-lifecycle-1.4-trial-record-v1';
  generation: number;
  digest: string;
  lifecycle: KnownFactLifecycle14;
}
export type LifecycleTrialToken14 = { generation: number; digest: string };

function jsonMeaning(value: unknown): string {
  return canonicalizeJson(JSON.parse(JSON.stringify(value)));
}
function assertTrialDatabase(db: IDBDatabase): void {
  if (db.name !== LIFECYCLE_TRIAL_DB_NAME || db.version !== LIFECYCLE_TRIAL_DB_VERSION
    || STORES.some((name) => !db.objectStoreNames.contains(name))) {
    throw new Error('Only the isolated schema 1.4 trial database is supported.');
  }
}
function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'));
  });
}
function nonempty(value: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Session ID is required.');
  return value;
}

/** Callers own the connection; no live database or version upgrade is touched. */
export function openKnownFactLifecycleTrial14ForReview(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(LIFECYCLE_TRIAL_DB_NAME, LIFECYCLE_TRIAL_DB_VERSION);
    request.onupgradeneeded = () => {
      for (const name of STORES) {
        if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name);
      }
    };
    let blocked = false;
    request.onsuccess = () => {
      const db = request.result;
      // A blocked open can later succeed after the other tab closes. The
      // caller has already been told it failed: do not strand that late
      // connection or quietly return a handle from a rejected attempt.
      if (blocked) { db.close(); return; }
      try {
        assertTrialDatabase(db);
        // Another tab's explicit upgrade/delete must not be held hostage by
        // this trial-only tab. Pending transactions finish before close.
        // A caller using the old handle will receive an IndexedDB error and
        // must explicitly reopen/revalidate; never silently replay writes.
        db.onversionchange = () => db.close();
        resolve(db);
      } catch (error) { db.close(); reject(error); }
    };
    request.onerror = () => reject(request.error ?? new Error('Trial database open failed.'));
    request.onblocked = () => {
      blocked = true;
      reject(new Error('Trial database is blocked by another connection.'));
    };
  });
}

export function lifecycleTrialHistoryKey(sessionId: string, generation: number): string {
  return canonicalizeJson([nonempty(sessionId), generation]);
}

/**
 * Portable, self-contained, confidential lifecycle backup. Digest detects
 * corruption, NOT authentication or encryption; external retention is a
 * separate owner-controlled action, never automatic.
 */
export async function createLifecycleTrial14BackupForReview(raw: unknown): Promise<string> {
  const materialized = JSON.parse(JSON.stringify(raw));
  const lifecycle = await validateKnownFactLifecycle14(materialized);
  if (jsonMeaning(materialized) !== jsonMeaning(lifecycle)) {
    throw new Error('Lifecycle backup source would lose data during validation.');
  }
  const payload = jsonMeaning(lifecycle);
  const envelope = {
    kind: LIFECYCLE_TRIAL_BACKUP_KIND,
    formatVersion: 1,
    classification: 'INTERNAL / CONFIDENTIAL',
    integrity: { algorithm: 'SHA-256', canonicalization: 'ldw-json-c14n-v1', digest: await sha256Hex(payload) },
    lifecycle: JSON.parse(payload),
  };
  const bytes = canonicalizeJson(envelope) + '\n';
  if (bytes.length > MAX_BACKUP_LENGTH) throw new Error('Lifecycle backup exceeds size limit.');
  return bytes;
}

export async function validateLifecycleTrial14BackupForReview(raw: unknown): Promise<KnownFactLifecycle14> {
  if (typeof raw !== 'string' || !raw.length || raw.length > MAX_BACKUP_LENGTH) {
    throw new Error('Lifecycle backup must be bounded JSON text.');
  }
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('Lifecycle backup must be valid JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Lifecycle backup is invalid.');
  const obj = value as Record<string, unknown>;
  if (Object.keys(obj).some(k => !['kind', 'formatVersion', 'classification', 'integrity', 'lifecycle'].includes(k))
    || obj.kind !== LIFECYCLE_TRIAL_BACKUP_KIND || obj.formatVersion !== 1
    || obj.classification !== 'INTERNAL / CONFIDENTIAL') throw new Error('Unsupported lifecycle backup envelope.');
  const integrity = obj.integrity as Record<string, unknown> | null;
  if (!integrity || typeof integrity !== 'object' || Array.isArray(integrity)
    || Object.keys(integrity).some(k => !['algorithm', 'canonicalization', 'digest'].includes(k))
    || integrity.algorithm !== 'SHA-256' || integrity.canonicalization !== 'ldw-json-c14n-v1'
    || typeof integrity.digest !== 'string' || !/^[a-f0-9]{64}$/.test(integrity.digest)) {
    throw new Error('Unsupported lifecycle backup integrity.');
  }
  const lifecycle = await validateKnownFactLifecycle14(obj.lifecycle);
  const payload = jsonMeaning(lifecycle);
  if (jsonMeaning(obj.lifecycle) !== payload || await sha256Hex(payload) !== integrity.digest) {
    throw new Error('Lifecycle backup integrity mismatch.');
  }
  if (raw !== canonicalizeJson(obj) + '\n') throw new Error('Lifecycle backup must use canonical JSON bytes.');
  return lifecycle;
}

/** Closed stored-row validation with an exact source digest. */
async function checkedRecord(raw: unknown, sessionId: string): Promise<LifecycleTrialRecord14> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Trial lifecycle row is invalid.');
  const obj = raw as Record<string, unknown>;
  if (Object.keys(obj).some(k => !['format', 'generation', 'digest', 'lifecycle'].includes(k))
    || obj.format !== 'ldw-lifecycle-1.4-trial-record-v1'
    || !Number.isSafeInteger(obj.generation) || (obj.generation as number) < 0
    || typeof obj.digest !== 'string' || !/^[a-f0-9]{64}$/.test(obj.digest)) {
    throw new Error('Unsupported lifecycle trial row.');
  }
  const lifecycle = await validateKnownFactLifecycle14(obj.lifecycle);
  if (lifecycle.session.sessionId !== sessionId
    || jsonMeaning(obj.lifecycle) !== jsonMeaning(lifecycle)
    || await sha256Hex(jsonMeaning(lifecycle)) !== obj.digest) {
    throw new Error('Lifecycle trial row source or integrity mismatch.');
  }
  return {
    format: 'ldw-lifecycle-1.4-trial-record-v1',
    generation: obj.generation as number,
    digest: obj.digest,
    lifecycle,
  };
}

export async function loadKnownFactLifecycleTrial14ForReview(
  db: IDBDatabase, sessionId: string,
): Promise<LifecycleTrialRecord14 | null> {
  assertTrialDatabase(db);
  nonempty(sessionId);
  // Requests are queued synchronously: never await inside an idle IDB transaction.
  const tx = db.transaction([...STORES], 'readonly');
  const recordRequest = tx.objectStore('trial-lifecycle').get(sessionId);
  const sessionRequest = tx.objectStore('trial-session').get(sessionId);
  const backupRequest = tx.objectStore('trial-backup').get(sessionId);
  const [raw, session, backup] = await Promise.all([
    requestValue(recordRequest), requestValue(sessionRequest), requestValue(backupRequest),
  ]);
  if (raw === undefined) {
    if (session !== undefined || backup !== undefined) throw new Error('Orphan lifecycle trial data.');
    return null;
  }
  const record = await checkedRecord(raw, sessionId);
  if (session === undefined || jsonMeaning(session) !== jsonMeaning(record.lifecycle.session)
    || typeof backup !== 'string') throw new Error('Atomic lifecycle trial stores disagree.');
  const recovered = await validateLifecycleTrial14BackupForReview(backup);
  if (jsonMeaning(recovered) !== jsonMeaning(record.lifecycle)) {
    throw new Error('Lifecycle backup does not match the active trial generation.');
  }
  return record;
}

/** Append-only state validation across full envelopes; no silent history rewrites. */
function assertForwardLifecycle(previous: KnownFactLifecycle14, next: KnownFactLifecycle14): void {
  if (previous.session.sessionId !== next.session.sessionId
    || previous.session.createdAt !== next.session.createdAt
    || previous.session.interviewPackId !== next.session.interviewPackId
    || previous.session.interviewPackVersion !== next.session.interviewPackVersion
    || jsonMeaning(previous.session.packSnapshot) !== jsonMeaning(next.session.packSnapshot)
    || jsonMeaning(previous.session.packIdentity) !== jsonMeaning(next.session.packIdentity)
    || jsonMeaning(previous.session.knownFacts) !== jsonMeaning(next.session.knownFacts)) {
    throw new Error('Trial lifecycle cannot replace pinned source identity.');
  }
  for (const field of ['events', 'completedRevisions'] as const) {
    const oldItems = previous[field], newItems = next[field];
    if (newItems.length < oldItems.length || jsonMeaning(newItems.slice(0, oldItems.length)) !== jsonMeaning(oldItems)) {
      throw new Error('Trial lifecycle history must be append-only.');
    }
  }
  const oldLedger = previous.session.knownFactLedger, newLedger = next.session.knownFactLedger;
  for (const field of ['facts', 'acceptances'] as const) {
    const oldItems = oldLedger[field], newItems = newLedger[field];
    if (newItems.length < oldItems.length || jsonMeaning(newItems.slice(0, oldItems.length)) !== jsonMeaning(oldItems)) {
      throw new Error('Trial lifecycle provenance must be append-only.');
    }
  }
  if (next.session.updatedAt < previous.session.updatedAt) throw new Error('Trial lifecycle source time moved backwards.');
  const added = next.events.slice(previous.events.length);
  if (previous.status === 'draft' && next.status === 'draft') {
    if (next.session.revisionId !== previous.session.revisionId
      || added.some(e => e.type !== 'read-back-recorded')) {
      throw new Error('Draft edit must retain its current lifecycle revision.');
    }
  } else if (previous.status === 'draft' && next.status === 'completed') {
    if (next.session.revisionId !== previous.session.revisionId
      || !added.some(e => e.type === 'completed')
      || jsonMeaning(next.session) !== jsonMeaning(previous.session)) {
      throw new Error('Completion must preserve the exact previously saved Draft revision.');
    }
  } else if (previous.status === 'completed' && next.status === 'draft') {
    if (!added.some(e => e.type === 'reopened'
      && e.fromRevisionId === previous.session.revisionId && e.newRevisionId === next.session.revisionId)) {
      throw new Error('Reopen must preserve the completed parent and create a new Draft.');
    }
  } else if (jsonMeaning(previous.session) !== jsonMeaning(next.session)
    || added.some(e => e.type !== 'read-back-recorded')) {
    throw new Error('Completed lifecycle content cannot be edited.');
  }
}

export class LifecycleTrialConflictError extends Error {
  readonly name = 'LifecycleTrialConflictError';
  constructor(message: string) { super(message); }
}

/**
 * Compare-and-swap for a COMPLETE lifecycle state, including same-revision
 * completion events. A revision ID alone is not a sufficient CAS token.
 *
 * All four stores write in ONE transaction. Preflight validation is completed
 * BEFORE starting it; the in-transaction reads re-check exact source bytes.
 */
export async function saveKnownFactLifecycleTrial14ForReview(
  db: IDBDatabase,
  raw: unknown,
  expected: LifecycleTrialToken14 | null,
): Promise<LifecycleTrialRecord14> {
  assertTrialDatabase(db);
  const candidate = await validateKnownFactLifecycle14(raw);
  const sessionId = nonempty(candidate.session.sessionId);
  const prior = await loadKnownFactLifecycleTrial14ForReview(db, sessionId);
  if (prior === null ? expected !== null : !expected
    || expected.generation !== prior.generation || expected.digest !== prior.digest) {
    throw new LifecycleTrialConflictError('Stale lifecycle generation or fingerprint.');
  }
  if (prior) assertForwardLifecycle(prior.lifecycle, candidate);
  const digest = await sha256Hex(jsonMeaning(candidate));
  const next: LifecycleTrialRecord14 = {
    format: 'ldw-lifecycle-1.4-trial-record-v1',
    generation: prior === null ? 0 : prior.generation + 1,
    digest,
    lifecycle: candidate,
  };
  const backup = await createLifecycleTrial14BackupForReview(candidate);
  const expectedRow = prior === null ? undefined : jsonMeaning(prior);
  const expectedSession = prior === null ? undefined : jsonMeaning(prior.lifecycle.session);
  const expectedBackup = prior === null ? undefined : await createLifecycleTrial14BackupForReview(prior.lifecycle);
  return new Promise<LifecycleTrialRecord14>((resolve, reject) => {
    const tx = db.transaction([...STORES], 'readwrite');
    let failure: unknown;
    const fail = (error: unknown) => {
      if (failure !== undefined) return;
      failure = error;
      try { tx.abort(); } catch { /* already terminated */ }
    };
    tx.oncomplete = () => failure === undefined ? resolve(next) : reject(failure);
    tx.onabort = () => reject(failure ?? tx.error ?? new LifecycleTrialConflictError('Lifecycle transaction aborted.'));
    tx.onerror = () => { if (failure === undefined) failure = tx.error ?? new Error('Lifecycle trial write failed.'); };
    const lifecycleStore = tx.objectStore('trial-lifecycle');
    const sessionStore = tx.objectStore('trial-session');
    const backupStore = tx.objectStore('trial-backup');
    const historyStore = tx.objectStore('trial-history');
    const currentRequest = lifecycleStore.get(sessionId);
    currentRequest.onerror = () => fail(currentRequest.error);
    currentRequest.onsuccess = () => {
      try {
        if ((prior === null && currentRequest.result !== undefined)
          || (prior !== null && (currentRequest.result === undefined
            || jsonMeaning(currentRequest.result) !== expectedRow))) {
          fail(new LifecycleTrialConflictError('Concurrent lifecycle update changed the active row.')); return;
        }
        const sessionRequest = sessionStore.get(sessionId);
        sessionRequest.onerror = () => fail(sessionRequest.error);
        sessionRequest.onsuccess = () => {
          try {
            const actualSession = sessionRequest.result;
            if ((prior === null && actualSession !== undefined)
              || (prior !== null && (actualSession === undefined
                || jsonMeaning(actualSession) !== expectedSession))) {
              fail(new LifecycleTrialConflictError('Active trial session diverged.')); return;
            }
            const backupRequest = backupStore.get(sessionId);
            backupRequest.onerror = () => fail(backupRequest.error);
            backupRequest.onsuccess = () => {
              try {
                if (prior === null ? backupRequest.result !== undefined
                  : backupRequest.result !== expectedBackup) {
                  fail(new LifecycleTrialConflictError('Active trial backup diverged.')); return;
                }
                const commit = () => {
                  try {
                    sessionStore.put(structuredClone(candidate.session), sessionId);
                    backupStore.put(backup, sessionId);
                    lifecycleStore.put(structuredClone(next), sessionId);
                  } catch (error) { fail(error); }
                };
                if (!prior) { commit(); return; }
                const key = lifecycleTrialHistoryKey(sessionId, prior.generation);
                const historyRequest = historyStore.get(key);
                historyRequest.onerror = () => fail(historyRequest.error);
                historyRequest.onsuccess = () => {
                  if (historyRequest.result !== undefined) {
                    fail(new LifecycleTrialConflictError('Immutable trial history key is already occupied.'));
                    return;
                  }
                  try { historyStore.add(structuredClone(prior), key); commit(); }
                  catch (error) { fail(error); }
                };
              } catch (error) { fail(error); }
            };
          } catch (error) { fail(error); }
        };
      } catch (error) { fail(error); }
    };
  });
}

/** Explicit restore into an EMPTY trial slot, never into live PWA storage. */
export async function restoreKnownFactLifecycleTrial14ForReview(
  db: IDBDatabase, bytes: string,
): Promise<LifecycleTrialRecord14> {
  const restored = await validateLifecycleTrial14BackupForReview(bytes);
  return saveKnownFactLifecycleTrial14ForReview(db, restored, null);
}

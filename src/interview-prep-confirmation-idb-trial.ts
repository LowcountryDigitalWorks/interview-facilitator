import { canonicalizeJson } from './pack-identity';
import {
  validateSemanticSessionRecord, type SemanticInterviewSession,
} from './semantic-session';
import type { ConfirmedPrepCompareAndSaveForReview } from './interview-prep-confirmation-trial';

/**
 * Synthetic-only, isolated native IndexedDB proof for #105.
 * NEVER import into main.ts or use the live session DB. The browser store
 * contains actual confirmed synthetic canonical state, NOT private overlay
 * source references. It has no cloud sync, encryption, backup, or client auth.
 */
export const CONFIRMATION_TRIAL_DB_NAME = 'ldw-prep-confirmation-synthetic-trial-only' as const;
const DB_VERSION = 1;
const STORE = 'synthetic-confirmed-sessions';

function checkDB(db: IDBDatabase): void {
  if (db.name !== CONFIRMATION_TRIAL_DB_NAME || db.version !== DB_VERSION
    || !db.objectStoreNames.contains(STORE)) {
    throw new Error('Only the isolated synthetic confirmation database is supported.');
  }
}
function syntheticOnly(session: SemanticInterviewSession): void {
  if (!session.clientLabel.startsWith('SYNTHETIC ')) {
    throw new Error('Only synthetic labeled sessions are permitted in this trial database.');
  }
}

/** No silent blocked upgrade. Versionchange closes a trial connection. */
export function openConfirmationTrialDatabaseForReview(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(CONFIRMATION_TRIAL_DB_NAME, DB_VERSION);
    let blocked = false;
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE);
      }
    };
    request.onblocked = () => {
      blocked = true;
      reject(new Error('Synthetic confirmation database upgrade was blocked.'));
    };
    request.onerror = () => reject(request.error ?? new Error('Trial DB open failed.'));
    request.onsuccess = () => {
      const db = request.result;
      if (blocked) { db.close(); return; }
      try {
        checkDB(db);
        db.onversionchange = () => db.close();
        resolve(db);
      } catch (error) { db.close(); reject(error); }
    };
  });
}

/** Seed once with a validated synthetic 1.3 interview. No overwrite. */
export async function seedConfirmationTrialForReview(
  db: IDBDatabase, rawSession: unknown,
): Promise<void> {
  checkDB(db);
  const session = await validateSemanticSessionRecord(rawSession);
  syntheticOnly(session);
  const encoded = canonicalizeJson(session);
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('Synthetic trial seed rejected.'));
    tx.onerror = () => { /* transaction abort is reported by onabort */ };
    tx.objectStore(STORE).add(encoded, session.sessionId);
  });
}

export async function loadConfirmationTrialForReview(
  db: IDBDatabase, sessionId: string,
): Promise<SemanticInterviewSession | undefined> {
  checkDB(db);
  if (!sessionId || typeof sessionId !== 'string') throw new Error('Session ID required.');
  const raw = await new Promise<unknown>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    let value: unknown;
    tx.oncomplete = () => resolve(value);
    tx.onabort = () => reject(tx.error ?? new Error('Trial read failed.'));
    const request = tx.objectStore(STORE).get(sessionId);
    request.onsuccess = () => { value = request.result; };
    request.onerror = () => { /* transaction abort is reported by onabort */ };
  });
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') throw new Error('Synthetic confirmation row is invalid.');
  const session = await validateSemanticSessionRecord(JSON.parse(raw));
  syntheticOnly(session);
  if (session.sessionId !== sessionId || canonicalizeJson(session) !== raw) {
    throw new Error('Synthetic confirmation row identity/integrity mismatch.');
  }
  return session;
}

/**
 * Atomic compare on the ENTIRE previously validated canonical session text
 * inside ONE native readwrite transaction; no await between get and put.
 * Simultaneous tabs cannot both promote the same prior source. A changed
 * private note without a revision bump is still a conflict.
 */
export function confirmationTrialStoreForReview(
  db: IDBDatabase,
): ConfirmedPrepCompareAndSaveForReview {
  checkDB(db);
  return {
    async compareAndSave(
      sessionId: string, expectedCanonical: string,
      rawProposed: SemanticInterviewSession,
    ): Promise<SemanticInterviewSession | null> {
      checkDB(db);
      const proposal = await validateSemanticSessionRecord(rawProposed);
      syntheticOnly(proposal);
      if (typeof expectedCanonical !== 'string'
        || expectedCanonical.length > 2_000_000 || !expectedCanonical
        || proposal.sessionId !== sessionId) {
        throw new Error('Synthetic CAS requires exact bounded source and session identity.');
      }
      const old = JSON.parse(expectedCanonical) as unknown;
      const validatedOld = await validateSemanticSessionRecord(old);
      syntheticOnly(validatedOld);
      if (validatedOld.sessionId !== sessionId
        || canonicalizeJson(validatedOld) !== expectedCanonical
        || proposal.parentRevisionId !== validatedOld.revisionId
        || proposal.revisionId === validatedOld.revisionId) {
        throw new Error('Synthetic CAS source/proposal lineage is invalid.');
      }
      const target = canonicalizeJson(proposal);
      if (target.length > 2_000_000) throw new Error('Synthetic CAS payload is oversized.');
      const saved = await new Promise<boolean>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        let wrote = false;
        tx.oncomplete = () => resolve(wrote);
        tx.onabort = () => reject(tx.error ?? new Error('Synthetic CAS transaction aborted.'));
        tx.onerror = () => { /* transaction abort is reported by onabort */ };
        const request = tx.objectStore(STORE).get(sessionId);
        request.onsuccess = () => {
          // Synchronous comparison and put stay in the SAME transaction.
          // A missing/stale row is a bounded no-write outcome.
          if (request.result !== expectedCanonical) return;
          tx.objectStore(STORE).put(target, sessionId);
          wrote = true;
        };
        request.onerror = () => { /* transaction abort is reported by onabort */ };
      });
      return saved ? proposal : null;
    },
  };
}

export function deleteConfirmationTrialDatabaseForReview(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(CONFIRMATION_TRIAL_DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error('Synthetic trial deletion failed.'));
    request.onblocked = () => reject(new Error('Synthetic trial deletion blocked by an open tab.'));
  });
}

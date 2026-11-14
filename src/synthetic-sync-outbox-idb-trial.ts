import { canonicalizeJson } from './pack-identity';
import { validateSemanticSessionRecord, type SemanticInterviewSession } from './semantic-session';
import {
  evaluateSyntheticDurableAck,
  prepareSyntheticRevisionOffer,
  type SyntheticSyncOffer,
} from './synthetic-sync-plan';

/**
 * S1B — DORMANT native-IDB synthetic proof only. The live PWA never imports
 * this module. No network, credentials, external ACK authority, or real sync.
 * This isolated test database is NOT the user's 1.3 session database.
 */
export const SYNTHETIC_OUTBOX_TRIAL_DB = 'ldw-if-synthetic-offline-outbox-s1b-test';
export const SYNTHETIC_OUTBOX_TRIAL_VERSION = 1;
export const SYNTHETIC_OUTBOX_MAX_PENDING = 32;
const STORES = ['current', 'history', 'pending', 'receipts'] as const;

type Current = { sessionId: string; offer: SyntheticSyncOffer };
type Retained = { operationId: string; offer: SyntheticSyncOffer; session: SemanticInterviewSession };
type Pending = { operationId: string; offer: SyntheticSyncOffer };
type Receipt = { operationId: string; offer: SyntheticSyncOffer };

export type SyntheticStageResult =
  | 'staged-atomically'
  | 'replay-noop'
  | 'stale-no-write'
  | 'queue-full-no-write'
  | 'inconsistent-no-write';

export type SyntheticAckResult =
  | 'mock-receipt-recorded'
  | 'already-mock-received'
  | 'retained-no-verified-receipt';

/** No migration, upgrade or access to the real "ldw-interview-facilitator" DB. */
export function openSyntheticOutboxTrialForReview(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(SYNTHETIC_OUTBOX_TRIAL_DB, SYNTHETIC_OUTBOX_TRIAL_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'operationId' });
      }
      // Current is keyed by stable session identity, not operation identity.
      if (db.objectStoreNames.contains('current')) {
        // The current store must be keyed by sessionId. This branch is only
        // reachable on fresh test database upgrades; keep the contract strict.
        const tx = request.transaction;
        if (tx?.objectStore('current').keyPath !== 'sessionId') {
          db.deleteObjectStore('current');
          db.createObjectStore('current', { keyPath: 'sessionId' });
        }
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error('Synthetic outbox open failed.'));
    request.onblocked = () => reject(new Error('Synthetic outbox version is blocked.'));
  });
}

export function deleteSyntheticOutboxTrialForReview(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(SYNTHETIC_OUTBOX_TRIAL_DB);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error('Synthetic outbox deletion failed.'));
    request.onblocked = () => reject(new Error('Synthetic outbox deletion blocked by open tabs.'));
  });
}

function getValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Synthetic outbox read failed.'));
  });
}

function headsEqual(left: SyntheticSyncOffer, right: SyntheticSyncOffer): boolean {
  return left.operationId === right.operationId
    && canonicalizeJson(left.head) === canonicalizeJson(right.head);
}

/**
 * Only accepted atomic write path for the dormant synthetic proof.
 * Validation/digest happen BEFORE opening the native readwrite transaction.
 * The transaction writes current + immutable complete snapshot + pending,
 * or rolls back ALL THREE on a native IDB request failure.
 */
export async function stageSyntheticRevisionForTrial(
  db: IDBDatabase,
  rawSession: unknown,
  expectedRevisionId: string | null,
): Promise<SyntheticStageResult> {
  const session = await validateSemanticSessionRecord(rawSession);
  if (canonicalizeJson(rawSession) !== canonicalizeJson(session)) {
    throw new Error('Synthetic source must be an unmodified canonical session.');
  }
  const offer = await prepareSyntheticRevisionOffer(session);
  if (expectedRevisionId !== null && (!expectedRevisionId || expectedRevisionId.length > 128)) {
    throw new Error('Synthetic expected revision identity is invalid.');
  }

  return new Promise((resolve, reject) => {
    const tx = db.transaction([...STORES], 'readwrite');
    let result: SyntheticStageResult = 'inconsistent-no-write';
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(new Error('Synthetic native outbox atomic write aborted.'));
    const currentStore = tx.objectStore('current');
    const historyStore = tx.objectStore('history');
    const queue = tx.objectStore('pending');
    const headRequest = currentStore.get(session.sessionId);
    headRequest.onsuccess = () => {
      const current = headRequest.result as Current | undefined;
      if (current) {
        if (!current.offer?.head || current.sessionId !== session.sessionId) {
          result = 'inconsistent-no-write';
          return;
        }
        if (current.offer.head.revisionId === offer.head.revisionId) {
          if (!headsEqual(current.offer, offer)) {
            result = 'stale-no-write';
            return;
          }
          const history = historyStore.get(offer.operationId);
          history.onsuccess = () => {
            const retained = history.result as Retained | undefined;
            result = retained && headsEqual(retained.offer, offer)
              && canonicalizeJson(retained.session) === canonicalizeJson(session)
              ? 'replay-noop' : 'inconsistent-no-write';
          };
          return;
        }
        if (expectedRevisionId !== current.offer.head.revisionId
          || offer.head.parentRevisionId !== current.offer.head.revisionId
          || offer.head.packDigest !== current.offer.head.packDigest) {
          result = 'stale-no-write';
          return;
        }
      } else if (expectedRevisionId !== null || offer.head.parentRevisionId !== null) {
        result = 'stale-no-write';
        return;
      }

      const count = queue.count();
      count.onsuccess = () => {
        if (count.result >= SYNTHETIC_OUTBOX_MAX_PENDING) {
          result = 'queue-full-no-write';
          return;
        }
        result = 'staged-atomically';
        currentStore.put({ sessionId: session.sessionId, offer } satisfies Current);
        // ADD rather than PUT makes every snapshot immutable. A constraint
        // failure aborts head, retained source and pending as one transaction.
        historyStore.add({ operationId: offer.operationId, offer, session } satisfies Retained);
        queue.add({ operationId: offer.operationId, offer } satisfies Pending);
      };
    };
  });
}

/** Read-only snapshot for a synthetic test, never a production transport API. */
export async function inspectSyntheticOutboxTrial(db: IDBDatabase, sessionId: string) {
  const tx = db.transaction([...STORES], 'readonly');
  const [current, history, pending, receipts] = await Promise.all([
    getValue(tx.objectStore('current').get(sessionId)) as Promise<Current | undefined>,
    getValue(tx.objectStore('history').getAll()) as Promise<Retained[]>,
    getValue(tx.objectStore('pending').getAll()) as Promise<Pending[]>,
    getValue(tx.objectStore('receipts').getAll()) as Promise<Receipt[]>,
  ]);
  return {
    current,
    history: history.filter(row => row.offer.head.sessionId === sessionId),
    pending: pending.filter(row => row.offer.head.sessionId === sessionId),
    receipts: receipts.filter(row => row.offer.head.sessionId === sessionId),
  };
}

/**
 * Deliberately simulates *a previously verified* durable remote receipt
 * without any remote endpoint. The caller-provided proof marker is NOT
 * security/authentication; only future approved private adapter may supply
 * real verification. Never surface SYNCED from this trial method.
 */
export async function simulateVerifiedSyntheticAckForTrial(
  db: IDBDatabase,
  offer: SyntheticSyncOffer,
  ack: unknown,
  proof: 'synthetic-test-receipt' | 'no-verified-receipt',
): Promise<SyntheticAckResult> {
  if (proof !== 'synthetic-test-receipt'
    || await evaluateSyntheticDurableAck(offer, ack) !== 'candidate-ack-matched') {
    return 'retained-no-verified-receipt';
  }
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['pending', 'receipts'], 'readwrite');
    let result: SyntheticAckResult = 'retained-no-verified-receipt';
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(new Error('Synthetic receipt transaction aborted.'));
    const pending = tx.objectStore('pending');
    const receipts = tx.objectStore('receipts');
    const pendingRequest = pending.get(offer.operationId);
    pendingRequest.onsuccess = () => {
      const row = pendingRequest.result as Pending | undefined;
      if (row) {
        if (!headsEqual(row.offer, offer)) return;
        // The test receipt and queue deletion are atomic, not a "cloud ACK".
        receipts.add({ operationId: offer.operationId, offer } satisfies Receipt);
        pending.delete(offer.operationId);
        result = 'mock-receipt-recorded';
        return;
      }
      const existing = receipts.get(offer.operationId);
      existing.onsuccess = () => {
        const prior = existing.result as Receipt | undefined;
        if (prior && headsEqual(prior.offer, offer)) result = 'already-mock-received';
      };
    };
  });
}

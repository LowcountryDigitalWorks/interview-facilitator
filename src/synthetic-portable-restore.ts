import { canonicalizeJson } from './pack-identity';
import {
  serializePortableRevisionArchive,
  validatePortableRevisionArchiveJson,
  type PortableRevisionArchive,
} from './portable-revision-archive';
import {
  planFreshOriginPortableRestoreDryRun,
  type PortableRestorePreflightScope,
} from './portable-restore-plan';
import { INDEXED_DB_LAYOUT_VERSION } from './session-migration';
import {
  validateSemanticSessionRecord,
  type SemanticInterviewSession,
} from './semantic-session';
import {
  LEGACY_ARCHIVE_STORE,
  REVISION_HISTORY_STORE,
  SESSIONS_STORE,
  revisionHistoryKey,
} from './storage';

/**
 * E1 / #35 — SYNTHETIC-ONLY, test-harness fresh-origin transactional import.
 * No UI route, no customer import, no provider/Drive, no 1.4 activation.
 * Unkeyed archive checksum is not authenticity or tamper-evidence.
 */
export const SYNTHETIC_PORTABLE_RESTORE_TEST_CAPABILITY =
  'ldw.synthetic-portable-restore-test-only.v1' as const;

const DB_NAME = 'ldw-interview-facilitator';

export type SyntheticPortableRestoreRequest = {
  testOnlyCapability: typeof SYNTHETIC_PORTABLE_RESTORE_TEST_CAPABILITY;
  untrustedArchiveJson: string;
  scope?: PortableRestorePreflightScope;
};

export type SyntheticPortableRestoreSuccess = {
  kind: 'imported';
  sessionId: string;
  headRevisionId: string;
  retainedRevisionCount: number;
};

export type SyntheticPortableRestoreCommittedUnverified = {
  kind: 'committed-unverified';
  sessionId: string;
  headRevisionId: string;
  reason: string;
};

export type SyntheticPortableRestoreRejected = {
  kind: 'rejected';
  code:
    | 'invalid-request'
    | 'preflight-reject'
    | 'synthetic-guard'
    | 'durability-unavailable';
  reason: string;
};

export type SyntheticPortableRestoreOutcome =
  | SyntheticPortableRestoreSuccess
  | SyntheticPortableRestoreCommittedUnverified
  | SyntheticPortableRestoreRejected;

export class SyntheticPortableRestoreCollisionError extends Error {
  readonly name = 'SyntheticPortableRestoreCollisionError';
  constructor(
    readonly code: 'session-exists' | 'orphan-history',
    message: string,
  ) {
    super(message);
  }
}

export class SyntheticPortableRestoreTransactionError extends Error {
  readonly name = 'SyntheticPortableRestoreTransactionError';
  constructor(message: string) {
    super(message);
  }
}

function revisionHistorySessionPrefix(sessionId: string): string {
  const encodedSessionTuple = canonicalizeJson([sessionId]);
  return `${encodedSessionTuple.slice(0, -1)},`;
}

function assertSyntheticClientLabel(session: SemanticInterviewSession): void {
  if (!/^synthetic(?:\s|[-_])/i.test(session.clientLabel)) {
    throw new Error('Synthetic portable restore accepts synthetic-labelled sessions only.');
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, INDEXED_DB_LAYOUT_VERSION);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SESSIONS_STORE)) {
        db.createObjectStore(SESSIONS_STORE, { keyPath: 'sessionId' });
      }
      if (!db.objectStoreNames.contains(LEGACY_ARCHIVE_STORE)) {
        db.createObjectStore(LEGACY_ARCHIVE_STORE);
      }
      if (!db.objectStoreNames.contains(REVISION_HISTORY_STORE)) {
        db.createObjectStore(REVISION_HISTORY_STORE);
      }
      if (((event as IDBVersionChangeEvent | undefined)?.oldVersion ?? 0) < 3
        && db.objectStoreNames.contains(SESSIONS_STORE)) {
        const cursorRequest = request.transaction?.objectStore(SESSIONS_STORE).openCursor();
        if (cursorRequest) {
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (!cursor) return;
            const row = cursor.value as Record<string, unknown>;
            if (row.sessionSchemaVersion === '1.2.0' && typeof row.sessionId === 'string') {
              if (typeof row.revisionId !== 'string' || !row.revisionId.trim()) row.revisionId = crypto.randomUUID();
              if (row.parentRevisionId === undefined) row.parentRevisionId = null;
              cursor.update(row);
            }
            cursor.continue();
          };
        }
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Unable to open local storage.'));
  });
}

type PreparedImport = {
  archive: PortableRevisionArchive;
  head: SemanticInterviewSession;
  historyRows: ReadonlyArray<{ key: string; record: SemanticInterviewSession }>;
};

async function prepareSyntheticImport(
  untrustedArchiveJson: string,
  scope?: PortableRestorePreflightScope,
): Promise<PreparedImport | SyntheticPortableRestoreRejected> {
  const plan = await planFreshOriginPortableRestoreDryRun(untrustedArchiveJson, scope);
  if (!plan.headImportFeasible) {
    return {
      kind: 'rejected',
      code: 'preflight-reject',
      reason: `Portable restore preflight blocked import: ${plan.verdict}.`,
    };
  }
  const archive = await validatePortableRevisionArchiveJson(untrustedArchiveJson);
  const byRevision = new Map<string, SemanticInterviewSession>();
  for (const revision of archive.revisions) {
    const session = await validateSemanticSessionRecord(revision.record);
    assertSyntheticClientLabel(session);
    if (session.sessionId !== archive.sessionId) {
      throw new Error('Archive revision session identity does not match the envelope.');
    }
    byRevision.set(revision.revisionId, session);
  }
  const head = byRevision.get(archive.headRevisionId);
  if (!head) throw new Error('Archive head revision is missing from validated records.');
  const historyRows = archive.revisions
    .filter((row) => row.revisionId !== archive.headRevisionId)
    .map((row) => {
      const record = byRevision.get(row.revisionId);
      if (!record) throw new Error('Archive history revision is missing from validated records.');
      return {
        key: revisionHistoryKey(archive.sessionId, row.revisionId),
        record,
      };
    });
  return { archive, head, historyRows };
}

async function verifyPostCommit(
  db: IDBDatabase,
  prepared: PreparedImport,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  return new Promise((resolve) => {
    const tx = db.transaction([SESSIONS_STORE, REVISION_HISTORY_STORE], 'readonly');
    let failure: string | null = null;
    const fail = (reason: string) => {
      if (failure !== null) return;
      failure = reason;
    };
    tx.oncomplete = () => resolve(failure === null ? { ok: true } : { ok: false, reason: failure });
    tx.onerror = () => resolve({ ok: false, reason: 'Post-commit verification transaction failed.' });
    tx.onabort = () => resolve({ ok: false, reason: 'Post-commit verification transaction aborted.' });

    const sessions = tx.objectStore(SESSIONS_STORE);
    const history = tx.objectStore(REVISION_HISTORY_STORE);
    const headRequest = sessions.get(prepared.archive.sessionId);
    headRequest.onerror = () => fail('Could not read imported head row.');
    headRequest.onsuccess = () => {
      try {
        if (headRequest.result === undefined) {
          fail('Imported head row is missing after commit.');
          return;
        }
        if (canonicalizeJson(headRequest.result) !== canonicalizeJson(prepared.head)) {
          fail('Imported head row does not match validated archive head.');
          return;
        }
        for (const row of prepared.historyRows) {
          const request = history.get(row.key);
          request.onerror = () => fail(`Could not read imported history row ${row.key}.`);
          request.onsuccess = () => {
            if (request.result === undefined) {
              fail(`Imported history row ${row.key} is missing after commit.`);
              return;
            }
            if (canonicalizeJson(request.result) !== canonicalizeJson(row.record)) {
              fail(`Imported history row ${row.key} does not match validated archive record.`);
            }
          };
        }
      } catch (error) {
        fail(error instanceof Error ? error.message : 'Post-commit verification failed.');
      }
    };
  });
}

function commitPreparedImport(
  db: IDBDatabase,
  prepared: PreparedImport,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction([SESSIONS_STORE, REVISION_HISTORY_STORE], 'readwrite', { durability: 'strict' });
    } catch {
      reject(new SyntheticPortableRestoreTransactionError('Strict local transaction durability unavailable.'));
      return;
    }
    if (tx.durability !== 'strict') {
      try { tx.abort(); } catch { /* no writes queued yet */ }
      reject(new SyntheticPortableRestoreTransactionError('Strict local transaction durability unverified.'));
      return;
    }

    let failure: unknown = null;
    const abort = (error: unknown): void => {
      if (failure !== null) return;
      failure = error;
      try { tx.abort(); } catch { /* already finished */ }
    };

    tx.oncomplete = () => (failure === null ? resolve() : reject(failure));
    tx.onerror = () => {
      if (failure === null) failure = tx.error ?? new SyntheticPortableRestoreTransactionError('Import transaction failed.');
    };
    tx.onabort = () => reject(failure ?? tx.error ?? new SyntheticPortableRestoreTransactionError('Import transaction aborted.'));

    const sessions = tx.objectStore(SESSIONS_STORE);
    const history = tx.objectStore(REVISION_HISTORY_STORE);
    const sessionId = prepared.archive.sessionId;
    const queueWrites = (): void => {
      const headPut = sessions.put(structuredClone(prepared.head));
      headPut.onerror = () => abort(headPut.error ?? new SyntheticPortableRestoreTransactionError('Unable to write imported head.'));
      for (const row of prepared.historyRows) {
        const put = history.put(structuredClone(row.record), row.key);
        put.onerror = () => abort(put.error ?? new SyntheticPortableRestoreTransactionError('Unable to write imported history row.'));
      }
    };

    const current = sessions.get(sessionId);
    current.onerror = () => abort(current.error ?? new SyntheticPortableRestoreTransactionError('Could not inspect destination session row.'));
    current.onsuccess = () => {
      if (current.result !== undefined) {
        abort(new SyntheticPortableRestoreCollisionError('session-exists', 'Destination session already exists; import aborted.'));
        return;
      }
      const prefix = revisionHistorySessionPrefix(sessionId);
      const range = IDBKeyRange.bound(prefix, `${prefix}\uffff`);
      const cursor = history.openCursor(range);
      cursor.onerror = () => abort(cursor.error ?? new SyntheticPortableRestoreTransactionError('Could not inspect revision history.'));
      cursor.onsuccess = () => {
        const row = cursor.result;
        if (row) {
          abort(new SyntheticPortableRestoreCollisionError('orphan-history', 'Destination has orphan revision history; import aborted.'));
          return;
        }
        queueWrites();
      };
    };
  });
}

/**
 * Import a validated complete-to-root portable archive into an empty local slot.
 * Call only from synthetic test harnesses with the explicit test-only capability token.
 */
export async function importSyntheticPortableArchiveFreshOrigin(
  request: SyntheticPortableRestoreRequest,
): Promise<SyntheticPortableRestoreOutcome> {
  if (request.testOnlyCapability !== SYNTHETIC_PORTABLE_RESTORE_TEST_CAPABILITY) {
    return {
      kind: 'rejected',
      code: 'invalid-request',
      reason: 'Synthetic portable restore requires the explicit test-only capability token.',
    };
  }
  if (typeof request.untrustedArchiveJson !== 'string' || request.untrustedArchiveJson.length === 0) {
    return {
      kind: 'rejected',
      code: 'invalid-request',
      reason: 'Portable restore input must be a nonempty archive JSON string.',
    };
  }
  let prepared: PreparedImport;
  try {
    const outcome = await prepareSyntheticImport(request.untrustedArchiveJson, request.scope);
    if ('kind' in outcome && outcome.kind === 'rejected') return outcome;
    prepared = outcome as PreparedImport;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Portable restore validation failed.';
    if (message.includes('synthetic-labelled')) {
      return { kind: 'rejected', code: 'synthetic-guard', reason: message };
    }
    return { kind: 'rejected', code: 'preflight-reject', reason: message };
  }

  const db = await openDb();
  try {
    try {
      await commitPreparedImport(db, prepared);
    } catch (error) {
      if (error instanceof SyntheticPortableRestoreCollisionError) throw error;
      if (error instanceof SyntheticPortableRestoreTransactionError) {
        if (error.message.includes('durability')) {
          return { kind: 'rejected', code: 'durability-unavailable', reason: error.message };
        }
      }
      throw error;
    }

    const verified = await verifyPostCommit(db, prepared);
    if (!verified.ok) {
      return {
        kind: 'committed-unverified',
        sessionId: prepared.archive.sessionId,
        headRevisionId: prepared.archive.headRevisionId,
        reason: verified.reason,
      };
    }

    return {
      kind: 'imported',
      sessionId: prepared.archive.sessionId,
      headRevisionId: prepared.archive.headRevisionId,
      retainedRevisionCount: prepared.archive.revisions.length,
    };
  } finally {
    db.close();
  }
}

/** Test helper: canonical archive JSON string for round-trip assertions. */
export function portableArchiveJsonForTests(archive: PortableRevisionArchive): string {
  return serializePortableRevisionArchive(archive);
}

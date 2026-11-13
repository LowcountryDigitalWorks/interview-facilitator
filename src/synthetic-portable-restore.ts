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
import {
  validateSemanticSessionRecord,
  type SemanticInterviewSession,
} from './semantic-session';
import {
  REVISION_HISTORY_STORE,
  SESSIONS_STORE,
  openInterviewFacilitatorIndexedDb,
  revisionHistoryKey,
} from './storage';

/**
 * E1 / #35 — SYNTHETIC-ONLY, test-harness fresh-origin transactional import.
 * No UI route, no customer import, no provider/Drive, no 1.4 activation.
 * Unkeyed archive checksum is not authenticity or tamper-evidence.
 */
export const SYNTHETIC_PORTABLE_RESTORE_TEST_CAPABILITY =
  'ldw.synthetic-portable-restore-test-only.v1' as const;

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

export type SyntheticPortableRestoreRejectedCode =
  | 'invalid-request'
  | 'preflight-reject'
  | 'synthetic-guard'
  | 'durability-unavailable'
  | 'session-exists'
  | 'orphan-history';

export type SyntheticPortableRestoreRejected = {
  kind: 'rejected';
  code: SyntheticPortableRestoreRejectedCode;
  reason: string;
};

export type SyntheticPortableRestoreOutcome =
  | SyntheticPortableRestoreSuccess
  | SyntheticPortableRestoreCommittedUnverified
  | SyntheticPortableRestoreRejected;

export class SyntheticPortableRestoreTransactionError extends Error {
  readonly name = 'SyntheticPortableRestoreTransactionError';
  constructor(message: string) {
    super(message);
  }
}

/** One-shot test harness hook: forces the next post-commit readback to fail after a successful commit. */
let testOnlyPostCommitReadbackFailure: string | null = null;

export function armSyntheticPortableRestorePostCommitReadbackFailureForTests(reason: string): void {
  testOnlyPostCommitReadbackFailure = reason;
}

export function clearSyntheticPortableRestoreTestArmsForTests(): void {
  testOnlyPostCommitReadbackFailure = null;
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

type PreparedImport = {
  archive: PortableRevisionArchive;
  head: SemanticInterviewSession;
  historyRows: ReadonlyArray<{ key: string; record: SemanticInterviewSession }>;
};

type CommitPreparedImportResult =
  | { status: 'committed' }
  | { status: 'collision'; code: 'session-exists' | 'orphan-history'; reason: string };

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
  if (testOnlyPostCommitReadbackFailure !== null) {
    const reason = testOnlyPostCommitReadbackFailure;
    testOnlyPostCommitReadbackFailure = null;
    return { ok: false, reason };
  }
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
): Promise<CommitPreparedImportResult> {
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
    let collision: { code: 'session-exists' | 'orphan-history'; reason: string } | null = null;

    const abortFailure = (error: unknown): void => {
      if (failure !== null || collision !== null) return;
      failure = error;
      try { tx.abort(); } catch { /* already finished */ }
    };

    const abortCollision = (code: 'session-exists' | 'orphan-history', reason: string): void => {
      if (failure !== null || collision !== null) return;
      collision = { code, reason };
      try { tx.abort(); } catch { /* already finished */ }
    };

    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (collision !== null) {
        resolve({ status: 'collision', code: collision.code, reason: collision.reason });
        return;
      }
      if (failure !== null) reject(failure);
      else resolve({ status: 'committed' });
    };

    tx.oncomplete = finish;
    tx.onerror = () => {
      if (collision !== null) return;
      if (failure === null) failure = tx.error ?? new SyntheticPortableRestoreTransactionError('Import transaction failed.');
    };
    tx.onabort = () => {
      if (collision !== null) finish();
      else reject(failure ?? tx.error ?? new SyntheticPortableRestoreTransactionError('Import transaction aborted.'));
    };

    const sessions = tx.objectStore(SESSIONS_STORE);
    const history = tx.objectStore(REVISION_HISTORY_STORE);
    const sessionId = prepared.archive.sessionId;
    const queueWrites = (): void => {
      const headPut = sessions.put(structuredClone(prepared.head));
      headPut.onerror = () => abortFailure(headPut.error ?? new SyntheticPortableRestoreTransactionError('Unable to write imported head.'));
      for (const row of prepared.historyRows) {
        const put = history.put(structuredClone(row.record), row.key);
        put.onerror = () => abortFailure(put.error ?? new SyntheticPortableRestoreTransactionError('Unable to write imported history row.'));
      }
    };

    const current = sessions.get(sessionId);
    current.onerror = () => abortFailure(current.error ?? new SyntheticPortableRestoreTransactionError('Could not inspect destination session row.'));
    current.onsuccess = () => {
      if (current.result !== undefined) {
        abortCollision('session-exists', 'Destination session already exists; import aborted.');
        return;
      }
      const prefix = revisionHistorySessionPrefix(sessionId);
      const range = IDBKeyRange.bound(prefix, `${prefix}\uffff`);
      const cursor = history.openCursor(range);
      cursor.onerror = () => abortFailure(cursor.error ?? new SyntheticPortableRestoreTransactionError('Could not inspect revision history.'));
      cursor.onsuccess = () => {
        const row = cursor.result;
        if (row) {
          abortCollision('orphan-history', 'Destination has orphan revision history; import aborted.');
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

  const db = await openInterviewFacilitatorIndexedDb();
  try {
    let commit: CommitPreparedImportResult;
    try {
      commit = await commitPreparedImport(db, prepared);
    } catch (error) {
      if (error instanceof SyntheticPortableRestoreTransactionError) {
        if (error.message.includes('durability')) {
          return { kind: 'rejected', code: 'durability-unavailable', reason: error.message };
        }
      }
      throw error;
    }

    if (commit.status === 'collision') {
      return {
        kind: 'rejected',
        code: commit.code,
        reason: commit.reason,
      };
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

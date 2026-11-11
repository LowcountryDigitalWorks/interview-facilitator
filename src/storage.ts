import type { InterviewSession } from './domain';
import {
  SEMANTIC_13_TO_KNOWN_FACT_14_MIGRATION_ID,
  planKnownFactMigration,
  validateKnownFactSession14Record,
  type KnownFactMigrationPlan,
  type KnownFactSession14,
} from './known-fact-session';
import { canonicalizeJson, validateSessionRecord } from './pack-identity';
import { auditRetainedLocalRevisionsForReview, type LocalRevisionContinuityReport } from './local-revision-continuity';
import {
  INDEXED_DB_LAYOUT_VERSION,
  LEGACY_TO_PINNED_MIGRATION_ID,
  PINNED_11_TO_12_MIGRATION_ID,
  legacyArchiveKey,
  planCurrentMigration,
} from './session-migration';
import {
  PINNED_12_TO_13_MIGRATION_ID,
  planSemanticMigration,
  validateSemanticSessionRecord,
  type SemanticInterviewSession,
} from './semantic-session';

const DB_NAME = 'ldw-interview-facilitator';
export const SESSIONS_STORE = 'sessions';
export const LEGACY_ARCHIVE_STORE = 'legacy-session-archive';
export const REVISION_HISTORY_STORE = 'revision-history';
const STORE = SESSIONS_STORE;
const DB_VERSION = INDEXED_DB_LAYOUT_VERSION;
const MAX_RECOVERY_STRING_BYTES = 256_000;
const MAX_RECOVERY_TOTAL_STRING_BYTES = 1_000_000;
const MAX_RECOVERY_OUTPUT_BYTES = 2_000_000;

export type StoredSessionList = {
  sessions: SemanticInterviewSession[];
  unreadableCount: number;
  rows?: ClassifiedStoredRow[];
};

export type ClassifiedStoredRow =
  | { sessionId: string; classification: 'current'; raw: unknown; session: SemanticInterviewSession }
  | { sessionId: string; classification: 'current-known-fact-14'; raw: unknown; session: KnownFactSession14 }
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
      // A valid 1.4 row is readable for safe listing/backup, but is not a
      // live 1.3 editable session. Keep it out of sessions[] until the 1.4
      // active editor and import paths are independently accepted.
      if (candidate?.sessionSchemaVersion === '1.4.0') {
        try {
          const session = await validateKnownFactSession14Record(raw);
          if (session.sessionId !== sessionId) throw new Error('Stored 1.4 identity mismatch.');
          classified.push({ sessionId, classification: 'current-known-fact-14', raw, session });
        } catch {
          let recoveryAvailable = false;
          if (hasStableRecoveryIdentity(raw)) {
            try { buildRecoveryBackup(raw); recoveryAvailable = true; } catch { /* preserve source unchanged */ }
          }
          classified.push({ sessionId, classification: 'malformed-unreadable', reason: 'Stored 1.4 interview is invalid.', recoveryAvailable });
        }
        continue;
      }
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
    request.onupgradeneeded = (event) => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'sessionId' });
      if (!db.objectStoreNames.contains(LEGACY_ARCHIVE_STORE)) db.createObjectStore(LEGACY_ARCHIVE_STORE);
      if (!db.objectStoreNames.contains(REVISION_HISTORY_STORE)) db.createObjectStore(REVISION_HISTORY_STORE);
      if (((event as IDBVersionChangeEvent | undefined)?.oldVersion ?? 0) < 3 && db.objectStoreNames.contains(STORE)) {
        const cursorRequest = request.transaction?.objectStore(STORE).openCursor();
        if (cursorRequest) cursorRequest.onsuccess = () => {
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

export class RevisionConflictError extends Error {
  readonly name = 'RevisionConflictError';
  constructor(readonly sessionId: string, readonly expectedRevisionId: string | null, readonly actualRevisionId: string | null) {
    super(`Session ${sessionId} changed in another tab. Reload or fork before saving.`);
  }
}

export class RevisionHistoryConflictError extends Error {
  readonly name = 'RevisionHistoryConflictError';
  constructor(message: string) {
    super(message);
  }
}

export function revisionHistoryKey(sessionId: string, revisionId: string): string {
  return canonicalizeJson([sessionId, revisionId]);
}

function revisionHistorySessionPrefix(sessionId: string): string {
  const encodedSessionTuple = canonicalizeJson([sessionId]);
  return `${encodedSessionTuple.slice(0, -1)},`;
}

export async function replaceSessionWithHistory(imported: SemanticInterviewSession, expectedRevisionId: string): Promise<SemanticInterviewSession> {
  await validateSemanticSessionRecord(imported);
  const db = await openDb();
  try {
    const rawCurrent = await requestResult(db.transaction(STORE, 'readonly').objectStore(STORE).get(imported.sessionId));
    if (rawCurrent === undefined) throw new RevisionConflictError(imported.sessionId, expectedRevisionId, null);
    const validatedCurrent = await validateSemanticSessionRecord(rawCurrent);
    if (validatedCurrent.revisionId !== expectedRevisionId) {
      throw new RevisionConflictError(imported.sessionId, expectedRevisionId, validatedCurrent.revisionId);
    }
    const currentFingerprint = canonicalizeJson(validatedCurrent);
    const next: SemanticInterviewSession = {
      ...structuredClone(imported),
      revisionId: crypto.randomUUID(),
      parentRevisionId: expectedRevisionId,
    };

    return await new Promise<SemanticInterviewSession>((resolve, reject) => {
      const tx = openTransaction(db, [STORE, REVISION_HISTORY_STORE], 'readwrite');
      const currentStore = tx.objectStore(STORE);
      const historyStore = tx.objectStore(REVISION_HISTORY_STORE);
      let failure: unknown = null;
      const fail = (error: unknown) => {
        if (failure !== null) return;
        failure = error;
        try { tx.abort(); } catch { /* transaction is already finished */ }
      };
      tx.oncomplete = () => failure === null ? resolve(next) : reject(failure);
      tx.onerror = () => {
        if (failure === null) failure = tx.error ?? new Error('Unable to replace local session.');
      };
      tx.onabort = () => reject(failure ?? tx.error ?? new Error('Local replacement was aborted.'));

      const currentRequest = currentStore.get(imported.sessionId);
      currentRequest.onerror = () => fail(currentRequest.error ?? new Error('Unable to verify the current revision.'));
      currentRequest.onsuccess = () => {
        try {
          const currentRaw = currentRequest.result as Record<string, unknown> | undefined;
          const actualRevisionId = typeof currentRaw?.revisionId === 'string' ? currentRaw.revisionId : null;
          if (actualRevisionId !== expectedRevisionId) {
            fail(new RevisionConflictError(imported.sessionId, expectedRevisionId, actualRevisionId));
            return;
          }
          if (canonicalizeJson(currentRaw) !== currentFingerprint) {
            fail(new RevisionHistoryConflictError('The current session changed without a matching revision advance. Replacement was stopped.'));
            return;
          }

          const historyKey = revisionHistoryKey(imported.sessionId, expectedRevisionId);
          const historyRequest = historyStore.get(historyKey);
          historyRequest.onerror = () => fail(historyRequest.error ?? new Error('Unable to verify revision history.'));
          historyRequest.onsuccess = () => {
            try {
              if (historyRequest.result !== undefined) {
                if (canonicalizeJson(historyRequest.result) !== currentFingerprint) {
                  fail(new RevisionHistoryConflictError('Revision history already contains different data for this revision.'));
                  return;
                }
              } else {
                const historyPut = historyStore.put(structuredClone(validatedCurrent), historyKey);
                historyPut.onerror = () => fail(historyPut.error ?? new Error('Unable to retain the prior revision.'));
              }
              const currentPut = currentStore.put(next);
              currentPut.onerror = () => fail(currentPut.error ?? new Error('Unable to write the replacement revision.'));
            } catch (error) {
              fail(error);
            }
          };
        } catch (error) {
          fail(error);
        }
      };
    });
  } finally {
    db.close();
  }
}

/**
 * #105 SYNTHETIC-ONLY explicit human client-statement save.
 *
 * This is NOT the normal autosave writer and NOT a provider/client adapter.
 * The complete canonical source must match the stored IDB row in one strict
 * native transaction. Archive the exact old row and replace with the already
 * independently validated proposed revision atomically, or return null stale.
 * Never use this demo gate as proof of real client identity or consent.
 */
export async function compareAndSaveSyntheticConfirmedStatement(
  sessionId: string,
  expectedCanonical: string,
  proposed: SemanticInterviewSession,
): Promise<SemanticInterviewSession | null> {
  if (typeof expectedCanonical !== 'string' || expectedCanonical.length < 1
    || expectedCanonical.length > 2_000_000) {
    throw new Error('Synthetic confirmation requires bounded canonical input.');
  }
  let expected: SemanticInterviewSession;
  try {
    expected = await validateSemanticSessionRecord(JSON.parse(expectedCanonical));
  } catch {
    throw new Error('Synthetic confirmation source is invalid.');
  }
  await validateSemanticSessionRecord(proposed);
  const synthetic = (label: string) => /^synthetic(?:\s|[-_])/i.test(label);
  if (!synthetic(expected.clientLabel) || !synthetic(proposed.clientLabel)
    || expected.sessionId !== sessionId || proposed.sessionId !== sessionId
    || expected.sessionSchemaVersion !== '1.3.0' || proposed.sessionSchemaVersion !== '1.3.0'
    || canonicalizeJson(expected) !== expectedCanonical
    || proposed.parentRevisionId !== expected.revisionId
    || proposed.revisionId === expected.revisionId
    || Date.parse(proposed.updatedAt) < Date.parse(expected.updatedAt)) {
    throw new Error('Synthetic confirmation identity or revision is invalid.');
  }

  // Enforce a SINGLE independently client-entered answer change. The source,
  // pack, other answers, notes, facts, follow-ups and metadata remain exact.
  const changed = Object.keys(expected.answers).filter(
    key => canonicalizeJson(expected.answers[key]) !== canonicalizeJson(proposed.answers[key]),
  );
  if (changed.length !== 1) throw new Error('Synthetic confirmation must modify exactly one answer.');
  const questionId = changed[0]!;
  const before = expected.answers[questionId]!;
  const after = proposed.answers[questionId]!;
  if (!before || !after || before.value !== null || before.resolution !== 'unresolved'
    || before.source !== null || before.confirmation !== null || before.needsConfirmation
    || before.followUp !== null || typeof after.value !== 'string' || !after.value.trim()
    || after.resolution !== 'captured' || after.source !== 'client-statement'
    || after.needsConfirmation !== false || after.confirmation !== null) {
    throw new Error('Synthetic confirmation cannot overwrite prior or sourced evidence.');
  }
  const onlyAllowed = structuredClone(expected);
  onlyAllowed.answers[questionId] = {
    ...before, value: after.value, resolution: 'captured',
    source: 'client-statement', needsConfirmation: false, confirmation: null,
  };
  onlyAllowed.parentRevisionId = expected.revisionId;
  onlyAllowed.revisionId = proposed.revisionId;
  onlyAllowed.updatedAt = proposed.updatedAt;
  if (canonicalizeJson(onlyAllowed) !== canonicalizeJson(proposed)) {
    throw new Error('Synthetic confirmation changed unrelated interview data.');
  }

  const db = await openDb();
  try {
    return await new Promise<SemanticInterviewSession | null>((resolve, reject) => {
      // This explicit, human-attested confirmation must never silently
      // downgrade to browser-default durability. On unsupported/ignored strict
      // options refuse BEFORE any row or revision-history write is requested.
      let tx: IDBTransaction;
      try {
        tx = db.transaction([STORE, REVISION_HISTORY_STORE], 'readwrite', { durability: 'strict' });
      } catch {
        reject(new Error('Strict local transaction durability unavailable; no confirmation was saved.'));
        return;
      }
      if (tx.durability !== 'strict') {
        try { tx.abort(); } catch { /* no writes were requested */ }
        reject(new Error('Strict local transaction durability unverified; no confirmation was saved.'));
        return;
      }
      const sessions = tx.objectStore(STORE);
      const history = tx.objectStore(REVISION_HISTORY_STORE);
      let result: SemanticInterviewSession | null = null;
      let failure: unknown = null;
      const abort = (reason: unknown): void => {
        if (failure !== null) return;
        failure = reason;
        try { tx.abort(); } catch { /* already finished */ }
      };
      tx.oncomplete = () => failure === null ? resolve(result) : reject(failure);
      tx.onerror = () => {
        if (failure === null) failure = tx.error ?? new Error('Synthetic local confirmation failed.');
      };
      tx.onabort = () => reject(failure ?? tx.error ?? new Error('Synthetic local confirmation aborted.'));

      const current = sessions.get(sessionId);
      current.onerror = () => abort(current.error ?? new Error('Could not verify local interview.'));
      current.onsuccess = () => {
        try {
          const raw = current.result as Record<string, unknown> | undefined;
          // A changed (or absent) row is an ordinary stale result, NO write.
          if (raw === undefined || canonicalizeJson(raw) !== expectedCanonical) return;
          const key = revisionHistoryKey(sessionId, expected.revisionId);
          const check = history.get(key);
          check.onerror = () => abort(check.error ?? new Error('Could not verify revision history.'));
          check.onsuccess = () => {
            try {
              if (check.result !== undefined) {
                if (canonicalizeJson(check.result) !== expectedCanonical) {
                  abort(new RevisionHistoryConflictError('Synthetic prior revision history differs.'));
                  return;
                }
              } else {
                const archive = history.put(structuredClone(expected), key);
                archive.onerror = () => abort(archive.error ?? new Error('Could not archive prior revision.'));
              }
              const write = sessions.put(structuredClone(proposed));
              write.onerror = () => abort(write.error ?? new Error('Could not save client-confirmed revision.'));
              result = structuredClone(proposed);
            } catch (error) {
              abort(error);
            }
          };
        } catch (error) {
          abort(error);
        }
      };
    });
  } finally {
    db.close();
  }
}

export async function saveSession(session: SemanticInterviewSession, expectedRevisionId: string | null): Promise<SemanticInterviewSession> {
  await validateSemanticSessionRecord(session);
  const db = await openDb();
  try {
    const next: SemanticInterviewSession = {
      ...structuredClone(session),
      revisionId: crypto.randomUUID(),
      parentRevisionId: expectedRevisionId,
    };
    await new Promise<void>((resolve, reject) => {
      const tx = writeTransaction(db);
      const store = tx.objectStore(STORE);
      let conflict: Error | null = null;
      const currentRequest = store.get(session.sessionId);
      currentRequest.onsuccess = () => {
        const current = currentRequest.result as { revisionId?: unknown; sessionSchemaVersion?: unknown } | undefined;
        // Never let the active 1.3 writer silently replace an already migrated 1.4 row.
        if (current !== undefined && current.sessionSchemaVersion !== '1.3.0') {
          conflict = new Error('The 1.3 writer cannot overwrite a different session schema version.');
          return;
        }
        const actualRevisionId = typeof current?.revisionId === 'string' ? current.revisionId : null;
        if (actualRevisionId !== expectedRevisionId) {
          conflict = new RevisionConflictError(session.sessionId, expectedRevisionId, actualRevisionId);
          return;
        }
        store.put(next);
      };
      currentRequest.onerror = () => { try { tx.abort(); } catch { /* transaction is already finished */ } };
      tx.oncomplete = () => conflict ? reject(conflict) : resolve();
      tx.onerror = () => reject(tx.error ?? new Error('Unable to save session.'));
      tx.onabort = () => reject(tx.error ?? new Error('Local save was aborted.'));
    });
    return next;
  } finally {
    db.close();
  }
}


/**
 * #34A2B2A — internal typed 1.4 read/save adapter.
 * No caller in the live UI is permitted until version-aware import, export,
 * list and edit flows are independently accepted. The current 1.3 writer
 * deliberately remains separate and must never downgrade a 1.4 row.
 */
export async function loadKnownFactSession14ForReview(sessionId: string): Promise<KnownFactSession14 | undefined> {
  const db = await openDb();
  try {
    const raw = await requestResult(db.transaction(STORE, 'readonly').objectStore(STORE).get(sessionId));
    if (raw === undefined) return undefined;
    const validated = await validateKnownFactSession14Record(raw);
    if (validated.sessionId !== sessionId) throw new Error('Loaded known-fact session identity does not match its storage key.');
    return validated;
  } finally {
    db.close();
  }
}

function assertKnownFactRevisionIsAppendOnly(previous: KnownFactSession14, next: KnownFactSession14): void {
  if (previous.sessionId !== next.sessionId
    || previous.createdAt !== next.createdAt
    || previous.interviewPackId !== next.interviewPackId
    || previous.interviewPackVersion !== next.interviewPackVersion
    || canonicalizeJson(previous.packSnapshot) !== canonicalizeJson(next.packSnapshot)
    || canonicalizeJson(previous.packIdentity) !== canonicalizeJson(next.packIdentity)
    || canonicalizeJson(previous.knownFacts) !== canonicalizeJson(next.knownFacts)) {
    throw new RevisionHistoryConflictError('Known-fact source identity and pinned pack must remain immutable.');
  }
  const priorFacts = previous.knownFactLedger.facts;
  const priorAcceptances = previous.knownFactLedger.acceptances;
  const nextFacts = next.knownFactLedger.facts;
  const nextAcceptances = next.knownFactLedger.acceptances;
  if (nextFacts.length < priorFacts.length || nextAcceptances.length < priorAcceptances.length
    || canonicalizeJson(nextFacts.slice(0, priorFacts.length)) !== canonicalizeJson(priorFacts)
    || canonicalizeJson(nextAcceptances.slice(0, priorAcceptances.length)) !== canonicalizeJson(priorAcceptances)) {
    throw new RevisionHistoryConflictError('Known-fact source/correction/acceptance evidence is append-only.');
  }
  // An acceptance appended in this save must testify to the CAS-verified
  // source revision, never an arbitrary caller-supplied revision identity.
  if (nextAcceptances.slice(priorAcceptances.length)
    .some((acceptance) => acceptance.revisionId !== previous.revisionId)) {
    throw new RevisionHistoryConflictError('New known-fact acceptance must reference the current source revision.');
  }
}

/**
 * Internal-only 1.4 save: validates both schema and append-only provenance,
 * then CAS-checks current content and atomically archives the prior revision.
 * If a 1.3 row is still present, this refuses to upgrade or overwrite it:
 * only the reviewed 1.3→1.4 migration gate is allowed to perform that step.
 */
export async function saveKnownFactSession14ForReview(
  session: KnownFactSession14,
  expectedRevisionId: string | null,
): Promise<KnownFactSession14> {
  await validateKnownFactSession14Record(session);
  const db = await openDb();
  try {
    const previousRaw = await requestResult(db.transaction(STORE, 'readonly').objectStore(STORE).get(session.sessionId));
    let previous: KnownFactSession14 | null = null;
    let fingerprint: string | null = null;
    if (previousRaw !== undefined) {
      if (expectedRevisionId === null) {
        const raw = previousRaw as { revisionId?: unknown };
        throw new RevisionConflictError(
          session.sessionId, expectedRevisionId,
          typeof raw?.revisionId === 'string' ? raw.revisionId : null,
        );
      }
      previous = await validateKnownFactSession14Record(previousRaw);
      if (previous.sessionId !== session.sessionId) {
        throw new RevisionHistoryConflictError('Stored 1.4 identity does not match its key.');
      }
      if (previous.revisionId !== expectedRevisionId) {
        throw new RevisionConflictError(session.sessionId, expectedRevisionId, previous.revisionId);
      }
      if (session.revisionId !== expectedRevisionId) {
        throw new RevisionConflictError(session.sessionId, expectedRevisionId, session.revisionId);
      }
      assertKnownFactRevisionIsAppendOnly(previous, session);
      fingerprint = canonicalizeJson(previousRaw);
    } else if (expectedRevisionId !== null) {
      throw new RevisionConflictError(session.sessionId, expectedRevisionId, null);
    } else if (session.knownFactLedger.acceptances.length > 0) {
      // There is no CAS-verified prior revision for a brand-new record.
      throw new RevisionHistoryConflictError('New 1.4 sessions cannot invent pre-persistence acceptance events.');
    }

    const next: KnownFactSession14 = {
      ...structuredClone(session),
      revisionId: crypto.randomUUID(),
      parentRevisionId: expectedRevisionId,
    };
    await validateKnownFactSession14Record(next);

    return await new Promise<KnownFactSession14>((resolve, reject) => {
      const tx = openTransaction(db, [STORE, REVISION_HISTORY_STORE], 'readwrite');
      const currentStore = tx.objectStore(STORE);
      const historyStore = tx.objectStore(REVISION_HISTORY_STORE);
      let failure: unknown = null;
      const fail = (error: unknown): void => {
        if (failure !== null) return;
        failure = error;
        try { tx.abort(); } catch { /* transaction already finished */ }
      };
      tx.oncomplete = () => failure === null ? resolve(next) : reject(failure);
      tx.onerror = () => { if (failure === null) failure = tx.error ?? new Error('Unable to save known-fact session.'); };
      tx.onabort = () => reject(failure ?? tx.error ?? new Error('Known-fact save was aborted.'));
      const currentRequest = currentStore.get(session.sessionId);
      currentRequest.onerror = () => fail(currentRequest.error ?? new Error('Unable to read current known-fact revision.'));
      currentRequest.onsuccess = () => {
        try {
          const current = currentRequest.result as { revisionId?: unknown; sessionSchemaVersion?: unknown } | undefined;
          const actualId = typeof current?.revisionId === 'string' ? current.revisionId : null;
          if ((current !== undefined && current.sessionSchemaVersion !== '1.4.0')
            || (current !== undefined && expectedRevisionId === null)
            || actualId !== expectedRevisionId) {
            fail(new RevisionConflictError(session.sessionId, expectedRevisionId, actualId));
            return;
          }
          if (previous !== null && canonicalizeJson(current) !== fingerprint) {
            fail(new RevisionHistoryConflictError('Known-fact session changed without a corresponding revision advance.'));
            return;
          }
          if (previous === null) {
            const put = currentStore.put(next);
            put.onerror = () => fail(put.error ?? new Error('Unable to create known-fact session.'));
            return;
          }
          const historyKey = revisionHistoryKey(session.sessionId, expectedRevisionId!);
          const historyRequest = historyStore.get(historyKey);
          historyRequest.onerror = () => fail(historyRequest.error ?? new Error('Unable to inspect known-fact revision history.'));
          historyRequest.onsuccess = () => {
            try {
              if (historyRequest.result !== undefined) {
                if (canonicalizeJson(historyRequest.result) !== fingerprint) {
                  fail(new RevisionHistoryConflictError('A different immutable 1.4 revision already occupies this history key.'));
                  return;
                }
              } else {
                const retain = historyStore.put(structuredClone(previous), historyKey);
                retain.onerror = () => fail(retain.error ?? new Error('Unable to retain immutable 1.4 revision.'));
              }
              const put = currentStore.put(next);
              put.onerror = () => fail(put.error ?? new Error('Unable to write known-fact revision.'));
            } catch (error) {
              fail(error);
            }
          };
        } catch (error) {
          fail(error);
        }
      };
    });
  } finally {
    db.close();
  }
}

export async function deleteSession(sessionId: string, expectedRevisionId: string): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = openTransaction(db, [STORE, REVISION_HISTORY_STORE, LEGACY_ARCHIVE_STORE], 'readwrite');
      const currentStore = tx.objectStore(STORE);
      const historyStore = tx.objectStore(REVISION_HISTORY_STORE);
      const legacyArchiveStore = tx.objectStore(LEGACY_ARCHIVE_STORE);
      let failure: unknown = null;
      const fail = (error: unknown) => {
        if (failure !== null) return;
        failure = error;
        try { tx.abort(); } catch { /* transaction is already finished */ }
      };
      tx.oncomplete = () => failure === null ? resolve() : reject(failure);
      tx.onerror = () => {
        if (failure === null) failure = tx.error ?? new Error('Unable to delete local session.');
      };
      tx.onabort = () => reject(failure ?? tx.error ?? new Error('Local delete was aborted.'));

      const currentRequest = currentStore.get(sessionId);
      currentRequest.onerror = () => fail(currentRequest.error ?? new Error('Unable to verify the current revision before delete.'));
      currentRequest.onsuccess = () => {
        const current = currentRequest.result as { revisionId?: unknown } | undefined;
        const actualRevisionId = typeof current?.revisionId === 'string' ? current.revisionId : null;
        if (actualRevisionId !== expectedRevisionId) {
          fail(new RevisionConflictError(sessionId, expectedRevisionId, actualRevisionId));
          return;
        }
        const deleteCurrent = currentStore.delete(sessionId);
        deleteCurrent.onerror = () => fail(deleteCurrent.error ?? new Error('Unable to delete the current session.'));

        const historyPrefix = revisionHistorySessionPrefix(sessionId);
        const historyRange = IDBKeyRange.bound(historyPrefix, `${historyPrefix}\uffff`);
        const cursorRequest = historyStore.openCursor(historyRange);
        cursorRequest.onerror = () => fail(cursorRequest.error ?? new Error('Unable to delete retained revision history.'));
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) return;
          const deleteHistory = cursor.delete();
          deleteHistory.onerror = () => fail(deleteHistory.error ?? new Error('Unable to delete retained revision history.'));
          cursor.continue();
        };

        const archiveCursorRequest = legacyArchiveStore.openCursor();
        archiveCursorRequest.onerror = () => fail(archiveCursorRequest.error ?? new Error('Unable to delete retained legacy migration archives.'));
        archiveCursorRequest.onsuccess = () => {
          const cursor = archiveCursorRequest.result;
          if (!cursor) return;
          const archived = cursor.value as { sessionId?: unknown } | undefined;
          if (archived?.sessionId === sessionId) {
            const deleteArchive = cursor.delete();
            deleteArchive.onerror = () => fail(deleteArchive.error ?? new Error('Unable to delete retained legacy migration archive.'));
          }
          cursor.continue();
        };
      };
    });
  } finally {
    db.close();
  }
}

export async function loadSession(sessionId: string): Promise<SemanticInterviewSession | undefined> {
  const db = await openDb();
  try {
    const raw = await new Promise<unknown>((resolve, reject) => {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(sessionId);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Unable to load session.'));
    });
    if (raw === undefined) return undefined;
    return await validateSemanticSessionRecord(raw);
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
  | { kind: 'migrated'; session: SemanticInterviewSession }
  | { kind: 'already-migrated'; session: SemanticInterviewSession }
  | { kind: 'missing' | 'stale' | 'aborted' | 'not-legacy' }
  | { kind: 'unsupported' | 'invalid' | 'conflict'; reason: string };

type HistoricalMigrationStepResult =
  | { kind: 'migrated'; session: InterviewSession }
  | { kind: 'stale' | 'aborted' }
  | { kind: 'conflict'; reason: string };

/**
 * Explicit user-triggered upgrade to the live schema. Each accepted transition is committed in
 * its own archive+current transaction: 1.0→1.1, 1.1→1.2, then 1.2→1.3. If a later step fails,
 * the earlier accepted transition and its exact archive remain available for a safe retry.
 */
export async function migrateLegacySession(sessionId: string): Promise<LegacyMigrationResult> {
  const db = await openDb();
  try {
    for (let step = 0; step < 3; step += 1) {
      const raw = await requestResult(db.transaction(STORE, 'readonly').objectStore(STORE).get(sessionId));
      if (raw === undefined) return { kind: 'missing' };
      const plan = await planCurrentMigration(raw);
      if (plan.kind === 'unsupported' || plan.kind === 'invalid') return plan;
      if (plan.kind === 'current') {
        const archiveKey = legacyArchiveKey(sessionId, '1.2.0', PINNED_12_TO_13_MIGRATION_ID);
        const archived = await requestResult(db.transaction(LEGACY_ARCHIVE_STORE, 'readonly').objectStore(LEGACY_ARCHIVE_STORE).get(archiveKey));
        if (archived === undefined) return { kind: 'not-legacy' };
        return await confirmSemanticAlreadyMigrated(db, sessionId);
      }

      if (plan.sourceSchemaVersion === '1.2.0') {
        return await commitSemanticMigrationPlan(db, sessionId, plan as SemanticReadyPlan);
      }

      const historical = await commitHistoricalMigration(
        db,
        sessionId,
        plan.session,
        plan.fingerprint,
        plan.raw,
        plan.sourceSchemaVersion,
        plan.migrationId,
      );
      if (historical.kind !== 'migrated') return historical;
    }
    return { kind: 'aborted' };
  } finally {
    db.close();
  }
}

function commitHistoricalMigration(
  db: IDBDatabase,
  sessionId: string,
  session: InterviewSession,
  fingerprint: string,
  raw: unknown,
  sourceSchemaVersion: string,
  migrationId: string,
): Promise<HistoricalMigrationStepResult> {
  return new Promise((resolve) => {
    const tx = openTransaction(db, [STORE, LEGACY_ARCHIVE_STORE], 'readwrite');
    let settled = false;
    let failure: HistoricalMigrationStepResult | null = null;
    const finish = (result: HistoricalMigrationStepResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const fail = (result: HistoricalMigrationStepResult) => {
      failure = result;
      try { tx.abort(); } catch { /* transaction is already finished */ }
    };
    tx.oncomplete = () => finish({ kind: 'migrated', session });
    tx.onerror = () => { if (failure === null) failure = { kind: 'aborted' }; };
    tx.onabort = () => finish(failure ?? { kind: 'aborted' });
    const currentRequest = tx.objectStore(STORE).get(sessionId);
    currentRequest.onerror = () => fail({ kind: 'aborted' });
    currentRequest.onsuccess = () => {
      try {
        if (currentRequest.result === undefined || canonicalizeJson(currentRequest.result) !== fingerprint) {
          fail({ kind: 'stale' });
          return;
        }
        const key = legacyArchiveKey(sessionId, sourceSchemaVersion, migrationId);
        const archiveStore = tx.objectStore(LEGACY_ARCHIVE_STORE);
        const archiveRequest = archiveStore.get(key);
        archiveRequest.onerror = () => fail({ kind: 'aborted' });
        archiveRequest.onsuccess = () => {
          try {
            if (archiveRequest.result !== undefined) {
              if (canonicalizeJson(archiveRequest.result) !== fingerprint) {
                fail({ kind: 'conflict', reason: 'An existing archive contains different legacy data.' });
                return;
              }
            } else {
              const archivePut = archiveStore.put(structuredClone(raw), key);
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
export type SemanticMigrationResult =
  | { kind: 'migrated'; session: SemanticInterviewSession }
  | { kind: 'already-migrated'; session: SemanticInterviewSession }
  | { kind: 'missing' | 'stale' | 'aborted' }
  | { kind: 'unsupported' | 'invalid' | 'conflict'; reason: string };

/** Direct 1.2→1.3 migration helper retained for focused migration/recovery tests and tooling. */
type SemanticReadyPlan = Extract<Awaited<ReturnType<typeof planSemanticMigration>>, { kind: 'ready' }>;

export async function migrateSession12To13(sessionId: string): Promise<SemanticMigrationResult> {
  const db = await openDb();
  try {
    const raw = await requestResult(db.transaction(STORE, 'readonly').objectStore(STORE).get(sessionId));
    if (raw === undefined) return { kind: 'missing' };
    const plan = await planSemanticMigration(raw);
    if (plan.kind === 'unsupported' || plan.kind === 'invalid') return plan;
    if (plan.kind === 'current') return await confirmSemanticAlreadyMigrated(db, sessionId);
    return await commitSemanticMigrationPlan(db, sessionId, plan);
  } finally {
    db.close();
  }
}

function commitSemanticMigrationPlan(
  db: IDBDatabase,
  sessionId: string,
  plan: SemanticReadyPlan,
): Promise<SemanticMigrationResult> {
  return new Promise((resolve) => {
    const tx = openTransaction(db, [STORE, LEGACY_ARCHIVE_STORE], 'readwrite');
    let failure: SemanticMigrationResult | null = null;
    const fail = (result: SemanticMigrationResult) => {
      if (failure !== null) return;
      failure = result;
      try { tx.abort(); } catch { /* already finished */ }
    };
    tx.oncomplete = () => resolve({ kind: 'migrated', session: plan.session });
    tx.onerror = () => { if (failure === null) failure = { kind: 'aborted' }; };
    tx.onabort = () => resolve(failure ?? { kind: 'aborted' });
    const currentRequest = tx.objectStore(STORE).get(sessionId);
    currentRequest.onerror = () => fail({ kind: 'aborted' });
    currentRequest.onsuccess = () => {
      try {
        if (currentRequest.result === undefined || canonicalizeJson(currentRequest.result) !== plan.fingerprint) {
          fail({ kind: 'stale' });
          return;
        }
        const key = legacyArchiveKey(sessionId, plan.sourceSchemaVersion, PINNED_12_TO_13_MIGRATION_ID);
        const archiveStore = tx.objectStore(LEGACY_ARCHIVE_STORE);
        const archiveRequest = archiveStore.get(key);
        archiveRequest.onerror = () => fail({ kind: 'aborted' });
        archiveRequest.onsuccess = () => {
          try {
            if (archiveRequest.result !== undefined && canonicalizeJson(archiveRequest.result) !== plan.fingerprint) {
              fail({ kind: 'conflict', reason: 'An existing archive contains different pinned 1.2 data.' });
              return;
            }
            if (archiveRequest.result === undefined) {
              const archivePut = archiveStore.put(structuredClone(plan.raw), key);
              archivePut.onerror = () => fail({ kind: 'aborted' });
            }
            const put = tx.objectStore(STORE).put(plan.session);
            put.onerror = () => fail({ kind: 'aborted' });
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
async function confirmSemanticAlreadyMigrated(
  db: IDBDatabase,
  sessionId: string,
): Promise<SemanticMigrationResult> {
  const key = legacyArchiveKey(sessionId, '1.2.0', PINNED_12_TO_13_MIGRATION_ID);
  const tx = openTransaction(db, [STORE, LEGACY_ARCHIVE_STORE], 'readonly');
  const currentRequest = tx.objectStore(STORE).get(sessionId);
  const archiveRequest = tx.objectStore(LEGACY_ARCHIVE_STORE).get(key);
  const [rawCurrent, archived] = await Promise.all([
    requestResult(currentRequest),
    requestResult(archiveRequest),
  ]);
  if (rawCurrent === undefined) return { kind: 'stale' };
  if (archived === undefined) {
    return { kind: 'conflict', reason: 'Current semantic session has no retained pinned 1.2 migration source.' };
  }
  const currentPlan = await planSemanticMigration(rawCurrent);
  if (currentPlan.kind !== 'current') {
    return { kind: 'conflict', reason: 'Current semantic session changed while migration history was being verified.' };
  }
  const replay = await planSemanticMigration(archived);
  if (replay.kind !== 'ready') {
    return { kind: 'conflict', reason: 'Retained pinned 1.2 migration source cannot be replayed.' };
  }
  if (canonicalizeJson(replay.session) !== canonicalizeJson(currentPlan.session)) {
    return { kind: 'conflict', reason: 'Retained pinned 1.2 migration source does not match the current semantic session.' };
  }
  return { kind: 'already-migrated', session: currentPlan.session };
}


/**
 * #34A2B1 — internal storage proof, deliberately NOT wired into the user interface.
 * The live app remains 1.3-only until separate 1.4 load/edit/save/export gates are accepted.
 * A single strict IndexedDB transaction archives the exact original 1.3 bytes and
 * commits its deterministic 1.4 successor, or rolls both writes back.
 */
export type KnownFactStorageMigrationResult =
  | { kind: 'migrated' | 'already-migrated'; session: KnownFactSession14 }
  | { kind: 'missing' | 'stale' | 'aborted' }
  | { kind: 'unsupported' | 'invalid' | 'conflict'; reason: string };

type KnownFactReadyPlan = Extract<KnownFactMigrationPlan, { kind: 'ready' }>;

export async function migrateSession13To14ForReview(sessionId: string): Promise<KnownFactStorageMigrationResult> {
  if (!sessionId.trim()) return { kind: 'invalid', reason: 'A nonempty session ID is required.' };
  const db = await openDb();
  try {
    const raw = await requestResult(db.transaction(STORE, 'readonly').objectStore(STORE).get(sessionId));
    if (raw === undefined) return { kind: 'missing' };
    const plan = await planKnownFactMigration(raw);
    if (plan.kind === 'unsupported' || plan.kind === 'invalid') return plan;
    if (plan.session.sessionId !== sessionId) {
      return { kind: 'invalid', reason: 'Stored session identity does not match the requested key.' };
    }
    if (plan.kind === 'current') return await confirmKnownFactAlreadyMigrated(db, sessionId);
    return await commitKnownFactMigrationPlan(db, sessionId, plan);
  } finally {
    db.close();
  }
}

function commitKnownFactMigrationPlan(
  db: IDBDatabase,
  sessionId: string,
  plan: KnownFactReadyPlan,
): Promise<KnownFactStorageMigrationResult> {
  return new Promise((resolve) => {
    const tx = openTransaction(db, [STORE, LEGACY_ARCHIVE_STORE], 'readwrite');
    let failure: KnownFactStorageMigrationResult | null = null;
    const fail = (result: KnownFactStorageMigrationResult): void => {
      if (failure !== null) return;
      failure = result;
      try { tx.abort(); } catch { /* transaction already completed */ }
    };
    tx.oncomplete = () => resolve({ kind: 'migrated', session: plan.session });
    tx.onerror = () => { if (failure === null) failure = { kind: 'aborted' }; };
    tx.onabort = () => resolve(failure ?? { kind: 'aborted' });

    const currentRequest = tx.objectStore(STORE).get(sessionId);
    currentRequest.onerror = () => fail({ kind: 'aborted' });
    currentRequest.onsuccess = () => {
      try {
        if (currentRequest.result === undefined || canonicalizeJson(currentRequest.result) !== plan.fingerprint) {
          fail({ kind: 'stale' });
          return;
        }
        const key = legacyArchiveKey(sessionId, plan.sourceSchemaVersion, plan.migrationId);
        const archiveStore = tx.objectStore(LEGACY_ARCHIVE_STORE);
        const archiveRequest = archiveStore.get(key);
        archiveRequest.onerror = () => fail({ kind: 'aborted' });
        archiveRequest.onsuccess = () => {
          try {
            if (archiveRequest.result !== undefined
              && canonicalizeJson(archiveRequest.result) !== plan.fingerprint) {
              fail({ kind: 'conflict', reason: 'An existing archive contains different semantic 1.3 data.' });
              return;
            }
            if (archiveRequest.result === undefined) {
              const archivePut = archiveStore.put(structuredClone(plan.raw), key);
              archivePut.onerror = () => fail({ kind: 'aborted' });
            }
            const currentPut = tx.objectStore(STORE).put(plan.session);
            currentPut.onerror = () => fail({ kind: 'aborted' });
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

/** Replaying the retained source is required to report idempotent migration success. */
async function confirmKnownFactAlreadyMigrated(
  db: IDBDatabase,
  sessionId: string,
): Promise<KnownFactStorageMigrationResult> {
  const key = legacyArchiveKey(sessionId, '1.3.0', SEMANTIC_13_TO_KNOWN_FACT_14_MIGRATION_ID);
  const tx = openTransaction(db, [STORE, LEGACY_ARCHIVE_STORE], 'readonly');
  const [rawCurrent, archived] = await Promise.all([
    requestResult(tx.objectStore(STORE).get(sessionId)),
    requestResult(tx.objectStore(LEGACY_ARCHIVE_STORE).get(key)),
  ]);
  if (rawCurrent === undefined) return { kind: 'stale' };
  if (archived === undefined) {
    return { kind: 'conflict', reason: 'Current known-fact session has no retained semantic 1.3 migration source.' };
  }
  const currentPlan = await planKnownFactMigration(rawCurrent);
  if (currentPlan.kind !== 'current' || currentPlan.session.sessionId !== sessionId) {
    return { kind: 'conflict', reason: 'Known-fact session changed while migration history was verified.' };
  }
  const replay = await planKnownFactMigration(archived);
  if (replay.kind !== 'ready' || replay.session.sessionId !== sessionId) {
    return { kind: 'conflict', reason: 'Retained semantic 1.3 source cannot be replayed.' };
  }
  if (canonicalizeJson(replay.session) !== canonicalizeJson(currentPlan.session)) {
    return { kind: 'conflict', reason: 'Retained semantic 1.3 source does not match the current known-fact session.' };
  }
  return { kind: 'already-migrated', session: currentPlan.session };
}

export async function requestPersistentStorage(): Promise<boolean | null> {
  if (!navigator.storage?.persist) return null;
  if (await navigator.storage.persisted()) return true;
  return navigator.storage.persist();
}


/**
 * #35: read-only, SYNTHETIC-only retained local history inventory.
 * A single IDB readonly transaction captures current + that session's
 * retained keyed revisions atomically. This NEVER exports confidential data,
 * implies no off-device backup, and makes no storage or provider writes.
 */
export async function inspectSyntheticLocalRevisionContinuity(
  source: SemanticInterviewSession,
): Promise<LocalRevisionContinuityReport> {
  await validateSemanticSessionRecord(source);
  if (!/^synthetic(?:\s|[-_])/i.test(source.clientLabel)) {
    throw new Error('Local revision continuity trial accepts synthetic interviews only.');
  }
  const db = await openDb();
  try {
    const tx = db.transaction([STORE, REVISION_HISTORY_STORE], 'readonly');
    const completed = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('Could not read local history.'));
      tx.onabort = () => reject(tx.error ?? new Error('Local history check was aborted.'));
    });
    const prefix = revisionHistorySessionPrefix(source.sessionId);
    const range = IDBKeyRange.bound(prefix, `${prefix}\uffff`);
    const current = tx.objectStore(STORE).get(source.sessionId);
    const history = tx.objectStore(REVISION_HISTORY_STORE);
    const keysRequest = history.getAllKeys(range);
    const rowsRequest = history.getAll(range);
    const [raw, keys, rows] = await Promise.all([
      requestResult(current), requestResult(keysRequest), requestResult(rowsRequest),
    ]);
    await completed;
    // UI source may have changed while awaiting the transaction: never
    // silently audit an unseen session or mislabel another tab's record.
    if (raw === undefined || canonicalizeJson(raw) !== canonicalizeJson(source)) {
      throw new RevisionHistoryConflictError('The local interview changed during history inspection.');
    }
    if (keys.length !== rows.length) {
      throw new RevisionHistoryConflictError('Local revision history keys and records differ.');
    }
    return auditRetainedLocalRevisionsForReview(raw, keys.map((key, i) => {
      if (typeof key !== 'string') {
        throw new RevisionHistoryConflictError('Local revision history key is not a string.');
      }
      return { key, record: rows[i] };
    }));
  } finally {
    db.close();
  }
}

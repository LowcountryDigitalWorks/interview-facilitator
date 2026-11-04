import { afterEach, describe, expect, it, vi } from 'vitest';
import { generalDiscoveryPack100 } from '../src/historical-packs/general-discovery-1.0.0';
import { canonicalizeJson, createPinnedSession, sha256Hex, validateHistoricalPinned11Record, validateSessionRecord } from '../src/pack-identity';
import { generalDiscoveryPack } from '../src/pack';
import {
  INDEXED_DB_LAYOUT_VERSION,
  LEGACY_TO_PINNED_MIGRATION_ID,
  PINNED_11_TO_12_MIGRATION_ID,
  RULE_SEMANTICS_VERSION,
  legacyArchiveKey,
  migratePinned11To12,
  migrationRegistry,
  planCurrentMigration,
  planLegacyMigration,
} from '../src/session-migration';
import { LEGACY_ARCHIVE_STORE, REVISION_HISTORY_STORE, SESSIONS_STORE, listSessions, loadKnownFactSession14ForReview, migrateLegacySession, migrateSession12To13, migrateSession13To14ForReview, revisionHistoryKey, RevisionConflictError, RevisionHistoryConflictError, saveKnownFactSession14ForReview, saveSession } from '../src/storage';
import { PINNED_12_TO_13_MIGRATION_ID, createSemanticSession, planSemanticMigration } from '../src/semantic-session';
import { SEMANTIC_13_TO_KNOWN_FACT_14_MIGRATION_ID, migrateSemantic13ToKnownFact14, planKnownFactMigration } from '../src/known-fact-session';
import { acceptKnownFact, correctKnownFact } from '../src/known-fact-evidence';

const SESSION_ID = 'synthetic-legacy-session';

function blankAnswers(overrides: Record<string, { value: string | null; status: string | null; note: string }> = {}) {
  return Object.fromEntries(generalDiscoveryPack100.questions.map((question) => [
    question.id,
    overrides[question.id] ?? { value: null, status: null, note: '' },
  ]));
}

function legacyRecord(overrides: Record<string, unknown> = {}) {
  return {
    sessionSchemaVersion: '1.0.0',
    sessionId: SESSION_ID,
    interviewPackId: 'general-discovery',
    interviewPackVersion: '1.0.0',
    clientLabel: 'Synthetic Client',
    interviewerLabel: 'Synthetic Interviewer',
    interviewMode: 'discovery',
    createdAt: '2026-10-01T15:00:00.000Z',
    updatedAt: '2026-10-02T16:30:00.000Z',
    currentQuestionId: 'booking-process',
    knownFacts: [
      {
        id: 'fact-custom',
        label: 'Synthetic constraint',
        value: 'The first version stays local.',
        provenance: 'Synthetic interview note',
        questionId: 'must-have',
      },
    ],
    answers: blankAnswers({
      'existing-presence': { value: 'A brochure site.', status: 'ANSWERED', note: 'Confirmed on the call.' },
      'needs-booking': { value: 'Yes', status: 'ALREADY_KNOWN', note: 'Known before the interview.' },
      'booking-process': { value: 'Email for now.', status: 'MUST_CONFIRM', note: 'Ask operations.' },
    }),
    runningNotes: 'Synthetic running notes.',
    ...overrides,
  };
}

function installMigrationDatabase(options: { fail?: 'archive-get' | 'archive-put' | 'session-put' | 'history-put'; abortWrite?: boolean; abortAtCommit?: boolean; swapSecondRead?: unknown; removeSecondRead?: boolean } = {}) {
  const stores = new Map<string, Map<string, unknown>>();
  const transactions: Array<{ names: string[]; mode: IDBTransactionMode }> = [];
  let version = 0;
  let sessionReads = 0;
  const db = {
    objectStoreNames: { contains: (name: string) => stores.has(name) },
    createObjectStore(name: string) {
      if (!stores.has(name)) stores.set(name, new Map());
      return {};
    },
    close() {},
    transaction(storeNames: string | string[], mode: IDBTransactionMode) {
      const names = Array.isArray(storeNames) ? storeNames : [storeNames];
      transactions.push({ names: [...names], mode });
      const writes: Array<{ store: string; key: string; value: unknown }> = [];
      let pending = 0;
      let aborted = false;
      let finished = false;
      const tx = {
        oncomplete: null as null | (() => void),
        onabort: null as null | (() => void),
        onerror: null as null | (() => void),
        error: null as DOMException | null,
        abort() {
          if (finished) return;
          aborted = true;
          finished = true;
          queueMicrotask(() => tx.onabort?.());
        },
        objectStore(name: string) {
          if (!names.includes(name) || !stores.has(name)) throw new DOMException('Unknown transaction store.', 'NotFoundError');
          const store = stores.get(name)!;
          return {
            get(key: IDBValidKey) {
              const request = { result: undefined as unknown, onsuccess: null as null | (() => void), onerror: null as null | (() => void), error: null as DOMException | null };
              enqueue(() => {
                if (options.fail === 'archive-get' && name === LEGACY_ARCHIVE_STORE) {
                  request.onerror?.();
                  return;
                }
                let value = store.get(String(key));
                if (name === SESSIONS_STORE) {
                  sessionReads += 1;
                  if (sessionReads === 2 && options.removeSecondRead) value = undefined;
                  else if (sessionReads === 2 && options.swapSecondRead !== undefined) value = options.swapSecondRead;
                }
                request.result = value === undefined ? undefined : structuredClone(value);
                request.onsuccess?.();
              });
              return request;
            },
            getAll() {
              const request = { result: [] as unknown[], onsuccess: null as null | (() => void), onerror: null as null | (() => void), error: null as DOMException | null };
              enqueue(() => {
                request.result = [...store.values()].map((value) => structuredClone(value));
                request.onsuccess?.();
              });
              return request;
            },
            put(value: { sessionId?: string }, key?: IDBValidKey) {
              const request = { onsuccess: null as null | (() => void), onerror: null as null | (() => void), error: null as DOMException | null };
              enqueue(() => {
                const injected = (options.fail === 'archive-put' && name === LEGACY_ARCHIVE_STORE)
                  || (options.fail === 'history-put' && name === REVISION_HISTORY_STORE)
                  || (options.fail === 'session-put' && name === SESSIONS_STORE
                    && (names.includes(LEGACY_ARCHIVE_STORE) || names.includes(REVISION_HISTORY_STORE)));
                if (injected) {
                  request.onerror?.();
                  return;
                }
                writes.push({ store: name, key: String(key ?? value.sessionId), value: structuredClone(value) });
                request.onsuccess?.();
              });
              return request;
            },
          };
        },
      };
      const enqueue = (fn: () => void) => {
        pending += 1;
        queueMicrotask(() => {
          if (aborted || finished) {
            pending -= 1;
            return;
          }
          fn();
          pending -= 1;
          if (pending === 0 && !aborted && !finished) {
            if (options.abortAtCommit && mode === 'readwrite' && (names.includes(LEGACY_ARCHIVE_STORE) || names.includes(REVISION_HISTORY_STORE))) {
              tx.abort();
              return;
            }
            finished = true;
            if (mode === 'readwrite') {
              for (const write of writes) stores.get(write.store)?.set(write.key, write.value);
            }
            queueMicrotask(() => tx.oncomplete?.());
          }
        });
      };
      if (options.abortWrite && mode === 'readwrite' && (names.includes(LEGACY_ARCHIVE_STORE) || names.includes(REVISION_HISTORY_STORE))) queueMicrotask(() => tx.abort());
      return tx;
    },
  };
  vi.stubGlobal('indexedDB', {
    open(_name: string, nextVersion?: number) {
      const request = {
        result: db,
        onupgradeneeded: null as null | (() => void),
        onsuccess: null as null | (() => void),
        onerror: null as null | (() => void),
      };
      queueMicrotask(() => {
        if ((nextVersion ?? 1) > version) {
          request.onupgradeneeded?.();
          version = nextVersion ?? 1;
        }
        request.onsuccess?.();
      });
      return request;
    },
  });
  return {
    stores,
    transactions,
    setVersion(next: number) { version = next; },
    version: () => version,
  };
}

function seedLegacy(memory: ReturnType<typeof installMigrationDatabase>, row: unknown, id = SESSION_ID) {
  memory.setVersion(1);
  memory.stores.set(SESSIONS_STORE, new Map([[id, structuredClone(row)]]));
}

function seedArchive(memory: ReturnType<typeof installMigrationDatabase>, row: unknown) {
  memory.setVersion(2);
  memory.stores.set(LEGACY_ARCHIVE_STORE, new Map([[legacyArchiveKey(SESSION_ID), row]]));
  expect(memory.stores.get(LEGACY_ARCHIVE_STORE)?.get(legacyArchiveKey(SESSION_ID))).toBe(row);
}

async function pinned11Record() {
  const session = await createPinnedSession(generalDiscoveryPack, { clientLabel: 'Synthetic Client' }, new Date('2026-10-31T12:00:00.000Z'));
  session.sessionSchemaVersion = '1.1.0';
  delete session.packSnapshot.ruleSemanticsVersion;
  session.packIdentity.digest = await sha256Hex(canonicalizeJson(session.packSnapshot));
  return session;
}

describe('legacy 1.0 to pinned 1.1 migration', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps compatibility versions independent and uses the archived pack identity', () => {
    expect(INDEXED_DB_LAYOUT_VERSION).toBe(4);
    expect(migrationRegistry).toHaveLength(1);
    expect(migrationRegistry[0]).toMatchObject({
      sourceSessionSchemaVersion: '1.0.0',
      packId: 'general-discovery',
      packVersion: '1.0.0',
      targetSessionSchemaVersion: '1.1.0',
      ruleSemanticsVersion: RULE_SEMANTICS_VERSION,
      migrationId: LEGACY_TO_PINNED_MIGRATION_ID,
    });
    expect(RULE_SEMANTICS_VERSION).toBe('condition-equals-v1');
    expect(migrationRegistry[0]?.historicalPack).toBe(generalDiscoveryPack100);
    expect(migrationRegistry[0]?.historicalPack).not.toBe(generalDiscoveryPack);
    expect(Object.isFrozen(generalDiscoveryPack100)).toBe(true);
    expect(generalDiscoveryPack100.questions[3]?.condition).toEqual({ questionId: 'needs-booking', equals: 'Yes' });
  });

  it('migrates a populated legacy record without changing identity, timestamps, or answer semantics', async () => {
    const source = legacyRecord();
    const plan = await planLegacyMigration(source);
    expect(plan.kind).toBe('ready');
    if (plan.kind !== 'ready') return;
    expect(plan.session.sessionSchemaVersion).toBe('1.1.0');
    expect(plan.session.sessionId).toBe(source.sessionId);
    expect(plan.session.createdAt).toBe(source.createdAt);
    expect(plan.session.updatedAt).toBe(source.updatedAt);
    expect(plan.session.currentQuestionId).toBe('booking-process');
    expect(plan.session.knownFacts).toEqual(source.knownFacts);
    expect(plan.session.answers).toEqual(source.answers);
    expect(plan.session.runningNotes).toBe(source.runningNotes);
    expect(plan.session.clientLabel).toBe(source.clientLabel);
    expect(plan.session).not.toHaveProperty('ruleSemanticsVersion');
    expect(plan.session.packSnapshot.knownFacts).toEqual(generalDiscoveryPack100.knownFacts);
    expect(plan.session.packSnapshot.knownFacts).not.toEqual(plan.session.knownFacts);
    expect(plan.session.packIdentity.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps the migrated digest stable when the live pack changes', async () => {
    const source = legacyRecord();
    const before = await planLegacyMigration(source);
    const question = generalDiscoveryPack.questions[0];
    expect(question).toBeDefined();
    const original = question!.prompt;
    question!.prompt = 'Mutated live pack prompt';
    try {
      const after = await planLegacyMigration(structuredClone(source));
      expect(before.kind).toBe('ready');
      expect(after.kind).toBe('ready');
      if (before.kind !== 'ready' || after.kind !== 'ready') return;
      expect(after.session.packSnapshot.questions[0]?.prompt).toBe('What is already in place today?');
      expect(canonicalizeJson(after.session)).toBe(canonicalizeJson(before.session));
      expect(after.session.packIdentity.digest).toBe(before.session.packIdentity.digest);
    } finally {
      question!.prompt = original;
    }
  });

  it('returns the same semantic record and digest for the same legacy input', async () => {
    const first = await planLegacyMigration(legacyRecord());
    const second = await planLegacyMigration(legacyRecord());
    expect(first.kind).toBe('ready');
    expect(second.kind).toBe('ready');
    if (first.kind !== 'ready' || second.kind !== 'ready') return;
    expect(canonicalizeJson(second.session)).toBe(canonicalizeJson(first.session));
    expect(second.session.packIdentity.digest).toBe(first.session.packIdentity.digest);
  });

  it('fails closed for an unknown legacy pack, a malformed record, and a future schema', async () => {
    const unknown = await planLegacyMigration(legacyRecord({ interviewPackVersion: '9.9.9' }));
    const malformed = await planLegacyMigration(legacyRecord({ extra: true }));
    const future = await planLegacyMigration(legacyRecord({ sessionSchemaVersion: '2.0.0' }));
    expect(unknown).toMatchObject({ kind: 'unsupported' });
    expect(malformed).toMatchObject({ kind: 'invalid' });
    expect(future).toMatchObject({ kind: 'unsupported' });
  });

  it('creates the archive store on upgrade and leaves existing session rows untouched', async () => {
    const memory = installMigrationDatabase();
    const source = legacyRecord();
    seedLegacy(memory, source);
    const listed = await listSessions();
    expect(memory.version()).toBe(4);
    expect(memory.stores.has(LEGACY_ARCHIVE_STORE)).toBe(true);
    expect(memory.stores.get(LEGACY_ARCHIVE_STORE)?.size).toBe(0);
    expect(memory.stores.has(REVISION_HISTORY_STORE)).toBe(true);
    expect(memory.stores.get(REVISION_HISTORY_STORE)?.size).toBe(0);
    expect(listed.sessions).toHaveLength(0);
    expect(listed.unreadableCount).toBe(0);
    expect(listed.rows?.map((row) => row.classification)).toEqual(['legacy-migratable']);
    expect(memory.stores.get(SESSIONS_STORE)?.get(SESSION_ID)).toEqual(source);
  });

  it('upgrades 1.0 through every accepted stored stage and retains each exact source archive', async () => {
    const memory = installMigrationDatabase();
    const source10 = legacyRecord();
    const plan11 = await planLegacyMigration(source10);
    expect(plan11.kind).toBe('ready');
    if (plan11.kind !== 'ready') return;
    const plan12 = await migratePinned11To12(plan11.session);
    expect(plan12.kind).toBe('ready');
    if (plan12.kind !== 'ready') return;
    seedLegacy(memory, source10);

    const result = await migrateLegacySession(SESSION_ID);
    expect(result.kind).toBe('migrated');
    if (result.kind !== 'migrated') return;
    expect(result.session.sessionSchemaVersion).toBe('1.3.0');
    expect(result.session.packSnapshot.ruleSemanticsVersion).toBe('effective-evidence-equals-v2');
    expect(memory.stores.get(SESSIONS_STORE)?.get(SESSION_ID)).toEqual(result.session);
    expect(memory.stores.get(LEGACY_ARCHIVE_STORE)?.get(legacyArchiveKey(SESSION_ID, '1.0.0', LEGACY_TO_PINNED_MIGRATION_ID))).toEqual(source10);
    expect(memory.stores.get(LEGACY_ARCHIVE_STORE)?.get(legacyArchiveKey(SESSION_ID, '1.1.0', PINNED_11_TO_12_MIGRATION_ID))).toEqual(plan11.session);
    expect(memory.stores.get(LEGACY_ARCHIVE_STORE)?.get(legacyArchiveKey(SESSION_ID, '1.2.0', PINNED_12_TO_13_MIGRATION_ID))).toEqual(plan12.session);
    expect(memory.stores.get(LEGACY_ARCHIVE_STORE)?.size).toBe(3);
    expect(result.session.createdAt).toBe(source10.createdAt);
    expect(result.session.updatedAt).toBe(source10.updatedAt);
  });

  it('migrates persisted 1.1 through 1.2 to current 1.3 and archives each untouched source', async () => {
    const memory = installMigrationDatabase();
    const source11 = await pinned11Record();
    source11.sessionId = SESSION_ID;
    const plan12 = await migratePinned11To12(source11);
    expect(plan12.kind).toBe('ready');
    if (plan12.kind !== 'ready') return;
    seedLegacy(memory, source11);

    const result = await migrateLegacySession(SESSION_ID);
    expect(result.kind).toBe('migrated');
    expect(memory.stores.get(SESSIONS_STORE)?.get(SESSION_ID)).toMatchObject({ sessionSchemaVersion: '1.3.0' });
    expect(memory.stores.get(LEGACY_ARCHIVE_STORE)?.get(legacyArchiveKey(SESSION_ID, '1.1.0', PINNED_11_TO_12_MIGRATION_ID))).toEqual(source11);
    expect(memory.stores.get(LEGACY_ARCHIVE_STORE)?.get(legacyArchiveKey(SESSION_ID, '1.2.0', PINNED_12_TO_13_MIGRATION_ID))).toEqual(plan12.session);
    expect(memory.stores.get(LEGACY_ARCHIVE_STORE)?.size).toBe(2);
    expect(legacyArchiveKey(SESSION_ID, '1.0.0', LEGACY_TO_PINNED_MIGRATION_ID)).not.toBe(legacyArchiveKey(SESSION_ID, '1.1.0', PINNED_11_TO_12_MIGRATION_ID));
    const repeat = await migrateLegacySession(SESSION_ID);
    expect(repeat.kind).toBe('already-migrated');
  });

  it('keeps historical validation explicit and plans exactly one accepted migration stage at a time', async () => {
    const historical = await pinned11Record();
    await expect(validateSessionRecord(historical)).rejects.toThrow(/unsupported session schema/i);
    await expect(validateHistoricalPinned11Record(historical)).resolves.toMatchObject({ sessionSchemaVersion: '1.1.0' });

    const source10 = legacyRecord();
    const planned11 = await planCurrentMigration(source10);
    const explicit11 = await planLegacyMigration(source10);
    expect(planned11.kind).toBe('ready');
    expect(explicit11.kind).toBe('ready');
    if (planned11.kind !== 'ready' || explicit11.kind !== 'ready') return;
    expect(planned11.session.sessionSchemaVersion).toBe('1.1.0');
    expect(canonicalizeJson(planned11.session)).toBe(canonicalizeJson(explicit11.session));

    const planned12 = await planCurrentMigration(planned11.session);
    const explicit12 = await migratePinned11To12(explicit11.session);
    expect(planned12.kind).toBe('ready');
    expect(explicit12.kind).toBe('ready');
    if (planned12.kind !== 'ready' || explicit12.kind !== 'ready') return;
    expect(planned12.session.sessionSchemaVersion).toBe('1.2.0');
    expect(canonicalizeJson(planned12.session)).toBe(canonicalizeJson(explicit12.session));

    const planned13 = await planCurrentMigration(planned12.session);
    expect(planned13.kind).toBe('ready');
    if (planned13.kind === 'ready') expect(planned13.session.sessionSchemaVersion).toBe('1.3.0');
  });

  it('preserves an identical 1.1 archive and conflicts on a different one', async () => {
    const sameMemory = installMigrationDatabase();
    const source = await pinned11Record();
    source.sessionId = SESSION_ID;
    seedLegacy(sameMemory, source);
    const archiveKey = legacyArchiveKey(SESSION_ID, '1.1.0', 'pinned-1.1-to-1.2');
    const identicalArchive = structuredClone(source);
    sameMemory.stores.set(LEGACY_ARCHIVE_STORE, new Map([[archiveKey, identicalArchive]]));
    const migrated = await migrateLegacySession(SESSION_ID);
    expect(migrated.kind).toBe('migrated');
    expect(sameMemory.stores.get(LEGACY_ARCHIVE_STORE)?.get(archiveKey)).toBe(identicalArchive);

    const conflictMemory = installMigrationDatabase();
    seedLegacy(conflictMemory, source);
    const conflictingArchive = { ...structuredClone(source), runningNotes: 'Other original source.' };
    conflictMemory.stores.set(LEGACY_ARCHIVE_STORE, new Map([[archiveKey, conflictingArchive]]));
    const result = await migrateLegacySession(SESSION_ID);
    expect(result.kind).toBe('conflict');
    expect(conflictMemory.stores.get(SESSIONS_STORE)?.get(SESSION_ID)).toEqual(source);
    expect(conflictMemory.stores.get(LEGACY_ARCHIVE_STORE)?.get(archiveKey)).toBe(conflictingArchive);
  });

  it('does not overwrite a 1.1 source changed before its transaction', async () => {
    const source = await pinned11Record();
    source.sessionId = SESSION_ID;
    const changed = { ...structuredClone(source), runningNotes: 'Changed before commit.' };
    const memory = installMigrationDatabase({ swapSecondRead: changed });
    seedLegacy(memory, source);
    const result = await migrateLegacySession(SESSION_ID);
    expect(result.kind).toBe('stale');
    expect(memory.stores.get(SESSIONS_STORE)?.get(SESSION_ID)).toEqual(source);
    expect(memory.stores.get(LEGACY_ARCHIVE_STORE)?.size ?? 0).toBe(0);
  });

  it('preserves an older 1.0 archive while using the current valid 1.1 row as the next migration source', async () => {
    const memory = installMigrationDatabase();
    const source10 = legacyRecord();
    memory.stores.set(LEGACY_ARCHIVE_STORE, new Map([[
      legacyArchiveKey(SESSION_ID, '1.0.0', LEGACY_TO_PINNED_MIGRATION_ID),
      structuredClone(source10),
    ]]));
    const source11 = await pinned11Record();
    source11.sessionId = SESSION_ID;
    source11.runningNotes = 'Edited after the historical 1.0 migration.';
    seedLegacy(memory, source11);

    const result = await migrateLegacySession(SESSION_ID);
    expect(result.kind).toBe('migrated');
    expect(memory.stores.get(LEGACY_ARCHIVE_STORE)?.get(legacyArchiveKey(SESSION_ID, '1.0.0', LEGACY_TO_PINNED_MIGRATION_ID))).toEqual(source10);
    expect(memory.stores.get(LEGACY_ARCHIVE_STORE)?.get(legacyArchiveKey(SESSION_ID, '1.1.0', PINNED_11_TO_12_MIGRATION_ID))).toEqual(source11);
    expect(memory.stores.get(LEGACY_ARCHIVE_STORE)?.has(legacyArchiveKey(SESSION_ID, '1.2.0', PINNED_12_TO_13_MIGRATION_ID))).toBe(true);
    expect((await migrateLegacySession(SESSION_ID)).kind).toBe('already-migrated');
  });

  it.each([
    { fail: 'archive-get' as const },
    { fail: 'archive-put' as const },
    { fail: 'session-put' as const },
    { abortAtCommit: true },
  ])('preserves a 1.1 source on transaction failure: %j', async (options) => {
    const memory = installMigrationDatabase(options);
    const source = await pinned11Record();
    source.sessionId = SESSION_ID;
    seedLegacy(memory, source);
    const result = await migrateLegacySession(SESSION_ID);
    expect(result.kind).toBe('aborted');
    expect(memory.stores.get(SESSIONS_STORE)?.get(SESSION_ID)).toEqual(source);
    expect(memory.stores.get(LEGACY_ARCHIVE_STORE)?.size).toBe(0);
  });

  it('converts pinned 1.1 deterministically without changing semantic session content', async () => {
    const source = await pinned11Record();
    const first = await migratePinned11To12(source);
    const second = await migratePinned11To12(source);
    expect(first.kind).toBe('ready');
    expect(second.kind).toBe('ready');
    if (first.kind !== 'ready' || second.kind !== 'ready') return;
    const { sessionSchemaVersion: _firstVersion, packSnapshot: firstSnapshot, packIdentity: _firstIdentity, revisionId: _firstRevision, parentRevisionId: _firstParent, ...firstState } = first.session;
    const { sessionSchemaVersion: _secondVersion, packSnapshot: secondSnapshot, packIdentity: _secondIdentity, revisionId: _secondRevision, parentRevisionId: _secondParent, ...secondState } = second.session;
    expect(firstState).toEqual(source && (({ sessionSchemaVersion: _version, packSnapshot: _snapshot, packIdentity: _identity, revisionId: _revision, parentRevisionId: _parent, ...state }) => state)(source));
    expect(secondState).toEqual(firstState);
    expect(first.session.parentRevisionId).toBe(source.revisionId);
    expect(first.session.revisionId).toBe(`migration:${source.revisionId}:${PINNED_11_TO_12_MIGRATION_ID}`);
    expect(firstSnapshot.ruleSemanticsVersion).toBe(RULE_SEMANTICS_VERSION);
    expect(canonicalizeJson(first.session)).toBe(canonicalizeJson(second.session));
  });

  it.each([
    ['archive read', { fail: 'archive-get' as const }],
    ['archive put', { fail: 'archive-put' as const }],
    ['current put', { fail: 'session-put' as const }],
    ['transaction abort', { abortWrite: true }],
    ['abort after staged writes', { abortAtCommit: true }],
  ])('rolls back when %s fails', async (_label, options) => {
    const memory = installMigrationDatabase(options);
    const source = legacyRecord();
    seedLegacy(memory, source);
    const result = await migrateLegacySession(SESSION_ID);
    expect(result.kind).toBe('aborted');
    expect(memory.stores.get(SESSIONS_STORE)?.get(SESSION_ID)).toEqual(source);
    expect(memory.stores.get(LEGACY_ARCHIVE_STORE)?.size ?? 0).toBe(0);
  });

  it('does not write when the source changes before the transaction', async () => {
    const memory = installMigrationDatabase({ swapSecondRead: legacyRecord({ runningNotes: 'Changed before commit.' }) });
    const source = legacyRecord();
    seedLegacy(memory, source);
    const result = await migrateLegacySession(SESSION_ID);
    expect(result.kind).toBe('stale');
    expect(memory.stores.get(SESSIONS_STORE)?.get(SESSION_ID)).toEqual(source);
    expect(memory.stores.get(LEGACY_ARCHIVE_STORE)?.size ?? 0).toBe(0);
  });

  it('does not write an unknown pack, a malformed row, or a future schema', async () => {
    for (const source of [
      legacyRecord({ interviewPackId: 'other-pack' }),
      legacyRecord({ unexpected: 'field' }),
      legacyRecord({ sessionSchemaVersion: '9.0.0' }),
    ]) {
      const memory = installMigrationDatabase();
      seedLegacy(memory, source);
      const result = await migrateLegacySession(SESSION_ID);
      expect(result.kind === 'unsupported' || result.kind === 'invalid').toBe(true);
      expect(memory.stores.get(SESSIONS_STORE)?.get(SESSION_ID)).toEqual(source);
      expect(memory.stores.get(LEGACY_ARCHIVE_STORE)?.size ?? 0).toBe(0);
    }
  });

  it('retries a completed full migration without duplicating any stage archive', async () => {
    const memory = installMigrationDatabase();
    const source = legacyRecord();
    seedLegacy(memory, source);
    const first = await migrateLegacySession(SESSION_ID);
    const archiveEntries = [...(memory.stores.get(LEGACY_ARCHIVE_STORE)?.entries() ?? [])];
    const second = await migrateLegacySession(SESSION_ID);
    expect(first.kind).toBe('migrated');
    expect(second.kind).toBe('already-migrated');
    expect(memory.stores.get(LEGACY_ARCHIVE_STORE)?.size).toBe(3);
    expect([...(memory.stores.get(LEGACY_ARCHIVE_STORE)?.entries() ?? [])]).toEqual(archiveEntries);
    if (first.kind !== 'migrated' || second.kind !== 'already-migrated') return;
    expect(canonicalizeJson(second.session)).toBe(canonicalizeJson(first.session));
  });

  it('preserves an identical pre-existing 1.0 archive while adding later stage archives', async () => {
    const memory = installMigrationDatabase();
    const source = legacyRecord();
    seedLegacy(memory, source);
    const archive = structuredClone(source);
    seedArchive(memory, archive);
    const result = await migrateLegacySession(SESSION_ID);
    expect(result.kind).toBe('migrated');
    expect(memory.stores.get(LEGACY_ARCHIVE_STORE)?.size).toBe(3);
    expect(memory.stores.get(LEGACY_ARCHIVE_STORE)?.get(legacyArchiveKey(SESSION_ID))).toBe(archive);
    expect(memory.stores.get(LEGACY_ARCHIVE_STORE)?.has(legacyArchiveKey(SESSION_ID, '1.1.0', PINNED_11_TO_12_MIGRATION_ID))).toBe(true);
    expect(memory.stores.get(LEGACY_ARCHIVE_STORE)?.has(legacyArchiveKey(SESSION_ID, '1.2.0', PINNED_12_TO_13_MIGRATION_ID))).toBe(true);
  });

  it('returns conflict without changing either store for a different pre-existing archive', async () => {
    const memory = installMigrationDatabase();
    const source = legacyRecord();
    seedLegacy(memory, source);
    const original = structuredClone(source);
    const archive = { ...structuredClone(source), runningNotes: 'Different historical source.' };
    seedArchive(memory, archive);
    const result = await migrateLegacySession(SESSION_ID);
    expect(result.kind).toBe('conflict');
    expect(memory.stores.get(SESSIONS_STORE)?.get(SESSION_ID)).toEqual(original);
    expect(memory.stores.get(LEGACY_ARCHIVE_STORE)?.get(legacyArchiveKey(SESSION_ID))).toBe(archive);
  });

  it.each([
    { fail: 'archive-get' as const },
    { fail: 'session-put' as const },
    { abortWrite: true },
    { abortAtCommit: true },
  ])('preserves an existing archive and source on failure: %j', async (options) => {
    const memory = installMigrationDatabase(options);
    const source = legacyRecord();
    seedLegacy(memory, source);
    const archive = structuredClone(source);
    seedArchive(memory, archive);
    const result = await migrateLegacySession(SESSION_ID);
    expect(result.kind).toBe('aborted');
    expect(memory.stores.get(SESSIONS_STORE)?.get(SESSION_ID)).toEqual(source);
    expect(memory.stores.get(LEGACY_ARCHIVE_STORE)?.get(legacyArchiveKey(SESSION_ID))).toBe(archive);
    expect(memory.stores.get(LEGACY_ARCHIVE_STORE)?.size).toBe(1);
  });

  it('reports a conflict when the current row no longer matches the archived source', async () => {
    const memory = installMigrationDatabase();
    const source = legacyRecord();
    seedLegacy(memory, source);
    const first = await migrateLegacySession(SESSION_ID);
    expect(first.kind).toBe('migrated');
    const current = memory.stores.get(SESSIONS_STORE)?.get(SESSION_ID) as { runningNotes: string };
    current.runningNotes = 'Edited after migration.';
    const archived = memory.stores.get(LEGACY_ARCHIVE_STORE)?.get(legacyArchiveKey(SESSION_ID));
    const result = await migrateLegacySession(SESSION_ID);
    expect(result.kind).toBe('conflict');
    expect(memory.stores.get(SESSIONS_STORE)?.get(SESSION_ID)).toBe(current);
    expect(memory.stores.get(LEGACY_ARCHIVE_STORE)?.get(legacyArchiveKey(SESSION_ID))).toBe(archived);
  });

  it('keeps 1.0→1.1→1.2→1.3 planning sequential rather than skipping accepted semantics', async () => {
    const source10 = legacyRecord();
    const plan11 = await planCurrentMigration(source10);
    expect(plan11.kind).toBe('ready');
    if (plan11.kind !== 'ready') return;
    expect(plan11.session.sessionSchemaVersion).toBe('1.1.0');

    const plan12 = await planCurrentMigration(plan11.session);
    expect(plan12.kind).toBe('ready');
    if (plan12.kind !== 'ready') return;
    expect(plan12.session.sessionSchemaVersion).toBe('1.2.0');
    expect(plan12.session.packSnapshot.ruleSemanticsVersion).toBe('condition-equals-v1');

    const plan13 = await planCurrentMigration(plan12.session);
    expect(plan13.kind).toBe('ready');
    if (plan13.kind !== 'ready') return;
    expect(plan13.session.sessionSchemaVersion).toBe('1.3.0');
    expect(plan13.session.parentRevisionId).toBe(plan12.session.revisionId);
    expect(plan13.session.packSnapshot.ruleSemanticsVersion).toBe('effective-evidence-equals-v2');
  });

  it('atomically archives an exact 1.2 source while committing dormant 1.3 semantic state', async () => {
    const memory = installMigrationDatabase();
    const source = await createPinnedSession(generalDiscoveryPack, { clientLabel: 'Synthetic 1.2' }, new Date('2026-11-02T12:00:00.000Z'));
    source.sessionId = SESSION_ID;
    source.answers['existing-presence'] = { value: 'Retained context', status: 'MUST_CONFIRM', note: 'Private note' };
    seedLegacy(memory, source);
    const result = await migrateSession12To13(SESSION_ID);
    expect(result.kind).toBe('migrated');
    const archiveKey = legacyArchiveKey(SESSION_ID, '1.2.0', PINNED_12_TO_13_MIGRATION_ID);
    expect(memory.stores.get(LEGACY_ARCHIVE_STORE)?.get(archiveKey)).toEqual(source);
    expect(memory.stores.get(SESSIONS_STORE)?.get(SESSION_ID)).toMatchObject({
      sessionSchemaVersion: '1.3.0',
      parentRevisionId: source.revisionId,
      answers: { 'existing-presence': { value: 'Retained context', resolution: 'captured', needsConfirmation: true, note: 'Private note' } },
    });
  });

  it('replays the retained 1.2 archive before reporting an already-migrated 1.3 row', async () => {
    const memory = installMigrationDatabase();
    const source = await createPinnedSession(generalDiscoveryPack, { clientLabel: 'Synthetic 1.2' });
    source.sessionId = SESSION_ID;
    seedLegacy(memory, source);
    const first = await migrateSession12To13(SESSION_ID);
    const second = await migrateSession12To13(SESSION_ID);
    expect(first.kind).toBe('migrated');
    expect(second.kind).toBe('already-migrated');
    if (first.kind === 'migrated' && second.kind === 'already-migrated') {
      expect(canonicalizeJson(second.session)).toBe(canonicalizeJson(first.session));
    }
    expect(memory.stores.get(LEGACY_ARCHIVE_STORE)?.size).toBe(1);
    expect(memory.transactions.filter((tx) => tx.mode === 'readonly'
      && tx.names.includes(SESSIONS_STORE)
      && tx.names.includes(LEGACY_ARCHIVE_STORE))).toHaveLength(1);
  });

  it('fails closed when a current 1.3 row has no retained 1.2 migration source', async () => {
    const memory = installMigrationDatabase();
    const source = await createPinnedSession(generalDiscoveryPack, { clientLabel: 'Synthetic 1.2' });
    source.sessionId = SESSION_ID;
    seedLegacy(memory, source);
    expect((await migrateSession12To13(SESSION_ID)).kind).toBe('migrated');
    memory.stores.get(LEGACY_ARCHIVE_STORE)?.clear();
    expect(await migrateSession12To13(SESSION_ID)).toMatchObject({ kind: 'conflict' });
  });

  it('fails closed when retained 1.2 history no longer reproduces the current 1.3 row', async () => {
    const memory = installMigrationDatabase();
    const source = await createPinnedSession(generalDiscoveryPack, { clientLabel: 'Synthetic 1.2' });
    source.sessionId = SESSION_ID;
    seedLegacy(memory, source);
    expect((await migrateSession12To13(SESSION_ID)).kind).toBe('migrated');
    const archiveKey = legacyArchiveKey(SESSION_ID, '1.2.0', PINNED_12_TO_13_MIGRATION_ID);
    memory.stores.get(LEGACY_ARCHIVE_STORE)?.set(archiveKey, { ...structuredClone(source), runningNotes: 'Conflicting retained source.' });
    expect(await migrateSession12To13(SESSION_ID)).toMatchObject({ kind: 'conflict' });
  });

  it.each([
    { fail: 'archive-get' as const },
    { fail: 'archive-put' as const },
    { fail: 'session-put' as const },
    { abortAtCommit: true },
  ])('rolls back 1.2→1.3 migration on transaction failure: %j', async (options) => {
    const memory = installMigrationDatabase(options);
    const source = await createPinnedSession(generalDiscoveryPack, { clientLabel: 'Synthetic 1.2' });
    source.sessionId = SESSION_ID;
    seedLegacy(memory, source);
    const result = await migrateSession12To13(SESSION_ID);
    expect(result.kind).toBe('aborted');
    expect(memory.stores.get(SESSIONS_STORE)?.get(SESSION_ID)).toEqual(source);
    expect(memory.stores.get(LEGACY_ARCHIVE_STORE)?.size ?? 0).toBe(0);
  });

  it('reports stale when the 1.2 source disappears before the migration transaction reread', async () => {
    const memory = installMigrationDatabase({ removeSecondRead: true });
    const source = await createPinnedSession(generalDiscoveryPack, { clientLabel: 'Synthetic 1.2' });
    source.sessionId = SESSION_ID;
    seedLegacy(memory, source);
    const result = await migrateSession12To13(SESSION_ID);
    expect(result.kind).toBe('stale');
    expect(memory.stores.get(SESSIONS_STORE)?.get(SESSION_ID)).toEqual(source);
    expect(memory.stores.get(LEGACY_ARCHIVE_STORE)?.size ?? 0).toBe(0);
  });

  it('does not commit 1.3 when the 1.2 source changes before the transaction', async () => {
    const source = await createPinnedSession(generalDiscoveryPack, { clientLabel: 'Synthetic 1.2' });
    source.sessionId = SESSION_ID;
    const changed = { ...structuredClone(source), runningNotes: 'Changed before commit.' };
    const memory = installMigrationDatabase({ swapSecondRead: changed });
    seedLegacy(memory, source);
    const result = await migrateSession12To13(SESSION_ID);
    expect(result.kind).toBe('stale');
    expect(memory.stores.get(SESSIONS_STORE)?.get(SESSION_ID)).toEqual(source);
    expect(memory.stores.get(LEGACY_ARCHIVE_STORE)?.size ?? 0).toBe(0);
  });

  it('does not rewrite a current 1.3 session that has no migration archive', async () => {
    const memory = installMigrationDatabase();
    const current = await createSemanticSession(generalDiscoveryPack, { clientLabel: 'Synthetic Client' }, new Date('2026-10-31T12:00:00.000Z'));
    current.sessionId = SESSION_ID;
    seedLegacy(memory, current);
    const result = await migrateLegacySession(SESSION_ID);
    expect(result.kind).toBe('not-legacy');
    expect(memory.stores.get(SESSIONS_STORE)?.get(SESSION_ID)).toEqual(current);
    expect(memory.stores.get(LEGACY_ARCHIVE_STORE)?.size ?? 0).toBe(0);
  });
});


describe('34A2B1 internal atomic known-fact 1.3 to 1.4 storage gate', () => {
  afterEach(() => vi.unstubAllGlobals());

  async function source13() {
    const source = await createSemanticSession(generalDiscoveryPack, { clientLabel: 'Synthetic storage-only proof' }, new Date('2026-11-03T12:00:00.000Z'));
    source.sessionId = SESSION_ID;
    source.runningNotes = 'Private synthetic context; preserve exactly.';
    source.answers['primary-goal']!.note = 'Internal note.';
    return source;
  }

  function archiveKey() {
    return legacyArchiveKey(SESSION_ID, '1.3.0', SEMANTIC_13_TO_KNOWN_FACT_14_MIGRATION_ID);
  }

  it('atomically archives a byte-equivalent 1.3 source and commits validated 1.4 with no invented fact acceptance', async () => {
    const memory = installMigrationDatabase();
    const source = await source13();
    source.answers['existing-presence'] = {
      ...source.answers['existing-presence']!,
      value: 'Synthetic known context', resolution: 'captured',
      source: 'accepted-known-fact', needsConfirmation: false,
    };
    const before = canonicalizeJson(source);
    seedLegacy(memory, source);
    const result = await migrateSession13To14ForReview(SESSION_ID);
    expect(result.kind).toBe('migrated');
    if (result.kind !== 'migrated') return;
    expect(canonicalizeJson(source)).toBe(before);
    expect(memory.stores.get(LEGACY_ARCHIVE_STORE)?.get(archiveKey())).toEqual(source);
    expect(memory.stores.get(SESSIONS_STORE)?.get(SESSION_ID)).toEqual(result.session);
    expect(result.session.sessionSchemaVersion).toBe('1.4.0');
    expect(result.session.parentRevisionId).toBe(source.revisionId);
    expect(result.session.runningNotes).toBe(source.runningNotes);
    expect(result.session.answers['primary-goal']?.note).toBe('Internal note.');
    expect(result.session.packSnapshot).toEqual(source.packSnapshot);
    expect(result.session.packIdentity).toEqual(source.packIdentity);
    expect(result.session.knownFactLedger.acceptances).toEqual([]);
    expect(result.session.knownFactAnswerLinks['existing-presence']).toEqual({ kind: 'legacy-unverified' });
    expect(result.session.answers['existing-presence']?.needsConfirmation).toBe(true);
    expect(memory.transactions.some((tx) => tx.mode === 'readwrite'
      && tx.names.includes(SESSIONS_STORE) && tx.names.includes(LEGACY_ARCHIVE_STORE))).toBe(true);
  });

  it('idempotently verifies the archived source by deterministic replay without adding a second archive', async () => {
    const memory = installMigrationDatabase();
    const source = await source13();
    seedLegacy(memory, source);
    const first = await migrateSession13To14ForReview(SESSION_ID);
    const archive = structuredClone(memory.stores.get(LEGACY_ARCHIVE_STORE)?.get(archiveKey()));
    const second = await migrateSession13To14ForReview(SESSION_ID);
    expect(first.kind).toBe('migrated');
    expect(second.kind).toBe('already-migrated');
    if (first.kind === 'migrated' && second.kind === 'already-migrated') {
      expect(canonicalizeJson(second.session)).toBe(canonicalizeJson(first.session));
    }
    expect(memory.stores.get(LEGACY_ARCHIVE_STORE)?.size).toBe(1);
    expect(memory.stores.get(LEGACY_ARCHIVE_STORE)?.get(archiveKey())).toEqual(archive);
  });

  it('preserves identical pre-existing archive bytes and rejects conflicting archives without writes', async () => {
    for (const conflicting of [false, true]) {
      const memory = installMigrationDatabase();
      const source = await source13();
      seedLegacy(memory, source);
      const archived = structuredClone(source);
      if (conflicting) archived.runningNotes = 'Different archived truth';
      memory.stores.set(LEGACY_ARCHIVE_STORE, new Map([[archiveKey(), archived]]));
      const before = canonicalizeJson(memory.stores.get(SESSIONS_STORE)?.get(SESSION_ID));
      const result = await migrateSession13To14ForReview(SESSION_ID);
      expect(result.kind).toBe(conflicting ? 'conflict' : 'migrated');
      expect(memory.stores.get(LEGACY_ARCHIVE_STORE)?.get(archiveKey())).toEqual(archived);
      expect(memory.stores.get(SESSIONS_STORE)?.get(SESSION_ID)).toEqual(
        conflicting ? source : (result.kind === 'migrated' ? result.session : source),
      );
      if (conflicting) expect(canonicalizeJson(memory.stores.get(SESSIONS_STORE)?.get(SESSION_ID))).toBe(before);
    }
  });

  it.each([
    ['archive read', { fail: 'archive-get' as const }],
    ['archive put', { fail: 'archive-put' as const }],
    ['current put', { fail: 'session-put' as const }],
    ['aborted transaction', { abortWrite: true }],
    ['abort after staged writes', { abortAtCommit: true }],
  ])('rolls back both records when %s fails', async (_name, opts) => {
    const memory = installMigrationDatabase(opts);
    const source = await source13();
    seedLegacy(memory, source);
    const before = canonicalizeJson(source);
    const result = await migrateSession13To14ForReview(SESSION_ID);
    expect(result.kind).toBe('aborted');
    expect(canonicalizeJson(memory.stores.get(SESSIONS_STORE)?.get(SESSION_ID))).toBe(before);
    expect(memory.stores.get(LEGACY_ARCHIVE_STORE)?.size ?? 0).toBe(0);
  });

  it.each([
    ['changed', { swapSecondRead: { changed: 'test-only row' } }],
    ['removed', { removeSecondRead: true }],
  ])('detects a %s session between preflight and commit without mutation', async (_name, opts) => {
    const memory = installMigrationDatabase(opts);
    const source = await source13();
    seedLegacy(memory, source);
    expect((await migrateSession13To14ForReview(SESSION_ID)).kind).toBe('stale');
    expect(memory.stores.get(SESSIONS_STORE)?.get(SESSION_ID)).toEqual(source);
    expect(memory.stores.get(LEGACY_ARCHIVE_STORE)?.size ?? 0).toBe(0);
  });

  it('fails closed when retry archive is missing or no longer replays exact current state', async () => {
    const memory = installMigrationDatabase();
    seedLegacy(memory, await source13());
    expect((await migrateSession13To14ForReview(SESSION_ID)).kind).toBe('migrated');
    const original = structuredClone(memory.stores.get(LEGACY_ARCHIVE_STORE)?.get(archiveKey())) as Record<string, unknown>;
    memory.stores.get(LEGACY_ARCHIVE_STORE)?.delete(archiveKey());
    expect((await migrateSession13To14ForReview(SESSION_ID)).kind).toBe('conflict');
    memory.stores.get(LEGACY_ARCHIVE_STORE)?.set(archiveKey(), { ...original, runningNotes: 'Corrupt synthetic archive' });
    expect((await migrateSession13To14ForReview(SESSION_ID)).kind).toBe('conflict');
    memory.stores.get(LEGACY_ARCHIVE_STORE)?.set(archiveKey(), original);
    const current = memory.stores.get(SESSIONS_STORE)?.get(SESSION_ID) as { runningNotes: string };
    current.runningNotes = 'Edited after migration';
    expect((await migrateSession13To14ForReview(SESSION_ID)).kind).toBe('conflict');
  });

  it('does not migrate a missing row, invalid 1.3 data, earlier 1.0-1.2 rows or future versions', async () => {
    const memory = installMigrationDatabase();
    expect((await migrateSession13To14ForReview(SESSION_ID)).kind).toBe('missing');
    expect((await migrateSession13To14ForReview('   ')).kind).toBe('invalid');
    const source = await source13();
    for (const row of [
      { ...source, unexpected: 'not canonical' },
      { ...source, sessionSchemaVersion: '1.2.0' },
      { ...source, sessionSchemaVersion: '1.1.0' },
      { ...source, sessionSchemaVersion: '1.0.0' },
      { ...source, sessionSchemaVersion: '9.0.0' },
    ]) {
      seedLegacy(memory, row);
      const actual = await migrateSession13To14ForReview(SESSION_ID);
      expect(['invalid', 'unsupported']).toContain(actual.kind);
      expect(memory.stores.get(SESSIONS_STORE)?.get(SESSION_ID)).toEqual(row);
      expect(memory.stores.get(LEGACY_ARCHIVE_STORE)?.size ?? 0).toBe(0);
    }
  });

  it('keeps known-fact 1.4 a dormant migration contract, not an active 1.3 save target', async () => {
    const source = await source13();
    expect((await planKnownFactMigration(source)).kind).toBe('ready');
    const memory = installMigrationDatabase();
    seedLegacy(memory, source);
    const upgraded = await migrateSession13To14ForReview(SESSION_ID);
    expect(upgraded.kind).toBe('migrated');
    if (upgraded.kind !== 'migrated') return;
    expect((await planKnownFactMigration(upgraded.session)).kind).toBe('current');
    expect((await planSemanticMigration(upgraded.session)).kind).toBe('unsupported');
  });
});


describe('34A2B2A dormant 1.4 read/save and immutable history boundary', () => {
  afterEach(() => vi.unstubAllGlobals());

  async function state14() {
    const source = await createSemanticSession(generalDiscoveryPack, { clientLabel: 'Synthetic known-fact durability' }, new Date('2026-11-03T15:00:00.000Z'));
    source.sessionId = SESSION_ID;
    source.knownFacts.push({
      id: 'synthetic-fact-a', label: 'Synthetic hosting fact',
      value: 'Managed hosting', provenance: 'Synthetic test plan', questionId: 'existing-presence',
    });
    return { source, upgraded: await migrateSemantic13ToKnownFact14(source) };
  }

  it('loads only validated 1.4 records and refuses to interpret 1.3 as canonical 1.4', async () => {
    const memory = installMigrationDatabase();
    const { source, upgraded } = await state14();
    expect(await loadKnownFactSession14ForReview(SESSION_ID)).toBeUndefined();
    seedLegacy(memory, source);
    await expect(loadKnownFactSession14ForReview(SESSION_ID)).rejects.toThrow(/schema version/i);
    memory.stores.get(SESSIONS_STORE)?.set(SESSION_ID, structuredClone(upgraded));
    expect(await loadKnownFactSession14ForReview(SESSION_ID)).toEqual(upgraded);
    const mismatch = { ...structuredClone(upgraded), sessionId: 'another-session' };
    memory.stores.get(SESSIONS_STORE)?.set(SESSION_ID, mismatch);
    await expect(loadKnownFactSession14ForReview(SESSION_ID)).rejects.toThrow(/identity/i);
  });

  it('creates an explicit 1.4 record while preserving all fields and does not touch revision history when new', async () => {
    const memory = installMigrationDatabase();
    const { upgraded } = await state14();
    const next = await saveKnownFactSession14ForReview(upgraded, null);
    expect(next.sessionSchemaVersion).toBe('1.4.0');
    expect(next.revisionId).not.toBe(upgraded.revisionId);
    expect(next.parentRevisionId).toBeNull();
    expect(next.knownFactLedger).toEqual(upgraded.knownFactLedger);
    expect(memory.stores.get(SESSIONS_STORE)?.get(SESSION_ID)).toEqual(next);
    expect(memory.stores.get(REVISION_HISTORY_STORE)?.size).toBe(0);
    expect(await loadKnownFactSession14ForReview(SESSION_ID)).toEqual(next);
  });

  it('saves canonical 1.4 edits with CAS, retains exact prior revision, and appends accepted-fact history', async () => {
    const memory = installMigrationDatabase();
    const { upgraded } = await state14();
    seedLegacy(memory, upgraded);
    const initial = structuredClone(upgraded);
    const editing = structuredClone(upgraded);
    editing.knownFactLedger = acceptKnownFact(editing.knownFactLedger, {
      id: 'accept-fact-a', factId: 'synthetic-fact-a',
      expectedRevisionId: editing.revisionId, currentRevisionId: editing.revisionId,
      acceptedAt: '2026-11-03T15:01:00.000Z',
    });
    editing.runningNotes = 'Edited synthetic note';
    const saved = await saveKnownFactSession14ForReview(editing, initial.revisionId);
    expect(saved.revisionId).not.toBe(initial.revisionId);
    expect(saved.parentRevisionId).toBe(initial.revisionId);
    expect(saved.knownFactLedger.acceptances).toHaveLength(1);
    expect(memory.stores.get(REVISION_HISTORY_STORE)?.get(revisionHistoryKey(SESSION_ID, initial.revisionId))).toEqual(initial);
    expect(memory.stores.get(SESSIONS_STORE)?.get(SESSION_ID)).toEqual(saved);
    expect(await loadKnownFactSession14ForReview(SESSION_ID)).toEqual(saved);
  });

  it('prevents the live 1.3 writer or a 1.4 shortcut from overwriting another session schema', async () => {
    const memory = installMigrationDatabase();
    const { source, upgraded } = await state14();
    seedLegacy(memory, source);
    await expect(saveKnownFactSession14ForReview(upgraded, source.revisionId)).rejects.toThrow(/schema version/i);
    expect(memory.stores.get(SESSIONS_STORE)?.get(SESSION_ID)).toEqual(source);
    memory.stores.get(SESSIONS_STORE)?.set(SESSION_ID, structuredClone(upgraded));
    source.revisionId = upgraded.revisionId;
    await expect(saveSession(source, upgraded.revisionId)).rejects.toThrow(/1.3 writer/i);
    expect(memory.stores.get(SESSIONS_STORE)?.get(SESSION_ID)).toEqual(upgraded);
  });

  it('rejects stale writes from another tab without changing the authoritative 1.4 revision', async () => {
    const memory = installMigrationDatabase();
    const { upgraded } = await state14();
    seedLegacy(memory, upgraded);
    const tabA = structuredClone(upgraded);
    tabA.runningNotes = 'Tab A';
    const savedA = await saveKnownFactSession14ForReview(tabA, upgraded.revisionId);
    const tabB = structuredClone(upgraded);
    tabB.runningNotes = 'Tab B stale';
    await expect(saveKnownFactSession14ForReview(tabB, upgraded.revisionId)).rejects.toBeInstanceOf(RevisionConflictError);
    expect(memory.stores.get(SESSIONS_STORE)?.get(SESSION_ID)).toEqual(savedA);
    expect(memory.stores.get(REVISION_HISTORY_STORE)?.size).toBe(1);
  });

  it('rejects rewriting pinned source facts, correction lineage, acceptance events or pack identities', async () => {
    const memory = installMigrationDatabase();
    const { upgraded } = await state14();
    const accepted = structuredClone(upgraded);
    accepted.knownFactLedger = acceptKnownFact(accepted.knownFactLedger, {
      id: 'accept-fact-a', factId: 'synthetic-fact-a',
      expectedRevisionId: accepted.revisionId, currentRevisionId: accepted.revisionId,
      acceptedAt: '2026-11-03T15:01:00.000Z',
    });
    accepted.knownFactLedger = correctKnownFact(accepted.knownFactLedger, {
      id: 'corrected-fact-a', supersedesFactId: 'synthetic-fact-a',
      value: 'Private hosting', provenance: 'Synthetic corrected context',
      expectedRevisionId: accepted.revisionId, currentRevisionId: accepted.revisionId,
    });
    seedLegacy(memory, accepted);
    const mutations = [
      (draft: typeof accepted) => { draft.knownFactLedger.facts.pop(); },
      (draft: typeof accepted) => { draft.knownFactLedger.acceptances.pop(); },
      (draft: typeof accepted) => { draft.knownFactLedger.acceptances[0]!.revisionId = 'rewritten-revision'; },
      (draft: typeof accepted) => { draft.knownFacts[0]!.value = 'Silently modified root'; draft.knownFactLedger.facts[0]!.value = 'Silently modified root'; },
      (draft: typeof accepted) => { draft.packIdentity.digest = 'a'.repeat(64); },
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(accepted);
      mutate(changed);
      await expect(saveKnownFactSession14ForReview(changed, accepted.revisionId)).rejects.toThrow();
      expect(memory.stores.get(SESSIONS_STORE)?.get(SESSION_ID)).toEqual(accepted);
    }
    expect(memory.stores.get(REVISION_HISTORY_STORE)?.size ?? 0).toBe(0);
  });

  it('refuses a pre-existing conflicting history record with zero writes', async () => {
    const memory = installMigrationDatabase();
    const { upgraded } = await state14();
    seedLegacy(memory, upgraded);
    const oldHistory = { ...structuredClone(upgraded), runningNotes: 'Conflicting existing history' };
    memory.stores.set(REVISION_HISTORY_STORE, new Map([[revisionHistoryKey(SESSION_ID, upgraded.revisionId), oldHistory]]));
    await expect(saveKnownFactSession14ForReview(upgraded, upgraded.revisionId)).rejects.toBeInstanceOf(RevisionHistoryConflictError);
    expect(memory.stores.get(SESSIONS_STORE)?.get(SESSION_ID)).toEqual(upgraded);
    expect(memory.stores.get(REVISION_HISTORY_STORE)?.size).toBe(1);
  });

  it.each([
    ['history write failure', { fail: 'history-put' as const }],
    ['current write failure', { fail: 'session-put' as const }],
    ['abort after staged writes', { abortAtCommit: true }],
  ])('rolls back current and immutable history together on %s', async (_label, options) => {
    const memory = installMigrationDatabase(options);
    const { upgraded } = await state14();
    seedLegacy(memory, upgraded);
    await expect(saveKnownFactSession14ForReview(upgraded, upgraded.revisionId)).rejects.toThrow();
    expect(memory.stores.get(SESSIONS_STORE)?.get(SESSION_ID)).toEqual(upgraded);
    expect(memory.stores.get(REVISION_HISTORY_STORE)?.size ?? 0).toBe(0);
  });
});

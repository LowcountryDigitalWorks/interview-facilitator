import { afterEach, describe, expect, it, vi } from 'vitest';
import { generalDiscoveryPack100 } from '../src/historical-packs/general-discovery-1.0.0';
import { canonicalizeJson, createPinnedSession, sha256Hex, validateHistoricalPinned11Record, validateSessionRecord } from '../src/pack-identity';
import { generalDiscoveryPack } from '../src/pack';
import {
  INDEXED_DB_LAYOUT_VERSION,
  LEGACY_TO_PINNED_MIGRATION_ID,
  RULE_SEMANTICS_VERSION,
  legacyArchiveKey,
  migratePinned11To12,
  migrationRegistry,
  planCurrentMigration,
  planLegacyMigration,
} from '../src/session-migration';
import { LEGACY_ARCHIVE_STORE, SESSIONS_STORE, listSessions, migrateLegacySession } from '../src/storage';

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

function installMigrationDatabase(options: { fail?: 'archive-get' | 'archive-put' | 'session-put'; abortWrite?: boolean; abortAtCommit?: boolean; swapSecondRead?: unknown } = {}) {
  const stores = new Map<string, Map<string, unknown>>();
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
                  if (sessionReads === 2 && options.swapSecondRead !== undefined) value = options.swapSecondRead;
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
                  || (options.fail === 'session-put' && name === SESSIONS_STORE && names.includes(LEGACY_ARCHIVE_STORE));
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
            if (options.abortAtCommit && mode === 'readwrite' && names.includes(LEGACY_ARCHIVE_STORE)) {
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
      if (options.abortWrite && mode === 'readwrite' && names.includes(LEGACY_ARCHIVE_STORE)) queueMicrotask(() => tx.abort());
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
    expect(INDEXED_DB_LAYOUT_VERSION).toBe(2);
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
    expect(memory.version()).toBe(2);
    expect(memory.stores.has(LEGACY_ARCHIVE_STORE)).toBe(true);
    expect(memory.stores.get(LEGACY_ARCHIVE_STORE)?.size).toBe(0);
    expect(listed.sessions).toHaveLength(0);
    expect(listed.unreadableCount).toBe(1);
    expect(memory.stores.get(SESSIONS_STORE)?.get(SESSION_ID)).toEqual(source);
  });

  it('stores one current 1.1 row and one raw archived 1.0 row', async () => {
    const memory = installMigrationDatabase();
    const source = legacyRecord();
    seedLegacy(memory, source);
    const result = await migrateLegacySession(SESSION_ID);
    expect(result.kind).toBe('migrated');
    if (result.kind !== 'migrated') return;
    const current = memory.stores.get(SESSIONS_STORE)?.get(SESSION_ID);
    const archived = memory.stores.get(LEGACY_ARCHIVE_STORE)?.get(legacyArchiveKey(SESSION_ID));
    expect(current).toEqual(result.session);
    expect(result.session.sessionSchemaVersion).toBe('1.2.0');
    expect(result.session.packSnapshot.ruleSemanticsVersion).toBe(RULE_SEMANTICS_VERSION);
    expect(archived).toEqual(source);
    expect(memory.stores.get(LEGACY_ARCHIVE_STORE)?.size).toBe(1);
    expect(result.session.createdAt).toBe(source.createdAt);
    expect(result.session.updatedAt).toBe(source.updatedAt);
  });

  it('migrates persisted 1.1 through storage and archives the untouched source', async () => {
    const memory = installMigrationDatabase();
    const source = await pinned11Record();
    source.sessionId = SESSION_ID;
    seedLegacy(memory, source);
    const result = await migrateLegacySession(SESSION_ID);
    expect(result.kind).toBe('migrated');
    expect(memory.stores.get(SESSIONS_STORE)?.get(SESSION_ID)).toMatchObject({ sessionSchemaVersion: '1.2.0' });
    expect(memory.stores.get(LEGACY_ARCHIVE_STORE)?.get(legacyArchiveKey(SESSION_ID, '1.1.0', 'pinned-1.1-to-1.2'))).toEqual(source);
    expect(legacyArchiveKey(SESSION_ID, '1.0.0', 'legacy-1.0-to-1.1')).not.toBe(legacyArchiveKey(SESSION_ID, '1.1.0', 'pinned-1.1-to-1.2'));
    const repeat = await migrateLegacySession(SESSION_ID);
    expect(repeat.kind).toBe('already-migrated');
  });

  it('keeps 1.1 validation explicit and verifies sequential 1.0→1.1→1.2 equivalence', async () => {
    const historical = await pinned11Record();
    await expect(validateSessionRecord(historical)).rejects.toThrow(/unsupported session schema/i);
    await expect(validateHistoricalPinned11Record(historical)).resolves.toMatchObject({ sessionSchemaVersion: '1.1.0' });

    const source10 = legacyRecord();
    const intermediate = await planLegacyMigration(source10);
    const sequential = intermediate.kind === 'ready' ? await migratePinned11To12(intermediate.session) : intermediate;
    const direct = await planCurrentMigration(source10);
    expect(sequential.kind).toBe('ready');
    expect(direct.kind).toBe('ready');
    if (sequential.kind === 'ready' && direct.kind === 'ready') {
      expect(canonicalizeJson(sequential.session)).toBe(canonicalizeJson(direct.session));
    }
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

  it('prefers the latest 1.1 source archive when both migration archives exist', async () => {
    const memory = installMigrationDatabase();
    const source10 = legacyRecord();
    seedLegacy(memory, source10);
    const first = await migrateLegacySession(SESSION_ID);
    expect(first.kind).toBe('migrated');
    const current = memory.stores.get(SESSIONS_STORE)?.get(SESSION_ID) as Awaited<ReturnType<typeof createPinnedSession>>;
    const edited11 = structuredClone(current);
    edited11.sessionSchemaVersion = '1.1.0';
    edited11.runningNotes = 'Edited after the first migration.';
    delete edited11.packSnapshot.ruleSemanticsVersion;
    edited11.packIdentity.digest = await sha256Hex(canonicalizeJson(edited11.packSnapshot));
    seedLegacy(memory, edited11);
    const second = await migrateLegacySession(SESSION_ID);
    expect(second.kind).toBe('migrated');
    expect(memory.stores.get(LEGACY_ARCHIVE_STORE)?.has(legacyArchiveKey(SESSION_ID, '1.0.0', LEGACY_TO_PINNED_MIGRATION_ID))).toBe(true);
    expect(memory.stores.get(LEGACY_ARCHIVE_STORE)?.has(legacyArchiveKey(SESSION_ID, '1.1.0', 'pinned-1.1-to-1.2'))).toBe(true);
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
    const { sessionSchemaVersion: _firstVersion, packSnapshot: firstSnapshot, packIdentity: _firstIdentity, ...firstState } = first.session;
    const { sessionSchemaVersion: _secondVersion, packSnapshot: secondSnapshot, packIdentity: _secondIdentity, ...secondState } = second.session;
    expect(firstState).toEqual(source && (({ sessionSchemaVersion: _version, packSnapshot: _snapshot, packIdentity: _identity, ...state }) => state)(source));
    expect(secondState).toEqual(firstState);
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

  it('retries a completed migration without a second archive entry', async () => {
    const memory = installMigrationDatabase();
    const source = legacyRecord();
    seedLegacy(memory, source);
    const first = await migrateLegacySession(SESSION_ID);
    const archived = memory.stores.get(LEGACY_ARCHIVE_STORE)?.get(legacyArchiveKey(SESSION_ID));
    const second = await migrateLegacySession(SESSION_ID);
    expect(first.kind).toBe('migrated');
    expect(second.kind).toBe('already-migrated');
    expect(memory.stores.get(LEGACY_ARCHIVE_STORE)?.size).toBe(1);
    expect(memory.stores.get(LEGACY_ARCHIVE_STORE)?.get(legacyArchiveKey(SESSION_ID))).toBe(archived);
    if (first.kind !== 'migrated' || second.kind !== 'already-migrated') return;
    expect(canonicalizeJson(second.session)).toBe(canonicalizeJson(first.session));
  });

  it('preserves an identical pre-existing archive while migrating', async () => {
    const memory = installMigrationDatabase();
    const source = legacyRecord();
    seedLegacy(memory, source);
    const archive = structuredClone(source);
    seedArchive(memory, archive);
    const result = await migrateLegacySession(SESSION_ID);
    expect(result.kind).toBe('migrated');
    expect(memory.stores.get(LEGACY_ARCHIVE_STORE)?.size).toBe(1);
    expect(memory.stores.get(LEGACY_ARCHIVE_STORE)?.get(legacyArchiveKey(SESSION_ID))).toBe(archive);
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

  it('does not rewrite a current session that has no legacy archive', async () => {
    const memory = installMigrationDatabase();
    const current = await createPinnedSession(generalDiscoveryPack, { clientLabel: 'Synthetic Client' }, new Date('2026-10-31T12:00:00.000Z'));
    current.sessionId = SESSION_ID;
    seedLegacy(memory, current);
    const result = await migrateLegacySession(SESSION_ID);
    expect(result.kind).toBe('not-legacy');
    expect(memory.stores.get(SESSIONS_STORE)?.get(SESSION_ID)).toEqual(current);
    expect(memory.stores.get(LEGACY_ARCHIVE_STORE)?.size ?? 0).toBe(0);
  });
});

import { expect, test } from '@playwright/test';

/**
 * #34 READ-ONLY-TO-PRODUCTION source proof. Actual existing 1.3→1.4
 * migration adapter, backed by real IndexedDB in the separate Vite test
 * origin. Synthetic source rows only. No live PWA entry or schema activation.
 *
 * Fault hooks are installed inside isolated Chromium test pages and always
 * restored. They do NOT ship in the application or production bundle.
 */
test.beforeEach(async ({ page }) => {
  await page.goto('/tests/browser/fixtures/readback.html');
});

test('legitimate competing 1.3 save during migration planning wins; stale plan writes no archive', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const [pack, semantic, storage, known, migration, identity] = await Promise.all([
      '/src/pack.ts', '/src/semantic-session.ts', '/src/storage.ts',
      '/src/known-fact-session.ts', '/src/session-migration.ts', '/src/pack-identity.ts',
    ].map(load));
    const initial = await semantic.createSemanticSession(pack.generalDiscoveryPack, {
      clientLabel: 'SYNTHETIC STALE PLAN',
    }, new Date('2026-11-07T08:00:00.000Z'));
    const old = await storage.saveSession(initial, null);
    const subtlePrototype = Object.getPrototypeOf(crypto.subtle) as SubtleCrypto;
    const originalDigest = subtlePrototype.digest;
    let trapped = false;
    let release!: () => void;
    let notify!: () => void;
    const paused = new Promise<void>((resolve) => { notify = resolve; });
    const resume = new Promise<void>((resolve) => { release = resolve; });

    // Intercept ONLY the first SHA validation in the migration planner after
    // it has read its source. This is deterministic TOCTOU, not a delay guess.
    subtlePrototype.digest = (function (
      this: SubtleCrypto, algorithm: AlgorithmIdentifier, data: BufferSource,
    ): Promise<ArrayBuffer> {
      if (!trapped) {
        trapped = true;
        notify();
        return resume.then(() => originalDigest.call(this, algorithm, data));
      }
      return originalDigest.call(this, algorithm, data);
    }) as SubtleCrypto['digest'];

    let updated: { sessionId: string; revisionId: string; runningNotes: string } | null = null;
    let outcome: { kind: string } | null = null;
    try {
      const pending = storage.migrateSession13To14ForReview(old.sessionId);
      await paused;
      // Legitimate concurrent save, from the 1.3 writer, while migration
      // validation has not yet completed. Must be retained, not overwritten.
      updated = await storage.saveSession({
        ...old, runningNotes: 'SYNTHETIC CONCURRENT AUTHOR WINS',
        updatedAt: '2026-11-07T08:01:00.000Z',
      }, old.revisionId);
      release();
      outcome = await pending;
    } finally {
      release();
      subtlePrototype.digest = originalDigest;
    }
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('ldw-interview-facilitator', 4);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const key = migration.legacyArchiveKey(
      old.sessionId, '1.3.0', known.SEMANTIC_13_TO_KNOWN_FACT_14_MIGRATION_ID,
    );
    const tx = db.transaction(['sessions', 'legacy-session-archive', 'revision-history'], 'readonly');
    const read = (request: IDBRequest) => new Promise<unknown>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const [current, archive, historyKeys] = await Promise.all([
      read(tx.objectStore('sessions').get(old.sessionId)),
      read(tx.objectStore('legacy-session-archive').get(key)),
      read(tx.objectStore('revision-history').getAllKeys()),
    ]);
    db.close();
    return {
      pausedInPlanner: trapped,
      outcome: outcome?.kind,
      preservedNewRevision: (current as { revisionId: string }).revisionId === updated?.revisionId,
      preservedEdit: (current as { runningNotes: string }).runningNotes,
      preserved13: (current as { sessionSchemaVersion: string }).sessionSchemaVersion,
      noMigrationArchive: archive === undefined,
      noRevisionHistory: (historyKeys as unknown[]).length === 0,
      originalNotReplayed: identity.canonicalizeJson(current) !== identity.canonicalizeJson(old),
    };
  });
  expect(result).toEqual({
    pausedInPlanner: true,
    outcome: 'stale',
    preservedNewRevision: true,
    preservedEdit: 'SYNTHETIC CONCURRENT AUTHOR WINS',
    preserved13: '1.3.0',
    noMigrationArchive: true,
    noRevisionHistory: true,
    originalNotReplayed: true,
  });
});

test('injected session write failure rolls back already-queued migration archive atomically', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const [pack, semantic, storage, known, migration, identity] = await Promise.all([
      '/src/pack.ts', '/src/semantic-session.ts', '/src/storage.ts',
      '/src/known-fact-session.ts', '/src/session-migration.ts', '/src/pack-identity.ts',
    ].map(load));
    const initial = await semantic.createSemanticSession(pack.generalDiscoveryPack, {
      clientLabel: 'SYNTHETIC ABORTED MIGRATION',
    }, new Date('2026-11-07T08:00:00.000Z'));
    const old = await storage.saveSession(initial, null);
    const originalPut = IDBObjectStore.prototype.put;
    let injected = false;
    IDBObjectStore.prototype.put = (function (
      this: IDBObjectStore, value: unknown, key?: IDBValidKey,
    ): IDBRequest {
      if (this.name === 'sessions'
        && value && typeof value === 'object'
        && (value as { sessionSchemaVersion?: unknown }).sessionSchemaVersion === '1.4.0') {
        injected = true;
        // The prior request that queues the archive has already been created.
        // Throw before the row write; adapter must ABORT the entire transaction.
        throw new DOMException('SYNTHETIC SESSION PUT FAILED', 'ConstraintError');
      }
      return key === undefined
        ? originalPut.call(this, value)
        : originalPut.call(this, value, key);
    }) as IDBObjectStore['put'];
    let result: { kind: string } | null = null;
    try {
      result = await storage.migrateSession13To14ForReview(old.sessionId);
    } finally {
      IDBObjectStore.prototype.put = originalPut;
    }
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('ldw-interview-facilitator', 4);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const key = migration.legacyArchiveKey(
      old.sessionId, '1.3.0', known.SEMANTIC_13_TO_KNOWN_FACT_14_MIGRATION_ID,
    );
    const tx = db.transaction(['sessions', 'legacy-session-archive', 'revision-history'], 'readonly');
    const read = (request: IDBRequest) => new Promise<unknown>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const [current, archive, history] = await Promise.all([
      read(tx.objectStore('sessions').get(old.sessionId)),
      read(tx.objectStore('legacy-session-archive').get(key)),
      read(tx.objectStore('revision-history').getAllKeys()),
    ]);
    db.close();
    const retry = await storage.migrateSession13To14ForReview(old.sessionId);
    return {
      injected,
      failedKind: result?.kind,
      sourceUnchanged: identity.canonicalizeJson(current) === identity.canonicalizeJson(old),
      noHalfArchive: archive === undefined,
      noRevisionHistory: (history as unknown[]).length === 0,
      retryKind: retry.kind,
    };
  });
  expect(result).toEqual({
    injected: true,
    failedKind: 'aborted',
    sourceUnchanged: true,
    noHalfArchive: true,
    noRevisionHistory: true,
    retryKind: 'migrated',
  });
});

test('two simultaneous migrations commit exactly once; old 1.3 writer cannot downgrade 1.4', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const [pack, semantic, storage, known, migration, identity] = await Promise.all([
      '/src/pack.ts', '/src/semantic-session.ts', '/src/storage.ts',
      '/src/known-fact-session.ts', '/src/session-migration.ts', '/src/pack-identity.ts',
    ].map(load));
    const initial = await semantic.createSemanticSession(pack.generalDiscoveryPack, {
      clientLabel: 'SYNTHETIC TWO MIGRATORS',
    }, new Date('2026-11-07T08:00:00.000Z'));
    const old = await storage.saveSession(initial, null);
    const outcomes = await Promise.all([
      storage.migrateSession13To14ForReview(old.sessionId),
      storage.migrateSession13To14ForReview(old.sessionId),
    ]);
    let oldWriterRejected = false;
    try {
      await storage.saveSession({
        ...old, runningNotes: 'SYNTHETIC MUST NOT DOWNGRADE',
        updatedAt: '2026-11-07T08:01:00.000Z',
      }, old.revisionId);
    } catch { oldWriterRejected = true; }

    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('ldw-interview-facilitator', 4);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const key = migration.legacyArchiveKey(
      old.sessionId, '1.3.0', known.SEMANTIC_13_TO_KNOWN_FACT_14_MIGRATION_ID,
    );
    const tx = db.transaction(['sessions', 'legacy-session-archive', 'revision-history'], 'readonly');
    const read = (request: IDBRequest) => new Promise<unknown>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const [current, archive, archiveKeys, historyKeys] = await Promise.all([
      read(tx.objectStore('sessions').get(old.sessionId)),
      read(tx.objectStore('legacy-session-archive').get(key)),
      read(tx.objectStore('legacy-session-archive').getAllKeys()),
      read(tx.objectStore('revision-history').getAllKeys()),
    ]);
    db.close();
    return {
      kinds: outcomes.map((x: { kind: string }) => x.kind).sort(),
      oneMigrate: outcomes.filter((x: { kind: string }) => x.kind === 'migrated').length === 1,
      otherSafe: outcomes.filter((x: { kind: string }) => x.kind !== 'migrated')
        .every((x: { kind: string }) => x.kind === 'stale' || x.kind === 'already-migrated'),
      oldWriterRejected,
      final14: (current as { sessionSchemaVersion: string }).sessionSchemaVersion === '1.4.0',
      exactArchive: identity.canonicalizeJson(archive) === identity.canonicalizeJson(old),
      oneArchive: (archiveKeys as unknown[]).length === 1,
      noRevisionHistory: (historyKeys as unknown[]).length === 0,
      noDowngradeMarker: !(identity.canonicalizeJson(current) as string)
        .includes('SYNTHETIC MUST NOT DOWNGRADE'),
    };
  });
  expect(result.oneMigrate).toBe(true);
  expect(result.otherSafe).toBe(true);
  expect(result.oldWriterRejected).toBe(true);
  expect(result.final14).toBe(true);
  expect(result.exactArchive).toBe(true);
  expect(result.oneArchive).toBe(true);
  expect(result.noRevisionHistory).toBe(true);
  expect(result.noDowngradeMarker).toBe(true);
});

test('archive tampering after successful migration blocks idempotent replay and read-only preflight', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const [pack, semantic, storage, known, migration, preflight, identity] = await Promise.all([
      '/src/pack.ts', '/src/semantic-session.ts', '/src/storage.ts',
      '/src/known-fact-session.ts', '/src/session-migration.ts',
      '/src/known-fact-activation-preflight-14.ts', '/src/pack-identity.ts',
    ].map(load));
    const initial = await semantic.createSemanticSession(pack.generalDiscoveryPack, {
      clientLabel: 'SYNTHETIC PRIVATE TAMPERED ARCHIVE',
    }, new Date('2026-11-07T08:00:00.000Z'));
    const old = await storage.saveSession(initial, null);
    const migrated = await storage.migrateSession13To14ForReview(old.sessionId);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('ldw-interview-facilitator', 4);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const before = await preflight.inspectKnownFact14ActivationDatabaseForReview(db);
    const key = migration.legacyArchiveKey(
      old.sessionId, '1.3.0', known.SEMANTIC_13_TO_KNOWN_FACT_14_MIGRATION_ID,
    );
    const corrupt = db.transaction('legacy-session-archive', 'readwrite');
    corrupt.objectStore('legacy-session-archive').put({ syntheticForgery: true }, key);
    await new Promise<void>((resolve, reject) => {
      corrupt.oncomplete = () => resolve();
      corrupt.onerror = () => reject(corrupt.error);
      corrupt.onabort = () => reject(corrupt.error);
    });
    const after = await preflight.inspectKnownFact14ActivationDatabaseForReview(db);
    const retry = await storage.migrateSession13To14ForReview(old.sessionId);
    const currentRequest = db.transaction('sessions', 'readonly')
      .objectStore('sessions').get(old.sessionId);
    const current = await new Promise<unknown>((resolve, reject) => {
      currentRequest.onsuccess = () => resolve(currentRequest.result);
      currentRequest.onerror = () => reject(currentRequest.error);
    });
    db.close();
    const text = JSON.stringify(after);
    return {
      migrated: migrated.kind,
      initiallyPass: before.disposition,
      afterBlocked: after.disposition,
      codes: after.findings.map((x: { code: string }) => x.code),
      noDisclosure: !text.includes('SYNTHETIC PRIVATE')
        && !text.includes(old.sessionId),
      retryKind: retry.kind,
      original14StillCurrent: identity.canonicalizeJson(current)
        === identity.canonicalizeJson(migrated.kind === 'migrated' ? migrated.session : null),
    };
  });
  expect(result).toEqual({
    migrated: 'migrated',
    initiallyPass: 'INSPECTION_PASS',
    afterBlocked: 'BLOCKED',
    codes: ['ARCHIVE_REPLAY_INVALID'],
    noDisclosure: true,
    retryKind: 'conflict',
    original14StillCurrent: true,
  });
});

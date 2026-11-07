import { expect, test } from '@playwright/test';

/**
 * #34 dormant source-only real-Chromium IndexedDB harness.
 * Runs on the test-only Vite dev-server origin. No live 1.3 UI, production
 * bundle, provider, real client data, schema migration button, or cloud sync.
 */
test.beforeEach(async ({ page }) => {
  await page.goto('/tests/browser/fixtures/readback.html');
});

test('1.4 CAS keeps one concurrent writer, immutable history and verified backup', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const [pack, semantic, known, storage, backup, identity] = await Promise.all([
      '/src/pack.ts', '/src/semantic-session.ts', '/src/known-fact-session.ts',
      '/src/storage.ts', '/src/known-fact-backup-14.ts', '/src/pack-identity.ts',
    ].map(load));
    const old = await semantic.createSemanticSession(pack.generalDiscoveryPack, {
      clientLabel: 'Synthetic concurrent storage',
    }, new Date('2026-11-07T08:00:00.000Z'));
    const source14 = await known.migrateSemantic13ToKnownFact14(old);
    const originalRevision = source14.revisionId;
    const first = await storage.saveKnownFactSession14ForReview(source14, null);
    const left = structuredClone(first);
    left.updatedAt = '2026-11-07T08:01:00.000Z';
    left.runningNotes = 'SYNTHETIC WRITER A';
    const right = structuredClone(first);
    right.updatedAt = '2026-11-07T08:02:00.000Z';
    right.runningNotes = 'SYNTHETIC WRITER B';
    const outcomes = await Promise.allSettled([
      storage.saveKnownFactSession14ForReview(left, first.revisionId),
      storage.saveKnownFactSession14ForReview(right, first.revisionId),
    ]);
    const winners = outcomes.filter((item) => item.status === 'fulfilled');
    const failures = outcomes.filter((item) => item.status === 'rejected')
      .map((item) => (item as PromiseRejectedResult).reason?.name);
    const current = await storage.loadKnownFactSession14ForReview(first.sessionId);
    const bytes = await backup.createKnownFact14CanonicalBackupForReview(current);
    const restored = await backup.validateKnownFact14CanonicalBackupForReview(bytes);

    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('ldw-interview-facilitator', 4);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const tx = db.transaction(['sessions', 'revision-history'], 'readonly');
    const read = (request: IDBRequest) => new Promise<unknown>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const [stored, archived, historyKeys] = await Promise.all([
      read(tx.objectStore('sessions').get(first.sessionId)),
      read(tx.objectStore('revision-history').get(storage.revisionHistoryKey(first.sessionId, first.revisionId))),
      read(tx.objectStore('revision-history').getAllKeys()),
    ]);
    db.close();
    return {
      createdWithoutEditingSource: source14.revisionId === originalRevision,
      changedRevision: current.revisionId !== first.revisionId,
      parentRevision: current.parentRevisionId === first.revisionId,
      winnerCount: winners.length,
      failureNames: failures,
      storedMatchesCurrent: JSON.stringify(stored) === JSON.stringify(current),
      historyMatchesOriginal: JSON.stringify(archived) === JSON.stringify(first),
      historyCount: (historyKeys as unknown[]).length,
      currentNotes: current.runningNotes,
      backupMatchesCurrent: identity.canonicalizeJson(JSON.parse(JSON.stringify(restored)))
        === identity.canonicalizeJson(JSON.parse(JSON.stringify(current))),
      backupClassifiedInternal: bytes.includes('INTERNAL / CONFIDENTIAL'),
    };
  });
  expect(result.createdWithoutEditingSource).toBe(true);
  expect(result.changedRevision).toBe(true);
  expect(result.parentRevision).toBe(true);
  expect(result.winnerCount).toBe(1);
  expect(result.failureNames).toEqual(['RevisionConflictError']);
  expect(result.storedMatchesCurrent).toBe(true);
  expect(result.historyMatchesOriginal).toBe(true);
  expect(result.historyCount).toBe(1);
  expect(result.currentNotes).toMatch(/^SYNTHETIC WRITER [AB]$/);
  expect(result.backupMatchesCurrent).toBe(true);
  expect(result.backupClassifiedInternal).toBe(true);
});

test('1.3 to 1.4 local archive is reversible evidence; conflicting archive aborts', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const [pack, semantic, known, storage, migration] = await Promise.all([
      '/src/pack.ts', '/src/semantic-session.ts', '/src/known-fact-session.ts',
      '/src/storage.ts', '/src/session-migration.ts',
    ].map(load));
    const old = await semantic.createSemanticSession(pack.generalDiscoveryPack, {
      clientLabel: 'Synthetic versioned migration',
    }, new Date('2026-11-07T08:00:00.000Z'));
    const saved = await storage.saveSession(old, null);
    const migrated = await storage.migrateSession13To14ForReview(saved.sessionId);
    const again = await storage.migrateSession13To14ForReview(saved.sessionId);

    const collisionSource = await semantic.createSemanticSession(pack.generalDiscoveryPack, {
      clientLabel: 'Synthetic protected archive conflict',
    }, new Date('2026-11-07T08:00:00.000Z'));
    const second = await storage.saveSession(collisionSource, null);
    const collisionKey = migration.legacyArchiveKey(second.sessionId, '1.3.0',
      known.SEMANTIC_13_TO_KNOWN_FACT_14_MIGRATION_ID);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('ldw-interview-facilitator', 4);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('legacy-session-archive', 'readwrite');
      tx.objectStore('legacy-session-archive').put({ syntheticConflict: true }, collisionKey);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    const collision = await storage.migrateSession13To14ForReview(second.sessionId);
    const read = (request: IDBRequest) => new Promise<unknown>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const key = migration.legacyArchiveKey(saved.sessionId, '1.3.0',
      known.SEMANTIC_13_TO_KNOWN_FACT_14_MIGRATION_ID);
    const tx = db.transaction(['sessions', 'legacy-session-archive'], 'readonly');
    const [firstStored, sourceArchive, secondStored, collisionArchive, archiveKeys] = await Promise.all([
      read(tx.objectStore('sessions').get(saved.sessionId)),
      read(tx.objectStore('legacy-session-archive').get(key)),
      read(tx.objectStore('sessions').get(second.sessionId)),
      read(tx.objectStore('legacy-session-archive').get(collisionKey)),
      read(tx.objectStore('legacy-session-archive').getAllKeys()),
    ]);
    db.close();
    return {
      migratedKind: migrated.kind,
      idempotentKind: again.kind,
      currentIs14: (firstStored as { sessionSchemaVersion: string }).sessionSchemaVersion === '1.4.0',
      exactArchivedSource: JSON.stringify(sourceArchive) === JSON.stringify(saved),
      conflictKind: collision.kind,
      collisionLeft13: JSON.stringify(secondStored) === JSON.stringify(second),
      collisionArchiveIntact: JSON.stringify(collisionArchive) === JSON.stringify({ syntheticConflict: true }),
      archivesCount: (archiveKeys as unknown[]).length,
    };
  });
  expect(result).toEqual({
    migratedKind: 'migrated',
    idempotentKind: 'already-migrated',
    currentIs14: true,
    exactArchivedSource: true,
    conflictKind: 'conflict',
    collisionLeft13: true,
    collisionArchiveIntact: true,
    archivesCount: 2,
  });
});

test('1.4 rejected provenance regression cannot overwrite or archive a new revision', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const [pack, semantic, known, storage, evidence] = await Promise.all([
      '/src/pack.ts', '/src/semantic-session.ts', '/src/known-fact-session.ts',
      '/src/storage.ts', '/src/known-fact-evidence.ts',
    ].map(load));
    const old = await semantic.createSemanticSession(pack.generalDiscoveryPack, {
      clientLabel: 'Synthetic append-only correction',
    }, new Date('2026-11-07T08:00:00.000Z'));
    const source14 = await known.migrateSemantic13ToKnownFact14(old);
    const first = await storage.saveKnownFactSession14ForReview(source14, null);
    const originalFact = first.knownFactLedger.facts[0];
    if (!originalFact) throw new Error('Synthetic pack must provide one known fact.');
    const correction = structuredClone(first);
    correction.updatedAt = '2026-11-07T08:05:00.000Z';
    correction.knownFactLedger = evidence.correctKnownFact(first.knownFactLedger, {
      id: 'synthetic-correction-1', supersedesFactId: originalFact.id,
      value: 'Synthetic corrected source', provenance: 'Synthetic interviewer checked',
      expectedRevisionId: first.revisionId, currentRevisionId: first.revisionId,
    });
    const second = await storage.saveKnownFactSession14ForReview(correction, first.revisionId);
    const regression = structuredClone(second);
    regression.knownFactLedger.facts.pop();
    regression.updatedAt = '2026-11-07T08:06:00.000Z';
    let rejectedName = '';
    try {
      await storage.saveKnownFactSession14ForReview(regression, second.revisionId);
    } catch (error) { rejectedName = (error as Error).name; }
    const persisted = await storage.loadKnownFactSession14ForReview(second.sessionId);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('ldw-interview-facilitator', 4);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const tx = db.transaction('revision-history', 'readonly');
    const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
      const request = tx.objectStore('revision-history').getAllKeys();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return {
      rejectedName,
      revisionUnchanged: persisted.revisionId === second.revisionId,
      correctionsRetained: persisted.knownFactLedger.facts.length === first.knownFactLedger.facts.length + 1,
      historyCount: keys.length,
    };
  });
  expect(result).toEqual({
    rejectedName: 'RevisionHistoryConflictError',
    revisionUnchanged: true,
    correctionsRetained: true,
    historyCount: 1,
  });
});

import { expect, test } from '@playwright/test';

/**
 * #34 source-only verification of a *native asynchronous IndexedDB request
 * failure* in the existing dormant 1.3→1.4 migration transaction.
 *
 * This is not power-loss / fsync / Safari evidence. The interception exists
 * only inside this isolated Chromium test page; the live PWA stays schema 1.3.
 */
test('native asynchronous constraint abort rolls back both 1.3→1.4 writes and permits retry', async ({ page }) => {
  await page.goto('/tests/browser/fixtures/readback.html');
  const result = await page.evaluate(async () => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const [pack, semantic, storage, known, migration, identity] = await Promise.all([
      '/src/pack.ts', '/src/semantic-session.ts', '/src/storage.ts',
      '/src/known-fact-session.ts', '/src/session-migration.ts', '/src/pack-identity.ts',
    ].map(load));
    const initial = await semantic.createSemanticSession(pack.generalDiscoveryPack, {
      clientLabel: 'SYNTHETIC ASYNC IDB ROLLBACK',
    }, new Date('2026-11-08T08:00:00.000Z'));
    const old = await storage.saveSession(initial, null);
    const archiveKey = migration.legacyArchiveKey(
      old.sessionId, '1.3.0', known.SEMANTIC_13_TO_KNOWN_FACT_14_MIGRATION_ID,
    );
    const originalPut = IDBObjectStore.prototype.put;
    let nativeFaultQueued = false;
    let nativeFaultName = '';
    IDBObjectStore.prototype.put = (function (
      this: IDBObjectStore, value: unknown, key?: IDBValidKey,
    ): IDBRequest {
      const putRequest = key === undefined
        ? originalPut.call(this, value)
        : originalPut.call(this, value, key);
      if (!nativeFaultQueued && this.name === 'sessions'
        && value && typeof value === 'object'
        && (value as { sessionSchemaVersion?: unknown }).sessionSchemaVersion === '1.4.0') {
        nativeFaultQueued = true;
        // The migration's prior archive put is already queued; the current
        // row put is now queued. This ADD will hit the *same archive key*
        // after the prior put succeeds, producing an actual async IDBRequest
        // ConstraintError. Do not preventDefault: native abort must roll
        // back the entire transaction, including earlier successful requests.
        const archive = this.transaction.objectStore('legacy-session-archive');
        const conflictRequest = archive.add({ syntheticDuplicate: true }, archiveKey);
        conflictRequest.onerror = () => {
          nativeFaultName = conflictRequest.error?.name ?? 'unknown';
        };
      }
      return putRequest;
    }) as IDBObjectStore['put'];

    let failedKind = '';
    try {
      const outcome = await storage.migrateSession13To14ForReview(old.sessionId);
      failedKind = outcome.kind;
    } finally {
      IDBObjectStore.prototype.put = originalPut;
    }
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('ldw-interview-facilitator', 4);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const tx = db.transaction(['sessions', 'legacy-session-archive', 'revision-history'], 'readonly');
    const read = (request: IDBRequest) => new Promise<unknown>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const [current, archive, historyKeys] = await Promise.all([
      read(tx.objectStore('sessions').get(old.sessionId)),
      read(tx.objectStore('legacy-session-archive').get(archiveKey)),
      read(tx.objectStore('revision-history').getAllKeys()),
    ]);
    db.close();

    // The same legitimate source should still migrate after removing the
    // test fault; no partial archive may poison the retry.
    const retry = await storage.migrateSession13To14ForReview(old.sessionId);
    const proofDb = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('ldw-interview-facilitator', 4);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const verifiedArchive = await read(proofDb.transaction('legacy-session-archive', 'readonly')
      .objectStore('legacy-session-archive').get(archiveKey));
    proofDb.close();
    return {
      nativeFaultQueued,
      nativeFaultName,
      failedKind,
      originalRowUnchanged: identity.canonicalizeJson(current) === identity.canonicalizeJson(old),
      noPartialArchive: archive === undefined,
      noUnexpectedRevisionHistory: (historyKeys as unknown[]).length === 0,
      retryKind: retry.kind,
      exactArchiveAfterRetry: identity.canonicalizeJson(verifiedArchive) === identity.canonicalizeJson(old),
    };
  });

  expect(result).toEqual({
    nativeFaultQueued: true,
    nativeFaultName: 'ConstraintError',
    failedKind: 'aborted',
    originalRowUnchanged: true,
    noPartialArchive: true,
    noUnexpectedRevisionHistory: true,
    retryKind: 'migrated',
    exactArchiveAfterRetry: true,
  });
});

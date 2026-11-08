import { expect, test } from '@playwright/test';

/** Synthetic, source-only Vite fixture. These tests never use real customer records. */
test.beforeEach(async ({ page }) => {
  await page.goto('/tests/browser/fixtures/readback.html');
});

test('preflight reads a real mixed 1.3/1.4 IndexedDB snapshot without mutating rows or archives', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const [pack, semantic, known, migration, preflight, canonical] = await Promise.all([
      '/src/pack.ts', '/src/semantic-session.ts', '/src/known-fact-session.ts',
      '/src/session-migration.ts', '/src/known-fact-activation-preflight-14.ts',
      '/src/pack-identity.ts',
    ].map(load));
    const source13 = await semantic.createSemanticSession(pack.generalDiscoveryPack, {
      clientLabel: 'SYNTHETIC PRIVATE 13 LABEL',
    }, new Date('2026-11-07T13:00:00.000Z'));
    const sourceFor14 = await semantic.createSemanticSession(pack.generalDiscoveryPack, {
      clientLabel: 'SYNTHETIC PRIVATE 14 LABEL',
    }, new Date('2026-11-07T13:01:00.000Z'));
    const source14 = await known.migrateSemantic13ToKnownFact14(sourceFor14);
    const archiveKey = migration.legacyArchiveKey(
      source14.sessionId, '1.3.0', known.SEMANTIC_13_TO_KNOWN_FACT_14_MIGRATION_ID,
    );
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('ldw-interview-facilitator', 4);
      request.onupgradeneeded = () => {
        const handle = request.result;
        handle.createObjectStore('sessions', { keyPath: 'sessionId' });
        handle.createObjectStore('legacy-session-archive');
        handle.createObjectStore('revision-history');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const write = db.transaction(['sessions', 'legacy-session-archive'], 'readwrite');
    write.objectStore('sessions').put(source13);
    write.objectStore('sessions').put(source14);
    write.objectStore('legacy-session-archive').put(sourceFor14, archiveKey);
    await new Promise<void>((resolve, reject) => {
      write.oncomplete = () => resolve();
      write.onerror = () => reject(write.error);
      write.onabort = () => reject(write.error);
    });
    const snapshot = async () => {
      const tx = db.transaction(['sessions', 'legacy-session-archive', 'revision-history'], 'readonly');
      const requests = [
        tx.objectStore('sessions').getAllKeys(),
        tx.objectStore('sessions').getAll(),
        tx.objectStore('legacy-session-archive').getAllKeys(),
        tx.objectStore('legacy-session-archive').getAll(),
        tx.objectStore('revision-history').getAllKeys(),
      ];
      const read = (request: IDBRequest) => new Promise<unknown>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      return Promise.all(requests.map(read));
    };
    const before = await snapshot();
    const report = await preflight.inspectKnownFact14ActivationDatabaseForReview(db);
    const after = await snapshot();
    db.close();
    const text = JSON.stringify(report);
    return {
      report,
      unchanged: canonical.canonicalizeJson(before) === canonical.canonicalizeJson(after),
      noPrivateDataInReport: !text.includes('SYNTHETIC PRIVATE')
        && !text.includes(source13.sessionId) && !text.includes(source14.sessionId),
    };
  });
  expect(result.report).toMatchObject({
    format: 'ldw-1.4-readonly-activation-preflight-v1',
    disposition: 'INSPECTION_PASS', activationAuthorized: false,
    externalBackupVerified: false, snapshotOnly: true,
    counts: { sessions: 2, archives: 1, valid13Candidates: 1,
      archived13Candidates: 0, archivesToCreateOnFutureMigration: 1,
      validated14Rows: 1, verified14ArchiveReplays: 1,
      unrelatedArchivesPreserved: 0, blocked: 0 },
    findings: [],
  });
  expect(result.unchanged).toBe(true);
  expect(result.noPrivateDataInReport).toBe(true);
});

test('preflight refuses missing, conflicting and future-schema evidence without any storage writes', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const [pack, semantic, known, migration, preflight, identity] = await Promise.all([
      '/src/pack.ts', '/src/semantic-session.ts', '/src/known-fact-session.ts',
      '/src/session-migration.ts', '/src/known-fact-activation-preflight-14.ts',
      '/src/pack-identity.ts',
    ].map(load));
    const legacy = await semantic.createSemanticSession(pack.generalDiscoveryPack, {
      clientLabel: 'PRIVATE CONFLICTING SOURCE',
    }, new Date('2026-11-07T13:00:00.000Z'));
    const futureSource = await semantic.createSemanticSession(pack.generalDiscoveryPack, {
      clientLabel: 'PRIVATE MISSING ARCHIVE',
    }, new Date('2026-11-07T13:01:00.000Z'));
    const converted = await known.migrateSemantic13ToKnownFact14(futureSource);
    const unsupported = { sessionId: 'synthetic-future-version-id',
      sessionSchemaVersion: '99.0.0', clientLabel: 'PRIVATE FUTURE DATA' };
    const archiveKey = migration.legacyArchiveKey(
      legacy.sessionId, '1.3.0', known.SEMANTIC_13_TO_KNOWN_FACT_14_MIGRATION_ID,
    );
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('ldw-interview-facilitator', 4);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('sessions', { keyPath: 'sessionId' });
        request.result.createObjectStore('legacy-session-archive');
        request.result.createObjectStore('revision-history');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const write = db.transaction(['sessions', 'legacy-session-archive'], 'readwrite');
    for (const row of [legacy, converted, unsupported]) write.objectStore('sessions').put(row);
    write.objectStore('legacy-session-archive').put({ syntheticCollision: true }, archiveKey);
    await new Promise<void>((resolve, reject) => {
      write.oncomplete = () => resolve();
      write.onerror = () => reject(write.error);
      write.onabort = () => reject(write.error);
    });
    const snapshot = async () => {
      const tx = db.transaction(['sessions', 'legacy-session-archive'], 'readonly');
      const requests = [
        tx.objectStore('sessions').getAll(),
        tx.objectStore('legacy-session-archive').getAll(),
      ];
      const read = (request: IDBRequest) => new Promise<unknown>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      return Promise.all(requests.map(read));
    };
    const before = await snapshot();
    const report = await preflight.inspectKnownFact14ActivationDatabaseForReview(db);
    const after = await snapshot();
    db.close();
    const redacted = JSON.stringify(report);
    return {
      disposition: report.disposition,
      authorized: report.activationAuthorized,
      codes: report.findings.map((item: { code: string }) => item.code).sort(),
      unchanged: identity.canonicalizeJson(before) === identity.canonicalizeJson(after),
      noPrivateDataInReport: !redacted.includes('PRIVATE ')
        && !redacted.includes(legacy.sessionId)
        && !redacted.includes(converted.sessionId),
    };
  });
  expect(result).toEqual({
    disposition: 'BLOCKED', authorized: false,
    codes: ['ARCHIVE_CONFLICT', 'ARCHIVE_REQUIRED', 'SOURCE_UNSUPPORTED'],
    unchanged: true, noPrivateDataInReport: true,
  });
});

test('pure preflight rejects ambiguous storage keys, duplicate archives, and a changed 1.4 replay', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const [pack, semantic, known, migration, preflight, identity] = await Promise.all([
      '/src/pack.ts', '/src/semantic-session.ts', '/src/known-fact-session.ts',
      '/src/session-migration.ts', '/src/known-fact-activation-preflight-14.ts',
      '/src/pack-identity.ts',
    ].map(load));
    const source = await semantic.createSemanticSession(pack.generalDiscoveryPack, {
      clientLabel: 'PRIVATE SENSITIVE SOURCE',
    }, new Date('2026-11-07T13:01:00.000Z'));
    const current = await known.migrateSemantic13ToKnownFact14(source);
    const changed = structuredClone(current);
    changed.runningNotes = 'PRIVATE CHANGED SINCE MIGRATION';
    const archiveKey = migration.legacyArchiveKey(
      source.sessionId, '1.3.0', known.SEMANTIC_13_TO_KNOWN_FACT_14_MIGRATION_ID,
    );
    const bogus = structuredClone(source);
    bogus.sessionId = 'different-in-value';
    const report = await preflight.evaluateKnownFact14ActivationSnapshotForReview({
      sessions: [
        { key: source.sessionId, value: bogus },
        { key: source.sessionId, value: source },
        { key: current.sessionId + '-wrong-key', value: current },
        { key: current.sessionId, value: changed },
        { key: null, value: source },
      ],
      archives: [
        { key: archiveKey, value: source },
        { key: archiveKey, value: { hidden: true } },
        { key: 42, value: source },
      ],
    });
    const invalid = await preflight.evaluateKnownFact14ActivationSnapshotForReview({
      sessions: new Array(preflight.ACTIVATION_PREFLIGHT_MAX_ROWS + 1).fill(null),
      archives: [],
    });
    const output = JSON.stringify(report);
    return {
      disposition: report.disposition,
      codes: report.findings.map((item: { code: string }) => item.code).sort(),
      blockCount: report.counts.blocked,
      noPrivateData: !output.includes('PRIVATE') && !output.includes(source.sessionId),
      oversizedBlocked: invalid.disposition === 'BLOCKED'
        && invalid.findings[0].code === 'INVALID_INPUT'
        && invalid.activationAuthorized === false,
      deterministic: identity.canonicalizeJson(report) === identity.canonicalizeJson(
        await preflight.evaluateKnownFact14ActivationSnapshotForReview({
          sessions: [
            { key: source.sessionId, value: bogus },
            { key: source.sessionId, value: source },
            { key: current.sessionId + '-wrong-key', value: current },
            { key: current.sessionId, value: changed },
            { key: null, value: source },
          ],
          archives: [
            { key: archiveKey, value: source },
            { key: archiveKey, value: { hidden: true } },
            { key: 42, value: source },
          ],
        })),
    };
  });
  expect(result).toEqual({
    disposition: 'BLOCKED',
    codes: [
      'ARCHIVE_KEY_DUPLICATE', 'ARCHIVE_KEY_INVALID', 'ARCHIVE_REPLAY_MISMATCH',
      'SOURCE_KEY_DUPLICATE', 'SOURCE_KEY_INVALID', 'SOURCE_KEY_MISMATCH',
      'SOURCE_KEY_MISMATCH',
    ],
    blockCount: 7,
    noPrivateData: true,
    oversizedBlocked: true,
    deterministic: true,
  });
});

test('preflight refuses an unrelated or incorrectly versioned database', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const preflight = await load('/src/known-fact-activation-preflight-14.ts');
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('ldw-different-trial-database', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('sessions');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const before = [...db.objectStoreNames];
    const report = await preflight.inspectKnownFact14ActivationDatabaseForReview(db);
    const after = [...db.objectStoreNames];
    db.close();
    return { report, unchanged: JSON.stringify(before) === JSON.stringify(after) };
  });
  expect(result.report).toMatchObject({
    disposition: 'BLOCKED', activationAuthorized: false,
    findings: [{ scope: 'snapshot', index: 0, code: 'INVALID_INPUT' }],
  });
  expect(result.unchanged).toBe(true);
});

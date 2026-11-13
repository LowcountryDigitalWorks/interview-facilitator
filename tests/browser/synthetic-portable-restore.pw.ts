import { expect, test, type Page } from '@playwright/test';

const DB = 'ldw-interview-facilitator';
const CAP = 'ldw.synthetic-portable-restore-test-only.v1';
const CREATED_AT = '2026-11-13T19:05:00.000Z';

async function clearInterviewDb(page: Page): Promise<void> {
  await page.evaluate(async (name) => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => resolve();
    });
  }, DB);
}

test.describe('synthetic portable restore', () => {
  test('@preview-smoke live shell does not expose synthetic restore harness controls', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: /restore/i })).toHaveCount(0);
    await expect(page.getByText(/synthetic portable restore/i)).toHaveCount(0);
  });

  test.describe('@idb-dev-harness chromium transactional restore', () => {
    test.beforeEach(async ({ page }) => {
      await page.goto('/tests/browser/fixtures/readback.html');
      await clearInterviewDb(page);
    });

    test('imports complete chain into empty stores with exact head and history readback', async ({ page }) => {
      const result = await page.evaluate(async ({ capability, createdAt }) => {
        const load = (path: string) => import(/* @vite-ignore */ path);
        const [pack, semantic, portable, restore, storage] = await Promise.all([
          '/src/pack.ts', '/src/semantic-session.ts', '/src/portable-revision-archive.ts',
          '/src/synthetic-portable-restore.ts', '/src/storage.ts',
        ].map(load));
        const root = await semantic.createSemanticSession(pack.generalDiscoveryPack, {
          clientLabel: 'SYNTHETIC E1 FRESH ORIGIN',
        }, new Date('2026-11-13T16:00:00.000Z'));
        const middle = { ...structuredClone(root) };
        middle.parentRevisionId = root.revisionId;
        middle.revisionId = crypto.randomUUID();
        middle.updatedAt = '2026-11-13T16:10:00.000Z';
        const head = { ...structuredClone(middle) };
        head.parentRevisionId = middle.revisionId;
        head.revisionId = crypto.randomUUID();
        head.updatedAt = '2026-11-13T16:20:00.000Z';
        head.runningNotes = 'SYNTHETIC RETAINED HISTORY TAIL';
        const archive = await portable.createPortableRevisionArchive({
          sessionId: head.sessionId,
          headRevisionId: head.revisionId,
          createdAt,
          revisions: [root, middle, head].map((session) => ({
            revisionId: session.revisionId,
            parentRevisionId: session.parentRevisionId,
            updatedAt: session.updatedAt,
            record: structuredClone(session),
          })),
        });
        const json = portable.serializePortableRevisionArchive(archive);
        const outcome = await restore.importSyntheticPortableArchiveFreshOrigin({
          testOnlyCapability: capability,
          untrustedArchiveJson: json,
          scope: { expectedSessionId: head.sessionId, expectedHeadRevisionId: head.revisionId },
        });
        const listed = await storage.listSessions();
        const loaded = await storage.loadSession(head.sessionId);
        const historyKey = storage.revisionHistoryKey(head.sessionId, root.revisionId);
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open('ldw-interview-facilitator', 4);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const ancestor = await new Promise<unknown>((resolve, reject) => {
          const tx = db.transaction('revision-history', 'readonly');
          const request = tx.objectStore('revision-history').get(historyKey);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        db.close();
        return {
          outcome,
          listedCount: listed.sessions.length,
          headNotes: loaded?.runningNotes ?? null,
          ancestorParent: (ancestor as { parentRevisionId?: string | null } | undefined)?.parentRevisionId ?? null,
        };
      }, { capability: CAP, createdAt: CREATED_AT });

      expect(result.outcome).toMatchObject({
        kind: 'imported',
        retainedRevisionCount: 3,
      });
      expect(result.listedCount).toBe(1);
      expect(result.headNotes).toBe('SYNTHETIC RETAINED HISTORY TAIL');
      expect(result.ancestorParent).toBeNull();
    });

    test('rejects session collision without mutating stores', async ({ page }) => {
      const result = await page.evaluate(async ({ capability, createdAt }) => {
        const load = (path: string) => import(/* @vite-ignore */ path);
        const [pack, semantic, portable, restore, storage] = await Promise.all([
          '/src/pack.ts', '/src/semantic-session.ts', '/src/portable-revision-archive.ts',
          '/src/synthetic-portable-restore.ts', '/src/storage.ts',
        ].map(load));
        const session = await semantic.createSemanticSession(pack.generalDiscoveryPack, {
          clientLabel: 'SYNTHETIC COLLISION GUARD',
        }, new Date('2026-11-13T16:00:00.000Z'));
        const saved = await storage.saveSession(session, null);
        const archive = await portable.createPortableRevisionArchive({
          sessionId: saved.sessionId,
          headRevisionId: saved.revisionId,
          createdAt,
          revisions: [{
            revisionId: saved.revisionId,
            parentRevisionId: saved.parentRevisionId,
            updatedAt: saved.updatedAt,
            record: structuredClone(saved),
          }],
        });
        const outcome = await restore.importSyntheticPortableArchiveFreshOrigin({
          testOnlyCapability: capability,
          untrustedArchiveJson: portable.serializePortableRevisionArchive(archive),
        });
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open('ldw-interview-facilitator', 4);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const historyCount = await new Promise<number>((resolve, reject) => {
          const tx = db.transaction('revision-history', 'readonly');
          const request = tx.objectStore('revision-history').count();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        db.close();
        return {
          outcome,
          rowCount: (await storage.listSessions()).sessions.length,
          historyCount,
        };
      }, { capability: CAP, createdAt: CREATED_AT });
      expect(result.outcome).toEqual({
        kind: 'rejected',
        code: 'session-exists',
        reason: 'Destination session already exists; import aborted.',
      });
      expect(result.rowCount).toBe(1);
      expect(result.historyCount).toBe(0);
    });

    test('rejects orphan revision history prefix', async ({ page }) => {
      const seed = await page.evaluate(async ({ capability, createdAt }) => {
        const load = (path: string) => import(/* @vite-ignore */ path);
        const [pack, semantic, portable, restore, storage] = await Promise.all([
          '/src/pack.ts', '/src/semantic-session.ts', '/src/portable-revision-archive.ts',
          '/src/synthetic-portable-restore.ts', '/src/storage.ts',
        ].map(load));
        const session = await semantic.createSemanticSession(pack.generalDiscoveryPack, {
          clientLabel: 'SYNTHETIC ORPHAN HISTORY',
        }, new Date('2026-11-13T16:00:00.000Z'));
        const archive = await portable.createPortableRevisionArchive({
          sessionId: session.sessionId,
          headRevisionId: session.revisionId,
          createdAt,
          revisions: [{
            revisionId: session.revisionId,
            parentRevisionId: session.parentRevisionId,
            updatedAt: session.updatedAt,
            record: structuredClone(session),
          }],
        });
        await storage.listSessions();
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open('ldw-interview-facilitator', 4);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(['revision-history'], 'readwrite');
          const key = storage.revisionHistoryKey(session.sessionId, session.revisionId);
          tx.objectStore('revision-history').put(structuredClone(session), key);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
        db.close();
        const outcome = await restore.importSyntheticPortableArchiveFreshOrigin({
          testOnlyCapability: capability,
          untrustedArchiveJson: portable.serializePortableRevisionArchive(archive),
        });
        const verifyDb = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open('ldw-interview-facilitator', 4);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const sessionsCount = await new Promise<number>((resolve, reject) => {
          const tx = verifyDb.transaction('sessions', 'readonly');
          const request = tx.objectStore('sessions').count();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        verifyDb.close();
        return { outcome, sessionsCount };
      }, { capability: CAP, createdAt: CREATED_AT });

      expect(seed.outcome).toEqual({
        kind: 'rejected',
        code: 'orphan-history',
        reason: 'Destination has orphan revision history; import aborted.',
      });
      expect(seed.sessionsCount).toBe(0);
    });

    test('fresh browser profile round-trip lists imported synthetic head', async ({ browser }) => {
      const destination = await browser.newContext();
      const page = await destination.newPage();
      try {
        await page.goto('/tests/browser/fixtures/readback.html');
        await clearInterviewDb(page);
        const summary = await page.evaluate(async ({ capability, createdAt }) => {
          const load = (path: string) => import(/* @vite-ignore */ path);
          const [pack, semantic, portable, restore, storage] = await Promise.all([
            '/src/pack.ts', '/src/semantic-session.ts', '/src/portable-revision-archive.ts',
            '/src/synthetic-portable-restore.ts', '/src/storage.ts',
          ].map(load));
          const root = await semantic.createSemanticSession(pack.generalDiscoveryPack, {
            clientLabel: 'SYNTHETIC FRESH PROFILE ROUNDTRIP',
          }, new Date('2026-11-13T17:00:00.000Z'));
          const head = { ...structuredClone(root) };
          head.parentRevisionId = root.revisionId;
          head.revisionId = crypto.randomUUID();
          head.updatedAt = '2026-11-13T17:05:00.000Z';
          const archive = await portable.createPortableRevisionArchive({
            sessionId: head.sessionId,
            headRevisionId: head.revisionId,
            createdAt,
            revisions: [root, head].map((session) => ({
              revisionId: session.revisionId,
              parentRevisionId: session.parentRevisionId,
              updatedAt: session.updatedAt,
              record: structuredClone(session),
            })),
          });
          const outcome = await restore.importSyntheticPortableArchiveFreshOrigin({
            testOnlyCapability: capability,
            untrustedArchiveJson: portable.serializePortableRevisionArchive(archive),
          });
          const listed = await storage.listSessions();
          return {
            outcome,
            labels: listed.sessions.map((row: { clientLabel: string }) => row.clientLabel),
          };
        }, { capability: CAP, createdAt: CREATED_AT });
        expect(summary.outcome.kind).toBe('imported');
        expect(summary.labels).toEqual(['SYNTHETIC FRESH PROFILE ROUNDTRIP']);
      } finally {
        await destination.close();
      }
    });

    test('aborted transaction leaves stores empty after explicit IDB fault', async ({ page }) => {
      const faulted = await page.evaluate(async ({ capability, createdAt }) => {
        const load = (path: string) => import(/* @vite-ignore */ path);
        const [pack, semantic, portable, restore] = await Promise.all([
          '/src/pack.ts', '/src/semantic-session.ts', '/src/portable-revision-archive.ts',
          '/src/synthetic-portable-restore.ts',
        ].map(load));
        const root = await semantic.createSemanticSession(pack.generalDiscoveryPack, {
          clientLabel: 'SYNTHETIC ABORT INJECTION',
        }, new Date('2026-11-13T17:00:00.000Z'));
        const archive = await portable.createPortableRevisionArchive({
          sessionId: root.sessionId,
          headRevisionId: root.revisionId,
          createdAt,
          revisions: [{
            revisionId: root.revisionId,
            parentRevisionId: root.parentRevisionId,
            updatedAt: root.updatedAt,
            record: structuredClone(root),
          }],
        });
        const json = portable.serializePortableRevisionArchive(archive);
        const originalPut = IDBObjectStore.prototype.put;
        let faultedOnce = false;
        IDBObjectStore.prototype.put = function (
          this: IDBObjectStore, value: unknown, key?: IDBValidKey,
        ): IDBRequest {
          const request = key === undefined
            ? originalPut.call(this, value)
            : originalPut.call(this, value, key);
          if (!faultedOnce && this.name === 'sessions') {
            faultedOnce = true;
            queueMicrotask(() => {
              try { this.transaction.abort(); } catch { /* already inactive */ }
            });
          }
          return request;
        };
        let threw = '';
        try {
          await restore.importSyntheticPortableArchiveFreshOrigin({
            testOnlyCapability: capability,
            untrustedArchiveJson: json,
          });
        } catch (error) {
          threw = (error as Error).name;
        } finally {
          IDBObjectStore.prototype.put = originalPut;
        }
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open('ldw-interview-facilitator', 4);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const counts = await new Promise<{ sessions: number; history: number }>((resolve, reject) => {
          const tx = db.transaction(['sessions', 'revision-history'], 'readonly');
          const sessions = tx.objectStore('sessions').count();
          const history = tx.objectStore('revision-history').count();
          Promise.all([
            new Promise<number>((res, rej) => {
              sessions.onsuccess = () => res(sessions.result);
              sessions.onerror = () => rej(sessions.error);
            }),
            new Promise<number>((res, rej) => {
              history.onsuccess = () => res(history.result);
              history.onerror = () => rej(history.error);
            }),
          ]).then(([s, h]) => resolve({ sessions: s, history: h })).catch(reject);
        });
        db.close();
        return { threw, counts };
      }, { capability: CAP, createdAt: CREATED_AT });
      expect(faulted.threw.length).toBeGreaterThan(0);
      expect(faulted.counts).toEqual({ sessions: 0, history: 0 });
    });

    test('rejects strict durability unavailability without mutating stores', async ({ page }) => {
      const outcome = await page.evaluate(async ({ capability, createdAt }) => {
        const load = (path: string) => import(/* @vite-ignore */ path);
        const [pack, semantic, portable, restore, storage] = await Promise.all([
          '/src/pack.ts', '/src/semantic-session.ts', '/src/portable-revision-archive.ts',
          '/src/synthetic-portable-restore.ts', '/src/storage.ts',
        ].map(load));
        const root = await semantic.createSemanticSession(pack.generalDiscoveryPack, {
          clientLabel: 'SYNTHETIC STRICT DURABILITY GUARD',
        }, new Date('2026-11-13T17:30:00.000Z'));
        const archive = await portable.createPortableRevisionArchive({
          sessionId: root.sessionId,
          headRevisionId: root.revisionId,
          createdAt,
          revisions: [{
            revisionId: root.revisionId,
            parentRevisionId: root.parentRevisionId,
            updatedAt: root.updatedAt,
            record: structuredClone(root),
          }],
        });
        const original = IDBDatabase.prototype.transaction;
        IDBDatabase.prototype.transaction = function (
          this: IDBDatabase,
          storeNames: string | string[],
          mode: IDBTransactionMode,
          options?: IDBTransactionOptions,
        ) {
          if (mode === 'readwrite' && options?.durability === 'strict') {
            throw new DOMException('Strict durability unsupported in harness fault.', 'NotSupportedError');
          }
          return original.call(this, storeNames, mode, options);
        };
        let result: { kind: string; code?: string } = { kind: 'none' };
        try {
          result = await restore.importSyntheticPortableArchiveFreshOrigin({
            testOnlyCapability: capability,
            untrustedArchiveJson: portable.serializePortableRevisionArchive(archive),
          });
        } finally {
          IDBDatabase.prototype.transaction = original;
        }
        return {
          outcome: result,
          sessionCount: (await storage.listSessions()).sessions.length,
        };
      }, { capability: CAP, createdAt: CREATED_AT });
      expect(outcome.outcome).toEqual({
        kind: 'rejected',
        code: 'durability-unavailable',
        reason: 'Strict local transaction durability unavailable.',
      });
      expect(outcome.sessionCount).toBe(0);
    });

    test('returns committed-unverified when post-commit readback is armed to fail', async ({ page }) => {
      const result = await page.evaluate(async ({ capability, createdAt }) => {
        const load = (path: string) => import(/* @vite-ignore */ path);
        const [pack, semantic, portable, restore, storage] = await Promise.all([
          '/src/pack.ts', '/src/semantic-session.ts', '/src/portable-revision-archive.ts',
          '/src/synthetic-portable-restore.ts', '/src/storage.ts',
        ].map(load));
        const root = await semantic.createSemanticSession(pack.generalDiscoveryPack, {
          clientLabel: 'SYNTHETIC COMMITTED UNVERIFIED',
        }, new Date('2026-11-13T17:35:00.000Z'));
        const archive = await portable.createPortableRevisionArchive({
          sessionId: root.sessionId,
          headRevisionId: root.revisionId,
          createdAt,
          revisions: [{
            revisionId: root.revisionId,
            parentRevisionId: root.parentRevisionId,
            updatedAt: root.updatedAt,
            record: structuredClone(root),
          }],
        });
        restore.armSyntheticPortableRestorePostCommitReadbackFailureForTests(
          'Harness injected post-commit readback failure.',
        );
        const outcome = await restore.importSyntheticPortableArchiveFreshOrigin({
          testOnlyCapability: capability,
          untrustedArchiveJson: portable.serializePortableRevisionArchive(archive),
        });
        const loaded = await storage.loadSession(root.sessionId);
        restore.clearSyntheticPortableRestoreTestArmsForTests();
        return { outcome, clientLabel: loaded?.clientLabel ?? null };
      }, { capability: CAP, createdAt: CREATED_AT });
      expect(result.outcome).toMatchObject({
        kind: 'committed-unverified',
        reason: 'Harness injected post-commit readback failure.',
      });
      expect(result.clientLabel).toBe('SYNTHETIC COMMITTED UNVERIFIED');
    });

    test('parallel imports to different sessions both commit', async ({ page }) => {
      const summary = await page.evaluate(async ({ capability, createdAt }) => {
        const load = (path: string) => import(/* @vite-ignore */ path);
        const [pack, semantic, portable, restore, storage] = await Promise.all([
          '/src/pack.ts', '/src/semantic-session.ts', '/src/portable-revision-archive.ts',
          '/src/synthetic-portable-restore.ts', '/src/storage.ts',
        ].map(load));
        const build = async (label: string) => {
          const root = await semantic.createSemanticSession(pack.generalDiscoveryPack, {
            clientLabel: label,
          }, new Date('2026-11-13T18:00:00.000Z'));
          const archive = await portable.createPortableRevisionArchive({
            sessionId: root.sessionId,
            headRevisionId: root.revisionId,
            createdAt,
            revisions: [{
              revisionId: root.revisionId,
              parentRevisionId: root.parentRevisionId,
              updatedAt: root.updatedAt,
              record: structuredClone(root),
            }],
          });
          return {
            json: portable.serializePortableRevisionArchive(archive),
            sessionId: root.sessionId,
          };
        };
        const [a, b] = await Promise.all([
          build('SYNTHETIC PARALLEL A'),
          build('SYNTHETIC PARALLEL B'),
        ]);
        const [oa, ob] = await Promise.all([
          restore.importSyntheticPortableArchiveFreshOrigin({
            testOnlyCapability: capability,
            untrustedArchiveJson: a.json,
          }),
          restore.importSyntheticPortableArchiveFreshOrigin({
            testOnlyCapability: capability,
            untrustedArchiveJson: b.json,
          }),
        ]);
        const listed = await storage.listSessions();
        return {
          outcomes: [oa.kind, ob.kind],
          count: listed.sessions.length,
          ids: listed.sessions.map((row: { sessionId: string }) => row.sessionId).sort(),
          expected: [a.sessionId, b.sessionId].sort(),
        };
      }, { capability: CAP, createdAt: CREATED_AT });
      expect(summary.outcomes).toEqual(['imported', 'imported']);
      expect(summary.count).toBe(2);
      expect(summary.ids).toEqual(summary.expected);
    });
  });
});

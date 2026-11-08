import { expect, test } from '@playwright/test';

/**
 * #34 source-only browser contract. This operates only on the isolated 1.4
 * trial IndexedDB origin/database; it cannot touch the live 1.3 interview DB.
 * The deletion below simulates an explicit human-controlled empty-profile
 * recovery trial, NOT an automatic or production data reset.
 */
test('a second tab can delete the trial database because the first yields versionchange', async ({ page, context }) => {
  await page.goto('/tests/browser/fixtures/readback.html');
  const initial = await page.evaluate(async () => {
    const trial = await import(/* @vite-ignore */ '/src/known-fact-lifecycle-storage-trial-14.ts');
    const db = await trial.openKnownFactLifecycleTrial14ForReview();
    (globalThis as typeof globalThis & { __trialConnection?: IDBDatabase }).__trialConnection = db;
    return { version: db.version, stores: db.objectStoreNames.length };
  });
  const other = await context.newPage();
  try {
    await other.goto('/tests/browser/fixtures/readback.html');
    const deletion = await other.evaluate(async () => {
      return await new Promise<{ status: string; blocked: boolean }>((resolve) => {
        let blocked = false;
        const req = indexedDB.deleteDatabase('ldw-interview-lifecycle-14-trial-only');
        req.onblocked = () => { blocked = true; resolve({ status: 'blocked', blocked }); };
        req.onerror = () => resolve({ status: 'error', blocked });
        req.onsuccess = () => resolve({ status: 'deleted', blocked });
      });
    });
    const oldHandleClosed = await page.evaluate(() => {
      const db = (globalThis as typeof globalThis & { __trialConnection?: IDBDatabase }).__trialConnection;
      if (!db) return false;
      try { db.transaction('trial-session', 'readonly'); return false; }
      catch (e) { return (e as Error).name === 'InvalidStateError'; }
    });
    const fresh = await other.evaluate(async () => {
      const trial = await import(/* @vite-ignore */ '/src/known-fact-lifecycle-storage-trial-14.ts');
      const db = await trial.openKnownFactLifecycleTrial14ForReview();
      try {
        return {
          version: db.version,
          stores: db.objectStoreNames.length,
          empty: await trial.loadKnownFactLifecycleTrial14ForReview(db, 'SYNTHETIC-NOT-PRESENT') === null,
        };
      } finally { db.close(); }
    });
    expect({ initial, deletion, oldHandleClosed, fresh }).toEqual({
      initial: { version: 1, stores: 4 },
      deletion: { status: 'deleted', blocked: false },
      oldHandleClosed: true,
      fresh: { version: 1, stores: 4, empty: true },
    });
  } finally {
    await page.evaluate(() => {
      const db = (globalThis as typeof globalThis & { __trialConnection?: IDBDatabase }).__trialConnection;
      db?.close();
    });
    await other.close();
  }
});

/**
 * Synthetic blocked event, NOT a claim that an actual version upgrade
 * occurred. It specifically covers the rare late-success connection leak
 * after a caller has already been told its open request was blocked.
 */
test('a rejected blocked trial open closes any later successful native handle', async ({ page }) => {
  await page.goto('/tests/browser/fixtures/readback.html');
  const result = await page.evaluate(async () => {
    const trial = await import(/* @vite-ignore */ '/src/known-fact-lifecycle-storage-trial-14.ts');
    const originalOpen = indexedDB.open;
    let captured: IDBOpenDBRequest | null = null;
    indexedDB.open = (function (this: IDBFactory, name: string, version?: number) {
      const request = version === undefined
        ? originalOpen.call(this, name)
        : originalOpen.call(this, name, version);
      captured = request;
      queueMicrotask(() => request.dispatchEvent(new Event('blocked')));
      return request;
    }) as IDBFactory['open'];
    try {
      let rejected = '';
      try { await trial.openKnownFactLifecycleTrial14ForReview(); }
      catch (e) { rejected = (e as Error).message; }
      const request = captured as IDBOpenDBRequest | null;
      if (!request) throw new Error('No native IndexedDB request was observed.');
      await new Promise<void>((resolve, reject) => {
        if (request.readyState === 'done') { resolve(); return; }
        request.addEventListener('success', () => resolve(), { once: true });
        request.addEventListener('error', () => reject(request.error), { once: true });
      });
      let closed = false;
      try { request.result.transaction('trial-session', 'readonly'); }
      catch (e) { closed = (e as Error).name === 'InvalidStateError'; }
      return {
        rejected: rejected === 'Trial database is blocked by another connection.',
        nativeRequestSucceeded: request.readyState === 'done' && request.error === null,
        lateHandleClosed: closed,
      };
    } finally { indexedDB.open = originalOpen; }
  });
  expect(result).toEqual({
    rejected: true,
    nativeRequestSucceeded: true,
    lateHandleClosed: true,
  });
});

import { expect, test } from '@playwright/test';

/**
 * Isolated 1.4 lifecycle trial in a SEPARATE disposable database. Every value
 * is synthetic. No live 1.3 IndexedDB schema, PWA or customer data is touched.
 */
test.beforeEach(async ({ page }) => {
  await page.goto('/tests/browser/fixtures/readback.html');
});

test('atomic Draft→read-back→Completed→reopened Draft survives canonical export and explicit trial-only restore', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const [pack, semantic, known, lifecycle, trial, identity] = await Promise.all([
      '/src/pack.ts', '/src/semantic-session.ts', '/src/known-fact-session.ts',
      '/src/known-fact-lifecycle-14.ts', '/src/known-fact-lifecycle-storage-trial-14.ts',
      '/src/pack-identity.ts',
    ].map(load));
    let db = await trial.openKnownFactLifecycleTrial14ForReview();
    const semanticSource = await semantic.createSemanticSession(pack.generalDiscoveryPack, {
      clientLabel: 'Synthetic lifecycle recovery client',
      interviewerLabel: 'Synthetic interviewer',
    }, new Date('2026-11-07T08:00:00.000Z'));
    semanticSource.runningNotes = 'SYNTHETIC INTERNAL NOTES';
    const session = await known.migrateSemantic13ToKnownFact14(semanticSource);
    const initial = await lifecycle.createKnownFactLifecycle14(session);
    const first = await trial.saveKnownFactLifecycleTrial14ForReview(db, initial, null);

    const viewed = await lifecycle.recordKnownFactReadBack14(first.lifecycle, {
      eventId: 'synthetic-read-back', occurredAt: '2026-11-07T08:01:00.000Z',
    });
    const second = await trial.saveKnownFactLifecycleTrial14ForReview(db, viewed, {
      generation: first.generation, digest: first.digest,
    });
    const didNotAutoComplete = second.lifecycle.status === 'draft'
      && second.lifecycle.completedRevisions.length === 0;

    const completed = await lifecycle.completeKnownFactLifecycle14(second.lifecycle, {
      expectedRevisionId: session.revisionId,
      eventId: 'synthetic-complete', completedAt: '2026-11-07T08:05:00.000Z',
      acknowledgedFollowUpQuestionIds: [],
    });
    const third = await trial.saveKnownFactLifecycleTrial14ForReview(db, completed, {
      generation: second.generation, digest: second.digest,
    });
    const reopened = await lifecycle.reopenKnownFactLifecycle14(third.lifecycle, {
      expectedRevisionId: session.revisionId, eventId: 'synthetic-reopen',
      newRevisionId: 'synthetic-reopen-draft-revision',
      reopenedAt: '2026-11-07T08:10:00.000Z',
    });
    const fourth = await trial.saveKnownFactLifecycleTrial14ForReview(db, reopened, {
      generation: third.generation, digest: third.digest,
    });
    const live = await trial.loadKnownFactLifecycleTrial14ForReview(db, session.sessionId);
    const exportBytes = await trial.createLifecycleTrial14BackupForReview(live.lifecycle);
    const restoredFromBytes = await trial.validateLifecycleTrial14BackupForReview(exportBytes);
    const canonical = (value: unknown) => identity.canonicalizeJson(JSON.parse(JSON.stringify(value)));

    const tx = db.transaction(['trial-session', 'trial-lifecycle', 'trial-history', 'trial-backup'], 'readonly');
    const get = (request: IDBRequest) => new Promise<unknown>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const historyStore = tx.objectStore('trial-history');
    // Queue ALL requests before awaiting: IndexedDB may auto-commit as soon
    // as the event loop returns with no pending requests.
    const historyRequests = [0, 1, 2].map((generation) =>
      get(historyStore.get(trial.lifecycleTrialHistoryKey(session.sessionId, generation))));
    const sessionRequest = get(tx.objectStore('trial-session').get(session.sessionId));
    const backupRequest = get(tx.objectStore('trial-backup').get(session.sessionId));
    const [history, storedSession, storedBackup] = await Promise.all([
      Promise.all(historyRequests), sessionRequest, backupRequest,
    ]);
    const historic = history as Array<{ lifecycle: { status: string } } | undefined>;
    const verifiedHistory = historic.length === 3 && historic.every((item) => item !== undefined)
      && historic[0]?.lifecycle?.status === 'draft'
      && historic[1]?.lifecycle?.status === 'draft'
      && historic[2]?.lifecycle?.status === 'completed';
    db.close();

    // Simulate local trial database loss, then restore from explicitly held
    // portable bytes. This is NOT off-device backup, power-loss or live restore.
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(trial.LIFECYCLE_TRIAL_DB_NAME);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Trial deletion blocked.'));
    });
    db = await trial.openKnownFactLifecycleTrial14ForReview();
    const restored = await trial.restoreKnownFactLifecycleTrial14ForReview(db, exportBytes);
    const loadedAgain = await trial.loadKnownFactLifecycleTrial14ForReview(db, session.sessionId);
    let refusedDuplicate = false;
    try { await trial.restoreKnownFactLifecycleTrial14ForReview(db, exportBytes); }
    catch (error) { refusedDuplicate = (error as Error).name === 'LifecycleTrialConflictError'; }
    db.close();
    return {
      didNotAutoComplete,
      generation: fourth.generation,
      preservedParent: fourth.lifecycle.session.parentRevisionId === session.revisionId,
      readBackAndCompletionEvents: fourth.lifecycle.events.map((e: { type: string }) => e.type),
      historicalSnapshotRetained: canonical(fourth.lifecycle.completedRevisions[0].sessionSnapshot)
        === canonical(third.lifecycle.session),
      verifiedHistory,
      activeMatchesSession: canonical(storedSession) === canonical(live.lifecycle.session),
      backupStoreMatchesExport: storedBackup === exportBytes,
      confidential: exportBytes.includes('INTERNAL / CONFIDENTIAL'),
      portableRoundtrip: canonical(restoredFromBytes) === canonical(live.lifecycle),
      newDbRecovery: canonical(loadedAgain.lifecycle) === canonical(live.lifecycle)
        && canonical(restored.lifecycle) === canonical(live.lifecycle),
      restoredGeneration: restored.generation,
      refusedDuplicate,
    };
  });
  expect(result).toEqual({
    didNotAutoComplete: true,
    generation: 3,
    preservedParent: true,
    readBackAndCompletionEvents: ['read-back-recorded', 'completed', 'reopened'],
    historicalSnapshotRetained: true,
    verifiedHistory: true,
    activeMatchesSession: true,
    backupStoreMatchesExport: true,
    confidential: true,
    portableRoundtrip: true,
    newDbRecovery: true,
    restoredGeneration: 0,
    refusedDuplicate: true,
  });
});

test('stale concurrent envelope edits cannot overwrite current session, events or backup', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const [pack, semantic, known, lifecycle, trial, identity] = await Promise.all([
      '/src/pack.ts', '/src/semantic-session.ts', '/src/known-fact-session.ts',
      '/src/known-fact-lifecycle-14.ts', '/src/known-fact-lifecycle-storage-trial-14.ts',
      '/src/pack-identity.ts',
    ].map(load));
    const db = await trial.openKnownFactLifecycleTrial14ForReview();
    const legacy = await semantic.createSemanticSession(pack.generalDiscoveryPack, {
      clientLabel: 'Synthetic tab race',
    }, new Date('2026-11-07T08:00:00.000Z'));
    const draft = await lifecycle.createKnownFactLifecycle14(await known.migrateSemantic13ToKnownFact14(legacy));
    const initial = await trial.saveKnownFactLifecycleTrial14ForReview(db, draft, null);
    const a = structuredClone(initial.lifecycle);
    a.session.updatedAt = '2026-11-07T08:02:00.000Z';
    a.session.runningNotes = 'SYNTHETIC TAB A';
    const b = structuredClone(initial.lifecycle);
    b.session.updatedAt = '2026-11-07T08:02:00.000Z';
    b.session.runningNotes = 'SYNTHETIC TAB B';
    const expected = { generation: initial.generation, digest: initial.digest };
    const outcomes = await Promise.allSettled([
      trial.saveKnownFactLifecycleTrial14ForReview(db, a, expected),
      trial.saveKnownFactLifecycleTrial14ForReview(db, b, expected),
    ]);
    const winners = outcomes.filter((o) => o.status === 'fulfilled');
    const losses = outcomes.filter((o) => o.status === 'rejected')
      .map((o) => (o as PromiseRejectedResult).reason?.name);
    const current = await trial.loadKnownFactLifecycleTrial14ForReview(db, draft.session.sessionId);
    const same = (x: unknown, y: unknown) => identity.canonicalizeJson(JSON.parse(JSON.stringify(x)))
      === identity.canonicalizeJson(JSON.parse(JSON.stringify(y)));
    const tx = db.transaction(['trial-history', 'trial-backup'], 'readonly');
    const historyReq = tx.objectStore('trial-history').get(
      trial.lifecycleTrialHistoryKey(draft.session.sessionId, 0));
    const backupReq = tx.objectStore('trial-backup').get(draft.session.sessionId);
    const get = (req: IDBRequest) => new Promise<unknown>((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const [archive, backup] = await Promise.all([get(historyReq), get(backupReq)]);
    const decoded = await trial.validateLifecycleTrial14BackupForReview(backup);
    db.close();
    return {
      winnerCount: winners.length,
      lossNames: losses,
      revisionStillSame: current.lifecycle.session.revisionId === initial.lifecycle.session.revisionId,
      generation: current.generation,
      notes: current.lifecycle.session.runningNotes,
      oldHistoryRetained: same(archive, initial),
      exportedMatchesCurrent: same(decoded, current.lifecycle),
      sourceEventsUnaffected: current.lifecycle.events.length === 0,
    };
  });
  expect(result.winnerCount).toBe(1);
  expect(result.lossNames).toEqual(['LifecycleTrialConflictError']);
  expect(result.revisionStillSame).toBe(true);
  expect(result.generation).toBe(1);
  expect(result.notes).toMatch(/^SYNTHETIC TAB [AB]$/);
  expect(result.oldHistoryRetained).toBe(true);
  expect(result.exportedMatchesCurrent).toBe(true);
  expect(result.sourceEventsUnaffected).toBe(true);
});

test('occupied immutable history aborts all four-store lifecycle transaction writes', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const [pack, semantic, known, lifecycle, trial, identity] = await Promise.all([
      '/src/pack.ts', '/src/semantic-session.ts', '/src/known-fact-session.ts',
      '/src/known-fact-lifecycle-14.ts', '/src/known-fact-lifecycle-storage-trial-14.ts',
      '/src/pack-identity.ts',
    ].map(load));
    const db = await trial.openKnownFactLifecycleTrial14ForReview();
    const legacy = await semantic.createSemanticSession(pack.generalDiscoveryPack, {
      clientLabel: 'Synthetic atomic abort',
    }, new Date('2026-11-07T08:00:00.000Z'));
    const initial = await trial.saveKnownFactLifecycleTrial14ForReview(
      db, await lifecycle.createKnownFactLifecycle14(await known.migrateSemantic13ToKnownFact14(legacy)), null);
    const candidate = await lifecycle.recordKnownFactReadBack14(initial.lifecycle, {
      eventId: 'synthetic-should-not-commit', occurredAt: '2026-11-07T08:01:00.000Z',
    });
    const snapshot = (value: unknown) => identity.canonicalizeJson(JSON.parse(JSON.stringify(value)));
    const before = await trial.loadKnownFactLifecycleTrial14ForReview(db, initial.lifecycle.session.sessionId);
    const tx = db.transaction('trial-history', 'readwrite');
    const key = trial.lifecycleTrialHistoryKey(initial.lifecycle.session.sessionId, initial.generation);
    tx.objectStore('trial-history').put({ syntheticProtectedCollision: true }, key);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    let rejected = '';
    try {
      await trial.saveKnownFactLifecycleTrial14ForReview(db, candidate, {
        generation: initial.generation, digest: initial.digest,
      });
    } catch (error) { rejected = (error as Error).name; }
    const after = await trial.loadKnownFactLifecycleTrial14ForReview(db, initial.lifecycle.session.sessionId);
    const stores = db.transaction(['trial-lifecycle', 'trial-session', 'trial-backup', 'trial-history'], 'readonly');
    const get = (req: IDBRequest) => new Promise<unknown>((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const [raw, session, backup, blocker, keys] = await Promise.all([
      get(stores.objectStore('trial-lifecycle').get(initial.lifecycle.session.sessionId)),
      get(stores.objectStore('trial-session').get(initial.lifecycle.session.sessionId)),
      get(stores.objectStore('trial-backup').get(initial.lifecycle.session.sessionId)),
      get(stores.objectStore('trial-history').get(key)),
      get(stores.objectStore('trial-history').getAllKeys()),
    ]);
    db.close();
    return {
      rejected,
      unchanged: snapshot(after) === snapshot(before) && snapshot(raw) === snapshot(initial),
      sessionUnchanged: snapshot(session) === snapshot(initial.lifecycle.session),
      backupUnchanged: backup === await trial.createLifecycleTrial14BackupForReview(initial.lifecycle),
      blockerUnmodified: snapshot(blocker) === snapshot({ syntheticProtectedCollision: true }),
      historyCount: (keys as unknown[]).length,
    };
  });
  expect(result).toEqual({
    rejected: 'LifecycleTrialConflictError',
    unchanged: true,
    sessionUnchanged: true,
    backupUnchanged: true,
    blockerUnmodified: true,
    historyCount: 1,
  });
});

test('tampered confidential backup fails closed before creating a trial session', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const [pack, semantic, known, lifecycle, trial] = await Promise.all([
      '/src/pack.ts', '/src/semantic-session.ts', '/src/known-fact-session.ts',
      '/src/known-fact-lifecycle-14.ts', '/src/known-fact-lifecycle-storage-trial-14.ts',
    ].map(load));
    const db = await trial.openKnownFactLifecycleTrial14ForReview();
    const old = await semantic.createSemanticSession(pack.generalDiscoveryPack, {
      clientLabel: 'Synthetic confidential backup guard',
    }, new Date('2026-11-07T08:00:00.000Z'));
    const source = await lifecycle.createKnownFactLifecycle14(await known.migrateSemantic13ToKnownFact14(old));
    const bytes = await trial.createLifecycleTrial14BackupForReview(source);
    const modified = JSON.parse(bytes);
    modified.lifecycle.session.runningNotes = 'SYNTHETIC FORGED BACKUP';
    let rejected = false;
    try { await trial.restoreKnownFactLifecycleTrial14ForReview(db, JSON.stringify(modified)); }
    catch { rejected = true; }
    const current = await trial.loadKnownFactLifecycleTrial14ForReview(db, source.session.sessionId);
    db.close();
    return { rejected, noSessionCreated: current === null };
  });
  expect(result).toEqual({ rejected: true, noSessionCreated: true });
});

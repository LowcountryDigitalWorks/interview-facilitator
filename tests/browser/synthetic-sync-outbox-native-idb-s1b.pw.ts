import { expect, test } from '@playwright/test';

/**
 * S1B SYNTHETIC ONLY. Uses the existing Vite source-dev-only dormant harness,
 * not the public 1.3 PWA bundle or real user IndexedDB schema. Network is
 * never used for sync; separate IDB "trial" origin store only.
 */
test.beforeEach(async ({ page }) => {
  await page.goto('/tests/browser/fixtures/readback.html');
});

test('native atomic snapshot/outbox survives reopen; negative ACK retains queue; mock receipt consumes once', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const [pack, semantic, trial, plan, identity] = await Promise.all([
      '/src/pack.ts', '/src/semantic-session.ts',
      '/src/synthetic-sync-outbox-idb-trial.ts',
      '/src/synthetic-sync-plan.ts', '/src/pack-identity.ts',
    ].map(load));
    const source = await semantic.createSemanticSession(pack.generalDiscoveryPack, {
      clientLabel: 'SYNTHETIC PRIVATE NOT IN OUTBOX HEAD',
    }, new Date('2026-11-14T12:00:00.000Z'));
    source.runningNotes = 'SYNTHETIC PRIVATE INTERVIEW CONTENT MUST BE RETAINED LOCALLY';
    const offer = await plan.prepareSyntheticRevisionOffer(source);
    let db = await trial.openSyntheticOutboxTrialForReview();
    try {
      const staged = await trial.stageSyntheticRevisionForTrial(db, source, null);
      const before = await trial.inspectSyntheticOutboxTrial(db, source.sessionId);
      db.close();
      db = await trial.openSyntheticOutboxTrialForReview();
      const reopened = await trial.inspectSyntheticOutboxTrial(db, source.sessionId);
      const ack = {
        operationId: offer.operationId,
        sessionId: offer.head.sessionId,
        revisionId: offer.head.revisionId,
        snapshotDigest: offer.head.snapshotDigest,
        committed: true,
      };
      const negative = await trial.simulateVerifiedSyntheticAckForTrial(db,
        offer, { ...ack, committed: false }, 'synthetic-test-receipt');
      const untrusted = await trial.simulateVerifiedSyntheticAckForTrial(db,
        offer, ack, 'no-verified-receipt');
      const pendingAfterFailure = (await trial.inspectSyntheticOutboxTrial(db, source.sessionId)).pending.length;
      const confirmed = await trial.simulateVerifiedSyntheticAckForTrial(db,
        offer, ack, 'synthetic-test-receipt');
      const repeatedReceipt = await trial.simulateVerifiedSyntheticAckForTrial(db,
        offer, ack, 'synthetic-test-receipt');
      const replay = await trial.stageSyntheticRevisionForTrial(db, source, null);
      const after = await trial.inspectSyntheticOutboxTrial(db, source.sessionId);
      const names = await indexedDB.databases();
      return {
        staged, negative, untrusted, pendingAfterFailure, confirmed, repeatedReceipt, replay,
        beforeQueueCount: before.pending.length,
        restoredQueueCount: reopened.pending.length,
        beforeHistoryCount: before.history.length,
        restoredHistoryCount: reopened.history.length,
        retainedPrivateSnapshot: identity.canonicalizeJson(before.history[0].session)
          === identity.canonicalizeJson(source),
        reopenedPrivateSnapshot: reopened.history[0].session.runningNotes === source.runningNotes,
        noPrivateContentInMetadata: !JSON.stringify(reopened.pending).includes(source.runningNotes)
          && !JSON.stringify(reopened.pending).includes(source.clientLabel),
        afterQueueCount: after.pending.length,
        afterHistoryCount: after.history.length,
        receiptCount: after.receipts.length,
        currentHeadUnchanged: after.current.offer.operationId === offer.operationId,
        avoidedLiveSessionDb: !names.some((item: { name: string }) => item.name === 'ldw-interview-facilitator'),
      };
    } finally {
      db.close();
      await trial.deleteSyntheticOutboxTrialForReview();
    }
  });
  expect(result).toEqual({
    staged: 'staged-atomically',
    negative: 'retained-no-verified-receipt',
    untrusted: 'retained-no-verified-receipt',
    pendingAfterFailure: 1,
    confirmed: 'mock-receipt-recorded',
    repeatedReceipt: 'already-mock-received',
    replay: 'replay-noop',
    beforeQueueCount: 1,
    restoredQueueCount: 1,
    beforeHistoryCount: 1,
    restoredHistoryCount: 1,
    retainedPrivateSnapshot: true,
    reopenedPrivateSnapshot: true,
    noPrivateContentInMetadata: true,
    afterQueueCount: 0,
    afterHistoryCount: 1,
    receiptCount: 1,
    currentHeadUnchanged: true,
    avoidedLiveSessionDb: true,
  });
});

test('two real Chromium tabs racing on same revision preserve loser and never silently overwrite', async ({ page, context }) => {
  const second = await context.newPage();
  await second.goto('/tests/browser/fixtures/readback.html');
  const source = await page.evaluate(async () => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const [pack, semantic, trial] = await Promise.all([
      '/src/pack.ts', '/src/semantic-session.ts', '/src/synthetic-sync-outbox-idb-trial.ts',
    ].map(load));
    const session = await semantic.createSemanticSession(pack.generalDiscoveryPack, {
      clientLabel: 'SYNTHETIC TWO TAB CAS',
    }, new Date('2026-11-14T12:00:00.000Z'));
    const db = await trial.openSyntheticOutboxTrialForReview();
    try {
      const saved = await trial.stageSyntheticRevisionForTrial(db, session, null);
      if (saved !== 'staged-atomically') throw new Error('Synthetic trial baseline did not commit.');
      return session;
    } finally { db.close(); }
  });
  const write = async (target: typeof page, writer: 'left' | 'right') => target.evaluate(async ({ source, writer }) => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const trial = await load('/src/synthetic-sync-outbox-idb-trial.ts');
    const update = {
      ...source, revisionId: 'synthetic-' + writer + '-revision',
      parentRevisionId: source.revisionId, runningNotes: 'SYNTHETIC ' + writer.toUpperCase(),
    };
    const db = await trial.openSyntheticOutboxTrialForReview();
    try {
      return await trial.stageSyntheticRevisionForTrial(db, update, source.revisionId);
    } finally { db.close(); }
  }, { source, writer });
  try {
    const [left, right] = await Promise.all([write(page, 'left'), write(second, 'right')]);
    const state = await page.evaluate(async (sessionId) => {
      const load = (path: string) => import(/* @vite-ignore */ path);
    const trial = await load('/src/synthetic-sync-outbox-idb-trial.ts');
      const db = await trial.openSyntheticOutboxTrialForReview();
      try {
        const snap = await trial.inspectSyntheticOutboxTrial(db, sessionId);
        return {
          pending: snap.pending.length,
          history: snap.history.length,
          currentRevision: snap.current?.offer.head.revisionId,
          allHistoryIds: snap.history.map((item) => item.offer.head.revisionId),
        };
      } finally { db.close(); }
    }, source.sessionId);
    expect([left, right].sort()).toEqual(['staged-atomically', 'stale-no-write'].sort());
    expect(state.pending).toBe(2);
    expect(state.history).toBe(2);
    expect(state.allHistoryIds).toContain(source.revisionId);
    expect(state.currentRevision).toBe(left === 'staged-atomically'
      ? 'synthetic-left-revision' : 'synthetic-right-revision');
  } finally {
    await second.close();
    await page.evaluate(async () => {
      const load = (path: string) => import(/* @vite-ignore */ path);
    const trial = await load('/src/synthetic-sync-outbox-idb-trial.ts');
      await trial.deleteSyntheticOutboxTrialForReview();
    });
  }
});

test('native async constraint fault rolls back current, history and pending atomically then retry succeeds', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const [pack, semantic, trial] = await Promise.all([
      '/src/pack.ts', '/src/semantic-session.ts', '/src/synthetic-sync-outbox-idb-trial.ts',
    ].map(load));
    const session = await semantic.createSemanticSession(pack.generalDiscoveryPack, {
      clientLabel: 'SYNTHETIC NATIVE ASYNC ABORT',
    }, new Date('2026-11-14T12:00:00.000Z'));
    const db = await trial.openSyntheticOutboxTrialForReview();
    const originalAdd = IDBObjectStore.prototype.add;
    let injected = false;
    let failureName = '';
    IDBObjectStore.prototype.add = (function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      const request = key === undefined
        ? originalAdd.call(this, value) : originalAdd.call(this, value, key);
      if (!injected && this.name === 'pending') {
        injected = true;
        // Two real same-key queued IDB adds: the later native request fails
        // with ConstraintError. The *whole* transaction must roll back.
        const duplicate = key === undefined
          ? originalAdd.call(this, value) : originalAdd.call(this, value, key);
        duplicate.onerror = () => { failureName = duplicate.error?.name ?? 'unknown'; };
      }
      return request;
    }) as IDBObjectStore['add'];
    let error = '';
    try {
      await trial.stageSyntheticRevisionForTrial(db, session, null);
    } catch (e) {
      error = e instanceof Error ? e.message : 'unknown';
    } finally { IDBObjectStore.prototype.add = originalAdd; }
    try {
      const rolledBack = await trial.inspectSyntheticOutboxTrial(db, session.sessionId);
      const retried = await trial.stageSyntheticRevisionForTrial(db, session, null);
      const after = await trial.inspectSyntheticOutboxTrial(db, session.sessionId);
      return {
        injected, failureName, rejected: error.includes('atomic write aborted'),
        noPartialCurrent: rolledBack.current === undefined,
        noPartialHistory: rolledBack.history.length === 0,
        noPartialQueue: rolledBack.pending.length === 0,
        retried, afterHistoryCount: after.history.length, afterPendingCount: after.pending.length,
      };
    } finally {
      db.close();
      await trial.deleteSyntheticOutboxTrialForReview();
    }
  });
  expect(result).toEqual({
    injected: true, failureName: 'ConstraintError', rejected: true,
    noPartialCurrent: true, noPartialHistory: true, noPartialQueue: true,
    retried: 'staged-atomically', afterHistoryCount: 1, afterPendingCount: 1,
  });
});

test('outbox bound refuses 33rd pending revision without changing current or immutable history', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const [pack, semantic, trial] = await Promise.all([
      '/src/pack.ts', '/src/semantic-session.ts', '/src/synthetic-sync-outbox-idb-trial.ts',
    ].map(load));
    let value = await semantic.createSemanticSession(pack.generalDiscoveryPack, {
      clientLabel: 'SYNTHETIC 32 REVISIONS ONLY',
    }, new Date('2026-11-14T12:00:00.000Z'));
    const db = await trial.openSyntheticOutboxTrialForReview();
    try {
      const actions: string[] = [];
      for (let i = 0; i < trial.SYNTHETIC_OUTBOX_MAX_PENDING; i += 1) {
        const expected = i === 0 ? null : value.parentRevisionId;
        actions.push(await trial.stageSyntheticRevisionForTrial(db, value, expected));
        value = { ...value,
          parentRevisionId: value.revisionId,
          revisionId: 'synthetic-queued-' + String(i).padStart(3, '0'),
          runningNotes: 'SYNTHETIC REV ' + String(i),
        };
      }
      const blocked = await trial.stageSyntheticRevisionForTrial(db, value, value.parentRevisionId);
      const state = await trial.inspectSyntheticOutboxTrial(db, value.sessionId);
      return {
        allCommitted: actions.every(x => x === 'staged-atomically'),
        blocked,
        pendingCount: state.pending.length,
        retainedHistoryCount: state.history.length,
        currentRevisionId: state.current?.offer.head.revisionId,
        rejectedRevisionId: value.revisionId,
      };
    } finally {
      db.close();
      await trial.deleteSyntheticOutboxTrialForReview();
    }
  });
  expect(result.allCommitted).toBe(true);
  expect(result.blocked).toBe('queue-full-no-write');
  expect(result.pendingCount).toBe(32);
  expect(result.retainedHistoryCount).toBe(32);
  expect(result.currentRevisionId).not.toBe(result.rejectedRevisionId);
});

import { expect, test, type Page } from '@playwright/test';

/**
 * S1C: test-only manual convergence rehearsal across two genuinely isolated
 * Chromium browser contexts. There is no network relay, auth, or PWA sync UI.
 * Each profile writes an independent copy to its own synthetic IndexedDB.
 */
const fixture = 'http://127.0.0.1:4191/tests/browser/fixtures/readback.html';

async function warmSourceModules(page: Page): Promise<void> {
  await page.goto(fixture);
  await page.evaluate(async () => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    await Promise.all([
      '/src/pack.ts', '/src/semantic-session.ts', '/src/synthetic-sync-plan.ts',
      '/src/synthetic-sync-outbox-idb-trial.ts',
    ].map(load));
  });
}

test('two disconnected profiles preserve concurrent interview edits on manual mock reconnect', async ({ browser }) => {
  const desktopContext = await browser.newContext({ serviceWorkers: 'block' });
  const mobileContext = await browser.newContext({
    serviceWorkers: 'block', viewport: { width: 390, height: 780 },
  });
  const desktop = await desktopContext.newPage();
  const mobile = await mobileContext.newPage();

  const stage = async (page: Page, record: unknown, expectedRevision: string | null) =>
    page.evaluate(async ({ record, expectedRevision }) => {
      const load = (path: string) => import(/* @vite-ignore */ path);
      const trial = await load('/src/synthetic-sync-outbox-idb-trial.ts');
      const db = await trial.openSyntheticOutboxTrialForReview();
      try {
        const outcome = await trial.stageSyntheticRevisionForTrial(db, record, expectedRevision);
        const state = await trial.inspectSyntheticOutboxTrial(db, (record as {sessionId:string}).sessionId);
        return {
          outcome,
          offline: !navigator.onLine,
          historyCount: state.history.length,
          pendingCount: state.pending.length,
          currentRevisionId: state.current?.offer.head.revisionId,
          pendingContainsPrivateText: JSON.stringify(state.pending).includes('SYNTHETIC PRIVATE OFFLINE NOTES'),
        };
      } finally {
        db.close();
      }
    }, { record, expectedRevision });

  try {
    await Promise.all([warmSourceModules(desktop), warmSourceModules(mobile)]);
    const base = await desktop.evaluate(async () => {
      const load = (path: string) => import(/* @vite-ignore */ path);
      const [semantic, pack] = await Promise.all([
        '/src/semantic-session.ts', '/src/pack.ts',
      ].map(load));
      return semantic.createSemanticSession(pack.generalDiscoveryPack, {
        clientLabel: 'SYNTHETIC TWO DEVICE CLIENT LABEL',
      }, new Date('2026-11-14T12:00:00.000Z'));
    });

    // A previously accepted single revision is explicitly seeded in both
    // *isolated* profiles; source sharing here is test-fixture setup only.
    const baseline = await Promise.all([
      stage(desktop, base, null),
      stage(mobile, base, null),
    ]);
    expect(baseline.map(x => x.outcome)).toEqual([
      'staged-atomically', 'staged-atomically',
    ]);
    const baseOffer = await desktop.evaluate(async record => {
      const load = (path: string) => import(/* @vite-ignore */ path);
      const plan = await load('/src/synthetic-sync-plan.ts');
      return plan.prepareSyntheticRevisionOffer(record);
    }, base);

    await Promise.all([
      desktopContext.setOffline(true),
      mobileContext.setOffline(true),
    ]);

    const desktopRevision = {
      ...base, parentRevisionId: base.revisionId,
      revisionId: 'synthetic-desktop-offline-1',
      runningNotes: 'SYNTHETIC PRIVATE OFFLINE NOTES DESKTOP',
    };
    const mobileRevision = {
      ...base, parentRevisionId: base.revisionId,
      revisionId: 'synthetic-mobile-offline-1',
      runningNotes: 'SYNTHETIC PRIVATE OFFLINE NOTES MOBILE',
    };

    const [leftOffline, rightOffline] = await Promise.all([
      stage(desktop, desktopRevision, base.revisionId),
      stage(mobile, mobileRevision, base.revisionId),
    ]);
    for (const [outcome, expectedId] of [
      [leftOffline, desktopRevision.revisionId],
      [rightOffline, mobileRevision.revisionId],
    ] as const) {
      expect(outcome).toMatchObject({
        outcome: 'staged-atomically', offline: true,
        historyCount: 2, pendingCount: 2,
        currentRevisionId: expectedId, pendingContainsPrivateText: false,
      });
    }

    const desktopOffer = await desktop.evaluate(async record => {
      const load = (path: string) => import(/* @vite-ignore */ path);
      const plan = await load('/src/synthetic-sync-plan.ts');
      return plan.prepareSyntheticRevisionOffer(record);
    }, desktopRevision);
    const mobileOffer = await mobile.evaluate(async record => {
      const load = (path: string) => import(/* @vite-ignore */ path);
      const plan = await load('/src/synthetic-sync-plan.ts');
      return plan.prepareSyntheticRevisionOffer(record);
    }, mobileRevision);

    // A plain JS object inside Playwright is the only mock "remote" state;
    // no endpoint, cloud database, account, browser cache or key is created.
    let mockRemoteHead = baseOffer.head;
    await desktopContext.setOffline(false);
    const desktopPlan = await desktop.evaluate(async ({ local, remote }) => {
      const load = (path: string) => import(/* @vite-ignore */ path);
      const planner = await load('/src/synthetic-sync-plan.ts');
      return planner.planSyntheticRevisionReconciliation(local, remote, false);
    }, { local: desktopOffer.head, remote: mockRemoteHead });
    expect(desktopPlan.kind).toBe('offer-local');
    mockRemoteHead = desktopOffer.head; // Test-only simulated accepted revision.

    // Lost reply: no mock ACK delivered, so the accepted desktop revision
    // remains pending until an explicit receipt simulation.
    const pendingWithoutReply = await desktop.evaluate(async sessionId => {
      const load = (path: string) => import(/* @vite-ignore */ path);
      const trial = await load('/src/synthetic-sync-outbox-idb-trial.ts');
      const db = await trial.openSyntheticOutboxTrialForReview();
      try {
        return (await trial.inspectSyntheticOutboxTrial(db, sessionId)).pending.length;
      } finally { db.close(); }
    }, base.sessionId);
    expect(pendingWithoutReply).toBe(2);

    await mobileContext.setOffline(false);
    const mobilePlan = await mobile.evaluate(async ({ local, remote }) => {
      const load = (path: string) => import(/* @vite-ignore */ path);
      const planner = await load('/src/synthetic-sync-plan.ts');
      return planner.planSyntheticRevisionReconciliation(local, remote, false);
    }, { local: mobileOffer.head, remote: mockRemoteHead });
    expect(mobilePlan.kind).toBe('preserve-conflict');
    expect(mobilePlan).toMatchObject({
      local: { revisionId: mobileRevision.revisionId },
      remote: { revisionId: desktopRevision.revisionId },
    });

    const receipt = await desktop.evaluate(async offer => {
      const load = (path: string) => import(/* @vite-ignore */ path);
      const trial = await load('/src/synthetic-sync-outbox-idb-trial.ts');
      const db = await trial.openSyntheticOutboxTrialForReview();
      try {
        const ack = {
          operationId: offer.operationId,
          sessionId: offer.head.sessionId,
          revisionId: offer.head.revisionId,
          snapshotDigest: offer.head.snapshotDigest,
          committed: true,
        };
        const recorded = await trial.simulateVerifiedSyntheticAckForTrial(
          db, offer, ack, 'synthetic-test-receipt',
        );
        const again = await trial.simulateVerifiedSyntheticAckForTrial(
          db, offer, ack, 'synthetic-test-receipt',
        );
        const data = await trial.inspectSyntheticOutboxTrial(db, offer.head.sessionId);
        return {
          recorded, again, pendingCount: data.pending.length,
          historyCount: data.history.length, receipts: data.receipts.length,
        };
      } finally { db.close(); }
    }, desktopOffer);
    expect(receipt).toEqual({
      recorded: 'mock-receipt-recorded', again: 'already-mock-received',
      pendingCount: 1, historyCount: 2, receipts: 1,
    });

    // Replaying from the already stored source is a no-op: no duplicate
    // pending revision and no accidental resurrection after a test receipt.
    const replay = await stage(desktop, desktopRevision, base.revisionId);
    expect(replay).toMatchObject({
      outcome: 'replay-noop', pendingCount: 1, historyCount: 2,
    });
    const untouchedMobile = await stage(mobile, mobileRevision, base.revisionId);
    expect(untouchedMobile).toMatchObject({
      outcome: 'replay-noop', pendingCount: 2, historyCount: 2,
      currentRevisionId: mobileRevision.revisionId,
    });
  } finally {
    for (const page of [desktop, mobile]) {
      try {
        await page.evaluate(async () => {
          const load = (path: string) => import(/* @vite-ignore */ path);
      const trial = await load('/src/synthetic-sync-outbox-idb-trial.ts');
          await trial.deleteSyntheticOutboxTrialForReview();
        });
      } catch {
        // Context teardown still discards the isolated ephemeral test profile.
      }
    }
    await Promise.all([desktopContext.close(), mobileContext.close()]);
  }
});

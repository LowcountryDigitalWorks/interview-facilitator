import { expect, test } from '@playwright/test';

/** Synthetic-only recovery / lifecycle proof, separate from the live PWA. */
test.beforeEach(async ({ page }) => {
  await page.goto('/tests/browser/fixtures/readback.html');
});

test('canonical private backup restores an isolated confirmed session after database deletion without overwriting', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const [pack, semantic, trial, backup, c14n] = await Promise.all([
      '/src/pack.ts', '/src/semantic-session.ts',
      '/src/interview-prep-confirmation-idb-trial.ts',
      '/src/interview-prep-confirmation-backup-trial.ts',
      '/src/pack-identity.ts',
    ].map(load));
    const session = await semantic.createSemanticSession(pack.generalDiscoveryPack, {
      clientLabel: 'SYNTHETIC PORTABLE RECOVERY PROOF',
    }, new Date('2026-11-08T15:00:00.000Z'));
    session.runningNotes = 'SYNTHETIC PRIVATE RECOVERY NOTE';
    session.answers['primary-goal'].value = 'SYNTHETIC CUSTOMER CONFIRMED CORRECTION';
    session.answers['primary-goal'].resolution = 'captured';
    session.answers['primary-goal'].source = 'client-statement';
    let db: IDBDatabase | null = await trial.openConfirmationTrialDatabaseForReview();
    try {
      await trial.seedConfirmationTrialForReview(db, session);
      const bytes = await backup.exportConfirmationTrialBackupForReview(db, session.sessionId);
      const expected = await backup.validateConfirmationTrialBackupForReview(bytes);
      db.close(); db = null;
      await trial.deleteConfirmationTrialDatabaseForReview();
      db = await trial.openConfirmationTrialDatabaseForReview();
      const restored = await backup.restoreConfirmationTrialBackupForReview(db, bytes);
      const loaded = await trial.loadConfirmationTrialForReview(db, session.sessionId);
      let duplicateRejected = false;
      try {
        await backup.restoreConfirmationTrialBackupForReview(db, bytes);
      } catch {
        duplicateRejected = true;
      }
      let tamperRejected = false;
      const forged = JSON.parse(bytes);
      forged.session.runningNotes = 'SYNTHETIC FORGED';
      try {
        await backup.restoreConfirmationTrialBackupForReview(
          db, c14n.canonicalizeJson(forged) + '\n',
        );
      } catch {
        tamperRejected = true;
      }
      return {
        restoredIdentical: c14n.canonicalizeJson(restored) === c14n.canonicalizeJson(expected)
          && c14n.canonicalizeJson(loaded) === c14n.canonicalizeJson(session),
        duplicateRejected,
        tamperRejected,
        value: loaded.answers['primary-goal'].value,
        notes: loaded.runningNotes,
      };
    } finally {
      db?.close();
      await trial.deleteConfirmationTrialDatabaseForReview();
    }
  });
  expect(result).toEqual({
    restoredIdentical: true,
    duplicateRejected: true,
    tamperRejected: true,
    value: 'SYNTHETIC CUSTOMER CONFIRMED CORRECTION',
    notes: 'SYNTHETIC PRIVATE RECOVERY NOTE',
  });
});

test('held synthetic tab blocks deletion and the caller sees a failure, never false success', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const mod = await import(/* @vite-ignore */ '/src/interview-prep-confirmation-idb-trial.ts');
    let db: IDBDatabase | null = await mod.openConfirmationTrialDatabaseForReview();
    let versionChangeSeen = false;
    // Deliberately simulate a noncooperative second tab: no automatic close.
    db.onversionchange = () => { versionChangeSeen = true; };
    let blockedReported = false;
    try {
      await mod.deleteConfirmationTrialDatabaseForReview();
    } catch (e) {
      blockedReported = e instanceof Error && e.message.includes('blocked');
    }
    db.close(); db = null;
    // The blocked native request may complete after the tab closes. Open will
    // wait for that native request to settle before creating the trial DB anew.
    const newDb = await mod.openConfirmationTrialDatabaseForReview();
    newDb.close();
    await mod.deleteConfirmationTrialDatabaseForReview();
    return { blockedReported, versionChangeSeen };
  });
  expect(result).toEqual({ blockedReported: true, versionChangeSeen: true });
});

test('synthetic versionchange closes old trial handle and requires explicit reopen', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const mod = await import(/* @vite-ignore */ '/src/interview-prep-confirmation-idb-trial.ts');
    const db = await mod.openConfirmationTrialDatabaseForReview();
    try {
      const bumped = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(mod.CONFIRMATION_TRIAL_DB_NAME, 2);
        req.onupgradeneeded = () => { /* only for synthetic lifecycle test */ };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('Synthetic upgrade failed'));
        req.onblocked = () => reject(new Error('Unexpected synthetic upgrade block'));
      });
      bumped.close();
      let oldHandleRejected = false;
      try {
        db.transaction('synthetic-confirmed-sessions', 'readonly');
      } catch (e) {
        oldHandleRejected = e instanceof DOMException && e.name === 'InvalidStateError';
      }
      let explicitOldVersionRejected = false;
      try {
        await mod.openConfirmationTrialDatabaseForReview();
      } catch (e) {
        explicitOldVersionRejected = e instanceof Error;
      }
      return { oldHandleRejected, explicitOldVersionRejected };
    } finally {
      db.close();
      await mod.deleteConfirmationTrialDatabaseForReview();
    }
  });
  expect(result).toEqual({
    oldHandleRejected: true,
    explicitOldVersionRejected: true,
  });
});

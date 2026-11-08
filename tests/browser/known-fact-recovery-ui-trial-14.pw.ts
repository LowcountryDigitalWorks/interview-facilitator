import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * Human-operated source-only 1.4 trial UI using synthetic Chromium.
 * No production entry, live customer data, network provider or real device.
 */
test.beforeEach(async ({ page }) => {
  await page.goto('/tests/browser/fixtures/readback.html');
});

/** Browser-native synthetic selection. No Node/Buffer types or new dependencies. */
async function selectSyntheticBackup(page: Page, name: string, contents: string): Promise<void> {
  await page.evaluate(({ name, contents }) => {
    const input = document.querySelector('#synthetic-recovery input[type="file"]') as HTMLInputElement;
    const data = new DataTransfer();
    data.items.add(new File([contents], name, { type: 'application/json' }));
    input.files = data.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, { name, contents });
}

test('human export download and explicit verified-file restore survive isolated trial DB loss', async ({ page }) => {
  const id = await page.evaluate(async () => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const [pack, semantic, known, lifecycle, trial, ui] = await Promise.all([
      '/src/pack.ts', '/src/semantic-session.ts', '/src/known-fact-session.ts',
      '/src/known-fact-lifecycle-14.ts', '/src/known-fact-lifecycle-storage-trial-14.ts',
      '/src/known-fact-recovery-ui-trial-14.ts',
    ].map(load));
    const source = await semantic.createSemanticSession(pack.generalDiscoveryPack, {
      clientLabel: 'PRIVATE SYNTHETIC CLIENT',
      interviewerLabel: 'PRIVATE SYNTHETIC INTERVIEWER',
    }, new Date('2026-11-08T05:00:00.000Z'));
    source.runningNotes = 'PRIVATE SYNTHETIC RUNNING NOTES';
    const session = await known.migrateSemantic13ToKnownFact14(source);
    const db = await trial.openKnownFactLifecycleTrial14ForReview();
    const saved = await trial.saveKnownFactLifecycleTrial14ForReview(
      db, await lifecycle.createKnownFactLifecycle14(session), null);
    const host = document.createElement('section');
    host.id = 'synthetic-recovery';
    document.querySelector('main')!.appendChild(host);
    const mounted = ui.mountKnownFactRecoveryTrial14ForReview(host, db, {
      exportSessionId: saved.lifecycle.session.sessionId,
    });
    (window as Window & { __recoveryTrial?: { db: IDBDatabase; dispose: () => void } })
      .__recoveryTrial = { db, dispose: mounted.dispose };
    return session.sessionId;
  });
  expect(await page.locator('#synthetic-recovery').textContent()).not.toContain('PRIVATE SYNTHETIC');

  const downloadWait = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download selected trial backup' }).click();
  const download = await downloadWait;
  expect(download.suggestedFilename()).toBe('ldw-interview-lifecycle-1.4-trial-confidential.json');
  const downloadedPath = await download.path();
  expect(downloadedPath).toBeTruthy();
  await expect(page.getByRole('status')).toContainText('Local download requested');

  await page.evaluate(async () => {
    const trial = await import(/* @vite-ignore */ String('/src/known-fact-lifecycle-storage-trial-14.ts'));
    const handle = (window as Window & { __recoveryTrial?: { db: IDBDatabase; dispose: () => void } })
      .__recoveryTrial!;
    handle.dispose();
    handle.db.close();
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(trial.LIFECYCLE_TRIAL_DB_NAME);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Trial DB loss blocked.'));
    });
    const db = await trial.openKnownFactLifecycleTrial14ForReview();
    const ui = await import(/* @vite-ignore */ String('/src/known-fact-recovery-ui-trial-14.ts'));
    const host = document.querySelector('#synthetic-recovery') as HTMLElement;
    const mounted = ui.mountKnownFactRecoveryTrial14ForReview(host, db);
    (window as Window & { __recoveryTrial?: { db: IDBDatabase; dispose: () => void } })
      .__recoveryTrial = { db, dispose: mounted.dispose };
  });

  const restoreButton = page.getByRole('button', { name: 'Restore selected backup into empty trial slot' });
  await expect(restoreButton).toBeDisabled();
  await page.getByLabel('Choose a confidential trial backup JSON file')
    .setInputFiles(downloadedPath!);
  const validation = await page.evaluate(async () => {
    const input = document.querySelector('#synthetic-recovery input[type="file"]') as HTMLInputElement;
    const content = await input.files![0]!.text();
    const trial = await import(/* @vite-ignore */ String('/src/known-fact-lifecycle-storage-trial-14.ts'));
    const lifecycle = await trial.validateLifecycleTrial14BackupForReview(content);
    return { classification: JSON.parse(content).classification,
      status: lifecycle.status, containsPrivate: content.includes('PRIVATE SYNTHETIC'),
      sessionId: lifecycle.session.sessionId };
  });
  expect(validation).toEqual({
    classification: 'INTERNAL / CONFIDENTIAL', status: 'draft',
    containsPrivate: true, sessionId: id,
  });
  await expect(page.getByText(/Validated confidential trial backup/)).toBeVisible();
  await expect(restoreButton).toBeDisabled();
  await page.getByRole('checkbox', { name: /I understand this is an explicit restore/ }).check();
  await expect(restoreButton).toBeEnabled();
  await restoreButton.click();
  await expect(page.getByRole('status')).toContainText('Trial restore committed locally');
  await expect(restoreButton).toBeDisabled();

  const recovered = await page.evaluate(async (sessionId) => {
    const trial = await import(/* @vite-ignore */ String('/src/known-fact-lifecycle-storage-trial-14.ts'));
    const handle = (window as Window & { __recoveryTrial?: { db: IDBDatabase; dispose: () => void } })
      .__recoveryTrial!;
    const saved = await trial.loadKnownFactLifecycleTrial14ForReview(handle.db, sessionId);
    return { status: saved?.lifecycle.status, generation: saved?.generation,
      clientLabel: saved?.lifecycle.session.clientLabel,
      notes: saved?.lifecycle.session.runningNotes };
  }, id);
  expect(recovered).toEqual({
    status: 'draft', generation: 0, clientLabel: 'PRIVATE SYNTHETIC CLIENT',
    notes: 'PRIVATE SYNTHETIC RUNNING NOTES',
  });
  expect(await page.locator('#synthetic-recovery').textContent()).not.toContain('PRIVATE SYNTHETIC');
});

test('invalid file, explicit cancellation and occupied trial restore never overwrite data', async ({ page }) => {
  const bytes = await page.evaluate(async () => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const [pack, semantic, known, lifecycle, trial, ui] = await Promise.all([
      '/src/pack.ts', '/src/semantic-session.ts', '/src/known-fact-session.ts',
      '/src/known-fact-lifecycle-14.ts', '/src/known-fact-lifecycle-storage-trial-14.ts',
      '/src/known-fact-recovery-ui-trial-14.ts',
    ].map(load));
    const source = await semantic.createSemanticSession(pack.generalDiscoveryPack, {
      clientLabel: 'PRIVATE UNDISPLAYED CLIENT',
    }, new Date('2026-11-08T05:00:00.000Z'));
    const session = await known.migrateSemantic13ToKnownFact14(source);
    const bytes = await trial.createLifecycleTrial14BackupForReview(
      await lifecycle.createKnownFactLifecycle14(session));
    const db = await trial.openKnownFactLifecycleTrial14ForReview();
    const host = document.createElement('section');
    host.id = 'synthetic-recovery';
    document.querySelector('main')!.appendChild(host);
    ui.mountKnownFactRecoveryTrial14ForReview(host, db);
    (window as Window & { __recoveryDb?: IDBDatabase }).__recoveryDb = db;
    return bytes;
  });
  const input = page.getByLabel('Choose a confidential trial backup JSON file');
  const restore = page.getByRole('button', { name: 'Restore selected backup into empty trial slot' });
  await selectSyntheticBackup(page, 'bad.json', '{"invalid":"PRIVATE MUST NEVER LEAK"}');
  await expect(page.getByRole('status')).toContainText('Backup rejected');
  await expect(restore).toBeDisabled();
  expect(await page.locator('#synthetic-recovery').textContent()).not.toContain('PRIVATE MUST NEVER LEAK');

  await selectSyntheticBackup(page, 'good.json', bytes);
  await expect(page.getByRole('status')).toContainText('Backup validated locally');
  await page.getByRole('button', { name: 'Cancel selected backup' }).click();
  await expect(page.getByRole('status')).toContainText('Selection cancelled');
  await expect(restore).toBeDisabled();
  const empty = await page.evaluate(async () => {
    const db = (window as Window & { __recoveryDb?: IDBDatabase }).__recoveryDb!;
    const request = db.transaction('trial-lifecycle', 'readonly').objectStore('trial-lifecycle').getAll();
    return new Promise<number>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result.length);
      request.onerror = () => reject(request.error);
    });
  });
  expect(empty).toBe(0);

  await selectSyntheticBackup(page, 'good.json', bytes);
  await expect(page.getByRole('status')).toContainText('Backup validated locally');
  await page.getByRole('checkbox', { name: /I understand this is an explicit restore/ }).check();
  await restore.click();
  await expect(page.getByRole('status')).toContainText('Trial restore committed locally');
  await selectSyntheticBackup(page, 'good.json', bytes);
  await expect(page.getByRole('status')).toContainText('Backup validated locally');
  await page.getByRole('checkbox', { name: /I understand this is an explicit restore/ }).check();
  await restore.click();
  await expect(page.getByRole('status')).toContainText('Restore was not applied');
  await expect(restore).toBeDisabled();
  const rows = await page.evaluate(async () => {
    const db = (window as Window & { __recoveryDb?: IDBDatabase }).__recoveryDb!;
    const request = db.transaction('trial-lifecycle', 'readonly').objectStore('trial-lifecycle').getAll();
    return new Promise<Array<{ generation: number }>>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  });
  expect(rows).toHaveLength(1);
  expect(rows[0]?.generation).toBe(0);
  expect(await page.locator('#synthetic-recovery').textContent()).not.toContain('PRIVATE UNDISPLAYED CLIENT');
});

test('source-only recovery controls pass automated accessibility floor without revealing contents', async ({ page }) => {
  await page.evaluate(async () => {
    const trial = await import(/* @vite-ignore */ String('/src/known-fact-lifecycle-storage-trial-14.ts'));
    const ui = await import(/* @vite-ignore */ String('/src/known-fact-recovery-ui-trial-14.ts'));
    const db = await trial.openKnownFactLifecycleTrial14ForReview();
    const host = document.createElement('section');
    host.id = 'synthetic-recovery';
    document.querySelector('main')!.appendChild(host);
    ui.mountKnownFactRecoveryTrial14ForReview(host, db);
    (window as Window & { __recoveryDb?: IDBDatabase }).__recoveryDb = db;
  });
  await expect(page.getByRole('button', { name: 'Download selected trial backup' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Restore selected backup into empty trial slot' })).toBeDisabled();
  await expect(page.getByRole('status')).toContainText('No export or restore');
  const result = await new AxeBuilder({ page }).include('main')
    .withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(result.violations.filter(x => x.impact === 'critical' || x.impact === 'serious')).toEqual([]);
});

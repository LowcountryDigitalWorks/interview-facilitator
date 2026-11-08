import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * Synthetic, internal-only 1.4 lifecycle UI. This Vite fixture intentionally
 * does not import the production main.ts entry or open the live 1.3 database.
 */
test.beforeEach(async ({ page }) => {
  await page.goto('/tests/browser/fixtures/readback.html');
});

async function install(page: Page, seed: boolean): Promise<string> {
  return page.evaluate(async (create) => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const [pack, semantic, known, lifecycle, trial, ui] = await Promise.all([
      '/src/pack.ts', '/src/semantic-session.ts', '/src/known-fact-session.ts',
      '/src/known-fact-lifecycle-14.ts', '/src/known-fact-lifecycle-storage-trial-14.ts',
      '/src/known-fact-lifecycle-controls-trial-14.ts',
    ].map(load));
    const db = await trial.openKnownFactLifecycleTrial14ForReview();
    let sessionId: string;
    if (create) {
      const base = await semantic.createSemanticSession(pack.generalDiscoveryPack, {
        clientLabel: 'PRIVATE SYNTHETIC CLIENT NEVER DISPLAY',
        interviewerLabel: 'PRIVATE SYNTHETIC INTERVIEWER NEVER DISPLAY',
      }, new Date('2026-11-07T08:00:00.000Z'));
      base.runningNotes = 'PRIVATE SYNTHETIC RUNNING NOTES NEVER DISPLAY';
      const session = await known.migrateSemantic13ToKnownFact14(base);
      sessionId = session.sessionId;
      const initial = await lifecycle.createKnownFactLifecycle14(session);
      await trial.saveKnownFactLifecycleTrial14ForReview(db, initial, null);
    } else {
      sessionId = (sessionStorage.getItem('synthetic-lifecycle-id') ?? '');
    }
    sessionStorage.setItem('synthetic-lifecycle-id', sessionId);
    const host = document.createElement('section');
    host.id = 'synthetic-lifecycle';
    document.querySelector('main')!.appendChild(host);
    const controller = ui.mountKnownFactLifecycleControlsTrial14ForReview(host, db, sessionId);
    (window as Window & { __lifecycleTrial?: { db: IDBDatabase; dispose: () => void; sessionId: string } })
      .__lifecycleTrial = { db, dispose: controller.dispose, sessionId };
    return sessionId;
  }, seed);
}

async function inspect(page: Page): Promise<{
  status: string; generation: number; completionCount: number; eventTypes: string[];
  parentLinked: boolean; completedSnapshotMatches: boolean; notesRetained: boolean;
}> {
  return page.evaluate(async () => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const [trial, identity] = await Promise.all([
      '/src/known-fact-lifecycle-storage-trial-14.ts', '/src/pack-identity.ts',
    ].map(load));
    const held = (window as Window & { __lifecycleTrial?: {
      db: IDBDatabase; sessionId: string;
    } }).__lifecycleTrial!;
    const record = await trial.loadKnownFactLifecycleTrial14ForReview(held.db, held.sessionId);
    if (!record) throw new Error('Expected synthetic trial record.');
    const snapshot = record.lifecycle.completedRevisions[0]?.sessionSnapshot;
    const historicalRequest = held.db.transaction('trial-history', 'readonly')
      .objectStore('trial-history').get(trial.lifecycleTrialHistoryKey(held.sessionId, 1));
    const historical = await new Promise<{ lifecycle: { session: unknown } } | undefined>(
      (resolve, reject) => {
        historicalRequest.onsuccess = () => resolve(historicalRequest.result);
        historicalRequest.onerror = () => reject(historicalRequest.error);
      });
    const canonical = (v: unknown) => identity.canonicalizeJson(JSON.parse(JSON.stringify(v)));
    return {
      status: record.lifecycle.status,
      generation: record.generation,
      completionCount: record.lifecycle.completedRevisions.length,
      eventTypes: record.lifecycle.events.map((e: { type: string }) => e.type),
      parentLinked: snapshot
        ? record.lifecycle.session.parentRevisionId === snapshot.revisionId : false,
      completedSnapshotMatches: !!snapshot && !!historical
        && canonical(snapshot) === canonical(historical.lifecycle.session),
      notesRetained: record.lifecycle.session.runningNotes
        === 'PRIVATE SYNTHETIC RUNNING NOTES NEVER DISPLAY',
    };
  });
}

test('human-only Complete/Reopen survives reload with immutable source and no implicit read-back event', async ({ page }) => {
  await install(page, true);
  await expect(page.getByRole('status')).toContainText('Trial record loaded');
  await expect(page.getByRole('button', { name: 'Mark Draft complete — trial only' })).toBeDisabled();
  expect(await inspect(page)).toMatchObject({ status: 'draft', generation: 0, completionCount: 0, eventTypes: [] });

  // Navigation alone cannot record read-back, change lifecycle or consent.
  await page.getByRole('button', { name: 'View discussion guidance' }).click();
  await expect(page.getByText(/Opening this view does not record/)).toBeVisible();
  expect(await inspect(page)).toMatchObject({ status: 'draft', generation: 0, completionCount: 0, eventTypes: [] });
  await page.getByRole('button', { name: 'Return to lifecycle controls' }).click();

  await page.getByRole('checkbox', { name: /I am deliberately marking this Draft complete/ }).check();
  await page.getByRole('button', { name: 'Mark Draft complete — trial only' }).click();
  await expect(page.getByRole('status')).toContainText('Draft marked Completed');
  expect(await inspect(page)).toMatchObject({
    status: 'completed', generation: 1, completionCount: 1, eventTypes: ['completed'], notesRetained: true,
  });

  // New trial UI mount after page reload: no automatic reopening.
  await page.reload();
  await install(page, false);
  await expect(page.getByRole('status')).toContainText('Trial record loaded');
  await expect(page.getByRole('button', { name: 'Reopen as new Draft — trial only' })).toBeDisabled();
  await page.getByRole('checkbox', { name: /I am deliberately reopening/ }).check();
  await page.getByRole('button', { name: 'Reopen as new Draft — trial only' }).click();
  await expect(page.getByRole('status')).toContainText('new Draft saved');
  expect(await inspect(page)).toEqual({
    status: 'draft', generation: 2, completionCount: 1,
    eventTypes: ['completed', 'reopened'], parentLinked: true,
    completedSnapshotMatches: true, notesRetained: true,
  });
  expect(await page.locator('#synthetic-lifecycle').textContent()).not.toContain('PRIVATE SYNTHETIC');
  expect(await page.locator('#synthetic-lifecycle').textContent()).not.toContain('sessionId');
});

test('stale parallel tab cannot overwrite completion; explicit reload shows winning state', async ({ page, context }) => {
  await install(page, true);
  const other = await context.newPage();
  await other.goto('/tests/browser/fixtures/readback.html');
  await other.evaluate(() => {
    // sessionStorage is per tab; explicit synthetic fixture transfer only.
    sessionStorage.setItem('synthetic-lifecycle-id', 'pending');
  });
  const id = await page.evaluate(() => sessionStorage.getItem('synthetic-lifecycle-id')!);
  await other.evaluate(value => sessionStorage.setItem('synthetic-lifecycle-id', value), id);
  await install(other, false);
  await expect(other.getByRole('status')).toContainText('Trial record loaded');

  await page.getByRole('checkbox', { name: /I am deliberately marking this Draft complete/ }).check();
  await page.getByRole('button', { name: 'Mark Draft complete — trial only' }).click();
  await expect(page.getByRole('status')).toContainText('Draft marked Completed');

  await other.getByRole('checkbox', { name: /I am deliberately marking this Draft complete/ }).check();
  await other.getByRole('button', { name: 'Mark Draft complete — trial only' }).click();
  await expect(other.getByRole('status')).toContainText('No overwrite. Reload');
  await expect(other.getByRole('button', { name: 'Mark Draft complete — trial only' })).toBeDisabled();
  expect(await inspect(other)).toMatchObject({ status: 'completed', generation: 1, eventTypes: ['completed'] });

  await other.getByRole('button', { name: 'Reload current trial state' }).click();
  await expect(other.getByRole('status')).toContainText('Trial record loaded');
  await expect(other.getByRole('button', { name: 'Reopen as new Draft — trial only' })).toBeDisabled();
  await other.close();
});

test('isolated controls retain privacy and basic axe accessibility; dispose removes listeners and UI', async ({ page }) => {
  await install(page, true);
  await expect(page.getByRole('status')).toContainText('Trial record loaded');
  const content = await page.locator('#synthetic-lifecycle').textContent();
  expect(content).not.toContain('PRIVATE SYNTHETIC');
  expect(content).not.toContain('RUNNING NOTES');
  const a11y = await new AxeBuilder({ page }).include('main')
    .withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(a11y.violations.filter(v => v.impact === 'critical' || v.impact === 'serious')).toEqual([]);
  await page.evaluate(() => {
    const controller = (window as Window & { __lifecycleTrial?: { dispose: () => void } })
      .__lifecycleTrial!;
    controller.dispose();
  });
  await expect(page.locator('#synthetic-lifecycle')).toBeEmpty();
});

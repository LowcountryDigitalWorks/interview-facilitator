import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/** Synthetic 1.4 UI only; the live 1.3 entrypoint/database is never loaded. */
test.beforeEach(async ({ page }) => {
  await page.goto('/tests/browser/fixtures/readback.html');
});

async function mount(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const [pack, semantic, known, ui] = await Promise.all([
      '/src/pack.ts', '/src/semantic-session.ts', '/src/known-fact-session.ts',
      '/src/client-readback-controls-trial-14.ts',
    ].map(load));
    const base = await semantic.createSemanticSession(pack.generalDiscoveryPack, {
      clientLabel: 'SYNTHETIC SECRET CLIENT NOT TO DISCLOSE',
    }, new Date('2026-11-08T16:00:00.000Z'));
    base.runningNotes = 'SYNTHETIC PRIVATE RUNNING NOTES NOT TO DISCLOSE';
    base.answers['primary-goal'] = {
      value: 'SYNTHETIC REVIEWABLE GOAL',
      resolution: 'captured', source: 'client-statement',
      needsConfirmation: false, confirmation: null,
      note: 'SYNTHETIC PRIVATE QUESTION NOTE NOT TO DISCLOSE',
      followUp: { action: 'SYNTHETIC REVIEWABLE FOLLOW-UP' },
    };
    const session = await known.migrateSemantic13ToKnownFact14(base);
    const privateHost = document.createElement('section');
    privateHost.id = 'private-selection';
    privateHost.setAttribute('aria-label', 'Internal synthetic review');
    document.querySelector('main')!.appendChild(privateHost);
    const previewHost = document.querySelector('#readback-preview') as HTMLElement;
    const state = { session, dispose: () => {} };
    const handle = ui.mountKnownFact14ReadBackSelectionTrialForReview(
      privateHost, previewHost, () => state.session,
    );
    state.dispose = handle.dispose;
    (window as Window & { __selectionTrial?: typeof state }).__selectionTrial = state;
  });
  await expect(page.getByRole('heading', {
    name: 'Private Read-back selection — 1.4 trial',
  })).toBeVisible();
}

test('explicit human selection only; private content removed before discussion, no consent recorded', async ({ page }) => {
  await mount(page);
  const privateHost = page.locator('#private-selection');
  const previewHost = page.locator('#readback-preview');
  expect(await previewHost.textContent()).toBe('');
  const group = privateHost.getByRole('group', { name: 'What outcome matters most from this work?' });
  await expect(group).toContainText('SYNTHETIC REVIEWABLE GOAL');
  await group.getByRole('checkbox', { name: /Review this item for disclosure/ }).check();
  await group.getByRole('textbox', { name: 'Reviewed public label:' }).fill('Public pilot objective');
  await group.getByRole('checkbox', { name: /Separately disclose this exact follow-up/ }).check();
  await privateHost.getByRole('button', { name: 'Show selected discussion preview — trial' }).click();
  await expect(previewHost.getByRole('heading', { name: 'Client Read-back — discussion preview' })).toBeVisible();
  await expect(previewHost.getByRole('listitem')).toHaveCount(1);
  await expect(previewHost).toContainText('Public pilot objective');
  await expect(previewHost).toContainText('SYNTHETIC REVIEWABLE GOAL');
  await expect(previewHost).toContainText('SYNTHETIC REVIEWABLE FOLLOW-UP');
  expect(await privateHost.textContent()).toBe('');
  const publicText = await previewHost.textContent() ?? '';
  expect(publicText).not.toContain('SYNTHETIC SECRET CLIENT');
  expect(publicText).not.toContain('SYNTHETIC PRIVATE RUNNING');
  expect(publicText).not.toContain('SYNTHETIC PRIVATE QUESTION');
  expect(publicText).not.toContain('consent recorded');
  const audit = await new AxeBuilder({ page })
    .include('#readback-preview')
    .withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(audit.violations.filter(v => v.impact === 'critical' || v.impact === 'serious')).toEqual([]);

  await previewHost.getByRole('button', { name: 'End preview and return to private review' }).click();
  await expect(privateHost.getByRole('heading', { name: 'Private Read-back selection — 1.4 trial' })).toBeVisible();
  expect(await previewHost.textContent()).toBe('');
  await expect(privateHost.getByRole('checkbox', { name: /Review this item for disclosure/ }).first()).not.toBeChecked();
});

test('no checked selection yields zero disclosed items; no automatic opt-in', async ({ page }) => {
  await mount(page);
  await page.locator('#private-selection').getByRole('button', { name: 'Show selected discussion preview — trial' }).click();
  const publicHost = page.locator('#readback-preview');
  await expect(publicHost).toContainText('No items selected for disclosure.');
  await expect(publicHost.getByRole('listitem')).toHaveCount(0);
  expect(await publicHost.textContent()).not.toContain('SYNTHETIC REVIEWABLE GOAL');
  expect(await page.locator('#private-selection').textContent()).toBe('');
});

test('a private-note-only source change rejects previously selected snapshot', async ({ page }) => {
  await mount(page);
  const group = page.locator('#private-selection').getByRole('group', {
    name: 'What outcome matters most from this work?',
  });
  await group.getByRole('checkbox', { name: /Review this item for disclosure/ }).check();
  await group.getByRole('textbox', { name: 'Reviewed public label:' }).fill('Public objective');
  await page.evaluate(() => {
    const trial = (window as Window & { __selectionTrial?: { session: { runningNotes: string } } })
      .__selectionTrial!;
    trial.session.runningNotes = 'SYNTHETIC PRIVATE NOTE CHANGED AFTER REVIEW';
  });
  await page.locator('#private-selection').getByRole('button', {
    name: 'Show selected discussion preview — trial',
  }).click();
  const publicHost = page.locator('#readback-preview');
  await expect(publicHost.getByRole('alert')).toContainText('Source or selections require fresh private review');
  await expect(publicHost.getByRole('listitem')).toHaveCount(0);
  expect(await publicHost.textContent()).not.toContain('SYNTHETIC REVIEWABLE GOAL');
  expect(await publicHost.textContent()).not.toContain('SYNTHETIC PRIVATE');
  await publicHost.getByRole('button', { name: 'End preview and return to private review' }).click();
  await expect(page.locator('#private-selection').getByRole('heading', {
    name: 'Private Read-back selection — 1.4 trial',
  })).toBeVisible();
  expect(await publicHost.textContent()).toBe('');
});

test('disposal clears both surfaces and detached controls cannot re-disclose', async ({ page }) => {
  await mount(page);
  const outcome = await page.evaluate(async () => {
    const privateHost = document.querySelector('#private-selection') as HTMLElement;
    const previewHost = document.querySelector('#readback-preview') as HTMLElement;
    const button = Array.from(privateHost.querySelectorAll('button'))
      .find(b => b.textContent?.includes('Show selected discussion preview'))!;
    const state = (window as Window & { __selectionTrial?: { dispose: () => void } }).__selectionTrial!;
    state.dispose();
    button.disabled = false;
    button.click();
    await Promise.resolve();
    return {
      privateEmpty: privateHost.childElementCount === 0,
      previewEmpty: previewHost.childElementCount === 0,
    };
  });
  expect(outcome).toEqual({ privateEmpty: true, previewEmpty: true });
});

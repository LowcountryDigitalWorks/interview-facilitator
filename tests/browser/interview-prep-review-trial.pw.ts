import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/** Dormant synthetic-only private prep proof; no live PWA or provider connection. */
test.beforeEach(async ({ page }) => {
  await page.goto('/tests/browser/fixtures/readback.html');
});

async function install(page: Page, hiddenOnly = false): Promise<void> {
  await page.evaluate(async (onlyHidden) => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const [pack, semantic, prep, ui] = await Promise.all([
      '/src/pack.ts', '/src/semantic-session.ts', '/src/interview-workflow-bridge.ts',
      '/src/interview-prep-review-ui-trial.ts',
    ].map(load));
    const session = await semantic.createSemanticSession(pack.generalDiscoveryPack, {
      clientLabel: 'SYNTHETIC CLIENT PRIVATE NEVER ON CONSOLE',
    }, new Date('2026-11-08T12:00:00.000Z'));
    session.runningNotes = 'SYNTHETIC SECRET RUNNING NOTES';
    session.answers['needs-booking'] = {
      value: 'No', resolution: 'captured', source: 'client-statement',
      needsConfirmation: false, confirmation: null, followUp: null, note: '',
    };
    const candidate = (
      candidateId: string, questionId: string, proposedValue: string,
    ) => ({
      candidateId, questionId, proposedValue, sourceSystem: 'authorized-notes',
      sourceRecordRef: 'PRIVATE AUTHORIZED SOURCE ' + candidateId,
      observedAt: '2026-11-08T12:30:00.000Z', confidence: 'unverified',
    });
    const packet = {
      schemaVersion: prep.INTERVIEW_PREP_PACKET_VERSION,
      jobKey: 'SYNTHETIC-PRIVATE-JOB-001',
      sessionId: session.sessionId,
      expectedRevisionId: session.revisionId,
      expectedPackDigest: session.packIdentity.digest,
      preparedAt: '2026-11-08T13:00:00.000Z',
      candidates: [
        ...(!onlyHidden ? [
          candidate('a', 'primary-goal', 'SYNTHETIC ALTERNATIVE A'),
          candidate('b', 'primary-goal', 'SYNTHETIC ALTERNATIVE B'),
          candidate('c', 'must-have', 'SYNTHETIC ONE PROPOSAL'),
        ] : []),
        candidate('private-hidden', 'booking-process', 'SYNTHETIC HIDDEN BRANCH'),
      ],
    };
    const host = document.createElement('section');
    host.setAttribute('aria-label', 'Private preparation trial');
    host.id = 'private-prep-trial';
    document.querySelector('main')!.appendChild(host);
    const state = {
      session, packet, reviewed: [] as unknown[],
      dispose: () => {},
    };
    const ctrl = ui.mountPrivateInterviewPrepReviewTrial(
      host, () => state.packet, () => state.session,
      (selection: unknown) => { state.reviewed.push(selection); },
    );
    state.dispose = ctrl.dispose;
    (window as Window & { __prepTrial?: typeof state }).__prepTrial = state;
  }, hiddenOnly);
  await expect(page.getByRole('heading', {
    name: 'Private preparation — candidate review trial',
  })).toBeVisible();
}

test('human must select one explicit conflicting candidate and acknowledge; no automatic accepted answer', async ({ page }) => {
  await install(page);
  const host = page.locator('#private-prep-trial');
  const goal = host.getByRole('group', { name: 'What outcome matters most from this work?' });
  await expect(goal).toContainText('Conflicting source values');
  await expect(goal.getByRole('radio')).toHaveCount(2);
  await expect(host.getByRole('group', {
    name: 'How should booking or scheduling work?',
  })).toHaveCount(0);
  const submit = host.getByRole('button', {
    name: 'Prepare selected candidate proposal — trial only',
  });
  await expect(submit).toBeDisabled();
  await goal.getByRole('radio', { name: /SYNTHETIC ALTERNATIVE B/ }).check();
  await expect(submit).toBeDisabled();
  await host.getByRole('checkbox', { name: /I deliberately reviewed/ }).check();
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(host).toContainText('Private candidate proposal assembled in local memory.');
  const outcome = await page.evaluate(() => {
    const state = (window as Window & { __prepTrial?: {
      reviewed: Array<{ selections: Array<{questionId:string;candidateId:string}> }>;
      session: { answers: Record<string, { value: string | null; resolution: string }> };
    } }).__prepTrial!;
    return {
      length: state.reviewed.length,
      selected: state.reviewed[0]?.selections,
      privatePayload: JSON.stringify(state.reviewed[0]),
      originalAnswer: state.session.answers['primary-goal'],
    };
  });
  expect(outcome.length).toBe(1);
  expect(outcome.selected).toEqual([{ questionId: 'primary-goal', candidateId: 'b' }]);
  expect(outcome.originalAnswer).toMatchObject({ value: null, resolution: 'unresolved' });
  for (const phrase of ['SYNTHETIC ALTERNATIVE', 'PRIVATE AUTHORIZED SOURCE',
    'SYNTHETIC SECRET RUNNING', 'SYNTHETIC CLIENT PRIVATE']) {
    expect(outcome.privatePayload).not.toContain(phrase);
    expect(await host.textContent()).not.toContain(phrase);
  }
});

test('full source private-note edit rejects stale selection before callback', async ({ page }) => {
  await install(page);
  const host = page.locator('#private-prep-trial');
  await host.getByRole('group', { name: 'What outcome matters most from this work?' })
    .getByRole('radio', { name: /SYNTHETIC ALTERNATIVE A/ }).check();
  await host.getByRole('checkbox', { name: /I deliberately reviewed/ }).check();
  await page.evaluate(() => {
    const state = (window as Window & { __prepTrial?: {
      session: { runningNotes: string },
    } }).__prepTrial!;
    state.session.runningNotes = 'SYNTHETIC PRIVATE NOTE CHANGED WHILE REVIEW OPEN';
  });
  await host.getByRole('button', { name: 'Prepare selected candidate proposal — trial only' }).click();
  await expect(host.getByRole('alert')).toContainText('Private source changed');
  const count = await page.evaluate(() =>
    (window as Window & { __prepTrial?: { reviewed: unknown[] } }).__prepTrial!.reviewed.length);
  expect(count).toBe(0);
  expect(await host.textContent()).not.toContain('SYNTHETIC ALTERNATIVE A');
});

test('a private prep packet change rejects stale selection and never produces tasks', async ({ page }) => {
  await install(page);
  const host = page.locator('#private-prep-trial');
  await host.getByRole('group', { name: 'What outcome matters most from this work?' })
    .getByRole('radio', { name: /SYNTHETIC ALTERNATIVE A/ }).check();
  await host.getByRole('checkbox', { name: /I deliberately reviewed/ }).check();
  await page.evaluate(() => {
    const state = (window as Window & { __prepTrial?: {
      packet: { candidates: Array<{ proposedValue: string }> },
    } }).__prepTrial!;
    state.packet.candidates[0]!.proposedValue = 'SYNTHETIC CHANGED SOURCE VALUE';
  });
  await host.getByRole('button', { name: 'Prepare selected candidate proposal — trial only' }).click();
  await expect(host.getByRole('alert')).toContainText('Private source changed');
  const count = await page.evaluate(() =>
    (window as Window & { __prepTrial?: { reviewed: unknown[] } }).__prepTrial!.reviewed.length);
  expect(count).toBe(0);
});

test('only hidden-branch source evidence cannot produce a selection', async ({ page }) => {
  await install(page, true);
  const host = page.locator('#private-prep-trial');
  await expect(host.getByRole('radio')).toHaveCount(0);
  await expect(host).toContainText('No currently relevant candidates available');
  await host.getByRole('checkbox', { name: /I deliberately reviewed/ }).check();
  await expect(host.getByRole('button', {
    name: 'Prepare selected candidate proposal — trial only',
  })).toBeDisabled();
  expect(await host.textContent()).not.toContain('SYNTHETIC HIDDEN BRANCH');
});

test('dispose prevents activation from a detached button and clears private contents', async ({ page }) => {
  await install(page);
  const outcome = await page.evaluate(async () => {
    const state = (window as Window & { __prepTrial?: {
      reviewed: unknown[], dispose: () => void,
    } }).__prepTrial!;
    const host = document.querySelector('#private-prep-trial') as HTMLElement;
    const submit = Array.from(host.querySelectorAll('button'))
      .find(btn => btn.textContent?.includes('Prepare selected candidate proposal'))!;
    state.dispose();
    submit.disabled = false;
    submit.click();
    await Promise.resolve();
    return { callbacks: state.reviewed.length, empty: host.childElementCount === 0 };
  });
  expect(outcome).toEqual({ callbacks: 0, empty: true });
});

test('private review fieldsets and explicit controls pass automated serious/critical axe', async ({ page }) => {
  await install(page);
  const a11y = await new AxeBuilder({ page })
    .include('#private-prep-trial')
    .withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(a11y.violations.filter(v => v.impact === 'critical' || v.impact === 'serious')).toEqual([]);
});

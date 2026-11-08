import { expect, test } from '@playwright/test';

test('synthetic private review -> source-bound overlay; client answers/read-back remain unchanged', async ({ page }) => {
  await page.goto('/tests/browser/fixtures/readback.html');
  await page.evaluate(async () => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const [pack, semantic, prep, ui, stage, presentation] = await Promise.all([
      '/src/pack.ts', '/src/semantic-session.ts', '/src/interview-workflow-bridge.ts',
      '/src/interview-prep-review-ui-trial.ts', '/src/interview-prep-staging-overlay.ts',
      '/src/presentation.ts',
    ].map(load));
    const session = await semantic.createSemanticSession(pack.generalDiscoveryPack, {
      clientLabel: 'SYNTHETIC INTERNAL ENGAGEMENT — DO NOT SHARE',
    }, new Date('2026-11-08T12:00:00.000Z'));
    const packet = {
      schemaVersion: prep.INTERVIEW_PREP_PACKET_VERSION,
      jobKey: 'synthetic-job-private-stage-1',
      sessionId: session.sessionId,
      expectedRevisionId: session.revisionId,
      expectedPackDigest: session.packIdentity.digest,
      preparedAt: '2026-11-08T12:30:00.000Z',
      candidates: [
        {
          candidateId: 'a', questionId: 'primary-goal',
          proposedValue: 'SYNTHETIC CONFIDENTIAL SOURCE GOAL',
          sourceSystem: 'authorized-notes',
          sourceRecordRef: 'PRIVATE SOURCE REF A',
          observedAt: '2026-11-08T12:15:00.000Z',
          confidence: 'unverified',
        },
        {
          candidateId: 'b', questionId: 'primary-goal',
          proposedValue: 'SYNTHETIC ALTERNATIVE GOAL',
          sourceSystem: 'client-ops',
          sourceRecordRef: 'PRIVATE SOURCE REF B',
          observedAt: '2026-11-08T12:15:00.000Z',
          confidence: 'source-stated',
        },
      ],
    };
    const host = document.createElement('section');
    host.id = 'staging-review';
    document.querySelector('main')!.appendChild(host);
    const outcome = document.createElement('section');
    outcome.id = 'staging-result';
    document.querySelector('main')!.appendChild(outcome);
    const state = {
      session, packet, overlay: null as unknown, callbackCount: 0, errors: [] as string[],
      publicReadback: () => presentation.projectSemanticReadBack(
        session.packSnapshot.questions.find((q: { id: string }) => q.id === 'primary-goal'),
        session.answers['primary-goal'],
      ),
    };
    ui.mountPrivateInterviewPrepReviewTrial(host,
      () => state.packet, () => state.session, (selection: unknown) => {
        state.callbackCount++;
        void stage.stageSelectedInterviewPrepForReview(state.session, state.packet, selection)
          .then((overlay: unknown) => {
            state.overlay = overlay;
            outcome.textContent = 'Private source overlay staged; no canonical answers changed.';
          }).catch((err: Error) => {
            state.errors.push(err.message);
            outcome.textContent = 'Private staging rejected; no canonical answers changed.';
          });
      });
    (window as Window & { __staging?: typeof state }).__staging = state;
  });
  const host = page.locator('#staging-review');
  await expect(host.getByRole('heading', { name: 'Private preparation — candidate review trial' }))
    .toBeVisible();
  const submit = host.getByRole('button', { name: 'Prepare selected candidate proposal — trial only' });
  await expect(submit).toBeDisabled();
  await host.getByRole('radio', { name: /SYNTHETIC CONFIDENTIAL SOURCE GOAL/ }).check();
  await host.getByRole('checkbox', { name: /I deliberately reviewed/ }).check();
  await submit.click();
  await expect(page.locator('#staging-result')).toContainText('Private source overlay staged');
  await expect(host).not.toContainText('SYNTHETIC CONFIDENTIAL SOURCE GOAL');
  const state = await page.evaluate(() => {
    const s = (window as Window & { __staging?: {
      session: { answers: Record<string, { value: string | null; resolution: string }> },
      overlay: { kind: string; candidates: Array<{ proposedValue: string; sourceRecordRef: string }> } | null,
      callbackCount: number,
      errors: string[],
      publicReadback: () => { valueLabel: string; statusLabel: string },
    } }).__staging!;
    return {
      originalAnswer: s.session.answers['primary-goal'],
      overlay: s.overlay,
      count: s.callbackCount,
      errors: s.errors,
      readback: s.publicReadback(),
    };
  });
  expect(state.count).toBe(1);
  expect(state.errors).toEqual([]);
  expect(state.originalAnswer).toMatchObject({ value: null, resolution: 'unresolved' });
  expect(state.readback).toMatchObject({ valueLabel: 'No answer recorded', statusLabel: 'Open' });
  expect(state.overlay).toMatchObject({
    kind: 'private-interviewer-only-unconfirmed',
    candidates: [{
      proposedValue: 'SYNTHETIC CONFIDENTIAL SOURCE GOAL',
      sourceRecordRef: 'PRIVATE SOURCE REF A',
    }],
  });
  expect(await page.locator('#staging-result').textContent())
    .not.toContain('PRIVATE SOURCE REF');
  expect(await page.locator('#staging-result').textContent())
    .not.toContain('SYNTHETIC CONFIDENTIAL SOURCE GOAL');
});

import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * #35F: dormant 1.4 Read-back accessibility acceptance floor.
 *
 * This uses REAL browser DOM and actual source modules, but does not mount the
 * live application, provide client data, or certify keyboard/screen readers.
 * An automated axe pass is a baseline, not a human accessibility sign-off.
 */
test.beforeEach(async ({ page }) => {
  await page.goto('/tests/browser/fixtures/readback.html');
});

test('reviewed Read-back has semantic headings/list and does not steal interviewer focus', async ({ page }) => {
  const outcome = await page.evaluate(async () => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const [pack, semantic, known, readback, renderer] = await Promise.all([
      '/src/pack.ts', '/src/semantic-session.ts',
      '/src/known-fact-session.ts', '/src/client-readback-14.ts',
      '/src/client-readback-render-14.ts',
    ].map(load));

    const source = await semantic.createSemanticSession(pack.generalDiscoveryPack, {
      clientLabel: 'SYNTHETIC PRIVATE CLIENT',
      interviewerLabel: 'SYNTHETIC PRIVATE INTERVIEWER',
    }, new Date('2026-11-05T12:00:00.000Z'));
    source.runningNotes = 'SYNTHETIC PRIVATE RUNNING NOTES';
    source.answers['primary-goal'] = {
      value: '<svg onload="window.__readbackInjected=true">SYNTHETIC REVIEWED VALUE</svg>',
      resolution: 'captured', source: 'client-statement',
      needsConfirmation: false, confirmation: null,
      note: 'SYNTHETIC PRIVATE QUESTION NOTE',
      followUp: { action: 'SYNTHETIC REVIEWED NEXT STEP',
        owner: 'SYNTHETIC PRIVATE OWNER', dueDate: '2027-01-01' },
    };
    const session = await known.migrateSemantic13ToKnownFact14(source);
    const command = {
      ...await readback.prepareKnownFact14ReadBackReviewForReview(session),
      entries: [{
        questionId: 'primary-goal',
        publicLabel: 'SYNTHETIC REVIEWED GOAL',
        reviewedValue: source.answers['primary-goal'].value,
        reviewedFollowUp: 'SYNTHETIC REVIEWED NEXT STEP',
      }],
    };
    const control = document.createElement('button');
    control.textContent = 'Synthetic interviewer control';
    document.querySelector('main')!.prepend(control);
    control.focus();
    const host = document.querySelector('#readback-preview') as HTMLElement;
    const status = await renderer.renderReviewedKnownFact14ReadBackForReview(
      host, session, command,
    );
    const renderedText = host.textContent ?? '';
    return {
      status,
      focusStable: document.activeElement === control,
      headingLevels: Array.from(document.querySelectorAll('main h1, main h2, main h3'))
        .map(node => node.tagName.toLowerCase()),
      reviewedListCount: host.querySelectorAll('ol > li').length,
      noUnexpectedControls: host.querySelectorAll('button, a[href], input, textarea, [tabindex]').length === 0,
      noLiveRegionOnSuccessfulPreview: host.querySelector('[role="alert"], [aria-live]') === null,
      disclaimerPresent: renderedText.includes('For discussion only; not a confirmation'),
      selectionPresent: renderedText.includes('SYNTHETIC REVIEWED GOAL')
        && renderedText.includes('SYNTHETIC REVIEWED VALUE')
        && renderedText.includes('SYNTHETIC REVIEWED NEXT STEP'),
      privateFieldsAbsent: !renderedText.includes('SYNTHETIC PRIVATE'),
      noExecutableElements: host.querySelectorAll('svg, script, iframe, img, object').length === 0,
      noUnexpectedExecution: !(window as Window & { __readbackInjected?: boolean }).__readbackInjected,
    };
  });
  expect(outcome).toEqual({
    status: 'rendered',
    focusStable: true,
    headingLevels: ['h1', 'h2', 'h3'],
    reviewedListCount: 1,
    noUnexpectedControls: true,
    noLiveRegionOnSuccessfulPreview: true,
    disclaimerPresent: true,
    selectionPresent: true,
    privateFieldsAbsent: true,
    noExecutableElements: true,
    noUnexpectedExecution: true,
  });

  const a11y = await new AxeBuilder({ page }).include('main')
    .withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(a11y.violations.filter(v => v.impact === 'critical' || v.impact === 'serious'))
    .toEqual([]);
});

test('stale review clears selected disclosure without moving interviewer focus', async ({ page }) => {
  const outcome = await page.evaluate(async () => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const [pack, semantic, known, readback, renderer] = await Promise.all([
      '/src/pack.ts', '/src/semantic-session.ts',
      '/src/known-fact-session.ts', '/src/client-readback-14.ts',
      '/src/client-readback-render-14.ts',
    ].map(load));
    const source = await semantic.createSemanticSession(pack.generalDiscoveryPack, {
      clientLabel: 'SYNTHETIC PRIVATE CLIENT',
    }, new Date('2026-11-05T12:00:00.000Z'));
    source.answers['primary-goal'] = {
      value: 'SYNTHETIC REVIEWED VALUE',
      resolution: 'captured', source: 'client-statement',
      needsConfirmation: false, confirmation: null,
      note: 'SYNTHETIC PRIVATE NOTE', followUp: null,
    };
    const session = await known.migrateSemantic13ToKnownFact14(source);
    const valid = {
      ...await readback.prepareKnownFact14ReadBackReviewForReview(session),
      entries: [{ questionId: 'primary-goal', publicLabel: 'Reviewed goal',
        reviewedValue: 'SYNTHETIC REVIEWED VALUE' }],
    };
    const control = document.createElement('button');
    control.textContent = 'Synthetic interviewer control';
    document.querySelector('main')!.prepend(control);
    control.focus();
    const host = document.querySelector('#readback-preview') as HTMLElement;
    const first = await renderer.renderReviewedKnownFact14ReadBackForReview(host, session, valid);
    const previouslyVisible = (host.textContent ?? '').includes('SYNTHETIC REVIEWED VALUE');
    let rejected = false;
    try {
      await renderer.renderReviewedKnownFact14ReadBackForReview(host, session, {
        ...valid, expectedRevisionId: 'SYNTHETIC PRIVATE STALE REVISION',
      });
    } catch {
      rejected = true;
    }
    return {
      first,
      previouslyVisible,
      rejected,
      focusStable: document.activeElement === control,
      onlyGenericNotice: host.textContent ===
        'Read-back unavailable. Review the current session before presenting.',
      noPriorDisclosure: !(host.textContent ?? '').includes('SYNTHETIC REVIEWED VALUE'),
      noPrivateRevision: !(host.textContent ?? '').includes('SYNTHETIC PRIVATE'),
      genericFailureAlert: host.querySelector('[role="alert"]')?.textContent ===
        'Read-back unavailable. Review the current session before presenting.',
      noOldHeadingsOrList: host.querySelectorAll('h2,h3,ol,li').length === 0,
      noNewControls: host.querySelectorAll('button, a[href], input, textarea').length === 0,
    };
  });
  expect(outcome).toEqual({
    first: 'rendered',
    previouslyVisible: true,
    rejected: true,
    focusStable: true,
    onlyGenericNotice: true,
    noPriorDisclosure: true,
    noPrivateRevision: true,
    genericFailureAlert: true,
    noOldHeadingsOrList: true,
    noNewControls: true,
  });

  const a11y = await new AxeBuilder({ page }).include('main')
    .withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(a11y.violations.filter(v => v.impact === 'critical' || v.impact === 'serious'))
    .toEqual([]);
});

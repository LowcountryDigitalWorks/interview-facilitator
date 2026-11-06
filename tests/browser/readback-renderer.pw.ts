import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * Test-only Vite dev server serves the REAL dormant 1.4 modules to Chromium.
 * This fixture does not wire main.ts, import into dist, persist, or sync data.
 * All values are synthetic. Browser proof is limited to these tested paths.
 */
test.beforeEach(async ({ page }) => {
  await page.goto('/tests/browser/fixtures/readback.html');
});

test('real DOM renders reviewed HTML-looking text without elements or private notes', async ({ page }) => {
  const result = await page.evaluate(async () => {
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
      value: '<script>window.__readbackXss = true</script> PUBLIC SYNTHETIC ANSWER',
      resolution: 'captured', source: 'client-statement',
      needsConfirmation: false, confirmation: null,
      note: 'SYNTHETIC PRIVATE ANSWER NOTE',
      followUp: {
        action: 'PUBLIC SYNTHETIC FOLLOW-UP',
        owner: 'SYNTHETIC PRIVATE OWNER', dueDate: '2027-01-01',
      },
    };
    const session = await known.migrateSemantic13ToKnownFact14(source);
    const review = {
      ...await readback.prepareKnownFact14ReadBackReviewForReview(session),
      entries: [{
        questionId: 'primary-goal',
        publicLabel: '<img src=x onerror="window.__readbackXss=true"> SYNTHETIC HEADING',
        reviewedValue: '<script>window.__readbackXss = true</script> PUBLIC SYNTHETIC ANSWER',
        reviewedFollowUp: 'PUBLIC SYNTHETIC FOLLOW-UP',
      }],
    };
    const root = document.querySelector('#readback-preview') as HTMLElement;
    const status = await renderer.renderReviewedKnownFact14ReadBackForReview(root, session, review);
    return {
      status,
      text: root.textContent,
      html: root.innerHTML,
      injectedElements: root.querySelectorAll('img,script,iframe,object').length,
      executed: Boolean((window as Window & { __readbackXss?: boolean }).__readbackXss),
      items: root.querySelectorAll('ol > li').length,
      headings: root.querySelectorAll('h2,h3').length,
    };
  });
  expect(result.status).toBe('rendered');
  expect(result.text).toContain('<img src=x onerror=');
  expect(result.text).toContain('<script>window.__readbackXss = true</script>');
  expect(result.text).toContain('PUBLIC SYNTHETIC FOLLOW-UP');
  expect(result.html).toContain('&lt;img');
  expect(result.html).toContain('&lt;script&gt;');
  expect(result.injectedElements).toBe(0);
  expect(result.executed).toBe(false);
  expect(result.items).toBe(1);
  expect(result.headings).toBe(2);
  for (const privateText of [
    'SYNTHETIC PRIVATE CLIENT',
    'SYNTHETIC PRIVATE INTERVIEWER',
    'SYNTHETIC PRIVATE RUNNING NOTES',
    'SYNTHETIC PRIVATE ANSWER NOTE',
    'SYNTHETIC PRIVATE OWNER',
  ]) {
    expect(result.text).not.toContain(privateText);
  }

  // A real Chromium/axe smoke check; not a claim of full assistive-tech QA.
  const a11y = await new AxeBuilder({ page })
    .include('#readback-preview')
    .withTags(['wcag2a', 'wcag2aa'])
    .analyze();
  expect(a11y.violations.filter(v => v.impact === 'critical' || v.impact === 'serious'))
    .toEqual([]);
});

test('real DOM rejection gives a generic, non-sensitive notice', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const [pack, semantic, known, renderer] = await Promise.all([
      '/src/pack.ts', '/src/semantic-session.ts',
      '/src/known-fact-session.ts', '/src/client-readback-render-14.ts',
    ].map(load));
    const source = await semantic.createSemanticSession(pack.generalDiscoveryPack, {
      clientLabel: 'SYNTHETIC PRIVATE CLIENT',
    }, new Date('2026-11-05T12:00:00.000Z'));
    const session = await known.migrateSemantic13ToKnownFact14(source);
    const root = document.querySelector('#readback-preview') as HTMLElement;
    let rejected = false;
    try {
      await renderer.renderReviewedKnownFact14ReadBackForReview(root, session, {
        expectedRevisionId: 'SYNTHETIC PRIVATE STALE REVISION', entries: [],
      });
    } catch {
      rejected = true;
    }
    const errorText = root.textContent;
    return { rejected, errorText, noticeParagraphs: root.querySelectorAll('p').length };
  });
  expect(result.rejected).toBe(true);
  expect(result.errorText).toBe('Read-back unavailable. Review the current session before presenting.');
  expect(result.errorText).not.toContain('SYNTHETIC PRIVATE');
  expect(result.noticeParagraphs).toBe(1);
});

test('real DOM clears a previous approved preview when a later review is stale', async ({ page }) => {
  const result = await page.evaluate(async () => {
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
      value: 'SYNTHETIC APPROVED ANSWER',
      resolution: 'captured', source: 'client-statement',
      needsConfirmation: false, confirmation: null,
      note: 'SYNTHETIC PRIVATE NOTE', followUp: null,
    };
    const session = await known.migrateSemantic13ToKnownFact14(source);
    const root = document.querySelector('#readback-preview') as HTMLElement;
    const validReview = {
      ...await readback.prepareKnownFact14ReadBackReviewForReview(session),
      entries: [{ questionId: 'primary-goal', publicLabel: 'SYNTHETIC REVIEWED HEADING',
        reviewedValue: 'SYNTHETIC APPROVED ANSWER' }],
    };
    const firstStatus = await renderer.renderReviewedKnownFact14ReadBackForReview(
      root, session, validReview);
    const firstText = root.textContent ?? '';
    let rejected = false;
    try {
      await renderer.renderReviewedKnownFact14ReadBackForReview(root, session, {
        expectedRevisionId: 'SYNTHETIC PRIVATE STALE ID', entries: [],
      });
    } catch {
      rejected = true;
    }
    return { firstStatus, firstText, rejected, finalText: root.textContent,
      itemCount: root.querySelectorAll('ol > li').length,
      noticeCount: root.querySelectorAll('p').length };
  });
  expect(result.firstStatus).toBe('rendered');
  expect(result.firstText).toContain('SYNTHETIC APPROVED ANSWER');
  expect(result.rejected).toBe(true);
  expect(result.finalText).toBe('Read-back unavailable. Review the current session before presenting.');
  expect(result.finalText).not.toContain('SYNTHETIC REVIEWED HEADING');
  expect(result.finalText).not.toContain('SYNTHETIC APPROVED ANSWER');
  expect(result.finalText).not.toContain('SYNTHETIC PRIVATE STALE ID');
  expect(result.itemCount).toBe(0);
  expect(result.noticeCount).toBe(1);
});

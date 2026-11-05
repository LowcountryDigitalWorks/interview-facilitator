import { describe, expect, it } from 'vitest';
import { renderReviewedKnownFact14ReadBackForReview } from '../src/client-readback-render-14';
import { prepareKnownFact14ReadBackReviewForReview } from '../src/client-readback-14';
import { migrateSemantic13ToKnownFact14 } from '../src/known-fact-session';
import { createSemanticSession } from '../src/semantic-session';
import { generalDiscoveryPack } from '../src/pack';

const AT = '2026-11-05T00:00:00.000Z';

// A DOM-shaped test double makes any innerHTML insertion fail explicitly.
// Actual browser integration is a separate acceptance gate, not claimed here.
class TextNode {
  readonly children: TextNode[] = [];
  textContent = '';
  constructor(readonly tag: string, readonly ownerDocument: FakeDocument) {}
  appendChild(child: TextNode): void { this.children.push(child); }
  replaceChildren(...nodes: TextNode[]): void { this.children.splice(0, this.children.length, ...nodes); }
  set innerHTML(_value: string) { throw new Error('Unsafe innerHTML was used.'); }
}
class FakeDocument {
  createElement(tag: string): TextNode { return new TextNode(tag, this); }
  createDocumentFragment(): TextNode { return new TextNode('#fragment', this); }
}
function root() {
  const doc = new FakeDocument();
  return doc.createElement('section');
}
function nodes(root: TextNode): TextNode[] {
  return [root, ...root.children.flatMap(nodes)];
}
function visible(root: TextNode) {
  return nodes(root).map(node => node.textContent).filter(Boolean).join(' | ');
}
async function fixture() {
  const session = await createSemanticSession(generalDiscoveryPack,
    { clientLabel: 'PRIVATE CLIENT', interviewerLabel: 'PRIVATE INTERVIEWER' }, new Date(AT));
  session.runningNotes = 'PRIVATE RUNNING NOTES';
  session.answers['primary-goal'] = {
    value: '<script>alert(1)</script> SYNTHETIC PUBLIC VALUE', resolution: 'captured',
    source: 'client-statement', needsConfirmation: false, confirmation: null,
    note: 'PRIVATE NOTE', followUp: { action: '<b>Discuss deadline</b>',
      owner: 'PRIVATE OWNER', dueDate: '2027-01-01' },
  };
  session.answers['booking-process'] = {
    value: 'PRIVATE HIDDEN ANSWER', resolution: 'captured', source: 'client-statement',
    needsConfirmation: false, confirmation: null,
    followUp: null, note: 'PRIVATE HIDDEN NOTE',
  };
  return migrateSemantic13ToKnownFact14(session);
}
async function review(session: Awaited<ReturnType<typeof fixture>>, entries: unknown[]) {
  const snapshot = await prepareKnownFact14ReadBackReviewForReview(session);
  return { ...snapshot, entries };
}
function asHost(value: TextNode): HTMLElement { return value as unknown as HTMLElement; }

describe('#35E dormant textContent-only read-back renderer', () => {
  it('with empty review shows zero items and never dumps private session fields', async () => {
    const session = await fixture(), host = root(), before = structuredClone(session);
    expect(await renderReviewedKnownFact14ReadBackForReview(
      asHost(host), session, await review(session, []),
    )).toBe('rendered');
    expect(visible(host)).toContain('No items selected for disclosure.');
    expect(nodes(host).some(n => n.tag === 'li')).toBe(false);
    expect(visible(host)).not.toContain('PRIVATE');
    expect(visible(host)).not.toContain('sessionId');
    expect(session).toEqual(before);
  });

  it('renders reviewer-selected hostile free text as text, never as executable markup', async () => {
    const session = await fixture(), host = root();
    const label = '<img src=x onerror=alert(1)> Main outcome';
    await renderReviewedKnownFact14ReadBackForReview(asHost(host), session,
      await review(session, [{
        questionId: 'primary-goal', publicLabel: label,
        reviewedValue: '<script>alert(1)</script> SYNTHETIC PUBLIC VALUE',
        reviewedFollowUp: '<b>Discuss deadline</b>',
      }]));
    const text = visible(host);
    expect(text).toContain(label);
    expect(text).toContain('<script>alert(1)</script> SYNTHETIC PUBLIC VALUE');
    expect(text).toContain('Follow-up for discussion: <b>Discuss deadline</b>');
    for (const hidden of ['PRIVATE', 'sessionId', 'knownFactLedger', 'dueDate',
      'owner', 'questionId', 'accepted-known-fact', 'book time']) {
      expect(text).not.toContain(hidden);
    }
    expect(nodes(host).filter(n => n.tag === 'li')).toHaveLength(1);
    expect(nodes(host).some(n => ['script', 'img', 'b', 'a'].includes(n.tag))).toBe(false);
    expect(nodes(host).every(n => n.textContent !== undefined)).toBe(true);
  });

  it('clears a previously selected view before throwing on stale or private selections', async () => {
    const session = await fixture(), host = root();
    await renderReviewedKnownFact14ReadBackForReview(asHost(host), session,
      await review(session, [{ questionId: 'primary-goal', publicLabel: 'Goal',
        reviewedValue: '<script>alert(1)</script> SYNTHETIC PUBLIC VALUE' }]));
    expect(visible(host)).toContain('SYNTHETIC PUBLIC VALUE');
    await expect(renderReviewedKnownFact14ReadBackForReview(asHost(host), session, {
      expectedRevisionId: 'outdated', entries: [],
    })).rejects.toThrow(/stale/);
    expect(visible(host)).toBe('Read-back unavailable. Review the current session before presenting.');
    expect(visible(host)).not.toContain('SYNTHETIC PUBLIC VALUE');
    await expect(renderReviewedKnownFact14ReadBackForReview(asHost(host), session,
      await review(session, [{ questionId: 'booking-process', publicLabel: 'Booking',
        reviewedValue: 'PRIVATE HIDDEN ANSWER' }]))).rejects.toThrow(/relevant/);
    expect(visible(host)).not.toContain('PRIVATE');
  });

  it('does not expose private source error information in the failure view', async () => {
    const session = await fixture(), host = root();
    session.answers['primary-goal']!.value = 'PRIVATE MALFORMED';
    await expect(renderReviewedKnownFact14ReadBackForReview(asHost(host), session,
      await review(session, [{ questionId: 'primary-goal', publicLabel: 'Goal',
        reviewedValue: 'stale' }]))).rejects.toThrow(/differs/);
    expect(visible(host)).not.toContain('PRIVATE');
    expect(visible(host)).not.toContain('stale');
  });

  it('does not revive a superseded selection when concurrent renders race', async () => {
    const session = await fixture(), host = root();
    const olderReview = await review(session, [{
      questionId: 'primary-goal', publicLabel: 'OLDER SELECTION',
      reviewedValue: '<script>alert(1)</script> SYNTHETIC PUBLIC VALUE',
    }]);
    const newerReview = await review(session, [{
      questionId: 'primary-goal', publicLabel: 'NEWER SELECTION',
      reviewedValue: '<script>alert(1)</script> SYNTHETIC PUBLIC VALUE',
    }]);
    // Both private snapshot commands are prepared before starting the renders.
    const older = renderReviewedKnownFact14ReadBackForReview(asHost(host), session, olderReview);
    const newer = renderReviewedKnownFact14ReadBackForReview(asHost(host), session, newerReview);
    const outcomes = await Promise.all([older, newer]);
    expect(outcomes).toEqual(['superseded', 'rendered']);
    expect(visible(host)).toContain('NEWER SELECTION');
    expect(visible(host)).not.toContain('OLDER SELECTION');
  });
  it('does not let an older rejected render overwrite the latest valid view', async () => {
    const session = await fixture(), host = root();
    const freshReview = await review(session, [{
      questionId: 'primary-goal', publicLabel: 'Valid selection',
      reviewedValue: '<script>alert(1)</script> SYNTHETIC PUBLIC VALUE',
    }]);
    const old = renderReviewedKnownFact14ReadBackForReview(asHost(host), session, {
      expectedRevisionId: 'STALE PRIVATE REVISION', entries: [],
    });
    const fresh = renderReviewedKnownFact14ReadBackForReview(asHost(host), session, freshReview);
    await expect(old).rejects.toThrow(/stale/);
    expect(await fresh).toBe('rendered');
    expect(visible(host)).toContain('Valid selection');
    expect(visible(host)).not.toContain('Read-back unavailable');
    expect(visible(host)).not.toContain('STALE PRIVATE REVISION');
  });
  it('does not accept a standalone forged projection or an invalid host', async () => {
    const host = root();
    await expect(renderReviewedKnownFact14ReadBackForReview(asHost(host),
      { kind: 'draft-client-readback-preview', entries: [{ label: 'PRIVATE' }] },
      { expectedRevisionId: 'x', entries: [] })).rejects.toThrow();
    await expect(renderReviewedKnownFact14ReadBackForReview(
      {} as HTMLElement, {}, {},
    )).rejects.toThrow(/host/);
    expect(visible(host)).not.toContain('PRIVATE');
  });
});

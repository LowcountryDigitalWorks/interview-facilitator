import { describe, expect, it } from 'vitest';
import { generalDiscoveryPack } from '../src/pack';
import { createSemanticSession } from '../src/semantic-session';
import { migrateSemantic13ToKnownFact14 } from '../src/known-fact-session';
import { canonicalizeJson } from '../src/pack-identity';
import {
  createKnownFactLifecycle14, completeKnownFactLifecycle14,
  reopenKnownFactLifecycle14, validateKnownFactLifecycle14,
} from '../src/known-fact-lifecycle-14';

describe('repeat complete and reopen', () => {
  it('accepts two reopened completions without allowing historical revision reuse', async () => {
    const old = await createSemanticSession(generalDiscoveryPack,
      { clientLabel: 'Synthetic only' }, new Date('2026-11-05T12:00:00.000Z'));
    const session = await migrateSemantic13ToKnownFact14(old);
    const draft = await createKnownFactLifecycle14(session);
    const first = await completeKnownFactLifecycle14(draft, {
      expectedRevisionId: session.revisionId, eventId: 'complete-A',
      completedAt: '2026-11-05T12:05:00.000Z', acknowledgedFollowUpQuestionIds: [],
    });
    const savedA = canonicalizeJson(first.completedRevisions[0]!.sessionSnapshot);
    const secondDraft = await reopenKnownFactLifecycle14(first, {
      expectedRevisionId: session.revisionId, eventId: 'reopen-B',
      newRevisionId: 'revision-B', reopenedAt: '2026-11-05T12:06:00.000Z',
    });
    const second = await completeKnownFactLifecycle14(secondDraft, {
      expectedRevisionId: 'revision-B', eventId: 'complete-B',
      completedAt: '2026-11-05T12:07:00.000Z', acknowledgedFollowUpQuestionIds: [],
    });
    expect(second.events.map(e => e.type)).toEqual(['completed', 'reopened', 'completed']);
    expect(canonicalizeJson(second.completedRevisions[0]!.sessionSnapshot)).toBe(savedA);
    const thirdDraft = await reopenKnownFactLifecycle14(second, {
      expectedRevisionId: 'revision-B', eventId: 'reopen-C',
      newRevisionId: 'revision-C', reopenedAt: '2026-11-05T12:08:00.000Z',
    });
    const third = await completeKnownFactLifecycle14(thirdDraft, {
      expectedRevisionId: 'revision-C', eventId: 'complete-C',
      completedAt: '2026-11-05T12:09:00.000Z', acknowledgedFollowUpQuestionIds: [],
    });
    expect(third.completedRevisions).toHaveLength(3);
    expect(await validateKnownFactLifecycle14(JSON.parse(canonicalizeJson(third)))).toEqual(third);
    await expect(reopenKnownFactLifecycle14(third, {
      expectedRevisionId: 'revision-C', eventId: 'reuse-A',
      newRevisionId: session.revisionId, reopenedAt: '2026-11-05T12:10:00.000Z',
    })).rejects.toThrow(/already exists/i);
  });
});

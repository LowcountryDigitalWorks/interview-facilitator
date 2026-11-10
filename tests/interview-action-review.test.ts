import { describe, expect, it } from 'vitest';
import { createSemanticSession } from '../src/semantic-session';
import { generalDiscoveryPack } from '../src/pack';
import { canonicalizeJson, sha256Hex } from '../src/pack-identity';
import { proposeInterviewNextStepsForReview } from '../src/interview-workflow-bridge';
import { relevanceMap } from '../src/live-session';
import {
  OPERATOR_ACTION_REVIEW_VERSION,
  stageOperatorSelectedActionsForReview,
  type OperatorActionSelection,
} from '../src/interview-action-review';

async function fixture() {
  const session = await createSemanticSession(generalDiscoveryPack, {
    clientLabel: 'SYNTHETIC ACTION REVIEW',
  }, new Date('2026-11-09T12:00:00.000Z'));
  session.runningNotes = 'SYNTHETIC PRIVATE NOTES MUST NEVER BE IN TASK DRAFT';
  session.answers['primary-goal']!.followUp = {
    action: 'SYNTHETIC FIRST REVIEW', owner: 'LDW SYNTHETIC OWNER',
    dueDate: '2026-12-08',
  };
  session.answers['must-have']!.followUp = {
    action: 'SYNTHETIC SECOND REVIEW',
  };
  session.answers['booking-process']!.followUp = {
    action: 'SYNTHETIC HIDDEN ACTION',
  };
  session.answers['needs-booking'] = {
    value: 'No', resolution: 'captured', source: 'client-statement',
    needsConfirmation: false, confirmation: null, followUp: null, note: '',
  };
  const proposals = await proposeInterviewNextStepsForReview(session);
  const selection: OperatorActionSelection = {
    schemaVersion: OPERATOR_ACTION_REVIEW_VERSION,
    engagementKey: 'synthetic-engagement-001',
    expectedSessionId: session.sessionId,
    expectedRevisionId: session.revisionId,
    expectedSessionDigest: await sha256Hex(canonicalizeJson(session)),
    expectedProposalDigest: await sha256Hex(canonicalizeJson(proposals)),
    selectedQuestionIds: ['must-have', 'primary-goal'],
    operatorSelectedForReview: true,
    reviewedAt: '2026-11-09T13:00:00.000Z',
  };
  return { session, selection };
}

describe('private operator-selected next-step staging: source-only', () => {
  it('keeps pinned question order, optional ISO date, and stable retry identity without writes', async () => {
    const { session, selection } = await fixture();
    const before = canonicalizeJson(session);
    const review = await stageOperatorSelectedActionsForReview(session, selection);
    expect(review).toMatchObject({
      schemaVersion: OPERATOR_ACTION_REVIEW_VERSION,
      kind: 'private-operator-selected-proposals-only',
      sessionId: session.sessionId, revisionId: session.revisionId,
    });
    expect(review.actions.map(x => x.questionId)).toEqual(['primary-goal', 'must-have']);
    expect(review.actions[0]).toMatchObject({
      action: 'SYNTHETIC FIRST REVIEW',
      owner: 'LDW SYNTHETIC OWNER',
      dueDate: '2026-12-08',
    });
    expect(review.actions[1]).not.toHaveProperty('dueDate');
    expect(review.notice).toContain('no client consent');
    expect(JSON.stringify(review)).not.toContain('SYNTHETIC PRIVATE NOTES');
    expect(JSON.stringify(review)).not.toContain('SYNTHETIC HIDDEN ACTION');
    expect(canonicalizeJson(session)).toBe(before);
    const laterReview = await stageOperatorSelectedActionsForReview(session, {
      ...selection, reviewedAt: '2026-11-10T09:00:00.000Z',
    });
    expect(laterReview.actions.map(x => x.retryKey)).toEqual(review.actions.map(x => x.retryKey));
    expect(review.actions[0]?.retryKey).toMatch(/^[a-f0-9]{64}$/);
  });

  it('requires explicit human choice and rejects an unsupported or forged envelope', async () => {
    const { session, selection } = await fixture();
    await expect(stageOperatorSelectedActionsForReview(session, {
      ...selection, operatorSelectedForReview: false,
    })).rejects.toThrow('Explicit operator');
    await expect(stageOperatorSelectedActionsForReview(session, {
      ...selection, selectedQuestionIds: [],
    })).rejects.toThrow('nonempty selection');
    await expect(stageOperatorSelectedActionsForReview(session, {
      ...selection, selectedQuestionIds: ['primary-goal', 'primary-goal'],
    })).rejects.toThrow('Duplicate');
    await expect(stageOperatorSelectedActionsForReview(session, {
      ...selection, payload: 'forbidden-secret',
    })).rejects.toThrow('unsupported fields');
    await expect(stageOperatorSelectedActionsForReview(session, {
      ...selection, engagementKey: 'client/../../escape',
    })).rejects.toThrow('path-safe');
    await expect(stageOperatorSelectedActionsForReview(session, {
      ...selection, reviewedAt: '2026-11-09',
    })).rejects.toThrow('canonical UTC');
  });

  it('refuses changed full canonical source even if revision ID was not incremented', async () => {
    const { session, selection } = await fixture();
    const changed = structuredClone(session);
    changed.runningNotes += ' CHANGED BEFORE APPROVAL';
    await expect(stageOperatorSelectedActionsForReview(changed, selection))
      .rejects.toThrow('contents changed');
    await expect(stageOperatorSelectedActionsForReview(session, {
      ...selection, expectedRevisionId: 'stale-revision',
    })).rejects.toThrow('stale');
    await expect(stageOperatorSelectedActionsForReview(session, {
      ...selection, expectedProposalDigest: 'f'.repeat(64),
    })).rejects.toThrow('contents changed');
  });

  it('rejects hidden and nonexistent proposals, not only malformed IDs', async () => {
    const { session, selection } = await fixture();
    for (const questionId of ['booking-process', 'needs-booking', 'unrecognized-question']) {
      await expect(stageOperatorSelectedActionsForReview(session, {
        ...selection, selectedQuestionIds: [questionId],
      })).rejects.toThrow('absent, hidden, pending');
    }
  });

  it('rejects an actual pending conditional action whose parent is unresolved', async () => {
    const { session, selection } = await fixture();
    const pending = structuredClone(session);
    pending.answers['needs-booking'] = {
      value: null, resolution: 'unresolved', source: null,
      needsConfirmation: false, confirmation: null, followUp: null, note: '',
    };
    pending.answers['booking-process']!.followUp = {
      action: 'SYNTHETIC NOT-YET-RELEVANT BOOKING ACTION',
    };
    // This is genuinely PENDING, rather than irrelevant after a captured "No".
    expect(relevanceMap(pending)['booking-process']).toBe('pending');
    const projection = await proposeInterviewNextStepsForReview(pending);
    expect(projection.items.some(x => x.questionId === 'booking-process')).toBe(false);
    const pendingSelection: OperatorActionSelection = {
      ...selection,
      expectedSessionDigest: await sha256Hex(canonicalizeJson(pending)),
      expectedProposalDigest: await sha256Hex(canonicalizeJson(projection)),
      selectedQuestionIds: ['booking-process'],
    };
    await expect(stageOperatorSelectedActionsForReview(pending, pendingSelection))
      .rejects.toThrow('absent, hidden, pending');
    // Selecting the invalid action must not alter the original private draft.
    expect(pending.answers['booking-process']!.followUp?.action)
      .toBe('SYNTHETIC NOT-YET-RELEVANT BOOKING ACTION');
  });

  it('refuses noncanonical or impossible due dates without changing the local proposal', async () => {
    const { session } = await fixture();
    for (const invalidDate of ['soon', '2026-02-30', '2026-2-9']) {
      const changed = structuredClone(session);
      changed.answers['primary-goal']!.followUp!.dueDate = invalidDate;
      const proposals = await proposeInterviewNextStepsForReview(changed);
      const selection: OperatorActionSelection = {
        schemaVersion: OPERATOR_ACTION_REVIEW_VERSION,
        engagementKey: 'synthetic-engagement-001',
        expectedSessionId: changed.sessionId, expectedRevisionId: changed.revisionId,
        expectedSessionDigest: await sha256Hex(canonicalizeJson(changed)),
        expectedProposalDigest: await sha256Hex(canonicalizeJson(proposals)),
        selectedQuestionIds: ['primary-goal'],
        operatorSelectedForReview: true,
        reviewedAt: '2026-11-09T13:00:00.000Z',
      };
      await expect(stageOperatorSelectedActionsForReview(changed, selection))
        .rejects.toThrow('due date');
      expect(changed.answers['primary-goal']!.followUp!.dueDate).toBe(invalidDate);
    }
  });

  it('requires a bounded nonblank owner for selected downstream action', async () => {
    const { session } = await fixture();
    const changed = structuredClone(session);
    changed.answers['primary-goal']!.followUp!.owner = ' ';
    const proposals = await proposeInterviewNextStepsForReview(changed);
    const selection = {
      schemaVersion: OPERATOR_ACTION_REVIEW_VERSION,
      engagementKey: 'synthetic-engagement-001',
      expectedSessionId: changed.sessionId, expectedRevisionId: changed.revisionId,
      expectedSessionDigest: await sha256Hex(canonicalizeJson(changed)),
      expectedProposalDigest: await sha256Hex(canonicalizeJson(proposals)),
      selectedQuestionIds: ['primary-goal'],
      operatorSelectedForReview: true,
      reviewedAt: '2026-11-09T13:00:00.000Z',
    };
    await expect(stageOperatorSelectedActionsForReview(changed, selection))
      .rejects.toThrow('Suggested owner');
  });
});

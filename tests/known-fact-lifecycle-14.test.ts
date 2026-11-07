import { describe, expect, it } from 'vitest';
import { createSemanticSession } from '../src/semantic-session';
import { generalDiscoveryPack } from '../src/pack';
import { canonicalizeJson } from '../src/pack-identity';
import { migrateSemantic13ToKnownFact14 } from '../src/known-fact-session';
import { correctKnownFact } from '../src/known-fact-evidence';
import {
  KNOWN_FACT_LIFECYCLE_FORMAT,
  completeKnownFactLifecycle14,
  createKnownFactLifecycle14,
  recordKnownFactReadBack14,
  reopenKnownFactLifecycle14,
  validateKnownFactLifecycle14,
} from '../src/known-fact-lifecycle-14';

const AT = '2026-11-05T12:00:00.000Z';

async function draftLifecycle() {
  const semantic = await createSemanticSession(generalDiscoveryPack, {
    clientLabel: 'Synthetic lifecycle interview',
    interviewerLabel: 'Synthetic interviewer',
  }, new Date(AT));
  semantic.runningNotes = 'Synthetic note survives completion and reopen.';
  semantic.answers['primary-goal']!.followUp = {
    action: 'Confirm the sample goal.', owner: 'Synthetic interviewer', dueDate: '2026-11-12',
  };
  const session = await migrateSemantic13ToKnownFact14(semantic);
  return { session, lifecycle: await createKnownFactLifecycle14(session) };
}

describe('#34B versioned dormant Draft / Completed / reopen contract', () => {
  it('uses a separately versioned envelope and allows explicit completion without complete coverage', async () => {
    const { session, lifecycle } = await draftLifecycle();
    expect(lifecycle.format).toBe(KNOWN_FACT_LIFECYCLE_FORMAT);
    expect(lifecycle.formatVersion).toBe(1);
    expect(lifecycle.status).toBe('draft');
    const completed = await completeKnownFactLifecycle14(lifecycle, {
      expectedRevisionId: session.revisionId,
      eventId: 'complete-1',
      completedAt: '2026-11-05T12:05:00.000Z',
      acknowledgedFollowUpQuestionIds: ['primary-goal'],
    });
    expect(completed.status).toBe('completed');
    expect(completed.session.revisionId).toBe(session.revisionId);
    expect(completed.completedRevisions[0]).toMatchObject({
      revisionId: session.revisionId,
      acknowledgedFollowUpQuestionIds: ['primary-goal'],
      sessionSnapshot: session,
    });
    expect(completed.session.answers['primary-goal']!.followUp?.action).toBe('Confirm the sample goal.');
    await expect(validateKnownFactLifecycle14(JSON.parse(canonicalizeJson(completed)))).resolves.toEqual(completed);
  });

  it('rejects stale, duplicate, and unbacked follow-up acknowledgments', async () => {
    const { session, lifecycle } = await draftLifecycle();
    const base = { expectedRevisionId: session.revisionId, eventId: 'complete-1', completedAt: '2026-11-05T12:05:00.000Z' };
    await expect(completeKnownFactLifecycle14(lifecycle, { ...base, expectedRevisionId: 'old-revision', acknowledgedFollowUpQuestionIds: [] }))
      .rejects.toThrow(/stale/i);
    await expect(completeKnownFactLifecycle14(lifecycle, { ...base, acknowledgedFollowUpQuestionIds: ['missing-question'] }))
      .rejects.toThrow(/currently relevant follow-up/i);
    await expect(completeKnownFactLifecycle14(lifecycle, { ...base, acknowledgedFollowUpQuestionIds: ['primary-goal', 'primary-goal'] }))
      .rejects.toThrow(/duplicate/i);
  });

  it('records read-back without completing or confirming anything', async () => {
    const { session, lifecycle } = await draftLifecycle();
    const before = canonicalizeJson(lifecycle);
    const recorded = await recordKnownFactReadBack14(lifecycle, {
      eventId: 'readback-1', occurredAt: '2026-11-05T12:02:00.000Z',
    });
    expect(recorded.status).toBe('draft');
    expect(recorded.session.answers).toEqual(session.answers);
    expect(recorded.events.at(-1)).toMatchObject({
      type: 'read-back-recorded', revisionId: session.revisionId,
    });
    expect(canonicalizeJson(lifecycle)).toBe(before);
  });

  it('reopens as a new parent-linked Draft and preserves the exact completed revision', async () => {
    const { session, lifecycle } = await draftLifecycle();
    const completed = await completeKnownFactLifecycle14(lifecycle, {
      expectedRevisionId: session.revisionId,
      eventId: 'complete-1', completedAt: '2026-11-05T12:05:00.000Z',
      acknowledgedFollowUpQuestionIds: [],
    });
    const completedSnapshot = canonicalizeJson(completed.completedRevisions[0]!.sessionSnapshot);
    const draft = await reopenKnownFactLifecycle14(completed, {
      expectedRevisionId: session.revisionId,
      eventId: 'reopen-1', newRevisionId: 'revision-after-reopen',
      reopenedAt: '2026-11-05T12:10:00.000Z',
    });
    expect(draft.status).toBe('draft');
    expect(draft.session.revisionId).toBe('revision-after-reopen');
    expect(draft.session.parentRevisionId).toBe(session.revisionId);
    expect(draft.session.runningNotes).toBe(session.runningNotes);
    expect(draft.session.answers).toEqual(session.answers);
    expect(canonicalizeJson(draft.completedRevisions[0]!.sessionSnapshot)).toBe(completedSnapshot);
    await expect(reopenKnownFactLifecycle14(draft, {
      expectedRevisionId: draft.session.revisionId,
      eventId: 'reopen-again', newRevisionId: 'revision-3', reopenedAt: '2026-11-05T12:11:00.000Z',
    })).rejects.toThrow(/only a completed/i);
  });

  it('rejects forged reopened Draft parent and time without changing preserved completion', async () => {
    const { session, lifecycle } = await draftLifecycle();
    const completed = await completeKnownFactLifecycle14(lifecycle, {
      expectedRevisionId: session.revisionId,
      eventId: 'complete-parent-guard', completedAt: '2026-11-05T12:05:00.000Z',
      acknowledgedFollowUpQuestionIds: [],
    });
    const draft = await reopenKnownFactLifecycle14(completed, {
      expectedRevisionId: session.revisionId, eventId: 'reopen-parent-guard',
      newRevisionId: 'synthetic-next-revision', reopenedAt: '2026-11-05T12:10:00.000Z',
    });
    const retained = canonicalizeJson(draft.completedRevisions[0]!.sessionSnapshot);
    const alteredParent = structuredClone(draft);
    alteredParent.session.parentRevisionId = 'unrelated-parent';
    await expect(validateKnownFactLifecycle14(alteredParent))
      .rejects.toThrow(/reopened draft.*parent/i);
    const backdated = structuredClone(draft);
    backdated.session.updatedAt = '2026-11-05T12:06:00.000Z';
    await expect(validateKnownFactLifecycle14(backdated))
      .rejects.toThrow(/reopened draft.*reopen time/i);
    expect(canonicalizeJson(draft.completedRevisions[0]!.sessionSnapshot)).toBe(retained);
    await expect(validateKnownFactLifecycle14(draft)).resolves.toEqual(draft);
  });

  it('rejects forged completed-reopen lineage and immutable pinned interview identity', async () => {
    const { session, lifecycle } = await draftLifecycle();
    const first = await completeKnownFactLifecycle14(lifecycle, {
      expectedRevisionId: session.revisionId,
      eventId: 'complete-original', completedAt: '2026-11-05T12:05:00.000Z',
      acknowledgedFollowUpQuestionIds: [],
    });
    const reopened = await reopenKnownFactLifecycle14(first, {
      expectedRevisionId: session.revisionId, eventId: 'reopen-next',
      newRevisionId: 'synthetic-second-completion', reopenedAt: '2026-11-05T12:10:00.000Z',
    });
    const second = await completeKnownFactLifecycle14(reopened, {
      expectedRevisionId: 'synthetic-second-completion',
      eventId: 'complete-again', completedAt: '2026-11-05T12:12:00.000Z',
      acknowledgedFollowUpQuestionIds: [],
    });
    const wrongParent = structuredClone(second);
    wrongParent.session.parentRevisionId = 'unrelated-parent';
    wrongParent.completedRevisions[1]!.sessionSnapshot.parentRevisionId = 'unrelated-parent';
    await expect(validateKnownFactLifecycle14(wrongParent))
      .rejects.toThrow(/completed reopened revision.*parent/i);

    // The individual session snapshots remain valid, but the lifecycle is not:
    // a later completion cannot claim a different creation identity.
    const changedOrigin = structuredClone(second);
    changedOrigin.session.createdAt = '2026-11-05T11:00:00.000Z';
    changedOrigin.completedRevisions[1]!.sessionSnapshot.createdAt = '2026-11-05T11:00:00.000Z';
    await expect(validateKnownFactLifecycle14(changedOrigin))
      .rejects.toThrow(/immutable pinned interview identity/i);
    await expect(validateKnownFactLifecycle14(second)).resolves.toEqual(second);
  });

  it('rejects removal of independently valid correction evidence after completing and reopening', async () => {
    const { session, lifecycle } = await draftLifecycle();
    const initialFact = lifecycle.session.knownFactLedger.facts[0];
    expect(initialFact).toBeDefined();
    const source = structuredClone(lifecycle);
    source.session.knownFactLedger = correctKnownFact(source.session.knownFactLedger, {
      id: 'synthetic-corrected-fact', supersedesFactId: initialFact!.id,
      value: 'Synthetic corrected fact', provenance: 'Synthetic reviewer evidence',
      expectedRevisionId: session.revisionId, currentRevisionId: session.revisionId,
    });
    const completed = await completeKnownFactLifecycle14(source, {
      expectedRevisionId: session.revisionId, eventId: 'complete-with-correction',
      completedAt: '2026-11-05T12:05:00.000Z', acknowledgedFollowUpQuestionIds: [],
    });
    const reopened = await reopenKnownFactLifecycle14(completed, {
      expectedRevisionId: session.revisionId, eventId: 'reopen-with-correction',
      newRevisionId: 'synthetic-correction-next', reopenedAt: '2026-11-05T12:10:00.000Z',
    });
    expect(reopened.session.knownFactLedger.facts).toHaveLength(2);
    const forged = structuredClone(reopened);
    forged.session.knownFactLedger.facts.pop();
    await expect(validateKnownFactLifecycle14(forged))
      .rejects.toThrow(/append-only known-fact provenance/i);
    await expect(validateKnownFactLifecycle14(reopened)).resolves.toEqual(reopened);
    expect(completed.completedRevisions[0]!.sessionSnapshot.knownFactLedger.facts).toHaveLength(2);
  });

  it('rejects completion and read-back timestamps earlier than captured source evidence', async () => {
    const { session, lifecycle } = await draftLifecycle();
    const prior = '2026-11-05T11:59:59.999Z';
    await expect(completeKnownFactLifecycle14(lifecycle, {
      expectedRevisionId: session.revisionId, eventId: 'backdated-complete',
      completedAt: prior, acknowledgedFollowUpQuestionIds: [],
    })).rejects.toThrow(/predate.*source/i);
    await expect(recordKnownFactReadBack14(lifecycle, {
      eventId: 'backdated-readback', occurredAt: prior,
    })).rejects.toThrow(/predate.*source/i);
    expect(lifecycle.events).toEqual([]);
    expect(lifecycle.status).toBe('draft');
  });

  it('rejects restored completed snapshots backdated before the captured revision', async () => {
    const { session, lifecycle } = await draftLifecycle();
    const completed = await completeKnownFactLifecycle14(lifecycle, {
      expectedRevisionId: session.revisionId,
      eventId: 'completion-true-date',
      completedAt: '2026-11-05T12:05:00.000Z',
      acknowledgedFollowUpQuestionIds: [],
    });
    const forged = structuredClone(completed);
    forged.events[0]!.occurredAt = '2026-11-05T11:59:59.999Z';
    forged.completedRevisions[0]!.completedAt = '2026-11-05T11:59:59.999Z';
    await expect(validateKnownFactLifecycle14(forged))
      .rejects.toThrow(/predate.*source/i);
  });

  it('rejects oversized lifecycle event and completed-revision history before replay', async () => {
    const { lifecycle } = await draftLifecycle();
    await expect(validateKnownFactLifecycle14({
      ...lifecycle, events: Array.from({ length: 2001 }, () => ({})),
    })).rejects.toThrow(/bounded/i);
    await expect(validateKnownFactLifecycle14({
      ...lifecycle, completedRevisions: Array.from({ length: 501 }, () => ({})),
    })).rejects.toThrow(/bounded/i);
    expect(lifecycle.events).toEqual([]);
    expect(lifecycle.completedRevisions).toEqual([]);
  });

  it('fails closed on unsupported envelope versions and forged completion history', async () => {
    const { session, lifecycle } = await draftLifecycle();
    await expect(validateKnownFactLifecycle14({ ...lifecycle, formatVersion: 2 })).rejects.toThrow(/unsupported lifecycle format/i);
    const completed = await completeKnownFactLifecycle14(lifecycle, {
      expectedRevisionId: session.revisionId, eventId: 'complete-1',
      completedAt: '2026-11-05T12:05:00.000Z', acknowledgedFollowUpQuestionIds: [],
    });
    const forged = structuredClone(completed);
    forged.completedRevisions[0]!.sessionSnapshot.runningNotes = 'forged';
    await expect(validateKnownFactLifecycle14(forged)).rejects.toThrow();
  });
});

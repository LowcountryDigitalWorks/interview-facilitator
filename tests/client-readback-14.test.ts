import { describe, expect, it } from 'vitest';
import { projectReviewedKnownFact14ReadBackForReview as projectRaw, prepareKnownFact14ReadBackReviewForReview } from '../src/client-readback-14';
import { migrateSemantic13ToKnownFact14 } from '../src/known-fact-session';
import { generalDiscoveryPack } from '../src/pack';
import { createSemanticSession } from '../src/semantic-session';

const AT = '2026-11-04T20:00:00.000Z';
async function fixture() {
  const source = await createSemanticSession(generalDiscoveryPack,
    { clientLabel: 'PRIVATE SYNTHETIC CLIENT', interviewerLabel: 'PRIVATE INTERVIEWER' }, new Date(AT));
  source.runningNotes = 'PRIVATE RUNNING NOTE';
  source.answers['primary-goal'] = {
    value: 'A public reviewable goal', resolution: 'captured', source: 'client-statement',
    needsConfirmation: false, confirmation: null,
    followUp: { action: 'Discuss timeline', owner: 'PRIVATE OWNER', dueDate: '2026-12-01' },
    note: 'PRIVATE QUESTION NOTE',
  };
  source.answers['booking-process'] = {
    value: 'PRIVATE RETAINED HIDDEN BOOKING', resolution: 'captured', source: 'client-statement',
    needsConfirmation: false, confirmation: null, followUp: null, note: 'PRIVATE HIDDEN NOTE',
  };
  return migrateSemantic13ToKnownFact14(source);
}

// For existing fixture tests, give the projection an exact source snapshot.
async function projectReviewedKnownFact14ReadBackForReview(session: unknown, review: Record<string, unknown>) {
  const snapshot = await prepareKnownFact14ReadBackReviewForReview(session);
  return projectRaw(session, { ...review, expectedSessionDigest: snapshot.expectedSessionDigest });
}

describe('#35B explicitly reviewed 1.4 client Read-back preview', () => {
  it('defaults to zero disclosed rows and does not mutate canonical state', async () => {
    const session = await fixture();
    const before = structuredClone(session);
    const result = await projectReviewedKnownFact14ReadBackForReview(session, {
      expectedRevisionId: session.revisionId, entries: [],
    });
    expect(result.entries).toEqual([]);
    expect(result.notice).toContain('not a confirmation');
    expect(session).toEqual(before);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it('uses only reviewed public labels and current values, excluding notes, metadata, and owners', async () => {
    const session = await fixture();
    const result = await projectReviewedKnownFact14ReadBackForReview(session, {
      expectedRevisionId: session.revisionId,
      entries: [{ questionId: 'primary-goal', publicLabel: 'Main objective',
        reviewedValue: 'A public reviewable goal', reviewedFollowUp: 'Discuss timeline' }],
    });
    expect(result.entries).toEqual([{
      label: 'Main objective', value: 'A public reviewable goal',
      status: 'Current', followUp: 'Discuss timeline',
    }]);
    expect(result.revision).toMatch(/^[0-9a-f]{64}$/);
    expect(result.revision).not.toBe(session.revisionId);
    expect(result.sessionUpdatedAt).toBe(session.updatedAt);
    const json = JSON.stringify(result);
    for (const prohibited of [
      'PRIVATE', 'knownFactLedger', 'questionId', 'accepted-known-fact',
      'runningNotes', 'sourceReference', 'packSnapshot', 'dueDate', 'sessionId',
      'interviewerLabel', 'backup', 'delete',
    ]) expect(json).not.toContain(prohibited);
  });

  it('refuses stale revision, unknown, duplicate, or extra-key disclosure commands', async () => {
    const session = await fixture();
    await expect(projectReviewedKnownFact14ReadBackForReview(session, {
      expectedRevisionId: 'stale', entries: [],
    })).rejects.toThrow(/stale/i);
    await expect(projectReviewedKnownFact14ReadBackForReview(session, {
      expectedRevisionId: session.revisionId,
      entries: [{ questionId: 'unknown-id', publicLabel: 'X', reviewedValue: null }],
    })).rejects.toThrow(/unknown/i);
    const item = { questionId: 'primary-goal', publicLabel: 'Goal', reviewedValue: 'A public reviewable goal' };
    await expect(projectReviewedKnownFact14ReadBackForReview(session, {
      expectedRevisionId: session.revisionId, entries: [item, item],
    })).rejects.toThrow(/duplicate/i);
    await expect(projectReviewedKnownFact14ReadBackForReview(session, {
      expectedRevisionId: session.revisionId, entries: [], privateNotes: true,
    })).rejects.toThrow(/unsupported fields/i);
  });

  it('denies hidden/pending branches and stale or unreviewed values', async () => {
    const session = await fixture();
    await expect(projectReviewedKnownFact14ReadBackForReview(session, {
      expectedRevisionId: session.revisionId,
      entries: [{ questionId: 'booking-process', publicLabel: 'Booking',
        reviewedValue: 'PRIVATE RETAINED HIDDEN BOOKING' }],
    })).rejects.toThrow(/not currently relevant/i);
    await expect(projectReviewedKnownFact14ReadBackForReview(session, {
      expectedRevisionId: session.revisionId,
      entries: [{ questionId: 'primary-goal', publicLabel: 'Goal',
        reviewedValue: 'stale old value' }],
    })).rejects.toThrow(/differs/i);
    await expect(projectReviewedKnownFact14ReadBackForReview(session, {
      expectedRevisionId: session.revisionId,
      entries: [{ questionId: 'primary-goal', publicLabel: 'Goal' }],
    })).rejects.toThrow(/explicitly reviewed/i);
  });

  it('does not show retained values when deferred, even if the reviewer tries to release them', async () => {
    const session = await fixture();
    session.answers['primary-goal'] = {
      ...session.answers['primary-goal']!, resolution: 'deferred', needsConfirmation: false,
    };
    await expect(projectReviewedKnownFact14ReadBackForReview(session, {
      expectedRevisionId: session.revisionId,
      entries: [{ questionId: 'primary-goal', publicLabel: 'Goal',
        reviewedValue: 'A public reviewable goal' }],
    })).rejects.toThrow(/differs/i);
    const result = await projectReviewedKnownFact14ReadBackForReview(session, {
      expectedRevisionId: session.revisionId,
      entries: [{ questionId: 'primary-goal', publicLabel: 'Goal', reviewedValue: null }],
    });
    expect(result.entries).toEqual([{ label: 'Goal', value: null, status: 'Deferred' }]);
  });

  it('treats interviewer inference and legacy-unverified source as uncertainty, not agreement', async () => {
    const session = await fixture();
    session.answers['primary-goal'] = {
      ...session.answers['primary-goal']!, source: 'interviewer-inference', needsConfirmation: false,
    };
    const review = { expectedRevisionId: session.revisionId, entries: [{
      questionId: 'primary-goal', publicLabel: 'Goal', reviewedValue: 'A public reviewable goal',
    }] };
    const projected = await projectReviewedKnownFact14ReadBackForReview(session, review);
    expect(projected.entries[0]?.status).toBe('Needs confirmation');

    const old = await createSemanticSession(generalDiscoveryPack,
      { clientLabel: 'Synthetic legacy' }, new Date(AT));
    old.answers['primary-goal'] = {
      value: 'Unverified source value', resolution: 'captured', source: 'accepted-known-fact',
      needsConfirmation: true, confirmation: null, followUp: null, note: '',
    };
    const legacy = await migrateSemantic13ToKnownFact14(old);
    const result = await projectReviewedKnownFact14ReadBackForReview(legacy, {
      expectedRevisionId: legacy.revisionId,
      entries: [{ questionId: 'primary-goal', publicLabel: 'Goal', reviewedValue: 'Unverified source value' }],
    });
    expect(result.entries[0]?.status).toBe('Needs confirmation');
    expect(JSON.stringify(result)).not.toContain('legacy-unverified');
  });

  it('does not expose private follow-ups by default or without exact approval', async () => {
    const session = await fixture();
    const base = { expectedRevisionId: session.revisionId,
      entries: [{ questionId: 'primary-goal', publicLabel: 'Goal', reviewedValue: 'A public reviewable goal' }] };
    const result = await projectReviewedKnownFact14ReadBackForReview(session, base);
    expect(result.entries[0]).not.toHaveProperty('followUp');
    await expect(projectReviewedKnownFact14ReadBackForReview(session, {
      ...base, entries: [{ ...base.entries[0], reviewedFollowUp: 'PRIVATE OWNER' }],
    })).rejects.toThrow(/follow-up/i);
  });

  it('refuses malformed 1.4 records and invalid free-text labels', async () => {
    const session = await fixture();
    await expect(projectReviewedKnownFact14ReadBackForReview({
      ...session, unexpectedField: 'PRIVATE SHOULD NEVER PASS',
    }, { expectedRevisionId: session.revisionId, entries: [] })).rejects.toThrow(/unsupported field/i);
    await expect(projectReviewedKnownFact14ReadBackForReview(session, {
      expectedRevisionId: session.revisionId,
      entries: [{ questionId: 'primary-goal', publicLabel: 'Client\nSecret',
        reviewedValue: 'A public reviewable goal' }],
    })).rejects.toThrow(/single line/i);
  });

  it('rejects same-revision source/status mutations against the reviewed SHA-256 snapshot', async () => {
    const session = await fixture();
    const snapshot = await prepareKnownFact14ReadBackReviewForReview(session);
    const review = { ...snapshot, entries: [{
      questionId: 'primary-goal', publicLabel: 'Goal', reviewedValue: 'A public reviewable goal',
    }] };
    expect((await projectRaw(session, review)).entries[0]?.status).toBe('Current');
    // Simulate a buggy storage layer mutating confirmation truth without bumping revision.
    session.answers['primary-goal']!.needsConfirmation = true;
    await expect(projectRaw(session, review)).rejects.toThrow(/snapshot changed/i);
    session.answers['primary-goal']!.needsConfirmation = false;
    session.runningNotes = 'PRIVATE UPDATED WITHOUT REVISION';
    await expect(projectRaw(session, review)).rejects.toThrow(/snapshot changed/i);
    await expect(projectRaw(session, {
      expectedRevisionId: session.revisionId, entries: review.entries,
    })).rejects.toThrow(/snapshot/i);
  });

  it('does not release data from a changing getter or expose the private review digest', async () => {
    const session = await fixture();
    const snapshot = await prepareKnownFact14ReadBackReviewForReview(session);
    let reads = 0;
    const entry = {
      questionId: 'primary-goal', publicLabel: 'Goal', reviewedValue: 'A public reviewable goal',
      get reviewedFollowUp() {
        reads += 1;
        return reads === 1 ? 'Discuss timeline' : 'PRIVATE GETTER PAYLOAD';
      },
    };
    const result = await projectRaw(session, { ...snapshot, entries: [entry] });
    expect(reads).toBe(1);
    expect(result.entries[0]?.followUp).toBe('Discuss timeline');
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(JSON.stringify(result)).not.toContain(snapshot.expectedSessionDigest);
  });

  it('rejects bidi and invisible public labels and bounds the label length', async () => {
    const session = await fixture();
    for (const label of ['Goal' + String.fromCharCode(0x202e), 'Goal' + String.fromCharCode(0x85),
      'Goal' + String.fromCharCode(0x200b), 'X'.repeat(121)]) {
      await expect(projectReviewedKnownFact14ReadBackForReview(session, {
        expectedRevisionId: session.revisionId,
        entries: [{ questionId: 'primary-goal', publicLabel: label,
          reviewedValue: 'A public reviewable goal' }],
      })).rejects.toThrow(/short single line/i);
    }
  });

  it('uses an opaque output revision for migrated lineage even with zero selected rows', async () => {
    const session = await fixture();
    const preview = await projectReviewedKnownFact14ReadBackForReview(session, {
      expectedRevisionId: session.revisionId, entries: [],
    });
    expect(preview.revision).toMatch(/^[0-9a-f]{64}$/);
    expect(preview.revision).not.toContain('migration:');
    expect(JSON.stringify(preview)).not.toContain(session.revisionId);
    expect(preview.entries).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { generalDiscoveryPack } from '../src/pack';
import { canonicalizeJson, sha256Hex } from '../src/pack-identity';
import { createSemanticSession, validateSemanticSessionRecord } from '../src/semantic-session';
import { projectSemanticReadBack } from '../src/presentation';
import { semanticSessionToMarkdown, serializeSession } from '../src/markdown';
import {
  INTERVIEW_PREP_PACKET_VERSION,
  prepareInterviewCandidateReviewForReview,
  projectOwnerInterviewPreparationForReview,
  proposeInterviewNextStepsForReview,
  type InterviewPrepPacket,
} from '../src/interview-workflow-bridge';
import {
  PREP_REVIEW_SELECTION_VERSION, type PrivatePrepSelectionForReview,
} from '../src/interview-prep-review-ui-trial';
import { stageSelectedInterviewPrepForReview } from '../src/interview-prep-staging-overlay';
import {
  PREP_CONFIRMATION_TRIAL_VERSION, planClientConfirmedPrepForReview,
  commitClientConfirmedPrepForReview, type ClientConfirmationInputForReview,
} from '../src/interview-prep-confirmation-trial';

/**
 * #105 — one cross-module, source-only SYNTHETIC journey.
 * It is deliberately not connected to the live 1.3 UI, IndexedDB, a provider,
 * authenticated identity, Owner Console, or the draft PR #116/#117 artifacts.
 */
async function digest(value: unknown): Promise<string> {
  return sha256Hex(canonicalizeJson(JSON.parse(JSON.stringify(value))));
}

async function fixture() {
  const session = await createSemanticSession(generalDiscoveryPack, {
    clientLabel: 'SYNTHETIC PRIVATE CLIENT A — NEVER IN OWNER CONSOLE',
  }, new Date('2026-11-08T14:00:00.000Z'));
  session.runningNotes = 'SYNTHETIC PRIVATE INTERNAL NOTES';
  const packet: InterviewPrepPacket = {
    schemaVersion: INTERVIEW_PREP_PACKET_VERSION,
    jobKey: 'SYNTHETIC-ENGAGEMENT-A-JOB',
    sessionId: session.sessionId,
    expectedRevisionId: session.revisionId,
    expectedPackDigest: session.packIdentity.digest,
    preparedAt: '2026-11-08T14:15:00.000Z',
    candidates: [
      {
        candidateId: 'a', questionId: 'primary-goal',
        proposedValue: 'SYNTHETIC RESEARCH SUGGESTION A',
        sourceSystem: 'authorized-notes',
        sourceRecordRef: 'PRIVATE-SOURCE-A-NOT-FOR-CONSOLE',
        observedAt: '2026-11-08T13:00:00.000Z',
        confidence: 'unverified',
      },
      {
        candidateId: 'b', questionId: 'primary-goal',
        proposedValue: 'SYNTHETIC CONFLICTING SUGGESTION B',
        sourceSystem: 'client-ops',
        sourceRecordRef: 'PRIVATE-SOURCE-B-NOT-FOR-CONSOLE',
        observedAt: '2026-11-08T13:10:00.000Z',
        confidence: 'source-stated',
      },
    ],
  };
  const selection: PrivatePrepSelectionForReview = {
    schemaVersion: PREP_REVIEW_SELECTION_VERSION,
    jobKey: packet.jobKey,
    sessionId: session.sessionId,
    expectedRevisionId: session.revisionId,
    expectedPackDigest: session.packIdentity.digest,
    expectedSessionDigest: await digest(session),
    expectedPacketDigest: await digest(packet),
    selections: [{ questionId: 'primary-goal', candidateId: 'a' }],
    notice: 'Selections are proposals for client confirmation, not accepted answers or workflow actions.',
  };
  const confirmation: ClientConfirmationInputForReview = {
    schemaVersion: PREP_CONFIRMATION_TRIAL_VERSION,
    sessionId: session.sessionId,
    jobKey: packet.jobKey,
    questionId: 'primary-goal',
    candidateId: 'a',
    clientStatement: 'SYNTHETIC DIRECT CLIENT STATEMENT, NOT RESEARCH',
    confirmedAt: '2026-11-08T15:00:00.000Z',
    operatorAttestation: 'client-confirmed-in-interview',
    operatorAcknowledged: true,
  };
  return { session, packet, selection, confirmation };
}

describe('PREP-BRIDGE full synthetic human authority journey', () => {
  it('keeps research unconfirmed until a separate client statement, then projects only human-drafted private actions', async () => {
    const { session, packet, selection, confirmation } = await fixture();
    const original = canonicalizeJson(session);
    const review = await prepareInterviewCandidateReviewForReview(packet, session);
    expect(review).toMatchObject({
      kind: 'private-preparation-review',
      status: 'needs_human_review', conflictCount: 1,
    });
    const status = projectOwnerInterviewPreparationForReview(review);
    expect(status).toMatchObject({
      readiness: 'waiting_for_review',
      escalation: 'none', actionMode: 'link-only',
      launch: { available: false, href: null },
    });
    const consoleText = JSON.stringify(status);
    for (const secret of [
      session.clientLabel, session.sessionId, session.revisionId,
      packet.jobKey, packet.candidates[0]!.proposedValue,
      packet.candidates[0]!.sourceRecordRef, session.runningNotes,
    ]) expect(consoleText).not.toContain(secret);

    const overlay = await stageSelectedInterviewPrepForReview(session, packet, selection);
    expect(overlay).toMatchObject({
      kind: 'private-interviewer-only-unconfirmed',
      candidates: [{ candidateId: 'a', conflict: true }],
    });
    expect(session.answers['primary-goal']).toMatchObject({
      value: null, resolution: 'unresolved', source: null,
    });
    const question = session.packSnapshot.questions.find(q => q.id === 'primary-goal')!;
    expect(projectSemanticReadBack(question, session.answers['primary-goal']!).valueLabel)
      .toBe('No answer recorded');
    expect(semanticSessionToMarkdown(session))
      .not.toContain(packet.candidates[0]!.proposedValue);
    expect(canonicalizeJson(session)).toBe(original);
    expect((await proposeInterviewNextStepsForReview(session)).items).toEqual([]);

    const draft = await planClientConfirmedPrepForReview(session, packet, overlay, confirmation);
    expect(draft.kind).toBe('private-client-confirmation-draft-only');
    expect(draft.expectedSessionCanonical).toBe(original);
    expect(draft.proposed.parentRevisionId).toBe(session.revisionId);
    expect(draft.proposed.revisionId).not.toBe(session.revisionId);
    expect(draft.proposed.answers['primary-goal']).toMatchObject({
      value: confirmation.clientStatement, resolution: 'captured', source: 'client-statement',
    });
    expect(canonicalizeJson(session)).toBe(original);

    // Synthetic store is not a provider or app storage adapter. Its purpose
    // is to exercise the mandatory full-canonical compare-and-save boundary.
    let storedCanonical = original;
    let writes = 0;
    const store = {
      compareAndSave: async (id: string, expected: string, proposed: typeof session) => {
        if (id !== session.sessionId || storedCanonical !== expected) return null;
        storedCanonical = canonicalizeJson(proposed);
        writes++;
        return structuredClone(proposed);
      },
    };
    const committed = await commitClientConfirmedPrepForReview(
      session, packet, overlay, confirmation, store,
    );
    expect(committed.kind).toBe('saved-private-client-statement');
    if (committed.kind !== 'saved-private-client-statement') {
      throw new Error('Synthetic compare-and-save unexpectedly refused.');
    }
    const confirmed = committed.session;
    expect(writes).toBe(1);
    expect(canonicalizeJson(confirmed)).toBe(storedCanonical);
    expect(canonicalizeJson(confirmed)).not.toContain('PRIVATE-SOURCE-A-NOT-FOR-CONSOLE');
    expect(canonicalizeJson(confirmed)).not.toContain(packet.candidates[0]!.proposedValue);
    expect(projectSemanticReadBack(question, confirmed.answers['primary-goal']!).valueLabel)
      .toBe(confirmation.clientStatement);

    // Replaying the same old packet/selection is stale after confirmation.
    await expect(prepareInterviewCandidateReviewForReview(packet, confirmed))
      .rejects.toThrow('exact selected session');
    expect(await commitClientConfirmedPrepForReview(
      session, packet, overlay, confirmation, store,
    )).toEqual({ kind: 'stale-no-write' });
    expect(writes).toBe(1);

    const withAction = structuredClone(confirmed);
    withAction.answers['primary-goal']!.followUp = {
      action: 'SYNTHETIC HUMAN-DRAFTED REVIEW ACTION',
      owner: 'SYNTHETIC INTERNAL OWNER',
      dueDate: '2026-11-10',
    };
    // Keep a synthetic proposed action under an unresolved conditional parent
    // to prove it cannot be promoted into a currently relevant action.
    withAction.answers['booking-process']!.followUp = {
      action: 'SYNTHETIC PENDING ACTION NEVER TO ROUTE',
    };
    const validated = await validateSemanticSessionRecord(withAction);
    const proposed = await proposeInterviewNextStepsForReview(validated);
    expect(proposed.items).toEqual([{
      questionId: 'primary-goal',
      action: 'SYNTHETIC HUMAN-DRAFTED REVIEW ACTION',
      owner: 'SYNTHETIC INTERNAL OWNER',
      dueDate: '2026-11-10',
    }]);
    expect(JSON.stringify(proposed)).not.toContain('SYNTHETIC PENDING ACTION');
    expect(JSON.stringify(proposed)).not.toContain('SYNTHETIC PRIVATE INTERNAL NOTES');

    const restored = await validateSemanticSessionRecord(JSON.parse(serializeSession(validated)));
    expect(restored.answers).toEqual(validated.answers);
    expect(restored.runningNotes).toBe('SYNTHETIC PRIVATE INTERNAL NOTES');
    expect(semanticSessionToMarkdown(restored))
      .toContain('SYNTHETIC HUMAN-DRAFTED REVIEW ACTION');
    // Simulate a NEW private preparation snapshot after the client's
    // statement was confirmed. This is not the initial pre-commit review:
    // a source adapter would have to authorize and supply a fresh packet.
    const refreshedPacket: InterviewPrepPacket = {
      ...packet,
      expectedRevisionId: restored.revisionId,
      preparedAt: '2026-11-08T15:10:00.000Z',
      candidates: [],
    };
    const refreshedReview = await prepareInterviewCandidateReviewForReview(
      refreshedPacket, restored,
    );
    expect(refreshedReview).toMatchObject({
      status: 'no_source_evidence', questions: [], conflictCount: 0,
      revisionId: restored.revisionId,
    });
    const refreshedConsole = projectOwnerInterviewPreparationForReview(refreshedReview);
    expect(refreshedConsole).toMatchObject({
      readiness: 'unknown', readCondition: 'unknown',
      escalation: 'none', actionMode: 'link-only',
      launch: { available: false, href: null },
    });
    const afterConsole = JSON.stringify(refreshedConsole);
    for (const secret of [
      confirmation.clientStatement, 'SYNTHETIC HUMAN-DRAFTED REVIEW ACTION',
      'SYNTHETIC PENDING ACTION NEVER TO ROUTE', session.clientLabel,
      restored.sessionId, restored.revisionId, refreshedPacket.jobKey,
      session.runningNotes, packet.candidates[0]!.sourceRecordRef,
    ]) expect(afterConsole).not.toContain(secret);
  });

  it('stops altered evidence and stale full-session state without producing a confirmed draft', async () => {
    const { session, packet, selection, confirmation } = await fixture();
    const original = canonicalizeJson(session);
    const editedEvidence = structuredClone(packet);
    editedEvidence.candidates[0]!.proposedValue = 'SYNTHETIC ATTACKER ALTERED VALUE';
    await expect(stageSelectedInterviewPrepForReview(session, editedEvidence, selection))
      .rejects.toThrow('source changed');

    const overlay = await stageSelectedInterviewPrepForReview(session, packet, selection);
    const changed = structuredClone(session);
    changed.runningNotes = 'SYNTHETIC NEW OPERATOR NOTE — REVISION UNCHANGED';
    await expect(planClientConfirmedPrepForReview(changed, packet, overlay, confirmation))
      .rejects.toThrow('Source/session changed');
    await expect(planClientConfirmedPrepForReview(session, packet, overlay, {
      ...confirmation, operatorAcknowledged: false,
    })).rejects.toThrow('Explicit client-confirmed-in-interview');
    await expect(planClientConfirmedPrepForReview(session, packet, overlay, {
      ...confirmation, jobKey: 'SYNTHETIC-WRONG-ENGAGEMENT',
    })).rejects.toThrow('pinned client');
    expect(canonicalizeJson(session)).toBe(original);
    expect(session.answers['primary-goal']!.value).toBeNull();
  });
});

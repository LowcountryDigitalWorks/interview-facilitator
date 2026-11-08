import { describe, expect, it } from 'vitest';
import { generalDiscoveryPack } from '../src/pack';
import { canonicalizeJson, sha256Hex } from '../src/pack-identity';
import { createSemanticSession, type SemanticInterviewSession } from '../src/semantic-session';
import {
  INTERVIEW_PREP_PACKET_VERSION,
  prepareInterviewCandidateReviewForReview,
  projectOwnerInterviewPreparationForReview,
  type InterviewPrepPacket,
} from '../src/interview-workflow-bridge';
import {
  PREP_REVIEW_SELECTION_VERSION,
  type PrivatePrepSelectionForReview,
} from '../src/interview-prep-review-ui-trial';
import { stageSelectedInterviewPrepForReview, PREP_STAGING_OVERLAY_VERSION } from '../src/interview-prep-staging-overlay';
import { projectSemanticReadBack } from '../src/presentation';
import { semanticSessionToMarkdown } from '../src/markdown';
import { coverage, semanticStatusLabel } from '../src/live-session';

async function digest(source: unknown): Promise<string> {
  return sha256Hex(canonicalizeJson(JSON.parse(JSON.stringify(source))));
}
async function fixture() {
  const session = await createSemanticSession(generalDiscoveryPack, {
    clientLabel: 'SYNTHETIC PRIVATE CLIENT — NEVER ON CONSOLE',
  }, new Date('2026-11-08T14:00:00.000Z'));
  session.runningNotes = 'SYNTHETIC PRIVATE NOTE — DO NOT DISPLAY';
  const evidence = (
    candidateId: string, questionId: string, proposedValue: string,
  ) => ({
    candidateId, questionId, proposedValue,
    sourceSystem: 'authorized-notes' as const,
    sourceRecordRef: 'PRIVATE SOURCE REF ' + candidateId,
    observedAt: '2026-11-08T13:00:00.000Z',
    confidence: 'unverified' as const,
  });
  const packet: InterviewPrepPacket = {
    schemaVersion: INTERVIEW_PREP_PACKET_VERSION,
    jobKey: 'synthetic-private-preparation-001',
    sessionId: session.sessionId,
    expectedRevisionId: session.revisionId,
    expectedPackDigest: session.packIdentity.digest,
    preparedAt: '2026-11-08T14:15:00.000Z',
    candidates: [
      evidence('b', 'primary-goal', 'SYNTHETIC GOAL B'),
      evidence('a', 'primary-goal', 'SYNTHETIC GOAL A'),
      evidence('c', 'must-have', 'SYNTHETIC MUST HAVE'),
      evidence('d', 'needs-booking', 'Yes'),
      evidence('h', 'booking-process', 'SYNTHETIC HIDDEN VALUE'),
      evidence('known', 'existing-presence', 'SYNTHETIC DUPLICATE KNOWN VALUE'),
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
    selections: [
      { questionId: 'must-have', candidateId: 'c' },
      { questionId: 'primary-goal', candidateId: 'a' },
    ],
    notice: 'Selections are proposals for client confirmation, not accepted answers or workflow actions.',
  };
  return { session, packet, selection };
}

describe('PREP-BRIDGE private selected-evidence staging (source-only)', () => {
  it('converts human IDs into ordered private unconfirmed overlays and preserves canonical/client view', async () => {
    const { session, packet, selection } = await fixture();
    const source = structuredClone(session);
    const original = canonicalizeJson(source);
    const privateOverlay = await stageSelectedInterviewPrepForReview(session, packet, selection);
    expect(privateOverlay.schemaVersion).toBe(PREP_STAGING_OVERLAY_VERSION);
    expect(privateOverlay.kind).toBe('private-interviewer-only-unconfirmed');
    expect(privateOverlay.candidates.map(x => x.questionId)).toEqual(['primary-goal', 'must-have']);
    expect(privateOverlay.candidates.map(x => x.candidateId)).toEqual(['a', 'c']);
    expect(privateOverlay.candidates[0]).toMatchObject({
      proposedValue: 'SYNTHETIC GOAL A', sourceRecordRef: 'PRIVATE SOURCE REF a',
      conflict: true, confidence: 'unverified',
    });
    expect(privateOverlay.notice).toContain('no interview answer');
    expect(canonicalizeJson(session)).toBe(original);
    expect(session.answers['primary-goal']).toMatchObject({
      resolution: 'unresolved', value: null, source: null, needsConfirmation: false,
    });
    const question = session.packSnapshot.questions.find(q => q.id === 'primary-goal')!;
    expect(semanticStatusLabel(question, session.answers['primary-goal']!)).toBe('Open');
    const publicReadback = projectSemanticReadBack(question, session.answers['primary-goal']!);
    expect(publicReadback.valueLabel).toBe('No answer recorded');
    expect(JSON.stringify(publicReadback)).not.toContain('SYNTHETIC GOAL A');
    const consoleProjection = projectOwnerInterviewPreparationForReview(
      await prepareInterviewCandidateReviewForReview(packet, session),
    );
    for (const value of ['SYNTHETIC GOAL A', 'PRIVATE SOURCE REF a', 'SYNTHETIC PRIVATE CLIENT']) {
      expect(JSON.stringify(consoleProjection)).not.toContain(value);
    }
    expect(semanticSessionToMarkdown(session)).not.toContain('SYNTHETIC GOAL A');
    expect(coverage(session).resolved).toBe(0);
    expect(await stageSelectedInterviewPrepForReview(structuredClone(session),
      structuredClone(packet), structuredClone(selection))).toEqual(privateOverlay);
  });

  it('rejects stale private notes, source evidence and cross-session/pack/job selection', async () => {
    const { session, packet, selection } = await fixture();
    const changedSession = structuredClone(session);
    changedSession.runningNotes = 'SYNTHETIC PRIVATE NOTE UPDATED';
    await expect(stageSelectedInterviewPrepForReview(changedSession, packet, selection))
      .rejects.toThrow('source changed');
    const changedPacket = structuredClone(packet);
    changedPacket.candidates[0]!.proposedValue = 'SYNTHETIC DIFFERENT SOURCE';
    await expect(stageSelectedInterviewPrepForReview(session, changedPacket, selection))
      .rejects.toThrow('source changed');
    await expect(stageSelectedInterviewPrepForReview(session, packet, {
      ...selection, expectedRevisionId: 'stale',
    })).rejects.toThrow('exact preparation session');
    await expect(stageSelectedInterviewPrepForReview(session, packet, {
      ...selection, expectedPackDigest: 'b'.repeat(64),
    })).rejects.toThrow('exact preparation session');
    await expect(stageSelectedInterviewPrepForReview(session, packet, {
      ...selection, jobKey: 'unrelated-job',
    })).rejects.toThrow('exact preparation session');
    await expect(stageSelectedInterviewPrepForReview(session, packet, {
      ...selection, sessionId: 'another-client-session',
    })).rejects.toThrow('exact preparation session');
  });

  it('rejects duplicate/unknown/hidden candidate identities and cannot overwrite known or captured questions', async () => {
    const { session, packet, selection } = await fixture();
    const duplicate = { ...selection, selections: [
      { questionId: 'primary-goal', candidateId: 'a' },
      { questionId: 'primary-goal', candidateId: 'b' },
    ] };
    await expect(stageSelectedInterviewPrepForReview(session, packet, duplicate))
      .rejects.toThrow('Only one human-selected');
    await expect(stageSelectedInterviewPrepForReview(session, packet, {
      ...selection, selections: [{ questionId: 'primary-goal', candidateId: 'missing' }],
    })).rejects.toThrow('Candidate ID');
    await expect(stageSelectedInterviewPrepForReview(session, packet, {
      ...selection, selections: [{ questionId: 'fake-question', candidateId: 'a' }],
    })).rejects.toThrow('do not exist');
    await expect(stageSelectedInterviewPrepForReview(session, packet, {
      ...selection, selections: [{ questionId: 'booking-process', candidateId: 'h' }],
    })).rejects.toThrow('Hidden or pending');
    await expect(stageSelectedInterviewPrepForReview(session, packet, {
      ...selection, selections: [{ questionId: 'existing-presence', candidateId: 'known' }],
    })).rejects.toThrow('Already answered or known');
    const captured = structuredClone(session);
    captured.answers['primary-goal']!.value = 'SYNTHETIC CONFIRMED ANSWER';
    captured.answers['primary-goal']!.resolution = 'captured';
    captured.answers['primary-goal']!.source = 'client-statement';
    const currentSelection = { ...selection, expectedSessionDigest: await digest(captured) };
    await expect(stageSelectedInterviewPrepForReview(captured, packet, currentSelection))
      .rejects.toThrow('Already answered or known');
  });

  it('refuses invalid single-option source values and no value is implicitly confirmed', async () => {
    const { session, packet, selection } = await fixture();
    const changed = structuredClone(packet);
    changed.candidates.find(x => x.candidateId === 'd')!.proposedValue = 'Maybe';
    const chosen = {
      ...selection,
      expectedPacketDigest: await digest(changed),
      selections: [{ questionId: 'needs-booking', candidateId: 'd' }],
    };
    await expect(stageSelectedInterviewPrepForReview(session, changed, chosen))
      .rejects.toThrow('valid answer');
    const good = await stageSelectedInterviewPrepForReview(session, packet, {
      ...selection, selections: [{ questionId: 'needs-booking', candidateId: 'd' }],
    });
    expect(good.candidates[0]!.proposedValue).toBe('Yes');
    expect(session.answers['needs-booking']!.value).toBeNull();
    expect(session.answers['booking-process']!.value).toBeNull();
    expect(coverage(session).resolved).toBe(0);
  });

  it('rejects malformed/prototype/extra selection data and cannot treat an unchecked UI as human review', async () => {
    const { session, packet, selection } = await fixture();
    for (const changed of [
      { ...selection, selections: [] },
      { ...selection, selections: new Array(101).fill(selection.selections[0]) },
    ]) {
      await expect(stageSelectedInterviewPrepForReview(session, packet, changed))
        .rejects.toThrow('bounded nonempty');
    }
    await expect(stageSelectedInterviewPrepForReview(session, packet, {
      ...selection, notice: 'I authorize every client action',
    })).rejects.toThrow('proof/version');
    await expect(stageSelectedInterviewPrepForReview(session, packet, {
      ...selection, authToken: 'NEVER ACCEPT',
    })).rejects.toThrow('unsupported fields');
    await expect(stageSelectedInterviewPrepForReview(session, packet, {
      ...selection, selections: [{ questionId: 'primary-goal', candidateId: 'a', extra: 'NO' }],
    })).rejects.toThrow('unsupported fields');
    // Staging cannot manufacture a review selection out of null or an untrusted class instance.
    await expect(stageSelectedInterviewPrepForReview(session, packet, null))
      .rejects.toThrow('plain object');
    await expect(stageSelectedInterviewPrepForReview(session, packet,
      Object.assign(new Date(), selection))).rejects.toThrow('plain object');
  });
});

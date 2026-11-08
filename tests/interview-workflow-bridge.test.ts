import { describe, expect, it } from 'vitest';
import { createSemanticSession, type SemanticInterviewSession } from '../src/semantic-session';
import { generalDiscoveryPack } from '../src/pack';
import {
  INTERVIEW_PREP_PACKET_VERSION, INTERVIEW_OWNER_STATUS_VERSION,
  INTERVIEW_NEXT_STEPS_VERSION,
  prepareInterviewCandidateReviewForReview,
  projectOwnerInterviewPreparationForReview,
  proposeInterviewNextStepsForReview,
  type InterviewPrepPacket,
} from '../src/interview-workflow-bridge';

async function fixture(): Promise<{ session: SemanticInterviewSession; packet: InterviewPrepPacket }> {
  const session = await createSemanticSession(generalDiscoveryPack, {
    clientLabel: 'SYNTHETIC PRIVATE ENGAGEMENT',
  }, new Date('2026-11-08T14:00:00.000Z'));
  session.runningNotes = 'SYNTHETIC CONFIDENTIAL NOTES NEVER IN CONSOLE';
  return {
    session,
    packet: {
      schemaVersion: INTERVIEW_PREP_PACKET_VERSION,
      jobKey: 'synthetic-prep-job-001',
      sessionId: session.sessionId,
      expectedRevisionId: session.revisionId,
      expectedPackDigest: session.packIdentity.digest,
      preparedAt: '2026-11-08T15:00:00.000Z',
      candidates: [
        {
          candidateId: 'b', questionId: 'primary-goal',
          proposedValue: 'SYNTHETIC PROPOSED GOAL B',
          sourceSystem: 'governed-drive',
          sourceRecordRef: 'PRIVATE-GOVERNED-REFERENCE-B',
          observedAt: '2026-11-08T13:00:00.000Z',
          confidence: 'unverified',
        },
        {
          candidateId: 'a', questionId: 'primary-goal',
          proposedValue: 'SYNTHETIC PROPOSED GOAL A',
          sourceSystem: 'client-ops',
          sourceRecordRef: 'PRIVATE-CRM-REFERENCE-A',
          observedAt: '2026-11-08T12:00:00.000Z',
          confidence: 'source-stated',
        },
        {
          candidateId: 'c', questionId: 'must-have',
          proposedValue: 'SYNTHETIC REQUIREMENT',
          sourceSystem: 'authorized-notes',
          sourceRecordRef: 'PRIVATE-NOTES-REFERENCE-C',
          observedAt: '2026-11-08T12:30:00.000Z',
          confidence: 'unverified',
        },
      ],
    },
  };
}

describe('PREP-BRIDGE-001 — dormant private preparation', () => {
  it('groups proposed evidence by pinned pack order, flags conflicts, never overwrites live answers', async () => {
    const { session, packet } = await fixture();
    const before = structuredClone(session);
    const plan = await prepareInterviewCandidateReviewForReview(packet, session);
    expect(plan.status).toBe('needs_human_review');
    expect(plan.kind).toBe('private-preparation-review');
    expect(plan.conflictCount).toBe(1);
    expect(plan.questions.map(q => q.questionId)).toEqual(['primary-goal', 'must-have']);
    expect(plan.questions[0]).toMatchObject({
      questionId: 'primary-goal', conflict: true,
    });
    expect(plan.questions[0]?.candidates.map(x => x.candidateId)).toEqual(['a', 'b']);
    expect(plan.warning).toContain('not verified client facts');
    expect(session).toEqual(before);
    expect(session.answers['primary-goal']).toMatchObject({
      value: null, resolution: 'unresolved', source: null,
    });
    // Provider response reordering must not change the deterministic review.
    const reversed = { ...packet, candidates: [...packet.candidates].reverse() };
    expect(await prepareInterviewCandidateReviewForReview(reversed, session)).toEqual(plan);
  });

  it('rejects mismatched session, revision and pinned pack digest, including edited source', async () => {
    const { session, packet } = await fixture();
    await expect(prepareInterviewCandidateReviewForReview({
      ...packet, sessionId: 'different-synthetic-session',
    }, session)).rejects.toThrow('exact selected session');
    await expect(prepareInterviewCandidateReviewForReview({
      ...packet, expectedRevisionId: 'outdated-review',
    }, session)).rejects.toThrow('exact selected session');
    await expect(prepareInterviewCandidateReviewForReview({
      ...packet, expectedPackDigest: 'a'.repeat(64),
    }, session)).rejects.toThrow('exact selected session');
    const newer = structuredClone(session);
    newer.revisionId = 'newer-synthetic-revision';
    await expect(prepareInterviewCandidateReviewForReview(packet, newer))
      .rejects.toThrow('exact selected session');
  });

  it('rejects duplicate evidence, out-of-pack questions, unsupported providers, and unexpected private fields', async () => {
    const { session, packet } = await fixture();
    await expect(prepareInterviewCandidateReviewForReview({
      ...packet, candidates: [...packet.candidates, packet.candidates[0]],
    }, session)).rejects.toThrow('Duplicate evidence');
    const altered = structuredClone(packet);
    altered.candidates[0]!.questionId = 'synthetic-unknown-question';
    await expect(prepareInterviewCandidateReviewForReview(altered, session))
      .rejects.toThrow('unknown pack question');
    const untrusted = structuredClone(packet);
    (untrusted.candidates[0] as unknown as Record<string, unknown>).sourceSystem = 'unapproved-scraper';
    await expect(prepareInterviewCandidateReviewForReview(untrusted, session))
      .rejects.toThrow('unsupported source');
    await expect(prepareInterviewCandidateReviewForReview({
      ...packet, credentials: 'NEVER STORE OR LOG',
    }, session)).rejects.toThrow('unsupported fields');
    await expect(prepareInterviewCandidateReviewForReview({
      ...packet, candidates: new Array(101).fill(packet.candidates[0]),
    }, session)).rejects.toThrow('bound');
    const future = structuredClone(packet);
    future.candidates[0]!.observedAt = '2026-11-08T16:00:00.000Z';
    await expect(prepareInterviewCandidateReviewForReview(future, session))
      .rejects.toThrow('postdate');
  });

  it('returns an explicit no-evidence review without promoting source absence to readiness', async () => {
    const { session, packet } = await fixture();
    const plan = await prepareInterviewCandidateReviewForReview({
      ...packet, candidates: [],
    }, session);
    expect(plan).toMatchObject({
      status: 'no_source_evidence', conflictCount: 0, questions: [],
    });
    expect(projectOwnerInterviewPreparationForReview(plan)).toMatchObject({
      schemaVersion: INTERVIEW_OWNER_STATUS_VERSION,
      readiness: 'unknown', readCondition: 'unknown',
      escalation: 'none', actionMode: 'link-only',
      launch: { available: false, href: null },
    });
  });

  it('projects ONLY generic readiness into Owner Console and does not invent a launch or owner action', async () => {
    const { session, packet } = await fixture();
    const plan = await prepareInterviewCandidateReviewForReview(packet, session);
    const owner = projectOwnerInterviewPreparationForReview(plan);
    expect(owner).toMatchObject({
      readiness: 'waiting_for_review',
      readCondition: 'waiting',
      escalation: 'none',
      launch: { available: false, href: null, reason: 'Protected launch not configured' },
    });
    const publicJson = JSON.stringify(owner);
    for (const secret of [
      'SYNTHETIC PRIVATE ENGAGEMENT', 'PRIVATE-CRM',
      'PRIVATE-GOVERNED', 'SYNTHETIC PROPOSED',
      session.sessionId, packet.jobKey, session.revisionId,
    ]) expect(publicJson).not.toContain(secret);
    expect(projectOwnerInterviewPreparationForReview(null).readiness).toBe('unknown');
  });

  it('proposes relevant human-reviewed follow-ups only; no provider tasks or hidden branches', async () => {
    const { session } = await fixture();
    session.answers['primary-goal']!.followUp = {
      action: 'SYNTHETIC REVIEW ARCHITECTURE',
      owner: 'SYNTHETIC INTERNAL TEAM',
    };
    session.answers['needs-booking'] = {
      value: 'No', resolution: 'captured', source: 'client-statement',
      needsConfirmation: false, confirmation: null, followUp: null, note: '',
    };
    // Hidden booking-process evidence must not route as an active action.
    session.answers['booking-process']!.followUp = {
      action: 'PRIVATE OUTDATED SCHEDULING TASK',
    };
    const result = await proposeInterviewNextStepsForReview(session);
    expect(result).toMatchObject({
      schemaVersion: INTERVIEW_NEXT_STEPS_VERSION,
      kind: 'private-human-review-only', sessionId: session.sessionId,
      items: [{
        questionId: 'primary-goal',
        action: 'SYNTHETIC REVIEW ARCHITECTURE',
        owner: 'SYNTHETIC INTERNAL TEAM',
      }],
    });
    expect(JSON.stringify(result)).not.toContain('PRIVATE OUTDATED');
    expect(result.notice).toContain('no task');
    expect(JSON.stringify(projectOwnerInterviewPreparationForReview(null)))
      .not.toContain('SYNTHETIC REVIEW ARCHITECTURE');
  });
});

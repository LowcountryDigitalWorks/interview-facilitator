import { describe, expect, it } from 'vitest';
import { canonicalizeJson, sha256Hex } from '../src/pack-identity';
import { generalDiscoveryPack } from '../src/pack';
import { createSemanticSession } from '../src/semantic-session';
import { projectSemanticReadBack } from '../src/presentation';
import { INTERVIEW_PREP_PACKET_VERSION } from '../src/interview-workflow-bridge';
import { PREP_REVIEW_SELECTION_VERSION } from '../src/interview-prep-review-ui-trial';
import { stageSelectedInterviewPrepForReview } from '../src/interview-prep-staging-overlay';
import {
  PREP_CONFIRMATION_TRIAL_VERSION, planClientConfirmedPrepForReview,
  commitClientConfirmedPrepForReview, type ClientConfirmationInputForReview,
} from '../src/interview-prep-confirmation-trial';

async function digest(value: unknown): Promise<string> {
  return sha256Hex(canonicalizeJson(JSON.parse(JSON.stringify(value))));
}
async function fixture() {
  const session = await createSemanticSession(generalDiscoveryPack, {
    clientLabel: 'SYNTHETIC CLIENT DATA NEVER FOR PUBLIC',
  }, new Date('2026-11-08T14:00:00.000Z'));
  session.runningNotes = 'SYNTHETIC PRIVATE INTERVIEW NOTES';
  const packet = {
    schemaVersion: INTERVIEW_PREP_PACKET_VERSION,
    jobKey: 'synthetic-preparation-job',
    sessionId: session.sessionId,
    expectedRevisionId: session.revisionId,
    expectedPackDigest: session.packIdentity.digest,
    preparedAt: '2026-11-08T14:15:00.000Z',
    candidates: [
      {
        candidateId: 'a', questionId: 'primary-goal', proposedValue: 'SYNTHETIC SOURCE SUGGESTION',
        sourceSystem: 'authorized-notes', sourceRecordRef: 'PRIVATE-REF-NO-CLIENT',
        observedAt: '2026-11-08T14:05:00.000Z', confidence: 'unverified',
      },
      {
        candidateId: 'b', questionId: 'primary-goal', proposedValue: 'SYNTHETIC CONFLICT',
        sourceSystem: 'client-ops', sourceRecordRef: 'PRIVATE-REF-OTHER',
        observedAt: '2026-11-08T14:05:00.000Z', confidence: 'source-stated',
      },
    ],
  };
  const selection = {
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
  const overlay = await stageSelectedInterviewPrepForReview(session, packet, selection);
  const input: ClientConfirmationInputForReview = {
    schemaVersion: PREP_CONFIRMATION_TRIAL_VERSION,
    sessionId: session.sessionId,
    jobKey: packet.jobKey,
    questionId: 'primary-goal',
    candidateId: 'a',
    clientStatement: 'SYNTHETIC CLIENT ACTUALLY CONFIRMED THIS',
    confirmedAt: '2026-11-08T15:00:00.000Z',
    operatorAttestation: 'client-confirmed-in-interview',
    operatorAcknowledged: true,
  };
  return { session, packet, overlay, input };
}

describe('PREP-BRIDGE human client-confirmation + atomic store contract', () => {
  it('never promotes selected source; separately typed client statement makes a new validated revision only in a draft', async () => {
    const { session, packet, overlay, input } = await fixture();
    const original = canonicalizeJson(session);
    const q = session.packSnapshot.questions.find(x => x.id === 'primary-goal')!;
    expect(projectSemanticReadBack(q, session.answers['primary-goal']!))
      .toMatchObject({ valueLabel: 'No answer recorded', statusLabel: 'Open' });
    const draft = await planClientConfirmedPrepForReview(session, packet, overlay, input);
    expect(canonicalizeJson(session)).toBe(original);
    expect(draft.expectedSessionCanonical).toBe(original);
    expect(draft.proposed.sessionId).toBe(session.sessionId);
    expect(draft.proposed.parentRevisionId).toBe(session.revisionId);
    expect(draft.proposed.revisionId).not.toBe(session.revisionId);
    expect(draft.proposed.answers['primary-goal']).toMatchObject({
      value: input.clientStatement,
      resolution: 'captured',
      source: 'client-statement',
      needsConfirmation: false,
      confirmation: null,
    });
    expect(projectSemanticReadBack(q, draft.proposed.answers['primary-goal']!).valueLabel)
      .toBe(input.clientStatement);
    expect(canonicalizeJson(draft.proposed)).not.toContain('PRIVATE-REF');
    expect(canonicalizeJson(draft.proposed)).not.toContain('SYNTHETIC SOURCE SUGGESTION');
    expect(draft.kind).toBe('private-client-confirmation-draft-only');
  });

  it('does not accept prior research as client confirmation without explicit independent human action', async () => {
    const { session, packet, overlay, input } = await fixture();
    for (const row of [
      { ...input, operatorAcknowledged: false },
      { ...input, operatorAttestation: 'source-confirmed' },
      { ...input, clientStatement: '' },
      { ...input, clientStatement: '   ' },
      { ...input, clientStatement: 'X'.repeat(2001) },
      { ...input, hiddenPassword: 'not-an-accepted-field' },
    ]) {
      await expect(planClientConfirmedPrepForReview(session, packet, overlay, row)).rejects.toThrow();
    }
    expect(session.answers['primary-goal']!.value).toBeNull();
  });

  it('refuses stale source/revision and forged overlay provenance', async () => {
    const { session, packet, overlay, input } = await fixture();
    const changed = structuredClone(session);
    changed.runningNotes = 'SYNTHETIC SOURCE CHANGED';
    await expect(planClientConfirmedPrepForReview(changed, packet, overlay, input))
      .rejects.toThrow('Source/session changed');
    await expect(planClientConfirmedPrepForReview(session, packet, overlay, {
      ...input, jobKey: 'not-this-job',
    })).rejects.toThrow('pinned client');
    const editedOverlay = structuredClone(overlay);
    editedOverlay.candidates[0]!.proposedValue = 'FORGED PRIVATE VALUE';
    await expect(planClientConfirmedPrepForReview(session, packet, editedOverlay, input))
      .rejects.toThrow('modified');
    const extra = { ...overlay, secret: 'bad' };
    await expect(planClientConfirmedPrepForReview(session, packet, extra, input))
      .rejects.toThrow('unsupported fields');
    const newer = { ...session, revisionId: 'revised-session' };
    await expect(planClientConfirmedPrepForReview(newer, packet, overlay, input))
      .rejects.toThrow();
  });

  it('refuses hidden, invalid-option, previously answered or known questions', async () => {
    const { session, packet, overlay, input } = await fixture();
    await expect(planClientConfirmedPrepForReview(session, packet, overlay, {
      ...input, candidateId: 'b',
    })).rejects.toThrow('explicitly staged');
    const captured = structuredClone(session);
    captured.answers['primary-goal']!.value = 'Already captured';
    captured.answers['primary-goal']!.resolution = 'captured';
    captured.answers['primary-goal']!.source = 'client-statement';
    await expect(planClientConfirmedPrepForReview(captured, packet, overlay, input))
      .rejects.toThrow();
    const bad = { ...input, confirmedAt: '2026-11-08T13:00:00.000Z' };
    await expect(planClientConfirmedPrepForReview(session, packet, overlay, bad))
      .rejects.toThrow('cannot precede');
  });

  it('enforces an explicit atomic compare-and-save outcome, including in-flight stale replay', async () => {
    const { session, packet, overlay, input } = await fixture();
    let stored = canonicalizeJson(session);
    let writes = 0;
    const store = {
      compareAndSave: async (_id: string, expected: string, proposed: typeof session) => {
        if (stored !== expected) return null;
        stored = canonicalizeJson(proposed);
        writes++;
        return structuredClone(proposed);
      },
    };
    const success = await commitClientConfirmedPrepForReview(session, packet, overlay, input, store);
    expect(success.kind).toBe('saved-private-client-statement');
    expect(writes).toBe(1);
    const second = await commitClientConfirmedPrepForReview(session, packet, overlay, input, store);
    expect(second).toEqual({ kind: 'stale-no-write' });
    expect(writes).toBe(1);
  });

  it('rejects an adapter claiming success with divergent content or throwing on storage failure', async () => {
    const { session, packet, overlay, input } = await fixture();
    await expect(commitClientConfirmedPrepForReview(session, packet, overlay, input, {
      compareAndSave: async (_id, _before, proposed) => ({
        ...proposed, runningNotes: 'SYNTHETIC CORRUPTION',
      }),
    })).rejects.toThrow('divergent');
    await expect(commitClientConfirmedPrepForReview(session, packet, overlay, input, {
      compareAndSave: async () => { throw new Error('storage unavailable'); },
    })).rejects.toThrow('storage unavailable');
  });

  it('never accepts malformed or inherited-property client confirmation objects', async () => {
    const { session, packet, overlay, input } = await fixture();
    await expect(planClientConfirmedPrepForReview(session, packet, overlay,
      Object.assign(new Date(), input))).rejects.toThrow('plain record');
    await expect(planClientConfirmedPrepForReview(session, packet, overlay, null))
      .rejects.toThrow('plain record');
    await expect(commitClientConfirmedPrepForReview(session, packet, overlay, input, {
      compareAndSave: undefined,
    } as never)).rejects.toThrow('trusted atomic');
  });
});

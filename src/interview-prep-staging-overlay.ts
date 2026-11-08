import { canonicalizeJson, sha256Hex } from './pack-identity';
import { isMeaningfulCaptureValue } from './coverage-semantics';
import { captureSpecForQuestion, relevanceMap } from './live-session';
import { validateSemanticSessionRecord } from './semantic-session';
import {
  prepareInterviewCandidateReviewForReview,
  type PrepEvidenceCandidate,
} from './interview-workflow-bridge';
import {
  PREP_REVIEW_SELECTION_VERSION,
  type PrivatePrepSelectionForReview,
} from './interview-prep-review-ui-trial';

/**
 * #105 — PRIVATE human-selection -> interviewer-only staging overlay.
 * Source-only SYNTHETIC proof: NO canonical answer edit, IndexedDB, provider,
 * Client Read-back, Owner Console projection, downstream action, or transport.
 *
 * The overlay contains confidential values and source references. Never pass
 * it to Owner Console, a client-facing view, a public URL, GitHub, or logs.
 */
export const PREP_STAGING_OVERLAY_VERSION = 'ldw.prep-staging-overlay.v1' as const;
export interface PrivatePrepStagedCandidate {
  questionId: string;
  candidateId: string;
  proposedValue: string;
  sourceSystem: PrepEvidenceCandidate['sourceSystem'];
  sourceRecordRef: string;
  observedAt: string;
  confidence: PrepEvidenceCandidate['confidence'];
  conflict: boolean;
}
export interface PrivatePrepStagingOverlay {
  schemaVersion: typeof PREP_STAGING_OVERLAY_VERSION;
  kind: 'private-interviewer-only-unconfirmed';
  jobKey: string;
  sessionId: string;
  revisionId: string;
  packDigest: string;
  sessionDigest: string;
  packetDigest: string;
  candidates: PrivatePrepStagedCandidate[];
  notice: 'Private proposals only; no interview answer, accepted fact, confirmation, consent, or provider write exists.';
}

const SELECTION_KEYS = [
  'schemaVersion', 'jobKey', 'sessionId', 'expectedRevisionId',
  'expectedPackDigest', 'expectedSessionDigest', 'expectedPacketDigest',
  'selections', 'notice',
];
const SELECTION_NOTICE =
  'Selections are proposals for client confirmation, not accepted answers or workflow actions.';

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(label + ' must be a plain object.');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(label + ' must be a plain object.');
  }
  return value as Record<string, unknown>;
}
function requireExactKeys(record: Record<string, unknown>, fields: readonly string[], label: string): void {
  if (Object.keys(record).length !== fields.length
    || Object.keys(record).some(key => !fields.includes(key))
    || fields.some(key => !Object.hasOwn(record, key))) {
    throw new Error(label + ' has missing or unsupported fields.');
  }
}
function verifiedSelection(raw: unknown): PrivatePrepSelectionForReview {
  const s = plainRecord(raw, 'Human selection');
  requireExactKeys(s, SELECTION_KEYS, 'Human selection');
  if (s.schemaVersion !== PREP_REVIEW_SELECTION_VERSION || s.notice !== SELECTION_NOTICE) {
    throw new Error('Human selection proof/version is unsupported.');
  }
  for (const key of ['jobKey', 'sessionId', 'expectedRevisionId', 'expectedPackDigest'] as const) {
    const v = s[key];
    if (typeof v !== 'string' || !v.trim() || v.length > 128) {
      throw new Error('Human selection identity is invalid.');
    }
  }
  for (const key of ['expectedSessionDigest', 'expectedPacketDigest'] as const) {
    if (typeof s[key] !== 'string' || !/^[a-f0-9]{64}$/.test(s[key])) {
      throw new Error('Human selection fingerprint is invalid.');
    }
  }
  if (!Array.isArray(s.selections) || s.selections.length < 1 || s.selections.length > 100) {
    throw new Error('Human selection requires a bounded nonempty candidate list.');
  }
  for (const entry of s.selections) {
    const row = plainRecord(entry, 'Selected evidence');
    requireExactKeys(row, ['questionId', 'candidateId'], 'Selected evidence');
    if (typeof row.questionId !== 'string' || !row.questionId.trim() || row.questionId.length > 128
      || typeof row.candidateId !== 'string' || !row.candidateId.trim() || row.candidateId.length > 128) {
      throw new Error('Selected candidate identity is invalid.');
    }
  }
  return s as unknown as PrivatePrepSelectionForReview;
}

async function sourceFingerprint(value: unknown): Promise<string> {
  // Use the same source meaning as the isolated #107 UI. These bytes are
  // NOT an atomic write guard or a proof of provider/client authorization.
  return sha256Hex(canonicalizeJson(JSON.parse(JSON.stringify(value))));
}

/**
 * Resolve a human-reviewed, ID-only selection to a PRIVATE overlay from
 * two *current* source readers. Strictly rejects stale source/pack/revision,
 * hidden questions, invalid option values, already-filled answers, or
 * duplicate/conflicting selection entries. Does not amend canonical truth.
 *
 * The eventual private storage integration must re-check source identity
 * and engagement authorization INSIDE its own conditional write.
 */
export async function stageSelectedInterviewPrepForReview(
  rawSession: unknown,
  rawPacket: unknown,
  rawSelection: unknown,
): Promise<PrivatePrepStagingOverlay> {
  const selected = verifiedSelection(rawSelection);
  const session = await validateSemanticSessionRecord(rawSession);
  const plan = await prepareInterviewCandidateReviewForReview(rawPacket, session);
  if (selected.sessionId !== session.sessionId
    || selected.jobKey !== plan.jobKey
    || selected.expectedRevisionId !== session.revisionId
    || selected.expectedPackDigest !== session.packIdentity.digest) {
    throw new Error('Selection does not match the exact preparation session and packet.');
  }
  const [sessionDigest, packetDigest] = await Promise.all([
    sourceFingerprint(session), sourceFingerprint(rawPacket),
  ]);
  if (selected.expectedSessionDigest !== sessionDigest
    || selected.expectedPacketDigest !== packetDigest) {
    throw new Error('Selected preparation source changed. Discard the stale selection.');
  }

  const relevance = relevanceMap(session);
  const selectedByQuestion = new Map<string, string>();
  for (const entry of selected.selections) {
    if (selectedByQuestion.has(entry.questionId)) {
      throw new Error('Only one human-selected candidate per question is supported.');
    }
    selectedByQuestion.set(entry.questionId, entry.candidateId);
  }

  const staged: PrivatePrepStagedCandidate[] = [];
  for (const question of session.packSnapshot.questions) {
    const candidateId = selectedByQuestion.get(question.id);
    if (candidateId === undefined) continue;
    if (relevance[question.id] !== 'relevant') {
      throw new Error('Hidden or pending preparation evidence cannot be staged.');
    }
    const state = session.answers[question.id];
    if (!state || state.value !== null || state.resolution !== 'unresolved'
      || state.source !== null || state.confirmation !== null
      || state.needsConfirmation || state.followUp !== null
      || session.knownFacts.some(fact => fact.questionId === question.id)) {
      throw new Error('Already answered or known question cannot be overwritten by a source proposal.');
    }
    const group = plan.questions.find(row => row.questionId === question.id);
    const candidate = group?.candidates.find(row => row.candidateId === candidateId);
    if (!candidate) throw new Error('Candidate ID does not match the current reviewed question.');
    if (!isMeaningfulCaptureValue(captureSpecForQuestion(question), candidate.proposedValue)) {
      throw new Error('Source proposal is not a valid answer for the pinned question.');
    }
    staged.push({
      questionId: question.id,
      candidateId: candidate.candidateId,
      proposedValue: candidate.proposedValue,
      sourceSystem: candidate.sourceSystem,
      sourceRecordRef: candidate.sourceRecordRef,
      observedAt: candidate.observedAt,
      confidence: candidate.confidence,
      conflict: group!.conflict,
    });
  }
  if (staged.length !== selected.selections.length) {
    throw new Error('One or more selected questions do not exist in the pinned pack.');
  }
  return {
    schemaVersion: PREP_STAGING_OVERLAY_VERSION,
    kind: 'private-interviewer-only-unconfirmed',
    jobKey: plan.jobKey,
    sessionId: session.sessionId,
    revisionId: session.revisionId,
    packDigest: session.packIdentity.digest,
    sessionDigest,
    packetDigest,
    candidates: staged,
    notice: 'Private proposals only; no interview answer, accepted fact, confirmation, consent, or provider write exists.',
  };
}

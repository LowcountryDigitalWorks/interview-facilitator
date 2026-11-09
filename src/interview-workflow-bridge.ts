import { relevanceMap } from './live-session';
import { validateSemanticSessionRecord } from './semantic-session';

/**
 * PREP-BRIDGE-001. Pure provider-neutral projections with no direct storage,
 * network, automatic answer acceptance, Owner Console mutation or downstream
 * tasks. Preparation packet + Owner Console status remain source-only contracts.
 *
 * The follow-up proposal projector is also usable by the LIVE offline PWA's
 * private export after local validation: export is NOT external task routing,
 * consent, an approved customer action or provider synchronization.
 * Confidential packet values/proposed actions must never enter public GitHub,
 * Owner Console snapshots, presentation mode or URL query strings.
 */
export const INTERVIEW_PREP_PACKET_VERSION = 'ldw.interview-prep.v1' as const;
export const INTERVIEW_OWNER_STATUS_VERSION = 'ldw.interview-owner-status.v1' as const;
export const INTERVIEW_NEXT_STEPS_VERSION = 'ldw.interview-next-steps.v1' as const;

type SourceSystem = 'client-ops' | 'governed-drive' | 'prior-interview' | 'authorized-notes' | 'manual';
type EvidenceConfidence = 'unverified' | 'source-stated';

export interface PrepEvidenceCandidate {
  candidateId: string;
  questionId: string;
  proposedValue: string;
  sourceSystem: SourceSystem;
  sourceRecordRef: string;
  observedAt: string;
  confidence: EvidenceConfidence;
}
export interface InterviewPrepPacket {
  schemaVersion: typeof INTERVIEW_PREP_PACKET_VERSION;
  jobKey: string;
  sessionId: string;
  expectedRevisionId: string;
  expectedPackDigest: string;
  preparedAt: string;
  candidates: PrepEvidenceCandidate[];
}
export interface InterviewPrepReview {
  kind: 'private-preparation-review';
  jobKey: string;
  sessionId: string;
  revisionId: string;
  status: 'no_source_evidence' | 'needs_human_review';
  /** Every value remains a candidate, NEVER an accepted client answer. */
  questions: {
    questionId: string;
    candidates: PrepEvidenceCandidate[];
    conflict: boolean;
  }[];
  conflictCount: number;
  warning: 'Preparation candidates are not verified client facts or approved answers.';
}
export interface OwnerInterviewStatus {
  schemaVersion: typeof INTERVIEW_OWNER_STATUS_VERSION;
  title: 'Interview preparation';
  /** Deliberately no client IDs, source pointers, candidate counts or values. */
  readiness: 'unknown' | 'waiting_for_review';
  readCondition: 'unknown' | 'waiting';
  escalation: 'none';
  actionMode: 'link-only';
  launch: { available: false; href: null; reason: 'Protected launch not configured' };
}
export interface InterviewNextStepProposals {
  schemaVersion: typeof INTERVIEW_NEXT_STEPS_VERSION;
  kind: 'private-human-review-only';
  sessionId: string;
  revisionId: string;
  items: { questionId: string; action: string; owner?: string; dueDate?: string }[];
  notice: 'Suggestions only; no task, commitment, quote or provider write was created.';
}

function plainRecord(raw: unknown, label: string): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(label + ' must be a plain record.');
  }
  const prototype = Object.getPrototypeOf(raw);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(label + ' must be a plain record.');
  }
  return raw as Record<string, unknown>;
}
function keys(raw: Record<string, unknown>, allowed: readonly string[], label: string): void {
  if (Object.keys(raw).some(key => !allowed.includes(key))) {
    throw new Error(label + ' includes unsupported fields.');
  }
}
function requiredString(raw: unknown, label: string, max: number): string {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > max
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(raw)) {
    throw new Error(label + ' must be bounded nonempty text.');
  }
  return raw;
}
function canonicalTime(raw: unknown, label: string): string {
  const value = requiredString(raw, label, 24);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error(label + ' must be a canonical UTC timestamp.');
  }
  return value;
}
const SYSTEMS: ReadonlySet<string> = new Set([
  'client-ops', 'governed-drive', 'prior-interview', 'authorized-notes', 'manual',
]);
const CONFIDENCE: ReadonlySet<string> = new Set(['unverified', 'source-stated']);
const PACKET_KEYS = [
  'schemaVersion', 'jobKey', 'sessionId', 'expectedRevisionId',
  'expectedPackDigest', 'preparedAt', 'candidates',
];
const EVIDENCE_KEYS = [
  'candidateId', 'questionId', 'proposedValue', 'sourceSystem',
  'sourceRecordRef', 'observedAt', 'confidence',
];

/**
 * Validate a private, already-authorized prep packet against the exact
 * pinned source session. No "last source wins" and no implicit writes.
 * A private adapter (NOT this module) must authorize each provider read and
 * client identity before constructing the packet.
 */
export async function prepareInterviewCandidateReviewForReview(
  rawPacket: unknown, rawSession: unknown,
): Promise<InterviewPrepReview> {
  const packet = plainRecord(rawPacket, 'Preparation packet');
  keys(packet, PACKET_KEYS, 'Preparation packet');
  if (packet.schemaVersion !== INTERVIEW_PREP_PACKET_VERSION) {
    throw new Error('Unsupported preparation packet version.');
  }
  const jobKey = requiredString(packet.jobKey, 'Job key', 128);
  const sessionId = requiredString(packet.sessionId, 'Session ID', 128);
  const revisionId = requiredString(packet.expectedRevisionId, 'Revision ID', 128);
  const packDigest = requiredString(packet.expectedPackDigest, 'Pack digest', 64);
  const preparedAt = canonicalTime(packet.preparedAt, 'Preparation time');
  const session = await validateSemanticSessionRecord(rawSession);
  if (session.sessionId !== sessionId || session.revisionId !== revisionId
    || session.packIdentity.digest !== packDigest) {
    throw new Error('Preparation packet does not match the exact selected session and pack.');
  }
  if (!Array.isArray(packet.candidates) || packet.candidates.length > 100) {
    throw new Error('Preparation evidence list exceeds the supported bound.');
  }

  const questionIds = new Set(session.packSnapshot.questions.map(question => question.id));
  const byQuestion = new Map<string, PrepEvidenceCandidate[]>();
  const candidateIds = new Set<string>();
  for (const [index, candidateRaw] of packet.candidates.entries()) {
    const source = plainRecord(candidateRaw, 'Evidence candidate ' + index);
    keys(source, EVIDENCE_KEYS, 'Evidence candidate');
    const candidateId = requiredString(source.candidateId, 'Candidate ID', 128);
    const questionId = requiredString(source.questionId, 'Question ID', 128);
    const proposedValue = requiredString(source.proposedValue, 'Proposed value', 2000);
    const sourceSystem = requiredString(source.sourceSystem, 'Source system', 32);
    const sourceRecordRef = requiredString(source.sourceRecordRef, 'Private source reference', 256);
    const observedAt = canonicalTime(source.observedAt, 'Observed time');
    const confidence = requiredString(source.confidence, 'Source confidence', 32);
    if (!questionIds.has(questionId)) throw new Error('Evidence references an unknown pack question.');
    if (candidateIds.has(candidateId)) throw new Error('Duplicate evidence candidate identity.');
    if (observedAt > preparedAt) throw new Error('Evidence cannot postdate its preparation packet.');
    if (!SYSTEMS.has(sourceSystem) || !CONFIDENCE.has(confidence)) {
      throw new Error('Evidence uses an unsupported source classification.');
    }
    candidateIds.add(candidateId);
    const candidate: PrepEvidenceCandidate = {
      candidateId, questionId, proposedValue,
      sourceSystem: sourceSystem as SourceSystem,
      sourceRecordRef, observedAt, confidence: confidence as EvidenceConfidence,
    };
    byQuestion.set(questionId, [...(byQuestion.get(questionId) ?? []), candidate]);
  }

  // Stable pack question order and canonical candidate ID order: deterministic
  // output for repeated/rescheduled prep with the same source evidence.
  const questions = session.packSnapshot.questions
    .filter(question => byQuestion.has(question.id))
    .map(question => {
      const candidates = byQuestion.get(question.id)!.sort(
        (a, b) => a.candidateId.localeCompare(b.candidateId, 'en'),
      );
      return {
        questionId: question.id,
        candidates,
        conflict: new Set(candidates.map(candidate => candidate.proposedValue)).size > 1,
      };
    });
  return {
    kind: 'private-preparation-review',
    jobKey, sessionId, revisionId,
    status: questions.length ? 'needs_human_review' : 'no_source_evidence',
    questions,
    conflictCount: questions.filter(question => question.conflict).length,
    warning: 'Preparation candidates are not verified client facts or approved answers.',
  };
}

/** Safe-only Owner Console projection: NO client identity, values or source refs. */
export function projectOwnerInterviewPreparationForReview(
  review: InterviewPrepReview | null,
): OwnerInterviewStatus {
  // Private review is intentionally NOT serialized into this projection.
  const waiting = review?.status === 'needs_human_review';
  return {
    schemaVersion: INTERVIEW_OWNER_STATUS_VERSION,
    title: 'Interview preparation',
    readiness: waiting ? 'waiting_for_review' : 'unknown',
    readCondition: waiting ? 'waiting' : 'unknown',
    escalation: 'none',
    actionMode: 'link-only',
    launch: {
      available: false,
      href: null,
      reason: 'Protected launch not configured',
    },
  };
}

/** Follow-ups remain private proposals; no task or provider action occurs. */
export async function proposeInterviewNextStepsForReview(
  rawSession: unknown,
): Promise<InterviewNextStepProposals> {
  const session = await validateSemanticSessionRecord(rawSession);
  const relevant = relevanceMap(session);
  const items = session.packSnapshot.questions.flatMap(question => {
    if (relevant[question.id] !== 'relevant') return [];
    const followUp = session.answers[question.id]?.followUp;
    if (!followUp) return [];
    return [{
      questionId: question.id,
      action: followUp.action,
      ...(followUp.owner !== undefined ? { owner: followUp.owner } : {}),
      ...(followUp.dueDate !== undefined ? { dueDate: followUp.dueDate } : {}),
    }];
  });
  return {
    schemaVersion: INTERVIEW_NEXT_STEPS_VERSION,
    kind: 'private-human-review-only',
    sessionId: session.sessionId,
    revisionId: session.revisionId,
    items,
    notice: 'Suggestions only; no task, commitment, quote or provider write was created.',
  };
}

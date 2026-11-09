import { canonicalizeJson, sha256Hex } from './pack-identity';
import { isMeaningfulCaptureValue } from './coverage-semantics';
import { captureSpecForQuestion, relevanceMap } from './live-session';
import {
  validateSemanticSessionRecord, type SemanticInterviewSession,
} from './semantic-session';
import { prepareInterviewCandidateReviewForReview } from './interview-workflow-bridge';
import {
  PREP_STAGING_OVERLAY_VERSION,
  type PrivatePrepStagingOverlay,
} from './interview-prep-staging-overlay';

/**
 * #105 — dormant, synthetic-only bridge to a *client-confirmed* answer.
 *
 * The #110 overlay is NEVER confirmation. This step requires a separate
 * operator-entered client statement and affirmative in-interview attestation.
 * No UI, provider, Owner Console, live PWA, or IndexedDB is activated here.
 */
export const PREP_CONFIRMATION_TRIAL_VERSION = 'ldw.prep-confirmation-trial.v1' as const;
export interface ClientConfirmationInputForReview {
  schemaVersion: typeof PREP_CONFIRMATION_TRIAL_VERSION;
  sessionId: string;
  jobKey: string;
  questionId: string;
  candidateId: string;
  /** Must be separately entered from what was actually confirmed with client. */
  clientStatement: string;
  confirmedAt: string;
  operatorAttestation: 'client-confirmed-in-interview';
  operatorAcknowledged: true;
}
export interface ClientConfirmationDraftForReview {
  kind: 'private-client-confirmation-draft-only';
  sessionId: string;
  expectedRevisionId: string;
  expectedSessionCanonical: string;
  proposed: SemanticInterviewSession;
  notice: 'Private human-attested draft. No client consent, provider write, or committed answer is implied.';
}

/**
 * The later private adapter MUST bind the caller to the authorized engagement.
 * It MUST compare the ENTIRE stored canonical session (not only revision ID)
 * and write the proposal in ONE native transaction, or return null for stale.
 * A rejected/failed transaction MUST NOT be represented as success.
 */
export interface ConfirmedPrepCompareAndSaveForReview {
  compareAndSave(
    sessionId: string, expectedCanonical: string,
    proposed: SemanticInterviewSession,
  ): Promise<SemanticInterviewSession | null>;
}
export type ClientConfirmationCommitForReview =
  | { kind: 'stale-no-write' }
  | { kind: 'saved-private-client-statement'; session: SemanticInterviewSession };

function plain(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(label + ' must be a plain record.');
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new Error(label + ' must be a plain record.');
  }
  return value as Record<string, unknown>;
}
function exact(obj: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(obj).length !== keys.length
    || keys.some(k => !Object.hasOwn(obj, k))
    || Object.keys(obj).some(k => !keys.includes(k))) {
    throw new Error(label + ' has missing or unsupported fields.');
  }
}
function nonempty(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw new Error(label + ' must be bounded nonempty text.');
  }
  return value;
}
const INPUT_FIELDS = [
  'schemaVersion', 'sessionId', 'jobKey', 'questionId', 'candidateId',
  'clientStatement', 'confirmedAt', 'operatorAttestation', 'operatorAcknowledged',
];
const OVERLAY_FIELDS = [
  'schemaVersion', 'kind', 'jobKey', 'sessionId', 'revisionId',
  'packDigest', 'sessionDigest', 'packetDigest', 'candidates', 'notice',
];
const STAGED_FIELDS = [
  'questionId', 'candidateId', 'proposedValue', 'sourceSystem',
  'sourceRecordRef', 'observedAt', 'confidence', 'conflict',
];
const OVERLAY_NOTICE =
  'Private proposals only; no interview answer, accepted fact, confirmation, consent, or provider write exists.';

function inputForReview(raw: unknown): ClientConfirmationInputForReview {
  const row = plain(raw, 'Client confirmation');
  exact(row, INPUT_FIELDS, 'Client confirmation');
  if (row.schemaVersion !== PREP_CONFIRMATION_TRIAL_VERSION
    || row.operatorAttestation !== 'client-confirmed-in-interview'
    || row.operatorAcknowledged !== true) {
    throw new Error('Explicit client-confirmed-in-interview operator attestation is required.');
  }
  for (const key of ['sessionId', 'jobKey', 'questionId', 'candidateId'] as const) {
    nonempty(row[key], key, 128);
  }
  nonempty(row.clientStatement, 'Client-confirmed statement', 2000);
  const time = nonempty(row.confirmedAt, 'Confirmation time', 24);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(time)
    || !Number.isFinite(Date.parse(time)) || new Date(time).toISOString() !== time) {
    throw new Error('Confirmation time must be canonical UTC.');
  }
  return row as unknown as ClientConfirmationInputForReview;
}
function overlayForReview(raw: unknown): PrivatePrepStagingOverlay {
  const obj = plain(raw, 'Private overlay');
  exact(obj, OVERLAY_FIELDS, 'Private overlay');
  if (obj.schemaVersion !== PREP_STAGING_OVERLAY_VERSION
    || obj.kind !== 'private-interviewer-only-unconfirmed'
    || obj.notice !== OVERLAY_NOTICE) {
    throw new Error('Only the unconfirmed private overlay is supported.');
  }
  for (const key of ['jobKey', 'sessionId', 'revisionId'] as const) nonempty(obj[key], key, 128);
  for (const key of ['packDigest', 'sessionDigest', 'packetDigest'] as const) {
    if (typeof obj[key] !== 'string' || !/^[0-9a-f]{64}$/.test(obj[key])) {
      throw new Error('Private overlay fingerprint is invalid.');
    }
  }
  if (!Array.isArray(obj.candidates) || !obj.candidates.length || obj.candidates.length > 100) {
    throw new Error('Private overlay requires bounded candidates.');
  }
  for (const entry of obj.candidates) {
    const row = plain(entry, 'Staged candidate');
    exact(row, STAGED_FIELDS, 'Staged candidate');
    for (const k of ['questionId', 'candidateId', 'proposedValue', 'sourceSystem', 'sourceRecordRef',
      'observedAt', 'confidence'] as const) nonempty(row[k], k, k === 'proposedValue' ? 2000 : 256);
    if (typeof row.conflict !== 'boolean') throw new Error('Staged conflict flag is invalid.');
  }
  return obj as unknown as PrivatePrepStagingOverlay;
}
async function fingerprint(value: unknown): Promise<string> {
  return sha256Hex(canonicalizeJson(JSON.parse(JSON.stringify(value))));
}

/** Pure, separate human confirmation; NOT automatic source promotion. */
export async function planClientConfirmedPrepForReview(
  rawSession: unknown,
  rawPacket: unknown,
  rawOverlay: unknown,
  rawInput: unknown,
): Promise<ClientConfirmationDraftForReview> {
  const input = inputForReview(rawInput);
  const overlay = overlayForReview(rawOverlay);
  const session = await validateSemanticSessionRecord(rawSession);
  const prep = await prepareInterviewCandidateReviewForReview(rawPacket, session);
  if (input.sessionId !== session.sessionId || input.jobKey !== prep.jobKey
    || overlay.sessionId !== session.sessionId || overlay.jobKey !== prep.jobKey
    || overlay.revisionId !== session.revisionId
    || overlay.packDigest !== session.packIdentity.digest) {
    throw new Error('Confirmation does not match the pinned client interview/session.');
  }
  const [sessionDigest, packetDigest] = await Promise.all([
    fingerprint(session), fingerprint(rawPacket),
  ]);
  if (sessionDigest !== overlay.sessionDigest || packetDigest !== overlay.packetDigest) {
    throw new Error('Source/session changed; discard stale private confirmation.');
  }
  // Do not accept a manufactured/modified overlay: each selected source row
  // must match the CURRENT verified packet, exactly, including provenance.
  const relevance = relevanceMap(session);
  const seen = new Set<string>();
  for (const staged of overlay.candidates) {
    if (seen.has(staged.questionId)) throw new Error('Duplicate overlay question.');
    seen.add(staged.questionId);
    if (relevance[staged.questionId] !== 'relevant') {
      throw new Error('Hidden or pending candidate cannot be confirmed.');
    }
    const group = prep.questions.find(g => g.questionId === staged.questionId);
    const current = group?.candidates.find(c => c.candidateId === staged.candidateId);
    if (!current || canonicalizeJson(staged) !== canonicalizeJson({
      ...current, conflict: group!.conflict,
    })) {
      throw new Error('Selected private evidence was modified or is no longer current.');
    }
  }
  const staged = overlay.candidates.find(x => x.questionId === input.questionId
    && x.candidateId === input.candidateId);
  if (!staged) throw new Error('Confirmation is not for an explicitly staged candidate.');
  const question = session.packSnapshot.questions.find(q => q.id === input.questionId);
  if (!question || !isMeaningfulCaptureValue(captureSpecForQuestion(question), input.clientStatement)) {
    throw new Error('Client-confirmed statement is invalid for pinned question.');
  }
  const prior = session.answers[input.questionId];
  if (!prior || prior.value !== null || prior.resolution !== 'unresolved'
    || prior.source !== null || prior.confirmation !== null || prior.needsConfirmation
    || prior.followUp !== null
    || session.knownFacts.some(f => f.questionId === input.questionId)) {
    throw new Error('Previously captured or known question cannot be overwritten.');
  }
  if (Date.parse(input.confirmedAt) < Date.parse(session.updatedAt)) {
    throw new Error('Confirmation time cannot precede current interview state.');
  }

  const next = structuredClone(session);
  next.parentRevisionId = session.revisionId;
  next.revisionId = crypto.randomUUID();
  next.updatedAt = input.confirmedAt;
  // Even if the client confirms the originally suggested value verbatim,
  // the evidence source is the explicit client statement, not the private
  // research candidate. No sourceRecordRef/overlay payload enters JSON.
  Object.defineProperty(next.answers, input.questionId, {
    enumerable: true, configurable: true, writable: true,
    value: {
      ...prior, value: input.clientStatement,
      resolution: 'captured' as const,
      source: 'client-statement' as const,
      needsConfirmation: false,
      confirmation: null,
    },
  });
  const proposed = await validateSemanticSessionRecord(next);
  return {
    kind: 'private-client-confirmation-draft-only',
    sessionId: session.sessionId,
    expectedRevisionId: session.revisionId,
    expectedSessionCanonical: canonicalizeJson(session),
    proposed,
    notice: 'Private human-attested draft. No client consent, provider write, or committed answer is implied.',
  };
}

/**
 * The supplied store is the ONLY write boundary. Returned success must
 * reproduce the complete proposed session, not merely advance revision.
 */
export async function commitClientConfirmedPrepForReview(
  rawSession: unknown, rawPacket: unknown,
  rawOverlay: unknown, rawInput: unknown,
  store: ConfirmedPrepCompareAndSaveForReview,
): Promise<ClientConfirmationCommitForReview> {
  if (!store || typeof store.compareAndSave !== 'function') {
    throw new Error('A trusted atomic full-session compare-and-save adapter is required.');
  }
  const draft = await planClientConfirmedPrepForReview(
    rawSession, rawPacket, rawOverlay, rawInput,
  );
  const result = await store.compareAndSave(
    draft.sessionId, draft.expectedSessionCanonical, draft.proposed,
  );
  if (result === null) return { kind: 'stale-no-write' };
  const checked = await validateSemanticSessionRecord(result);
  if (canonicalizeJson(checked) !== canonicalizeJson(draft.proposed)) {
    throw new Error('Confirmed storage returned a divergent session; do not accept the result.');
  }
  return { kind: 'saved-private-client-statement', session: checked };
}

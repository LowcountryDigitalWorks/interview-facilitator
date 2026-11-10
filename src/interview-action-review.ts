import { canonicalizeJson, sha256Hex } from './pack-identity';
import { validateSemanticSessionRecord } from './semantic-session';
import { proposeInterviewNextStepsForReview } from './interview-workflow-bridge';

/**
 * PREP-BRIDGE-001: source-only private review boundary for proposed next steps.
 *
 * This module does NOT authorize a real engagement or actor, create tasks,
 * contact clients, persist approval, or write to ClientOps/Owner Console.
 * The eventual private adapter MUST verify actor/engagement authority and
 * re-check the exact source within its own conditional provider write.
 */
export const OPERATOR_ACTION_REVIEW_VERSION = 'ldw.interview-operator-action-review.v1' as const;

export interface OperatorActionSelection {
  schemaVersion: typeof OPERATOR_ACTION_REVIEW_VERSION;
  engagementKey: string;
  expectedSessionId: string;
  expectedRevisionId: string;
  expectedSessionDigest: string;
  expectedProposalDigest: string;
  selectedQuestionIds: string[];
  operatorSelectedForReview: true;
  reviewedAt: string;
}

export interface OperatorActionReview {
  schemaVersion: typeof OPERATOR_ACTION_REVIEW_VERSION;
  kind: 'private-operator-selected-proposals-only';
  engagementKey: string;
  sessionId: string;
  revisionId: string;
  sourceSessionDigest: string;
  sourceProposalDigest: string;
  reviewedAt: string;
  actions: Array<{
    questionId: string;
    action: string;
    owner?: string;
    dueDate?: string;
    retryKey: string;
  }>;
  notice: 'Operator selection only; no client consent, task, assignment, message or provider write exists.';
}

function exactRecord(raw: unknown, allowed: readonly string[], label: string): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(label + ' must be a plain record.');
  }
  const proto = Object.getPrototypeOf(raw);
  if ((proto !== Object.prototype && proto !== null)
    || Object.getOwnPropertySymbols(raw).length !== 0) {
    throw new Error(label + ' must be a plain record.');
  }
  const object = raw as Record<string, unknown>;
  if (Object.keys(object).length !== allowed.length
    || allowed.some(key => !Object.hasOwn(object, key))
    || Object.keys(object).some(key => !allowed.includes(key))) {
    throw new Error(label + ' has missing or unsupported fields.');
  }
  return object;
}

function boundedText(raw: unknown, label: string, max: number): string {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > max
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(raw)) {
    throw new Error(label + ' must be bounded nonempty text.');
  }
  return raw;
}

function canonicalUtc(raw: unknown): string {
  const value = boundedText(raw, 'Review time', 24);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error('Review time must be canonical UTC.');
  }
  return value;
}

function strictDueDate(raw: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new Error('Suggested due date must use ISO YYYY-MM-DD before workflow handoff.');
  }
  const parsed = new Date(raw + 'T00:00:00.000Z');
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw) {
    throw new Error('Suggested due date is not a real calendar date.');
  }
  return raw;
}

/**
 * Select only explicitly operator-reviewed, CURRENTLY relevant proposals,
 * and produce deterministic private write candidates for a FUTURE adapter.
 * A digest is an accidental-change/staleness check, not authentication.
 *
 * Never call this from an automatic event trigger to promote all follow-ups.
 */
export async function stageOperatorSelectedActionsForReview(
  rawSession: unknown,
  rawSelection: unknown,
): Promise<OperatorActionReview> {
  const input = exactRecord(rawSelection, [
    'schemaVersion', 'engagementKey', 'expectedSessionId', 'expectedRevisionId',
    'expectedSessionDigest', 'expectedProposalDigest', 'selectedQuestionIds',
    'operatorSelectedForReview', 'reviewedAt',
  ], 'Operator action selection');
  if (input.schemaVersion !== OPERATOR_ACTION_REVIEW_VERSION
    || input.operatorSelectedForReview !== true) {
    throw new Error('Explicit operator selection with supported version is required.');
  }
  const engagementKey = boundedText(input.engagementKey, 'Engagement key', 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(engagementKey)) {
    throw new Error('Engagement key must be an opaque, path-safe identifier.');
  }
  const expectedSessionId = boundedText(input.expectedSessionId, 'Session ID', 128);
  const expectedRevisionId = boundedText(input.expectedRevisionId, 'Revision ID', 128);
  const expectedSessionDigest = boundedText(input.expectedSessionDigest, 'Session digest', 64);
  const expectedProposalDigest = boundedText(input.expectedProposalDigest, 'Proposal digest', 64);
  for (const fingerprint of [expectedSessionDigest, expectedProposalDigest]) {
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) {
      throw new Error('Source fingerprints must be canonical SHA-256 hex.');
    }
  }
  const reviewedAt = canonicalUtc(input.reviewedAt);
  if (!Array.isArray(input.selectedQuestionIds)
    || input.selectedQuestionIds.length < 1 || input.selectedQuestionIds.length > 100) {
    throw new Error('Explicit bounded nonempty selection is required.');
  }
  const chosen = new Set<string>();
  for (const questionId of input.selectedQuestionIds) {
    const id = boundedText(questionId, 'Selected question ID', 128);
    if (chosen.has(id)) throw new Error('Duplicate selected question.');
    chosen.add(id);
  }

  const session = await validateSemanticSessionRecord(rawSession);
  if (session.sessionId !== expectedSessionId || session.revisionId !== expectedRevisionId) {
    throw new Error('Selected source session/revision is stale.');
  }
  const proposals = await proposeInterviewNextStepsForReview(session);
  const [sessionDigest, proposalDigest] = await Promise.all([
    sha256Hex(canonicalizeJson(session)),
    sha256Hex(canonicalizeJson(proposals)),
  ]);
  if (expectedSessionDigest !== sessionDigest || expectedProposalDigest !== proposalDigest) {
    throw new Error('Selected source contents changed; review again.');
  }

  const actions: OperatorActionReview['actions'] = [];
  for (const proposal of proposals.items) {
    if (!chosen.has(proposal.questionId)) continue;
    const action = boundedText(proposal.action, 'Proposed action', 2000);
    let owner: string | undefined;
    let dueDate: string | undefined;
    if (proposal.owner !== undefined) owner = boundedText(proposal.owner, 'Suggested owner', 200);
    if (proposal.dueDate !== undefined) dueDate = strictDueDate(proposal.dueDate);
    // Exclude the operator review timestamp from retry identity: repeating the
    // same source and same choice must not create a new external work item.
    const retryKey = await sha256Hex(canonicalizeJson({
      version: OPERATOR_ACTION_REVIEW_VERSION, engagementKey,
      sessionId: session.sessionId, revisionId: session.revisionId,
      sessionDigest, questionId: proposal.questionId, action,
      owner: owner ?? null, dueDate: dueDate ?? null,
    }));
    actions.push({
      questionId: proposal.questionId, action,
      ...(owner !== undefined ? { owner } : {}),
      ...(dueDate !== undefined ? { dueDate } : {}),
      retryKey,
    });
  }
  if (actions.length !== chosen.size) {
    throw new Error('A selected proposal is absent, hidden, pending, or no longer relevant.');
  }
  return {
    schemaVersion: OPERATOR_ACTION_REVIEW_VERSION,
    kind: 'private-operator-selected-proposals-only',
    engagementKey, sessionId: session.sessionId, revisionId: session.revisionId,
    sourceSessionDigest: sessionDigest, sourceProposalDigest: proposalDigest,
    reviewedAt, actions,
    notice: 'Operator selection only; no client consent, task, assignment, message or provider write exists.',
  };
}

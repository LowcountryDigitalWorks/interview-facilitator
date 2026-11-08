import { canonicalizeJson, sha256Hex } from './pack-identity';
import { semanticSessionToMarkdown } from './markdown';
import { validateSemanticSessionRecord } from './semantic-session';
import {
  proposeInterviewNextStepsForReview,
  type InterviewNextStepProposals,
} from './interview-workflow-bridge';
import { exportCanonicalSessionJsonForReview } from './versioned-session-io';

/**
 * #105 HANDOFF-PLAN A — pure, private, schema-1.3 SOURCE-ONLY proof.
 * No provider, local persistence, Owner Console, PWA entry, background
 * execution, remote calls, task creation, or external publication.
 */
export const INTERVIEW_HANDOFF_PLAN_VERSION = 'ldw.interview-handoff-plan.v1' as const;
type ArtifactKind = 'canonical-json' | 'internal-markdown' | 'follow-up-proposals';

export interface PrivateHandoffScope {
  engagementRef: string;
  expectedSessionId: string;
  expectedRevisionId: string;
  expectedPackDigest: string;
  operatorReviewedForDraft: true;
}
export interface PrivateHandoffArtifact {
  kind: ArtifactKind;
  /** Deterministic opaque identity. A FUTURE approved destination must enforce
   * actual idempotency/conditional writes; this hash does not perform them. */
  idempotencyKey: string;
  contentDigest: string;
  bytes: number;
  /** Confidential. Do not serialize into an Owner Console snapshot, log,
   * public GitHub issue, or an unauthenticated browser/API response. */
  content: string;
}
export interface PrivateHandoffPlan {
  schemaVersion: typeof INTERVIEW_HANDOFF_PLAN_VERSION;
  kind: 'private-review-only-no-provider-write';
  engagementRef: string;
  sessionId: string;
  revisionId: string;
  packDigest: string;
  artifacts: PrivateHandoffArtifact[];
  nextSteps: InterviewNextStepProposals;
  notice: 'Proposed private artifacts only. No upload, task, client approval or commitment was performed.';
}

function record(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)
    || (Object.getPrototypeOf(raw) !== Object.prototype
      && Object.getPrototypeOf(raw) !== null)) {
    throw new Error('Handoff scope must be a plain object.');
  }
  return raw as Record<string, unknown>;
}

function scopeForReview(raw: unknown): PrivateHandoffScope {
  const scope = record(raw);
  const keys = [
    'engagementRef', 'expectedSessionId', 'expectedRevisionId',
    'expectedPackDigest', 'operatorReviewedForDraft',
  ];
  if (Object.keys(scope).some(key => !keys.includes(key))
    || keys.some(key => !Object.hasOwn(scope, key))) {
    throw new Error('Handoff scope has missing or unsupported fields.');
  }
  if (typeof scope.engagementRef !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(scope.engagementRef)) {
    throw new Error('Handoff engagement reference is not a bounded opaque ID.');
  }
  for (const key of ['expectedSessionId', 'expectedRevisionId'] as const) {
    const value = scope[key];
    if (typeof value !== 'string' || !value.trim() || value.length > 128) {
      throw new Error('Handoff identity must be bounded nonempty text.');
    }
  }
  if (typeof scope.expectedPackDigest !== 'string'
    || !/^[a-f0-9]{64}$/.test(scope.expectedPackDigest)) {
    throw new Error('Handoff pack digest is not a canonical SHA-256 identity.');
  }
  if (scope.operatorReviewedForDraft !== true) {
    throw new Error('Handoff requires explicit operator review for a draft.');
  }
  return scope as unknown as PrivateHandoffScope;
}

const MAX_PRIVATE_ARTIFACT_BYTES = 2 * 1024 * 1024;

/**
 * Make a deterministic private handoff PLAN. Engagement ownership, operator
 * identity, confidentiality, conditional destination writes, rollback, and
 * off-device restore remain the responsibility of a separately authorized
 * private adapter. This function does not attest any of them.
 */
export async function planPrivateInterviewHandoffForReview(
  rawSession: unknown,
  rawScope: unknown,
): Promise<PrivateHandoffPlan> {
  const scope = scopeForReview(rawScope);
  const session = await validateSemanticSessionRecord(rawSession);
  if (session.sessionId !== scope.expectedSessionId
    || session.revisionId !== scope.expectedRevisionId
    || session.packIdentity.digest !== scope.expectedPackDigest) {
    throw new Error('Handoff session, revision or pinned pack identity changed.');
  }
  const canonicalJson = await exportCanonicalSessionJsonForReview(session);
  const markdown = semanticSessionToMarkdown(session);
  const nextSteps = await proposeInterviewNextStepsForReview(session);
  const nextStepsJson = canonicalizeJson(nextSteps);
  const contentRows: Array<{ kind: ArtifactKind; content: string }> = [
    { kind: 'canonical-json', content: canonicalJson },
    { kind: 'internal-markdown', content: markdown },
    { kind: 'follow-up-proposals', content: nextStepsJson },
  ];
  const artifacts: PrivateHandoffArtifact[] = [];
  for (const row of contentRows) {
    const bytes = new TextEncoder().encode(row.content).byteLength;
    if (bytes > MAX_PRIVATE_ARTIFACT_BYTES) {
      throw new Error('Private handoff artifact exceeds the bounded export size.');
    }
    const contentDigest = await sha256Hex(row.content);
    const idempotencyKey = await sha256Hex(canonicalizeJson({
      schemaVersion: INTERVIEW_HANDOFF_PLAN_VERSION,
      engagementRef: scope.engagementRef,
      sessionId: session.sessionId,
      revisionId: session.revisionId,
      packDigest: session.packIdentity.digest,
      artifactKind: row.kind,
      contentDigest,
    }));
    artifacts.push({
      kind: row.kind,
      idempotencyKey,
      contentDigest,
      bytes,
      content: row.content,
    });
  }
  return {
    schemaVersion: INTERVIEW_HANDOFF_PLAN_VERSION,
    kind: 'private-review-only-no-provider-write',
    engagementRef: scope.engagementRef,
    sessionId: session.sessionId,
    revisionId: session.revisionId,
    packDigest: session.packIdentity.digest,
    artifacts,
    nextSteps,
    notice: 'Proposed private artifacts only. No upload, task, client approval or commitment was performed.',
  };
}

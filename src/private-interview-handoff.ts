import { canonicalizeJson, sha256Hex } from './pack-identity';
import { semanticSessionToMarkdown } from './markdown';
import { validateSemanticSessionRecord, type SemanticInterviewSession } from './semantic-session';
import {
  proposeInterviewNextStepsForReview,
  type InterviewNextStepProposals,
} from './interview-workflow-bridge';

/**
 * #105 / #35 — an OFFLINE, owner-initiated confidential handoff envelope.
 * No provider SDK, network, upload, encryption, task write or authority
 * escalation. Consumers MUST independently authorize the engagement/actor
 * and validate/normalize date and action data before any provider write.
 */
export const PRIVATE_INTERVIEW_HANDOFF_VERSION =
  'ldw.interview-private-handoff.v1' as const;

export const PRIVATE_INTERVIEW_HANDOFF_NOTICE =
  'Confidential internal handoff only. This is not a task approval, client consent, external message, or provider write.' as const;

const MAX_HANDOFF_BYTES = 5_000_000;
const sha256Pattern = /^[a-f0-9]{64}$/;

export interface PrivateInterviewHandoffForReview {
  schemaVersion: typeof PRIVATE_INTERVIEW_HANDOFF_VERSION;
  kind: 'private-human-review-only';
  source: {
    sessionId: string;
    revisionId: string;
    packDigest: string;
    updatedAt: string;
    canonicalSha256: string;
  };
  canonicalSession: SemanticInterviewSession;
  internalMarkdown: string;
  proposedNextSteps: InterviewNextStepProposals;
  notice: typeof PRIVATE_INTERVIEW_HANDOFF_NOTICE;
}

function exactRecord(value: unknown, allowed: readonly string[], name: string):
Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(name + ' must be a plain record.');
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new Error(name + ' must be a plain record.');
  }
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== allowed.length
    || Object.keys(row).some(key => !allowed.includes(key))
    || allowed.some(key => !Object.hasOwn(row, key))) {
    throw new Error(name + ' has missing or unsupported fields.');
  }
  return row;
}

function checkSize(value: string): void {
  if (new TextEncoder().encode(value).byteLength > MAX_HANDOFF_BYTES) {
    throw new Error('Private interview handoff exceeds the size bound.');
  }
}

/**
 * Apply a bounded raw-input preflight BEFORE source validation, full JSON
 * canonicalization, Markdown rendering and the final 5MB envelope check.
 * Those steps allocate multiple derived private strings, so a final-only
 * output limit is not sufficient protection against an oversized draft.
 *
 * This is a resource guard, NOT a replacement for semantic validation or
 * cryptographic integrity. Never inspect or log confidential field values.
 */
function preflightPrivateHandoffSource(raw: unknown): void {
  const encoder = new TextEncoder();
  // Track only objects on the active traversal path. A shared object
  // referenced by two independent fields is not a cycle in canonical JSON.
  const activePath = new WeakSet<object>();
  const stack: Array<{ value: unknown; depth: number; exit?: true }> = [
    { value: raw, depth: 0 },
  ];
  let visited = 0;
  let textBytes = 0;
  const reject = (): never => {
    throw new Error('Private interview handoff source exceeds safe input limits.');
  };
  while (stack.length > 0) {
    const { value, depth, exit } = stack.pop()!;
    if (exit) {
      activePath.delete(value as object);
      continue;
    }
    if (++visited > 100_000 || depth > 80) reject();
    if (typeof value === 'string') {
      if (value.length > MAX_HANDOFF_BYTES - textBytes) reject();
      textBytes += encoder.encode(value).byteLength;
      if (textBytes > MAX_HANDOFF_BYTES) reject();
      continue;
    }
    if (value === null || typeof value === 'number' || typeof value === 'boolean') continue;
    if (typeof value !== 'object') {
      throw new Error('Private interview handoff source exceeds safe input limits.');
    }
    if (activePath.has(value)) {
      throw new Error('Private interview handoff source contains a cycle.');
    }
    activePath.add(value);
    stack.push({ value, depth, exit: true });
    if (Array.isArray(value)) {
      if (value.length > 100_000) reject();
      for (let i = value.length - 1; i >= 0; i--) {
        // Never invoke a getter while traversing a hostile local value.
        const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
        if (!descriptor || !('value' in descriptor)) {
          throw new Error('Private interview handoff source exceeds safe input limits.');
        }
        stack.push({ value: descriptor.value, depth: depth + 1 });
      }
      continue;
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) reject();
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length > 100_000) reject();
    for (const key of keys) {
      if (key.length > MAX_HANDOFF_BYTES - textBytes) reject();
      textBytes += encoder.encode(key).byteLength;
      if (textBytes > MAX_HANDOFF_BYTES) reject();
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      if (!descriptor || !('value' in descriptor)) {
        throw new Error('Private interview handoff source exceeds safe input limits.');
      }
      stack.push({ value: descriptor.value, depth: depth + 1 });
    }
  }
}

/** Deterministic: same validated source revision => same full private bytes. */
export async function buildPrivateInterviewHandoffForReview(rawSession: unknown):
Promise<string> {
  preflightPrivateHandoffSource(rawSession);
  const session = await validateSemanticSessionRecord(rawSession);
  const proposedNextSteps = await proposeInterviewNextStepsForReview(session);
  const envelope: PrivateInterviewHandoffForReview = {
    schemaVersion: PRIVATE_INTERVIEW_HANDOFF_VERSION,
    kind: 'private-human-review-only',
    source: {
      sessionId: session.sessionId,
      revisionId: session.revisionId,
      packDigest: session.packIdentity.digest,
      updatedAt: session.updatedAt,
      canonicalSha256: await sha256Hex(canonicalizeJson(session)),
    },
    canonicalSession: session,
    internalMarkdown: semanticSessionToMarkdown(session),
    proposedNextSteps,
    notice: PRIVATE_INTERVIEW_HANDOFF_NOTICE,
  };
  const bytes = canonicalizeJson(envelope) + '\n';
  checkSize(bytes);
  return bytes;
}

/**
 * Validate a local, PRIVATE handoff file before a future authorized workspace
 * may import it. SHA-256 is accidental corruption detection, NOT authenticity,
 * encryption or proof of interviewer/client identity.
 *
 * This function never writes anything or creates workflow tasks.
 */
export async function validatePrivateInterviewHandoffForReview(raw: unknown):
Promise<PrivateInterviewHandoffForReview> {
  if (typeof raw !== 'string' || !raw.endsWith('\n')) {
    throw new Error('Private handoff must be canonical JSON text with a newline.');
  }
  checkSize(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('Private handoff is malformed JSON.');
  }
  const value = exactRecord(parsed, [
    'schemaVersion', 'kind', 'source', 'canonicalSession',
    'internalMarkdown', 'proposedNextSteps', 'notice',
  ], 'Private handoff');
  if (value.schemaVersion !== PRIVATE_INTERVIEW_HANDOFF_VERSION
    || value.kind !== 'private-human-review-only'
    || value.notice !== PRIVATE_INTERVIEW_HANDOFF_NOTICE) {
    throw new Error('Unsupported private handoff format.');
  }
  const source = exactRecord(value.source, [
    'sessionId', 'revisionId', 'packDigest', 'updatedAt', 'canonicalSha256',
  ], 'Handoff source');
  const session = await validateSemanticSessionRecord(value.canonicalSession);
  if (source.sessionId !== session.sessionId
    || source.revisionId !== session.revisionId
    || source.packDigest !== session.packIdentity.digest
    || source.updatedAt !== session.updatedAt
    || typeof source.canonicalSha256 !== 'string'
    || !sha256Pattern.test(source.canonicalSha256)
    || source.canonicalSha256 !== await sha256Hex(canonicalizeJson(session))) {
    throw new Error('Private handoff source identity or integrity mismatch.');
  }
  const expectedProposals = await proposeInterviewNextStepsForReview(session);
  if (typeof value.internalMarkdown !== 'string'
    || value.internalMarkdown !== semanticSessionToMarkdown(session)
    || canonicalizeJson(value.proposedNextSteps)
      !== canonicalizeJson(expectedProposals)
    || canonicalizeJson(value.canonicalSession) !== canonicalizeJson(session)
    || canonicalizeJson(value) + '\n' !== raw) {
    throw new Error('Private handoff content/proposal mismatch.');
  }
  return value as unknown as PrivateInterviewHandoffForReview;
}

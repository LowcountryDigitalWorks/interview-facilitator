import { captureSpecForQuestion, relevanceMap, semanticStatusLabel } from './live-session';
import { isMeaningfulCaptureValue } from './coverage-semantics';
import { validateKnownFactSession14Record } from './known-fact-session';
import { canonicalizeJson, sha256Hex } from './pack-identity';

/**
 * #35B: dormant, PURE client read-back preview contract.
 *
 * Never publish this object without a separate approved UI renderer that uses
 * textContent, rather than innerHTML. Values, public labels and any follow-up
 * action are individually opted in against an EXACT source revision. This is
 * a preview, not consent, signature, approval or proof read-back occurred.
 */
export interface ReadBack14ReviewedEntry {
  questionId: string;
  publicLabel: string;
  /** Must equal the current captured value; must be null for other resolutions. */
  reviewedValue: string | null;
  /** Optional, explicit release of the exact current follow-up ACTION only. */
  reviewedFollowUp?: string;
}

export interface ReadBack14Review {
  expectedRevisionId: string;
  /** SHA-256 of the entire validated canonical session, not merely its revision ID. */
  expectedSessionDigest: string;
  entries: ReadBack14ReviewedEntry[];
}

export interface ReadBack14PreviewEntry {
  label: string;
  value: string | null;
  status: 'Current' | 'Known context' | 'Needs confirmation' | 'Open' | 'Deferred' | 'Not applicable';
  followUp?: string;
}

export interface ReadBack14Preview {
  kind: 'draft-client-readback-preview';
  revision: string;
  sessionUpdatedAt: string;
  notice: 'For discussion only; not a confirmation, approval, signature or consent.';
  entries: ReadBack14PreviewEntry[];
}

const REVIEW_KEYS = ['expectedRevisionId', 'expectedSessionDigest', 'entries'] as const;
const ENTRY_KEYS = ['questionId', 'publicLabel', 'reviewedValue', 'reviewedFollowUp'] as const;

function record(input: unknown, label: string): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(`${label} must be an object.`);
  }
  return input as Record<string, unknown>;
}

function closedKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new Error(`${label} contains unsupported fields.`);
  }
}

function nonempty(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`);
  return value;
}

/** A privately held review snapshot; do not place the digest in client output. */
async function sessionDigest(session: Awaited<ReturnType<typeof validateKnownFactSession14Record>>): Promise<string> {
  // Normalizes optional absent fields to the exact JSON record being reviewed.
  return sha256Hex(canonicalizeJson(JSON.parse(JSON.stringify(session))));
}

/** Capture both identifiers BEFORE human review; recompute after ANY source change. */
export async function prepareKnownFact14ReadBackReviewForReview(rawSession: unknown): Promise<{
  expectedRevisionId: string;
  expectedSessionDigest: string;
}> {
  const session = await validateKnownFactSession14Record(rawSession);
  return {
    expectedRevisionId: session.revisionId,
    expectedSessionDigest: await sessionDigest(session),
  };
}

/** No automatic release: the empty human-selected list produces zero rows. */
export async function projectReviewedKnownFact14ReadBackForReview(
  rawSession: unknown, rawReview: unknown,
): Promise<ReadBack14Preview> {
  const session = await validateKnownFactSession14Record(rawSession);
  const review = record(rawReview, 'Read-back review');
  closedKeys(review, REVIEW_KEYS, 'Read-back review');
  if (nonempty(review.expectedRevisionId, 'Expected revision') !== session.revisionId) {
    throw new Error('Read-back review is stale; revision changed since human selection.');
  }
  if (nonempty(review.expectedSessionDigest, 'Expected source snapshot') !== await sessionDigest(session)) {
    throw new Error('Read-back source snapshot changed since human selection.');
  }
  if (!Array.isArray(review.entries)) throw new Error('Read-back review entries must be an array.');
  const selectedIds = new Set<string>();
  const questions = new Map(session.packSnapshot.questions.map((q) => [q.id, q]));
  const relevance = relevanceMap(session);
  const entries: ReadBack14PreviewEntry[] = [];
  for (const rawEntry of review.entries) {
    const entry = record(rawEntry, 'Read-back entry');
    closedKeys(entry, ENTRY_KEYS, 'Read-back entry');
    const id = nonempty(entry.questionId, 'Question ID');
    if (selectedIds.has(id)) throw new Error('Duplicate reviewed read-back question.');
    selectedIds.add(id);
    const question = questions.get(id);
    if (!question) throw new Error('Read-back references an unknown question.');
    // Pending as well as hidden branches must not disclose retained answers.
    if (relevance[id] !== 'relevant') throw new Error('Read-back question is not currently relevant.');
    const answer = session.answers[id];
    if (!answer) throw new Error('Read-back question is missing its canonical answer.');
    const label = nonempty(entry.publicLabel, 'Public label');
    if (Array.from(label).length > 120 || /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/u.test(label)) {
      throw new Error('Read-back public label must be a short single line of plain text.');
    }
    const reviewedValue = entry.reviewedValue;
    if (!Object.prototype.hasOwnProperty.call(entry, 'reviewedValue')
      || (reviewedValue !== null && typeof reviewedValue !== 'string')) {
      throw new Error('Read-back value must be explicitly reviewed as text or null.');
    }
    const captured = answer.resolution === 'captured'
      && isMeaningfulCaptureValue(captureSpecForQuestion(question), answer.value);
    if (captured ? reviewedValue !== answer.value : reviewedValue !== null) {
      throw new Error('Read-back reviewed value differs from effective canonical evidence.');
    }

    let status = semanticStatusLabel(question, answer) as ReadBack14PreviewEntry['status'];
    // Interviewer inferences are not upgraded into client-agreed facts.
    if (captured && (answer.source === 'interviewer-inference' || answer.source === null)) {
      status = 'Needs confirmation';
    }
    const row: ReadBack14PreviewEntry = {
      label,
      value: captured ? answer.value : null,
      status,
    };
    if (Object.prototype.hasOwnProperty.call(entry, 'reviewedFollowUp')) {
      const reviewedFollowUp = entry.reviewedFollowUp;
      if (typeof reviewedFollowUp !== 'string' || !reviewedFollowUp.trim()
        || reviewedFollowUp !== answer.followUp?.action) {
        throw new Error('Read-back follow-up must match the current human-reviewed action.');
      }
      // Export canonical text, never the repeated read of a caller-provided getter.
      row.followUp = answer.followUp!.action;
    }
    entries.push(row);
  }
  return {
    kind: 'draft-client-readback-preview',
    // Public opaque revision; do not disclose migration lineage or parent revision IDs.
    revision: await sha256Hex('ldw-readback-revision-v1:' + session.revisionId),
    sessionUpdatedAt: session.updatedAt,
    notice: 'For discussion only; not a confirmation, approval, signature or consent.',
    entries,
  };
}

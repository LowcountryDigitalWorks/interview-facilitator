import type { AnswerStatus } from './domain';
import {
  validateKnownFactSession14Record,
  type KnownFactSession14,
} from './known-fact-session';
import {
  applyReactivationReviews,
  applyStatusControl,
  applyValueEdit,
  relevanceMap,
} from './live-session';

/**
 * #34A2B2C3 — pure, internal 1.4 editing boundary. The live application
 * must NOT activate this helper until storage, navigation, import and artifacts
 * support the same schema. This never writes IndexedDB or creates fact events.
 */
export type KnownFact14Edit =
  | { kind: 'value'; questionId: string; value: string | null }
  | { kind: 'status'; questionId: string; status: AnswerStatus };

/**
 * Runtime commands may come from imported or future UI boundaries; TypeScript
 * types do not validate objects received at runtime. Reject unknown fields,
 * missing payloads, and unsupported statuses before applying any edit.
 */
const EDIT_STATUSES = new Set<AnswerStatus>([
  'ANSWERED', 'ALREADY_KNOWN', 'SKIP', 'N_A', 'MUST_CONFIRM',
]);

function validateKnownFact14EditCommand(value: unknown): asserts value is KnownFact14Edit {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Known-fact edit command is invalid.');
  }
  const command = value as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(command, 'kind')
    || !Object.prototype.hasOwnProperty.call(command, 'questionId')
    || typeof command.questionId !== 'string'
    || !command.questionId.trim()) {
    throw new Error('Known-fact edit command requires a valid question ID and kind.');
  }

  if (command.kind === 'value') {
    // Preserve independent post-edit schema-validation coverage: malformed
    // value types are rejected by validateKnownFactSession14Record(next), not
    // hidden by this earlier command-shape guard.
    if (Object.keys(command).some((key) => !['kind', 'questionId', 'value'].includes(key))
      || !Object.prototype.hasOwnProperty.call(command, 'value')) {
      throw new Error('Known-fact edit command has an invalid value payload.');
    }
    return;
  }
  if (command.kind === 'status') {
    if (Object.keys(command).some((key) => !['kind', 'questionId', 'status'].includes(key))
      || !Object.prototype.hasOwnProperty.call(command, 'status')
      || typeof command.status !== 'string'
      || !EDIT_STATUSES.has(command.status as AnswerStatus)) {
      throw new Error('Known-fact edit command has an invalid status payload.');
    }
    return;
  }
  throw new Error('Known-fact edit command kind is unsupported.');
}

/**
 * Return a separately validated 1.4 snapshot, preserving its source ledger.
 * When a person replaces evidence from an accepted known fact, the answer
 * becomes client-statement evidence and its now-inapplicable current link is
 * removed. The previous acceptance remains in the immutable ledger/history.
 */
export async function applyKnownFact14EditForReview(
  original: KnownFactSession14,
  edit: KnownFact14Edit,
): Promise<KnownFactSession14> {
  validateKnownFact14EditCommand(edit);
  const source = await validateKnownFactSession14Record(original);
  const question = source.packSnapshot.questions.find((item) => item.id === edit.questionId);
  const current = source.answers[edit.questionId];
  if (!question || !current) throw new Error('Known-fact edit question is not part of the pinned session.');

  const before = relevanceMap(source);
  const next = structuredClone(source);
  // Re-selecting an already accepted known fact is a no-op, not a new
  // acceptance or a conversion to weak/unverified evidence. In particular,
  // it must not clear a pending reconfirmation caused by branch reactivation.
  const repeatedAcceptedFact = edit.kind === 'status'
    && edit.status === 'ALREADY_KNOWN'
    && current.source === 'accepted-known-fact'
    && source.knownFactAnswerLinks[edit.questionId]?.kind === 'accepted';
  let answer = repeatedAcceptedFact
    ? current
    : edit.kind === 'value'
      ? applyValueEdit(question, current, edit.value)
      : applyStatusControl(question, current, edit.status);

  // The existing 1.3 field adapter intentionally leaves a Skip/N/A source
  // untouched. 1.4 must not retain an acceptance-value link after editing a
  // deferred/inapplicable historical value; changing its source is explicit.
  if (edit.kind === 'value'
    && current.value !== edit.value
    && current.source === 'accepted-known-fact'
    && answer.source === 'accepted-known-fact') {
    answer = { ...answer, source: 'client-statement' };
  }

  next.answers[edit.questionId] = answer;
  if (answer.source !== 'accepted-known-fact') {
    delete next.knownFactAnswerLinks[edit.questionId];
  }

  applyReactivationReviews(next, before);
  return validateKnownFactSession14Record(next);
}

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
 * Return a separately validated 1.4 snapshot, preserving its source ledger.
 * When a person replaces evidence from an accepted known fact, the answer
 * becomes client-statement evidence and its now-inapplicable current link is
 * removed. The previous acceptance remains in the immutable ledger/history.
 */
export async function applyKnownFact14EditForReview(
  original: KnownFactSession14,
  edit: KnownFact14Edit,
): Promise<KnownFactSession14> {
  const source = await validateKnownFactSession14Record(original);
  const question = source.packSnapshot.questions.find((item) => item.id === edit.questionId);
  const current = source.answers[edit.questionId];
  if (!question || !current) throw new Error('Known-fact edit question is not part of the pinned session.');

  const before = relevanceMap(source);
  const next = structuredClone(source);
  let answer = edit.kind === 'value'
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

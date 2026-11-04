import type { Question } from './domain';
import {
  projectCoverageObjectives,
  type SemanticStateMap,
} from './coverage-rules';

/**
 * #37B — deterministic, optional next-objective guidance for the human interviewer.
 *
 * This is a pure projection over the pinned question order and accepted
 * coverage semantics. It does not navigate, mutate answers, auto-confirm
 * information, call AI/network services, or change persisted session formats.
 * Pending conditional branches never become recommendations on guesses.
 */
export type NextObjectiveReason = 'capture' | 'review-capture' | 'needs-confirmation';

export interface NextObjectiveSuggestion {
  questionId: string;
  reason: NextObjectiveReason;
}

/**
 * Find the next applicable outstanding objective in pinned pack order,
 * beginning *after* the current objective and wrapping around once.
 *
 * A deliberately deferred/Skipped objective is not re-prompted automatically:
 * it remains visible to the interviewer in the coverage navigation. A
 * conditional objective is suggested only when its parent evidence makes
 * its relevance authoritative; pending and inactive branches are skipped.
 *
 * If the given current ID is not found, traversal begins at the first
 * question. If no other objective qualifies, the current one can be returned
 * on wrap-around when it remains outstanding. Null means no suggestion;
 * it never implies completion or client sign-off.
 */
export function suggestNextObjective(
  questions: readonly Question[],
  states: SemanticStateMap,
  currentQuestionId?: string | null,
): NextObjectiveSuggestion | null {
  if (questions.length === 0) return null;

  const projected = projectCoverageObjectives(questions, states);
  const byId = new Map(projected.map((item) => [item.questionId, item]));
  const currentIndex = questions.findIndex((question) => question.id === currentQuestionId);

  for (let step = 1; step <= questions.length; step += 1) {
    const question = questions[(currentIndex + step + questions.length) % questions.length]!;
    const projection = byId.get(question.id);
    const state = states[question.id];
    if (!projection || projection.relevance !== 'relevant') continue;
    if (projection.bucket !== 'open' && projection.bucket !== 'needs-confirmation') continue;
    if (state?.resolution === 'deferred') continue;

    return {
      questionId: question.id,
      reason: projection.bucket === 'needs-confirmation'
        ? 'needs-confirmation'
        : state?.resolution === 'captured'
          ? 'review-capture'
          : 'capture',
    };
  }
  return null;
}

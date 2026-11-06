import type { Question } from './domain';
import {
  effectiveEvidence,
  isMeaningfulCaptureValue,
  type CaptureSpec,
  type SemanticQuestionState,
} from './coverage-semantics';

export const EFFECTIVE_EVIDENCE_EQUALS_V2 = 'effective-evidence-equals-v2' as const;
export type EffectiveEvidenceRuleSemanticsVersion = typeof EFFECTIVE_EVIDENCE_EQUALS_V2;

export type Relevance = 'relevant' | 'irrelevant' | 'pending';
export type CoverageBucket = 'current' | 'needs-confirmation' | 'open' | 'not-applicable' | 'inactive';
export type SemanticStateMap = Readonly<Record<string, SemanticQuestionState | undefined>>;

export interface CoverageObjectiveProjection {
  questionId: string;
  relevance: Relevance;
  bucket: CoverageBucket;
}

function captureSpecForQuestion(question: Question): CaptureSpec {
  return question.options === undefined
    ? { kind: question.kind }
    : { kind: question.kind, options: question.options };
}

/**
 * Derives v2 relevance without changing the existing persisted condition-equals-v1 contract.
 * Missing parents and dependency cycles fail closed to pending rather than implicit false.
 */
export function deriveRelevanceMap(
  questions: readonly Question[],
  states: SemanticStateMap,
): Readonly<Record<string, Relevance>> {
  const byId = new Map(questions.map((question) => [question.id, question]));
  const memo = new Map<string, Relevance>();
  const visiting = new Set<string>();

  const evaluate = (questionId: string): Relevance => {
    const cached = memo.get(questionId);
    if (cached) return cached;

    const question = byId.get(questionId);
    if (!question) return 'pending';
    if (!question.condition) {
      memo.set(questionId, 'relevant');
      return 'relevant';
    }
    if (visiting.has(questionId)) return 'pending';

    visiting.add(questionId);
    let relevance: Relevance = 'pending';
    try {
      const parent = byId.get(question.condition.questionId);
      if (!parent) return 'pending';

      const parentRelevance = evaluate(parent.id);
      if (parentRelevance === 'irrelevant') {
        relevance = 'irrelevant';
      } else if (parentRelevance === 'pending') {
        relevance = 'pending';
      } else {
        const parentState = states[parent.id];
        if (!parentState) {
          relevance = 'pending';
        } else {
          const evidence = effectiveEvidence(captureSpecForQuestion(parent), parentState);
          if (evidence.strength !== 'authoritative') {
            relevance = 'pending';
          } else {
            relevance = evidence.value === question.condition.equals ? 'relevant' : 'irrelevant';
          }
        }
      }
      return relevance;
    } finally {
      visiting.delete(questionId);
      memo.set(questionId, relevance);
    }
  };

  // fromEntries preserves literal own keys such as "__proto__"; assignment into
  // {} would instead mutate the prototype and silently omit relevance evidence.
  return Object.fromEntries(
    questions.map((question) => [question.id, evaluate(question.id)]),
  ) as Record<string, Relevance>;
}

/**
 * Preserves retained data on reactivation but never silently restores old completion truth.
 * Historical evidence/event retention remains owned by #34.
 */
export function reviewReactivatedState(
  previousRelevance: Relevance,
  nextRelevance: Relevance,
  state: SemanticQuestionState,
  spec: CaptureSpec,
): SemanticQuestionState {
  if (previousRelevance !== 'irrelevant' || nextRelevance !== 'relevant') return { ...state };

  if (state.resolution === 'captured') {
    return { ...state, needsConfirmation: true, confirmation: null };
  }

  if (state.resolution === 'deferred' || state.resolution === 'not-applicable') {
    return { ...state, resolution: 'unresolved', needsConfirmation: true, confirmation: null };
  }

  // Follow-up metadata and source labels alone are not evidence. For unresolved states,
  // only a meaningful retained value or a historical/current confirmation reference
  // creates review work on reactivation.
  const hasRetainedEvidence = isMeaningfulCaptureValue(spec, state.value) || state.confirmation !== null;
  return hasRetainedEvidence
    ? { ...state, needsConfirmation: true, confirmation: null }
    : { ...state };
}

export function coverageBucketForQuestion(
  question: Question,
  state: SemanticQuestionState | undefined,
  relevance: Relevance,
): CoverageBucket {
  if (relevance === 'irrelevant') return 'inactive';
  if (relevance === 'pending') return 'open';
  if (!state) return 'open';
  if (state.resolution === 'not-applicable') return 'not-applicable';

  if (state.resolution === 'captured') {
    const evidence = effectiveEvidence(captureSpecForQuestion(question), state);
    if (evidence.strength === 'authoritative') return 'current';
    if (evidence.strength === 'tentative') return 'needs-confirmation';
  }

  return 'open';
}

export function projectCoverageObjectives(
  questions: readonly Question[],
  states: SemanticStateMap,
): readonly CoverageObjectiveProjection[] {
  const relevance = deriveRelevanceMap(questions, states);
  return questions.map((question) => ({
    questionId: question.id,
    relevance: relevance[question.id] ?? 'pending',
    bucket: coverageBucketForQuestion(question, states[question.id], relevance[question.id] ?? 'pending'),
  }));
}

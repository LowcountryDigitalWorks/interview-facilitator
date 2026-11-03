import type { AnswerStatus, Question } from './domain';
import {
  deriveRelevanceMap,
  projectCoverageObjectives,
  reviewReactivatedState,
  type CoverageBucket,
  type Relevance,
} from './coverage-rules';
import {
  effectiveEvidence,
  isMeaningfulCaptureValue,
  updateValueWithConfirmationInvalidation,
  type CaptureSpec,
} from './coverage-semantics';
import type { SemanticAnswerState, SemanticInterviewSession, SemanticPackSnapshot } from './semantic-session';

export interface LiveCoverage {
  resolved: number;
  remaining: number;
  mustConfirm: number;
  notApplicable: number;
  inactive: number;
  visible: number;
}

export function captureSpecForQuestion(question: Question): CaptureSpec {
  return question.options === undefined
    ? { kind: question.kind }
    : { kind: question.kind, options: question.options };
}

export function sessionPack(session: SemanticInterviewSession): SemanticPackSnapshot {
  return session.packSnapshot;
}

export function relevanceMap(session: SemanticInterviewSession): Readonly<Record<string, Relevance>> {
  return deriveRelevanceMap(session.packSnapshot.questions, session.answers);
}

export function visibleQuestions(session: SemanticInterviewSession): Question[] {
  const relevance = relevanceMap(session);
  return session.packSnapshot.questions.filter((question) => relevance[question.id] !== 'irrelevant');
}

export function nextVisibleQuestion(
  session: SemanticInterviewSession,
  currentId: string,
  direction: 1 | -1,
): Question | undefined {
  const visible = visibleQuestions(session);
  const index = visible.findIndex((question) => question.id === currentId);
  if (index < 0) return visible[0];
  return visible[index + direction];
}

export function coverageBucketMap(session: SemanticInterviewSession): Readonly<Record<string, CoverageBucket>> {
  return Object.fromEntries(projectCoverageObjectives(session.packSnapshot.questions, session.answers)
    .map((projection) => [projection.questionId, projection.bucket]));
}

export function coverage(session: SemanticInterviewSession): LiveCoverage {
  const projections = projectCoverageObjectives(session.packSnapshot.questions, session.answers);
  const result: LiveCoverage = {
    resolved: 0,
    remaining: 0,
    mustConfirm: 0,
    notApplicable: 0,
    inactive: 0,
    visible: 0,
  };
  for (const projection of projections) {
    if (projection.bucket !== 'inactive') result.visible += 1;
    if (projection.bucket === 'current') result.resolved += 1;
    else if (projection.bucket === 'needs-confirmation') result.mustConfirm += 1;
    else if (projection.bucket === 'open') result.remaining += 1;
    else if (projection.bucket === 'not-applicable') result.notApplicable += 1;
    else result.inactive += 1;
  }
  return result;
}

export function statusControlForState(state: SemanticAnswerState): AnswerStatus | null {
  if (state.resolution === 'deferred') return 'SKIP';
  if (state.resolution === 'not-applicable') return 'N_A';
  if (state.resolution !== 'captured') return null;
  if (state.source === null) return 'ALREADY_KNOWN';
  if (state.needsConfirmation) return 'MUST_CONFIRM';
  if (state.source === 'accepted-known-fact') return 'ALREADY_KNOWN';
  return 'ANSWERED';
}

export function applyStatusControl(
  question: Question,
  state: SemanticAnswerState,
  status: AnswerStatus,
): SemanticAnswerState {
  const meaningful = isMeaningfulCaptureValue(captureSpecForQuestion(question), state.value);
  switch (status) {
    case 'ANSWERED':
      return {
        ...state,
        resolution: meaningful ? 'captured' : 'unresolved',
        source: meaningful ? 'client-statement' : null,
        needsConfirmation: false,
        confirmation: null,
      };
    case 'ALREADY_KNOWN':
      return {
        ...state,
        resolution: meaningful ? 'captured' : 'unresolved',
        source: null,
        needsConfirmation: true,
        confirmation: null,
      };
    case 'MUST_CONFIRM':
      return {
        ...state,
        resolution: meaningful ? 'captured' : 'unresolved',
        source: meaningful ? (state.source ?? 'client-statement') : null,
        needsConfirmation: true,
        confirmation: null,
      };
    case 'SKIP':
      return {
        ...state,
        resolution: 'deferred',
        needsConfirmation: false,
        confirmation: null,
      };
    case 'N_A':
      return {
        ...state,
        resolution: 'not-applicable',
        needsConfirmation: false,
        confirmation: null,
      };
  }
}

export function applyValueEdit(
  question: Question,
  state: SemanticAnswerState,
  nextValue: string | null,
): SemanticAnswerState {
  // DOM synchronization can re-read an unchanged value during navigation. A no-op read must not
  // reclassify an explicit human resolution such as Skip/N/A or unresolved retained evidence.
  if (state.value === nextValue) return state;

  const updated = updateValueWithConfirmationInvalidation(state, nextValue) as SemanticAnswerState;
  const meaningful = isMeaningfulCaptureValue(captureSpecForQuestion(question), nextValue);

  if (!meaningful) {
    return state.resolution === 'captured'
      ? { ...updated, resolution: 'unresolved' }
      : updated;
  }

  if (state.resolution === 'unresolved') {
    return {
      ...updated,
      resolution: 'captured',
      source: 'client-statement',
      needsConfirmation: false,
      confirmation: null,
    };
  }

  // A user-entered correction is no longer evidence from the previously accepted known fact.
  // Preserve confirmation invalidation/tentative truth already derived by the value update.
  if (state.resolution === 'captured' && state.source === 'accepted-known-fact') {
    return {
      ...updated,
      source: 'client-statement',
    };
  }

  return updated;
}

/**
 * Preserves inactive retained data, but marks it for human review as soon as a branch leaves
 * `irrelevant` (including an intermediate `pending` state). That prevents a later pending→relevant
 * transition from silently restoring old completion truth after the original irrelevant state is lost.
 */
export function applyReactivationReviews(
  session: SemanticInterviewSession,
  before: Readonly<Record<string, Relevance>>,
): void {
  const after = relevanceMap(session);
  for (const question of session.packSnapshot.questions) {
    if (before[question.id] !== 'irrelevant' || after[question.id] === 'irrelevant') continue;
    const state = session.answers[question.id];
    if (!state) continue;
    const reviewed = reviewReactivatedState(
      'irrelevant',
      'relevant',
      state,
      captureSpecForQuestion(question),
    );
    session.answers[question.id] = {
      value: reviewed.value as string | null,
      resolution: reviewed.resolution,
      source: reviewed.source,
      needsConfirmation: reviewed.needsConfirmation,
      confirmation: reviewed.confirmation === null ? null : {
        revisionId: reviewed.confirmation.revisionId,
        confirmedAt: reviewed.confirmation.confirmedAt,
        value: reviewed.confirmation.value as string,
      },
      followUp: reviewed.followUp,
      note: state.note,
    };
  }
}

export function semanticStatusLabel(question: Question, state: SemanticAnswerState): string {
  if (state.resolution === 'deferred') return 'Deferred';
  if (state.resolution === 'not-applicable') return 'Not applicable';
  const evidence = effectiveEvidence(captureSpecForQuestion(question), state);
  if (evidence.strength === 'authoritative') {
    return state.source === 'accepted-known-fact' ? 'Known context' : 'Current';
  }
  if (evidence.strength === 'tentative') return 'Needs confirmation';
  return 'Open';
}

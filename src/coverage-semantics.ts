import type { QuestionState } from './domain';

export type CaptureValue = string | number | boolean | null;
export type MeaningfulAnswerKind = 'text' | 'textarea' | 'single' | 'boolean' | 'number';
export type Resolution = 'unresolved' | 'captured' | 'deferred' | 'not-applicable';
export type EvidenceSource = 'client-statement' | 'accepted-known-fact' | 'interviewer-inference';

export interface CaptureSpec {
  kind: MeaningfulAnswerKind;
  options?: readonly string[];
}

export interface ConfirmationReference {
  revisionId: string;
  confirmedAt: string;
  value: Exclude<CaptureValue, null>;
}

export interface FollowUpMetadata {
  action: string;
  owner?: string;
  dueDate?: string;
}

export interface SemanticQuestionState {
  value: CaptureValue;
  resolution: Resolution;
  source: EvidenceSource | null;
  needsConfirmation: boolean;
  confirmation: ConfirmationReference | null;
  followUp: FollowUpMetadata | null;
}

export type EffectiveEvidence =
  | { strength: 'none' }
  | { strength: 'tentative' | 'authoritative'; value: Exclude<CaptureValue, null>; source: EvidenceSource | null };

export function isMeaningfulCaptureValue(spec: CaptureSpec, value: unknown): value is Exclude<CaptureValue, null> {
  switch (spec.kind) {
    case 'text':
    case 'textarea':
      return typeof value === 'string' && value.trim().length > 0;
    case 'single':
      return typeof value === 'string' && Array.isArray(spec.options) && spec.options.includes(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
  }
}

function compatibilityState(input: {
  value: string | null;
  resolution: Resolution;
  source?: EvidenceSource | null;
  needsConfirmation?: boolean;
}): SemanticQuestionState {
  return {
    value: input.value,
    resolution: input.resolution,
    source: input.source ?? null,
    needsConfirmation: input.needsConfirmation ?? false,
    confirmation: null,
    followUp: null,
  };
}

/**
 * Projects the current 1.2 five-status state into the new semantic dimensions without
 * rewriting storage or inventing provenance/confirmation events that the old schema never stored.
 */
export function projectLegacyQuestionState(state: QuestionState, spec: CaptureSpec): SemanticQuestionState {
  const meaningful = isMeaningfulCaptureValue(spec, state.value);

  switch (state.status) {
    case 'ANSWERED':
      return meaningful
        ? compatibilityState({ value: state.value, resolution: 'captured', source: 'client-statement' })
        : compatibilityState({ value: state.value, resolution: 'unresolved' });
    case 'ALREADY_KNOWN':
      return meaningful
        ? compatibilityState({ value: state.value, resolution: 'captured', needsConfirmation: true })
        : compatibilityState({ value: state.value, resolution: 'unresolved', needsConfirmation: true });
    case 'MUST_CONFIRM':
      return meaningful
        ? compatibilityState({ value: state.value, resolution: 'captured', needsConfirmation: true })
        : compatibilityState({ value: state.value, resolution: 'unresolved', needsConfirmation: true });
    case 'SKIP':
      return compatibilityState({ value: state.value, resolution: 'deferred' });
    case 'N_A':
      return compatibilityState({ value: state.value, resolution: 'not-applicable' });
    case null:
      return compatibilityState({ value: state.value, resolution: 'unresolved' });
  }
}

export function effectiveEvidence(spec: CaptureSpec, state: SemanticQuestionState): EffectiveEvidence {
  if (state.resolution !== 'captured' || !isMeaningfulCaptureValue(spec, state.value)) {
    return { strength: 'none' };
  }

  return {
    strength: state.needsConfirmation || state.source === null ? 'tentative' : 'authoritative',
    value: state.value,
    source: state.source,
  };
}

/**
 * Updates only the value/confirmation dimensions. Resolution/source classification remains a
 * separate human/domain decision. Editing a value that had a current confirmation invalidates
 * that current reference while leaving historical confirmation evidence to the later lifecycle layer.
 */
export function updateValueWithConfirmationInvalidation(
  state: SemanticQuestionState,
  nextValue: CaptureValue,
): SemanticQuestionState {
  if (Object.is(state.value, nextValue)) return { ...state };

  return {
    ...state,
    value: nextValue,
    needsConfirmation: state.confirmation ? true : state.needsConfirmation,
    confirmation: null,
  };
}

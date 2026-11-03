import type { AnswerStatus, Question } from './domain';
import { semanticStatusLabel } from './live-session';
import type { SemanticAnswerState } from './semantic-session';

export type PresentationMode = 'private' | 'presentation';

export function enterPresentation(): PresentationMode { return 'presentation'; }
export function exitPresentation(): PresentationMode { return 'private'; }
export function isPresentationMode(mode: PresentationMode): boolean { return mode === 'presentation'; }

export interface ReadBackProjection {
  valueLabel: string;
  statusLabel: string;
}

/** Historical projection retained for legacy regression tests. */
export function projectReadBack(value: string | null, status: AnswerStatus | null): ReadBackProjection {
  const trimmed = value?.trim() ?? '';
  if (status === 'N_A') return { valueLabel: 'Not applicable', statusLabel: 'Not applicable' };
  if (status === 'SKIP') return { valueLabel: 'Deferred / not captured', statusLabel: 'Deferred' };
  if (status === 'MUST_CONFIRM') return { valueLabel: trimmed || 'No answer recorded', statusLabel: 'Needs confirmation' };
  if (status === 'ALREADY_KNOWN') return { valueLabel: trimmed || 'No answer recorded', statusLabel: 'Known context' };
  if (status === 'ANSWERED') return { valueLabel: trimmed || 'No answer recorded', statusLabel: 'Captured' };
  return { valueLabel: trimmed || 'No answer recorded', statusLabel: 'Unresolved' };
}

export function projectSemanticReadBack(question: Question, state: SemanticAnswerState): ReadBackProjection {
  const trimmed = state.value?.trim() ?? '';
  if (state.resolution === 'not-applicable') return { valueLabel: 'Not applicable', statusLabel: 'Not applicable' };
  if (state.resolution === 'deferred') return { valueLabel: 'Deferred / not captured', statusLabel: 'Deferred' };
  return {
    valueLabel: trimmed || 'No answer recorded',
    statusLabel: semanticStatusLabel(question, state),
  };
}

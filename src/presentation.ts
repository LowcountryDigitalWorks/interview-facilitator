import type { AnswerStatus } from './domain';

export type PresentationMode = 'private' | 'presentation';

export function enterPresentation(): PresentationMode {
  return 'presentation';
}

export function exitPresentation(): PresentationMode {
  return 'private';
}

export function isPresentationMode(mode: PresentationMode): boolean {
  return mode === 'presentation';
}

export interface ReadBackProjection {
  valueLabel: string;
  statusLabel: string;
}

export function projectReadBack(value: string | null, status: AnswerStatus | null): ReadBackProjection {
  const trimmed = value?.trim() ?? '';

  if (status === 'N_A') return { valueLabel: 'Not applicable', statusLabel: 'Not applicable' };
  if (status === 'SKIP') return { valueLabel: 'Deferred / not captured', statusLabel: 'Deferred' };
  if (status === 'MUST_CONFIRM') {
    return { valueLabel: trimmed || 'No answer recorded', statusLabel: 'Needs confirmation' };
  }
  if (status === 'ALREADY_KNOWN') {
    return { valueLabel: trimmed || 'No answer recorded', statusLabel: 'Known context' };
  }
  if (status === 'ANSWERED') {
    return { valueLabel: trimmed || 'No answer recorded', statusLabel: 'Captured' };
  }
  return { valueLabel: trimmed || 'No answer recorded', statusLabel: 'Unresolved' };
}

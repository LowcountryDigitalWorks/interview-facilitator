import { describe, expect, it } from 'vitest';
import { enterPresentation, exitPresentation, isPresentationMode, projectReadBack } from '../src/presentation';

describe('presentation mode', () => {
  it('enters and exits only through explicit transitions', () => {
    const entered = enterPresentation();
    expect(isPresentationMode(entered)).toBe(true);
    const exited = exitPresentation();
    expect(isPresentationMode(exited)).toBe(false);
  });

  it('does not expose retained values for deferred or not-applicable answers', () => {
    expect(projectReadBack('stale private detail', 'SKIP')).toEqual({
      valueLabel: 'Deferred / not captured',
      statusLabel: 'Deferred',
    });
    expect(projectReadBack('Yes', 'N_A')).toEqual({
      valueLabel: 'Not applicable',
      statusLabel: 'Not applicable',
    });
  });

  it('uses client-facing read-back labels rather than raw status enum names', () => {
    expect(projectReadBack('Current answer', 'MUST_CONFIRM')).toEqual({
      valueLabel: 'Current answer',
      statusLabel: 'Needs confirmation',
    });
    expect(projectReadBack('Existing fact', 'ALREADY_KNOWN')).toEqual({
      valueLabel: 'Existing fact',
      statusLabel: 'Known context',
    });
  });
});

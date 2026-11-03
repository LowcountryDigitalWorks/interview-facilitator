import { describe, expect, it } from 'vitest';
import { generalDiscoveryPack as pack } from '../src/pack';
import { enterPresentation, exitPresentation, isPresentationMode, projectReadBack, projectSemanticReadBack } from '../src/presentation';

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

  it('projects canonical semantic truth without exposing retained deferred or N/A values', () => {
    const question = pack.questions.find((item) => item.id === 'primary-goal')!;
    expect(projectSemanticReadBack(question, {
      value: 'stale private detail', resolution: 'deferred', source: 'client-statement', needsConfirmation: false,
      confirmation: null, followUp: null, note: '',
    })).toEqual({ valueLabel: 'Deferred / not captured', statusLabel: 'Deferred' });
    expect(projectSemanticReadBack(question, {
      value: 'stale N/A detail', resolution: 'not-applicable', source: 'client-statement', needsConfirmation: false,
      confirmation: null, followUp: null, note: '',
    })).toEqual({ valueLabel: 'Not applicable', statusLabel: 'Not applicable' });
  });

  it('distinguishes tentative, known-context, and current semantic evidence in read-back', () => {
    const question = pack.questions.find((item) => item.id === 'primary-goal')!;
    expect(projectSemanticReadBack(question, {
      value: 'Tentative answer', resolution: 'captured', source: null, needsConfirmation: false,
      confirmation: null, followUp: null, note: '',
    })).toEqual({ valueLabel: 'Tentative answer', statusLabel: 'Needs confirmation' });
    expect(projectSemanticReadBack(question, {
      value: 'Accepted context', resolution: 'captured', source: 'accepted-known-fact', needsConfirmation: false,
      confirmation: null, followUp: null, note: '',
    })).toEqual({ valueLabel: 'Accepted context', statusLabel: 'Known context' });
    expect(projectSemanticReadBack(question, {
      value: 'Current answer', resolution: 'captured', source: 'client-statement', needsConfirmation: false,
      confirmation: null, followUp: null, note: '',
    })).toEqual({ valueLabel: 'Current answer', statusLabel: 'Current' });
  });
});

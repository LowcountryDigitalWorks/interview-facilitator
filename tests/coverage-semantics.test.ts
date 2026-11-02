import { describe, expect, it } from 'vitest';
import {
  effectiveEvidence,
  isMeaningfulCaptureValue,
  projectLegacyQuestionState,
  updateValueWithConfirmationInvalidation,
  type CaptureSpec,
  type SemanticQuestionState,
} from '../src/coverage-semantics';
import type { AnswerStatus, QuestionState } from '../src/domain';

const text: CaptureSpec = { kind: 'text' };
const single: CaptureSpec = { kind: 'single', options: ['Yes', 'No'] };

function legacy(value: string | null, status: AnswerStatus | null): QuestionState {
  return { value, status, note: '' };
}

describe('coverage semantic primitives', () => {
  describe('meaningful capture values', () => {
    it.each([
      [null, false],
      ['', false],
      ['   ', false],
      ['0', true],
      ['  useful answer  ', true],
    ])('classifies text value %j as meaningful=%s', (value, expected) => {
      expect(isMeaningfulCaptureValue(text, value)).toBe(expected);
    });

    it.each([
      ['Yes', true],
      ['No', true],
      ['yes', false],
      ['Maybe', false],
      ['', false],
    ])('requires a single-choice value to match a pinned option exactly: %j', (value, expected) => {
      expect(isMeaningfulCaptureValue(single, value)).toBe(expected);
    });

    it('treats future false and zero values as meaningful rather than falsy/empty', () => {
      expect(isMeaningfulCaptureValue({ kind: 'boolean' }, false)).toBe(true);
      expect(isMeaningfulCaptureValue({ kind: 'boolean' }, true)).toBe(true);
      expect(isMeaningfulCaptureValue({ kind: 'number' }, 0)).toBe(true);
      expect(isMeaningfulCaptureValue({ kind: 'number' }, -3)).toBe(true);
      expect(isMeaningfulCaptureValue({ kind: 'number' }, Number.NaN)).toBe(false);
      expect(isMeaningfulCaptureValue({ kind: 'number' }, Number.POSITIVE_INFINITY)).toBe(false);
    });
  });

  describe('legacy 1.2 compatibility projection', () => {
    it('keeps a retained raw value with null status unresolved and non-authoritative', () => {
      const projected = projectLegacyQuestionState(legacy('Yes', null), single);
      expect(projected).toMatchObject({ value: 'Yes', resolution: 'unresolved', source: null, needsConfirmation: false });
      expect(effectiveEvidence(single, projected)).toEqual({ strength: 'none' });
    });

    it.each([null, '', '   '])('does not treat blank ANSWERED value %j as capture', (value) => {
      const projected = projectLegacyQuestionState(legacy(value, 'ANSWERED'), text);
      expect(projected.resolution).toBe('unresolved');
      expect(projected.source).toBeNull();
      expect(effectiveEvidence(text, projected)).toEqual({ strength: 'none' });
    });

    it('projects a meaningful ANSWERED value as a client statement without inventing confirmation metadata', () => {
      const projected = projectLegacyQuestionState(legacy('Client said yes', 'ANSWERED'), text);
      expect(projected).toEqual({
        value: 'Client said yes',
        resolution: 'captured',
        source: 'client-statement',
        needsConfirmation: false,
        confirmation: null,
        followUp: null,
      });
      expect(effectiveEvidence(text, projected)).toEqual({
        strength: 'authoritative',
        value: 'Client said yes',
        source: 'client-statement',
      });
    });

    it.each([null, '', '   '])('keeps blank ALREADY_KNOWN value %j unresolved and requiring confirmation', (value) => {
      const projected = projectLegacyQuestionState(legacy(value, 'ALREADY_KNOWN'), text);
      expect(projected).toMatchObject({ resolution: 'unresolved', source: null, needsConfirmation: true });
      expect(effectiveEvidence(text, projected)).toEqual({ strength: 'none' });
    });

    it('does not invent accepted-known-fact provenance from meaningful ALREADY_KNOWN legacy state', () => {
      const projected = projectLegacyQuestionState(legacy('Known before call', 'ALREADY_KNOWN'), text);
      expect(projected).toMatchObject({
        value: 'Known before call',
        resolution: 'captured',
        source: null,
        needsConfirmation: true,
      });
      expect(effectiveEvidence(text, projected)).toEqual({
        strength: 'tentative',
        value: 'Known before call',
        source: null,
      });
    });

    it.each([
      ['SKIP' as const, 'deferred' as const],
      ['N_A' as const, 'not-applicable' as const],
    ])('keeps stale raw values non-authoritative for %s', (status, resolution) => {
      const projected = projectLegacyQuestionState(legacy('Yes', status), single);
      expect(projected).toMatchObject({ value: 'Yes', resolution, source: null });
      expect(effectiveEvidence(single, projected)).toEqual({ strength: 'none' });
    });

    it('projects a meaningful MUST_CONFIRM value as tentative capture', () => {
      const projected = projectLegacyQuestionState(legacy('Yes', 'MUST_CONFIRM'), single);
      expect(projected).toMatchObject({ resolution: 'captured', source: null, needsConfirmation: true });
      expect(effectiveEvidence(single, projected)).toEqual({ strength: 'tentative', value: 'Yes', source: null });
    });

    it('projects a blank MUST_CONFIRM value as unresolved with no effective evidence', () => {
      const projected = projectLegacyQuestionState(legacy(' ', 'MUST_CONFIRM'), text);
      expect(projected).toMatchObject({ resolution: 'unresolved', source: null, needsConfirmation: true });
      expect(effectiveEvidence(text, projected)).toEqual({ strength: 'none' });
    });
  });

  describe('effective evidence and confirmation invalidation', () => {
    const confirmed: SemanticQuestionState = {
      value: 'Approved value',
      resolution: 'captured',
      source: 'client-statement',
      needsConfirmation: false,
      confirmation: {
        revisionId: 'revision-confirmed',
        confirmedAt: '2026-11-02T20:00:00.000Z',
        value: 'Approved value',
      },
      followUp: null,
    };

    it('defensively rejects captured state whose value is not meaningful', () => {
      const invalid: SemanticQuestionState = {
        ...confirmed,
        value: 'Maybe',
        confirmation: null,
      };
      expect(effectiveEvidence(single, invalid)).toEqual({ strength: 'none' });
    });

    it('treats provenance-unknown captured evidence as tentative rather than authoritative', () => {
      const unknownSource: SemanticQuestionState = {
        ...confirmed,
        value: 'Known value',
        source: null,
        confirmation: null,
      };
      expect(effectiveEvidence(text, unknownSource)).toEqual({
        strength: 'tentative',
        value: 'Known value',
        source: null,
      });
    });

    it('invalidates the current confirmation when a confirmed value is edited', () => {
      expect(updateValueWithConfirmationInvalidation(confirmed, 'Changed value')).toEqual({
        ...confirmed,
        value: 'Changed value',
        needsConfirmation: true,
        confirmation: null,
      });
    });

    it('preserves the current confirmation reference when the value is unchanged', () => {
      const updated = updateValueWithConfirmationInvalidation(confirmed, 'Approved value');
      expect(updated).toEqual(confirmed);
      expect(updated).not.toBe(confirmed);
      expect(updated.confirmation).toBe(confirmed.confirmation);
    });

    it('does not create a confirmation requirement when editing an unconfirmed state that did not require one', () => {
      const unconfirmed: SemanticQuestionState = {
        ...confirmed,
        confirmation: null,
      };
      expect(updateValueWithConfirmationInvalidation(unconfirmed, 'Changed value')).toMatchObject({
        value: 'Changed value',
        needsConfirmation: false,
        confirmation: null,
      });
    });
  });
});

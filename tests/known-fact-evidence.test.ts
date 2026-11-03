import { describe, expect, it } from 'vitest';
import { canonicalizeJson } from '../src/pack-identity';
import {
  acceptKnownFact,
  correctKnownFact,
  createKnownFactLedger,
  projectAcceptedKnownFact,
  validateKnownFactLedger,
} from '../src/known-fact-evidence';
import type { SemanticAnswerState } from '../src/semantic-session';

const WHEN = '2026-11-03T12:34:56.000Z';
const FACT = {
  id: 'fact-a', label: 'Hosting preference', value: 'Managed hosting',
  provenance: 'Synthetic planning notes', questionId: 'hosting-preference',
};

function emptyAnswer(): SemanticAnswerState {
  return {
    value: null, resolution: 'unresolved', source: null,
    needsConfirmation: false, confirmation: null, followUp: null, note: 'Keep this note',
  };
}

function accepted() {
  const ledger = createKnownFactLedger([FACT]);
  return acceptKnownFact(ledger, {
    id: 'accept-a', factId: FACT.id, currentRevisionId: 'rev-1',
    expectedRevisionId: 'rev-1', acceptedAt: WHEN,
  });
}

describe('#34A1 immutable known-fact evidence domain', () => {
  it('adapts pack facts without inventing acceptance or changing source', () => {
    const input = [structuredClone(FACT)];
    const before = canonicalizeJson(input);
    const ledger = createKnownFactLedger(input);
    expect(ledger).toEqual({ facts: input, acceptances: [] });
    ledger.facts[0]!.label = 'Edited local copy';
    expect(canonicalizeJson(input)).toBe(before);
  });

  it('accepts an exact value snapshot and revision without mutating either input or source fact', () => {
    const source = createKnownFactLedger([FACT]);
    const before = canonicalizeJson(source);
    const next = acceptKnownFact(source, {
      id: 'accept-a', factId: FACT.id, expectedRevisionId: 'rev-1',
      currentRevisionId: 'rev-1', acceptedAt: WHEN,
    });
    expect(canonicalizeJson(source)).toBe(before);
    expect(next.facts).toEqual(source.facts);
    expect(next.acceptances).toEqual([{
      id: 'accept-a', factId: 'fact-a', revisionId: 'rev-1',
      acceptedAt: WHEN, valueSnapshot: 'Managed hosting',
    }]);
    expect(validateKnownFactLedger(next)).toEqual(next);
  });

  it('rejects stale or malformed revision/event identifiers and double acceptance in one revision', () => {
    const source = createKnownFactLedger([FACT]);
    const base = { id: 'accept-a', factId: 'fact-a', expectedRevisionId: 'rev-1', currentRevisionId: 'rev-1', acceptedAt: WHEN };
    expect(() => acceptKnownFact(source, { ...base, expectedRevisionId: 'old-rev' })).toThrow(/stale/i);
    expect(() => acceptKnownFact(source, { ...base, id: '   ' })).toThrow(/nonempty/i);
    expect(() => acceptKnownFact(source, { ...base, acceptedAt: 'yesterday' })).toThrow(/timestamp/i);
    expect(() => acceptKnownFact(source, { ...base, factId: 'missing' })).toThrow(/unknown/i);
    const first = acceptKnownFact(source, base);
    expect(() => acceptKnownFact(first, base)).toThrow(/already/i);
    expect(() => acceptKnownFact(first, { ...base, id: 'accept-b' })).toThrow(/already/i);
    const later = acceptKnownFact(first, { ...base, id: 'accept-b', expectedRevisionId: 'rev-2', currentRevisionId: 'rev-2' });
    expect(later.acceptances).toHaveLength(2);
  });

  it('appends a correction with explicit replacement provenance and immutable supersession history', () => {
    const source = accepted();
    const before = canonicalizeJson(source);
    const next = correctKnownFact(source, {
      id: 'fact-b', supersedesFactId: 'fact-a', value: 'Self-hosted',
      provenance: 'Synthetic corrected interview note', sourceReference: 'notes-2',
      observedAt: WHEN, recordedAt: WHEN,
      expectedRevisionId: 'rev-2', currentRevisionId: 'rev-2',
    });
    expect(canonicalizeJson(source)).toBe(before);
    expect(next.facts).toEqual([
      FACT,
      {
        id: 'fact-b', label: FACT.label, questionId: FACT.questionId,
        supersedesFactId: 'fact-a', value: 'Self-hosted',
        provenance: 'Synthetic corrected interview note',
        sourceReference: 'notes-2', observedAt: WHEN, recordedAt: WHEN,
      },
    ]);
    expect(next.acceptances).toEqual(source.acceptances);
    expect(() => acceptKnownFact(next, {
      id: 'accept-old', factId: 'fact-a',
      expectedRevisionId: 'rev-3', currentRevisionId: 'rev-3', acceptedAt: WHEN,
    })).toThrow(/superseded/i);
    expect(validateKnownFactLedger(next)).toEqual(next);
  });

  it('rejects stale and duplicate corrections; allows sequential correction but no forked lineage', () => {
    const source = createKnownFactLedger([FACT]);
    const command = {
      id: 'fact-b', supersedesFactId: 'fact-a', value: 'Cloud',
      provenance: 'Corrected synthetic fact', expectedRevisionId: 'rev-1', currentRevisionId: 'rev-1',
    };
    expect(() => correctKnownFact(source, { ...command, currentRevisionId: 'rev-2' })).toThrow(/stale/i);
    expect(() => correctKnownFact(source, { ...command, id: 'fact-a' })).toThrow(/already exists/i);
    const next = correctKnownFact(source, command);
    expect(() => correctKnownFact(next, { ...command, id: 'fact-c' })).toThrow(/superseded/i);
    const following = correctKnownFact(next, { ...command, id: 'fact-c', supersedesFactId: 'fact-b' });
    expect(following.facts[2]!.supersedesFactId).toBe('fact-b');
    expect(() => validateKnownFactLedger({
      ...following,
      facts: [...following.facts, { ...FACT, id: 'fact-z', supersedesFactId: 'fact-a' }],
    })).toThrow(/lineage/i);
  });

  it('projects a meaningful accepted value into semantic capture, preserves private note/follow-up, but never invents client confirmation', () => {
    const ledger = accepted();
    const existing: SemanticAnswerState = {
      ...emptyAnswer(),
      value: 'Original answer', resolution: 'captured', source: 'client-statement',
      confirmation: { revisionId: 'rev-0', confirmedAt: WHEN, value: 'Original answer' },
      followUp: { action: 'Ask about migration', owner: 'Interviewer' },
    };
    const before = canonicalizeJson(existing);
    const projected = projectAcceptedKnownFact(ledger, 'accept-a', { kind: 'text' }, existing);
    expect(projected).toEqual({
      factId: 'fact-a',
      acceptanceId: 'accept-a',
      answer: {
        ...existing,
        value: 'Managed hosting', source: 'accepted-known-fact',
        needsConfirmation: true, confirmation: null,
      },
    });
    expect(canonicalizeJson(existing)).toBe(before);
    expect(ledger.acceptances[0]!.valueSnapshot).toBe('Managed hosting');
  });

  it('disallows capturing a value when question options do not permit it or source was superseded', () => {
    const ledger = accepted();
    expect(() => projectAcceptedKnownFact(ledger, 'accept-a', { kind: 'single', options: ['Yes', 'No'] }, emptyAnswer())).toThrow(/meaningful/i);
    expect(projectAcceptedKnownFact(ledger, 'accept-a', { kind: 'single', options: ['Managed hosting'] }, emptyAnswer()).answer.resolution).toBe('captured');
    const corrected = correctKnownFact(ledger, {
      id: 'fact-b', supersedesFactId: 'fact-a', value: 'Cloud',
      provenance: 'Corrected source', expectedRevisionId: 'rev-2', currentRevisionId: 'rev-2',
    });
    expect(() => projectAcceptedKnownFact(corrected, 'accept-a', { kind: 'text' }, emptyAnswer())).toThrow(/superseded/i);
    expect(() => projectAcceptedKnownFact(ledger, 'missing', { kind: 'text' }, emptyAnswer())).toThrow(/unknown/i);
  });

  it('rejects blank, duplicate or unsupported evidence, invalid timestamps, and absent provenance', () => {
    expect(() => createKnownFactLedger([{ ...FACT, value: '   ' }])).toThrow(/nonempty/i);
    expect(() => createKnownFactLedger([{ ...FACT, provenance: '' }])).toThrow(/nonempty/i);
    expect(() => createKnownFactLedger([FACT, FACT])).toThrow(/duplicate/i);
    expect(() => validateKnownFactLedger({ facts: [{ ...FACT, debugToken: 'unexpected' }], acceptances: [] })).toThrow(/unsupported/i);
    expect(() => validateKnownFactLedger({ facts: [FACT], acceptances: [{ id: 'a', factId: 'fact-a', revisionId: 'r', acceptedAt: WHEN, valueSnapshot: 'wrong' }] })).toThrow(/snapshot/i);
    expect(() => validateKnownFactLedger({ facts: [{ ...FACT, observedAt: '2026-11-03' }], acceptances: [] })).toThrow(/timestamp/i);
    expect(() => validateKnownFactLedger({ facts: [FACT], acceptances: [], hidden: true })).toThrow(/unsupported/i);
  });

  it('cannot change question attribution or attach a forward/cyclic supersession reference', () => {
    expect(() => validateKnownFactLedger({
      facts: [FACT, { ...FACT, id: 'fact-b', questionId: 'unrelated', supersedesFactId: 'fact-a' }],
      acceptances: [],
    })).toThrow(/question attribution/i);
    expect(() => validateKnownFactLedger({
      facts: [{ ...FACT, supersedesFactId: 'fact-b' }, { ...FACT, id: 'fact-b', supersedesFactId: 'fact-a' }],
      acceptances: [],
    })).toThrow(/lineage/i);
  });
});

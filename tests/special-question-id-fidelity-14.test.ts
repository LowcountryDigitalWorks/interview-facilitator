import { describe, expect, it } from 'vitest';
import { generalDiscoveryPack } from '../src/pack';
import { canonicalizeJson } from '../src/pack-identity';
import { createSemanticSession, validateSemanticSessionRecord } from '../src/semantic-session';
import { migrateSemantic13ToKnownFact14, validateKnownFactSession14Record } from '../src/known-fact-session';

const AT = new Date('2026-11-05T12:00:00.000Z');

async function specialQuestion() {
  const pack = structuredClone(generalDiscoveryPack);
  const goal = pack.questions.find(question => question.id === 'primary-goal');
  if (!goal) throw new Error('Synthetic fixture question missing.');
  goal.id = '__proto__';
  return createSemanticSession(pack, { clientLabel: 'Synthetic special-key client' }, AT);
}

describe('#34/#35 special question key source fidelity', () => {
  it('creates and validates an ordinary 1.3 session with an OWN __proto__ answer', async () => {
    const session = await specialQuestion();
    expect(Object.prototype.hasOwnProperty.call(session.answers, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(session.answers)).toBe(Object.prototype);
    session.answers['__proto__']!.value = 'Synthetic private goal';
    session.answers['__proto__']!.source = 'client-statement';
    session.answers['__proto__']!.resolution = 'captured';
    session.answers['__proto__']!.note = 'Synthetic private note';
    const before = canonicalizeJson(session);
    const checked = await validateSemanticSessionRecord(JSON.parse(before));
    expect(Object.keys(checked.answers)).toContain('__proto__');
    expect(checked.answers['__proto__']?.value).toBe('Synthetic private goal');
    expect(checked.answers['__proto__']?.note).toBe('Synthetic private note');
    expect(Object.getPrototypeOf(checked.answers)).toBe(Object.prototype);
    expect(canonicalizeJson(checked)).toBe(before);
    expect(canonicalizeJson(session)).toBe(before);
  });

  it('preserves legacy unverified known-fact links under __proto__ with confirmation required', async () => {
    const session = await specialQuestion();
    const state = session.answers['__proto__']!;
    state.value = 'Synthetic accepted-but-unverified source';
    state.resolution = 'captured';
    state.source = 'accepted-known-fact';
    state.needsConfirmation = true;
    state.note = 'Synthetic interviewer private note';
    const before = canonicalizeJson(session);
    const upgraded = await migrateSemantic13ToKnownFact14(session);
    expect(Object.keys(upgraded.answers)).toContain('__proto__');
    expect(Object.keys(upgraded.knownFactAnswerLinks)).toContain('__proto__');
    expect(Object.prototype.hasOwnProperty.call(upgraded.knownFactAnswerLinks, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(upgraded.knownFactAnswerLinks)).toBe(Object.prototype);
    expect(upgraded.knownFactAnswerLinks['__proto__']).toEqual({ kind: 'legacy-unverified' });
    expect(upgraded.answers['__proto__']?.value).toBe(state.value);
    expect(upgraded.answers['__proto__']?.note).toBe(state.note);
    expect(upgraded.answers['__proto__']?.needsConfirmation).toBe(true);
    const restored = await validateKnownFactSession14Record(JSON.parse(canonicalizeJson(upgraded)));
    expect(canonicalizeJson(restored)).toBe(canonicalizeJson(upgraded));
    expect(canonicalizeJson(session)).toBe(before);
  });

  it('rejects an unexpected __proto__ answer rather than dropping it during validation', async () => {
    const plain = await createSemanticSession(generalDiscoveryPack,
      { clientLabel: 'Synthetic plain client' }, AT);
    const extra = Object.fromEntries([
      ...Object.entries(plain.answers),
      ['__proto__', structuredClone(plain.answers['primary-goal'])],
    ]);
    expect(Object.prototype.hasOwnProperty.call(extra, '__proto__')).toBe(true);
    await expect(validateSemanticSessionRecord({ ...plain, answers: extra }))
      .rejects.toThrow(/unknown question/i);
  });

  it('rejects an unapproved special-key evidence link without changing the original session', async () => {
    const normal = await createSemanticSession(generalDiscoveryPack,
      { clientLabel: 'Synthetic plain client' }, AT);
    const converted = await migrateSemantic13ToKnownFact14(normal);
    const before = canonicalizeJson(converted);
    const extra = Object.fromEntries([
      ...Object.entries(converted.knownFactAnswerLinks),
      ['__proto__', { kind: 'legacy-unverified' }],
    ]);
    await expect(validateKnownFactSession14Record({
      ...converted, knownFactAnswerLinks: extra,
    })).rejects.toThrow(/accepted-known-fact/i);
    expect(canonicalizeJson(converted)).toBe(before);
  });
});

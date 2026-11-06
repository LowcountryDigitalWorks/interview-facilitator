import { describe, expect, it } from 'vitest';
import { generalDiscoveryPack } from '../src/pack';
import { canonicalizeJson } from '../src/pack-identity';
import { createSemanticSession, validateSemanticSessionRecord } from '../src/semantic-session';
import { migrateSemantic13ToKnownFact14, validateKnownFactSession14Record } from '../src/known-fact-session';
import { acceptKnownFact, projectAcceptedKnownFact } from '../src/known-fact-evidence';

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
  it('preserves a genuinely accepted __proto__ evidence link and rejects forged acceptance', async () => {
    const pack = structuredClone(generalDiscoveryPack);
    const question = pack.questions.find(item => item.id === 'existing-presence')!;
    question.id = '__proto__';
    pack.knownFacts[0]!.questionId = '__proto__';
    const source = await createSemanticSession(pack, { clientLabel: 'Synthetic accepted fact' }, AT);
    const sourceBytes = canonicalizeJson(source);
    const input = await migrateSemantic13ToKnownFact14(source);
    const acceptedAt = AT.toISOString();
    input.knownFactLedger = acceptKnownFact(input.knownFactLedger, {
      id: 'synthetic-acceptance-__proto__',
      factId: pack.knownFacts[0]!.id,
      expectedRevisionId: input.revisionId,
      currentRevisionId: input.revisionId,
      acceptedAt,
    });
    const projected = projectAcceptedKnownFact(
      input.knownFactLedger, 'synthetic-acceptance-__proto__', '__proto__',
      { kind: 'textarea' }, input.answers['__proto__']!,
    );
    Object.defineProperty(input.answers, '__proto__', {
      value: projected.answer, enumerable: true, writable: true, configurable: true,
    });
    Object.defineProperty(input.knownFactAnswerLinks, '__proto__', {
      value: { kind: 'accepted', factId: projected.factId, acceptanceId: projected.acceptanceId },
      enumerable: true, writable: true, configurable: true,
    });

    const before = canonicalizeJson(input);
    const validated = await validateKnownFactSession14Record(JSON.parse(before));
    expect(Object.prototype.hasOwnProperty.call(validated.knownFactAnswerLinks, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(validated.knownFactAnswerLinks)).toBe(Object.prototype);
    expect(validated.knownFactAnswerLinks['__proto__']).toEqual({
      kind: 'accepted', factId: pack.knownFacts[0]!.id,
      acceptanceId: 'synthetic-acceptance-__proto__',
    });
    expect(validated.answers['__proto__']?.value).toBe(pack.knownFacts[0]!.value);
    expect(validated.answers['__proto__']?.source).toBe('accepted-known-fact');
    expect(canonicalizeJson(validated)).toBe(before);
    expect(canonicalizeJson(source)).toBe(sourceBytes);

    const forged = structuredClone(input);
    forged.knownFactAnswerLinks['__proto__'] = {
      kind: 'accepted', factId: projected.factId, acceptanceId: 'nonexistent-acceptance',
    };
    await expect(validateKnownFactSession14Record(forged))
      .rejects.toThrow(/acceptance snapshot/i);
    expect(canonicalizeJson(input)).toBe(before);
  });

});

import { describe, expect, it } from 'vitest';
import {
  createKnownFact14CanonicalBackupForReview,
  validateKnownFact14CanonicalBackupForReview,
  KNOWN_FACT14_BACKUP_FORMAT,
  KNOWN_FACT14_BACKUP_MAX_CHARS,
} from '../src/known-fact-backup-14';
import { acceptKnownFact, correctKnownFact } from '../src/known-fact-evidence';
import { migrateSemantic13ToKnownFact14 } from '../src/known-fact-session';
import { createSemanticSession } from '../src/semantic-session';
import { generalDiscoveryPack } from '../src/pack';
import { canonicalizeJson } from '../src/pack-identity';

const AT = '2026-11-04T20:00:00.000Z';

async function completeSynthetic14() {
  const old = await createSemanticSession(generalDiscoveryPack,
    { clientLabel: 'PRIVATE CLIENT', interviewerLabel: 'PRIVATE INTERVIEWER' }, new Date(AT));
  old.runningNotes = 'PRIVATE RUNNING NOTES';
  old.knownFacts.push({
    id: 'source-1', label: 'Platform', value: 'PRIVATE ORIGINAL',
    provenance: 'Private interview note', questionId: 'existing-presence',
  });
  old.answers['primary-goal'] = {
    value: 'PRIVATE ORIGINAL GOAL', resolution: 'captured', source: 'client-statement',
    needsConfirmation: true, confirmation: null, note: 'PRIVATE ANSWER NOTE',
    followUp: { action: 'PRIVATE NEXT STEP', owner: 'PRIVATE OWNER', dueDate: '2026-11-20' },
  };
  old.answers['booking-process'] = {
    value: 'PRIVATE HIDDEN VALUE', resolution: 'deferred', source: null,
    needsConfirmation: false, confirmation: null, note: 'PRIVATE HIDDEN NOTE',
    followUp: null,
  };
  const session = await migrateSemantic13ToKnownFact14(old);
  session.knownFactLedger = acceptKnownFact(session.knownFactLedger, {
    id: 'accept-1', factId: 'source-1', acceptedAt: AT,
    expectedRevisionId: session.revisionId, currentRevisionId: session.revisionId,
  });
  session.knownFactLedger = correctKnownFact(session.knownFactLedger, {
    id: 'correction-1', supersedesFactId: 'source-1',
    value: 'PRIVATE CORRECTION', provenance: 'PRIVATE REVIEWED SOURCE',
    sourceReference: 'PRIVATE SOURCE REF',
    expectedRevisionId: session.revisionId, currentRevisionId: session.revisionId,
  });
  return session;
}

function canonical(value: unknown) {
  return canonicalizeJson(JSON.parse(JSON.stringify(value)));
}

describe('#35C dormant canonical JSON 1.4 backup/verification', () => {
  it('round trips every internal fact, history, answer, note and revision without mutating source', async () => {
    const session = await completeSynthetic14();
    const before = structuredClone(session);
    const bytes = await createKnownFact14CanonicalBackupForReview(session);
    const envelope = JSON.parse(bytes);
    expect(envelope.kind).toBe(KNOWN_FACT14_BACKUP_FORMAT);
    expect(envelope.classification).toBe('INTERNAL / CONFIDENTIAL');
    expect(envelope.integrity.algorithm).toBe('SHA-256');
    expect(envelope.integrity.digest).toMatch(/^[0-9a-f]{64}$/);
    for (const privateTerm of [
      'PRIVATE RUNNING NOTES', 'PRIVATE ANSWER NOTE', 'PRIVATE ORIGINAL GOAL',
      'PRIVATE HIDDEN VALUE', 'PRIVATE HIDDEN NOTE', 'PRIVATE CORRECTION',
      'PRIVATE SOURCE REF', 'PRIVATE OWNER', 'accept-1', 'correction-1',
    ]) expect(bytes).toContain(privateTerm);
    const restored = await validateKnownFact14CanonicalBackupForReview(bytes);
    expect(canonical(restored)).toBe(canonical(session));
    expect(session).toEqual(before);
    expect(await createKnownFact14CanonicalBackupForReview(restored)).toBe(bytes);
  });

  it('produces deterministic bytes and retains historical lineage and hidden branches', async () => {
    const session = await completeSynthetic14();
    const first = await createKnownFact14CanonicalBackupForReview(session);
    expect(first).toBe(await createKnownFact14CanonicalBackupForReview(structuredClone(session)));
    const restored = await validateKnownFact14CanonicalBackupForReview(first);
    expect(restored.parentRevisionId).toBe(session.parentRevisionId);
    expect(restored.knownFactLedger.facts).toHaveLength(session.knownFactLedger.facts.length);
    expect(restored.knownFactLedger.acceptances).toHaveLength(1);
    expect(restored.answers['booking-process']?.value).toBe('PRIVATE HIDDEN VALUE');
  });

  it('fails closed if the body or internal evidence is silently changed', async () => {
    const session = await completeSynthetic14();
    const envelope = JSON.parse(await createKnownFact14CanonicalBackupForReview(session));
    envelope.session.runningNotes = 'ATTACKER MODIFIED NOTES';
    await expect(validateKnownFact14CanonicalBackupForReview(JSON.stringify(envelope)))
      .rejects.toThrow(/integrity mismatch/i);
    const untouched = JSON.parse(await createKnownFact14CanonicalBackupForReview(session));
    untouched.session.knownFactLedger.facts[0].value = 'ATTACKER ORIGINAL';
    await expect(validateKnownFact14CanonicalBackupForReview(JSON.stringify(untouched)))
      .rejects.toThrow();
  });

  it('rejects envelope extra keys, unsupported versions and false classification', async () => {
    const valid = JSON.parse(await createKnownFact14CanonicalBackupForReview(await completeSynthetic14()));
    await expect(validateKnownFact14CanonicalBackupForReview(JSON.stringify({
      ...valid, privateEndpoint: 'never accepted',
    }))).rejects.toThrow(/unsupported fields/i);
    await expect(validateKnownFact14CanonicalBackupForReview(JSON.stringify({
      ...valid, formatVersion: 2,
    }))).rejects.toThrow(/unsupported/i);
    await expect(validateKnownFact14CanonicalBackupForReview(JSON.stringify({
      ...valid, classification: 'CLIENT PUBLIC',
    }))).rejects.toThrow(/unsupported/i);
    await expect(validateKnownFact14CanonicalBackupForReview(JSON.stringify({
      ...valid, integrity: { ...valid.integrity, algorithm: 'MD5' },
    }))).rejects.toThrow(/integrity/i);
    await expect(validateKnownFact14CanonicalBackupForReview(JSON.stringify({
      ...valid, integrity: { ...valid.integrity, unknown: true },
    }))).rejects.toThrow(/unsupported fields/i);
  });

  it('rejects invalid, unsupported, oversized and legacy source without auto-migration', async () => {
    await expect(validateKnownFact14CanonicalBackupForReview('not JSON'))
      .rejects.toThrow(/valid JSON/i);
    await expect(validateKnownFact14CanonicalBackupForReview('x'.repeat(KNOWN_FACT14_BACKUP_MAX_CHARS + 1)))
      .rejects.toThrow(/bounded JSON/i);
    await expect(validateKnownFact14CanonicalBackupForReview({})).rejects.toThrow(/bounded JSON/i);
    const old = await createSemanticSession(generalDiscoveryPack,
      { clientLabel: 'Legacy old' }, new Date(AT));
    await expect(createKnownFact14CanonicalBackupForReview(old)).rejects.toThrow(/schema version/i);
    const valid = JSON.parse(await createKnownFact14CanonicalBackupForReview(await completeSynthetic14()));
    valid.session.sessionSchemaVersion = '1.5.0';
    await expect(validateKnownFact14CanonicalBackupForReview(JSON.stringify(valid)))
      .rejects.toThrow(/schema version/i);
  });

  it('rejects duplicate JSON keys and noncanonical spacing/order/newline before acceptance', async () => {
    const valid = await createKnownFact14CanonicalBackupForReview(await completeSynthetic14());
    const parsed = JSON.parse(valid);
    await expect(validateKnownFact14CanonicalBackupForReview(valid)).resolves.toMatchObject({
      sessionSchemaVersion: '1.4.0',
    });
    await expect(validateKnownFact14CanonicalBackupForReview(valid.trimEnd()))
      .rejects.toThrow(/exact canonical JSON bytes/i);
    await expect(validateKnownFact14CanonicalBackupForReview(' ' + valid))
      .rejects.toThrow(/exact canonical JSON bytes/i);
    const shadow = valid.replace('"kind":', '"kind":"SHADOW-INJECTED","kind":');
    expect(JSON.parse(shadow)).toEqual(parsed);
    await expect(validateKnownFact14CanonicalBackupForReview(shadow))
      .rejects.toThrow(/exact canonical JSON bytes/i);
    await expect(validateKnownFact14CanonicalBackupForReview(JSON.stringify(parsed) + '\\n'))
      .rejects.toThrow(/exact canonical JSON bytes/i);
  });

  it('fails closed on special answer keys instead of silently dropping private material', async () => {
    const source = await completeSynthetic14();
    const answers = source.answers as Record<string, unknown>;
    Object.defineProperty(answers, '__proto__', {
      configurable: true, enumerable: true,
      value: structuredClone(source.answers['primary-goal']),
    });
    await expect(createKnownFact14CanonicalBackupForReview(source)).rejects.toThrow();
  });

  it('snapshots changing getters exactly once before validation, integrity and output', async () => {
    const source = await completeSynthetic14();
    const answer = source.answers['primary-goal']!;
    const original = answer.value!;
    let reads = 0;
    Object.defineProperty(answer, 'value', {
      enumerable: true, configurable: true,
      get: () => (++reads === 1 ? original : 'UNVALIDATED GETTER OVERRIDE'),
    });
    const bytes = await createKnownFact14CanonicalBackupForReview(source);
    expect(reads).toBe(1);
    expect(bytes).toContain('PRIVATE ORIGINAL GOAL');
    expect(bytes).not.toContain('UNVALIDATED GETTER OVERRIDE');
    const restored = await validateKnownFact14CanonicalBackupForReview(bytes);
    expect(restored.answers['primary-goal']?.value).toBe(original);
  });

  it('covers source-kind, version, digest format and canonicalization negatives', async () => {
    const valid = JSON.parse(await createKnownFact14CanonicalBackupForReview(await completeSynthetic14()));
    for (const variant of [
      { ...valid, kind: 'WRONG-KIND' },
      { ...valid, sessionSchemaVersion: '1.3.0' },
      { ...valid, integrity: { ...valid.integrity, digest: 'x'.repeat(64) } },
      { ...valid, integrity: { ...valid.integrity, canonicalization: 'other-json' } },
    ]) {
      await expect(validateKnownFact14CanonicalBackupForReview(
        canonicalizeJson(variant) + '\\n',
      )).rejects.toThrow();
    }
  });

  it('refuses unsupported nested fields instead of dropping unknown future data', async () => {
    const valid = JSON.parse(await createKnownFact14CanonicalBackupForReview(await completeSynthetic14()));
    valid.session.newFutureField = 'PRIVATE MUST NOT DROP';
    await expect(validateKnownFact14CanonicalBackupForReview(JSON.stringify(valid)))
      .rejects.toThrow(/unsupported field/i);
  });
});

import { describe, expect, it } from 'vitest';
import { generalDiscoveryPack } from '../src/pack';
import { canonicalizeJson } from '../src/pack-identity';
import { applyStatusControl } from '../src/live-session';
import { createSemanticSession, validateSemanticSessionRecord } from '../src/semantic-session';
import { acceptKnownFact, correctKnownFact, projectAcceptedKnownFact } from '../src/known-fact-evidence';
import {
  KNOWN_FACT_SESSION_SCHEMA_VERSION,
  SEMANTIC_13_TO_KNOWN_FACT_14_MIGRATION_ID,
  migrateSemantic13ToKnownFact14,
  planKnownFactMigration,
  validateKnownFactSession14Record,
} from '../src/known-fact-session';

const AT = '2026-11-03T12:30:00.000Z';
const SOURCE = {
  id: 'synthetic-fact-1',
  label: 'Existing platform',
  value: 'Current site',
  provenance: 'Synthetic discovery notes',
  questionId: 'existing-presence',
};

async function semantic13() {
  const source = await createSemanticSession(
    generalDiscoveryPack,
    { clientLabel: 'Synthetic known fact migration', interviewerLabel: 'Synthetic facilitator' },
    new Date(AT),
  );
  source.knownFacts = [{ ...SOURCE }];
  source.answers['existing-presence']!.note = 'Do not change private note';
  return validateSemanticSessionRecord(source);
}

describe('#34A2A explicit 1.4 known-fact envelope', () => {
  it('migrates deterministically without mutating 1.3 or inventing acceptance/confirmation', async () => {
    const before = await semantic13();
    const fingerprint = canonicalizeJson(before);
    const upgraded = await migrateSemantic13ToKnownFact14(before);
    const duplicated = await migrateSemantic13ToKnownFact14(structuredClone(before));
    expect(canonicalizeJson(before)).toBe(fingerprint);
    expect(canonicalizeJson(upgraded)).toBe(canonicalizeJson(duplicated));
    expect(upgraded.sessionSchemaVersion).toBe(KNOWN_FACT_SESSION_SCHEMA_VERSION);
    expect(upgraded.parentRevisionId).toBe(before.revisionId);
    expect(upgraded.revisionId).toBe(`migration:${before.revisionId}:${SEMANTIC_13_TO_KNOWN_FACT_14_MIGRATION_ID}`);
    expect(upgraded.sessionId).toBe(before.sessionId);
    expect(upgraded.createdAt).toBe(before.createdAt);
    expect(upgraded.updatedAt).toBe(before.updatedAt);
    expect(upgraded.packSnapshot).toEqual(before.packSnapshot);
    expect(upgraded.packIdentity).toEqual(before.packIdentity);
    expect(upgraded.answers).toEqual(before.answers);
    expect(upgraded.knownFacts).toEqual(before.knownFacts);
    expect(upgraded.knownFactLedger).toEqual({ facts: [SOURCE], acceptances: [] });
    expect(upgraded.knownFactAnswerLinks).toEqual({});
  });

  it('offers an exact source fingerprint and one-transition plan rather than automatic storage changes', async () => {
    const raw = await semantic13();
    const fingerprint = canonicalizeJson(raw);
    const plan = await planKnownFactMigration(raw);
    expect(plan.kind).toBe('ready');
    if (plan.kind !== 'ready') return;
    expect(plan.raw).toBe(raw);
    expect(plan.fingerprint).toBe(fingerprint);
    expect(plan.sourceSchemaVersion).toBe('1.3.0');
    expect(plan.migrationId).toBe(SEMANTIC_13_TO_KNOWN_FACT_14_MIGRATION_ID);
    expect(plan.session.parentRevisionId).toBe(raw.revisionId);
    expect(await planKnownFactMigration(plan.session)).toMatchObject({ kind: 'current' });
  });

  it('round-trips the validated envelope as strict canonical JSON', async () => {
    const session = await migrateSemantic13ToKnownFact14(await semantic13());
    const parsed = JSON.parse(canonicalizeJson(session));
    expect(await validateKnownFactSession14Record(parsed)).toEqual(session);
  });

  it('keeps accepted and corrected evidence lineages readable after 1.4 serialization', async () => {
    const input = await migrateSemantic13ToKnownFact14(await semantic13());
    input.knownFactLedger = acceptKnownFact(input.knownFactLedger, {
      id: 'accepted-event-1', factId: SOURCE.id, expectedRevisionId: input.revisionId,
      currentRevisionId: input.revisionId, acceptedAt: AT,
    });
    input.knownFactLedger = correctKnownFact(input.knownFactLedger, {
      id: 'corrected-fact-2', supersedesFactId: SOURCE.id,
      value: 'Updated site', provenance: 'Synthetic subsequent conversation',
      expectedRevisionId: input.revisionId, currentRevisionId: input.revisionId,
      sourceReference: 'synthetic-private-note', recordedAt: AT,
    });
    const restored = await validateKnownFactSession14Record(JSON.parse(canonicalizeJson(input)));
    expect(restored.knownFactLedger.facts[0]).toEqual(SOURCE);
    expect(restored.knownFactLedger.facts[1]).toMatchObject({
      id: 'corrected-fact-2', supersedesFactId: SOURCE.id,
      value: 'Updated site', provenance: 'Synthetic subsequent conversation',
      sourceReference: 'synthetic-private-note',
    });
    expect(restored.knownFactLedger.acceptances).toEqual([{
      id: 'accepted-event-1', factId: SOURCE.id, revisionId: input.revisionId,
      acceptedAt: AT, valueSnapshot: 'Current site',
    }]);
  });

  it('marks unproven legacy 1.3 accepted sources as needing confirmation without fabricating an event', async () => {
    const source = await semantic13();
    source.answers['existing-presence'] = {
      ...source.answers['existing-presence']!,
      value: SOURCE.value,
      resolution: 'captured',
      source: 'accepted-known-fact',
      needsConfirmation: false,
    };
    const before = canonicalizeJson(source);
    const migrated = await migrateSemantic13ToKnownFact14(source);
    expect(canonicalizeJson(source)).toBe(before);
    expect(migrated.knownFactLedger.acceptances).toEqual([]);
    expect(migrated.knownFactAnswerLinks['existing-presence']).toEqual({ kind: 'legacy-unverified' });
    expect(migrated.answers['existing-presence']).toMatchObject({
      value: SOURCE.value,
      source: 'accepted-known-fact',
      needsConfirmation: true,
    });
    await expect(validateKnownFactSession14Record(migrated)).resolves.toBeDefined();
    const forged = structuredClone(migrated);
    forged.answers['existing-presence']!.needsConfirmation = false;
    await expect(validateKnownFactSession14Record(forged)).rejects.toThrow(/require confirmation/i);
  });

  it('allows Skip and N/A to preserve a legacy source tag without active confirmation truth', async () => {
    const old = await semantic13();
    old.answers['existing-presence'] = {
      ...old.answers['existing-presence']!,
      value: SOURCE.value,
      resolution: 'captured',
      source: 'accepted-known-fact',
      needsConfirmation: false,
    };
    const migrated = await migrateSemantic13ToKnownFact14(old);
    const question = migrated.packSnapshot.questions.find((item) => item.id === 'existing-presence')!;
    for (const [status, expected] of [['SKIP', 'deferred'], ['N_A', 'not-applicable']] as const) {
      const changed = structuredClone(migrated);
      changed.answers['existing-presence'] = applyStatusControl(
        question, changed.answers['existing-presence']!, status,
      );
      expect(changed.answers['existing-presence']).toMatchObject({
        resolution: expected,
        source: 'accepted-known-fact',
        needsConfirmation: false,
      });
      expect(changed.knownFactAnswerLinks['existing-presence']).toEqual({ kind: 'legacy-unverified' });
      await expect(validateKnownFactSession14Record(changed)).resolves.toBeDefined();
    }
  });

  it('persists a question-scoped acceptance reference and refuses missing or mismatched provenance', async () => {
    const input = await migrateSemantic13ToKnownFact14(await semantic13());
    input.knownFactLedger = acceptKnownFact(input.knownFactLedger, {
      id: 'accept-fact', factId: SOURCE.id,
      expectedRevisionId: input.revisionId, currentRevisionId: input.revisionId, acceptedAt: AT,
    });
    const projection = projectAcceptedKnownFact(
      input.knownFactLedger, 'accept-fact', 'existing-presence',
      { kind: 'text' }, input.answers['existing-presence']!,
    );
    input.answers['existing-presence'] = { ...input.answers['existing-presence']!, ...projection.answer };
    input.knownFactAnswerLinks['existing-presence'] = {
      kind: 'accepted', factId: projection.factId, acceptanceId: projection.acceptanceId,
    };
    const restored = await validateKnownFactSession14Record(JSON.parse(canonicalizeJson(input)));
    expect(restored.knownFactAnswerLinks['existing-presence']).toEqual({
      kind: 'accepted', factId: SOURCE.id, acceptanceId: 'accept-fact',
    });
    expect(restored.answers['existing-presence']!.needsConfirmation).toBe(false);

    const unlinked = structuredClone(input);
    delete unlinked.knownFactAnswerLinks['existing-presence'];
    await expect(validateKnownFactSession14Record(unlinked)).rejects.toThrow(/missing its evidence link/i);

    const wrongAcceptance = structuredClone(input);
    wrongAcceptance.knownFactAnswerLinks['existing-presence'] = {
      kind: 'accepted', factId: SOURCE.id, acceptanceId: 'not-real',
    };
    await expect(validateKnownFactSession14Record(wrongAcceptance)).rejects.toThrow(/acceptance snapshot/i);

    const changedAnswer = structuredClone(input);
    changedAnswer.answers['existing-presence']!.value = 'Unexpected new value';
    await expect(validateKnownFactSession14Record(changedAnswer)).rejects.toThrow(/acceptance snapshot/i);

    const detached = structuredClone(input);
    detached.answers['existing-presence']!.source = 'client-statement';
    await expect(validateKnownFactSession14Record(detached)).rejects.toThrow(/must target/i);

    const extra = structuredClone(input);
    extra.knownFactAnswerLinks['existing-presence'] = {
      kind: 'accepted', factId: SOURCE.id, acceptanceId: 'accept-fact', debug: true,
    } as unknown as typeof extra.knownFactAnswerLinks['existing-presence'];
    await expect(validateKnownFactSession14Record(extra)).rejects.toThrow(/link is invalid/i);
  });

  it('requires review of a linked answer when its accepted fact is superseded', async () => {
    const input = await migrateSemantic13ToKnownFact14(await semantic13());
    input.knownFactLedger = acceptKnownFact(input.knownFactLedger, {
      id: 'accept-old', factId: SOURCE.id, expectedRevisionId: input.revisionId,
      currentRevisionId: input.revisionId, acceptedAt: AT,
    });
    input.answers['existing-presence'] = {
      ...input.answers['existing-presence']!,
      value: SOURCE.value, source: 'accepted-known-fact',
      resolution: 'captured', needsConfirmation: false,
    };
    input.knownFactAnswerLinks['existing-presence'] = {
      kind: 'accepted', factId: SOURCE.id, acceptanceId: 'accept-old',
    };
    input.knownFactLedger = correctKnownFact(input.knownFactLedger, {
      id: 'successor', supersedesFactId: SOURCE.id,
      value: 'New platform', provenance: 'Synthetic corrected evidence',
      expectedRevisionId: input.revisionId, currentRevisionId: input.revisionId,
    });
    await expect(validateKnownFactSession14Record(input)).rejects.toThrow(/superseded/i);
    const deferred = structuredClone(input);
    deferred.answers['existing-presence']!.resolution = 'deferred';
    deferred.answers['existing-presence']!.needsConfirmation = false;
    await expect(validateKnownFactSession14Record(deferred)).resolves.toBeDefined();
    input.answers['existing-presence']!.needsConfirmation = true;
    await expect(validateKnownFactSession14Record(input)).resolves.toBeDefined();
  });

  it('rejects invalid, missing and future versions without modifying the supplied source', async () => {
    const source = await semantic13();
    const before = canonicalizeJson(source);
    expect((await planKnownFactMigration({ ...source, sessionSchemaVersion: '1.2.0' })).kind).toBe('unsupported');
    expect((await planKnownFactMigration({ ...source, sessionSchemaVersion: '9.0.0' })).kind).toBe('unsupported');
    expect((await planKnownFactMigration({ ...source, sessionSchemaVersion: undefined })).kind).toBe('unsupported');
    expect((await planKnownFactMigration(null)).kind).toBe('invalid');
    expect(canonicalizeJson(source)).toBe(before);
  });

  it('distinguishes future nested rule and pack schemas from invalid data', async () => {
    const ruleFuture = structuredClone(await semantic13()) as unknown as {
      packSnapshot: { ruleSemanticsVersion: string };
    };
    ruleFuture.packSnapshot.ruleSemanticsVersion = 'future-rule-semantics';
    expect(await planKnownFactMigration(ruleFuture)).toMatchObject({ kind: 'unsupported' });

    const packFuture = structuredClone(await migrateSemantic13ToKnownFact14(await semantic13())) as unknown as {
      packSnapshot: { packSchemaVersion: string };
    };
    packFuture.packSnapshot.packSchemaVersion = '9.0.0';
    expect(await planKnownFactMigration(packFuture)).toMatchObject({ kind: 'unsupported' });
  });

  it('classifies closed-key corruption as invalid even when the error says unsupported field', async () => {
    const source = await semantic13();
    expect(await planKnownFactMigration({ ...source, unsupportedField: true })).toMatchObject({ kind: 'invalid' });
    const upgraded = await migrateSemantic13ToKnownFact14(source);
    expect(await planKnownFactMigration({ ...upgraded, unsupportedField: true })).toMatchObject({ kind: 'invalid' });

    const answerExtra = structuredClone(upgraded) as unknown as {
      answers: Record<string, Record<string, unknown>>;
    };
    answerExtra.answers['existing-presence']!.unsupportedField = true;
    expect(await planKnownFactMigration(answerExtra)).toMatchObject({ kind: 'invalid' });
  });

  it('fails closed on invalid 1.3 sources and preserves all source bytes in memory', async () => {
    const source = await semantic13();
    source.answers['existing-presence']!.resolution = 'captured';
    source.answers['existing-presence']!.value = '  ';
    const before = canonicalizeJson(source);
    const plan = await planKnownFactMigration(source);
    expect(plan.kind).toBe('invalid');
    expect(canonicalizeJson(source)).toBe(before);
  });

  it('does not silently discard legacy blank facts or absent provenance', async () => {
    const source = await semantic13();
    source.knownFacts[0]!.value = '   ';
    const before = canonicalizeJson(source);
    expect(await validateSemanticSessionRecord(source)).toBeDefined();
    expect(await planKnownFactMigration(source)).toMatchObject({ kind: 'invalid' });
    expect(canonicalizeJson(source)).toBe(before);

    source.knownFacts[0]!.value = 'Existing site';
    source.knownFacts[0]!.provenance = '';
    expect((await planKnownFactMigration(source)).kind).toBe('invalid');
  });

  it('refuses duplicate source identifiers instead of choosing an arbitrary root', async () => {
    const source = await semantic13();
    source.knownFacts.push({ ...SOURCE });
    const plan = await planKnownFactMigration(source);
    expect(plan.kind).toBe('invalid');
    expect(await validateSemanticSessionRecord(source)).toBeDefined();
  });

  it('requires the new ledger to exist and refuses unsupported session properties', async () => {
    const upgraded = await migrateSemantic13ToKnownFact14(await semantic13());
    const withoutLedger = { ...upgraded } as Partial<typeof upgraded>;
    delete withoutLedger.knownFactLedger;
    await expect(validateKnownFactSession14Record(withoutLedger)).rejects.toThrow(/ledger and answer links are required/i);
    const withoutLinks = { ...upgraded } as Partial<typeof upgraded>;
    delete withoutLinks.knownFactAnswerLinks;
    await expect(validateKnownFactSession14Record(withoutLinks)).rejects.toThrow(/answer links are required/i);
    await expect(validateKnownFactSession14Record({ ...upgraded, extraneous: true })).rejects.toThrow(/unsupported field/i);
    await expect(validateSemanticSessionRecord(upgraded)).rejects.toThrow(/unsupported|schema/i);
  });

  it('requires the source ledger to match every original fact and provenance exactly', async () => {
    const upgraded = await migrateSemantic13ToKnownFact14(await semantic13());
    const missingSource = structuredClone(upgraded);
    missingSource.knownFactLedger.facts = [];
    await expect(validateKnownFactSession14Record(missingSource)).rejects.toThrow(/every original/i);
    const alteredProvenance = structuredClone(upgraded);
    alteredProvenance.knownFactLedger.facts[0]!.provenance = 'Invented replacement provenance';
    await expect(validateKnownFactSession14Record(alteredProvenance)).rejects.toThrow(/source snapshot differs/i);
    const changedLabel = structuredClone(upgraded);
    changedLabel.knownFactLedger.facts[0]!.label = 'Different label';
    await expect(validateKnownFactSession14Record(changedLabel)).rejects.toThrow(/source snapshot differs/i);
  });

  it('rejects fabricated source facts and extra root identities', async () => {
    const upgraded = await migrateSemantic13ToKnownFact14(await semantic13());
    const extra = structuredClone(upgraded);
    extra.knownFactLedger.facts.push({ ...SOURCE, id: 'invented-fact' });
    await expect(validateKnownFactSession14Record(extra)).rejects.toThrow(/every original/i);
    const alteredSource = structuredClone(upgraded);
    alteredSource.knownFacts[0]!.value = 'Changed without ledger history';
    await expect(validateKnownFactSession14Record(alteredSource)).rejects.toThrow(/source snapshot differs/i);
  });

  it('rejects forged acceptance snapshots and malformed correction lineage', async () => {
    const upgraded = await migrateSemantic13ToKnownFact14(await semantic13());
    const forged = structuredClone(upgraded);
    forged.knownFactLedger.acceptances.push({
      id: 'forged', factId: SOURCE.id, revisionId: upgraded.revisionId,
      acceptedAt: AT, valueSnapshot: 'Something different',
    });
    await expect(validateKnownFactSession14Record(forged)).rejects.toThrow(/snapshot/i);
    const malformed = structuredClone(upgraded);
    malformed.knownFactLedger.facts.push({ ...SOURCE, id: 'successor', supersedesFactId: 'unknown' });
    await expect(validateKnownFactSession14Record(malformed)).rejects.toThrow(/lineage/i);
  });

  it('rejects forged pack identity while preserving an untouched pack snapshot', async () => {
    const upgraded = await migrateSemantic13ToKnownFact14(await semantic13());
    upgraded.packIdentity.digest = 'a'.repeat(64);
    await expect(validateKnownFactSession14Record(upgraded)).rejects.toThrow(/digest|identity/i);
  });
});

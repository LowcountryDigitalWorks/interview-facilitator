import { describe, expect, it } from 'vitest';
import { acceptKnownFact, projectAcceptedKnownFact } from '../src/known-fact-evidence';
import { applyKnownFact14EditForReview } from '../src/known-fact-editor';
import {
  migrateSemantic13ToKnownFact14,
  validateKnownFactSession14Record,
  type KnownFactSession14,
} from '../src/known-fact-session';
import { relevanceMap } from '../src/live-session';
import { generalDiscoveryPack } from '../src/pack';
import { createSemanticSession } from '../src/semantic-session';

const AT = '2026-11-04T04:00:00.000Z';

async function synthetic14(): Promise<KnownFactSession14> {
  const initial = await createSemanticSession(
    generalDiscoveryPack, { clientLabel: 'Synthetic 1.4 editing proof' }, new Date(AT),
  );
  return migrateSemantic13ToKnownFact14(initial);
}

async function accepted14(): Promise<KnownFactSession14> {
  const source = await createSemanticSession(
    generalDiscoveryPack, { clientLabel: 'Synthetic accepted fact editing' }, new Date(AT),
  );
  source.knownFacts.push({
    id: 'source-fact-a', label: 'Existing platform', value: 'Legacy site',
    provenance: 'Synthetic source', questionId: 'existing-presence',
  });
  const upgraded = await migrateSemantic13ToKnownFact14(source);
  upgraded.knownFactLedger = acceptKnownFact(upgraded.knownFactLedger, {
    id: 'acceptance-a', factId: 'source-fact-a',
    expectedRevisionId: upgraded.revisionId, currentRevisionId: upgraded.revisionId,
    acceptedAt: AT,
  });
  const projection = projectAcceptedKnownFact(
    upgraded.knownFactLedger, 'acceptance-a', 'existing-presence', { kind: 'text' },
    upgraded.answers['existing-presence']!,
  );
  upgraded.answers['existing-presence'] = { ...upgraded.answers['existing-presence']!, ...projection.answer };
  upgraded.knownFactAnswerLinks['existing-presence'] = {
    kind: 'accepted', factId: 'source-fact-a', acceptanceId: 'acceptance-a',
  };
  return validateKnownFactSession14Record(upgraded);
}

describe('#34A2B2C3 pure known-fact 1.4 editing adapter', () => {
  it('recomputes deterministic conditional relevance in canonical 1.4 without changing source', async () => {
    const source = await synthetic14();
    const snapshot = structuredClone(source);
    expect(relevanceMap(source)['booking-process']).toBe('pending');

    const withoutBooking = await applyKnownFact14EditForReview(source, {
      kind: 'value', questionId: 'needs-booking', value: 'No',
    });
    expect(withoutBooking.sessionSchemaVersion).toBe('1.4.0');
    expect(relevanceMap(withoutBooking)['booking-process']).toBe('irrelevant');
    expect(withoutBooking.knownFactLedger).toEqual(source.knownFactLedger);
    expect(source).toEqual(snapshot);

    const unconfirmed = await applyKnownFact14EditForReview(withoutBooking, {
      kind: 'status', questionId: 'needs-booking', status: 'MUST_CONFIRM',
    });
    expect(relevanceMap(unconfirmed)['booking-process']).toBe('pending');
  });

  it('replaces an accepted-fact answer with client evidence without forging or deleting ledger events', async () => {
    const accepted = await accepted14();
    const before = structuredClone(accepted);
    const updated = await applyKnownFact14EditForReview(accepted, {
      kind: 'value', questionId: 'existing-presence', value: 'Updated platform from client',
    });
    expect(updated.answers['existing-presence']).toMatchObject({
      value: 'Updated platform from client', source: 'client-statement', resolution: 'captured',
    });
    expect(updated.knownFactAnswerLinks['existing-presence']).toBeUndefined();
    expect(updated.knownFactLedger).toEqual(before.knownFactLedger);
    expect(accepted).toEqual(before);
    await expect(validateKnownFactSession14Record(updated)).resolves.toEqual(updated);
  });

  it('preserves accepted link on no-op/confirmation and drops it on explicit Answered status', async () => {
    const accepted = await accepted14();
    const noOp = await applyKnownFact14EditForReview(accepted, {
      kind: 'value', questionId: 'existing-presence', value: 'Legacy site',
    });
    expect(noOp.knownFactAnswerLinks).toEqual(accepted.knownFactAnswerLinks);
    const tentative = await applyKnownFact14EditForReview(noOp, {
      kind: 'status', questionId: 'existing-presence', status: 'MUST_CONFIRM',
    });
    expect(tentative.knownFactAnswerLinks).toEqual(accepted.knownFactAnswerLinks);
    expect(tentative.answers['existing-presence']?.needsConfirmation).toBe(true);

    const client = await applyKnownFact14EditForReview(accepted, {
      kind: 'status', questionId: 'existing-presence', status: 'ANSWERED',
    });
    expect(client.answers['existing-presence']?.source).toBe('client-statement');
    expect(client.knownFactAnswerLinks['existing-presence']).toBeUndefined();
    expect(client.knownFactLedger).toEqual(accepted.knownFactLedger);
  });

  it('clears an obsolete known-fact link if deferred retained evidence is edited', async () => {
    const accepted = await accepted14();
    const skipped = await applyKnownFact14EditForReview(accepted, {
      kind: 'status', questionId: 'existing-presence', status: 'SKIP',
    });
    expect(skipped.answers['existing-presence']).toMatchObject({
      resolution: 'deferred', source: 'accepted-known-fact',
    });
    expect(skipped.knownFactAnswerLinks['existing-presence']).toEqual(accepted.knownFactAnswerLinks['existing-presence']);
    const revised = await applyKnownFact14EditForReview(skipped, {
      kind: 'value', questionId: 'existing-presence', value: 'Changed retained value',
    });
    expect(revised.answers['existing-presence']).toMatchObject({
      value: 'Changed retained value', resolution: 'deferred', source: 'client-statement',
    });
    expect(revised.knownFactAnswerLinks['existing-presence']).toBeUndefined();
    expect(revised.knownFactLedger).toEqual(accepted.knownFactLedger);
  });

  it('rejects an unknown question without mutating evidence or storage', async () => {
    const source = await accepted14();
    const before = structuredClone(source);
    await expect(applyKnownFact14EditForReview(source, {
      kind: 'value', questionId: 'nonexistent-question', value: 'Attack',
    })).rejects.toThrow(/pinned session/i);
    expect(source).toEqual(before);
  });
});

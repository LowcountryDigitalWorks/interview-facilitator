import { describe, expect, it } from 'vitest';
import { acceptKnownFact, correctKnownFact, projectAcceptedKnownFact } from '../src/known-fact-evidence';
import { applyKnownFact14EditForReview } from '../src/known-fact-editor';
import {
  migrateSemantic13ToKnownFact14,
  validateKnownFactSession14Record,
  type KnownFactSession14,
} from '../src/known-fact-session';
import { relevanceMap } from '../src/live-session';
import { generalDiscoveryPack } from '../src/pack';
import { createSemanticSession } from '../src/semantic-session';

const AT = '2026-11-04T18:00:00.000Z';

async function acceptedFact(questionId: 'booking-process' | 'existing-presence'): Promise<KnownFactSession14> {
  const initial = await createSemanticSession(
    generalDiscoveryPack,
    { clientLabel: 'Synthetic adversarial evidence test' },
    new Date(AT),
  );
  initial.knownFacts.push({
    id: 'source-accepted-fact',
    label: 'Synthetic context',
    value: 'Retained synthetic evidence',
    provenance: 'Fixture only',
    questionId,
  });
  const session = await migrateSemantic13ToKnownFact14(initial);
  session.knownFactLedger = acceptKnownFact(session.knownFactLedger, {
    id: 'accepted-1',
    factId: 'source-accepted-fact',
    expectedRevisionId: session.revisionId,
    currentRevisionId: session.revisionId,
    acceptedAt: AT,
  });
  const projection = projectAcceptedKnownFact(
    session.knownFactLedger,
    'accepted-1',
    questionId,
    { kind: 'textarea' },
    session.answers[questionId]!,
  );
  session.answers[questionId] = { ...session.answers[questionId]!, ...projection.answer };
  session.knownFactAnswerLinks[questionId] = {
    kind: 'accepted', factId: 'source-accepted-fact', acceptanceId: 'accepted-1',
  };
  return validateKnownFactSession14Record(session);
}

describe('#34C3 independent review M1 — reactivation must reclassify retained accepted evidence', () => {
  it('requires fresh human review when an accepted-fact answer moves from inactive to relevant', async () => {
    const accepted = await acceptedFact('booking-process');
    expect(accepted.answers['booking-process']?.needsConfirmation).toBe(false);

    const deactivated = await applyKnownFact14EditForReview(accepted, {
      kind: 'value', questionId: 'needs-booking', value: 'No',
    });
    expect(relevanceMap(deactivated)['booking-process']).toBe('irrelevant');
    expect(deactivated.answers['booking-process']?.needsConfirmation).toBe(false);

    const before = structuredClone(deactivated);
    const reactivated = await applyKnownFact14EditForReview(deactivated, {
      kind: 'value', questionId: 'needs-booking', value: 'Yes',
    });
    expect(relevanceMap(reactivated)['booking-process']).toBe('relevant');
    expect(reactivated.answers['booking-process']).toMatchObject({
      value: 'Retained synthetic evidence',
      resolution: 'captured',
      source: 'accepted-known-fact',
      needsConfirmation: true,
      confirmation: null,
    });
    expect(reactivated.knownFactAnswerLinks).toEqual(deactivated.knownFactAnswerLinks);
    expect(reactivated.knownFactLedger).toEqual(deactivated.knownFactLedger);
    expect(deactivated).toEqual(before);
    await expect(validateKnownFactSession14Record(reactivated)).resolves.toEqual(reactivated);
  });
});

describe('#34C3 independent review M2 — validate both source and resulting 1.4 record', () => {
  it('rejects a 1.3 source before editing and leaves its bytes unchanged', async () => {
    const old = await createSemanticSession(
      generalDiscoveryPack, { clientLabel: 'Synthetic legacy' }, new Date(AT),
    );
    const unchanged = structuredClone(old);
    await expect(applyKnownFact14EditForReview(
      old as unknown as KnownFactSession14,
      { kind: 'value', questionId: 'primary-goal', value: 'No downgrade' },
    )).rejects.toThrow(/schema version/i);
    expect(old).toEqual(unchanged);
  });

  it('rejects an unsupported extra field before editing and does not silently drop it', async () => {
    const valid = await acceptedFact('existing-presence');
    const corrupted = { ...valid, unexpectedPrivateField: 'fixture canary' };
    const original = structuredClone(corrupted);
    await expect(applyKnownFact14EditForReview(
      corrupted as unknown as KnownFactSession14,
      { kind: 'value', questionId: 'primary-goal', value: 'No lossy coercion' },
    )).rejects.toThrow(/unsupported field/i);
    expect(corrupted).toEqual(original);
  });

  it('rejects a broken acceptance reference before modifying any answer', async () => {
    const valid = await acceptedFact('existing-presence');
    const corrupted = structuredClone(valid);
    corrupted.knownFactAnswerLinks['existing-presence'] = {
      kind: 'accepted', factId: 'source-accepted-fact', acceptanceId: 'missing-event',
    };
    const original = structuredClone(corrupted);
    await expect(applyKnownFact14EditForReview(corrupted, {
      kind: 'value', questionId: 'primary-goal', value: 'Must not update',
    })).rejects.toThrow(/acceptance snapshot/i);
    expect(corrupted).toEqual(original);
  });

  it('rejects superseded accepted evidence that has not been marked for confirmation', async () => {
    const valid = await acceptedFact('existing-presence');
    const corrupted = structuredClone(valid);
    corrupted.knownFactLedger = correctKnownFact(corrupted.knownFactLedger, {
      id: 'corrected-fact',
      supersedesFactId: 'source-accepted-fact',
      value: 'Newer synthetic evidence',
      provenance: 'Fixture correction',
      expectedRevisionId: valid.revisionId,
      currentRevisionId: valid.revisionId,
    });
    const original = structuredClone(corrupted);
    await expect(applyKnownFact14EditForReview(corrupted, {
      kind: 'value', questionId: 'primary-goal', value: 'Must not mutate',
    })).rejects.toThrow(/superseded/i);
    expect(corrupted).toEqual(original);
  });

  it('validates the edited result and rejects a runtime-invalid value type', async () => {
    const valid = await migrateSemantic13ToKnownFact14(await createSemanticSession(
      generalDiscoveryPack, { clientLabel: 'Synthetic invalid edit' }, new Date(AT),
    ));
    const original = structuredClone(valid);
    // Deliberately bypass TypeScript at this boundary: a malformed caller must
    // not turn an invalid runtime value into a persisted 1.4 session.
    await expect(applyKnownFact14EditForReview(valid, {
      kind: 'value', questionId: 'needs-booking', value: 42 as unknown as string,
    })).rejects.toThrow(/answer value must be a string or null/i);
    expect(valid).toEqual(original);
  });

  it('retains an out-of-options answer as unresolved, not as authoritative capture', async () => {
    const valid = await migrateSemantic13ToKnownFact14(await createSemanticSession(
      generalDiscoveryPack, { clientLabel: 'Synthetic out-of-options' }, new Date(AT),
    ));
    const edited = await applyKnownFact14EditForReview(valid, {
      kind: 'value', questionId: 'needs-booking', value: 'Not a pinned option',
    });
    expect(edited.answers['needs-booking']).toMatchObject({
      value: 'Not a pinned option', resolution: 'unresolved', source: null,
    });
    expect(relevanceMap(edited)['booking-process']).toBe('pending');
  });
});

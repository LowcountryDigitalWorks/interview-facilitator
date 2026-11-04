import { describe, expect, it } from 'vitest';
import { applyStoredKnownFact14EditForReview, type KnownFact14EditStorageForReview } from '../src/known-fact-edit-workflow';
import { acceptKnownFact, projectAcceptedKnownFact } from '../src/known-fact-evidence';
import { validateKnownFactSession14Record, migrateSemantic13ToKnownFact14, type KnownFactSession14 } from '../src/known-fact-session';
import { createSemanticSession } from '../src/semantic-session';
import { generalDiscoveryPack } from '../src/pack';

const AT = '2026-11-04T20:00:00.000Z';
async function fixture(): Promise<KnownFactSession14> {
  const source = await createSemanticSession(generalDiscoveryPack, {
    clientLabel: 'Synthetic workflow test',
  }, new Date(AT));
  source.knownFacts.push({
    id: 'fact-a', label: 'Existing site', value: 'Old site',
    provenance: 'Synthetic evidence', questionId: 'existing-presence',
  });
  const session = await migrateSemantic13ToKnownFact14(source);
  session.knownFactLedger = acceptKnownFact(session.knownFactLedger, {
    id: 'accept-a', factId: 'fact-a', expectedRevisionId: session.revisionId,
    currentRevisionId: session.revisionId, acceptedAt: AT,
  });
  const projection = projectAcceptedKnownFact(session.knownFactLedger, 'accept-a', 'existing-presence', {
    kind: 'text',
  }, session.answers['existing-presence']!);
  session.answers['existing-presence'] = { ...session.answers['existing-presence']!, ...projection.answer };
  session.knownFactAnswerLinks['existing-presence'] = {
    kind: 'accepted', factId: 'fact-a', acceptanceId: 'accept-a',
  };
  return validateKnownFactSession14Record(session);
}

function mockStore(initial: KnownFactSession14) {
  let persisted = structuredClone(initial);
  let writes = 0;
  const store: KnownFact14EditStorageForReview = {
    async load() { return structuredClone(persisted); },
    async save(next, expectedRevisionId) {
      if (persisted.revisionId !== expectedRevisionId) throw new Error('Synthetic CAS conflict.');
      writes += 1;
      persisted = await validateKnownFactSession14Record({
        ...structuredClone(next),
        revisionId: 'synthetic-next-revision',
        parentRevisionId: expectedRevisionId,
      });
      return structuredClone(persisted);
    },
  };
  return { store, writes: () => writes, current: () => persisted };
}

describe('#34A3 internal 1.4 stored-edit workflow', () => {
  it('saves a correction using CAS and preserves the immutable acceptance ledger', async () => {
    const source = await fixture();
    const original = structuredClone(source);
    const mocks = mockStore(source);
    const result = await applyStoredKnownFact14EditForReview({
      sessionId: source.sessionId, expectedRevisionId: source.revisionId,
      edit: { kind: 'value', questionId: 'existing-presence', value: 'New site' },
    }, mocks.store);
    expect(result.kind).toBe('saved');
    if (result.kind !== 'saved') return;
    expect(result.session.revisionId).toBe('synthetic-next-revision');
    expect(result.session.parentRevisionId).toBe(source.revisionId);
    expect(result.session.answers['existing-presence']).toMatchObject({
      value: 'New site', source: 'client-statement',
    });
    expect(result.session.knownFactAnswerLinks['existing-presence']).toBeUndefined();
    expect(result.session.knownFactLedger).toEqual(original.knownFactLedger);
    expect(source).toEqual(original);
    expect(mocks.writes()).toBe(1);
  });

  it('reselecting accepted known context does not create a new revision or lose evidence', async () => {
    const source = await fixture();
    const mocks = mockStore(source);
    const result = await applyStoredKnownFact14EditForReview({
      sessionId: source.sessionId, expectedRevisionId: source.revisionId,
      edit: { kind: 'status', questionId: 'existing-presence', status: 'ALREADY_KNOWN' },
    }, mocks.store);
    expect(result).toMatchObject({ kind: 'unchanged', session: source });
    expect(mocks.writes()).toBe(0);
    expect(mocks.current()).toEqual(source);
  });

  it('rejects an earlier revision without modifying the active 1.4 row', async () => {
    const source = await fixture();
    const mocks = mockStore(source);
    const result = await applyStoredKnownFact14EditForReview({
      sessionId: source.sessionId, expectedRevisionId: 'older-tab-revision',
      edit: { kind: 'value', questionId: 'existing-presence', value: 'Old tab edit' },
    }, mocks.store);
    expect(result).toEqual({ kind: 'stale', actualRevisionId: source.revisionId });
    expect(mocks.writes()).toBe(0);
    expect(mocks.current()).toEqual(source);
  });

  it('does not confuse a missing record with a failed storage read', async () => {
    const source = await fixture();
    const missing = await applyStoredKnownFact14EditForReview({
      sessionId: source.sessionId, expectedRevisionId: source.revisionId,
      edit: { kind: 'value', questionId: 'existing-presence', value: 'X' },
    }, { load: async () => undefined, save: async () => { throw new Error('unreachable'); } });
    expect(missing).toEqual({ kind: 'missing' });
    await expect(applyStoredKnownFact14EditForReview({
      sessionId: source.sessionId, expectedRevisionId: source.revisionId,
      edit: { kind: 'value', questionId: 'existing-presence', value: 'X' },
    }, { load: async () => { throw new Error('Storage read failed'); }, save: async () => { throw new Error('unreachable'); } }))
      .rejects.toThrow('Storage read failed');
  });

  it('propagates a concurrent late save conflict and never claims success', async () => {
    const source = await fixture();
    const original = structuredClone(source);
    await expect(applyStoredKnownFact14EditForReview({
      sessionId: source.sessionId, expectedRevisionId: source.revisionId,
      edit: { kind: 'value', questionId: 'existing-presence', value: 'Later edit' },
    }, { load: async () => structuredClone(source), save: async () => { throw new Error('CAS changed during edit'); } }))
      .rejects.toThrow('CAS changed during edit');
    expect(source).toEqual(original);
  });

  it('refuses legacy 1.3 and mismatched session IDs rather than silently upgrading', async () => {
    const source = await fixture();
    const legacy = await createSemanticSession(generalDiscoveryPack, { clientLabel: 'Legacy' }, new Date(AT));
    await expect(applyStoredKnownFact14EditForReview({
      sessionId: legacy.sessionId, expectedRevisionId: legacy.revisionId,
      edit: { kind: 'value', questionId: 'primary-goal', value: 'Unsafe' },
    }, { load: async () => legacy as unknown as KnownFactSession14, save: async () => { throw new Error('unreachable'); } }))
      .rejects.toThrow(/schema version/i);
    await expect(applyStoredKnownFact14EditForReview({
      sessionId: 'wrong-session', expectedRevisionId: source.revisionId,
      edit: { kind: 'status', questionId: 'existing-presence', status: 'ANSWERED' },
    }, { load: async () => source, save: async () => { throw new Error('unreachable'); } }))
      .rejects.toThrow(/identity mismatches/i);
  });

  it('refuses malformed edit commands before a save and malformed returned lineage', async () => {
    const source = await fixture();
    const mocks = mockStore(source);
    await expect(applyStoredKnownFact14EditForReview({
      sessionId: source.sessionId, expectedRevisionId: source.revisionId,
      edit: { kind: 'status', questionId: 'existing-presence', status: 'INVALID' } as never,
    }, mocks.store)).rejects.toThrow(/command/i);
    expect(mocks.writes()).toBe(0);
    await expect(applyStoredKnownFact14EditForReview({
      sessionId: source.sessionId, expectedRevisionId: source.revisionId,
      edit: { kind: 'value', questionId: 'existing-presence', value: 'Different' },
    }, {
      load: async () => source,
      save: async next => ({ ...next, revisionId: 'invalid-revision' }),
    })).rejects.toThrow(/parent-linked revision/i);
  });

  it('rejects blank session and revision IDs before any read or save', async () => {
    const source = await fixture();
    let reads = 0;
    const store: KnownFact14EditStorageForReview = {
      async load() { reads += 1; return source; },
      async save() { throw new Error('Unexpected write'); },
    };
    for (const IDs of [
      { sessionId: '  ', expectedRevisionId: source.revisionId },
      { sessionId: source.sessionId, expectedRevisionId: '  ' },
    ]) {
      await expect(applyStoredKnownFact14EditForReview({
        ...IDs, edit: { kind: 'value', questionId: 'existing-presence', value: 'Unsafe' },
      }, store)).rejects.toThrow(/requires a session ID and expected revision/);
    }
    expect(reads).toBe(0);
  });

  it('rejects a valid new revision that silently returns stale unedited answers', async () => {
    const source = await fixture();
    const before = structuredClone(source);
    const operation = applyStoredKnownFact14EditForReview({
      sessionId: source.sessionId, expectedRevisionId: source.revisionId,
      edit: { kind: 'value', questionId: 'existing-presence', value: 'New site' },
    }, {
      load: async () => structuredClone(source),
      save: async () => ({
        ...structuredClone(source),
        revisionId: 'synthetic-new-revision',
        parentRevisionId: source.revisionId,
      }),
    });
    await expect(operation).rejects.toThrow(/returned content that differs/);
    expect(source).toEqual(before);
  });

  it('rejects a valid saved revision with an unrelated field altered by the adapter', async () => {
    const source = await fixture();
    await expect(applyStoredKnownFact14EditForReview({
      sessionId: source.sessionId, expectedRevisionId: source.revisionId,
      edit: { kind: 'value', questionId: 'existing-presence', value: 'New site' },
    }, {
      load: async () => structuredClone(source),
      save: async (next) => ({
        ...structuredClone(next),
        clientLabel: 'Incorrect synthetic label',
        revisionId: 'synthetic-new-revision',
        parentRevisionId: source.revisionId,
      }),
    })).rejects.toThrow(/returned content that differs/);
  });

  it('rejects a new revision that changes the session identity', async () => {
    const source = await fixture();
    await expect(applyStoredKnownFact14EditForReview({
      sessionId: source.sessionId, expectedRevisionId: source.revisionId,
      edit: { kind: 'value', questionId: 'existing-presence', value: 'New site' },
    }, {
      load: async () => structuredClone(source),
      save: async (next) => ({
        ...structuredClone(next),
        sessionId: 'different-synthetic-session',
        revisionId: 'synthetic-new-revision',
        parentRevisionId: source.revisionId,
      }),
    })).rejects.toThrow(/parent-linked revision/);
  });
});

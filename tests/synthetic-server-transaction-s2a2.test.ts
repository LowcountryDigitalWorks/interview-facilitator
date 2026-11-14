import { describe, expect, it } from 'vitest';
import { createSemanticSession } from '../src/semantic-session';
import { generalDiscoveryPack } from '../src/pack';
import { prepareSyntheticRevisionOffer, type SyntheticSyncOffer } from '../src/synthetic-sync-plan';
import {
  SYNTHETIC_RELAY_PROTOCOL,
  type SyntheticRelayAppendRequest,
  type SyntheticRelayScope,
} from '../src/synthetic-protected-relay-policy-s2a';
import { SyntheticMetadataServerTransactionTrial } from '../src/synthetic-server-transaction-s2a2';

const ACTOR = 'synthetic-operator';
const PRIVATE_NOTE = 'SYNTHETIC CONFIDENTIAL INTERVIEW NEVER REMOTE';
const PRIVATE_CLIENT = 'SYNTHETIC PRIVATE CLIENT NAME';

async function sample() {
  const source = await createSemanticSession(generalDiscoveryPack, {
    clientLabel: PRIVATE_CLIENT,
  }, new Date('2026-11-14T08:00:00.000Z'));
  source.runningNotes = PRIVATE_NOTE;
  const root = await prepareSyntheticRevisionOffer(source);
  const scope: SyntheticRelayScope = {
    tenantId: 'synthetic-tenant',
    clientId: 'synthetic-client',
    engagementId: 'synthetic-engagement',
    sessionId: source.sessionId,
  };
  const service = new SyntheticMetadataServerTransactionTrial();
  await service.setSyntheticGrantForTest(ACTOR, scope, 'active', 'active', ['append', 'read']);
  return { source, root, scope, service };
}

function request(
  scope: SyntheticRelayScope,
  offer: SyntheticSyncOffer,
  expected: string | null,
): SyntheticRelayAppendRequest {
  return {
    protocol: SYNTHETIC_RELAY_PROTOCOL, scope,
    offer, expectedRemoteRevisionId: expected,
  };
}

async function child(
  source: Awaited<ReturnType<typeof createSemanticSession>>,
  id: string,
  note: string,
): Promise<SyntheticSyncOffer> {
  return prepareSyntheticRevisionOffer({
    ...source,
    revisionId: id,
    parentRevisionId: source.revisionId,
    runningNotes: note,
  });
}

describe('S2A-2 isolated synthetic server-side CAS + receipt simulator (NO HTTP/PROVIDER)', () => {
  it('commits root metadata and scoped receipt together, then retries exactly once', async () => {
    const f = await sample();
    const sent = request(f.scope, f.root, null);
    const first = await f.service.appendForTest(ACTOR, f.scope, sent);
    expect(first).toEqual({ kind: 'synthetic-committed', operationId: f.root.operationId });
    const retry = await f.service.appendForTest(ACTOR, f.scope, sent);
    expect(retry).toEqual({ kind: 'synthetic-replayed', operationId: f.root.operationId });
    const current = f.service.snapshotForTest(f.scope);
    expect(current.current).toEqual(f.root.head);
    expect(current.revisions).toEqual([f.root.head]);
    expect(current.receiptOperationIds).toEqual([f.root.operationId]);
    const shown = JSON.stringify({ first, retry, current });
    expect(shown).not.toContain(PRIVATE_CLIENT);
    expect(shown).not.toContain(PRIVATE_NOTE);
    expect(shown).not.toContain('answers');
  });

  it('two concurrent sibling writers race within one scoped lock: exactly one wins', async () => {
    const f = await sample();
    await f.service.appendForTest(ACTOR, f.scope, request(f.scope, f.root, null));
    const desktop = await child(f.source, 'synthetic-desktop-next', 'SYNTHETIC DESKTOP PRIVATE NOTE');
    const mobile = await child(f.source, 'synthetic-mobile-next', 'SYNTHETIC MOBILE PRIVATE NOTE');
    const [a, b] = await Promise.all([
      f.service.appendForTest(ACTOR, f.scope,
        request(f.scope, desktop, f.root.head.revisionId)),
      f.service.appendForTest(ACTOR, f.scope,
        request(f.scope, mobile, f.root.head.revisionId)),
    ]);
    const kinds = [a.kind, b.kind].sort();
    expect(kinds).toEqual(['synthetic-committed', 'synthetic-conflict-preserved'].sort());
    const outcome = f.service.snapshotForTest(f.scope);
    expect(outcome.revisions).toHaveLength(2); // root + one sibling, never both
    expect(outcome.receiptOperationIds).toHaveLength(2);
    const winner = a.kind === 'synthetic-committed' ? desktop : mobile;
    const loser = a.kind === 'synthetic-committed' ? mobile : desktop;
    expect(outcome.current).toEqual(winner.head);
    const conflict = a.kind === 'synthetic-conflict-preserved' ? a : b;
    expect(conflict).toMatchObject({
      current: winner.head, offered: loser.head,
    });
    // The losing branch still exists on its originating offline device.
    // This simulator never receives the private losing snapshot or discards it.
    expect(JSON.stringify(outcome)).not.toContain('PRIVATE NOTE');
  });

  it('aborted simulated transaction leaves NO current, history or receipt, then retry can commit', async () => {
    const f = await sample();
    const offered = request(f.scope, f.root, null);
    expect(await f.service.appendForTest(ACTOR, f.scope, offered, 'before-commit'))
      .toEqual({ kind: 'synthetic-aborted-before-commit' });
    expect(f.service.snapshotForTest(f.scope)).toEqual({
      current: null, revisions: [], receiptOperationIds: [],
    });
    expect((await f.service.appendForTest(ACTOR, f.scope, offered)).kind)
      .toBe('synthetic-committed');
    expect(f.service.snapshotForTest(f.scope).revisions).toHaveLength(1);
  });

  it('lost reply AFTER a synthetic commit retains receipt and returns replay on next request', async () => {
    const f = await sample();
    const offered = request(f.scope, f.root, null);
    expect(await f.service.appendForTest(ACTOR, f.scope, offered, 'after-commit-before-reply'))
      .toEqual({ kind: 'synthetic-reply-lost-after-commit' });
    expect(f.service.snapshotForTest(f.scope)).toMatchObject({
      current: f.root.head, receiptOperationIds: [f.root.operationId],
    });
    expect((await f.service.appendForTest(ACTOR, f.scope, offered)).kind)
      .toBe('synthetic-replayed');
    expect(f.service.snapshotForTest(f.scope).revisions).toHaveLength(1);
  });

  it('permission revocation is reevaluated on every request, including a receipt replay', async () => {
    const f = await sample();
    const sent = request(f.scope, f.root, null);
    await f.service.appendForTest(ACTOR, f.scope, sent);
    await f.service.setSyntheticGrantForTest(ACTOR, f.scope, 'active', 'revoked', ['append']);
    expect(await f.service.appendForTest(ACTOR, f.scope, sent)).toEqual({ kind: 'deny' });
    await f.service.setSyntheticGrantForTest(ACTOR, f.scope, 'revoked', 'active', ['append']);
    expect(await f.service.appendForTest(ACTOR, f.scope, sent)).toEqual({ kind: 'deny' });
    await f.service.setSyntheticGrantForTest(ACTOR, f.scope, 'active', 'active', ['read']);
    expect(await f.service.appendForTest(ACTOR, f.scope, sent)).toEqual({ kind: 'deny' });
    expect(f.service.snapshotForTest(f.scope).receiptOperationIds).toEqual([f.root.operationId]);
    await f.service.setSyntheticGrantForTest(ACTOR, f.scope, 'active', 'active', ['append']);
    expect((await f.service.appendForTest(ACTOR, f.scope, sent)).kind).toBe('synthetic-replayed');
  });

  it('requires an exact scoped grant: one tenant cannot request another engagement or client head', async () => {
    const f = await sample();
    await f.service.appendForTest(ACTOR, f.scope, request(f.scope, f.root, null));
    for (const key of ['tenantId', 'clientId', 'engagementId', 'sessionId'] as const) {
      const other = { ...f.scope, [key]: 'synthetic-other' };
      expect(await f.service.appendForTest(ACTOR, other, request(other, f.root, null)))
        .toEqual({ kind: 'deny' });
      expect(f.service.snapshotForTest(other)).toEqual({
        current: null, revisions: [], receiptOperationIds: [],
      });
      expect(await f.service.appendForTest(ACTOR, f.scope, request(other, f.root, null)))
        .toEqual({ kind: 'deny' });
    }
    expect(f.service.snapshotForTest(f.scope).revisions).toHaveLength(1);
  });

  it('keeps deterministic same-op retries scoped: same revision metadata may exist in different synthetic engagements', async () => {
    const f = await sample();
    const elsewhere = { ...f.scope, engagementId: 'synthetic-second-engagement' };
    await f.service.setSyntheticGrantForTest(ACTOR, elsewhere, 'active', 'active', ['append']);
    expect((await f.service.appendForTest(
      ACTOR, f.scope, request(f.scope, f.root, null),
    )).kind).toBe('synthetic-committed');
    expect((await f.service.appendForTest(
      ACTOR, elsewhere, request(elsewhere, f.root, null),
    )).kind).toBe('synthetic-committed');
    expect(f.service.snapshotForTest(f.scope).receiptOperationIds).toEqual([f.root.operationId]);
    expect(f.service.snapshotForTest(elsewhere).receiptOperationIds).toEqual([f.root.operationId]);
  });

  it('rejects malformed caller metadata, forged operation ID and hostile accessors without mutation', async () => {
    const f = await sample();
    const good = request(f.scope, f.root, null);
    let getterExecuted = 0;
    const getter = { ...good };
    Object.defineProperty(getter, 'offer', {
      enumerable: true,
      get() {
        getterExecuted++;
        throw new Error('SYNTHETIC SECRET ACCESSOR');
      },
    });
    for (const raw of [
      getter,
      { ...good, offer: { ...f.root, operationId: 'a'.repeat(64) } },
      { ...good, extraAdmin: true },
      { ...good, offer: { ...f.root, head: { ...f.root.head, sessionSchemaVersion: '1.4.0' } } },
      { ...good, expectedRemoteRevisionId: 'wrong' },
      null,
    ]) {
      expect(await f.service.appendForTest(ACTOR, f.scope, raw)).toEqual({ kind: 'deny' });
    }
    expect(getterExecuted).toBe(0);
    expect(f.service.snapshotForTest(f.scope)).toEqual({
      current: null, revisions: [], receiptOperationIds: [],
    });
    expect((await f.service.appendForTest(ACTOR, f.scope, good)).kind)
      .toBe('synthetic-committed');
  });

  it('never reuses an earlier revision ID as a new head, even when its immediate parent matches', async () => {
    const f = await sample();
    await f.service.appendForTest(ACTOR, f.scope, request(f.scope, f.root, null));
    const first = await child(f.source, 'synthetic-1', 'SYNTHETIC FIRST');
    expect((await f.service.appendForTest(ACTOR, f.scope,
      request(f.scope, first, f.root.head.revisionId))).kind).toBe('synthetic-committed');
    const second = await prepareSyntheticRevisionOffer({
      ...f.source,
      revisionId: 'synthetic-2', parentRevisionId: first.head.revisionId,
      runningNotes: 'SYNTHETIC SECOND',
    });
    expect((await f.service.appendForTest(ACTOR, f.scope,
      request(f.scope, second, first.head.revisionId))).kind).toBe('synthetic-committed');
    const reused = await prepareSyntheticRevisionOffer({
      ...f.source,
      revisionId: first.head.revisionId, parentRevisionId: second.head.revisionId,
      runningNotes: 'SYNTHETIC REUSED ID DIFF CONTENT',
    });
    const collision = await f.service.appendForTest(
      ACTOR, f.scope, request(f.scope, reused, second.head.revisionId),
    );
    expect(collision.kind).toBe('synthetic-conflict-preserved');
    const state = f.service.snapshotForTest(f.scope);
    expect(state.current).toEqual(second.head);
    expect(state.revisions).toHaveLength(3);
    expect(state.receiptOperationIds).toHaveLength(3);
  });

  it('duplicate concurrent retries produce one synthetic commit, one replay and one receipt', async () => {
    const f = await sample();
    const sent = request(f.scope, f.root, null);
    const results = await Promise.all([
      f.service.appendForTest(ACTOR, f.scope, sent),
      f.service.appendForTest(ACTOR, f.scope, sent),
    ]);
    expect(results.map(x => x.kind).sort())
      .toEqual(['synthetic-committed', 'synthetic-replayed'].sort());
    expect(f.service.snapshotForTest(f.scope)).toMatchObject({
      current: f.root.head, receiptOperationIds: [f.root.operationId],
    });
  });

  it('a failed or revoked request cannot expose stored remote revision identifiers', async () => {
    const f = await sample();
    const sent = request(f.scope, f.root, null);
    await f.service.appendForTest(ACTOR, f.scope, sent);
    for (const actor of ['synthetic-stranger', '', '<script>']) {
      const result = await f.service.appendForTest(actor, f.scope, sent);
      expect(result).toEqual({ kind: 'deny' });
      expect(JSON.stringify(result)).not.toContain(f.source.sessionId);
      expect(JSON.stringify(result)).not.toContain(f.root.head.snapshotDigest);
    }
  });
});

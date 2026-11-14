import { describe, expect, it } from 'vitest';
import { createSemanticSession } from '../src/semantic-session';
import { generalDiscoveryPack } from '../src/pack';
import { prepareSyntheticRevisionOffer, type SyntheticSyncOffer } from '../src/synthetic-sync-plan';
import {
  SYNTHETIC_RELAY_PROTOCOL,
  planSyntheticProtectedRelayAppend,
  type SyntheticRelayAppendRequest,
  type SyntheticRelayScope,
  type SyntheticServerPolicySnapshot,
  type SyntheticServerStoredSnapshot,
} from '../src/synthetic-protected-relay-policy-s2a';

const scope: SyntheticRelayScope = {
  tenantId: 'synthetic-tenant-01',
  clientId: 'synthetic-client-01',
  engagementId: 'synthetic-engagement-01',
  sessionId: 'placeholder',
};

function policy(forScope: SyntheticRelayScope): SyntheticServerPolicySnapshot {
  return {
    source: 'server-policy-test-fixture',
    actorId: 'synthetic-interviewer-01',
    scope: forScope,
    actorState: 'active',
    assignmentState: 'active',
    actions: ['append', 'read'],
  };
}

function stored(forScope: SyntheticRelayScope): SyntheticServerStoredSnapshot {
  return { scope: forScope, current: null, replayReceipt: null };
}

async function fixture() {
  const source = await createSemanticSession(
    generalDiscoveryPack,
    { clientLabel: 'SYNTHETIC SENSITIVE CUSTOMER NOT TO BE IN RELAY OUTPUT' },
    new Date('2026-11-14T04:00:00.000Z'),
  );
  source.runningNotes = 'SYNTHETIC PRIVATE NOTES NEVER IN RELAY METADATA';
  const root = await prepareSyntheticRevisionOffer(source);
  const resource = { ...scope, sessionId: source.sessionId };
  const request: SyntheticRelayAppendRequest = {
    protocol: SYNTHETIC_RELAY_PROTOCOL,
    scope: resource,
    offer: root,
    expectedRemoteRevisionId: null,
  };
  return { source, root, resource, request, grant: policy(resource), remote: stored(resource) };
}

async function child(
  source: Awaited<ReturnType<typeof createSemanticSession>>,
  revisionId: string,
  note: string,
): Promise<SyntheticSyncOffer> {
  return prepareSyntheticRevisionOffer({
    ...source, parentRevisionId: source.revisionId, revisionId,
    runningNotes: note,
  });
}

describe('S2A synthetic-only per-engagement authorization and remote CAS planner', () => {
  it('proposes a bounded initial append only with matching active per-session authorization', async () => {
    const f = await fixture();
    const decision = await planSyntheticProtectedRelayAppend(f.request, f.grant, f.remote);
    expect(decision).toMatchObject({
      kind: 'candidate-append',
      expectedRemoteRevisionId: null,
      next: f.root.head,
    });
    const serialized = JSON.stringify(decision);
    expect(serialized).not.toContain(f.source.clientLabel);
    expect(serialized).not.toContain(f.source.runningNotes);
    expect(serialized).not.toContain('answers');
  });

  it('enforces exact tenant, client, engagement, and session access, never merely the same tenant', async () => {
    const f = await fixture();
    for (const key of ['tenantId', 'clientId', 'engagementId', 'sessionId'] as const) {
      const wrongScope = { ...f.grant.scope, [key]: 'synthetic-other-resource' };
      const wrongPolicy = { ...f.grant, scope: wrongScope };
      expect(await planSyntheticProtectedRelayAppend(f.request, wrongPolicy, f.remote))
        .toEqual({ kind: 'deny' });
      const wrongStored = { ...f.remote, scope: wrongScope };
      expect(await planSyntheticProtectedRelayAppend(f.request, f.grant, wrongStored))
        .toEqual({ kind: 'deny' });
    }
    const wrongSessionRequest = {
      ...f.request, scope: { ...f.request.scope, sessionId: 'synthetic-other-session' },
    };
    expect(await planSyntheticProtectedRelayAppend(wrongSessionRequest, f.grant, f.remote))
      .toEqual({ kind: 'deny' });
  });

  it('denies revoked actors, revoked assignments, missing append, or an unverified policy marker', async () => {
    const f = await fixture();
    for (const gate of [
      { ...f.grant, actorState: 'revoked' },
      { ...f.grant, assignmentState: 'revoked' },
      { ...f.grant, actions: ['read'] },
      { ...f.grant, actions: [] },
      { ...f.grant, actions: ['append', 'append'] },
      { ...f.grant, source: 'browser-asserted' },
      { ...f.grant, actorId: '<img onerror=alert(1)>' },
      { ...f.grant, extraPermission: 'admin' },
      null,
    ]) {
      const result = await planSyntheticProtectedRelayAppend(f.request, gate, f.remote);
      expect(result).toEqual({ kind: 'deny' });
    }
  });

  it('requires a true immediate-parent CAS; stale expected revision never silently overwrites', async () => {
    const f = await fixture();
    const next = await child(f.source, 'synthetic-desktop-rev-01', 'SYNTHETIC DESKTOP EDIT');
    const proposed: SyntheticRelayAppendRequest = {
      ...f.request, offer: next, expectedRemoteRevisionId: f.root.head.revisionId,
    };
    const committed = { ...f.remote, current: f.root.head };
    expect(await planSyntheticProtectedRelayAppend(proposed, f.grant, committed)).toMatchObject({
      kind: 'candidate-append', expectedRemoteRevisionId: f.root.head.revisionId,
      next: next.head,
    });
    expect((await planSyntheticProtectedRelayAppend(
      { ...proposed, expectedRemoteRevisionId: null }, f.grant, committed,
    )).kind).toBe('candidate-conflict-preserve');
    expect((await planSyntheticProtectedRelayAppend(
      { ...proposed, expectedRemoteRevisionId: 'stale-other' }, f.grant, committed,
    )).kind).toBe('candidate-conflict-preserve');
    expect((await planSyntheticProtectedRelayAppend(
      proposed, f.grant, { ...committed, current: next.head },
    )).kind).toBe('candidate-conflict-preserve');
  });

  it('preserves two siblings and their immutable heads when remote advanced while the device was offline', async () => {
    const f = await fixture();
    const left = await child(f.source, 'synthetic-offline-left', 'SYNTHETIC PRIVATE LEFT');
    const right = await child(f.source, 'synthetic-offline-right', 'SYNTHETIC PRIVATE RIGHT');
    const request: SyntheticRelayAppendRequest = {
      ...f.request, offer: right, expectedRemoteRevisionId: f.root.head.revisionId,
    };
    const decision = await planSyntheticProtectedRelayAppend(
      request, f.grant, { ...f.remote, current: left.head },
    );
    expect(decision).toMatchObject({
      kind: 'candidate-conflict-preserve',
      current: left.head,
      offered: right.head,
    });
    expect(JSON.stringify(decision)).not.toContain('SYNTHETIC PRIVATE');
  });

  it('does not equate an unauthenticated duplicate operation with verified server durability', async () => {
    const f = await fixture();
    const unchanged = { ...f.remote, current: f.root.head };
    const noReceipt = await planSyntheticProtectedRelayAppend(f.request, f.grant, unchanged);
    expect(noReceipt.kind).toBe('candidate-conflict-preserve');
    const validReceipt = {
      scope: f.resource,
      operationId: f.root.operationId,
      revisionId: f.root.head.revisionId,
      snapshotDigest: f.root.head.snapshotDigest,
      committed: true,
    };
    const candidate = await planSyntheticProtectedRelayAppend(
      f.request, f.grant, { ...unchanged, replayReceipt: validReceipt },
    );
    expect(candidate).toEqual({ kind: 'candidate-replay', operationId: f.root.operationId });
    // The real service must fetch the stored receipt from its own protected
    // database; this synthetic object is NOT an authenticated ACK.
  });

  it('denies forged or cross-engagement receipts even with matching operation IDs', async () => {
    const f = await fixture();
    const receipt = {
      scope: f.resource,
      operationId: f.root.operationId,
      revisionId: f.root.head.revisionId,
      snapshotDigest: f.root.head.snapshotDigest,
      committed: true,
    };
    for (const injected of [
      { ...receipt, scope: { ...f.resource, engagementId: 'other-engagement' } },
      { ...receipt, operationId: 'f'.repeat(64) },
      { ...receipt, revisionId: 'not-the-revision' },
      { ...receipt, snapshotDigest: 'e'.repeat(64) },
      { ...receipt, committed: false },
      { ...receipt, clientLabel: 'SYNTHETIC PRIVATE EXTRA' },
    ]) {
      expect(await planSyntheticProtectedRelayAppend(
        f.request, f.grant, { ...f.remote, replayReceipt: injected },
      )).toEqual({ kind: 'deny' });
    }
  });

  it('rejects forged operation IDs and malformed/extra fields without returning stored client metadata', async () => {
    const f = await fixture();
    const invalid = [
      { ...f.request, offer: { ...f.root, operationId: 'a'.repeat(64) } },
      { ...f.request, offer: { ...f.root, extra: 'SYNTHETIC PRIVATE' } },
      { ...f.request, offer: { ...f.root, head: { ...f.root.head, unknown: 'X' } } },
      { ...f.request, offer: { ...f.root, head: { ...f.root.head, sessionSchemaVersion: '1.4.0' } } },
      { ...f.request, offer: { ...f.root, head: { ...f.root.head, revisionId: '<script>' } } },
      { ...f.request, extra: 'SYNTHETIC PRIVATE TEXT' },
      { ...f.request, expectedRemoteRevisionId: 1 },
      { ...f.request, expectedRemoteRevisionId: 'x'.repeat(129) },
      { ...f.request, scope: { ...f.resource, clientId: '' } },
      { ...f.request, scope: { ...f.resource, extra: true } },
      [],
      null,
    ];
    for (const proposal of invalid) {
      expect(await planSyntheticProtectedRelayAppend(proposal, f.grant, f.remote))
        .toEqual({ kind: 'deny' });
    }
  });

  it('rejects a mismatched pack or invalid server state before proposing an append', async () => {
    const f = await fixture();
    const next = await child(f.source, 'synthetic-s2a-next', 'synthetic next');
    const request = {
      ...f.request, offer: next, expectedRemoteRevisionId: f.root.head.revisionId,
    };
    const mismatched = {
      ...f.root.head, packDigest: '0'.repeat(64),
    };
    expect((await planSyntheticProtectedRelayAppend(
      request, f.grant, { ...f.remote, current: mismatched },
    )).kind).toBe('candidate-conflict-preserve');
    for (const remote of [
      { ...f.remote, current: { ...f.root.head, sessionId: 'other-session' } },
      { ...f.remote, current: { ...f.root.head, sessionSchemaVersion: '1.4.0' } },
      { ...f.remote, current: { ...f.root.head, extra: 1 } },
      { ...f.remote, unknown: true },
      null,
    ]) {
      expect(await planSyntheticProtectedRelayAppend(request, f.grant, remote))
        .toEqual({ kind: 'deny' });
    }
  });

  it('rejects hostile getter properties without executing an accessor or leaking protected heads', async () => {
    const f = await fixture();
    let touched = 0;
    const hostile = { ...f.request };
    Object.defineProperty(hostile, 'offer', {
      configurable: true, enumerable: true,
      get() {
        touched += 1;
        throw new Error('SYNTHETIC PRIVATE GETTER MUST NOT RUN');
      },
    });
    expect(await planSyntheticProtectedRelayAppend(hostile, f.grant, f.remote))
      .toEqual({ kind: 'deny' });
    const hostileGate = { ...f.grant };
    Object.defineProperty(hostileGate, 'scope', {
      configurable: true, enumerable: true,
      get() {
        touched += 1;
        return f.resource;
      },
    });
    expect(await planSyntheticProtectedRelayAppend(f.request, hostileGate, f.remote))
      .toEqual({ kind: 'deny' });
    expect(touched).toBe(0);
  });

  it('requires new-session initialization to have no existing remote and no claimed parent', async () => {
    const f = await fixture();
    const next = await child(f.source, 'synthetic-child-revision', 'synthetic child');
    expect(await planSyntheticProtectedRelayAppend(
      { ...f.request, expectedRemoteRevisionId: 'synthetic-not-found' },
      f.grant, f.remote,
    )).toEqual({ kind: 'deny' });
    expect(await planSyntheticProtectedRelayAppend(
      { ...f.request, offer: next },
      f.grant, f.remote,
    )).toEqual({ kind: 'deny' });
  });

  it('shows why provider-side atomic CAS is needed: two candidate writes cannot both commit', async () => {
    const f = await fixture();
    const left = await child(f.source, 'synthetic-competing-left', 'LEFT');
    const right = await child(f.source, 'synthetic-competing-right', 'RIGHT');
    const makeRequest = (offer: SyntheticSyncOffer) => ({
      ...f.request, offer, expectedRemoteRevisionId: f.root.head.revisionId,
    });
    const state = { ...f.remote, current: f.root.head };
    const candidates = await Promise.all([
      planSyntheticProtectedRelayAppend(makeRequest(left), f.grant, state),
      planSyntheticProtectedRelayAppend(makeRequest(right), f.grant, state),
    ]);
    expect(candidates.map(x => x.kind)).toEqual(['candidate-append', 'candidate-append']);
    // Test code pretends the server serialized the first accepted CAS.
    const afterFirst = { ...state, current: left.head };
    expect((await planSyntheticProtectedRelayAppend(
      makeRequest(right), f.grant, afterFirst,
    )).kind).toBe('candidate-conflict-preserve');
    // The pure planner alone cannot serialize real requests or prove durability.
  });
});

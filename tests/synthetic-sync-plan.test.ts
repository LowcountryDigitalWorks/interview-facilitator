import { describe, expect, it } from 'vitest';
import { generalDiscoveryPack } from '../src/pack';
import { createSemanticSession } from '../src/semantic-session';
import {
  evaluateSyntheticDurableAck,
  planSyntheticRevisionReconciliation,
  prepareSyntheticRevisionOffer,
  SYNTHETIC_SYNC_MAX_CANONICAL_BYTES,
} from '../src/synthetic-sync-plan';

async function session() {
  const value = await createSemanticSession(generalDiscoveryPack, {
    clientLabel: 'SYNTHETIC PRIVATE CLIENT NEVER SYNCHRONIZED',
  }, new Date('2026-11-14T01:00:00.000Z'));
  value.runningNotes = 'SYNTHETIC CONFIDENTIAL NOTES NOT IN HEAD';
  return value;
}

async function relatedOffer(parent: Awaited<ReturnType<typeof session>>, revisionId: string, note: string) {
  return prepareSyntheticRevisionOffer({
    ...parent, revisionId, parentRevisionId: parent.revisionId, runningNotes: note,
  });
}

describe('synthetic S1 metadata-only offline sync planner (never wired to live PWA)', () => {
  it('pins canonical 1.3 revision metadata and idempotent operation IDs without client content', async () => {
    const input = await session();
    const a = await prepareSyntheticRevisionOffer(input);
    const b = await prepareSyntheticRevisionOffer(structuredClone(input));
    expect(a).toEqual(b);
    expect(a.operationId).toMatch(/^[a-f0-9]{64}$/);
    expect(a.head).toMatchObject({
      protocolVersion: 'synthetic-sync-v1', sessionSchemaVersion: '1.3.0',
      sessionId: input.sessionId, revisionId: input.revisionId,
      parentRevisionId: null, packDigest: input.packIdentity.digest,
    });
    expect(JSON.stringify(a)).not.toContain(input.clientLabel);
    expect(JSON.stringify(a)).not.toContain(input.runningNotes);
    expect(JSON.stringify(a)).not.toContain('answers');
    const edited = structuredClone(input);
    edited.runningNotes = 'SYNTHETIC UPDATED PRIVATE NOTES';
    const changed = await prepareSyntheticRevisionOffer(edited);
    expect(changed.head.snapshotDigest).not.toBe(a.head.snapshotDigest);
    expect(changed.operationId).not.toBe(a.operationId);
  });

  it('requires valid 1.3 source and exact maximum canonical size, not an unsupported new schema', async () => {
    const valid = await session();
    await expect(prepareSyntheticRevisionOffer({ ...valid, sessionSchemaVersion: '1.4.0' }))
      .rejects.toThrow();
    await expect(prepareSyntheticRevisionOffer({ ...valid, extraneousSecret: 'SYNTHETIC' }))
      .rejects.toThrow();
    await expect(prepareSyntheticRevisionOffer({
      ...valid, runningNotes: 'x'.repeat(SYNTHETIC_SYNC_MAX_CANONICAL_BYTES),
    })).rejects.toThrow('source-only limit');
  });

  it('plans local initial offer, current exact alignment, and one-revision upload with no remote effects', async () => {
    const input = await session();
    const base = (await prepareSyntheticRevisionOffer(input)).head;
    expect(planSyntheticRevisionReconciliation(base, null, false)).toMatchObject({ kind: 'offer-local' });
    expect(planSyntheticRevisionReconciliation(base, base, false)).toMatchObject({ kind: 'already-aligned' });
    const next = (await relatedOffer(input, 'synthetic-revision-next', 'SYNTHETIC NEXT')).head;
    expect(planSyntheticRevisionReconciliation(next, base, false)).toMatchObject({ kind: 'offer-local' });
    expect(planSyntheticRevisionReconciliation(base, next, false)).toMatchObject({ kind: 'review-remote' });
  });

  it('holds dirty local edits rather than pulling or offering even when remote looks new', async () => {
    const input = await session();
    const base = (await prepareSyntheticRevisionOffer(input)).head;
    const next = (await relatedOffer(input, 'synthetic-remote-01', 'SYNTHETIC REMOTE')).head;
    expect(planSyntheticRevisionReconciliation(base, next, true)).toMatchObject({ kind: 'hold-unsaved-local' });
    expect(planSyntheticRevisionReconciliation(base, null, true)).toMatchObject({ kind: 'invalid-or-incompatible' });
  });

  it('preserves diverged offline branches and rejects same-revision digest collisions', async () => {
    const input = await session();
    const left = (await relatedOffer(input, 'synthetic-desktop-01', 'DESKTOP OFFLINE')).head;
    const right = (await relatedOffer(input, 'synthetic-mobile-01', 'MOBILE OFFLINE')).head;
    const result = planSyntheticRevisionReconciliation(left, right, false);
    expect(result).toMatchObject({ kind: 'preserve-conflict', local: left, remote: right });
    const tampered = { ...left, snapshotDigest: right.snapshotDigest };
    expect(planSyntheticRevisionReconciliation(left, tampered, false).kind).toBe('preserve-conflict');
    expect(planSyntheticRevisionReconciliation(right, left, true).kind).toBe('hold-unsaved-local');
  });

  it('fails closed on mixed client identities, untrusted/extra properties, pack mismatch and 1.4', async () => {
    const input = await session();
    const local = (await prepareSyntheticRevisionOffer(input)).head;
    const remote = (await relatedOffer(input, 'synthetic-remote-02', 'REMOTE')).head;
    for (const untrusted of [
      { ...remote, sessionId: 'other-client' },
      { ...remote, packDigest: '0'.repeat(64) },
      { ...remote, sessionSchemaVersion: '1.4.0' },
      { ...remote, extra: 'no' },
      { ...remote, revisionId: '<img src=x>' },
      { ...remote, parentRevisionId: remote.revisionId },
      undefined,
    ]) {
      expect(planSyntheticRevisionReconciliation(local, untrusted, false).kind)
        .toBe('invalid-or-incompatible');
    }
    expect(planSyntheticRevisionReconciliation(null, remote, false).kind)
      .toBe('invalid-or-incompatible');
  });

  it('matches only a complete deliberate synthetic durable ACK; never grants actual SYNCED', async () => {
    const offer = await prepareSyntheticRevisionOffer(await session());
    const ack = {
      operationId: offer.operationId,
      sessionId: offer.head.sessionId,
      revisionId: offer.head.revisionId,
      snapshotDigest: offer.head.snapshotDigest,
      committed: true,
    };
    expect(evaluateSyntheticDurableAck(offer, ack)).toBe('candidate-ack-matched');
    for (const bad of [
      null, undefined, { ...ack, committed: false }, { ...ack, operationId: '0'.repeat(64) },
      { ...ack, snapshotDigest: '0'.repeat(64) }, { ...ack, extra: true },
      { ...ack, revisionId: 'wrong' }, { ...ack, sessionId: 'different' },
    ]) expect(evaluateSyntheticDurableAck(offer, bad)).toBe('retain-queued');
  });
});

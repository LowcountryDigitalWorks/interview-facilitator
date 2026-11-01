import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateSessionForPack } from '../src/domain';
import { canonicalizeJson, createPinnedSession, sha256Hex } from '../src/pack-identity';
import { generalDiscoveryPack as pack } from '../src/pack';
import { buildRecoveryBackup, buildUnsupportedRecoveryBackup, classifyStoredSessionRows, exportRecoveryBackup, partitionStoredSessionRows } from '../src/storage';
import { openStoredSession } from '../src/session-durability';

describe('stored session quarantine', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('classifies current, migratable, recoverable, and malformed rows without changing them', async () => {
    const current = await createPinnedSession(pack, { clientLabel: 'Current' });
    const legacy = { ...structuredClone(current), sessionSchemaVersion: '1.1.0' };
    delete legacy.packSnapshot.ruleSemanticsVersion;
    legacy.packIdentity.digest = await sha256Hex(canonicalizeJson(legacy.packSnapshot));
    const unsupported = { sessionId: 'future', sessionSchemaVersion: '9.0.0', unknownPayload: { retained: true } };
    const malformed = { nope: true };
    const before = structuredClone([current, legacy, unsupported, malformed]);
    const classified = await classifyStoredSessionRows([current, legacy, unsupported, malformed]);
    expect(classified.map((row) => row.classification)).toEqual(['current', 'legacy-migratable', 'unsupported-recoverable', 'malformed-unreadable']);
    expect([current, legacy, unsupported, malformed]).toEqual(before);
    const backup = JSON.parse(buildRecoveryBackup(unsupported));
    expect(backup.backupType).toBe('interview-facilitator-recovery-internal');
    expect(backup.record).toEqual(unsupported);
    expect(JSON.parse(buildRecoveryBackup(unsupported))).toEqual(backup);
    await expect(buildUnsupportedRecoveryBackup(unsupported, 'future')).resolves.toBe(buildRecoveryBackup(unsupported));
    await expect(buildUnsupportedRecoveryBackup(unsupported, 'another-id')).rejects.toThrow(/safely created|identity/i);
    const db = {
      objectStoreNames: { contains: () => true },
      close() {},
      transaction: () => ({ objectStore: () => ({ get: () => {
        const request: { result?: unknown; onsuccess: (() => void) | null; onerror: (() => void) | null } = { onsuccess: null, onerror: null };
        queueMicrotask(() => { request.result = structuredClone(unsupported); request.onsuccess?.(); });
        return request;
      } }) }),
    };
    vi.stubGlobal('indexedDB', { open: () => {
      const request: { result: typeof db; onupgradeneeded: (() => void) | null; onsuccess: (() => void) | null; onerror: (() => void) | null } = { result: db, onupgradeneeded: null, onsuccess: null, onerror: null };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    } });
    await expect(exportRecoveryBackup('future')).resolves.toBe(buildRecoveryBackup(unsupported));
    await expect(exportRecoveryBackup('another-id')).rejects.toThrow(/safely created/i);
    for (const invalid of [
      { value: undefined },
      { value: () => undefined },
      { value: Symbol('recovery') },
      { value: Number.NaN },
      { value: Infinity },
      { value: -0 },
      { value: 'x'.repeat(300_000) },
    ]) expect(() => buildRecoveryBackup(invalid)).toThrow(/safely created/i);
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => buildRecoveryBackup(cyclic)).toThrow(/safely created/i);
    const sparse = new Array(1);
    const extraProperty: unknown[] & { extra?: boolean } = [];
    extraProperty.extra = true;
    const symbolProperty: unknown[] = [];
    Object.defineProperty(symbolProperty, Symbol('hidden'), { value: true });
    for (const invalid of [sparse, extraProperty, symbolProperty, new Date('2026-10-31T12:00:00.000Z')]) {
      expect(() => buildRecoveryBackup(invalid)).toThrow(/safely created/i);
    }
  });

  it('recovers versioned rows with a nonempty id and safe JSON data', async () => {
    const current = await createPinnedSession(pack, { clientLabel: 'Current' });
    const unsupportedRules = { ...structuredClone(current), sessionId: 'unsupported-rules', packSnapshot: { ...structuredClone(current.packSnapshot), ruleSemanticsVersion: 'condition-equals-v2' } };
    const unsupportedPack = { ...structuredClone(current), sessionId: 'unsupported-pack', packSnapshot: { ...structuredClone(current.packSnapshot), packSchemaVersion: '2.0.0' } };
    const unsupported11 = structuredClone(current) as unknown as Record<string, unknown>;
    const unsupported11Snapshot = structuredClone(current.packSnapshot) as unknown as Record<string, unknown>;
    unsupported11.sessionId = 'unsupported-11';
    unsupported11.sessionSchemaVersion = '1.1.0';
    unsupported11Snapshot.packSchemaVersion = '2.0.0';
    delete unsupported11Snapshot.ruleSemanticsVersion;
    unsupported11.packSnapshot = unsupported11Snapshot;
    const missingMetadata = { ...structuredClone(current), sessionId: 'missing-metadata', packSnapshot: { ...structuredClone(current.packSnapshot) } };
    delete missingMetadata.packSnapshot.ruleSemanticsVersion;
    const futureSchema = { sessionId: 'future-schema', sessionSchemaVersion: '9.0.0', unknownField: ['preserved'] };
    const missingId = { ...unsupportedRules, sessionId: '   ' };
    const classified = await classifyStoredSessionRows([unsupportedRules, unsupportedPack, unsupported11, missingMetadata, futureSchema, missingId]);
    expect(classified.map((row) => row.classification)).toEqual([
      'unsupported-recoverable', 'unsupported-recoverable', 'unsupported-recoverable', 'malformed-unreadable', 'unsupported-recoverable', 'malformed-unreadable',
    ]);
  });
  it('returns healthy rows and counts malformed records without throwing', async () => {
    const good = await createPinnedSession(pack, { clientLabel: 'Good Client' }, new Date('2026-10-31T12:00:00Z'));
    const malformed = { sessionId: 'bad-row', updatedAt: '2026-10-31T12:00:00.000Z' };
    const result = await partitionStoredSessionRows([good, malformed]);
    expect(result.unreadableCount).toBe(1);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]?.sessionId).toBe(good.sessionId);
  });

  it('sorts only validated rows and ignores malformed updatedAt values during partitioning', async () => {
    const older = await createPinnedSession(pack, { clientLabel: 'Older' }, new Date('2026-10-30T12:00:00Z'));
    const newer = await createPinnedSession(pack, { clientLabel: 'Newer' }, new Date('2026-10-31T12:00:00Z'));
    const missingUpdatedAt = { ...structuredClone(newer), updatedAt: undefined };
    const result = await partitionStoredSessionRows([older, missingUpdatedAt, newer]);
    expect(result.unreadableCount).toBe(1);
    expect(result.sessions.map((session) => session.clientLabel)).toEqual(['Newer', 'Older']);
  });

  it('rejects malformed selected records before activation', async () => {
    const result = await openStoredSession({
      sessionId: 'bad-row',
      flush: async () => undefined,
      load: async () => {
        throw new Error('Session JSON must be an object.');
      },
    });
    expect(result.kind).toBe('read-failure');
  });

  it('treats pack mismatch as a bounded read failure before activation', async () => {
    const session = await createPinnedSession(pack, { clientLabel: 'Pack mismatch' }, new Date('2026-10-31T12:00:00Z'));
    session.interviewPackVersion = '9.9.9';
    expect(() => validateSessionForPack(session)).toThrow(/different interview pack or version/i);
  });
});

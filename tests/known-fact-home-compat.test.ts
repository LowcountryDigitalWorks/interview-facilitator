import { describe, expect, it } from 'vitest';
import { generalDiscoveryPack } from '../src/pack';
import { migrateSemantic13ToKnownFact14 } from '../src/known-fact-session';
import { createSemanticSession } from '../src/semantic-session';
import { classifyStoredSessionRows, partitionStoredSessionRows, buildRecoveryBackup } from '../src/storage';
import { exportCanonicalSessionJsonForReview, parseCanonicalSessionJsonForReview } from '../src/versioned-session-io';

async function syntheticPair() {
  const current13 = await createSemanticSession(
    generalDiscoveryPack,
    { clientLabel: 'Synthetic 1.3 interview', interviewerLabel: 'Synthetic interviewer' },
    new Date('2026-11-03T12:00:00.000Z'),
  );
  const current14 = await migrateSemantic13ToKnownFact14({
    ...current13,
    sessionId: 'synthetic-14-id',
    clientLabel: 'Synthetic 1.4 interview',
  });
  return { current13, current14 };
}

describe('#34A2B2C1 read-only 1.4 home classification', () => {
  it('recognizes a validated 1.4 as a read-only row, never an editable 1.3 session', async () => {
    const { current13, current14 } = await syntheticPair();
    const unchanged = structuredClone(current14);
    const list = await partitionStoredSessionRows([current13, current14]);

    expect(list.sessions).toEqual([current13]);
    expect(list.unreadableCount).toBe(0);
    expect(list.rows?.map((row) => row.classification)).toEqual(['current', 'current-known-fact-14']);
    const row14 = list.rows?.[1];
    if (row14?.classification !== 'current-known-fact-14') throw new Error('1.4 row was not recognized.');
    expect(row14.session).toEqual(current14);
    expect(row14.raw).toEqual(unchanged);
    expect(current14).toEqual(unchanged);

    const json = await exportCanonicalSessionJsonForReview(row14.session);
    const roundTrip = await parseCanonicalSessionJsonForReview(json);
    expect(roundTrip.kind).toBe('readable');
    if (roundTrip.kind === 'readable') {
      expect(roundTrip.schemaVersion).toBe('1.4.0');
      expect(roundTrip.session).toEqual(current14);
    }
  });

  it('does not silently treat an invalid 1.4 as an editable 1.3 or valid 1.4', async () => {
    const { current14 } = await syntheticPair();
    const invalid = { ...current14, knownFactLedger: null };
    const unchanged = structuredClone(invalid);
    const classified = await classifyStoredSessionRows([invalid]);

    expect(classified).toHaveLength(1);
    expect(classified[0]).toMatchObject({
      sessionId: 'synthetic-14-id',
      classification: 'malformed-unreadable',
      recoveryAvailable: true,
    });
    expect(buildRecoveryBackup(invalid)).toContain('interview-facilitator-recovery-internal');
    expect(invalid).toEqual(unchanged);
  });

  it('leaves future schemas separately recoverable and counts malformed rows truthfully', async () => {
    const { current13, current14 } = await syntheticPair();
    const future = { ...current14, sessionSchemaVersion: '2.0.0', sessionId: 'synthetic-future-id' };
    const malformed = { ...current14, knownFactAnswerLinks: null, sessionId: 'synthetic-bad-id' };
    const listed = await partitionStoredSessionRows([current13, current14, future, malformed]);

    expect(listed.sessions).toHaveLength(1);
    expect(listed.unreadableCount).toBe(1);
    expect(listed.rows?.map((row) => row.classification)).toEqual([
      'current', 'current-known-fact-14', 'unsupported-recoverable', 'malformed-unreadable',
    ]);
    expect(listed.rows?.[2]).toMatchObject({ sessionId: 'synthetic-future-id' });
    expect(listed.rows?.[3]).toMatchObject({ sessionId: 'synthetic-bad-id', recoveryAvailable: true });
  });

  it('never recategorizes an invalid 1.4 record as a supported format when recovery serialization fails', async () => {
    const { current14 } = await syntheticPair();
    const oversized = { ...current14, knownFactLedger: null, runningNotes: 'a'.repeat(260_000) };
    const listed = await partitionStoredSessionRows([oversized]);
    expect(listed.sessions).toHaveLength(0);
    expect(listed.unreadableCount).toBe(1);
    expect(listed.rows?.[0]).toMatchObject({ classification: 'malformed-unreadable', recoveryAvailable: false });
  });
});

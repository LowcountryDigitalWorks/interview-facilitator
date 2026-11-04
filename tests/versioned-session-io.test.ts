import { describe, expect, it } from 'vitest';
import { generalDiscoveryPack } from '../src/pack';
import { createSemanticSession } from '../src/semantic-session';
import { migrateSemantic13ToKnownFact14 } from '../src/known-fact-session';
import {
  exportCanonicalSessionJsonForReview,
  inspectSessionCompatibilityForReview,
  parseCanonicalSessionJsonForReview,
} from '../src/versioned-session-io';

async function synthetic13() {
  return createSemanticSession(generalDiscoveryPack, {
    clientLabel: 'Synthetic prospect',
    interviewerLabel: 'Synthetic interviewer',
  }, new Date('2026-11-03T12:00:00.000Z'));
}

describe('#34A2B2B pure version-aware JSON boundary', () => {
  it('reads 1.3 strictly and round-trips canonical JSON without mutation', async () => {
    const source = await synthetic13();
    const unchanged = structuredClone(source);
    const inspected = await inspectSessionCompatibilityForReview(source);
    expect(inspected.kind).toBe('readable');
    if (inspected.kind !== 'readable') return;
    expect(inspected.schemaVersion).toBe('1.3.0');
    const json = await exportCanonicalSessionJsonForReview(source);
    const restored = await parseCanonicalSessionJsonForReview(json);
    expect(restored.kind).toBe('readable');
    if (restored.kind === 'readable') expect(restored.session).toEqual(source);
    expect(source).toEqual(unchanged);
  });

  it('preserves 1.4 known-fact evidence and returns 1.4, never a downgraded 1.3', async () => {
    const source = await synthetic13();
    source.knownFacts = [{
      id: 'synthetic-fact', label: 'Synthetic platform', value: 'Local only',
      provenance: 'Synthetic discovery note', questionId: 'existing-presence',
    }];
    const upgraded = await migrateSemantic13ToKnownFact14(source);
    const json = await exportCanonicalSessionJsonForReview(upgraded);
    const parsed = await parseCanonicalSessionJsonForReview(json);
    expect(parsed.kind).toBe('readable');
    if (parsed.kind !== 'readable') return;
    expect(parsed.schemaVersion).toBe('1.4.0');
    expect(parsed.session).toEqual(upgraded);
    if (parsed.schemaVersion === '1.4.0') {
      expect(parsed.session.knownFactLedger.facts[0].id).toBe('synthetic-fact');
      expect(parsed.session.knownFactLedger.acceptances).toEqual([]);
    }
  });

  it('rejects malformed 1.4 without reclassifying it as legacy or replacing evidence', async () => {
    const upgraded = await migrateSemantic13ToKnownFact14(await synthetic13());
    const bad = { ...upgraded, unexpectedLedgerOverride: true };
    expect((await inspectSessionCompatibilityForReview(bad)).kind).toBe('invalid');
    await expect(exportCanonicalSessionJsonForReview(bad)).rejects.toThrow('no export');
    expect((await inspectSessionCompatibilityForReview({ ...upgraded, knownFactLedger: null })).kind).toBe('invalid');
  });

  it('never treats 1.4 extension fields as acceptable in a 1.3 record', async () => {
    const semantic = await synthetic13();
    const raw = { ...semantic, knownFactLedger: { facts: [], acceptances: [] }, knownFactAnswerLinks: {} };
    expect((await inspectSessionCompatibilityForReview(raw)).kind).toBe('invalid');
    await expect(exportCanonicalSessionJsonForReview(raw)).rejects.toThrow();
  });

  it('distinguishes future schemas from malformed current schema and leaves the source untouched', async () => {
    const raw = { ...(await synthetic13()), sessionSchemaVersion: '2.0.0' };
    const unchanged = structuredClone(raw);
    expect(await inspectSessionCompatibilityForReview(raw)).toMatchObject({ kind: 'unsupported-version', schemaVersion: '2.0.0' });
    expect(raw).toEqual(unchanged);
    await expect(exportCanonicalSessionJsonForReview(raw)).rejects.toThrow();
    expect((await inspectSessionCompatibilityForReview({ ...raw, sessionSchemaVersion: 14 })).kind).toBe('invalid');
  });

  it('refuses broken JSON and over-limit input without writing a session', async () => {
    expect((await parseCanonicalSessionJsonForReview('{')).kind).toBe('invalid');
    expect((await parseCanonicalSessionJsonForReview('"wrong shape"')).kind).toBe('invalid');
    expect((await parseCanonicalSessionJsonForReview('x'.repeat(2_000_001))).kind).toBe('invalid');
  });

  it('does not label invalid 1.2-looking records as safe migrations', async () => {
    const fake = { ...(await synthetic13()), sessionSchemaVersion: '1.2.0' };
    expect((await inspectSessionCompatibilityForReview(fake)).kind).toBe('invalid');
  });
});

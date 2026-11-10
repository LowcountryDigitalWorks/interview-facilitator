import { describe, expect, it, vi } from 'vitest';
import { generalDiscoveryPack } from '../src/pack';
import { createSemanticSession } from '../src/semantic-session';
import { INTERVIEW_PREP_PACKET_VERSION, type InterviewPrepPacket } from '../src/interview-workflow-bridge';
import {
  SYNTHETIC_PREP_MAX_BYTES,
  isSyntheticPrepTrialSession,
  readSyntheticPrepPacketForReview,
} from '../src/synthetic-private-prep-file';

async function fixture() {
  const source = await createSemanticSession(generalDiscoveryPack, {
    clientLabel: 'SYNTHETIC private preparation demo',
  }, new Date('2026-11-09T14:00:00.000Z'));
  const packet: InterviewPrepPacket = {
    schemaVersion: INTERVIEW_PREP_PACKET_VERSION,
    jobKey: 'SYNTHETIC-JOB-1',
    sessionId: source.sessionId,
    expectedRevisionId: source.revisionId,
    expectedPackDigest: source.packIdentity.digest,
    preparedAt: '2026-11-09T14:30:00.000Z',
    candidates: [{
      candidateId: 'candidate-a',
      questionId: 'primary-goal',
      proposedValue: 'SYNTHETIC only value',
      sourceSystem: 'manual',
      sourceRecordRef: 'SYNTHETIC-REF-01',
      observedAt: '2026-11-09T14:10:00.000Z',
      confidence: 'unverified',
    }],
  };
  function file(value: unknown, size?: number) {
    const json = typeof value === 'string' ? value : JSON.stringify(value);
    return { size: size ?? new TextEncoder().encode(json).byteLength, text: vi.fn(async () => json) };
  }
  return { source, packet, file };
}

describe('synthetic private local prep packet boundary', () => {
  it('recognizes synthetic sessions only (never a normal real-client label)', () => {
    expect(isSyntheticPrepTrialSession('Synthetic Demo')).toBe(true);
    expect(isSyntheticPrepTrialSession('SYNTHETIC-Demo')).toBe(true);
    expect(isSyntheticPrepTrialSession('Actual Client')).toBe(false);
    expect(isSyntheticPrepTrialSession('SyntheticClient')).toBe(false);
  });

  it('validates exact selected session/pack and returns a read-only candidate packet', async () => {
    const { source, packet, file } = await fixture();
    const original = JSON.stringify(source);
    const input = file(packet);
    expect(await readSyntheticPrepPacketForReview(input, source)).toEqual(packet);
    expect(input.text).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(source)).toBe(original);
    expect(source.answers['primary-goal']).toMatchObject({
      value: null, resolution: 'unresolved', source: null,
    });
  });

  it('refuses real sessions and oversized files before file bytes are read', async () => {
    const { source, packet, file } = await fixture();
    const real = { ...source, clientLabel: 'Actual private customer' };
    const unread = file(packet);
    await expect(readSyntheticPrepPacketForReview(unread, real))
      .rejects.toThrow('synthetic interview sessions only');
    expect(unread.text).not.toHaveBeenCalled();
    const large = file(packet, SYNTHETIC_PREP_MAX_BYTES + 1);
    await expect(readSyntheticPrepPacketForReview(large, source))
      .rejects.toThrow('file size');
    expect(large.text).not.toHaveBeenCalled();
    const underreported = file(' '.repeat(SYNTHETIC_PREP_MAX_BYTES + 1), 1);
    await expect(readSyntheticPrepPacketForReview(underreported, source))
      .rejects.toThrow('decoded size');
  });

  it('rejects malformed, non-synthetic, stale and unsupported candidate input without source mutation', async () => {
    const { source, packet, file } = await fixture();
    const original = JSON.stringify(source);
    await expect(readSyntheticPrepPacketForReview(file('{not json'), source))
      .rejects.toThrow('not valid JSON');
    await expect(readSyntheticPrepPacketForReview(file({ ...packet, jobKey: 'REAL-CLIENT-JOB' }), source))
      .rejects.toThrow('synthetic job');
    await expect(readSyntheticPrepPacketForReview(file({
      ...packet, candidates: [{ ...packet.candidates[0]!, proposedValue: 'Actual sensitive source fact' }],
    }), source)).rejects.toThrow('synthetic value');
    await expect(readSyntheticPrepPacketForReview(file({
      ...packet, candidates: [{ ...packet.candidates[0]!, sourceRecordRef: 'real-source-ref' }],
    }), source)).rejects.toThrow('synthetic value');
    await expect(readSyntheticPrepPacketForReview(file({
      ...packet, sessionId: 'other-synthetic-session',
    }), source)).rejects.toThrow('exact selected session');
    await expect(readSyntheticPrepPacketForReview(file({
      ...packet, candidates: [packet.candidates[0]!, packet.candidates[0]!],
    }), source)).rejects.toThrow('Duplicate evidence candidate');
    expect(JSON.stringify(source)).toBe(original);
  });
});

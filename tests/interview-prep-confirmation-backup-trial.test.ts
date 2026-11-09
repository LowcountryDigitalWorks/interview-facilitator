import { describe, expect, it } from 'vitest';
import { generalDiscoveryPack } from '../src/pack';
import { createSemanticSession } from '../src/semantic-session';
import { canonicalizeJson } from '../src/pack-identity';
import {
  PREP_CONFIRMATION_BACKUP_KIND,
  createConfirmationTrialBackupForReview,
  validateConfirmationTrialBackupForReview,
} from '../src/interview-prep-confirmation-backup-trial';

async function syntheticSession() {
  const session = await createSemanticSession(generalDiscoveryPack, {
    clientLabel: 'SYNTHETIC CONFIDENTIAL CONFIRMATION',
  }, new Date('2026-11-08T15:00:00.000Z'));
  session.runningNotes = 'SYNTHETIC PRIVATE NOTE — MUST NOT ENTER PUBLIC LOGS';
  session.answers['primary-goal']!.value = 'SYNTHETIC CLIENT CONFIRMED THIS';
  session.answers['primary-goal']!.source = 'client-statement';
  session.answers['primary-goal']!.resolution = 'captured';
  return session;
}

describe('synthetic-only private confirmation backup source contract', () => {
  it('is deterministic, canonical and self-contained; preserves all private 1.3 interview state', async () => {
    const session = await syntheticSession();
    const before = structuredClone(session);
    const one = await createConfirmationTrialBackupForReview(session);
    const two = await createConfirmationTrialBackupForReview(structuredClone(session));
    expect(one).toBe(two);
    expect(one.endsWith('\n')).toBe(true);
    expect(one).toContain(PREP_CONFIRMATION_BACKUP_KIND);
    expect(one).toContain('SYNTHETIC PRIVATE NOTE');
    expect(await validateConfirmationTrialBackupForReview(one)).toEqual(session);
    expect(session).toEqual(before);
  });

  it('rejects tampering and unknown versions before recovery', async () => {
    const bytes = await createConfirmationTrialBackupForReview(await syntheticSession());
    const raw = JSON.parse(bytes);
    raw.session.runningNotes = 'SYNTHETIC TAMPERED NOTES';
    await expect(validateConfirmationTrialBackupForReview(canonicalizeJson(raw) + '\n'))
      .rejects.toThrow('integrity mismatch');
    const version = JSON.parse(bytes);
    version.formatVersion = 2;
    await expect(validateConfirmationTrialBackupForReview(canonicalizeJson(version) + '\n'))
      .rejects.toThrow('Unsupported synthetic');
    const extra = JSON.parse(bytes);
    extra.newField = 'unsupported';
    await expect(validateConfirmationTrialBackupForReview(canonicalizeJson(extra) + '\n'))
      .rejects.toThrow('unsupported fields');
    const corruptDigest = JSON.parse(bytes);
    corruptDigest.integrity.digest = '0'.repeat(64);
    await expect(validateConfirmationTrialBackupForReview(canonicalizeJson(corruptDigest) + '\n'))
      .rejects.toThrow('integrity mismatch');
  });

  it('requires exact canonical bytes, valid JSON and bounded size', async () => {
    const bytes = await createConfirmationTrialBackupForReview(await syntheticSession());
    await expect(validateConfirmationTrialBackupForReview(bytes.trim()))
      .rejects.toThrow('canonical JSON');
    await expect(validateConfirmationTrialBackupForReview('  ' + bytes))
      .rejects.toThrow('integrity mismatch');
    await expect(validateConfirmationTrialBackupForReview('{broken\n'))
      .rejects.toThrow('malformed JSON');
    await expect(validateConfirmationTrialBackupForReview(' '.repeat(2_500_001) + '\n'))
      .rejects.toThrow('size bound');
  });

  it('never permits real-looking session labels or non-synthetic source recovery', async () => {
    const session = await syntheticSession();
    session.clientLabel = 'REAL CLIENT — NEVER USE TRIAL';
    await expect(createConfirmationTrialBackupForReview(session))
      .rejects.toThrow('Only synthetic');
    const backup = await createConfirmationTrialBackupForReview(await syntheticSession());
    const envelope = JSON.parse(backup);
    envelope.session.clientLabel = 'REAL CLIENT';
    await expect(validateConfirmationTrialBackupForReview(canonicalizeJson(envelope) + '\n'))
      .rejects.toThrow('Only synthetic');
  });
});

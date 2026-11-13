import { describe, expect, it } from 'vitest';
import { generalDiscoveryPack } from '../src/pack';
import {
  createPortableRevisionArchive,
  serializePortableRevisionArchive,
} from '../src/portable-revision-archive';
import {
  SYNTHETIC_PORTABLE_RESTORE_TEST_CAPABILITY,
  importSyntheticPortableArchiveFreshOrigin,
} from '../src/synthetic-portable-restore';
import { createSemanticSession, type SemanticInterviewSession } from '../src/semantic-session';

const createdAt = '2026-11-13T19:00:00.000Z';

function nextRevision(parent: SemanticInterviewSession, updatedAt: string): SemanticInterviewSession {
  const copy = structuredClone(parent);
  copy.parentRevisionId = parent.revisionId;
  copy.revisionId = crypto.randomUUID();
  copy.updatedAt = updatedAt;
  return copy;
}

function archiveRevision(session: SemanticInterviewSession) {
  return {
    revisionId: session.revisionId,
    parentRevisionId: session.parentRevisionId,
    updatedAt: session.updatedAt,
    record: structuredClone(session),
  };
}

async function buildArchive(head: SemanticInterviewSession, chain: SemanticInterviewSession[]) {
  return createPortableRevisionArchive({
    sessionId: head.sessionId,
    headRevisionId: head.revisionId,
    createdAt,
    revisions: chain.map(archiveRevision),
  });
}

async function completeChainJson() {
  const root = await createSemanticSession(generalDiscoveryPack, {
    clientLabel: 'SYNTHETIC PORTABLE RESTORE UNIT',
  }, new Date('2026-11-13T14:00:00.000Z'));
  const middle = nextRevision(root, '2026-11-13T14:15:00.000Z');
  const head = nextRevision(middle, '2026-11-13T14:30:00.000Z');
  const archive = await buildArchive(head, [root, middle, head]);
  return serializePortableRevisionArchive(archive);
}

describe('synthetic portable restore — pre-transaction guards', () => {
  it('rejects missing test-only capability before validation', async () => {
    const json = await completeChainJson();
    const outcome = await importSyntheticPortableArchiveFreshOrigin({
      testOnlyCapability: 'invalid' as typeof SYNTHETIC_PORTABLE_RESTORE_TEST_CAPABILITY,
      untrustedArchiveJson: json,
    });
    expect(outcome).toEqual({
      kind: 'rejected',
      code: 'invalid-request',
      reason: 'Synthetic portable restore requires the explicit test-only capability token.',
    });
  });

  it('rejects incomplete lineage through preflight', async () => {
    const root = await createSemanticSession(generalDiscoveryPack, {
      clientLabel: 'SYNTHETIC GAP CHAIN',
    }, new Date('2026-11-13T14:00:00.000Z'));
    const middle = nextRevision(root, '2026-11-13T14:15:00.000Z');
    const gap = nextRevision(middle, '2026-11-13T14:35:00.000Z');
    const archive = await buildArchive(gap, [middle, gap]);
    const outcome = await importSyntheticPortableArchiveFreshOrigin({
      testOnlyCapability: SYNTHETIC_PORTABLE_RESTORE_TEST_CAPABILITY,
      untrustedArchiveJson: serializePortableRevisionArchive(archive),
    });
    expect(outcome.kind).toBe('rejected');
    expect(outcome).toMatchObject({ code: 'preflight-reject' });
  });

  it('rejects non-synthetic client labels before storage', async () => {
    const root = await createSemanticSession(generalDiscoveryPack, {
      clientLabel: 'REAL CLIENT — MUST NOT IMPORT',
    }, new Date('2026-11-13T14:00:00.000Z'));
    const head = nextRevision(root, '2026-11-13T14:30:00.000Z');
    const archive = await buildArchive(head, [root, head]);
    const outcome = await importSyntheticPortableArchiveFreshOrigin({
      testOnlyCapability: SYNTHETIC_PORTABLE_RESTORE_TEST_CAPABILITY,
      untrustedArchiveJson: serializePortableRevisionArchive(archive),
    });
    expect(outcome).toEqual({
      kind: 'rejected',
      code: 'synthetic-guard',
      reason: 'Synthetic portable restore accepts synthetic-labelled sessions only.',
    });
  });

  it('rejects tampered checksum envelope', async () => {
    const json = await completeChainJson();
    const parsed = JSON.parse(json) as { checksum: { digest: string } };
    // Always change a nibble: replacing it with '0' is a 1-in-16 no-op when
    // the random revision IDs already produce a digest ending in zero.
    const originalDigest = parsed.checksum.digest;
    parsed.checksum.digest = `${originalDigest.slice(0, -1)}${originalDigest.endsWith('0') ? '1' : '0'}`;
    expect(parsed.checksum.digest).not.toBe(originalDigest);
    const outcome = await importSyntheticPortableArchiveFreshOrigin({
      testOnlyCapability: SYNTHETIC_PORTABLE_RESTORE_TEST_CAPABILITY,
      untrustedArchiveJson: JSON.stringify(parsed),
    });
    expect(outcome.kind).toBe('rejected');
    expect(outcome).toMatchObject({ code: 'preflight-reject' });
  });
});

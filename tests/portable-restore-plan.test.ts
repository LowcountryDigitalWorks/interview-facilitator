import { describe, expect, it } from 'vitest';
import { generalDiscoveryPack } from '../src/pack';
import {
  createPortableRevisionArchive,
  serializePortableRevisionArchive,
  validatePortableRevisionArchiveJson,
} from '../src/portable-revision-archive';
import {
  PORTABLE_RESTORE_PLAN_VERSION,
  planFreshOriginPortableRestoreDryRun,
} from '../src/portable-restore-plan';
import { createSemanticSession, type SemanticInterviewSession } from '../src/semantic-session';

const createdAt = '2026-11-13T18:00:00.000Z';

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

async function fixtureChain() {
  const root = await createSemanticSession(generalDiscoveryPack, {
    clientLabel: 'SYNTHETIC PORTABLE RESTORE FIXTURE',
  }, new Date('2026-11-13T14:00:00.000Z'));
  const middle = nextRevision(root, '2026-11-13T14:15:00.000Z');
  const head = nextRevision(middle, '2026-11-13T14:30:00.000Z');
  const archive = await buildArchive(head, [root, middle, head]);
  return { root, middle, head, archive };
}

describe('portable fresh-origin restore preflight dry-run — no storage writes', () => {
  it('reports a complete lineage with validated 1.3 records and preserves inputs', async () => {
    const { head, archive } = await fixtureChain();
    const json = serializePortableRevisionArchive(archive);
    const before = json;
    const plan = await planFreshOriginPortableRestoreDryRun(json, {
      expectedSessionId: head.sessionId,
      expectedHeadRevisionId: head.revisionId,
    });
    expect(json).toBe(before);
    expect(plan.schemaVersion).toBe(PORTABLE_RESTORE_PLAN_VERSION);
    expect(plan.kind).toBe('fresh-origin-restore-preflight-dry-run');
    expect(plan.verdict).toBe('preflight-complete-head-validated');
    expect(plan.headImportFeasible).toBe(true);
    expect(plan.validatedRevisionCount).toBe(3);
    expect(plan.validatedRevisions.map((row) => row.revisionId)).toEqual([
      archive.revisions[0]!.revisionId,
      archive.revisions[1]!.revisionId,
      archive.revisions[2]!.revisionId,
    ]);
    expect(plan.integrityNotice).toContain('not authentication');
    expect(JSON.stringify(plan)).not.toContain(head.clientLabel);
  });

  it('returns incomplete lineage without claiming head import feasibility', async () => {
    const { middle } = await fixtureChain();
    const gap = nextRevision(middle, '2026-11-13T14:35:00.000Z');
    const archive = await buildArchive(gap, [middle, gap]);
    const plan = await planFreshOriginPortableRestoreDryRun(
      serializePortableRevisionArchive(archive),
    );
    expect(plan.verdict).toBe('preflight-incomplete-lineage');
    expect(plan.headImportFeasible).toBe(false);
    expect(plan.archiveLineageStatus).toBe('missing-ancestor');
  });

  it('rejects scoped session and head mismatches before semantic work', async () => {
    const { head, archive } = await fixtureChain();
    const json = serializePortableRevisionArchive(archive);
    await expect(planFreshOriginPortableRestoreDryRun(json, {
      expectedSessionId: 'other-session',
    })).rejects.toThrow(/session id/i);
    await expect(planFreshOriginPortableRestoreDryRun(json, {
      expectedHeadRevisionId: 'other-head',
    })).rejects.toThrow(/head revision/i);
  });

  it('rejects forged checksums recomputed by an adversary envelope', async () => {
    const { archive } = await fixtureChain();
    const forged = structuredClone(archive);
    forged.revisions[0]!.record = {
      ...(forged.revisions[0]!.record as SemanticInterviewSession),
      clientLabel: 'TAMPERED SYNTHETIC LABEL',
    };
    await expect(planFreshOriginPortableRestoreDryRun(
      serializePortableRevisionArchive(forged),
    )).rejects.toThrow(/checksum/i);
  });

  it('rejects semantic records that diverge from archive revision wrappers', async () => {
    const { head, root } = await fixtureChain();
    const wrapped = archiveRevision(root);
    wrapped.revisionId = 'wrapper-does-not-match-record';
    await expect(createPortableRevisionArchive({
      sessionId: head.sessionId,
      headRevisionId: head.revisionId,
      createdAt,
      revisions: [wrapped],
    })).rejects.toThrow(/identity does not match/i);
  });

  it('rejects mixed pinned packs across retained revisions', async () => {
    const { root, head } = await fixtureChain();
    const other = structuredClone(root);
    other.sessionId = root.sessionId;
    other.revisionId = crypto.randomUUID();
    other.parentRevisionId = root.revisionId;
    other.updatedAt = '2026-11-13T14:05:00.000Z';
    other.packSnapshot.title = 'SYNTHETIC MIXED PACK TITLE';
    other.packIdentity = {
      algorithm: 'SHA-256',
      canonicalization: 'ldw-json-c14n-v1',
      digest: 'b'.repeat(64),
    };
    await expect(buildArchive(head, [root, other, head])).rejects.toThrow(/mixed pinned/i);
  });

  it('rejects malformed archive strings fail-closed', async () => {
    await expect(planFreshOriginPortableRestoreDryRun('{')).rejects.toThrow(/malformed/i);
    await expect(planFreshOriginPortableRestoreDryRun('')).rejects.toThrow(/nonempty/i);
  });

  it('rejects unsupported archive schema versions surfaced by the archive validator', async () => {
    const { archive } = await fixtureChain();
    const unsupported = structuredClone(archive);
    (unsupported as { archiveSchemaVersion: number }).archiveSchemaVersion = 99;
    await expect(validatePortableRevisionArchiveJson(
      serializePortableRevisionArchive(unsupported as typeof archive),
    )).rejects.toThrow(/unsupported/i);
  });
});

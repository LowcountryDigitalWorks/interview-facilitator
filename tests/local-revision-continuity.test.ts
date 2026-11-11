import { describe, expect, it } from 'vitest';
import { generalDiscoveryPack } from '../src/pack';
import { canonicalizeJson } from '../src/pack-identity';
import { createSemanticSession, type SemanticInterviewSession } from '../src/semantic-session';
import {
  auditRetainedLocalRevisionsForReview, MAX_LOCAL_REVISION_AUDIT_ROWS,
  type RetainedLocalRevision,
} from '../src/local-revision-continuity';

async function fixture() {
  const root = await createSemanticSession(generalDiscoveryPack, {
    clientLabel: 'SYNTHETIC local continuity fixture',
  }, new Date('2026-11-09T14:00:00.000Z'));
  const next = (parent: SemanticInterviewSession, updatedAt: string) => {
    const copy = structuredClone(parent);
    copy.parentRevisionId = parent.revisionId;
    copy.revisionId = crypto.randomUUID();
    copy.updatedAt = updatedAt;
    return copy;
  };
  const middle = next(root, '2026-11-09T14:15:00.000Z');
  const current = next(middle, '2026-11-09T14:30:00.000Z');
  const archived = (row: SemanticInterviewSession): RetainedLocalRevision => ({
    key: canonicalizeJson([row.sessionId, row.revisionId]), record: structuredClone(row),
  });
  return { root, middle, current, next, archived };
}

describe('retained local 1.3 revision continuity audit — not a secure backup', () => {
  it('reports no snapshot even for a root: local data is not an off-device copy', async () => {
    const { root } = await fixture();
    expect(await auditRetainedLocalRevisionsForReview(root, [])).toMatchObject({
      kind: 'local-revisions-only', status: 'none-retained',
      retainedCount: 0, linkedCount: 0, unlinkedCount: 0,
    });
  });

  it('traces exact retained parent chain without altering interview content', async () => {
    const { root, middle, current, archived } = await fixture();
    const before = canonicalizeJson(current);
    const report = await auditRetainedLocalRevisionsForReview(
      current, [archived(root), archived(middle)],
    );
    expect(report).toMatchObject({
      status: 'linked-locally', retainedCount: 2, linkedCount: 2, unlinkedCount: 0,
    });
    expect(report.notice).toContain('No off-device copy');
    expect(canonicalizeJson(current)).toBe(before);
    expect(JSON.stringify(report)).not.toContain(current.clientLabel);
    expect(JSON.stringify(report)).not.toContain(current.sessionId);
  });

  it('does not pretend a missing intermediate autosave was retained', async () => {
    const { root, middle, current, archived } = await fixture();
    const report = await auditRetainedLocalRevisionsForReview(current, [archived(root)]);
    expect(report).toMatchObject({
      status: 'missing-link', retainedCount: 1, linkedCount: 0, unlinkedCount: 1,
    });
    // Also reject a gap after walking one valid archived parent.
    const gap = structuredClone(middle);
    gap.parentRevisionId = crypto.randomUUID();
    const later = structuredClone(current);
    later.parentRevisionId = gap.revisionId;
    expect(await auditRetainedLocalRevisionsForReview(later, [archived(gap)])).toMatchObject({
      status: 'missing-link', linkedCount: 1, unlinkedCount: 0,
    });
  });

  it('reports unrelated local snapshots rather than including them as current lineage', async () => {
    const { root, middle, current, archived } = await fixture();
    const sibling = structuredClone(root);
    sibling.revisionId = crypto.randomUUID();
    expect(await auditRetainedLocalRevisionsForReview(
      current, [archived(root), archived(middle), archived(sibling)],
    )).toMatchObject({
      status: 'unlinked-snapshots', retainedCount: 3, linkedCount: 2, unlinkedCount: 1,
    });
  });

  it('rejects wrong ID, wrong archive key, duplicate revision, malformed row and oversized inventory', async () => {
    const { root, middle, current, archived } = await fixture();
    await expect(auditRetainedLocalRevisionsForReview(current, [
      { ...archived(root), key: canonicalizeJson([root.sessionId, 'forged-revision']) },
    ])).rejects.toThrow('identity or key');
    const foreign = structuredClone(root);
    foreign.sessionId = crypto.randomUUID();
    await expect(auditRetainedLocalRevisionsForReview(current, [archived(foreign)]))
      .rejects.toThrow('identity or key');
    await expect(auditRetainedLocalRevisionsForReview(current, [
      archived(root), archived(root),
    ])).rejects.toThrow('identity or key');
    await expect(auditRetainedLocalRevisionsForReview(current, [
      { key: archived(middle).key, record: { invalid: true } },
    ])).rejects.toThrow();
    await expect(auditRetainedLocalRevisionsForReview(current,
      Array.from({ length: MAX_LOCAL_REVISION_AUDIT_ROWS + 1 }, () => archived(root)),
    )).rejects.toThrow('safe audit limit');
  });

  it('fails closed on parent cycles and reverse timestamp links', async () => {
    const { root, current, archived } = await fixture();
    const cycle = structuredClone(root);
    cycle.revisionId = current.parentRevisionId!;
    cycle.parentRevisionId = current.revisionId;
    await expect(auditRetainedLocalRevisionsForReview(current, [archived(cycle)]))
      .rejects.toThrow('parent cycle');

    const future = structuredClone(root);
    future.revisionId = current.parentRevisionId!;
    future.updatedAt = '2026-11-09T17:30:00.000Z';
    await expect(auditRetainedLocalRevisionsForReview(current, [archived(future)]))
      .rejects.toThrow('future timestamp');
  });
});

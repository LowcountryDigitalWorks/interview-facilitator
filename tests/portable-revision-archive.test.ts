import { describe, expect, it } from 'vitest';
import {
  createPortableRevisionArchive,
  PORTABLE_REVISION_ARCHIVE_MAX_REVISIONS,
  serializePortableRevisionArchive,
  validatePortableRevisionArchiveJson,
} from '../src/portable-revision-archive';

const sessionId = 'synthetic-session-archive-01';
const createdAt = '2026-11-12T15:00:00.000Z';

function revision(revisionId: string, parentRevisionId: string | null, updatedAt: string) {
  return {
    revisionId,
    parentRevisionId,
    updatedAt,
    record: {
      sessionSchemaVersion: '1.3.0',
      sessionId,
      revisionId,
      parentRevisionId,
      updatedAt,
      clientLabel: 'SYNTHETIC ARCHIVE FIXTURE',
    },
  };
}

async function archive(rows: Array<{
  revisionId: string; parentRevisionId: string | null; updatedAt: string; record: unknown;
}> = [
  revision('rev-a', null, '2026-11-12T14:00:00.000Z'),
  revision('rev-b', 'rev-a', '2026-11-12T14:20:00.000Z'),
  revision('rev-c', 'rev-b', '2026-11-12T14:40:00.000Z'),
]) {
  return createPortableRevisionArchive({
    sessionId, headRevisionId: rows.at(-1)!.revisionId, createdAt, revisions: rows,
  });
}

describe('synthetic portable multi-revision archive contract', () => {
  it('round-trips a bounded retained chain and states its limits', async () => {
    const source = await archive();
    const before = JSON.stringify(source);
    const parsed = await validatePortableRevisionArchiveJson(serializePortableRevisionArchive(source));
    expect(parsed.lineageStatus).toBe('complete-to-root');
    expect(parsed.revisions).toHaveLength(3);
    expect(JSON.stringify(source)).toBe(before);
    expect(JSON.stringify(parsed)).not.toContain('full history');
  });

  it('marks an omitted parent as an explicit incomplete ancestor', async () => {
    const result = await archive([
      revision('rev-b', 'missing-rev-a', '2026-11-12T14:20:00.000Z'),
      revision('rev-c', 'rev-b', '2026-11-12T14:40:00.000Z'),
    ]);
    expect(result.lineageStatus).toBe('missing-ancestor');
    expect((await validatePortableRevisionArchiveJson(serializePortableRevisionArchive(result))).lineageStatus)
      .toBe('missing-ancestor');
  });

  it('distinguishes unlinked retained branch and missing-plus-unlinked rows', async () => {
    const branched = await archive([
      revision('rev-a', null, '2026-11-12T14:00:00.000Z'),
      revision('rev-b', 'rev-a', '2026-11-12T14:20:00.000Z'),
      revision('rev-c', 'rev-b', '2026-11-12T14:40:00.000Z'),
      revision('rev-sibling', 'rev-a', '2026-11-12T14:10:00.000Z'),
    ]);
    expect(branched.lineageStatus).toBe('unlinked-revisions');
    const gap = await archive([
      revision('rev-c', 'missing-rev-b', '2026-11-12T14:40:00.000Z'),
      revision('rev-other', null, '2026-11-12T14:10:00.000Z'),
    ]);
    expect(gap.lineageStatus).toBe('missing-and-unlinked');
  });

  it('rejects duplicate or conflicting revision identifiers', async () => {
    const first = revision('rev-a', null, '2026-11-12T14:00:00.000Z');
    const conflict = { ...revision('rev-a', null, '2026-11-12T14:01:00.000Z'), record: {
      ...revision('rev-a', null, '2026-11-12T14:01:00.000Z').record, clientLabel: 'CONFLICT',
    } };
    await expect(archive([first, conflict])).rejects.toThrow('duplicate or conflicting');
  });

  it('rejects parent cycles, reverse chronology, absent head and future-created archives', async () => {
    await expect(archive([
      revision('rev-a', 'rev-b', '2026-11-12T14:00:00.000Z'),
      revision('rev-b', 'rev-a', '2026-11-12T14:10:00.000Z'),
    ])).rejects.toThrow('cycle');
    await expect(archive([
      revision('rev-a', null, '2026-11-12T14:30:00.000Z'),
      revision('rev-b', 'rev-a', '2026-11-12T14:20:00.000Z'),
    ])).rejects.toThrow('newer than its child');
    await expect(createPortableRevisionArchive({
      sessionId, headRevisionId: 'absent', createdAt, revisions: [revision('rev-a', null, '2026-11-12T14:00:00.000Z')],
    })).rejects.toThrow('head revision is not included');
    await expect(createPortableRevisionArchive({
      sessionId, headRevisionId: 'rev-a', createdAt: '2026-11-12T13:00:00.000Z',
      revisions: [revision('rev-a', null, '2026-11-12T14:00:00.000Z')],
    })).rejects.toThrow('precedes a retained revision');
  });

  it('binds envelope and row identity to one session and exact schema', async () => {
    const row = revision('rev-a', null, '2026-11-12T14:00:00.000Z');
    row.record.sessionId = 'other-synthetic-session';
    await expect(archive([row])).rejects.toThrow('identity does not match');
    const unsupported = revision('rev-a', null, '2026-11-12T14:00:00.000Z');
    unsupported.record.sessionSchemaVersion = '1.4.0';
    await expect(archive([unsupported])).rejects.toThrow('identity does not match');
  });

  it('rejects malformed, noncanonical, corrupt, unsupported and oversized input', async () => {
    await expect(validatePortableRevisionArchiveJson('{')).rejects.toThrow('malformed');
    const value = await archive();
    const canonical = serializePortableRevisionArchive(value);
    await expect(validatePortableRevisionArchiveJson(` ${canonical}`)).rejects.toThrow('canonical form');
    const changed = JSON.parse(canonical);
    changed.revisions[0].record.clientLabel = 'CORRUPTED';
    await expect(validatePortableRevisionArchiveJson(JSON.stringify(changed))).rejects.toThrow('canonical form');
    const noncanonicalChanged = serializePortableRevisionArchive(changed);
    await expect(validatePortableRevisionArchiveJson(noncanonicalChanged)).rejects.toThrow('checksum');
    const unsupported = JSON.parse(canonical);
    unsupported.archiveSchemaVersion = 2;
    await expect(validatePortableRevisionArchiveJson(serializePortableRevisionArchive(unsupported)))
      .rejects.toThrow('unsupported');
    await expect(createPortableRevisionArchive({
      sessionId, headRevisionId: 'rev-199', createdAt,
      revisions: Array.from({ length: PORTABLE_REVISION_ARCHIVE_MAX_REVISIONS + 1 }, (_, i) =>
        revision(`rev-${i}`, null, '2026-11-12T14:00:00.000Z')),
    })).rejects.toThrow('revision count');
  });

  it('bounds nested records and rejects cycles and unsupported JSON values', async () => {
    const cyclic = revision('rev-a', null, '2026-11-12T14:00:00.000Z');
    (cyclic.record as Record<string, unknown>).extra = cyclic.record;
    await expect(archive([cyclic])).rejects.toThrow('circular');
    const withUndefined = revision('rev-a', null, '2026-11-12T14:00:00.000Z');
    (withUndefined.record as Record<string, unknown>).extra = undefined;
    await expect(archive([withUndefined])).rejects.toThrow('undefined');
  });

  it('rejects a forged lineage declaration and noncanonical chronology order', async () => {
    const value = await archive();
    const wrongStatus = { ...value, lineageStatus: 'missing-ancestor' as const };
    await expect(validatePortableRevisionArchiveJson(serializePortableRevisionArchive(wrongStatus)))
      .rejects.toThrow('lineage declaration');
    const shuffled = { ...value, revisions: [...value.revisions].reverse() };
    await expect(validatePortableRevisionArchiveJson(serializePortableRevisionArchive(shuffled)))
      .rejects.toThrow('canonical chronology order');
    const rebuilt = await createPortableRevisionArchive({
      sessionId, headRevisionId: shuffled.headRevisionId, createdAt, revisions: shuffled.revisions,
    });
    expect(rebuilt.revisions.map((row) => row.revisionId)).toEqual(['rev-a', 'rev-b', 'rev-c']);
  });
});


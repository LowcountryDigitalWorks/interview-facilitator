import { describe, expect, it } from 'vitest';
import { createSession, validateSessionForPack } from '../src/domain';
import { generalDiscoveryPack as pack } from '../src/pack';
import { partitionStoredSessionRows } from '../src/storage';
import { openStoredSession } from '../src/session-durability';

describe('stored session quarantine', () => {
  it('returns healthy rows and counts malformed records without throwing', () => {
    const good = createSession(pack, { clientLabel: 'Good Client' }, new Date('2026-10-31T12:00:00Z'));
    const malformed = { sessionId: 'bad-row', updatedAt: '2026-10-31T12:00:00.000Z' };
    const result = partitionStoredSessionRows([good, malformed]);
    expect(result.unreadableCount).toBe(1);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]?.sessionId).toBe(good.sessionId);
  });

  it('sorts only validated rows and ignores malformed updatedAt values during partitioning', () => {
    const older = createSession(pack, { clientLabel: 'Older' }, new Date('2026-10-30T12:00:00Z'));
    const newer = createSession(pack, { clientLabel: 'Newer' }, new Date('2026-10-31T12:00:00Z'));
    const missingUpdatedAt = { ...structuredClone(newer), updatedAt: undefined };
    const result = partitionStoredSessionRows([older, missingUpdatedAt, newer]);
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
    const session = createSession(pack, { clientLabel: 'Pack mismatch' }, new Date('2026-10-31T12:00:00Z'));
    session.interviewPackVersion = '9.9.9';
    expect(() => validateSessionForPack(session, pack)).toThrow(/different interview pack or version/i);
  });
});

import { describe, expect, it } from 'vitest';
import { readSessionList } from '../src/session-list';

describe('readSessionList', () => {
  it('preserves a legitimate empty session list', async () => {
    await expect(readSessionList(async () => ({ sessions: [], unreadableCount: 0 }))).resolves.toEqual({
      kind: 'ready',
      sessions: [],
      unreadableCount: 0,
    });
  });

  it('returns an explicit error state when storage cannot be read', async () => {
    const failure = new Error('synthetic IndexedDB read failure');
    const result = await readSessionList(async () => {
      throw failure;
    });

    expect(result.kind).toBe('error');
    if (result.kind === 'error') expect(result.error).toBe(failure);
  });

  it('returns sessions and unreadable count when storage succeeds', async () => {
    const row = { sessionId: 'synthetic-session' } as never;
    const result = await readSessionList(async () => ({ sessions: [row], unreadableCount: 2 }));

    expect(result).toEqual({ kind: 'ready', sessions: [row], unreadableCount: 2 });
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { touch } from '../src/domain';
import { createPinnedSession } from '../src/pack-identity';
import { generalDiscoveryPack as pack } from '../src/pack';
import { saveSession } from '../src/storage';

function installMemoryDatabase(): Map<string, unknown> {
  const rows = new Map<string, unknown>();
  const indexedDB = {
    open() {
      const request = {
        result: {
          objectStoreNames: { contains: () => true },
          close() {},
          transaction() {
            const tx = {
              oncomplete: null as null | (() => void),
              onerror: null as null | (() => void),
              onabort: null as null | (() => void),
              error: null,
              objectStore() {
                return {
                  put(value: { sessionId: string }) {
                    rows.set(value.sessionId, structuredClone(value));
                    queueMicrotask(() => tx.oncomplete?.());
                  },
                };
              },
            };
            return tx;
          },
        },
        onsuccess: null as null | (() => void),
        onerror: null as null | (() => void),
        onupgradeneeded: null as null | (() => void),
      };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    },
  };
  vi.stubGlobal('indexedDB', indexedDB);
  return rows;
}

describe('saveSession pack identity gate', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('saves a valid pinned session and keeps ordinary answer edits without changing pack identity', async () => {
    const rows = installMemoryDatabase();
    const session = await createPinnedSession(pack, { clientLabel: 'Synthetic Client' }, new Date('2026-10-31T12:00:00.000Z'));
    const digest = session.packIdentity.digest;
    await saveSession(session);

    const edited = touch(structuredClone(session), new Date('2026-10-31T12:05:00.000Z'));
    edited.answers['primary-goal']!.value = 'A saved answer.';
    edited.answers['primary-goal']!.note = 'A saved note.';
    await saveSession(edited);

    expect(edited.packIdentity).toEqual(session.packIdentity);
    expect(edited.packSnapshot).toEqual(session.packSnapshot);
    expect(edited.packIdentity.digest).toBe(digest);
    expect(rows.get(session.sessionId)).toMatchObject({
      updatedAt: '2026-10-31T12:05:00.000Z',
      answers: { 'primary-goal': { value: 'A saved answer.', note: 'A saved note.' } },
      packIdentity: { digest },
    });
  });

  it('rejects a tampered snapshot before replacing the stored row', async () => {
    const rows = installMemoryDatabase();
    const session = await createPinnedSession(pack, { clientLabel: 'Synthetic Client' }, new Date('2026-10-31T12:00:00.000Z'));
    await saveSession(session);
    const tampered = structuredClone(session);
    tampered.packSnapshot.questions[0]!.prompt = 'Drifted prompt';

    await expect(saveSession(tampered)).rejects.toThrow(/digest/i);
    const stored = rows.get(session.sessionId) as { packSnapshot: { questions: Array<{ prompt: string }> } };
    expect(stored.packSnapshot.questions[0]?.prompt).toBe(session.packSnapshot.questions[0]?.prompt);
  });

  it('rejects a tampered digest before replacing the stored row', async () => {
    const rows = installMemoryDatabase();
    const session = await createPinnedSession(pack, { clientLabel: 'Synthetic Client' }, new Date('2026-10-31T12:00:00.000Z'));
    await saveSession(session);
    const tampered = structuredClone(session);
    tampered.packIdentity.digest = 'c'.repeat(64);

    await expect(saveSession(tampered)).rejects.toThrow(/digest/i);
    expect((rows.get(session.sessionId) as { packIdentity: { digest: string } }).packIdentity.digest).toBe(session.packIdentity.digest);
  });
});

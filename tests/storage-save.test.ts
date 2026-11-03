import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyValueEdit } from '../src/live-session';
import { generalDiscoveryPack as pack } from '../src/pack';
import { createSemanticSession } from '../src/semantic-session';
import { RevisionConflictError, saveSession } from '../src/storage';

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
                  get(sessionId: string) {
                    const request = { result: rows.get(sessionId), onsuccess: null as null | (() => void), onerror: null as null | (() => void) };
                    queueMicrotask(() => {
                      request.onsuccess?.();
                      queueMicrotask(() => tx.oncomplete?.());
                    });
                    return request;
                  },
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

describe('saveSession semantic pack identity and revision gate', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('saves a valid 1.3 session and keeps semantic answer edits without changing pack identity', async () => {
    const rows = installMemoryDatabase();
    const session = await createSemanticSession(pack, { clientLabel: 'Synthetic Client' }, new Date('2026-10-31T12:00:00.000Z'));
    const digest = session.packIdentity.digest;
    const first = await saveSession(session, null);

    const edited = structuredClone(first);
    edited.updatedAt = '2026-10-31T12:05:00.000Z';
    const question = edited.packSnapshot.questions.find((item) => item.id === 'primary-goal')!;
    edited.answers[question.id] = applyValueEdit(question, edited.answers[question.id]!, 'A saved answer.');
    edited.answers[question.id]!.note = 'A saved note.';
    const saved = await saveSession(edited, first.revisionId);

    expect(edited.packIdentity).toEqual(session.packIdentity);
    expect(edited.packSnapshot).toEqual(session.packSnapshot);
    expect(edited.packIdentity.digest).toBe(digest);
    expect(saved).toMatchObject({ revisionId: expect.any(String), parentRevisionId: first.revisionId });
    expect(rows.get(session.sessionId)).toMatchObject({
      updatedAt: '2026-10-31T12:05:00.000Z',
      answers: {
        'primary-goal': {
          value: 'A saved answer.',
          resolution: 'captured',
          source: 'client-statement',
          needsConfirmation: false,
          note: 'A saved note.',
        },
      },
      packIdentity: { digest },
    });
  });

  it('rejects a tampered snapshot before replacing the stored row', async () => {
    const rows = installMemoryDatabase();
    const session = await createSemanticSession(pack, { clientLabel: 'Synthetic Client' }, new Date('2026-10-31T12:00:00.000Z'));
    const first = await saveSession(session, null);
    const tampered = structuredClone(first);
    tampered.packSnapshot.questions[0]!.prompt = 'Drifted prompt';

    await expect(saveSession(tampered, first.revisionId)).rejects.toThrow(/digest/i);
    const stored = rows.get(session.sessionId) as { packSnapshot: { questions: Array<{ prompt: string }> } };
    expect(stored.packSnapshot.questions[0]?.prompt).toBe(session.packSnapshot.questions[0]?.prompt);
  });

  it('rejects a tampered digest before replacing the stored row', async () => {
    const rows = installMemoryDatabase();
    const session = await createSemanticSession(pack, { clientLabel: 'Synthetic Client' }, new Date('2026-10-31T12:00:00.000Z'));
    const saved = await saveSession(session, null);
    const tampered = structuredClone(saved);
    tampered.packIdentity.digest = 'c'.repeat(64);

    await expect(saveSession(tampered, saved.revisionId)).rejects.toThrow(/digest/i);
    expect((rows.get(session.sessionId) as { packIdentity: { digest: string } }).packIdentity.digest).toBe(session.packIdentity.digest);
  });

  it('rejects a stale expected revision without mutating the current row', async () => {
    const rows = installMemoryDatabase();
    const initial = await createSemanticSession(pack, { clientLabel: 'Synthetic Client' }, new Date('2026-10-31T12:00:00.000Z'));
    const r1 = await saveSession(initial, null);
    const a = structuredClone(r1);
    a.updatedAt = '2026-10-31T12:01:00.000Z';
    a.runningNotes = 'Tab A';
    const r2 = await saveSession(a, r1.revisionId);
    const b = structuredClone(r1);
    b.updatedAt = '2026-10-31T12:02:00.000Z';
    b.runningNotes = 'Stale tab B';

    await expect(saveSession(b, r1.revisionId)).rejects.toBeInstanceOf(RevisionConflictError);
    expect(rows.get(initial.sessionId)).toMatchObject({ revisionId: r2.revisionId, runningNotes: 'Tab A' });
  });
});

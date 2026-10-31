import { describe, expect, it, vi } from 'vitest';
import type { InterviewSession } from '../src/domain';
import { SessionAutosaveCoordinator } from '../src/autosave';
import { importSessionReplacement, openStoredSession, shouldFlushActiveSession } from '../src/session-durability';

function makeSession(sessionId: string, notes: string): InterviewSession {
  return {
    sessionSchemaVersion: '1.0.0',
    sessionId,
    interviewPackId: 'general-discovery',
    interviewPackVersion: '1.0.0',
    clientLabel: 'Synthetic',
    interviewerLabel: '',
    interviewMode: 'Conversation',
    createdAt: '2026-10-31T12:00:00.000Z',
    updatedAt: '2026-10-31T12:00:00.000Z',
    currentQuestionId: 'existing-presence',
    knownFacts: [],
    answers: {},
    runningNotes: notes,
  };
}

describe('session durability', () => {
  it('flushes a dirty same-ID session before replacement and keeps it when the import write fails', async () => {
    const store = new Map<string, InterviewSession>();
    const dirty = makeSession('session-a', 'dirty local');
    const imported = makeSession('session-a', 'imported replacement');
    const coordinator = new SessionAutosaveCoordinator(async (value) => {
      store.set(value.sessionId, structuredClone(value));
    });
    coordinator.schedule(dirty);

    const result = await importSessionReplacement({
      imported,
      flush: (sessionId) => coordinator.flushAndWait(sessionId),
      load: async (sessionId) => store.get(sessionId),
      confirmReplace: () => true,
      save: async () => {
        throw new Error('synthetic replacement failure');
      },
    });

    expect(result.kind).toBe('aborted-save');
    expect(store.get('session-a')?.runningNotes).toBe('dirty local');
    expect(coordinator.hasPending('session-a')).toBe(false);
  });

  it('keeps a flushed local row when replacement is cancelled', async () => {
    const store = new Map<string, InterviewSession>();
    const dirty = makeSession('session-a', 'dirty local');
    const coordinator = new SessionAutosaveCoordinator(async (value) => {
      store.set(value.sessionId, structuredClone(value));
    });
    coordinator.schedule(dirty);
    const save = vi.fn(async () => undefined);

    const result = await importSessionReplacement({
      imported: makeSession('session-a', 'imported'),
      flush: (sessionId) => coordinator.flushAndWait(sessionId),
      load: async (sessionId) => store.get(sessionId),
      confirmReplace: () => false,
      save,
    });

    expect(result.kind).toBe('aborted-cancelled');
    expect(save).not.toHaveBeenCalled();
    expect(store.get('session-a')?.runningNotes).toBe('dirty local');
  });

  it('does not replace a local row when confirmation is cancelled', async () => {
    const store = new Map<string, InterviewSession>([['session-a', makeSession('session-a', 'kept local')]]);
    const save = vi.fn(async () => undefined);

    const result = await importSessionReplacement({
      imported: makeSession('session-a', 'imported'),
      flush: async () => undefined,
      load: async (sessionId) => store.get(sessionId),
      confirmReplace: () => false,
      save,
    });

    expect(result.kind).toBe('aborted-cancelled');
    expect(save).not.toHaveBeenCalled();
    expect(store.get('session-a')?.runningNotes).toBe('kept local');
  });

  it('aborts import before replacement when the pre-write flush fails', async () => {
    const load = vi.fn(async () => makeSession('session-a', 'stored'));
    const save = vi.fn(async () => undefined);

    const result = await importSessionReplacement({
      imported: makeSession('session-a', 'imported'),
      flush: async () => {
        throw new Error('synthetic flush failure');
      },
      load,
      confirmReplace: () => true,
      save,
    });

    expect(result).toMatchObject({ kind: 'aborted-flush' });
    expect(load).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('does not read a session when the pre-open flush fails', async () => {
    const load = vi.fn(async () => makeSession('session-a', 'stored'));

    const result = await openStoredSession({
      sessionId: 'session-a',
      flush: async () => {
        throw new Error('synthetic flush failure');
      },
      load,
    });

    expect(result.kind).toBe('save-failure');
    expect(load).not.toHaveBeenCalled();
  });

  it('keeps a genuine load failure distinct from a save failure', async () => {
    const result = await openStoredSession({
      sessionId: 'session-a',
      flush: async () => undefined,
      load: async () => {
        throw new Error('synthetic read failure');
      },
    });

    expect(result.kind).toBe('read-failure');
  });

  it('flushes on page hide and when the document becomes hidden, once per pending edit', async () => {
    expect(shouldFlushActiveSession({ type: 'pagehide' })).toBe(true);
    expect(shouldFlushActiveSession({ type: 'visibilitychange', visibilityState: 'hidden' })).toBe(true);
    expect(shouldFlushActiveSession({ type: 'visibilitychange', visibilityState: 'visible' })).toBe(false);

    vi.useFakeTimers();
    try {
      const persisted: string[] = [];
      const coordinator = new SessionAutosaveCoordinator(async (value) => {
        persisted.push(value.runningNotes);
      });
      const active = makeSession('session-a', 'latest before hide');
      coordinator.schedule(active);
      await vi.advanceTimersByTimeAsync(50);

      await coordinator.flushAndWait(active.sessionId);
      await coordinator.flushAndWait(active.sessionId);

      expect(persisted).toEqual(['latest before hide']);
      expect(coordinator.hasPending(active.sessionId)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

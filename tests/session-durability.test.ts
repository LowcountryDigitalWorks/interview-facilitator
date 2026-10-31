import { describe, expect, it, vi } from 'vitest';
import type { InterviewSession } from '../src/domain';
import { SessionAutosaveCoordinator } from '../src/autosave';
import { beginSessionSwitch, importSessionReplacement, openStoredSession, SessionSwitchGate, shouldFlushActiveSession } from '../src/session-durability';

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

  it('keeps a dirty outgoing session when switching, creating, or importing fails, then retries the save', async () => {
    let fail = true;
    const persisted: string[] = [];
    const coordinator = new SessionAutosaveCoordinator(async (value) => {
      persisted.push(`${value.sessionId}:${value.runningNotes}`);
      if (fail && value.sessionId === 'session-a') throw new Error('synthetic outgoing failure');
    });
    const active = makeSession('session-a', 'dirty local');
    coordinator.schedule(active);
    const load = vi.fn(async () => makeSession('session-b', 'stored b'));
    const saveImported = vi.fn(async () => undefined);
    const saveCreated = vi.fn(async () => undefined);

    const opened = await beginSessionSwitch({
      active,
      nextSessionId: 'session-b',
      flush: (sessionId) => coordinator.flushAndWait(sessionId),
      proceed: () => openStoredSession({
        sessionId: 'session-b',
        flush: (sessionId) => coordinator.flushAndWait(sessionId),
        load,
      }),
    });
    const created = await beginSessionSwitch({
      active,
      nextSessionId: 'session-new',
      flush: (sessionId) => coordinator.flushAndWait(sessionId),
      proceed: async () => {
        await saveCreated();
        return makeSession('session-new', 'created');
      },
    });
    const imported = await beginSessionSwitch({
      active,
      nextSessionId: 'session-import',
      flush: (sessionId) => coordinator.flushAndWait(sessionId),
      proceed: () => importSessionReplacement({
        imported: makeSession('session-import', 'imported'),
        flush: async () => undefined,
        load: async () => undefined,
        confirmReplace: () => true,
        save: saveImported,
      }),
    });

    expect(opened.kind).toBe('save-failure');
    expect(created.kind).toBe('save-failure');
    expect(imported.kind).toBe('save-failure');
    expect(load).not.toHaveBeenCalled();
    expect(saveCreated).not.toHaveBeenCalled();
    expect(saveImported).not.toHaveBeenCalled();
    expect(active.runningNotes).toBe('dirty local');

    fail = false;
    const retried = await beginSessionSwitch({
      active,
      nextSessionId: 'session-b',
      flush: (sessionId) => coordinator.flushAndWait(sessionId),
      proceed: () => openStoredSession({
        sessionId: 'session-b',
        flush: (sessionId) => coordinator.flushAndWait(sessionId),
        load,
      }),
    });

    expect(retried.kind).toBe('proceeded');
    expect(load).toHaveBeenCalledTimes(1);
    expect(persisted).toContain('session-a:dirty local');
    expect(persisted.filter((value) => value === 'session-a:dirty local').length).toBeGreaterThan(1);
  });

  it('ignores an overlapping replacement and runs a later one after release', async () => {
    const gate = new SessionSwitchGate();
    let releaseFirst: () => void = () => undefined;
    const firstHold = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const calls: string[] = [];

    const first = gate.run(async () => {
      calls.push('first');
      await firstHold;
      return 'first-done';
    });
    const second = gate.run(async () => {
      calls.push('second');
      return 'second-done';
    });

    expect(await second).toEqual({ kind: 'busy' });
    expect(calls).toEqual(['first']);
    releaseFirst();
    await expect(first).resolves.toEqual({ kind: 'completed', value: 'first-done' });

    const third = await gate.run(async () => {
      calls.push('third');
      return 'third-done';
    });
    expect(third).toEqual({ kind: 'completed', value: 'third-done' });
    expect(calls).toEqual(['first', 'third']);
  });

  it('releases the gate when the active replacement throws', async () => {
    const gate = new SessionSwitchGate();
    await expect(gate.run(async () => {
      throw new Error('synthetic replacement failure');
    })).rejects.toThrow('synthetic replacement failure');

    await expect(gate.run(async () => 'after')).resolves.toEqual({ kind: 'completed', value: 'after' });
  });

  it('lets only the first of two concurrent session switches proceed', async () => {
    const gate = new SessionSwitchGate();
    let releaseFlush: () => void = () => undefined;
    const flushHold = new Promise<void>((resolve) => {
      releaseFlush = resolve;
    });
    const load = vi.fn(async (sessionId: string) => makeSession(sessionId, 'stored'));
    const save = vi.fn(async () => undefined);
    const assigned: string[] = [];

    const first = gate.run(async () => {
      const outcome = await beginSessionSwitch({
        active: makeSession('session-a', 'active'),
        nextSessionId: 'session-b',
        flush: async () => {
          await flushHold;
        },
        proceed: () => openStoredSession({
          sessionId: 'session-b',
          flush: async () => undefined,
          load,
        }),
      });
      if (outcome.kind === 'proceeded' && outcome.value.kind === 'opened') assigned.push(outcome.value.session.sessionId);
      return outcome;
    });
    const second = gate.run(async () => {
      const outcome = await beginSessionSwitch({
        active: makeSession('session-a', 'active'),
        nextSessionId: 'session-c',
        flush: async () => undefined,
        proceed: async () => {
          await save();
          return makeSession('session-c', 'created');
        },
      });
      if (outcome.kind === 'proceeded') assigned.push('session-c');
      return outcome;
    });

    expect(await second).toEqual({ kind: 'busy' });
    releaseFlush();
    const completed = await first;
    expect(completed.kind).toBe('completed');
    expect(load).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
    expect(assigned).toEqual(['session-b']);
  });
});

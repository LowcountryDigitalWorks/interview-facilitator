import { describe, expect, it, vi } from 'vitest';
import type { InterviewSession } from '../src/domain';
import { SessionAutosaveCoordinator } from '../src/autosave';
import { beginSessionSwitch, importSessionWithCollisionHandling, openStoredSession, SessionSwitchGate, shouldFlushActiveSession } from '../src/session-durability';
import { bareSession } from './session-stub';

function makeSession(sessionId: string, notes: string): InterviewSession {
  return bareSession(sessionId, notes);
}

describe('session durability', () => {
  it('treats a same-ID semantically identical import as a no-op despite revision metadata drift', async () => {
    const existing = makeSession('session-a', 'same content');
    const imported = structuredClone(existing);
    imported.revisionId = crypto.randomUUID();
    imported.parentRevisionId = crypto.randomUUID();
    imported.updatedAt = '2026-11-02T01:00:00.000Z';
    const chooseCollision = vi.fn(() => 'replace' as const);
    const save = vi.fn(async (value: InterviewSession) => value);
    const replace = vi.fn(async (value: InterviewSession) => value);

    const result = await importSessionWithCollisionHandling({
      imported,
      flush: async () => undefined,
      load: async () => existing,
      chooseCollision,
      save,
      replace,
    });

    expect(result).toEqual({ kind: 'noop', session: existing });
    expect(chooseCollision).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it('defaults a different same-ID import to an explicit copy with a new session and revision lineage', async () => {
    const existing = makeSession('session-a', 'local');
    const imported = makeSession('session-a', 'imported different content');
    const save = vi.fn(async (value: InterviewSession, expectedRevisionId: string | null) => ({
      ...structuredClone(value),
      revisionId: 'saved-copy-revision',
      parentRevisionId: expectedRevisionId,
    }));
    const replace = vi.fn(async (value: InterviewSession) => value);

    const result = await importSessionWithCollisionHandling({
      imported,
      flush: async () => undefined,
      load: async () => existing,
      chooseCollision: () => 'copy',
      save,
      replace,
    });

    expect(result.kind).toBe('forked');
    expect(save).toHaveBeenCalledTimes(1);
    const [fork, expectedRevisionId] = save.mock.calls[0]!;
    expect(fork.sessionId).not.toBe(existing.sessionId);
    expect(fork.sessionId).not.toBe(imported.sessionId);
    expect(fork.revisionId).not.toBe(imported.revisionId);
    expect(fork.parentRevisionId).toBeNull();
    expect(fork.runningNotes).toBe(imported.runningNotes);
    expect(expectedRevisionId).toBeNull();
    expect(replace).not.toHaveBeenCalled();
  });

  it('uses the collision revision as the expected revision for an explicit replace', async () => {
    const existing = makeSession('session-a', 'local');
    const imported = makeSession('session-a', 'replacement');
    const replace = vi.fn(async (value: InterviewSession, expectedRevisionId: string) => ({
      ...structuredClone(value),
      revisionId: 'replacement-revision',
      parentRevisionId: expectedRevisionId,
    }));
    const save = vi.fn(async (value: InterviewSession) => value);

    const result = await importSessionWithCollisionHandling({
      imported,
      flush: async () => undefined,
      load: async () => existing,
      chooseCollision: () => 'replace',
      save,
      replace,
    });

    expect(result.kind).toBe('replaced');
    expect(replace).toHaveBeenCalledWith(imported, existing.revisionId);
    expect(save).not.toHaveBeenCalled();
  });

  it('cancels a collision without saving or replacing either record', async () => {
    const existing = makeSession('session-a', 'kept local');
    const save = vi.fn(async (value: InterviewSession) => value);
    const replace = vi.fn(async (value: InterviewSession) => value);

    const result = await importSessionWithCollisionHandling({
      imported: makeSession('session-a', 'different imported content'),
      flush: async () => undefined,
      load: async () => existing,
      chooseCollision: () => 'cancel',
      save,
      replace,
    });

    expect(result.kind).toBe('aborted-cancelled');
    expect(save).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it('imports a previously unseen session through the ordinary CAS save path with no imported ancestry', async () => {
    const imported = makeSession('session-new', 'new import');
    imported.parentRevisionId = crypto.randomUUID();
    const save = vi.fn(async (value: InterviewSession, expectedRevisionId: string | null) => ({
      ...structuredClone(value),
      revisionId: 'local-import-revision',
      parentRevisionId: expectedRevisionId,
    }));

    const result = await importSessionWithCollisionHandling({
      imported,
      flush: async () => undefined,
      load: async () => undefined,
      chooseCollision: () => 'cancel',
      save,
      replace: async (value) => value,
    });

    expect(result.kind).toBe('imported');
    expect(save).toHaveBeenCalledWith(imported, null);
    if (result.kind === 'imported') expect(result.session.parentRevisionId).toBeNull();
  });

  it('flushes a dirty same-ID session before comparing an import and preserves it when the import is cancelled', async () => {
    const store = new Map<string, InterviewSession>();
    const dirty = makeSession('session-a', 'dirty local');
    const coordinator = new SessionAutosaveCoordinator(async (value) => {
      store.set(value.sessionId, structuredClone(value));
    });
    coordinator.schedule(dirty);

    const result = await importSessionWithCollisionHandling({
      imported: makeSession('session-a', 'different import'),
      flush: (sessionId) => coordinator.flushAndWait(sessionId),
      load: async (sessionId) => store.get(sessionId),
      chooseCollision: () => 'cancel',
      save: async (value) => value,
      replace: async (value) => value,
    });

    expect(result.kind).toBe('aborted-cancelled');
    expect(store.get('session-a')?.runningNotes).toBe('dirty local');
    expect(coordinator.hasPending('session-a')).toBe(false);
  });

  it('aborts import before any read or write when the pre-import flush fails', async () => {
    const load = vi.fn(async () => makeSession('session-a', 'stored'));
    const save = vi.fn(async (value: InterviewSession) => value);
    const replace = vi.fn(async (value: InterviewSession) => value);

    const result = await importSessionWithCollisionHandling({
      imported: makeSession('session-a', 'imported'),
      flush: async () => { throw new Error('synthetic flush failure'); },
      load,
      chooseCollision: () => 'replace',
      save,
      replace,
    });

    expect(result).toMatchObject({ kind: 'aborted-flush' });
    expect(load).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it('does not read a session when the pre-open flush fails', async () => {
    const load = vi.fn(async () => makeSession('session-a', 'stored'));

    const result = await openStoredSession({
      sessionId: 'session-a',
      flush: async () => { throw new Error('synthetic flush failure'); },
      load,
    });

    expect(result.kind).toBe('save-failure');
    expect(load).not.toHaveBeenCalled();
  });

  it('keeps a genuine load failure distinct from a save failure', async () => {
    const result = await openStoredSession({
      sessionId: 'session-a',
      flush: async () => undefined,
      load: async () => { throw new Error('synthetic read failure'); },
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
      const coordinator = new SessionAutosaveCoordinator(async (value) => { persisted.push(value.runningNotes); });
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
    const saveImported = vi.fn(async (value: InterviewSession) => value);
    const replaceImported = vi.fn(async (value: InterviewSession) => value);
    const saveCreated = vi.fn(async () => undefined);

    const opened = await beginSessionSwitch({
      active,
      nextSessionId: 'session-b',
      flush: (sessionId) => coordinator.flushAndWait(sessionId),
      proceed: () => openStoredSession({ sessionId: 'session-b', flush: (sessionId) => coordinator.flushAndWait(sessionId), load }),
    });
    const created = await beginSessionSwitch({
      active,
      nextSessionId: 'session-new',
      flush: (sessionId) => coordinator.flushAndWait(sessionId),
      proceed: async () => { await saveCreated(); return makeSession('session-new', 'created'); },
    });
    const imported = await beginSessionSwitch({
      active,
      nextSessionId: 'session-import',
      flush: (sessionId) => coordinator.flushAndWait(sessionId),
      proceed: () => importSessionWithCollisionHandling({
        imported: makeSession('session-import', 'imported'),
        flush: async () => undefined,
        load: async () => undefined,
        chooseCollision: () => 'copy',
        save: saveImported,
        replace: replaceImported,
      }),
    });

    expect(opened.kind).toBe('save-failure');
    expect(created.kind).toBe('save-failure');
    expect(imported.kind).toBe('save-failure');
    expect(load).not.toHaveBeenCalled();
    expect(saveCreated).not.toHaveBeenCalled();
    expect(saveImported).not.toHaveBeenCalled();
    expect(replaceImported).not.toHaveBeenCalled();
    expect(active.runningNotes).toBe('dirty local');

    fail = false;
    const retried = await beginSessionSwitch({
      active,
      nextSessionId: 'session-b',
      flush: (sessionId) => coordinator.flushAndWait(sessionId),
      proceed: () => openStoredSession({ sessionId: 'session-b', flush: (sessionId) => coordinator.flushAndWait(sessionId), load }),
    });

    expect(retried.kind).toBe('proceeded');
    expect(load).toHaveBeenCalledTimes(1);
    expect(persisted).toContain('session-a:dirty local');
    expect(persisted.filter((value) => value === 'session-a:dirty local').length).toBeGreaterThan(1);
  });

  it('ignores an overlapping replacement and runs a later one after release', async () => {
    const gate = new SessionSwitchGate();
    let releaseFirst: () => void = () => undefined;
    const firstHold = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const calls: string[] = [];

    const first = gate.run(async () => { calls.push('first'); await firstHold; return 'first-done'; });
    const second = gate.run(async () => { calls.push('second'); return 'second-done'; });

    expect(await second).toEqual({ kind: 'busy' });
    expect(calls).toEqual(['first']);
    releaseFirst();
    await expect(first).resolves.toEqual({ kind: 'completed', value: 'first-done' });

    const third = await gate.run(async () => { calls.push('third'); return 'third-done'; });
    expect(third).toEqual({ kind: 'completed', value: 'third-done' });
    expect(calls).toEqual(['first', 'third']);
  });

  it('releases the gate when the active replacement throws', async () => {
    const gate = new SessionSwitchGate();
    await expect(gate.run(async () => { throw new Error('synthetic replacement failure'); })).rejects.toThrow('synthetic replacement failure');
    await expect(gate.run(async () => 'after')).resolves.toEqual({ kind: 'completed', value: 'after' });
  });

  it('lets only the first of two concurrent session switches proceed', async () => {
    const gate = new SessionSwitchGate();
    let releaseFlush: () => void = () => undefined;
    const flushHold = new Promise<void>((resolve) => { releaseFlush = resolve; });
    const load = vi.fn(async (sessionId: string) => makeSession(sessionId, 'stored'));
    const save = vi.fn(async () => undefined);
    const assigned: string[] = [];

    const first = gate.run(async () => {
      const outcome = await beginSessionSwitch({
        active: makeSession('session-a', 'active'),
        nextSessionId: 'session-b',
        flush: async () => { await flushHold; },
        proceed: () => openStoredSession({ sessionId: 'session-b', flush: async () => undefined, load }),
      });
      if (outcome.kind === 'proceeded' && outcome.value.kind === 'opened') assigned.push(outcome.value.session.sessionId);
      return outcome;
    });
    const second = gate.run(async () => {
      const outcome = await beginSessionSwitch({
        active: makeSession('session-a', 'active'),
        nextSessionId: 'session-c',
        flush: async () => undefined,
        proceed: async () => { await save(); return makeSession('session-c', 'created'); },
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

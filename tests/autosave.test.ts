import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionAutosaveCoordinator } from '../src/autosave';
import type { InterviewSession } from '../src/domain';

function makeSession(sessionId: string): InterviewSession {
  return {
    sessionSchemaVersion: '1.0.0',
    sessionId,
    interviewPackId: 'general-discovery',
    interviewPackVersion: '1.0.0',
    clientLabel: sessionId,
    interviewerLabel: '',
    interviewMode: 'Conversation',
    createdAt: '2026-10-31T12:00:00.000Z',
    updatedAt: '2026-10-31T12:00:00.000Z',
    currentQuestionId: 'existing-presence',
    knownFacts: [],
    answers: {},
    runningNotes: '',
  };
}

describe('SessionAutosaveCoordinator', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('keeps pending saves bound to their original session', async () => {
    const persisted: InterviewSession[] = [];
    const coordinator = new SessionAutosaveCoordinator(async (value) => {
      persisted.push(structuredClone(value));
    });

    const sessionA = makeSession('session-a');
    sessionA.runningNotes = 'A latest';
    coordinator.schedule(sessionA);

    await vi.advanceTimersByTimeAsync(90);

    const sessionB = makeSession('session-b');
    sessionB.runningNotes = 'B latest';
    coordinator.schedule(sessionB);

    await vi.advanceTimersByTimeAsync(200);

    expect(persisted.map((value) => [value.sessionId, value.runningNotes])).toEqual([
      ['session-a', 'A latest'],
      ['session-b', 'B latest'],
    ]);
  });

  it('coalesces rapid edits for one session to the latest state', async () => {
    const persisted: InterviewSession[] = [];
    const coordinator = new SessionAutosaveCoordinator(async (value) => {
      persisted.push(structuredClone(value));
    });
    const active = makeSession('session-a');

    active.runningNotes = 'first';
    coordinator.schedule(active);
    await vi.advanceTimersByTimeAsync(100);

    active.runningNotes = 'second';
    coordinator.schedule(active);
    await vi.advanceTimersByTimeAsync(179);
    expect(persisted).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.runningNotes).toBe('second');
  });

  it('flushes a pending write before resume/load reads the record', async () => {
    const persisted: InterviewSession[] = [];
    const coordinator = new SessionAutosaveCoordinator(async (value) => {
      persisted.push(structuredClone(value));
    });
    const active = makeSession('session-a');
    active.runningNotes = 'latest before resume';

    coordinator.schedule(active);
    await vi.advanceTimersByTimeAsync(50);
    await coordinator.flushAndWait(active.sessionId);

    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.runningNotes).toBe('latest before resume');
    expect(coordinator.hasPending(active.sessionId)).toBe(false);
  });

  it('surfaces a failed flush instead of allowing stale resume data', async () => {
    const coordinator = new SessionAutosaveCoordinator(async () => {
      throw new Error('synthetic write failure');
    });
    const active = makeSession('session-a');

    coordinator.schedule(active);

    await expect(coordinator.flushAndWait(active.sessionId)).rejects.toThrow('synthetic write failure');
    expect(coordinator.hasPending(active.sessionId)).toBe(false);
  });

  it('cancels a pending write before delete/import replacement', async () => {
    const persisted: InterviewSession[] = [];
    const coordinator = new SessionAutosaveCoordinator(async (value) => {
      persisted.push(structuredClone(value));
    });
    const active = makeSession('session-a');

    coordinator.schedule(active);
    await coordinator.cancelAndWait(active.sessionId);
    await vi.advanceTimersByTimeAsync(250);

    expect(persisted).toEqual([]);
    expect(coordinator.hasPending(active.sessionId)).toBe(false);
    await coordinator.flushAndWait(active.sessionId);
    expect(persisted).toEqual([]);
  });

  it('waits for an in-flight write before destructive follow-up can continue', async () => {
    let release: (() => void) | undefined;
    const coordinator = new SessionAutosaveCoordinator(() => new Promise<void>((resolve) => {
      release = resolve;
    }));
    const active = makeSession('session-a');

    coordinator.schedule(active);
    await vi.advanceTimersByTimeAsync(180);

    let waitFinished = false;
    const wait = coordinator.cancelAndWait(active.sessionId).then(() => { waitFinished = true; });
    await Promise.resolve();
    expect(waitFinished).toBe(false);

    release?.();
    await wait;
    expect(waitFinished).toBe(true);
    expect(coordinator.hasPending(active.sessionId)).toBe(false);
  });

  it('suppresses stale completion callbacks when a newer save exists', async () => {
    let releaseFirst: (() => void) | undefined;
    let releaseSecond: (() => void) | undefined;
    let markSecondStarted: (() => void) | undefined;
    const secondStarted = new Promise<void>((resolve) => { markSecondStarted = resolve; });
    const persisted: InterviewSession[] = [];
    const savedLabels: string[] = [];
    let callCount = 0;

    const coordinator = new SessionAutosaveCoordinator((value) => new Promise<void>((resolve) => {
      callCount += 1;
      persisted.push(structuredClone(value));
      if (callCount === 1) releaseFirst = resolve;
      else {
        releaseSecond = resolve;
        markSecondStarted?.();
      }
    }));
    const active = makeSession('session-a');

    active.runningNotes = 'first';
    coordinator.schedule(active, { onSaved: (_id, value) => savedLabels.push(value.runningNotes) });
    await vi.advanceTimersByTimeAsync(180);

    active.runningNotes = 'second';
    coordinator.schedule(active, { onSaved: (_id, value) => savedLabels.push(value.runningNotes) });
    await vi.advanceTimersByTimeAsync(180);

    expect(persisted.map((value) => value.runningNotes)).toEqual(['first']);
    releaseFirst?.();
    await secondStarted;

    expect(persisted.map((value) => value.runningNotes)).toEqual(['first', 'second']);
    expect(savedLabels).toEqual([]);

    releaseSecond?.();
    await coordinator.flushAndWait(active.sessionId);

    expect(savedLabels).toEqual(['second']);
  });
});

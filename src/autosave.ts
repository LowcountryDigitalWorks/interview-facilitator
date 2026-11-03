import type { InterviewSession } from './domain';
import type { RevisionedSession } from './session-semantic';

export interface AutosaveHooks<T extends RevisionedSession> {
  onScheduled?: (sessionId: string) => void;
  onSaved?: (sessionId: string, savedSession: T) => void;
  onError?: (sessionId: string, error: unknown) => void;
}

type TimerHandle = ReturnType<typeof setTimeout>;

interface PendingTimer {
  handle: TimerHandle;
  run: () => void;
}

export class SessionAutosaveCoordinator<T extends RevisionedSession = InterviewSession> {
  private readonly timers = new Map<string, PendingTimer>();
  private readonly generations = new Map<string, number>();
  private readonly tails = new Map<string, Promise<void>>();
  private readonly errors = new Map<string, unknown>();
  private readonly liveSessions = new Map<string, T>();
  private readonly expectedRevisions = new Map<string, string | null>();

  constructor(
    private readonly persist: (session: T, expectedRevisionId: string | null) => Promise<NoInfer<T> | void>,
    private readonly delayMs = 180,
  ) {}

  schedule(session: T, hooks: AutosaveHooks<T> = {}): void {
    this.liveSessions.set(session.sessionId, session);
    if (!this.timers.has(session.sessionId) && !this.tails.has(session.sessionId)) {
      this.expectedRevisions.set(session.sessionId, session.revisionId);
    } else if (!this.expectedRevisions.has(session.sessionId)) {
      this.expectedRevisions.set(session.sessionId, session.revisionId);
    }
    this.queue(session, hooks, this.delayMs);
  }

  private queue(session: T, hooks: AutosaveHooks<T>, delayMs: number): void {
    const sessionId = session.sessionId;
    const generation = (this.generations.get(sessionId) ?? 0) + 1;
    this.generations.set(sessionId, generation);
    this.errors.delete(sessionId);

    const existingTimer = this.timers.get(sessionId);
    if (existingTimer) clearTimeout(existingTimer.handle);

    hooks.onScheduled?.(sessionId);

    const run = (): void => {
      const pending = this.timers.get(sessionId);
      if (pending?.run === run) this.timers.delete(sessionId);

      const snapshot = structuredClone(session);
      snapshot.updatedAt = new Date().toISOString();
      const previous = this.tails.get(sessionId) ?? Promise.resolve();

      const operation = previous
        .catch(() => undefined)
        .then(async () => {
          try {
            const expectedRevisionId = this.expectedRevisions.get(sessionId) ?? null;
            const saved = await this.persist(snapshot, expectedRevisionId);
            const savedSession = saved ?? {
              ...snapshot,
              revisionId: crypto.randomUUID(),
              parentRevisionId: expectedRevisionId,
            } as T;
            this.expectedRevisions.set(sessionId, savedSession.revisionId);
            const liveSession = this.liveSessions.get(sessionId);
            if (liveSession) {
              liveSession.updatedAt = savedSession.updatedAt;
              liveSession.revisionId = savedSession.revisionId;
              liveSession.parentRevisionId = savedSession.parentRevisionId;
            }
            if (this.generations.get(sessionId) === generation) {
              this.generations.delete(sessionId);
              this.errors.delete(sessionId);
              hooks.onSaved?.(sessionId, savedSession);
            }
          } catch (error) {
            if (this.generations.get(sessionId) === generation) {
              this.generations.delete(sessionId);
              this.errors.set(sessionId, error);
              hooks.onError?.(sessionId, error);
            }
          }
        });

      this.tails.set(sessionId, operation);
      void operation.finally(() => {
        if (this.tails.get(sessionId) === operation) this.tails.delete(sessionId);
      });
    };

    const handle = setTimeout(run, delayMs);
    this.timers.set(sessionId, { handle, run });
  }

  hasPending(sessionId: string): boolean {
    return this.timers.has(sessionId) || this.tails.has(sessionId);
  }

  async flushAndWait(sessionId: string): Promise<void> {
    if (!this.timers.has(sessionId) && !this.tails.has(sessionId) && this.errors.has(sessionId)) {
      const live = this.liveSessions.get(sessionId);
      if (live) this.queue(live, {}, 0);
    }

    const pending = this.timers.get(sessionId);
    if (pending) {
      clearTimeout(pending.handle);
      this.timers.delete(sessionId);
      pending.run();
    }

    const tail = this.tails.get(sessionId);
    if (tail) await tail.catch(() => undefined);

    if (this.errors.has(sessionId)) throw this.errors.get(sessionId);
  }

  async cancelAndWait(sessionId: string): Promise<void> {
    const pending = this.timers.get(sessionId);
    if (pending) {
      clearTimeout(pending.handle);
      this.timers.delete(sessionId);
    }

    // Suppress completion/error callbacks for any save that is already in flight.
    this.generations.delete(sessionId);

    const tail = this.tails.get(sessionId);
    if (tail) await tail.catch(() => undefined);
    this.errors.delete(sessionId);
    this.liveSessions.delete(sessionId);
    this.expectedRevisions.delete(sessionId);
  }
}

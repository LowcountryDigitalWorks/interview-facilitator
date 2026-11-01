import type { InterviewSession } from './domain';
import { touch } from './domain';

export interface AutosaveHooks {
  onScheduled?: (sessionId: string) => void;
  onSaved?: (sessionId: string, savedSession: InterviewSession) => void;
  onError?: (sessionId: string, error: unknown) => void;
}

type TimerHandle = ReturnType<typeof setTimeout>;

interface PendingTimer {
  handle: TimerHandle;
  run: () => void;
}

export class SessionAutosaveCoordinator {
  private readonly timers = new Map<string, PendingTimer>();
  private readonly generations = new Map<string, number>();
  private readonly tails = new Map<string, Promise<void>>();
  private readonly errors = new Map<string, unknown>();
  private readonly liveSessions = new Map<string, InterviewSession>();

  constructor(
    private readonly persist: (session: InterviewSession) => Promise<void>,
    private readonly delayMs = 180,
  ) {}

  schedule(session: InterviewSession, hooks: AutosaveHooks = {}): void {
    this.liveSessions.set(session.sessionId, session);
    this.queue(session, hooks, this.delayMs);
  }

  private queue(session: InterviewSession, hooks: AutosaveHooks, delayMs: number): void {
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

      const snapshot = touch(structuredClone(session));
      const previous = this.tails.get(sessionId) ?? Promise.resolve();

      const operation = previous
        .catch(() => undefined)
        .then(async () => {
          try {
            await this.persist(snapshot);
            if (this.generations.get(sessionId) === generation) {
              this.generations.delete(sessionId);
              this.errors.delete(sessionId);
              hooks.onSaved?.(sessionId, snapshot);
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
  }
}

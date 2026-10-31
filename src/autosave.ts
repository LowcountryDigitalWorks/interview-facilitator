import type { InterviewSession } from './domain';
import { touch } from './domain';

export interface AutosaveHooks {
  onScheduled?: (sessionId: string) => void;
  onSaved?: (sessionId: string, savedSession: InterviewSession) => void;
  onError?: (sessionId: string, error: unknown) => void;
}

type TimerHandle = ReturnType<typeof setTimeout>;

export class SessionAutosaveCoordinator {
  private readonly timers = new Map<string, TimerHandle>();
  private readonly generations = new Map<string, number>();
  private readonly tails = new Map<string, Promise<void>>();

  constructor(
    private readonly persist: (session: InterviewSession) => Promise<void>,
    private readonly delayMs = 180,
  ) {}

  schedule(session: InterviewSession, hooks: AutosaveHooks = {}): void {
    const sessionId = session.sessionId;
    const generation = (this.generations.get(sessionId) ?? 0) + 1;
    this.generations.set(sessionId, generation);

    const existingTimer = this.timers.get(sessionId);
    if (existingTimer !== undefined) clearTimeout(existingTimer);

    hooks.onScheduled?.(sessionId);

    const timer = setTimeout(() => {
      this.timers.delete(sessionId);
      const snapshot = touch(structuredClone(session));
      const previous = this.tails.get(sessionId) ?? Promise.resolve();

      const operation = previous
        .catch(() => undefined)
        .then(async () => {
          try {
            await this.persist(snapshot);
            if (this.generations.get(sessionId) === generation) {
              this.generations.delete(sessionId);
              hooks.onSaved?.(sessionId, snapshot);
            }
          } catch (error) {
            if (this.generations.get(sessionId) === generation) {
              this.generations.delete(sessionId);
              hooks.onError?.(sessionId, error);
            }
          }
        });

      this.tails.set(sessionId, operation);
      void operation.finally(() => {
        if (this.tails.get(sessionId) === operation) this.tails.delete(sessionId);
      });
    }, this.delayMs);

    this.timers.set(sessionId, timer);
  }

  hasPending(sessionId: string): boolean {
    return this.timers.has(sessionId) || this.tails.has(sessionId);
  }

  async cancelAndWait(sessionId: string): Promise<void> {
    const timer = this.timers.get(sessionId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(sessionId);
    }

    // Suppress completion/error callbacks for any save that is already in flight.
    this.generations.delete(sessionId);

    const tail = this.tails.get(sessionId);
    if (tail) await tail.catch(() => undefined);
  }
}

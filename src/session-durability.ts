import type { InterviewSession } from './domain';
import {
  forkImportedSession,
  sessionsSemanticallyEqual,
  type RevisionedSession,
} from './session-semantic';

export type OpenStoredSessionResult<T extends RevisionedSession = InterviewSession> =
  | { kind: 'opened'; session: T }
  | { kind: 'missing' }
  | { kind: 'save-failure'; error: unknown }
  | { kind: 'read-failure'; error: unknown };

export type ImportCollisionChoice = 'copy' | 'replace' | 'cancel';

export type ImportSessionResult<T extends RevisionedSession = InterviewSession> =
  | { kind: 'imported'; session: T }
  | { kind: 'noop'; session: T }
  | { kind: 'forked'; session: T }
  | { kind: 'replaced'; session: T }
  | { kind: 'aborted-flush'; error: unknown }
  | { kind: 'aborted-cancelled' }
  | { kind: 'aborted-save'; error: unknown }
  | { kind: 'aborted-read'; error: unknown };

export type LifecycleFlushEvent =
  | { type: 'pagehide' }
  | { type: 'visibilitychange'; visibilityState: DocumentVisibilityState };

export function shouldFlushActiveSession(event: LifecycleFlushEvent): boolean {
  if (event.type === 'pagehide') return true;
  return event.visibilityState === 'hidden';
}

export type OutgoingFlushResult<T extends RevisionedSession = InterviewSession> =
  | { kind: 'ready' }
  | { kind: 'save-failure'; error: unknown; session: T };

export async function flushOutgoingSession<T extends RevisionedSession = InterviewSession>(input: {
  active: T | null;
  nextSessionId: string;
  flush: (sessionId: string) => Promise<void>;
}): Promise<OutgoingFlushResult<T>> {
  if (!input.active || input.active.sessionId === input.nextSessionId) return { kind: 'ready' };
  try {
    await input.flush(input.active.sessionId);
    return { kind: 'ready' };
  } catch (error) {
    return { kind: 'save-failure', error, session: input.active };
  }
}

export type SessionSwitchGateResult<T> =
  | { kind: 'completed'; value: T }
  | { kind: 'busy' };

export class SessionSwitchGate {
  private busy = false;

  async run<T>(operation: () => Promise<T>): Promise<SessionSwitchGateResult<T>> {
    if (this.busy) return { kind: 'busy' };
    this.busy = true;
    try {
      return { kind: 'completed', value: await operation() };
    } finally {
      this.busy = false;
    }
  }
}

export async function beginSessionSwitch<TSession extends RevisionedSession = InterviewSession, TValue = unknown>(input: {
  active: TSession | null;
  nextSessionId: string;
  flush: (sessionId: string) => Promise<void>;
  proceed: () => Promise<TValue>;
}): Promise<{ kind: 'proceeded'; value: TValue } | (OutgoingFlushResult<TSession> & { kind: 'save-failure' })> {
  const outgoing = await flushOutgoingSession(input);
  if (outgoing.kind === 'save-failure') return outgoing;
  return { kind: 'proceeded', value: await input.proceed() };
}

export async function openStoredSession<T extends RevisionedSession = InterviewSession>(input: {
  sessionId: string;
  flush: (sessionId: string) => Promise<void>;
  load: (sessionId: string) => Promise<T | undefined>;
}): Promise<OpenStoredSessionResult<T>> {
  try {
    await input.flush(input.sessionId);
  } catch (error) {
    return { kind: 'save-failure', error };
  }

  try {
    const loaded = await input.load(input.sessionId);
    if (!loaded) return { kind: 'missing' };
    return { kind: 'opened', session: loaded };
  } catch (error) {
    return { kind: 'read-failure', error };
  }
}

export async function importSessionWithCollisionHandling<T extends RevisionedSession = InterviewSession>(input: {
  imported: T;
  flush: (sessionId: string) => Promise<void>;
  load: (sessionId: string) => Promise<T | undefined>;
  chooseCollision: (existing: T, imported: T) => ImportCollisionChoice | Promise<ImportCollisionChoice>;
  save: (session: T, expectedRevisionId: string | null) => Promise<T>;
  replace: (session: T, expectedRevisionId: string) => Promise<T>;
  fork?: (session: T) => T;
}): Promise<ImportSessionResult<T>> {
  try {
    await input.flush(input.imported.sessionId);
  } catch (error) {
    return { kind: 'aborted-flush', error };
  }

  let existing: T | undefined;
  try {
    existing = await input.load(input.imported.sessionId);
  } catch (error) {
    return { kind: 'aborted-read', error };
  }

  if (!existing) {
    try {
      return { kind: 'imported', session: await input.save(input.imported, null) };
    } catch (error) {
      return { kind: 'aborted-save', error };
    }
  }

  if (sessionsSemanticallyEqual(existing, input.imported)) {
    return { kind: 'noop', session: existing };
  }

  const choice = await input.chooseCollision(existing, input.imported);
  if (choice === 'cancel') return { kind: 'aborted-cancelled' };

  try {
    if (choice === 'copy') {
      const fork = (input.fork ?? forkImportedSession<T>)(input.imported);
      return { kind: 'forked', session: await input.save(fork, null) };
    }
    return { kind: 'replaced', session: await input.replace(input.imported, existing.revisionId) };
  } catch (error) {
    return { kind: 'aborted-save', error };
  }
}

import type { InterviewSession } from './domain';

export type OpenStoredSessionResult =
  | { kind: 'opened'; session: InterviewSession }
  | { kind: 'missing' }
  | { kind: 'save-failure'; error: unknown }
  | { kind: 'read-failure'; error: unknown };

export type ImportReplacementResult =
  | { kind: 'replaced'; session: InterviewSession }
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

export type OutgoingFlushResult =
  | { kind: 'ready' }
  | { kind: 'save-failure'; error: unknown; session: InterviewSession };

export async function flushOutgoingSession(input: {
  active: InterviewSession | null;
  nextSessionId: string;
  flush: (sessionId: string) => Promise<void>;
}): Promise<OutgoingFlushResult> {
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

export async function beginSessionSwitch<T>(input: {
  active: InterviewSession | null;
  nextSessionId: string;
  flush: (sessionId: string) => Promise<void>;
  proceed: () => Promise<T>;
}): Promise<{ kind: 'proceeded'; value: T } | OutgoingFlushResult & { kind: 'save-failure' }> {
  const outgoing = await flushOutgoingSession(input);
  if (outgoing.kind === 'save-failure') return outgoing;
  return { kind: 'proceeded', value: await input.proceed() };
}

export async function openStoredSession(input: {
  sessionId: string;
  flush: (sessionId: string) => Promise<void>;
  load: (sessionId: string) => Promise<InterviewSession | undefined>;
}): Promise<OpenStoredSessionResult> {
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

export async function importSessionReplacement(input: {
  imported: InterviewSession;
  flush: (sessionId: string) => Promise<void>;
  load: (sessionId: string) => Promise<InterviewSession | undefined>;
  confirmReplace: () => boolean;
  save: (session: InterviewSession) => Promise<void>;
}): Promise<ImportReplacementResult> {
  try {
    await input.flush(input.imported.sessionId);
  } catch (error) {
    return { kind: 'aborted-flush', error };
  }

  let existing: InterviewSession | undefined;
  try {
    existing = await input.load(input.imported.sessionId);
  } catch (error) {
    return { kind: 'aborted-read', error };
  }

  if (existing && !input.confirmReplace()) return { kind: 'aborted-cancelled' };

  try {
    await input.save(input.imported);
  } catch (error) {
    return { kind: 'aborted-save', error };
  }

  return { kind: 'replaced', session: input.imported };
}

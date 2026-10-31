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

import type { InterviewSession } from './domain';

export type SessionListState =
  | { kind: 'ready'; sessions: InterviewSession[] }
  | { kind: 'error'; error: unknown };

export async function readSessionList(
  loader: () => Promise<InterviewSession[]>,
): Promise<SessionListState> {
  try {
    return { kind: 'ready', sessions: await loader() };
  } catch (error) {
    return { kind: 'error', error };
  }
}

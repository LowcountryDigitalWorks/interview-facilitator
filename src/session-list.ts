import type { InterviewSession } from './domain';
import type { StoredSessionList } from './storage';

export type SessionListState =
  | { kind: 'ready'; sessions: InterviewSession[]; unreadableCount: number }
  | { kind: 'error'; error: unknown };

export async function readSessionList(
  loader: () => Promise<StoredSessionList>,
): Promise<SessionListState> {
  try {
    const result = await loader();
    return { kind: 'ready', sessions: result.sessions, unreadableCount: result.unreadableCount };
  } catch (error) {
    return { kind: 'error', error };
  }
}

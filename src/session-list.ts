import type { SemanticInterviewSession } from './semantic-session';
import type { ClassifiedStoredRow, StoredSessionList } from './storage';

export type SessionListState =
  | { kind: 'ready'; sessions: SemanticInterviewSession[]; unreadableCount: number; rows: ClassifiedStoredRow[] }
  | { kind: 'error'; error: unknown };

export async function readSessionList(
  loader: () => Promise<StoredSessionList>,
): Promise<SessionListState> {
  try {
    const result = await loader();
    return { kind: 'ready', sessions: result.sessions, unreadableCount: result.unreadableCount, rows: result.rows ?? [] };
  } catch (error) {
    return { kind: 'error', error };
  }
}

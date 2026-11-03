import type { InterviewSession } from './domain';
import { canonicalizeJson } from './pack-identity';

export interface RevisionedSession {
  sessionId: string;
  revisionId: string;
  parentRevisionId: string | null;
  updatedAt: string;
}

// Import equality excludes only local revision/transport metadata. Keep this list narrow:
// session identity, createdAt, pinned pack identity/snapshot, and interview content remain semantic.
export const SESSION_SEMANTIC_EXCLUDED_FIELDS = ['revisionId', 'parentRevisionId', 'updatedAt'] as const;

export type SessionSemanticContent<T extends RevisionedSession> = Omit<T, typeof SESSION_SEMANTIC_EXCLUDED_FIELDS[number]>;

export function sessionSemanticContent<T extends RevisionedSession = InterviewSession>(session: T): SessionSemanticContent<T> {
  const { revisionId: _revisionId, parentRevisionId: _parentRevisionId, updatedAt: _updatedAt, ...semantic } = session;
  void _revisionId;
  void _parentRevisionId;
  void _updatedAt;
  return structuredClone(semantic) as SessionSemanticContent<T>;
}

export function sessionSemanticFingerprint<T extends RevisionedSession = InterviewSession>(session: T): string {
  return canonicalizeJson(sessionSemanticContent(session));
}

export function sessionsSemanticallyEqual<T extends RevisionedSession = InterviewSession>(left: T, right: T): boolean {
  return sessionSemanticFingerprint(left) === sessionSemanticFingerprint(right);
}

export function forkImportedSession<T extends RevisionedSession = InterviewSession>(
  imported: T,
  identity: { sessionId?: string; revisionId?: string; updatedAt?: string } = {},
): T {
  return {
    ...structuredClone(imported),
    sessionId: identity.sessionId ?? crypto.randomUUID(),
    revisionId: identity.revisionId ?? crypto.randomUUID(),
    parentRevisionId: null,
    updatedAt: identity.updatedAt ?? new Date().toISOString(),
  } as T;
}

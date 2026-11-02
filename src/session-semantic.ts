import type { InterviewSession } from './domain';
import { canonicalizeJson } from './pack-identity';

// Import equality excludes only local revision/transport metadata. Keep this list narrow:
// session identity, createdAt, pinned pack identity/snapshot, and interview content remain semantic.
export const SESSION_SEMANTIC_EXCLUDED_FIELDS = ['revisionId', 'parentRevisionId', 'updatedAt'] as const;

export type SessionSemanticContent = Omit<InterviewSession, typeof SESSION_SEMANTIC_EXCLUDED_FIELDS[number]>;

export function sessionSemanticContent(session: InterviewSession): SessionSemanticContent {
  const { revisionId: _revisionId, parentRevisionId: _parentRevisionId, updatedAt: _updatedAt, ...semantic } = session;
  void _revisionId;
  void _parentRevisionId;
  void _updatedAt;
  return structuredClone(semantic);
}

export function sessionSemanticFingerprint(session: InterviewSession): string {
  return canonicalizeJson(sessionSemanticContent(session));
}

export function sessionsSemanticallyEqual(left: InterviewSession, right: InterviewSession): boolean {
  return sessionSemanticFingerprint(left) === sessionSemanticFingerprint(right);
}

export function forkImportedSession(
  imported: InterviewSession,
  identity: { sessionId?: string; revisionId?: string; updatedAt?: string } = {},
): InterviewSession {
  return {
    ...structuredClone(imported),
    sessionId: identity.sessionId ?? crypto.randomUUID(),
    revisionId: identity.revisionId ?? crypto.randomUUID(),
    parentRevisionId: null,
    updatedAt: identity.updatedAt ?? new Date().toISOString(),
  };
}

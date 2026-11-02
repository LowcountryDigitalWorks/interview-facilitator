import { describe, expect, it } from 'vitest';
import { forkImportedSession, SESSION_SEMANTIC_EXCLUDED_FIELDS, sessionSemanticFingerprint, sessionsSemanticallyEqual } from '../src/session-semantic';
import { bareSession } from './session-stub';

describe('session semantic import comparison', () => {
  it('excludes only revisionId, parentRevisionId, and updatedAt from semantic equality', () => {
    expect(SESSION_SEMANTIC_EXCLUDED_FIELDS).toEqual(['revisionId', 'parentRevisionId', 'updatedAt']);
    const original = bareSession('session-a', 'same notes');
    const transportDrift = structuredClone(original);
    transportDrift.revisionId = crypto.randomUUID();
    transportDrift.parentRevisionId = crypto.randomUUID();
    transportDrift.updatedAt = '2026-11-02T01:23:45.000Z';

    expect(sessionsSemanticallyEqual(original, transportDrift)).toBe(true);
    expect(sessionSemanticFingerprint(original)).toBe(sessionSemanticFingerprint(transportDrift));

    const changedCreatedAt = structuredClone(transportDrift);
    changedCreatedAt.createdAt = '2026-10-31T12:00:01.000Z';
    expect(sessionsSemanticallyEqual(original, changedCreatedAt)).toBe(false);

    const changedSessionId = structuredClone(transportDrift);
    changedSessionId.sessionId = 'session-b';
    expect(sessionsSemanticallyEqual(original, changedSessionId)).toBe(false);

    const changedNotes = structuredClone(transportDrift);
    changedNotes.runningNotes = 'different semantic notes';
    expect(sessionsSemanticallyEqual(original, changedNotes)).toBe(false);
  });

  it('forks imported content with a fresh session/revision lineage and no imported parent ancestry', () => {
    const imported = bareSession('session-a', 'imported content');
    imported.parentRevisionId = 'imported-parent';
    const forked = forkImportedSession(imported, {
      sessionId: 'fork-session',
      revisionId: 'fork-initial-revision',
      updatedAt: '2026-11-02T01:30:00.000Z',
    });

    expect(forked.sessionId).toBe('fork-session');
    expect(forked.revisionId).toBe('fork-initial-revision');
    expect(forked.parentRevisionId).toBeNull();
    expect(forked.updatedAt).toBe('2026-11-02T01:30:00.000Z');
    expect(forked.runningNotes).toBe(imported.runningNotes);
    expect(imported.parentRevisionId).toBe('imported-parent');
  });
});

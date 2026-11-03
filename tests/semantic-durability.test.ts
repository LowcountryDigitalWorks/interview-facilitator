import { describe, expect, it } from 'vitest';
import { SessionAutosaveCoordinator } from '../src/autosave';
import { generalDiscoveryPack } from '../src/pack';
import { createSemanticSession, type SemanticInterviewSession } from '../src/semantic-session';
import { applyValueEdit } from '../src/live-session';
import { importSessionWithCollisionHandling } from '../src/session-durability';

async function semanticSession(): Promise<SemanticInterviewSession> {
  return createSemanticSession(
    generalDiscoveryPack,
    { clientLabel: 'Synthetic semantic durability' },
    new Date('2026-11-03T04:00:00.000Z'),
  );
}

describe('semantic durability plumbing', () => {
  it('autosaves a canonical 1.3 session without erasing semantic answer dimensions', async () => {
    const active = await semanticSession();
    const question = active.packSnapshot.questions.find((item) => item.id === 'primary-goal')!;
    active.answers[question.id] = applyValueEdit(question, active.answers[question.id]!, 'Preserve semantic truth.');
    const originalRevision = active.revisionId;
    let persisted: SemanticInterviewSession | null = null;

    const coordinator = new SessionAutosaveCoordinator<SemanticInterviewSession>(async (snapshot, expectedRevisionId) => {
      expect(expectedRevisionId).toBe(originalRevision);
      persisted = {
        ...structuredClone(snapshot),
        revisionId: 'saved-semantic-revision',
        parentRevisionId: expectedRevisionId,
      };
      return persisted;
    }, 60_000);

    coordinator.schedule(active);
    await coordinator.flushAndWait(active.sessionId);

    expect(persisted).not.toBeNull();
    expect(persisted!.sessionSchemaVersion).toBe('1.3.0');
    expect(persisted!.answers[question.id]).toMatchObject({
      value: 'Preserve semantic truth.',
      resolution: 'captured',
      source: 'client-statement',
      needsConfirmation: false,
    });
    expect(active.revisionId).toBe('saved-semantic-revision');
    expect(active.parentRevisionId).toBe(originalRevision);
  });

  it('uses the generic collision gate for canonical 1.3 sessions without semantic churn', async () => {
    const imported = await semanticSession();
    const existing = structuredClone(imported);
    existing.revisionId = 'local-revision';
    existing.parentRevisionId = imported.revisionId;
    existing.updatedAt = '2026-11-03T04:01:00.000Z';
    let saveCalls = 0;
    let replaceCalls = 0;

    const result = await importSessionWithCollisionHandling<SemanticInterviewSession>({
      imported,
      flush: async () => undefined,
      load: async () => existing,
      chooseCollision: () => 'replace',
      save: async (value) => { saveCalls += 1; return value; },
      replace: async (value) => { replaceCalls += 1; return value; },
    });

    expect(result.kind).toBe('noop');
    expect(saveCalls).toBe(0);
    expect(replaceCalls).toBe(0);
    if (result.kind === 'noop') expect(result.session.revisionId).toBe('local-revision');
  });
});

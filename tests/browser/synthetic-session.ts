import type { InterviewSession } from '../../src/domain';
import { createPinnedSession } from '../../src/pack-identity';
import { generalDiscoveryPack } from '../../src/pack';
import { createSemanticSession, type SemanticInterviewSession } from '../../src/semantic-session';

export async function syntheticSemanticSession(
  overrides: Partial<SemanticInterviewSession> = {},
): Promise<SemanticInterviewSession> {
  const session = await createSemanticSession(generalDiscoveryPack, {
    clientLabel: overrides.clientLabel ?? 'Synthetic Browser Test',
    interviewerLabel: overrides.interviewerLabel ?? 'Test Operator',
    interviewMode: overrides.interviewMode ?? 'Conversation',
  }, new Date('2026-10-31T20:00:00.000Z'));
  const { packSnapshot, packIdentity, sessionSchemaVersion, answers, ...rest } = overrides;
  void packSnapshot;
  void packIdentity;
  void sessionSchemaVersion;
  return {
    ...session,
    ...rest,
    answers: answers ?? session.answers,
    sessionSchemaVersion: '1.3.0',
    packSnapshot: session.packSnapshot,
    packIdentity: session.packIdentity,
  };
}

export async function syntheticPinned12Session(
  overrides: Partial<InterviewSession> = {},
): Promise<InterviewSession> {
  const session = await createPinnedSession(generalDiscoveryPack, {
    clientLabel: overrides.clientLabel ?? 'Synthetic Browser Test',
    interviewerLabel: overrides.interviewerLabel ?? 'Test Operator',
    interviewMode: overrides.interviewMode ?? 'Conversation',
  }, new Date('2026-10-31T20:00:00.000Z'));
  const { packSnapshot, packIdentity, sessionSchemaVersion, ...rest } = overrides;
  void packSnapshot;
  void packIdentity;
  void sessionSchemaVersion;
  return {
    ...session,
    ...rest,
    sessionSchemaVersion: '1.2.0',
    packSnapshot: session.packSnapshot,
    packIdentity: session.packIdentity,
  };
}

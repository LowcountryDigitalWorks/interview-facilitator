import type { InterviewSession } from '../../src/domain';
import { createPinnedSession } from '../../src/pack-identity';
import { generalDiscoveryPack } from '../../src/pack';

export async function syntheticPinnedSession(overrides: Partial<InterviewSession> = {}): Promise<InterviewSession> {
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
    sessionSchemaVersion: '1.1.0',
    packSnapshot: session.packSnapshot,
    packIdentity: session.packIdentity,
  };
}

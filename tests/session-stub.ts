import type { InterviewSession } from '../src/domain';

export function bareSession(sessionId: string, runningNotes = ''): InterviewSession {
  return {
    sessionSchemaVersion: '1.2.0',
    sessionId,
    interviewPackId: 'general-discovery',
    interviewPackVersion: '1.0.0',
    clientLabel: 'Synthetic',
    interviewerLabel: '',
    interviewMode: 'Conversation',
    createdAt: '2026-10-31T12:00:00.000Z',
    updatedAt: '2026-10-31T12:00:00.000Z',
    currentQuestionId: 'existing-presence',
    knownFacts: [],
    answers: {},
    runningNotes,
    packSnapshot: {
      packSchemaVersion: '1.0.0',
      ruleSemanticsVersion: 'condition-equals-v1',
      packId: 'general-discovery',
      packVersion: '1.0.0',
      title: 'General discovery',
      description: 'Synthetic',
      sections: [],
      questions: [],
      knownFacts: [],
    },
    packIdentity: {
      algorithm: 'SHA-256',
      canonicalization: 'ldw-json-c14n-v1',
      digest: 'a'.repeat(64),
    },
  };
}

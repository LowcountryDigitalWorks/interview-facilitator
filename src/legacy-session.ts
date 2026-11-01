import type { AnswerStatus, InterviewPack, KnownFact, QuestionState } from './domain';

const ANSWER_STATUSES = new Set<AnswerStatus>(['ANSWERED', 'ALREADY_KNOWN', 'SKIP', 'N_A', 'MUST_CONFIRM']);
const SESSION_KEYS = ['sessionSchemaVersion', 'sessionId', 'interviewPackId', 'interviewPackVersion', 'clientLabel', 'interviewerLabel', 'interviewMode', 'createdAt', 'updatedAt', 'currentQuestionId', 'knownFacts', 'answers', 'runningNotes'];

export interface LegacySession10 {
  sessionSchemaVersion: '1.0.0';
  sessionId: string;
  interviewPackId: string;
  interviewPackVersion: string;
  clientLabel: string;
  interviewerLabel: string;
  interviewMode: string;
  createdAt: string;
  updatedAt: string;
  currentQuestionId: string;
  knownFacts: KnownFact[];
  answers: Record<string, QuestionState>;
  runningNotes: string;
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string') throw new Error(`Legacy session ${key} must be a string.`);
  return value;
}

function rejectUnknownKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw new Error(`${label} contains an unsupported field.`);
  }
}

function validateKnownFact(value: unknown): KnownFact {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Legacy known fact is invalid.');
  const record = value as Record<string, unknown>;
  rejectUnknownKeys(record, ['id', 'label', 'value', 'provenance', 'questionId'], 'Legacy known fact');
  const fact: KnownFact = {
    id: requireString(record, 'id'),
    label: requireString(record, 'label'),
    value: requireString(record, 'value'),
    provenance: requireString(record, 'provenance'),
  };
  if (record.questionId !== undefined) fact.questionId = requireString(record, 'questionId');
  return fact;
}

function validateAnswer(value: unknown): QuestionState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Legacy answer state is invalid.');
  const record = value as Record<string, unknown>;
  rejectUnknownKeys(record, ['value', 'status', 'note'], 'Legacy answer');
  if (record.value !== null && typeof record.value !== 'string') throw new Error('Legacy answer value must be a string or null.');
  if (record.status !== null && (typeof record.status !== 'string' || !ANSWER_STATUSES.has(record.status as AnswerStatus))) throw new Error('Legacy answer status is invalid.');
  if (typeof record.note !== 'string') throw new Error('Legacy answer note must be a string.');
  return { value: record.value as string | null, status: record.status as AnswerStatus | null, note: record.note };
}

export function parseLegacySession10(value: unknown): LegacySession10 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Legacy session JSON must be an object.');
  const record = value as Record<string, unknown>;
  if (record.sessionSchemaVersion !== '1.0.0') throw new Error('Legacy parser only accepts session schema 1.0.0.');
  rejectUnknownKeys(record, SESSION_KEYS, 'Legacy session');
  if (!record.answers || typeof record.answers !== 'object' || Array.isArray(record.answers)) throw new Error('Legacy session answers are missing or invalid.');
  if (!Array.isArray(record.knownFacts)) throw new Error('Legacy session known facts are invalid.');
  const answers = Object.fromEntries(Object.entries(record.answers as Record<string, unknown>).map(([questionId, state]) => {
    if (!questionId) throw new Error('Legacy answer question ID is invalid.');
    return [questionId, validateAnswer(state)];
  }));
  return {
    sessionSchemaVersion: '1.0.0',
    sessionId: requireString(record, 'sessionId'),
    interviewPackId: requireString(record, 'interviewPackId'),
    interviewPackVersion: requireString(record, 'interviewPackVersion'),
    clientLabel: requireString(record, 'clientLabel'),
    interviewerLabel: requireString(record, 'interviewerLabel'),
    interviewMode: requireString(record, 'interviewMode'),
    createdAt: requireString(record, 'createdAt'),
    updatedAt: requireString(record, 'updatedAt'),
    currentQuestionId: requireString(record, 'currentQuestionId'),
    knownFacts: record.knownFacts.map(validateKnownFact),
    answers,
    runningNotes: requireString(record, 'runningNotes'),
  };
}

export function assertLegacySessionMatchesPack(session: LegacySession10, pack: InterviewPack): void {
  if (session.interviewPackId !== pack.packId || session.interviewPackVersion !== pack.packVersion) {
    throw new Error('Legacy session does not match the archived pack identity.');
  }
  const questionIds = new Set(pack.questions.map((question) => question.id));
  for (const question of pack.questions) {
    if (!session.answers[question.id]) throw new Error(`Legacy session is missing answer state for question ${question.id}.`);
  }
  for (const questionId of Object.keys(session.answers)) {
    if (!questionIds.has(questionId)) throw new Error(`Legacy session contains an unknown question ${questionId}.`);
  }
  if (!questionIds.has(session.currentQuestionId)) throw new Error('Legacy session current question is not part of the archived pack.');
}

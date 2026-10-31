export type AnswerStatus = 'ANSWERED' | 'ALREADY_KNOWN' | 'SKIP' | 'N_A' | 'MUST_CONFIRM';
export type QuestionKind = 'text' | 'textarea' | 'single';

export interface Condition {
  questionId: string;
  equals: string;
}

export interface KnownFact {
  id: string;
  label: string;
  value: string;
  provenance: string;
  questionId?: string;
}

export interface Question {
  id: string;
  sectionId: string;
  prompt: string;
  help?: string;
  kind: QuestionKind;
  options?: string[];
  condition?: Condition;
}

export interface Section {
  id: string;
  title: string;
}

export interface InterviewPack {
  packSchemaVersion: '1.0.0';
  packId: string;
  packVersion: string;
  title: string;
  description: string;
  sections: Section[];
  questions: Question[];
  knownFacts: KnownFact[];
}

export interface QuestionState {
  value: string | null;
  status: AnswerStatus | null;
  note: string;
}

export interface InterviewSession {
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

export interface Coverage {
  resolved: number;
  remaining: number;
  mustConfirm: number;
  visible: number;
}

const ANSWER_STATUSES = new Set<AnswerStatus>(['ANSWERED', 'ALREADY_KNOWN', 'SKIP', 'N_A', 'MUST_CONFIRM']);

export function createSession(pack: InterviewPack, input: {clientLabel: string; interviewerLabel?: string; interviewMode?: string}, now = new Date()): InterviewSession {
  const timestamp = now.toISOString();
  const answers = Object.fromEntries(pack.questions.map((question) => [question.id, { value: null, status: null, note: '' }])) as Record<string, QuestionState>;
  return {
    sessionSchemaVersion: '1.0.0',
    sessionId: crypto.randomUUID(),
    interviewPackId: pack.packId,
    interviewPackVersion: pack.packVersion,
    clientLabel: input.clientLabel.trim() || 'Untitled interview',
    interviewerLabel: input.interviewerLabel?.trim() ?? '',
    interviewMode: input.interviewMode?.trim() || 'Conversation',
    createdAt: timestamp,
    updatedAt: timestamp,
    currentQuestionId: pack.questions[0]?.id ?? '',
    knownFacts: structuredClone(pack.knownFacts),
    answers,
    runningNotes: ''
  };
}

export function isQuestionVisible(question: Question, session: InterviewSession): boolean {
  if (!question.condition) return true;
  return session.answers[question.condition.questionId]?.value === question.condition.equals;
}

export function visibleQuestions(pack: InterviewPack, session: InterviewSession): Question[] {
  return pack.questions.filter((question) => isQuestionVisible(question, session));
}

export function coverage(pack: InterviewPack, session: InterviewSession): Coverage {
  const visible = visibleQuestions(pack, session);
  let resolved = 0;
  let mustConfirm = 0;
  let remaining = 0;
  for (const question of visible) {
    const status = session.answers[question.id]?.status ?? null;
    if (status === 'MUST_CONFIRM') mustConfirm += 1;
    else if (status) resolved += 1;
    else remaining += 1;
  }
  return { resolved, remaining, mustConfirm, visible: visible.length };
}

export function nextVisibleQuestion(pack: InterviewPack, session: InterviewSession, currentId: string, direction: 1 | -1): Question | undefined {
  const visible = visibleQuestions(pack, session);
  const index = visible.findIndex((question) => question.id === currentId);
  if (index < 0) return visible[0];
  return visible[index + direction];
}

export function relevantKnownFacts(question: Question, session: InterviewSession): KnownFact[] {
  return session.knownFacts.filter((fact) => !fact.questionId || fact.questionId === question.id);
}

export function touch(session: InterviewSession, now = new Date()): InterviewSession {
  return { ...session, updatedAt: now.toISOString() };
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string') throw new Error(`Session ${key} must be a string.`);
  return value;
}

function validateKnownFact(value: unknown): KnownFact {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Session known fact is invalid.');
  const record = value as Record<string, unknown>;
  const fact: KnownFact = {
    id: requireString(record, 'id'),
    label: requireString(record, 'label'),
    value: requireString(record, 'value'),
    provenance: requireString(record, 'provenance')
  };
  if (record.questionId !== undefined) fact.questionId = requireString(record, 'questionId');
  return fact;
}

function validateQuestionState(value: unknown): QuestionState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Session answer state is invalid.');
  const record = value as Record<string, unknown>;
  if (record.value !== null && typeof record.value !== 'string') throw new Error('Session answer value must be a string or null.');
  if (record.status !== null && (typeof record.status !== 'string' || !ANSWER_STATUSES.has(record.status as AnswerStatus))) throw new Error('Session answer status is invalid.');
  if (typeof record.note !== 'string') throw new Error('Session answer note must be a string.');
  return { value: record.value as string | null, status: record.status as AnswerStatus | null, note: record.note };
}

export function validateSessionShape(value: unknown): InterviewSession {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Session JSON must be an object.');
  const record = value as Record<string, unknown>;
  if (record.sessionSchemaVersion !== '1.0.0') throw new Error('Unsupported session schema version.');
  if (!record.answers || typeof record.answers !== 'object' || Array.isArray(record.answers)) throw new Error('Session answers are missing or invalid.');
  if (!Array.isArray(record.knownFacts)) throw new Error('Session known facts are invalid.');

  const answers = Object.fromEntries(Object.entries(record.answers as Record<string, unknown>).map(([questionId, state]) => {
    if (!questionId) throw new Error('Session answer question ID is invalid.');
    return [questionId, validateQuestionState(state)];
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
    runningNotes: requireString(record, 'runningNotes')
  };
}

export function validateSessionForPack(session: InterviewSession, pack: InterviewPack): void {
  if (session.interviewPackId !== pack.packId || session.interviewPackVersion !== pack.packVersion) throw new Error('This session uses a different interview pack or version.');
  const questionIds = new Set(pack.questions.map((question) => question.id));
  for (const question of pack.questions) {
    if (!session.answers[question.id]) throw new Error(`Session is missing answer state for question ${question.id}.`);
  }
  for (const questionId of Object.keys(session.answers)) {
    if (!questionIds.has(questionId)) throw new Error(`Session contains an unknown question ${questionId}.`);
  }
  if (!questionIds.has(session.currentQuestionId)) throw new Error('Session current question is not part of this pack.');
}

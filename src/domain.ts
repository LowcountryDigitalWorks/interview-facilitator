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

export function validateSessionShape(value: unknown): InterviewSession {
  if (!value || typeof value !== 'object') throw new Error('Session JSON must be an object.');
  const candidate = value as Partial<InterviewSession>;
  if (candidate.sessionSchemaVersion !== '1.0.0') throw new Error('Unsupported session schema version.');
  if (!candidate.sessionId || !candidate.interviewPackId || !candidate.interviewPackVersion) throw new Error('Session identity is incomplete.');
  if (!candidate.answers || typeof candidate.answers !== 'object') throw new Error('Session answers are missing.');
  if (!Array.isArray(candidate.knownFacts)) throw new Error('Session known facts are invalid.');
  return candidate as InterviewSession;
}

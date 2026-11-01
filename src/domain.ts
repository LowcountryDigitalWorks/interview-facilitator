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

export interface InterviewPackSnapshot {
  packSchemaVersion: '1.0.0';
  packId: string;
  packVersion: string;
  title: string;
  description: string;
  sections: Section[];
  questions: Question[];
  knownFacts: KnownFact[];
}

export interface InterviewPack extends InterviewPackSnapshot {}

export interface PackIdentity {
  algorithm: 'SHA-256';
  canonicalization: 'ldw-json-c14n-v1';
  digest: string;
}

export interface QuestionState {
  value: string | null;
  status: AnswerStatus | null;
  note: string;
}

export interface InterviewSession {
  sessionSchemaVersion: '1.1.0';
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
  packSnapshot: InterviewPackSnapshot;
  packIdentity: PackIdentity;
}

export interface Coverage {
  resolved: number;
  remaining: number;
  mustConfirm: number;
  visible: number;
}

const ANSWER_STATUSES = new Set<AnswerStatus>(['ANSWERED', 'ALREADY_KNOWN', 'SKIP', 'N_A', 'MUST_CONFIRM']);

export function sessionPack(session: InterviewSession): InterviewPackSnapshot {
  return session.packSnapshot;
}

export function assemblePinnedSession(
  snapshot: InterviewPackSnapshot,
  identity: PackIdentity,
  input: {clientLabel: string; interviewerLabel?: string; interviewMode?: string},
  now = new Date(),
): InterviewSession {
  const timestamp = now.toISOString();
  const answers = Object.fromEntries(snapshot.questions.map((question) => [question.id, { value: null, status: null, note: '' }])) as Record<string, QuestionState>;
  return {
    sessionSchemaVersion: '1.1.0',
    sessionId: crypto.randomUUID(),
    interviewPackId: snapshot.packId,
    interviewPackVersion: snapshot.packVersion,
    clientLabel: input.clientLabel.trim() || 'Untitled interview',
    interviewerLabel: input.interviewerLabel?.trim() ?? '',
    interviewMode: input.interviewMode?.trim() || 'Conversation',
    createdAt: timestamp,
    updatedAt: timestamp,
    currentQuestionId: snapshot.questions[0]?.id ?? '',
    knownFacts: structuredClone(snapshot.knownFacts),
    answers,
    runningNotes: '',
    packSnapshot: snapshot,
    packIdentity: identity,
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

const QUESTION_KINDS = new Set<QuestionKind>(['text', 'textarea', 'single']);

function requireOnlyKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw new Error(`${label} contains an unsupported field.`);
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} is invalid.`);
  return value as Record<string, unknown>;
}

function validateCondition(value: unknown): Condition {
  const record = requireRecord(value, 'Pack snapshot condition');
  requireOnlyKeys(record, ['questionId', 'equals'], 'Pack snapshot condition');
  return { questionId: requireString(record, 'questionId'), equals: requireString(record, 'equals') };
}

function validateSnapshotQuestion(value: unknown): Question {
  const record = requireRecord(value, 'Pack snapshot question');
  requireOnlyKeys(record, ['id', 'sectionId', 'prompt', 'help', 'kind', 'options', 'condition'], 'Pack snapshot question');
  if (typeof record.kind !== 'string' || !QUESTION_KINDS.has(record.kind as QuestionKind)) throw new Error('Pack snapshot question kind is invalid.');
  const question: Question = {
    id: requireString(record, 'id'),
    sectionId: requireString(record, 'sectionId'),
    prompt: requireString(record, 'prompt'),
    kind: record.kind as QuestionKind,
  };
  if (record.help !== undefined) question.help = requireString(record, 'help');
  if (record.options !== undefined) {
    if (!Array.isArray(record.options) || record.options.some((option) => typeof option !== 'string')) throw new Error('Pack snapshot options are invalid.');
    question.options = [...record.options];
  }
  if (question.kind === 'single' && (!question.options || question.options.length === 0)) throw new Error('A single-choice question requires a non-empty options array.');
  if (record.condition !== undefined) question.condition = validateCondition(record.condition);
  return question;
}

function validateSnapshotSection(value: unknown): Section {
  const record = requireRecord(value, 'Pack snapshot section');
  requireOnlyKeys(record, ['id', 'title'], 'Pack snapshot section');
  return { id: requireString(record, 'id'), title: requireString(record, 'title') };
}

function validateSnapshotFact(value: unknown): KnownFact {
  const record = requireRecord(value, 'Pack snapshot known fact');
  requireOnlyKeys(record, ['id', 'label', 'value', 'provenance', 'questionId'], 'Pack snapshot known fact');
  return validateKnownFact(record);
}

export function validatePackSnapshot(value: unknown): InterviewPackSnapshot {
  const record = requireRecord(value, 'Pack snapshot');
  requireOnlyKeys(record, ['packSchemaVersion', 'packId', 'packVersion', 'title', 'description', 'sections', 'questions', 'knownFacts'], 'Pack snapshot');
  if (record.packSchemaVersion !== '1.0.0') throw new Error('Unsupported pack snapshot schema version.');
  if (!Array.isArray(record.sections) || !Array.isArray(record.questions) || !Array.isArray(record.knownFacts)) throw new Error('Pack snapshot collections are invalid.');
  return {
    packSchemaVersion: '1.0.0',
    packId: requireString(record, 'packId'),
    packVersion: requireString(record, 'packVersion'),
    title: requireString(record, 'title'),
    description: requireString(record, 'description'),
    sections: record.sections.map(validateSnapshotSection),
    questions: record.questions.map(validateSnapshotQuestion),
    knownFacts: record.knownFacts.map(validateSnapshotFact),
  };
}

export function validatePackIdentity(value: unknown): PackIdentity {
  const record = requireRecord(value, 'Pack identity');
  requireOnlyKeys(record, ['algorithm', 'canonicalization', 'digest'], 'Pack identity');
  if (record.algorithm !== 'SHA-256' || record.canonicalization !== 'ldw-json-c14n-v1') throw new Error('Unsupported pack identity.');
  if (typeof record.digest !== 'string' || !/^[0-9a-f]{64}$/.test(record.digest)) throw new Error('Pack identity digest is invalid.');
  return { algorithm: 'SHA-256', canonicalization: 'ldw-json-c14n-v1', digest: record.digest };
}

export function validateSessionShape(value: unknown): InterviewSession {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Session JSON must be an object.');
  const record = value as Record<string, unknown>;
  if (record.sessionSchemaVersion === '1.0.0') throw new Error('Unsupported legacy session schema 1.0.0. This record has no pinned pack snapshot and was not migrated or deleted.');
  if (record.sessionSchemaVersion !== '1.1.0') throw new Error('Unsupported session schema version.');
  if (!record.answers || typeof record.answers !== 'object' || Array.isArray(record.answers)) throw new Error('Session answers are missing or invalid.');
  if (!Array.isArray(record.knownFacts)) throw new Error('Session known facts are invalid.');

  const answers = Object.fromEntries(Object.entries(record.answers as Record<string, unknown>).map(([questionId, state]) => {
    if (!questionId) throw new Error('Session answer question ID is invalid.');
    return [questionId, validateQuestionState(state)];
  }));

  return {
    sessionSchemaVersion: '1.1.0',
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
    packSnapshot: validatePackSnapshot(record.packSnapshot),
    packIdentity: validatePackIdentity(record.packIdentity),
  };
}

export function validateSessionForPack(session: InterviewSession): void {
  const pack = session.packSnapshot;
  const sectionIds = new Set<string>();
  for (const section of pack.sections) {
    if (sectionIds.has(section.id)) throw new Error('Pack snapshot contains a duplicate section.');
    sectionIds.add(section.id);
  }
  const seenQuestionIds = new Set<string>();
  for (const question of pack.questions) {
    if (seenQuestionIds.has(question.id)) throw new Error('Pack snapshot contains a duplicate question.');
    seenQuestionIds.add(question.id);
    if (!sectionIds.has(question.sectionId)) throw new Error('Pack snapshot question refers to an unknown section.');
    if (question.kind === 'single' && (!question.options || question.options.length === 0)) throw new Error('A single-choice question requires a non-empty options array.');
  }
  for (const question of pack.questions) {
    if (question.condition?.questionId === question.id) throw new Error('Pack snapshot condition cannot refer to its own question.');
    if (question.condition && !seenQuestionIds.has(question.condition.questionId)) throw new Error('Pack snapshot condition refers to an unknown question.');
  }
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

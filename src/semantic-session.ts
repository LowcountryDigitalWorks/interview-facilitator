import {
  validatePackSnapshot,
  type InterviewSession,
  type InterviewPackSnapshot,
  type PackIdentity,
  type Question,
} from './domain';
import { canonicalizeJson, sha256Hex, validateSessionRecord } from './pack-identity';
import {
  isMeaningfulCaptureValue,
  projectLegacyQuestionState,
  type EvidenceSource,
  type FollowUpMetadata,
  type Resolution,
} from './coverage-semantics';
import { EFFECTIVE_EVIDENCE_EQUALS_V2 } from './coverage-rules';

export const SEMANTIC_SESSION_SCHEMA_VERSION = '1.3.0' as const;
export const PINNED_12_TO_13_MIGRATION_ID = 'pinned-1.2-to-1.3' as const;

export interface SemanticConfirmationReference {
  revisionId: string;
  confirmedAt: string;
  value: string;
}

export interface SemanticAnswerState {
  value: string | null;
  resolution: Resolution;
  source: EvidenceSource | null;
  needsConfirmation: boolean;
  confirmation: SemanticConfirmationReference | null;
  followUp: FollowUpMetadata | null;
  note: string;
}

export interface SemanticPackSnapshot extends Omit<InterviewPackSnapshot, 'ruleSemanticsVersion'> {
  ruleSemanticsVersion: typeof EFFECTIVE_EVIDENCE_EQUALS_V2;
}

export interface SemanticInterviewSession extends Omit<InterviewSession, 'sessionSchemaVersion' | 'answers' | 'packSnapshot'> {
  sessionSchemaVersion: typeof SEMANTIC_SESSION_SCHEMA_VERSION;
  answers: Record<string, SemanticAnswerState>;
  packSnapshot: SemanticPackSnapshot;
}

const SESSION_KEYS = [
  'sessionSchemaVersion', 'sessionId', 'revisionId', 'parentRevisionId', 'interviewPackId',
  'interviewPackVersion', 'clientLabel', 'interviewerLabel', 'interviewMode', 'createdAt',
  'updatedAt', 'currentQuestionId', 'knownFacts', 'answers', 'runningNotes', 'packSnapshot',
  'packIdentity',
] as const;
const ANSWER_KEYS = ['value', 'resolution', 'source', 'needsConfirmation', 'confirmation', 'followUp', 'note'] as const;
const CONFIRMATION_KEYS = ['revisionId', 'confirmedAt', 'value'] as const;
const FOLLOW_UP_KEYS = ['action', 'owner', 'dueDate'] as const;
const RESOLUTIONS = new Set<Resolution>(['unresolved', 'captured', 'deferred', 'not-applicable']);
const SOURCES = new Set<EvidenceSource>(['client-statement', 'accepted-known-fact', 'interviewer-inference']);

function captureSpec(question: Question) {
  return question.options === undefined ? { kind: question.kind } : { kind: question.kind, options: question.options };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} is invalid.`);
  return value as Record<string, unknown>;
}

function requireOnlyKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw new Error(`${label} contains an unsupported field.`);
  }
}

function requireString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== 'string') throw new Error(`${label} ${key} must be a string.`);
  return value;
}

function requireNonEmptyString(record: Record<string, unknown>, key: string, label: string): string {
  const value = requireString(record, key, label);
  if (!value.trim()) throw new Error(`${label} ${key} must not be empty.`);
  return value;
}

function validateSemanticAnswer(value: unknown, question: Question): SemanticAnswerState {
  const record = requireRecord(value, 'Semantic answer');
  requireOnlyKeys(record, ANSWER_KEYS, 'Semantic answer');
  if (record.value !== null && typeof record.value !== 'string') throw new Error('Semantic answer value must be a string or null.');
  if (typeof record.resolution !== 'string' || !RESOLUTIONS.has(record.resolution as Resolution)) throw new Error('Semantic answer resolution is invalid.');
  if (record.source !== null && (typeof record.source !== 'string' || !SOURCES.has(record.source as EvidenceSource))) throw new Error('Semantic answer source is invalid.');
  if (typeof record.needsConfirmation !== 'boolean') throw new Error('Semantic answer confirmation flag is invalid.');
  if (typeof record.note !== 'string') throw new Error('Semantic answer note must be a string.');

  const spec = captureSpec(question);
  if (record.resolution === 'captured' && !isMeaningfulCaptureValue(spec, record.value)) {
    throw new Error('Captured semantic answer must contain a meaningful value for its question.');
  }

  let confirmation: SemanticConfirmationReference | null = null;
  if (record.confirmation !== null) {
    const confirmationRecord = requireRecord(record.confirmation, 'Semantic confirmation');
    requireOnlyKeys(confirmationRecord, CONFIRMATION_KEYS, 'Semantic confirmation');
    const confirmationValue = requireString(confirmationRecord, 'value', 'Semantic confirmation');
    if (!isMeaningfulCaptureValue(spec, confirmationValue)) throw new Error('Semantic confirmation value is not meaningful for its question.');
    confirmation = {
      revisionId: requireNonEmptyString(confirmationRecord, 'revisionId', 'Semantic confirmation'),
      confirmedAt: requireNonEmptyString(confirmationRecord, 'confirmedAt', 'Semantic confirmation'),
      value: confirmationValue,
    };
  }

  let followUp: FollowUpMetadata | null = null;
  if (record.followUp !== null) {
    const followUpRecord = requireRecord(record.followUp, 'Semantic follow-up');
    requireOnlyKeys(followUpRecord, FOLLOW_UP_KEYS, 'Semantic follow-up');
    const action = requireNonEmptyString(followUpRecord, 'action', 'Semantic follow-up');
    followUp = { action };
    if (followUpRecord.owner !== undefined) followUp.owner = requireString(followUpRecord, 'owner', 'Semantic follow-up');
    if (followUpRecord.dueDate !== undefined) followUp.dueDate = requireString(followUpRecord, 'dueDate', 'Semantic follow-up');
  }

  return {
    value: record.value as string | null,
    resolution: record.resolution as Resolution,
    source: record.source as EvidenceSource | null,
    needsConfirmation: record.needsConfirmation,
    confirmation,
    followUp,
    note: record.note,
  };
}

export async function validateSemanticSessionRecord(value: unknown): Promise<SemanticInterviewSession> {
  const record = requireRecord(value, 'Semantic session');
  requireOnlyKeys(record, SESSION_KEYS, 'Semantic session');
  if (record.sessionSchemaVersion !== SEMANTIC_SESSION_SCHEMA_VERSION) throw new Error('Unsupported semantic session schema version.');

  const snapshotRecord = requireRecord(record.packSnapshot, 'Semantic pack snapshot');
  if (snapshotRecord.ruleSemanticsVersion !== EFFECTIVE_EVIDENCE_EQUALS_V2) throw new Error('Unsupported semantic rule semantics version.');
  const legacyCompatibleSnapshot = structuredClone(snapshotRecord);
  legacyCompatibleSnapshot.ruleSemanticsVersion = 'condition-equals-v1';
  const validatedSnapshot = validatePackSnapshot(legacyCompatibleSnapshot);
  const questionById = new Map(validatedSnapshot.questions.map((question) => [question.id, question]));

  const answersRecord = requireRecord(record.answers, 'Semantic session answers');
  const answers: Record<string, SemanticAnswerState> = {};
  for (const [questionId, answer] of Object.entries(answersRecord)) {
    const question = questionById.get(questionId);
    if (!question) throw new Error(`Semantic session contains an unknown question ${questionId}.`);
    answers[questionId] = validateSemanticAnswer(answer, question);
  }

  const v1Digest = await sha256Hex(canonicalizeJson(legacyCompatibleSnapshot));
  const compatibilityRecord = {
    ...structuredClone(record),
    sessionSchemaVersion: '1.2.0',
    answers: Object.fromEntries(Object.entries(answers).map(([questionId, answer]) => [
      questionId,
      { value: answer.value, status: null, note: answer.note },
    ])),
    packSnapshot: legacyCompatibleSnapshot,
    packIdentity: { algorithm: 'SHA-256', canonicalization: 'ldw-json-c14n-v1', digest: v1Digest },
  };
  await validateSessionRecord(compatibilityRecord);

  const packIdentityRecord = requireRecord(record.packIdentity, 'Semantic pack identity');
  requireOnlyKeys(packIdentityRecord, ['algorithm', 'canonicalization', 'digest'], 'Semantic pack identity');
  if (packIdentityRecord.algorithm !== 'SHA-256' || packIdentityRecord.canonicalization !== 'ldw-json-c14n-v1'
    || typeof packIdentityRecord.digest !== 'string' || !/^[0-9a-f]{64}$/.test(packIdentityRecord.digest)) {
    throw new Error('Semantic pack identity is invalid.');
  }
  const v2Digest = await sha256Hex(canonicalizeJson(record.packSnapshot));
  if (packIdentityRecord.digest !== v2Digest) throw new Error('Semantic pack snapshot does not match its identity digest.');

  return {
    ...(structuredClone(record) as unknown as SemanticInterviewSession),
    answers,
    packSnapshot: structuredClone(record.packSnapshot) as SemanticPackSnapshot,
    packIdentity: {
      algorithm: 'SHA-256',
      canonicalization: 'ldw-json-c14n-v1',
      digest: packIdentityRecord.digest,
    },
  };
}

export async function migratePinned12To13(raw: unknown): Promise<SemanticInterviewSession> {
  const source = await validateSessionRecord(raw);
  const questions = new Map(source.packSnapshot.questions.map((question) => [question.id, question]));
  const answers: Record<string, SemanticAnswerState> = Object.fromEntries(Object.entries(source.answers).map(([questionId, state]) => {
    const question = questions.get(questionId);
    if (!question) throw new Error(`Session contains an unknown question ${questionId}.`);
    const projected = projectLegacyQuestionState(state, captureSpec(question));
    return [questionId, {
      value: projected.value as string | null,
      resolution: projected.resolution,
      source: projected.source,
      needsConfirmation: projected.needsConfirmation,
      confirmation: null,
      followUp: null,
      note: state.note,
    }];
  }));
  const packSnapshot: SemanticPackSnapshot = {
    ...structuredClone(source.packSnapshot),
    ruleSemanticsVersion: EFFECTIVE_EVIDENCE_EQUALS_V2,
  };
  const packIdentity: PackIdentity = {
    algorithm: 'SHA-256',
    canonicalization: 'ldw-json-c14n-v1',
    digest: await sha256Hex(canonicalizeJson(packSnapshot)),
  };
  const migrated: SemanticInterviewSession = {
    ...structuredClone(source),
    sessionSchemaVersion: SEMANTIC_SESSION_SCHEMA_VERSION,
    revisionId: `migration:${source.revisionId}:${PINNED_12_TO_13_MIGRATION_ID}`,
    parentRevisionId: source.revisionId,
    answers,
    packSnapshot,
    packIdentity,
  };
  return validateSemanticSessionRecord(migrated);
}

export type SemanticMigrationPlan =
  | { kind: 'ready'; session: SemanticInterviewSession; raw: unknown; fingerprint: string; sourceSchemaVersion: '1.2.0'; migrationId: typeof PINNED_12_TO_13_MIGRATION_ID }
  | { kind: 'current'; session: SemanticInterviewSession }
  | { kind: 'unsupported'; reason: string }
  | { kind: 'invalid'; reason: string };

export async function planSemanticMigration(raw: unknown): Promise<SemanticMigrationPlan> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { kind: 'invalid', reason: 'Session JSON must be an object.' };
  const record = raw as Record<string, unknown>;
  const version = record.sessionSchemaVersion;
  if (version === SEMANTIC_SESSION_SCHEMA_VERSION) {
    const snapshot = record.packSnapshot;
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)
      || (snapshot as Record<string, unknown>).ruleSemanticsVersion !== EFFECTIVE_EVIDENCE_EQUALS_V2) {
      return { kind: 'unsupported', reason: 'Unsupported semantic rule semantics version.' };
    }
    try { return { kind: 'current', session: await validateSemanticSessionRecord(raw) }; }
    catch (error) { return { kind: 'invalid', reason: error instanceof Error ? error.message : 'Semantic session is invalid.' }; }
  }
  if (version !== '1.2.0') return { kind: 'unsupported', reason: `Unsupported semantic migration source ${String(version)}.` };
  try {
    return {
      kind: 'ready',
      session: await migratePinned12To13(raw),
      raw,
      fingerprint: canonicalizeJson(raw),
      sourceSchemaVersion: '1.2.0',
      migrationId: PINNED_12_TO_13_MIGRATION_ID,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Pinned 1.2 session is invalid.';
    return /unsupported/i.test(reason) ? { kind: 'unsupported', reason } : { kind: 'invalid', reason };
  }
}

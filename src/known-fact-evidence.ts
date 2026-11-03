import type { KnownFact } from './domain';
import { isMeaningfulCaptureValue, updateValueWithConfirmationInvalidation, type CaptureSpec } from './coverage-semantics';
import type { SemanticAnswerState } from './semantic-session';

/**
 * #34A1: pure evidence commands. This is NOT the persisted 1.3 session schema.
 * A subsequent, explicitly versioned schema/migration slice must persist this ledger.
 */
export interface KnownFactEvidence extends KnownFact {
  sourceReference?: string;
  observedAt?: string;
  recordedAt?: string;
  supersedesFactId?: string;
}

export interface KnownFactAcceptance {
  id: string;
  factId: string;
  revisionId: string;
  acceptedAt: string;
  valueSnapshot: string;
}

export interface KnownFactLedger {
  facts: KnownFactEvidence[];
  acceptances: KnownFactAcceptance[];
}

const FACT_KEYS = ['id', 'label', 'value', 'provenance', 'questionId', 'sourceReference', 'observedAt', 'recordedAt', 'supersedesFactId'] as const;
const ACCEPTANCE_KEYS = ['id', 'factId', 'revisionId', 'acceptedAt', 'valueSnapshot'] as const;
const LEDGER_KEYS = ['facts', 'acceptances'] as const;

function recordOf(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a record.`);
  }
  return value as Record<string, unknown>;
}

function closedKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) {
    throw new Error(`${label} has an unsupported field.`);
  }
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a nonempty string.`);
  return value;
}

function optionalText(value: unknown, name: string): string | undefined {
  return value === undefined ? undefined : text(value, name);
}

function timestamp(value: unknown, name: string): string {
  const raw = text(value, name);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(raw) ||
      !Number.isFinite(Date.parse(raw)) || new Date(raw).toISOString() !== raw) {
    throw new Error(`${name} must be a valid canonical UTC timestamp.`);
  }
  return raw;
}

function optionalTimestamp(value: unknown, name: string): string | undefined {
  return value === undefined ? undefined : timestamp(value, name);
}

function factOf(value: unknown): KnownFactEvidence {
  const item = recordOf(value, 'Known fact');
  closedKeys(item, FACT_KEYS, 'Known fact');
  return {
    id: text(item.id, 'Known fact ID'),
    label: text(item.label, 'Known fact label'),
    value: text(item.value, 'Known fact value'),
    provenance: text(item.provenance, 'Known fact provenance'),
    ...(optionalText(item.questionId, 'Known fact question ID') === undefined ? {} : { questionId: item.questionId as string }),
    ...(optionalText(item.sourceReference, 'Known fact source reference') === undefined ? {} : { sourceReference: item.sourceReference as string }),
    ...(optionalTimestamp(item.observedAt, 'Known fact observedAt') === undefined ? {} : { observedAt: item.observedAt as string }),
    ...(optionalTimestamp(item.recordedAt, 'Known fact recordedAt') === undefined ? {} : { recordedAt: item.recordedAt as string }),
    ...(optionalText(item.supersedesFactId, 'Superseded fact ID') === undefined ? {} : { supersedesFactId: item.supersedesFactId as string }),
  };
}

function acceptanceOf(value: unknown): KnownFactAcceptance {
  const item = recordOf(value, 'Known fact acceptance');
  closedKeys(item, ACCEPTANCE_KEYS, 'Known fact acceptance');
  return {
    id: text(item.id, 'Acceptance ID'),
    factId: text(item.factId, 'Accepted fact ID'),
    revisionId: text(item.revisionId, 'Accepted revision ID'),
    acceptedAt: timestamp(item.acceptedAt, 'Acceptance time'),
    valueSnapshot: text(item.valueSnapshot, 'Accepted value snapshot'),
  };
}

/** Validates closed fields, historical lineage, unique identities and immutable snapshots. */
export function validateKnownFactLedger(input: unknown): KnownFactLedger {
  const value = recordOf(input, 'Known fact ledger');
  closedKeys(value, LEDGER_KEYS, 'Known fact ledger');
  if (!Array.isArray(value.facts) || !Array.isArray(value.acceptances)) {
    throw new Error('Known fact ledger must contain facts and acceptances arrays.');
  }

  const facts: KnownFactEvidence[] = [];
  const byId = new Map<string, KnownFactEvidence>();
  const superseded = new Set<string>();
  for (const raw of value.facts) {
    const fact = factOf(raw);
    if (byId.has(fact.id)) throw new Error('Duplicate known fact ID.');
    if (fact.supersedesFactId) {
      const previous = byId.get(fact.supersedesFactId);
      if (!previous || superseded.has(previous.id)) throw new Error('Invalid known fact correction lineage.');
      if (fact.questionId !== previous.questionId) throw new Error('Correction cannot silently change question attribution.');
      superseded.add(previous.id);
    }
    facts.push(fact);
    byId.set(fact.id, fact);
  }

  const acceptances: KnownFactAcceptance[] = [];
  const eventIds = new Set<string>();
  const acceptedRevisions = new Set<string>();
  for (const raw of value.acceptances) {
    const acceptance = acceptanceOf(raw);
    if (eventIds.has(acceptance.id) || byId.has(acceptance.id)) throw new Error('Duplicate evidence/event ID.');
    const fact = byId.get(acceptance.factId);
    if (!fact || fact.value !== acceptance.valueSnapshot) throw new Error('Acceptance must reference an exact known fact value snapshot.');
    const revisionKey = JSON.stringify([acceptance.factId, acceptance.revisionId]);
    if (acceptedRevisions.has(revisionKey)) throw new Error('Fact already accepted in this revision.');
    acceptedRevisions.add(revisionKey);
    eventIds.add(acceptance.id);
    acceptances.push(acceptance);
  }

  return { facts, acceptances };
}

/** Adapts existing pack facts without inventing an acceptance event or mutating the pack. */
export function createKnownFactLedger(source: readonly KnownFact[]): KnownFactLedger {
  return validateKnownFactLedger({ facts: source.map((fact) => ({ ...fact })), acceptances: [] });
}

function currentFact(ledger: KnownFactLedger, factId: string): KnownFactEvidence {
  const fact = ledger.facts.find((item) => item.id === factId);
  if (!fact) throw new Error('Unknown known fact.');
  if (ledger.facts.some((item) => item.supersedesFactId === factId)) {
    throw new Error('Superseded known fact cannot be used as current evidence.');
  }
  return fact;
}

function assertCurrentRevision(expectedRevisionId: string, currentRevisionId: string): void {
  text(expectedRevisionId, 'Expected revision ID');
  text(currentRevisionId, 'Current revision ID');
  if (expectedRevisionId !== currentRevisionId) throw new Error('Stale session revision; known fact command rejected.');
}

export function acceptKnownFact(
  source: KnownFactLedger,
  command: { id: string; factId: string; expectedRevisionId: string; currentRevisionId: string; acceptedAt: string },
): KnownFactLedger {
  const ledger = validateKnownFactLedger(source);
  assertCurrentRevision(command.expectedRevisionId, command.currentRevisionId);
  const fact = currentFact(ledger, text(command.factId, 'Known fact ID'));
  const id = text(command.id, 'Acceptance ID');
  if (ledger.facts.some((item) => item.id === id) || ledger.acceptances.some((event) => event.id === id)) {
    throw new Error('Evidence ID already exists.');
  }
  if (ledger.acceptances.some((event) => event.factId === fact.id && event.revisionId === command.currentRevisionId)) {
    throw new Error('Known fact was already accepted in this revision.');
  }
  const event: KnownFactAcceptance = {
    id, factId: fact.id, revisionId: command.currentRevisionId,
    acceptedAt: timestamp(command.acceptedAt, 'Acceptance time'), valueSnapshot: fact.value,
  };
  return { ...ledger, acceptances: [...ledger.acceptances, event] };
}

/**
 * Corrections append a successor record. Original provenance, snapshots and
 * acceptance events remain present; callers must pass fresh provenance.
 */
export function correctKnownFact(
  source: KnownFactLedger,
  command: {
    id: string; supersedesFactId: string; value: string; provenance: string;
    sourceReference?: string; observedAt?: string; recordedAt?: string;
    expectedRevisionId: string; currentRevisionId: string;
  },
): KnownFactLedger {
  const ledger = validateKnownFactLedger(source);
  assertCurrentRevision(command.expectedRevisionId, command.currentRevisionId);
  const original = currentFact(ledger, text(command.supersedesFactId, 'Superseded fact ID'));
  const id = text(command.id, 'Successor fact ID');
  if (ledger.facts.some((item) => item.id === id) || ledger.acceptances.some((event) => event.id === id)) {
    throw new Error('Evidence ID already exists.');
  }
  const successor = factOf({
    id, label: original.label, questionId: original.questionId, supersedesFactId: original.id,
    value: command.value, provenance: command.provenance,
    sourceReference: command.sourceReference, observedAt: command.observedAt, recordedAt: command.recordedAt,
  });
  return { ...ledger, facts: [...ledger.facts, successor] };
}

/**
 * No canonical 1.3 mutation: return a projected answer and an explicit
 * acceptance reference for a future versioned persistence adapter.
 * The human's acceptance of a fact is NOT client confirmation.
 */
export function projectAcceptedKnownFact(
  source: KnownFactLedger,
  acceptanceId: string,
  targetQuestionId: string,
  spec: CaptureSpec,
  existingAnswer: SemanticAnswerState,
): { answer: SemanticAnswerState; factId: string; acceptanceId: string } {
  const ledger = validateKnownFactLedger(source);
  const acceptance = ledger.acceptances.find((event) => event.id === acceptanceId);
  if (!acceptance) throw new Error('Unknown known fact acceptance.');
  const fact = currentFact(ledger, acceptance.factId);
  const target = text(targetQuestionId, 'Target question ID');
  if (fact.questionId !== undefined && fact.questionId !== target) {
    throw new Error('Known fact is attributed to another question.');
  }
  if (acceptance.valueSnapshot !== fact.value || !isMeaningfulCaptureValue(spec, fact.value)) {
    throw new Error('Accepted known fact does not contain a meaningful value for this question.');
  }
  const changed = updateValueWithConfirmationInvalidation(existingAnswer, fact.value);
  return {
    answer: {
      ...existingAnswer,
      ...changed,
      value: fact.value,
      resolution: 'captured',
      source: 'accepted-known-fact',
      needsConfirmation: true,
      confirmation: null,
    },
    factId: fact.id,
    acceptanceId: acceptance.id,
  };
}

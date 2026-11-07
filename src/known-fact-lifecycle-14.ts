import { relevanceMap } from './live-session';
import {
  validateKnownFactSession14Record,
  type KnownFactSession14,
} from './known-fact-session';
import { canonicalizeJson } from './pack-identity';

/** #34B: versioned, pure lifecycle envelope. It does not write storage or change the 1.4 session schema. */
export const KNOWN_FACT_LIFECYCLE_FORMAT = 'ldw-interview-lifecycle/1' as const;
export const KNOWN_FACT_LIFECYCLE_VERSION = 1 as const;

export interface CompletedKnownFactRevision14 {
  completionEventId: string;
  revisionId: string;
  completedAt: string;
  acknowledgedFollowUpQuestionIds: string[];
  sessionSnapshot: KnownFactSession14;
}

export type KnownFactLifecycleEvent14 =
  | { type: 'completed'; eventId: string; revisionId: string; occurredAt: string; acknowledgedFollowUpQuestionIds: string[] }
  | { type: 'reopened'; eventId: string; fromRevisionId: string; newRevisionId: string; occurredAt: string }
  | { type: 'read-back-recorded'; eventId: string; revisionId: string; occurredAt: string };

export interface KnownFactLifecycle14 {
  format: typeof KNOWN_FACT_LIFECYCLE_FORMAT;
  formatVersion: typeof KNOWN_FACT_LIFECYCLE_VERSION;
  status: 'draft' | 'completed';
  session: KnownFactSession14;
  completedRevisions: CompletedKnownFactRevision14[];
  events: KnownFactLifecycleEvent14[];
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(value).some(key => !keys.includes(key))) throw new Error(`${label} contains unsupported fields.`);
}

function nonempty(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a nonempty string.`);
  return value;
}

function timestamp(value: unknown, label: string): string {
  const text = nonempty(value, label);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(text)
    || !Number.isFinite(Date.parse(text)) || new Date(text).toISOString() !== text) {
    throw new Error(`${label} must be a canonical UTC timestamp.`);
  }
  return text;
}

function stringIds(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  const ids = value.map((item, index) => nonempty(item, `${label}[${index}]`));
  if (new Set(ids).size !== ids.length) throw new Error(`${label} contains duplicate IDs.`);
  return ids;
}

function same(left: unknown, right: unknown): boolean {
  return canonicalizeJson(left) === canonicalizeJson(right);
}

/**
 * A completion/reopen chain may update answers and append evidence, but it
 * cannot silently substitute a different pinned interview or rewrite earlier
 * known-fact evidence. Mirror the immutable-source and append-only contract
 * used by the separately reviewed 1.4 storage adapter.
 */
function assertLifecycleSourceContinuity(previous: KnownFactSession14, next: KnownFactSession14): void {
  if (previous.sessionId !== next.sessionId
    || previous.createdAt !== next.createdAt
    || previous.interviewPackId !== next.interviewPackId
    || previous.interviewPackVersion !== next.interviewPackVersion
    || !same(previous.packSnapshot, next.packSnapshot)
    || !same(previous.packIdentity, next.packIdentity)
    || !same(previous.knownFacts, next.knownFacts)) {
    throw new Error('Lifecycle history changed immutable pinned interview identity.');
  }
  const earlierFacts = previous.knownFactLedger.facts;
  const laterFacts = next.knownFactLedger.facts;
  const earlierAcceptances = previous.knownFactLedger.acceptances;
  const laterAcceptances = next.knownFactLedger.acceptances;
  if (laterFacts.length < earlierFacts.length
    || laterAcceptances.length < earlierAcceptances.length
    || !same(laterFacts.slice(0, earlierFacts.length), earlierFacts)
    || !same(laterAcceptances.slice(0, earlierAcceptances.length), earlierAcceptances)) {
    throw new Error('Lifecycle history must retain append-only known-fact provenance.');
  }
}

/** Strict validator for the independent lifecycle envelope; future formats fail closed. */
export async function validateKnownFactLifecycle14(raw: unknown): Promise<KnownFactLifecycle14> {
  const input = record(raw, 'Lifecycle envelope');
  onlyKeys(input, ['format', 'formatVersion', 'status', 'session', 'completedRevisions', 'events'], 'Lifecycle envelope');
  if (input.format !== KNOWN_FACT_LIFECYCLE_FORMAT || input.formatVersion !== KNOWN_FACT_LIFECYCLE_VERSION) {
    throw new Error('Unsupported lifecycle format version.');
  }
  if (input.status !== 'draft' && input.status !== 'completed') throw new Error('Lifecycle status is invalid.');
  if (!Array.isArray(input.completedRevisions) || !Array.isArray(input.events)) throw new Error('Lifecycle history must be arrays.');
  // Fail closed before iterating large attacker-controlled history trees.
  if (input.completedRevisions.length > 500 || input.events.length > 2000) {
    throw new Error('Lifecycle history exceeds the bounded event/revision limit.');
  }

  const session = await validateKnownFactSession14Record(input.session);
  const completedRevisions: CompletedKnownFactRevision14[] = [];
  const completedByRevision = new Map<string, CompletedKnownFactRevision14>();
  for (const [index, rawEntry] of input.completedRevisions.entries()) {
    const entry = record(rawEntry, `Completed revision ${index}`);
    onlyKeys(entry, ['completionEventId', 'revisionId', 'completedAt', 'acknowledgedFollowUpQuestionIds', 'sessionSnapshot'], `Completed revision ${index}`);
    const snapshot = await validateKnownFactSession14Record(entry.sessionSnapshot);
    const revisionId = nonempty(entry.revisionId, 'Completed revision ID');
    if (snapshot.revisionId !== revisionId || snapshot.sessionId !== session.sessionId) throw new Error('Completed snapshot identity does not match its revision record.');
    const acknowledged = stringIds(entry.acknowledgedFollowUpQuestionIds, 'Acknowledged follow-up IDs');
    const questionById = new Map(snapshot.packSnapshot.questions.map(q => [q.id, q]));
    const relevance = relevanceMap(snapshot);
    if (acknowledged.some(id => !questionById.has(id)
      || relevance[id] !== 'relevant' || !snapshot.answers[id]?.followUp)) {
      throw new Error('Acknowledged follow-up must identify an explicit currently relevant follow-up.');
    }
    const checked: CompletedKnownFactRevision14 = {
      completionEventId: nonempty(entry.completionEventId, 'Completion event ID'),
      revisionId,
      completedAt: timestamp(entry.completedAt, 'Completion time'),
      acknowledgedFollowUpQuestionIds: acknowledged,
      sessionSnapshot: snapshot,
    };
    if (checked.completedAt < snapshot.updatedAt) {
      throw new Error('Completion cannot predate the captured source revision.');
    }
    if (completedByRevision.has(revisionId)) throw new Error('A completed revision cannot be recorded twice.');
    completedByRevision.set(revisionId, checked);
    completedRevisions.push(checked);
  }

  // Immutable completed snapshots are chronological; the active Draft must
  // also preserve every earlier pinned source and append-only evidence root.
  for (let i = 1; i < completedRevisions.length; i += 1) {
    assertLifecycleSourceContinuity(
      completedRevisions[i - 1]!.sessionSnapshot, completedRevisions[i]!.sessionSnapshot,
    );
  }
  if (completedRevisions.length > 0) {
    assertLifecycleSourceContinuity(completedRevisions.at(-1)!.sessionSnapshot, session);
  }

  const events: KnownFactLifecycleEvent14[] = [];
  const eventIds = new Set<string>();
  const completionEventByRevision = new Map<string, string>();
  let previousTime = '';
  let replayStatus: 'draft' | 'completed' = 'draft';
  let replayRevisionId: string | null = null;
  let pendingReopen: { fromRevisionId: string; reopenedAt: string } | null = null;
  for (const [index, rawEvent] of input.events.entries()) {
    const event = record(rawEvent, `Lifecycle event ${index}`);
    const type = event.type;
    const eventId = nonempty(event.eventId, 'Lifecycle event ID');
    const occurredAt = timestamp(event.occurredAt, 'Lifecycle event time');
    if (eventIds.has(eventId) || (previousTime && occurredAt < previousTime)) throw new Error('Lifecycle event IDs must be unique and event time must be ordered.');
    eventIds.add(eventId);
    previousTime = occurredAt;
    if (type === 'completed') {
      onlyKeys(event, ['type', 'eventId', 'revisionId', 'occurredAt', 'acknowledgedFollowUpQuestionIds'], 'Completion event');
      const revisionId = nonempty(event.revisionId, 'Completed revision ID');
      const entry = completedByRevision.get(revisionId);
      const acknowledged = stringIds(event.acknowledgedFollowUpQuestionIds, 'Acknowledged follow-up IDs');
      if (!entry || entry.completionEventId !== eventId || entry.completedAt !== occurredAt
        || !same(entry.acknowledgedFollowUpQuestionIds, acknowledged)) throw new Error('Completion event does not match its immutable completed snapshot.');
      if (replayStatus === 'completed' || (replayRevisionId !== null && replayRevisionId !== revisionId)) throw new Error('Completion event is out of lifecycle order or references a stale revision.');
      if (pendingReopen !== null) {
        if (entry.sessionSnapshot.parentRevisionId !== pendingReopen.fromRevisionId
          || entry.sessionSnapshot.updatedAt < pendingReopen.reopenedAt) {
          throw new Error('Completed reopened revision must link to its preserved parent and reopen time.');
        }
        pendingReopen = null;
      }
      replayRevisionId = revisionId;
      replayStatus = 'completed';
      if (completionEventByRevision.has(revisionId)) throw new Error('A revision cannot be completed twice.');
      completionEventByRevision.set(revisionId, eventId);
      events.push({ type, eventId, revisionId, occurredAt, acknowledgedFollowUpQuestionIds: acknowledged });
    } else if (type === 'reopened') {
      onlyKeys(event, ['type', 'eventId', 'fromRevisionId', 'newRevisionId', 'occurredAt'], 'Reopen event');
      const fromRevisionId = nonempty(event.fromRevisionId, 'Reopened revision ID');
      const newRevisionId = nonempty(event.newRevisionId, 'New draft revision ID');
      if (replayStatus !== 'completed' || replayRevisionId !== fromRevisionId
        || !completedByRevision.has(fromRevisionId)) throw new Error('Reopen event must reference the active preserved completed revision.');
      if (newRevisionId === fromRevisionId) throw new Error('Reopen must create a new revision.');
      // Only completed revisions seen SO FAR in event replay count as reused.
      // A valid reopened draft can appear as a completed snapshot later.
      if (replayRevisionId === newRevisionId || completionEventByRevision.has(newRevisionId)) throw new Error('Reopen revision ID already exists.');
      replayRevisionId = newRevisionId;
      replayStatus = 'draft';
      pendingReopen = { fromRevisionId, reopenedAt: occurredAt };
      events.push({ type, eventId, fromRevisionId, newRevisionId, occurredAt });
    } else if (type === 'read-back-recorded') {
      onlyKeys(event, ['type', 'eventId', 'revisionId', 'occurredAt'], 'Read-back event');
      const revisionId = nonempty(event.revisionId, 'Read-back revision ID');
      if (revisionId !== session.revisionId && !completedByRevision.has(revisionId)) throw new Error('Read-back event must reference a current or preserved completed revision.');
      if (replayRevisionId === null) replayRevisionId = revisionId;
      if (revisionId !== replayRevisionId) throw new Error('Read-back event must reference the active lifecycle revision.');
      events.push({ type, eventId, revisionId, occurredAt });
    } else throw new Error('Unsupported lifecycle event.');
  }

  for (const item of completedRevisions) {
    if (completionEventByRevision.get(item.revisionId) !== item.completionEventId) throw new Error('Completed revision is missing its matching completion event.');
  }
  if (replayRevisionId !== null && replayRevisionId !== session.revisionId) throw new Error('Lifecycle history does not end at the current revision.');
  if (replayStatus !== input.status) throw new Error('Lifecycle status does not match its event history.');
  if (pendingReopen !== null && (session.parentRevisionId !== pendingReopen.fromRevisionId
    || session.updatedAt < pendingReopen.reopenedAt)) {
    throw new Error('Reopened Draft must retain its completed parent and reopen time.');
  }
  if (input.status === 'completed') {
    const completed = completedByRevision.get(session.revisionId);
    if (!completed || !same(completed.sessionSnapshot, session)) throw new Error('Completed lifecycle must retain the exact immutable current revision snapshot.');
  }

  return {
    format: KNOWN_FACT_LIFECYCLE_FORMAT,
    formatVersion: KNOWN_FACT_LIFECYCLE_VERSION,
    status: input.status,
    session,
    completedRevisions,
    events,
  };
}

export async function createKnownFactLifecycle14(sessionRaw: unknown): Promise<KnownFactLifecycle14> {
  const session = await validateKnownFactSession14Record(sessionRaw);
  return validateKnownFactLifecycle14({
    format: KNOWN_FACT_LIFECYCLE_FORMAT,
    formatVersion: KNOWN_FACT_LIFECYCLE_VERSION,
    status: 'draft', session, completedRevisions: [], events: [],
  });
}

/** Explicit completion does not require 100% coverage or erase follow-ups. */
export async function completeKnownFactLifecycle14(
  raw: unknown,
  command: { expectedRevisionId: string; eventId: string; completedAt: string; acknowledgedFollowUpQuestionIds: string[] },
): Promise<KnownFactLifecycle14> {
  const source = await validateKnownFactLifecycle14(raw);
  if (source.status !== 'draft') throw new Error('Only a Draft lifecycle can be completed.');
  if (source.session.revisionId !== nonempty(command?.expectedRevisionId, 'Expected revision ID')) throw new Error('Stale lifecycle revision; completion was not applied.');
  const eventId = nonempty(command.eventId, 'Completion event ID');
  const completedAt = timestamp(command.completedAt, 'Completion time');
  if (completedAt < source.session.updatedAt) {
    throw new Error('Completion cannot predate the captured source revision.');
  }
  const acknowledgedFollowUpQuestionIds = stringIds(command.acknowledgedFollowUpQuestionIds, 'Acknowledged follow-up IDs');
  if (source.events.some(event => event.eventId === eventId)) throw new Error('Lifecycle event ID already exists.');
  const completion: CompletedKnownFactRevision14 = {
    completionEventId: eventId,
    revisionId: source.session.revisionId,
    completedAt,
    acknowledgedFollowUpQuestionIds,
    sessionSnapshot: structuredClone(source.session),
  };
  const result = {
    ...source,
    status: 'completed' as const,
    completedRevisions: [...source.completedRevisions, completion],
    events: [...source.events, { type: 'completed' as const, eventId, revisionId: source.session.revisionId, occurredAt: completedAt, acknowledgedFollowUpQuestionIds }],
  };
  return validateKnownFactLifecycle14(result);
}

/** Reopening preserves the completed snapshot and starts a new parent-linked Draft revision. */
export async function reopenKnownFactLifecycle14(
  raw: unknown,
  command: { expectedRevisionId: string; eventId: string; newRevisionId: string; reopenedAt: string },
): Promise<KnownFactLifecycle14> {
  const source = await validateKnownFactLifecycle14(raw);
  if (source.status !== 'completed') throw new Error('Only a Completed lifecycle can be reopened.');
  if (source.session.revisionId !== nonempty(command?.expectedRevisionId, 'Expected revision ID')) throw new Error('Stale lifecycle revision; reopen was not applied.');
  const eventId = nonempty(command.eventId, 'Reopen event ID');
  const newRevisionId = nonempty(command.newRevisionId, 'New Draft revision ID');
  const reopenedAt = timestamp(command.reopenedAt, 'Reopen time');
  if (reopenedAt < source.session.updatedAt) {
    throw new Error('Reopen cannot predate the completed source revision.');
  }
  if (source.events.some(event => event.eventId === eventId)) throw new Error('Lifecycle event ID already exists.');
  if (source.events.some(event => event.type === 'reopened' && event.newRevisionId === newRevisionId)
    || source.completedRevisions.some(item => item.revisionId === newRevisionId)) throw new Error('New Draft revision ID already exists.');
  const session: KnownFactSession14 = {
    ...structuredClone(source.session),
    revisionId: newRevisionId,
    parentRevisionId: source.session.revisionId,
    updatedAt: reopenedAt,
  };
  const result = {
    ...source,
    status: 'draft' as const,
    session,
    events: [...source.events, { type: 'reopened' as const, eventId, fromRevisionId: source.session.revisionId, newRevisionId, occurredAt: reopenedAt }],
  };
  return validateKnownFactLifecycle14(result);
}

/** Explicitly record only that an interviewer says read-back happened; this is never consent or completion. */
export async function recordKnownFactReadBack14(
  raw: unknown,
  command: { eventId: string; occurredAt: string },
): Promise<KnownFactLifecycle14> {
  const source = await validateKnownFactLifecycle14(raw);
  const eventId = nonempty(command?.eventId, 'Read-back event ID');
  const occurredAt = timestamp(command.occurredAt, 'Read-back time');
  if (occurredAt < source.session.updatedAt) {
    throw new Error('Read-back cannot predate the captured source revision.');
  }
  if (source.events.some(event => event.eventId === eventId)) throw new Error('Lifecycle event ID already exists.');
  return validateKnownFactLifecycle14({
    ...source,
    events: [...source.events, { type: 'read-back-recorded' as const, eventId, revisionId: source.session.revisionId, occurredAt }],
  });
}

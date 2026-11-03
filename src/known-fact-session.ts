import { canonicalizeJson } from './pack-identity';
import { createKnownFactLedger, validateKnownFactLedger, type KnownFactLedger, type KnownFactEvidence } from './known-fact-evidence';
import { validateSemanticSessionRecord, type SemanticInterviewSession } from './semantic-session';
import type { KnownFact } from './domain';
import { EFFECTIVE_EVIDENCE_EQUALS_V2 } from './coverage-rules';

/**
 * Domain-only schema boundary for #34A2A.
 *
 * The live application and IndexedDB continue using canonical 1.3 until a separate
 * reviewed storage + UI migration activates 1.4. This module neither writes data
 * nor silently adds fields to the 1.3 validator.
 */
export const KNOWN_FACT_SESSION_SCHEMA_VERSION = '1.4.0' as const;
export const SEMANTIC_13_TO_KNOWN_FACT_14_MIGRATION_ID = 'semantic-1.3-to-known-fact-1.4' as const;

export type KnownFactAnswerLink =
  | { kind: 'accepted'; factId: string; acceptanceId: string }
  | { kind: 'legacy-unverified' };

export interface KnownFactSession14 extends Omit<SemanticInterviewSession, 'sessionSchemaVersion'> {
  sessionSchemaVersion: typeof KNOWN_FACT_SESSION_SCHEMA_VERSION;
  knownFactLedger: KnownFactLedger;
  /** Question-scoped provenance links. Legacy 1.3 evidence is explicitly not a verified acceptance. */
  knownFactAnswerLinks: Record<string, KnownFactAnswerLink>;
}

function sourceFactView(fact: KnownFactEvidence): KnownFact {
  return {
    id: fact.id,
    label: fact.label,
    value: fact.value,
    provenance: fact.provenance,
    ...(fact.questionId === undefined ? {} : { questionId: fact.questionId }),
  };
}

function assertSourceRoots(sourceFacts: readonly KnownFact[], ledger: KnownFactLedger): void {
  const originals = ledger.facts.filter((fact) => fact.supersedesFactId === undefined);
  if (originals.length !== sourceFacts.length) {
    throw new Error('Known fact ledger must retain every original session source fact exactly once.');
  }
  const seen = new Set<string>();
  for (const fact of sourceFacts) {
    if (seen.has(fact.id)) throw new Error('Duplicate source known fact ID.');
    seen.add(fact.id);
  }
  const originalById = new Map(originals.map((fact) => [fact.id, fact]));
  for (const fact of sourceFacts) {
    const original = originalById.get(fact.id);
    if (!original || canonicalizeJson(sourceFactView(original)) !== canonicalizeJson(fact)) {
      throw new Error('Known fact ledger source snapshot differs from original session evidence.');
    }
  }
}

function validateAnswerLinks(
  raw: unknown,
  session: SemanticInterviewSession,
  ledger: KnownFactLedger,
): Record<string, KnownFactAnswerLink> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Known-fact answer links must be a record.');
  }
  const links = raw as Record<string, unknown>;
  const checked: Record<string, KnownFactAnswerLink> = {};
  const facts = new Map(ledger.facts.map((fact) => [fact.id, fact]));
  const acceptances = new Map(ledger.acceptances.map((event) => [event.id, event]));

  for (const [questionId, rawLink] of Object.entries(links)) {
    const answer = session.answers[questionId];
    if (!answer || answer.source !== 'accepted-known-fact') {
      throw new Error('Known-fact answer link must target an accepted-known-fact question.');
    }
    if (!rawLink || typeof rawLink !== 'object' || Array.isArray(rawLink)) {
      throw new Error('Known-fact answer link is invalid.');
    }
    const link = rawLink as Record<string, unknown>;
    if (link.kind === 'legacy-unverified') {
      if (Object.keys(link).some((key) => key !== 'kind')) {
        throw new Error('Legacy unverified link contains an unsupported field.');
      }
      if (answer.resolution === 'captured' && !answer.needsConfirmation) {
        throw new Error('Legacy unverified captured known-fact evidence must require confirmation.');
      }
      checked[questionId] = { kind: 'legacy-unverified' };
      continue;
    }
    if (link.kind !== 'accepted'
      || Object.keys(link).some((key) => !['kind', 'factId', 'acceptanceId'].includes(key))) {
      throw new Error('Accepted known-fact answer link is invalid.');
    }
    if (typeof link.factId !== 'string' || !link.factId.trim()
      || typeof link.acceptanceId !== 'string' || !link.acceptanceId.trim()) {
      throw new Error('Accepted known-fact answer link requires nonempty fact and acceptance IDs.');
    }
    const fact = facts.get(link.factId);
    const acceptance = acceptances.get(link.acceptanceId);
    if (!fact || !acceptance || acceptance.factId !== fact.id
      || acceptance.valueSnapshot !== answer.value) {
      throw new Error('Accepted known-fact answer value is not backed by its acceptance snapshot.');
    }
    if (fact.questionId !== undefined && fact.questionId !== questionId) {
      throw new Error('Accepted known-fact answer link has incorrect question attribution.');
    }
    if (answer.resolution === 'captured' && !answer.needsConfirmation
      && ledger.facts.some((item) => item.supersedesFactId === fact.id)) {
      throw new Error('Superseded known-fact answer must require confirmation.');
    }
    checked[questionId] = {
      kind: 'accepted',
      factId: fact.id,
      acceptanceId: acceptance.id,
    };
  }
  for (const [questionId, answer] of Object.entries(session.answers)) {
    if (answer.source === 'accepted-known-fact'
      && !Object.prototype.hasOwnProperty.call(checked, questionId)) {
      throw new Error('Accepted-known-fact answer is missing its evidence link.');
    }
  }
  return checked;
}

/**
 * Closed 1.4 validator delegates every pre-existing session/pack/answer rule to
 * the accepted 1.3 validator, then adds ledger validation and source identity.
 */
export async function validateKnownFactSession14Record(raw: unknown): Promise<KnownFactSession14> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Known-fact session JSON must be an object.');
  const input = raw as Record<string, unknown>;
  if (input.sessionSchemaVersion !== KNOWN_FACT_SESSION_SCHEMA_VERSION) {
    throw new Error('Unsupported known-fact session schema version.');
  }
  if (!Object.prototype.hasOwnProperty.call(input, 'knownFactLedger')
    || !Object.prototype.hasOwnProperty.call(input, 'knownFactAnswerLinks')) {
    throw new Error('Known-fact session ledger and answer links are required.');
  }
  // Strip only explicitly versioned 1.4 fields; canonical 1.3 validation
  // continues to reject all other unsupported session fields.
  const { knownFactLedger, knownFactAnswerLinks, ...base } = input;
  const semantic = await validateSemanticSessionRecord({
    ...base, sessionSchemaVersion: '1.3.0',
  });
  const ledger = validateKnownFactLedger(knownFactLedger);
  assertSourceRoots(semantic.knownFacts, ledger);
  const links = validateAnswerLinks(knownFactAnswerLinks, semantic, ledger);
  return {
    ...semantic,
    sessionSchemaVersion: KNOWN_FACT_SESSION_SCHEMA_VERSION,
    knownFactLedger: ledger,
    knownFactAnswerLinks: links,
  };
}

/**
 * One-way deterministic and non-mutating 1.3→1.4 projection. No acceptance
 * events, confirmations or fact provenance are invented. An unusable legacy
 * fact fails closed rather than being dropped from the new evidence ledger.
 */
export async function migrateSemantic13ToKnownFact14(raw: unknown): Promise<KnownFactSession14> {
  const source = await validateSemanticSessionRecord(raw);
  const ledger = createKnownFactLedger(source.knownFacts);
  const knownFactAnswerLinks: Record<string, KnownFactAnswerLink> = {};
  const answers = structuredClone(source.answers);
  for (const [questionId, answer] of Object.entries(answers)) {
    if (answer.source !== 'accepted-known-fact') continue;
    // A 1.3 source tag has no durable acceptance ID. Preserve its value and
    // note but never fabricate acceptance history or authoritative coverage.
    knownFactAnswerLinks[questionId] = { kind: 'legacy-unverified' };
    answer.needsConfirmation = true;
  }
  const converted: KnownFactSession14 = {
    ...structuredClone(source),
    answers,
    sessionSchemaVersion: KNOWN_FACT_SESSION_SCHEMA_VERSION,
    revisionId: `migration:${source.revisionId}:${SEMANTIC_13_TO_KNOWN_FACT_14_MIGRATION_ID}`,
    parentRevisionId: source.revisionId,
    knownFactLedger: ledger,
    knownFactAnswerLinks,
  };
  return validateKnownFactSession14Record(converted);
}

/**
 * Compatibility is about version fields, not error message wording. In particular,
 * a closed-key error saying "unsupported field" is invalid data, not a future schema.
 */
function unsupportedNestedVersionReason(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const pack = (raw as Record<string, unknown>).packSnapshot;
  if (!pack || typeof pack !== 'object' || Array.isArray(pack)) return null;
  const snapshot = pack as Record<string, unknown>;
  if (typeof snapshot.packSchemaVersion === 'string' && snapshot.packSchemaVersion !== '1.0.0') {
    return 'Unsupported pack snapshot schema version.';
  }
  if (typeof snapshot.ruleSemanticsVersion === 'string' && snapshot.ruleSemanticsVersion !== EFFECTIVE_EVIDENCE_EQUALS_V2) {
    return 'Unsupported semantic rule semantics version.';
  }
  return null;
}

export type KnownFactMigrationPlan =
  | {
    kind: 'ready';
    session: KnownFactSession14;
    raw: unknown;
    fingerprint: string;
    sourceSchemaVersion: '1.3.0';
    migrationId: typeof SEMANTIC_13_TO_KNOWN_FACT_14_MIGRATION_ID;
  }
  | { kind: 'current'; session: KnownFactSession14 }
  | { kind: 'unsupported'; reason: string }
  | { kind: 'invalid'; reason: string };

/**
 * Pure single-transition planner for a future archive+CAS storage adapter.
 * Unsupported historical/future versions never silently auto-upgrade.
 */
export async function planKnownFactMigration(raw: unknown): Promise<KnownFactMigrationPlan> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { kind: 'invalid', reason: 'Session JSON must be an object.' };
  }
  const version = (raw as Record<string, unknown>).sessionSchemaVersion;
  if (version !== '1.3.0' && version !== KNOWN_FACT_SESSION_SCHEMA_VERSION) {
    return { kind: 'unsupported', reason: `Unsupported known-fact migration source ${String(version)}.` };
  }
  try {
    if (version === KNOWN_FACT_SESSION_SCHEMA_VERSION) {
      return { kind: 'current', session: await validateKnownFactSession14Record(raw) };
    }
    return {
      kind: 'ready',
      session: await migrateSemantic13ToKnownFact14(raw),
      fingerprint: canonicalizeJson(raw),
      raw,
      sourceSchemaVersion: '1.3.0',
      migrationId: SEMANTIC_13_TO_KNOWN_FACT_14_MIGRATION_ID,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Known-fact migration candidate is invalid.';
    const unsupported = unsupportedNestedVersionReason(raw);
    return unsupported === null
      ? { kind: 'invalid', reason }
      : { kind: 'unsupported', reason: unsupported };
  }
}

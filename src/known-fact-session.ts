import { canonicalizeJson } from './pack-identity';
import { createKnownFactLedger, validateKnownFactLedger, type KnownFactLedger, type KnownFactEvidence } from './known-fact-evidence';
import { validateSemanticSessionRecord, type SemanticInterviewSession } from './semantic-session';
import type { KnownFact } from './domain';

/**
 * Domain-only schema boundary for #34A2A.
 *
 * The live application and IndexedDB continue using canonical 1.3 until a separate
 * reviewed storage + UI migration activates 1.4. This module neither writes data
 * nor silently adds fields to the 1.3 validator.
 */
export const KNOWN_FACT_SESSION_SCHEMA_VERSION = '1.4.0' as const;
export const SEMANTIC_13_TO_KNOWN_FACT_14_MIGRATION_ID = 'semantic-1.3-to-known-fact-1.4' as const;

export interface KnownFactSession14 extends Omit<SemanticInterviewSession, 'sessionSchemaVersion'> {
  sessionSchemaVersion: typeof KNOWN_FACT_SESSION_SCHEMA_VERSION;
  knownFactLedger: KnownFactLedger;
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
  if (!Object.prototype.hasOwnProperty.call(input, 'knownFactLedger')) {
    throw new Error('Known-fact session ledger is required.');
  }
  // Explicitly strip only the new field before delegating. Unrecognized fields
  // continue to fail via the canonical 1.3 closed-key validator.
  const { knownFactLedger, ...base } = input;
  const semantic = await validateSemanticSessionRecord({
    ...base, sessionSchemaVersion: '1.3.0',
  });
  const ledger = validateKnownFactLedger(knownFactLedger);
  assertSourceRoots(semantic.knownFacts, ledger);
  return {
    ...semantic,
    sessionSchemaVersion: KNOWN_FACT_SESSION_SCHEMA_VERSION,
    knownFactLedger: ledger,
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
  const converted: KnownFactSession14 = {
    ...structuredClone(source),
    sessionSchemaVersion: KNOWN_FACT_SESSION_SCHEMA_VERSION,
    revisionId: `migration:${source.revisionId}:${SEMANTIC_13_TO_KNOWN_FACT_14_MIGRATION_ID}`,
    parentRevisionId: source.revisionId,
    knownFactLedger: ledger,
  };
  return validateKnownFactSession14Record(converted);
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
    return {
      kind: 'invalid',
      reason: error instanceof Error ? error.message : 'Known-fact migration candidate is invalid.',
    };
  }
}

import type { InterviewSession } from './domain';
import { EFFECTIVE_EVIDENCE_EQUALS_V2 } from './coverage-rules';
import { generalDiscoveryPack100 } from './historical-packs/general-discovery-1.0.0';
import { assertLegacySessionMatchesPack, parseLegacySession10, type LegacySession10 } from './legacy-session';
import { canonicalizeJson, pinPackSnapshot, sha256Hex, validateHistoricalPinned11Record, validateSessionRecord } from './pack-identity';
import {
  PINNED_12_TO_13_MIGRATION_ID,
  SEMANTIC_SESSION_SCHEMA_VERSION,
  planSemanticMigration,
  type SemanticInterviewSession,
} from './semantic-session';

export const INDEXED_DB_LAYOUT_VERSION = 4;
export const CURRENT_SESSION_SCHEMA_VERSION = SEMANTIC_SESSION_SCHEMA_VERSION;
export const PINNED_12_SESSION_SCHEMA_VERSION = '1.2.0' as const;
export const PACK_SCHEMA_VERSION = '1.0.0';
export const PINNED_12_RULE_SEMANTICS_VERSION = 'condition-equals-v1' as const;
/** Historical compatibility alias retained for the accepted 1.2 fixtures and migration proofs. */
export const RULE_SEMANTICS_VERSION = PINNED_12_RULE_SEMANTICS_VERSION;
export const CURRENT_RULE_SEMANTICS_VERSION = EFFECTIVE_EVIDENCE_EQUALS_V2;
export const LEGACY_TO_PINNED_MIGRATION_ID = 'legacy-1.0-to-1.1';
export const PINNED_11_TO_12_MIGRATION_ID = 'pinned-1.1-to-1.2';

export const migrationRegistry = [
  {
    sourceSessionSchemaVersion: '1.0.0' as const,
    packId: 'general-discovery',
    packVersion: '1.0.0',
    targetSessionSchemaVersion: '1.1.0',
    ruleSemanticsVersion: PINNED_12_RULE_SEMANTICS_VERSION,
    migrationId: LEGACY_TO_PINNED_MIGRATION_ID,
    historicalPack: generalDiscoveryPack100,
  },
] as const;

export function legacyArchiveKey(
  sessionId: string,
  sourceSchemaVersion: string = '1.0.0',
  migrationId = LEGACY_TO_PINNED_MIGRATION_ID,
): string {
  return `${sessionId}|${sourceSchemaVersion}|${migrationId}`;
}

export type HistoricalMigrationPlan =
  | { kind: 'ready'; session: InterviewSession; fingerprint: string; raw: unknown; sourceSchemaVersion: '1.0.0' | '1.1.0'; migrationId: string }
  | { kind: 'current'; session: InterviewSession }
  | { kind: 'unsupported'; reason: string }
  | { kind: 'invalid'; reason: string };

export type MigrationPlan =
  | Extract<HistoricalMigrationPlan, { kind: 'ready' }>
  | { kind: 'ready'; session: SemanticInterviewSession; fingerprint: string; raw: unknown; sourceSchemaVersion: '1.2.0'; migrationId: typeof PINNED_12_TO_13_MIGRATION_ID }
  | { kind: 'current'; session: SemanticInterviewSession }
  | { kind: 'unsupported'; reason: string }
  | { kind: 'invalid'; reason: string };

function migrationFor(packId: string, packVersion: string) {
  return migrationRegistry.find((entry) => entry.packId === packId && entry.packVersion === packVersion);
}

export async function planLegacyMigration(raw: unknown): Promise<HistoricalMigrationPlan> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { kind: 'invalid', reason: 'Legacy session JSON must be an object.' };
  const record = raw as Record<string, unknown>;
  if (record.sessionSchemaVersion === PINNED_12_SESSION_SCHEMA_VERSION) {
    try { return { kind: 'current', session: await validateSessionRecord(raw) }; }
    catch (error) { return { kind: 'invalid', reason: error instanceof Error ? error.message : 'Pinned 1.2 session is invalid.' }; }
  }
  if (record.sessionSchemaVersion !== '1.0.0') {
    return { kind: 'unsupported', reason: `Unsupported session schema ${String(record.sessionSchemaVersion)}. Recovery only; the stored row was not changed.` };
  }
  const packId = typeof record.interviewPackId === 'string' ? record.interviewPackId : '';
  const packVersion = typeof record.interviewPackVersion === 'string' ? record.interviewPackVersion : '';
  const migration = migrationFor(packId, packVersion);
  if (!migration) {
    return { kind: 'unsupported', reason: `No archived pack for ${packId || 'unknown'} ${packVersion || 'unknown'}. The stored row was not changed.` };
  }
  let legacy: LegacySession10;
  try {
    legacy = parseLegacySession10(raw);
    assertLegacySessionMatchesPack(legacy, migration.historicalPack);
  } catch (error) {
    return { kind: 'invalid', reason: error instanceof Error ? error.message : 'Legacy session is invalid.' };
  }
  const pinned = await pinPackSnapshot(migration.historicalPack, false);
  const session: InterviewSession = {
    sessionSchemaVersion: '1.1.0',
    sessionId: legacy.sessionId,
    revisionId: `legacy:${legacy.sessionId}`,
    parentRevisionId: null,
    interviewPackId: migration.historicalPack.packId,
    interviewPackVersion: migration.historicalPack.packVersion,
    clientLabel: legacy.clientLabel,
    interviewerLabel: legacy.interviewerLabel,
    interviewMode: legacy.interviewMode,
    createdAt: legacy.createdAt,
    updatedAt: legacy.updatedAt,
    currentQuestionId: legacy.currentQuestionId,
    knownFacts: legacy.knownFacts,
    answers: legacy.answers,
    runningNotes: legacy.runningNotes,
    packSnapshot: pinned.packSnapshot,
    packIdentity: pinned.packIdentity,
  };
  const validated = await validateHistoricalPinned11Record(session);
  return {
    kind: 'ready',
    session: validated,
    fingerprint: canonicalizeJson(raw),
    raw,
    sourceSchemaVersion: '1.0.0',
    migrationId: LEGACY_TO_PINNED_MIGRATION_ID,
  };
}

export async function migratePinned11To12(raw: unknown): Promise<HistoricalMigrationPlan> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { kind: 'invalid', reason: 'Session JSON must be an object.' };
  const record = raw as Record<string, unknown>;
  if (record.sessionSchemaVersion !== '1.1.0') return { kind: 'unsupported', reason: 'Only pinned session schema 1.1.0 can use this migration.' };
  try {
    const source = await validateHistoricalPinned11Record(raw);
    const packSnapshot = {
      ...source.packSnapshot,
      ruleSemanticsVersion: PINNED_12_RULE_SEMANTICS_VERSION as typeof PINNED_12_RULE_SEMANTICS_VERSION,
    };
    const packIdentity = {
      algorithm: 'SHA-256' as const,
      canonicalization: 'ldw-json-c14n-v1' as const,
      digest: await sha256Hex(canonicalizeJson(packSnapshot)),
    };
    const session: InterviewSession = {
      ...source,
      sessionSchemaVersion: PINNED_12_SESSION_SCHEMA_VERSION,
      revisionId: `migration:${source.revisionId}:${PINNED_11_TO_12_MIGRATION_ID}`,
      parentRevisionId: source.revisionId,
      packSnapshot,
      packIdentity,
    };
    return {
      kind: 'ready',
      session: await validateSessionRecord(session),
      fingerprint: canonicalizeJson(raw),
      raw,
      sourceSchemaVersion: '1.1.0',
      migrationId: PINNED_11_TO_12_MIGRATION_ID,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Pinned 1.1 session is invalid.';
    return /unsupported (pack snapshot schema|rule semantics)/i.test(reason)
      ? { kind: 'unsupported', reason }
      : { kind: 'invalid', reason };
  }
}

/**
 * Plans exactly one accepted schema transition. Stored upgrades call this repeatedly and commit
 * each transition in its own archive+current transaction so no historical source is skipped.
 */
export async function planCurrentMigration(raw: unknown): Promise<MigrationPlan> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { kind: 'invalid', reason: 'Session JSON must be an object.' };
  const schemaVersion = (raw as Record<string, unknown>).sessionSchemaVersion;
  if (typeof schemaVersion !== 'string') return { kind: 'invalid', reason: 'Session schema version is missing or invalid.' };

  if (schemaVersion === CURRENT_SESSION_SCHEMA_VERSION || schemaVersion === PINNED_12_SESSION_SCHEMA_VERSION) {
    return planSemanticMigration(raw);
  }
  if (schemaVersion === '1.1.0') return migratePinned11To12(raw) as Promise<MigrationPlan>;
  if (schemaVersion === '1.0.0') return planLegacyMigration(raw) as Promise<MigrationPlan>;
  return { kind: 'unsupported', reason: `Unsupported session schema ${String(schemaVersion)}.` };
}

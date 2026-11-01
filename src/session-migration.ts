import type { InterviewSession } from './domain';
import { generalDiscoveryPack100 } from './historical-packs/general-discovery-1.0.0';
import { assertLegacySessionMatchesPack, parseLegacySession10, type LegacySession10 } from './legacy-session';
import { canonicalizeJson, pinPackSnapshot, sha256Hex, validateHistoricalPinned11Record, validateSessionRecord } from './pack-identity';

export const INDEXED_DB_LAYOUT_VERSION = 2;
export const CURRENT_SESSION_SCHEMA_VERSION = '1.2.0';
export const PACK_SCHEMA_VERSION = '1.0.0';
export const RULE_SEMANTICS_VERSION = 'condition-equals-v1';
export const LEGACY_TO_PINNED_MIGRATION_ID = 'legacy-1.0-to-1.1';
export const PINNED_11_TO_12_MIGRATION_ID = 'pinned-1.1-to-1.2';

export const migrationRegistry = [
  {
    sourceSessionSchemaVersion: '1.0.0' as const,
    packId: 'general-discovery',
    packVersion: '1.0.0',
    targetSessionSchemaVersion: '1.1.0',
    ruleSemanticsVersion: RULE_SEMANTICS_VERSION,
    migrationId: LEGACY_TO_PINNED_MIGRATION_ID,
    historicalPack: generalDiscoveryPack100,
  },
] as const;

export function legacyArchiveKey(sessionId: string, sourceSchemaVersion: string = '1.0.0', migrationId = LEGACY_TO_PINNED_MIGRATION_ID): string {
  return `${sessionId}|${sourceSchemaVersion}|${migrationId}`;
}

export type MigrationPlan =
  | { kind: 'ready'; session: InterviewSession; fingerprint: string; raw: unknown; sourceSchemaVersion: '1.0.0' | '1.1.0'; migrationId: string }
  | { kind: 'current'; session: InterviewSession }
  | { kind: 'unsupported'; reason: string }
  | { kind: 'invalid'; reason: string };

function migrationFor(packId: string, packVersion: string) {
  return migrationRegistry.find((entry) => entry.packId === packId && entry.packVersion === packVersion);
}

export async function planLegacyMigration(raw: unknown): Promise<MigrationPlan> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { kind: 'invalid', reason: 'Legacy session JSON must be an object.' };
  const record = raw as Record<string, unknown>;
  if (record.sessionSchemaVersion === CURRENT_SESSION_SCHEMA_VERSION) {
    try { return { kind: 'current', session: await validateSessionRecord(raw) }; }
    catch (error) { return { kind: 'invalid', reason: error instanceof Error ? error.message : 'Current session is invalid.' }; }
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
  return { kind: 'ready', session: validated, fingerprint: canonicalizeJson(raw), raw, sourceSchemaVersion: '1.0.0', migrationId: LEGACY_TO_PINNED_MIGRATION_ID };
}

export async function migratePinned11To12(raw: unknown): Promise<MigrationPlan> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { kind: 'invalid', reason: 'Session JSON must be an object.' };
  const record = raw as Record<string, unknown>;
  if (record.sessionSchemaVersion !== '1.1.0') return { kind: 'unsupported', reason: 'Only pinned session schema 1.1.0 can use this migration.' };
  try {
    const source = await validateHistoricalPinned11Record(raw);
    const packSnapshot = { ...source.packSnapshot, ruleSemanticsVersion: RULE_SEMANTICS_VERSION as typeof RULE_SEMANTICS_VERSION };
    const packIdentity = {
      algorithm: 'SHA-256' as const,
      canonicalization: 'ldw-json-c14n-v1' as const,
      digest: await sha256Hex(canonicalizeJson(packSnapshot)),
    };
    const session: InterviewSession = { ...source, sessionSchemaVersion: CURRENT_SESSION_SCHEMA_VERSION, packSnapshot, packIdentity };
    return { kind: 'ready', session: await validateSessionRecord(session), fingerprint: canonicalizeJson(raw), raw, sourceSchemaVersion: '1.1.0', migrationId: PINNED_11_TO_12_MIGRATION_ID };
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Pinned 1.1 session is invalid.';
    return /unsupported (pack snapshot schema|rule semantics)/i.test(reason)
      ? { kind: 'unsupported', reason }
      : { kind: 'invalid', reason };
  }
}

export async function planCurrentMigration(raw: unknown): Promise<MigrationPlan> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { kind: 'invalid', reason: 'Session JSON must be an object.' };
  const schemaVersion = (raw as Record<string, unknown>).sessionSchemaVersion;
  if (typeof schemaVersion !== 'string') return { kind: 'invalid', reason: 'Session schema version is missing or invalid.' };
  if (schemaVersion === CURRENT_SESSION_SCHEMA_VERSION) {
    const snapshot = (raw as Record<string, unknown>).packSnapshot;
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) || (snapshot as Record<string, unknown>).ruleSemanticsVersion === undefined) {
      return { kind: 'invalid', reason: 'Current session is missing rule semantics metadata.' };
    }
    try { return { kind: 'current', session: await validateSessionRecord(raw) }; }
    catch (error) {
      const reason = error instanceof Error ? error.message : 'Current session is invalid.';
      return /unsupported (pack snapshot schema|rule semantics|session schema)/i.test(reason)
        ? { kind: 'unsupported', reason }
        : { kind: 'invalid', reason };
    }
  }
  if (schemaVersion === '1.1.0') return migratePinned11To12(raw);
  if (schemaVersion === '1.0.0') {
    const intermediate = await planLegacyMigration(raw);
    if (intermediate.kind !== 'ready') return intermediate;
    const current = await migratePinned11To12(intermediate.session);
    if (current.kind !== 'ready') return current;
    return { ...current, fingerprint: intermediate.fingerprint, raw: intermediate.raw, sourceSchemaVersion: '1.0.0', migrationId: LEGACY_TO_PINNED_MIGRATION_ID };
  }
  return { kind: 'unsupported', reason: `Unsupported session schema ${String(schemaVersion)}.` };
}

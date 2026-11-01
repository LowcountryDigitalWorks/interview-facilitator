import type { InterviewSession } from './domain';
import { generalDiscoveryPack100 } from './historical-packs/general-discovery-1.0.0';
import { assertLegacySessionMatchesPack, parseLegacySession10, type LegacySession10 } from './legacy-session';
import { canonicalizeJson, pinPackSnapshot, validateSessionRecord } from './pack-identity';

export const INDEXED_DB_LAYOUT_VERSION = 2;
export const CURRENT_SESSION_SCHEMA_VERSION = '1.1.0';
export const PACK_SCHEMA_VERSION = '1.0.0';
export const RULE_SEMANTICS_VERSION = 'condition-equals-v1';
export const LEGACY_TO_PINNED_MIGRATION_ID = 'legacy-1.0-to-1.1';

export const migrationRegistry = [
  {
    sourceSessionSchemaVersion: '1.0.0' as const,
    packId: 'general-discovery',
    packVersion: '1.0.0',
    targetSessionSchemaVersion: CURRENT_SESSION_SCHEMA_VERSION,
    ruleSemanticsVersion: RULE_SEMANTICS_VERSION,
    migrationId: LEGACY_TO_PINNED_MIGRATION_ID,
    historicalPack: generalDiscoveryPack100,
  },
] as const;

export function legacyArchiveKey(sessionId: string): string {
  return `${sessionId}|1.0.0|${LEGACY_TO_PINNED_MIGRATION_ID}`;
}

export type MigrationPlan =
  | { kind: 'ready'; session: InterviewSession; fingerprint: string; raw: unknown }
  | { kind: 'current' }
  | { kind: 'unsupported'; reason: string }
  | { kind: 'invalid'; reason: string };

function migrationFor(packId: string, packVersion: string) {
  return migrationRegistry.find((entry) => entry.packId === packId && entry.packVersion === packVersion);
}

export async function planLegacyMigration(raw: unknown): Promise<MigrationPlan> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { kind: 'invalid', reason: 'Legacy session JSON must be an object.' };
  const record = raw as Record<string, unknown>;
  if (record.sessionSchemaVersion === CURRENT_SESSION_SCHEMA_VERSION) return { kind: 'current' };
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
  const pinned = await pinPackSnapshot(migration.historicalPack);
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
  const validated = await validateSessionRecord(session);
  return { kind: 'ready', session: validated, fingerprint: canonicalizeJson(raw), raw };
}

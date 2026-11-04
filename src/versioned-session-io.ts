import { validateKnownFactSession14Record, type KnownFactSession14 } from './known-fact-session';
import { canonicalizeJson } from './pack-identity';
import { planCurrentMigration } from './session-migration';
import { validateSemanticSessionRecord, type SemanticInterviewSession } from './semantic-session';

/**
 * #34A2B2B — pure, internal-only compatibility gate for canonical JSON.
 *
 * The live 1.3 app must NOT use this to activate a 1.4 session until its
 * list/load/edit/save/import/export surfaces have a separately accepted route.
 * Inspection never writes, upgrades, drops fields, or invents acceptance.
 */
export type VersionedSessionInspection =
  | { kind: 'readable'; schemaVersion: '1.3.0'; session: SemanticInterviewSession }
  | { kind: 'readable'; schemaVersion: '1.4.0'; session: KnownFactSession14 }
  | { kind: 'migration-required'; schemaVersion: '1.0.0' | '1.1.0' | '1.2.0'; nextSchemaVersion: '1.1.0' | '1.2.0' | '1.3.0' }
  | { kind: 'unsupported-version'; schemaVersion: string; reason: string }
  | { kind: 'invalid'; reason: string };

const HISTORICAL_NEXT_VERSION = {
  '1.0.0': '1.1.0',
  '1.1.0': '1.2.0',
  '1.2.0': '1.3.0',
} as const;

const MAX_IMPORT_BYTES = 2_000_000;
const SEMVER = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;

function errorReason(error: unknown): string {
  return error instanceof Error ? error.message : 'Session data is not valid.';
}

export async function inspectSessionCompatibilityForReview(raw: unknown): Promise<VersionedSessionInspection> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { kind: 'invalid', reason: 'Session JSON must be an object.' };
  }
  const version = (raw as Record<string, unknown>).sessionSchemaVersion;
  if (typeof version !== 'string' || !SEMVER.test(version)) {
    return { kind: 'invalid', reason: 'Session schema version is missing or invalid.' };
  }
  if (version === '1.3.0') {
    try {
      return { kind: 'readable', schemaVersion: version, session: await validateSemanticSessionRecord(raw) };
    } catch (error) {
      return { kind: 'invalid', reason: errorReason(error) };
    }
  }
  if (version === '1.4.0') {
    try {
      return { kind: 'readable', schemaVersion: version, session: await validateKnownFactSession14Record(raw) };
    } catch (error) {
      return { kind: 'invalid', reason: errorReason(error) };
    }
  }
  if (Object.prototype.hasOwnProperty.call(HISTORICAL_NEXT_VERSION, version)) {
    const historical = version as keyof typeof HISTORICAL_NEXT_VERSION;
    const plan = await planCurrentMigration(raw);
    if (plan.kind === 'ready') {
      return { kind: 'migration-required', schemaVersion: historical, nextSchemaVersion: HISTORICAL_NEXT_VERSION[historical] };
    }
    if (plan.kind === 'unsupported') return { kind: 'unsupported-version', schemaVersion: version, reason: plan.reason };
    return { kind: 'invalid', reason: plan.kind === 'invalid' ? plan.reason : 'Historical session cannot be migrated safely.' };
  }
  return { kind: 'unsupported-version', schemaVersion: version, reason: 'Unsupported session schema version; preserve source for recovery.' };
}

/** Parse and inspect only. The caller must not persist anything based on this result. */
export async function parseCanonicalSessionJsonForReview(jsonText: string): Promise<VersionedSessionInspection> {
  if (new TextEncoder().encode(jsonText).byteLength > MAX_IMPORT_BYTES) {
    return { kind: 'invalid', reason: 'Session import exceeds the safe size limit.' };
  }
  try {
    return await inspectSessionCompatibilityForReview(JSON.parse(jsonText) as unknown);
  } catch {
    return { kind: 'invalid', reason: 'Session import is not valid JSON.' };
  }
}

/**
 * Exports only an exactly validated 1.3 or 1.4 envelope. Never serializes
 * a historical/future/invalid record as if it were current, and never downgrades.
 */
export async function exportCanonicalSessionJsonForReview(raw: unknown): Promise<string> {
  const inspection = await inspectSessionCompatibilityForReview(raw);
  if (inspection.kind !== 'readable') {
    throw new Error('Session is not a validated 1.3 or 1.4 record; no export was created.');
  }
  const json = canonicalizeJson(inspection.session);
  if (new TextEncoder().encode(json).byteLength > MAX_IMPORT_BYTES) {
    throw new Error('Session export exceeds the safe size limit.');
  }
  return json;
}

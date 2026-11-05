import { canonicalizeJson, sha256Hex } from './pack-identity';
import {
  KNOWN_FACT_SESSION_SCHEMA_VERSION,
  validateKnownFactSession14Record,
  type KnownFactSession14,
} from './known-fact-session';

/**
 * #35C: dormant canonical 1.4 backup contract, INTERNAL/CONFIDENTIAL.
 * No file writes, no storage modification, no restore/import button, no client
 * Read-back, no provider sync and no change to the live 1.3 app.
 *
 * Integrity digest detects corruption; it is NOT encryption or authentication.
 * Handle produced bytes as confidential customer-discovery material.
 */
export const KNOWN_FACT14_BACKUP_FORMAT = 'ldw-known-fact-session-1.4-backup-v1' as const;
export const KNOWN_FACT14_BACKUP_CLASSIFICATION = 'INTERNAL / CONFIDENTIAL' as const;
export const KNOWN_FACT14_BACKUP_MAX_CHARS = 5_000_000;
const TOP_LEVEL_KEYS = ['kind', 'formatVersion', 'classification', 'sessionSchemaVersion', 'integrity', 'session'] as const;
const INTEGRITY_KEYS = ['algorithm', 'canonicalization', 'digest'] as const;

type JsonObject = Record<string, unknown>;

function requireObject(value: unknown, name: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value as JsonObject;
}

function onlyKeys(value: JsonObject, keys: readonly string[], name: string): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) {
    throw new Error(`${name} contains unsupported fields.`);
  }
}

/** The 1.4 validator can represent optional absence as undefined in memory.
 * The backup records exactly its JSON meaning, without inventing values.
 */
function canonicalSessionJson(validated: KnownFactSession14): string {
  return canonicalizeJson(JSON.parse(JSON.stringify(validated)));
}

/** Deterministic, lossless canonical 1.4 backup; never a client export. */
export async function createKnownFact14CanonicalBackupForReview(raw: unknown): Promise<string> {
  const session = await validateKnownFactSession14Record(raw);
  const sessionJson = canonicalSessionJson(session);
  const body: JsonObject = {
    kind: KNOWN_FACT14_BACKUP_FORMAT,
    formatVersion: 1,
    classification: KNOWN_FACT14_BACKUP_CLASSIFICATION,
    sessionSchemaVersion: KNOWN_FACT_SESSION_SCHEMA_VERSION,
    integrity: {
      algorithm: 'SHA-256',
      canonicalization: 'ldw-json-c14n-v1',
      digest: await sha256Hex(sessionJson),
    },
    session: JSON.parse(sessionJson),
  };
  const artifact = canonicalizeJson(body) + '\n';
  if (artifact.length > KNOWN_FACT14_BACKUP_MAX_CHARS) {
    throw new Error('Canonical backup exceeds the bounded artifact size.');
  }
  return artifact;
}

/** Validates in memory only. Callers must separately gate any future storage restore. */
export async function validateKnownFact14CanonicalBackupForReview(input: unknown): Promise<KnownFactSession14> {
  if (typeof input !== 'string' || !input.trim() || input.length > KNOWN_FACT14_BACKUP_MAX_CHARS) {
    throw new Error('Canonical backup must be nonempty bounded JSON text.');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(input); }
  catch { throw new Error('Canonical backup must be valid JSON text.'); }
  const envelope = requireObject(parsed, 'Canonical backup envelope');
  onlyKeys(envelope, TOP_LEVEL_KEYS, 'Canonical backup envelope');
  if (envelope.kind !== KNOWN_FACT14_BACKUP_FORMAT
    || envelope.formatVersion !== 1
    || envelope.classification !== KNOWN_FACT14_BACKUP_CLASSIFICATION
    || envelope.sessionSchemaVersion !== KNOWN_FACT_SESSION_SCHEMA_VERSION) {
    throw new Error('Unsupported canonical backup contract.');
  }
  const integrity = requireObject(envelope.integrity, 'Canonical backup integrity');
  onlyKeys(integrity, INTEGRITY_KEYS, 'Canonical backup integrity');
  if (integrity.algorithm !== 'SHA-256'
    || integrity.canonicalization !== 'ldw-json-c14n-v1'
    || typeof integrity.digest !== 'string'
    || !/^[0-9a-f]{64}$/.test(integrity.digest)) {
    throw new Error('Unsupported canonical backup integrity record.');
  }
  const validated = await validateKnownFactSession14Record(envelope.session);
  if (await sha256Hex(canonicalSessionJson(validated)) !== integrity.digest) {
    throw new Error('Canonical backup integrity mismatch; no restore was attempted.');
  }
  return validated;
}

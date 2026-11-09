import { canonicalizeJson, sha256Hex } from './pack-identity';
import {
  validateSemanticSessionRecord, type SemanticInterviewSession,
} from './semantic-session';
import {
  loadConfirmationTrialForReview,
  seedConfirmationTrialForReview,
} from './interview-prep-confirmation-idb-trial';

/**
 * #35 / #105 — isolated, synthetic-only canonical confirmation backup proof.
 * Export returns PRIVATE JSON to caller memory, never downloads/syncs/sends.
 * Restore can ONLY seed the disposable confirmation-trial database and uses
 * IDB add (not put): an existing session cannot be overwritten by recovery.
 *
 * SHA-256 detects accidental corruption. It is NOT a signature, encryption,
 * verified consent, off-device retention or authority over a real client.
 */
export const PREP_CONFIRMATION_BACKUP_KIND =
  'ldw.synthetic-prep-confirmation-backup.v1' as const;
const MAX_BACKUP_BYTES = 2_500_000;

type Backup = {
  kind: typeof PREP_CONFIRMATION_BACKUP_KIND;
  formatVersion: 1;
  classification: 'INTERNAL / CONFIDENTIAL / SYNTHETIC ONLY';
  integrity: {
    algorithm: 'SHA-256';
    canonicalization: 'ldw-json-c14n-v1';
    digest: string;
  };
  session: SemanticInterviewSession;
};

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(label + ' must be a plain record.');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(label + ' must be a plain record.');
  }
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, names: readonly string[], label: string): void {
  if (Object.keys(value).length !== names.length
    || Object.keys(value).some(key => !names.includes(key))
    || names.some(key => !Object.hasOwn(value, key))) {
    throw new Error(label + ' has missing or unsupported fields.');
  }
}
function synthetic(session: SemanticInterviewSession): void {
  if (!session.clientLabel.startsWith('SYNTHETIC ')) {
    throw new Error('Only synthetic labeled confirmation sessions may be backed up.');
  }
}
function bounded(bytes: string): void {
  if (new TextEncoder().encode(bytes).byteLength > MAX_BACKUP_BYTES) {
    throw new Error('Synthetic confirmation backup exceeds the size bound.');
  }
}

/** Build a deterministic self-contained, unencrypted PRIVATE backup. */
export async function createConfirmationTrialBackupForReview(raw: unknown): Promise<string> {
  const session = await validateSemanticSessionRecord(raw);
  synthetic(session);
  const payload = canonicalizeJson(session);
  const envelope: Backup = {
    kind: PREP_CONFIRMATION_BACKUP_KIND,
    formatVersion: 1,
    classification: 'INTERNAL / CONFIDENTIAL / SYNTHETIC ONLY',
    integrity: {
      algorithm: 'SHA-256',
      canonicalization: 'ldw-json-c14n-v1',
      digest: await sha256Hex(payload),
    },
    session,
  };
  const output = canonicalizeJson(envelope) + '\n';
  bounded(output);
  return output;
}

/** Refuse noncanonical, truncated, modified, unknown-version and real-client records. */
export async function validateConfirmationTrialBackupForReview(raw: unknown):
Promise<SemanticInterviewSession> {
  if (typeof raw !== 'string' || !raw || !raw.endsWith('\n')) {
    throw new Error('Synthetic confirmation backup must be canonical JSON text.');
  }
  bounded(raw);
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch {
    throw new Error('Synthetic confirmation backup is malformed JSON.');
  }
  const value = record(parsed, 'Synthetic confirmation backup');
  exactKeys(value, ['kind', 'formatVersion', 'classification', 'integrity', 'session'],
    'Synthetic confirmation backup');
  if (value.kind !== PREP_CONFIRMATION_BACKUP_KIND || value.formatVersion !== 1
    || value.classification !== 'INTERNAL / CONFIDENTIAL / SYNTHETIC ONLY') {
    throw new Error('Unsupported synthetic confirmation backup format.');
  }
  const integrity = record(value.integrity, 'Synthetic confirmation integrity');
  exactKeys(integrity, ['algorithm', 'canonicalization', 'digest'],
    'Synthetic confirmation integrity');
  if (integrity.algorithm !== 'SHA-256'
    || integrity.canonicalization !== 'ldw-json-c14n-v1'
    || typeof integrity.digest !== 'string'
    || !/^[0-9a-f]{64}$/.test(integrity.digest)) {
    throw new Error('Synthetic confirmation backup integrity metadata is invalid.');
  }
  const session = await validateSemanticSessionRecord(value.session);
  synthetic(session);
  if (canonicalizeJson(value.session) !== canonicalizeJson(session)
    || await sha256Hex(canonicalizeJson(session)) !== integrity.digest
    || canonicalizeJson(value) + '\n' !== raw) {
    throw new Error('Synthetic confirmation backup integrity mismatch.');
  }
  return session;
}

/** Return bytes to the calling reviewer; no file, URL or background transfer. */
export async function exportConfirmationTrialBackupForReview(
  db: IDBDatabase, sessionId: string,
): Promise<string> {
  const session = await loadConfirmationTrialForReview(db, sessionId);
  if (!session) throw new Error('No synthetic confirmed session exists to back up.');
  return createConfirmationTrialBackupForReview(session);
}

/**
 * Restore into isolated trial DB using add (unique key); any collision
 * propagates as a failed transaction with NO overwrite. Explicit deletion
 * and physical external retention are separately gated operations.
 */
export async function restoreConfirmationTrialBackupForReview(
  db: IDBDatabase, bytes: unknown,
): Promise<SemanticInterviewSession> {
  const session = await validateConfirmationTrialBackupForReview(bytes);
  await seedConfirmationTrialForReview(db, session);
  return session;
}

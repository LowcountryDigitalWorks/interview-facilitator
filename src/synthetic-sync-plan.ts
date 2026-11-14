import { canonicalizeJson, sha256Hex } from './pack-identity';
import { validateSemanticSessionRecord } from './semantic-session';

/**
 * S1 — isolated synthetic-only, transport-independent revision sync planning.
 * No network adapter, IndexedDB writes/outbox, authentication or production
 * client enablement. A server ACK has no standing without future approved
 * authenticated transport and durable provider-side commit verification.
 */
export const SYNTHETIC_SYNC_PLAN_VERSION = 'synthetic-sync-v1' as const;
export const SYNTHETIC_SYNC_MAX_CANONICAL_BYTES = 2_000_000;

export interface SyntheticRevisionHead {
  protocolVersion: typeof SYNTHETIC_SYNC_PLAN_VERSION;
  sessionSchemaVersion: '1.3.0';
  sessionId: string;
  revisionId: string;
  parentRevisionId: string | null;
  packDigest: string;
  snapshotDigest: string;
}

export interface SyntheticSyncOffer {
  head: SyntheticRevisionHead;
  operationId: string;
}

export type SyntheticReconciliation =
  | { kind: 'offer-local'; local: SyntheticRevisionHead }
  | { kind: 'already-aligned'; local: SyntheticRevisionHead }
  | { kind: 'review-remote'; local: SyntheticRevisionHead; remote: SyntheticRevisionHead }
  | { kind: 'hold-unsaved-local'; local: SyntheticRevisionHead; remote: SyntheticRevisionHead }
  | { kind: 'preserve-conflict'; local: SyntheticRevisionHead; remote: SyntheticRevisionHead }
  | { kind: 'invalid-or-incompatible' };

export interface SyntheticDurableAck {
  operationId: string;
  sessionId: string;
  revisionId: string;
  snapshotDigest: string;
  committed: boolean;
}

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const HEAD_KEYS = [
  'protocolVersion', 'sessionSchemaVersion', 'sessionId', 'revisionId',
  'parentRevisionId', 'packDigest', 'snapshotDigest',
];

function isHead(value: unknown): value is SyntheticRevisionHead {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).length !== HEAD_KEYS.length
    || Object.keys(v).some(key => !HEAD_KEYS.includes(key))) return false;
  return v.protocolVersion === SYNTHETIC_SYNC_PLAN_VERSION
    && v.sessionSchemaVersion === '1.3.0'
    && typeof v.sessionId === 'string' && ID_PATTERN.test(v.sessionId)
    && typeof v.revisionId === 'string' && ID_PATTERN.test(v.revisionId)
    && (v.parentRevisionId === null
      || (typeof v.parentRevisionId === 'string'
        && ID_PATTERN.test(v.parentRevisionId)
        && v.parentRevisionId !== v.revisionId))
    && typeof v.packDigest === 'string' && DIGEST_PATTERN.test(v.packDigest)
    && typeof v.snapshotDigest === 'string' && DIGEST_PATTERN.test(v.snapshotDigest);
}

/**
 * Metadata-only planning head derived from the canonical, validated 1.3
 * session. No answers, client labels, private notes, or credentials in head.
 * Digest is an equality fingerprint, NOT signature/authentication/encryption.
 */
export async function prepareSyntheticRevisionOffer(rawSession: unknown): Promise<SyntheticSyncOffer> {
  const validated = await validateSemanticSessionRecord(rawSession);
  const canonical = canonicalizeJson(validated);
  if (new TextEncoder().encode(canonical).byteLength > SYNTHETIC_SYNC_MAX_CANONICAL_BYTES) {
    throw new Error('Synthetic sync snapshot exceeds the source-only limit.');
  }
  const head: SyntheticRevisionHead = {
    protocolVersion: SYNTHETIC_SYNC_PLAN_VERSION,
    sessionSchemaVersion: '1.3.0',
    sessionId: validated.sessionId,
    revisionId: validated.revisionId,
    parentRevisionId: validated.parentRevisionId,
    packDigest: validated.packIdentity.digest,
    snapshotDigest: await sha256Hex(canonical),
  };
  if (!isHead(head)) throw new Error('Synthetic sync identity is invalid.');
  const operationId = await sha256Hex(canonicalizeJson({
    protocol: SYNTHETIC_SYNC_PLAN_VERSION,
    sessionId: head.sessionId,
    revisionId: head.revisionId,
    snapshotDigest: head.snapshotDigest,
  }));
  return { head, operationId };
}

/**
 * The "remote" head is evidence to review, not proof of an authenticated
 * server. This pure planner DOES NOT merge snapshots, mutate device data or
 * authorize a remote write; it keeps uncertainty and divergent branches.
 */
export function planSyntheticRevisionReconciliation(
  rawLocal: unknown,
  rawRemote: unknown | null,
  hasUnsavedLocalEdits: boolean,
): SyntheticReconciliation {
  if (!isHead(rawLocal)) return { kind: 'invalid-or-incompatible' };
  const local = { ...rawLocal };
  if (rawRemote === null) {
    return hasUnsavedLocalEdits
      ? { kind: 'invalid-or-incompatible' }
      : { kind: 'offer-local', local };
  }
  if (!isHead(rawRemote) || rawRemote.sessionId !== local.sessionId
    || rawRemote.packDigest !== local.packDigest) return { kind: 'invalid-or-incompatible' };
  const remote = { ...rawRemote };
  if (remote.revisionId === local.revisionId) {
    return remote.snapshotDigest === local.snapshotDigest
      ? { kind: 'already-aligned', local }
      : { kind: 'preserve-conflict', local, remote };
  }
  if (hasUnsavedLocalEdits) return { kind: 'hold-unsaved-local', local, remote };
  if (local.parentRevisionId === remote.revisionId) {
    return { kind: 'offer-local', local };
  }
  if (remote.parentRevisionId === local.revisionId) {
    return { kind: 'review-remote', local, remote };
  }
  // Unknown depth, same-parent diverged, or unrelated revisions: never
  // infer LWW/ancestry from clocks or silently overwrite interview evidence.
  return { kind: 'preserve-conflict', local, remote };
}

/**
 * Only a future protected adapter may promote an authenticated durable ACK
 * into any real SYNCED status. This pure comparison cannot authenticate ACKs.
 * A mismatch or negative ACK retains the outbox item for review/retry.
 */
export function evaluateSyntheticDurableAck(
  offer: SyntheticSyncOffer,
  ack: unknown,
): 'candidate-ack-matched' | 'retain-queued' {
  if (!isHead(offer?.head) || typeof offer.operationId !== 'string'
    || !DIGEST_PATTERN.test(offer.operationId)
    || !ack || typeof ack !== 'object' || Array.isArray(ack)) return 'retain-queued';
  const record = ack as Record<string, unknown>;
  if (Object.keys(record).length !== 5
    || Object.keys(record).some(key => ![
      'operationId', 'sessionId', 'revisionId', 'snapshotDigest', 'committed',
    ].includes(key))) return 'retain-queued';
  return record.committed === true
    && record.operationId === offer.operationId
    && record.sessionId === offer.head.sessionId
    && record.revisionId === offer.head.revisionId
    && record.snapshotDigest === offer.head.snapshotDigest
    ? 'candidate-ack-matched' : 'retain-queued';
}

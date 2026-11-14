import { canonicalizeJson, sha256Hex } from './pack-identity';
import {
  SYNTHETIC_SYNC_PLAN_VERSION,
  type SyntheticRevisionHead,
  type SyntheticSyncOffer,
} from './synthetic-sync-plan';

/**
 * S2A — isolated, synthetic, transport-neutral policy-planning contract.
 * There is NO proof of authentication here: the future server must obtain
 * fresh verified actor/engagement grants and stored revision/receipt state
 * from protected infrastructure, then enforce this decision atomically.
 * This module is NEVER imported by the 1.3 PWA or an HTTP handler.
 */
export const SYNTHETIC_RELAY_PROTOCOL = 'synthetic-relay-policy-v1' as const;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const HEX_SHA256 = /^[a-f0-9]{64}$/;

export interface SyntheticRelayScope {
  tenantId: string;
  clientId: string;
  engagementId: string;
  sessionId: string;
}

export interface SyntheticRelayAppendRequest {
  protocol: typeof SYNTHETIC_RELAY_PROTOCOL;
  scope: SyntheticRelayScope;
  offer: SyntheticSyncOffer;
  expectedRemoteRevisionId: string | null;
}

/**
 * Test-only representation of what an approved *server* would look up after
 * authenticating the actor on THIS request. A forged object with this shape
 * is not evidence of identity or permission.
 */
export interface SyntheticServerPolicySnapshot {
  source: 'server-policy-test-fixture';
  actorId: string;
  scope: SyntheticRelayScope;
  actorState: 'active' | 'revoked';
  assignmentState: 'active' | 'revoked';
  actions: ('append' | 'read')[];
}

/**
 * Future backend would read this AND any replay receipt from its protected
 * authoritative store inside an atomic compare-and-swap boundary. Passing
 * it from a browser is not acceptable authorization or durable evidence.
 */
export interface SyntheticServerStoredSnapshot {
  scope: SyntheticRelayScope;
  current: SyntheticRevisionHead | null;
  replayReceipt: SyntheticStoredReceipt | null;
}

export interface SyntheticStoredReceipt {
  scope: SyntheticRelayScope;
  operationId: string;
  revisionId: string;
  snapshotDigest: string;
  committed: true;
}

export type SyntheticRelayDecision =
  | { kind: 'deny' }
  | { kind: 'candidate-append'; expectedRemoteRevisionId: string | null; next: SyntheticRevisionHead }
  | { kind: 'candidate-replay'; operationId: string }
  | { kind: 'candidate-conflict-preserve'; current: SyntheticRevisionHead; offered: SyntheticRevisionHead };

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (Object.getOwnPropertySymbols(value).length !== 0) return false;
  const found = Object.keys(value);
  return found.length === keys.length && found.every(key => keys.includes(key));
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function validDigest(value: unknown): value is string {
  return typeof value === 'string' && HEX_SHA256.test(value);
}

const SCOPE_KEYS = ['tenantId', 'clientId', 'engagementId', 'sessionId'];
const HEAD_KEYS = [
  'protocolVersion', 'sessionSchemaVersion', 'sessionId', 'revisionId',
  'parentRevisionId', 'packDigest', 'snapshotDigest',
];

function parseScope(raw: unknown): SyntheticRelayScope | null {
  if (!exactRecord(raw, SCOPE_KEYS)) return null;
  if (!validId(raw.tenantId) || !validId(raw.clientId)
    || !validId(raw.engagementId) || !validId(raw.sessionId)) return null;
  return {
    tenantId: raw.tenantId, clientId: raw.clientId,
    engagementId: raw.engagementId, sessionId: raw.sessionId,
  };
}

function scopesEqual(a: SyntheticRelayScope, b: SyntheticRelayScope): boolean {
  return a.tenantId === b.tenantId && a.clientId === b.clientId
    && a.engagementId === b.engagementId && a.sessionId === b.sessionId;
}

function parseHead(raw: unknown): SyntheticRevisionHead | null {
  if (!exactRecord(raw, HEAD_KEYS)) return null;
  if (raw.protocolVersion !== SYNTHETIC_SYNC_PLAN_VERSION
    || raw.sessionSchemaVersion !== '1.3.0'
    || !validId(raw.sessionId) || !validId(raw.revisionId)
    || !validDigest(raw.packDigest) || !validDigest(raw.snapshotDigest)
    || !(raw.parentRevisionId === null
      || (validId(raw.parentRevisionId) && raw.parentRevisionId !== raw.revisionId))) return null;
  return {
    protocolVersion: SYNTHETIC_SYNC_PLAN_VERSION,
    sessionSchemaVersion: '1.3.0',
    sessionId: raw.sessionId, revisionId: raw.revisionId,
    parentRevisionId: raw.parentRevisionId,
    packDigest: raw.packDigest, snapshotDigest: raw.snapshotDigest,
  };
}

function parsePolicy(raw: unknown): SyntheticServerPolicySnapshot | null {
  if (!exactRecord(raw, ['source', 'actorId', 'scope', 'actorState', 'assignmentState', 'actions'])
    || raw.source !== 'server-policy-test-fixture' || !validId(raw.actorId)
    || !Array.isArray(raw.actions) || raw.actions.length < 1
    || raw.actions.length > 2 || new Set(raw.actions).size !== raw.actions.length
    || !raw.actions.every(action => action === 'append' || action === 'read')
    || (raw.actorState !== 'active' && raw.actorState !== 'revoked')
    || (raw.assignmentState !== 'active' && raw.assignmentState !== 'revoked')) return null;
  const scope = parseScope(raw.scope);
  if (!scope) return null;
  return {
    source: 'server-policy-test-fixture', actorId: raw.actorId, scope,
    actorState: raw.actorState, assignmentState: raw.assignmentState,
    actions: [...raw.actions],
  };
}

function parseReceipt(raw: unknown): SyntheticStoredReceipt | null {
  if (!exactRecord(raw, ['scope', 'operationId', 'revisionId', 'snapshotDigest', 'committed'])
    || raw.committed !== true || !validDigest(raw.operationId)
    || !validId(raw.revisionId) || !validDigest(raw.snapshotDigest)) return null;
  const scope = parseScope(raw.scope);
  if (!scope) return null;
  return {
    scope, operationId: raw.operationId,
    revisionId: raw.revisionId, snapshotDigest: raw.snapshotDigest,
    committed: true,
  };
}

/**
 * A denied operation returns NO identifiers, remote heads, or reason.
 * Source-only candidate outcomes are NOT a server-side authorization grant:
 * future protection must authenticate, re-fetch policy + receipt per request,
 * perform an atomic durable CAS, then issue a signed/authenticated response.
 */
export async function planSyntheticProtectedRelayAppend(
  rawRequest: unknown,
  rawServerPolicy: unknown,
  rawServerStored: unknown,
): Promise<SyntheticRelayDecision> {
  const deny: SyntheticRelayDecision = { kind: 'deny' };
  if (!exactRecord(rawRequest, ['protocol', 'scope', 'offer', 'expectedRemoteRevisionId'])
    || rawRequest.protocol !== SYNTHETIC_RELAY_PROTOCOL) return deny;
  const scope = parseScope(rawRequest.scope);
  const policy = parsePolicy(rawServerPolicy);
  if (!scope || !policy || policy.actorState !== 'active'
    || policy.assignmentState !== 'active' || !policy.actions.includes('append')
    || !scopesEqual(scope, policy.scope)) return deny;

  if (!exactRecord(rawRequest.offer, ['head', 'operationId'])
    || !validDigest(rawRequest.offer.operationId)) return deny;
  const head = parseHead(rawRequest.offer.head);
  if (!head || head.sessionId !== scope.sessionId) return deny;

  const expected = rawRequest.expectedRemoteRevisionId;
  if (!(expected === null || validId(expected))) return deny;
  const expectedOperationId = await sha256Hex(canonicalizeJson({
    protocol: SYNTHETIC_SYNC_PLAN_VERSION,
    sessionId: head.sessionId,
    revisionId: head.revisionId,
    snapshotDigest: head.snapshotDigest,
  }));
  if (rawRequest.offer.operationId !== expectedOperationId) return deny;

  if (!exactRecord(rawServerStored, ['scope', 'current', 'replayReceipt'])) return deny;
  const storedScope = parseScope(rawServerStored.scope);
  if (!storedScope || !scopesEqual(scope, storedScope)) return deny;
  const current = rawServerStored.current === null ? null : parseHead(rawServerStored.current);
  if (rawServerStored.current !== null && !current) return deny;
  if (current && current.sessionId !== scope.sessionId) return deny;

  const receipt = rawServerStored.replayReceipt === null
    ? null : parseReceipt(rawServerStored.replayReceipt);
  if (rawServerStored.replayReceipt !== null && !receipt) return deny;
  if (receipt) {
    // An authenticated future store must query this receipt by scoped key
    // (tenant, engagement, session, operationId) before attempting CAS.
    if (!scopesEqual(scope, receipt.scope)
      || receipt.operationId !== rawRequest.offer.operationId
      || receipt.revisionId !== head.revisionId
      || receipt.snapshotDigest !== head.snapshotDigest) return deny;
    return { kind: 'candidate-replay', operationId: receipt.operationId };
  }

  if (current === null) {
    if (expected !== null || head.parentRevisionId !== null) return deny;
    return { kind: 'candidate-append', expectedRemoteRevisionId: null, next: head };
  }

  // Only the currently selected revision may be extended. A stale parent,
  // reused revision ID, pack mismatch, or unproved ancestry is a conflict.
  // No last-write-wins or automatic interview-evidence merge is possible.
  if (expected === current.revisionId && head.parentRevisionId === current.revisionId
    && head.packDigest === current.packDigest
    && head.revisionId !== current.revisionId) {
    return { kind: 'candidate-append', expectedRemoteRevisionId: current.revisionId, next: head };
  }
  return { kind: 'candidate-conflict-preserve', current, offered: head };
}

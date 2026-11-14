import { canonicalizeJson } from './pack-identity';
import {
  planSyntheticProtectedRelayAppend,
  type SyntheticRelayScope,
  type SyntheticServerPolicySnapshot,
  type SyntheticServerStoredSnapshot,
  type SyntheticStoredReceipt,
} from './synthetic-protected-relay-policy-s2a';
import type { SyntheticRevisionHead } from './synthetic-sync-plan';

/**
 * S2A-2: metadata-only IN-MEMORY, synthetic "server" transaction trial.
 * No HTTP, persistence, authenticated identity, encryption or real sync.
 * Do not import into the 1.3 PWA, a Worker, or any production backend.
 */
type StoredTrialState = {
  current: SyntheticRevisionHead | null;
  revisions: Map<string, SyntheticRevisionHead>;
  receipts: Map<string, SyntheticStoredReceipt>;
};

export type SyntheticTrialFault = 'none' | 'before-commit' | 'after-commit-before-reply';

export type SyntheticTrialResult =
  | { kind: 'deny' }
  | { kind: 'synthetic-committed'; operationId: string }
  | { kind: 'synthetic-replayed'; operationId: string }
  | { kind: 'synthetic-conflict-preserved'; current: SyntheticRevisionHead; offered: SyntheticRevisionHead }
  | { kind: 'synthetic-aborted-before-commit' }
  | { kind: 'synthetic-reply-lost-after-commit' };

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SCOPE_KEYS = ['tenantId', 'clientId', 'engagementId', 'sessionId'];
const HEX = /^[0-9a-f]{64}$/;

function dataField(value: unknown, name: string): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  return descriptor && 'value' in descriptor && descriptor.enumerable
    ? descriptor.value : undefined;
}

function scopedFixture(value: unknown): SyntheticRelayScope | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null)
    || Object.getOwnPropertySymbols(value).length !== 0
    || Object.keys(value).length !== 4
    || Object.keys(value).some(key => !SCOPE_KEYS.includes(key))) return null;
  const fields = SCOPE_KEYS.map(key => dataField(value, key));
  if (!fields.every(field => typeof field === 'string' && ID.test(field))) return null;
  return {
    tenantId: fields[0] as string,
    clientId: fields[1] as string,
    engagementId: fields[2] as string,
    sessionId: fields[3] as string,
  };
}

function cloneHead(head: SyntheticRevisionHead): SyntheticRevisionHead {
  return { ...head };
}

function copyTrialState(previous?: StoredTrialState): StoredTrialState {
  if (!previous) return { current: null, revisions: new Map(), receipts: new Map() };
  return {
    current: previous.current ? cloneHead(previous.current) : null,
    revisions: new Map([...previous.revisions].map(([id, h]) => [id, cloneHead(h)])),
    receipts: new Map([...previous.receipts].map(([op, receipt]) => [op, {
      ...receipt, scope: { ...receipt.scope },
    }])),
  };
}

/**
 * Each scope has a FIFO critical section. The ACTUAL protected service must
 * use provider-side durable transactions; a JS promise lock and its state
 * vanish on restart and offer no cross-process serialization.
 */
export class SyntheticMetadataServerTransactionTrial {
  readonly #state = new Map<string, StoredTrialState>();
  readonly #grants = new Map<string, Map<string, SyntheticServerPolicySnapshot>>();
  readonly #tails = new Map<string, Promise<void>>();

  async #exclusive<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>(resolve => { release = resolve; });
    this.#tails.set(key, mine);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.#tails.get(key) === mine) this.#tails.delete(key);
    }
  }

  /**
   * Privileged test-fixture setup ONLY. A real client must never be able to
   * create, approve or revoke its own grant.
   */
  async setSyntheticGrantForTest(
    actorId: string,
    rawScope: unknown,
    state: 'active' | 'revoked',
    assignment: 'active' | 'revoked',
    actions: ('read' | 'append')[],
  ): Promise<void> {
    const scope = scopedFixture(rawScope);
    if (!scope || !ID.test(actorId) || !['active', 'revoked'].includes(state)
      || !['active', 'revoked'].includes(assignment)
      || actions.length < 1 || actions.length > 2
      || new Set(actions).size !== actions.length
      || !actions.every(action => action === 'read' || action === 'append')) {
      throw new Error('Invalid synthetic fixture grant.');
    }
    const key = canonicalizeJson(scope);
    await this.#exclusive(key, async () => {
      const map = new Map(this.#grants.get(key) ?? []);
      map.set(actorId, {
        source: 'server-policy-test-fixture', actorId, scope,
        actorState: state, assignmentState: assignment, actions: [...actions],
      });
      this.#grants.set(key, map);
    });
  }

  /**
   * No authenticator here: actorId and route scope are supplied by a test.
   * A future service MUST independently authenticate actorId and resolve
   * ownership of the requested resource from server-owned data.
   */
  async appendForTest(
    claimedActorId: string,
    rawRouteScope: unknown,
    rawRequest: unknown,
    fault: SyntheticTrialFault = 'none',
  ): Promise<SyntheticTrialResult> {
    const route = scopedFixture(rawRouteScope);
    if (!route || !ID.test(claimedActorId)
      || !['none', 'before-commit', 'after-commit-before-reply'].includes(fault)) {
      return { kind: 'deny' };
    }
    const key = canonicalizeJson(route);
    return this.#exclusive(key, async () => {
      // The grant, current revision and receipt are all re-read *inside*
      // the same synthetic critical section on every request/replay.
      const grant = this.#grants.get(key)?.get(claimedActorId) ?? null;
      if (!grant) return { kind: 'deny' };
      const previous = this.#state.get(key);
      const rawOffer = dataField(rawRequest, 'offer');
      const op = dataField(rawOffer, 'operationId');
      const receipt = typeof op === 'string' && HEX.test(op)
        ? previous?.receipts.get(op) ?? null : null;
      const state: SyntheticServerStoredSnapshot = {
        scope: { ...route },
        current: previous?.current ? cloneHead(previous.current) : null,
        replayReceipt: receipt ? { ...receipt, scope: { ...receipt.scope } } : null,
      };
      const decision = await planSyntheticProtectedRelayAppend(rawRequest, grant, state);
      if (decision.kind === 'deny') return { kind: 'deny' };
      if (decision.kind === 'candidate-replay') {
        return { kind: 'synthetic-replayed', operationId: decision.operationId };
      }
      if (decision.kind === 'candidate-conflict-preserve') {
        return {
          kind: 'synthetic-conflict-preserved',
          current: cloneHead(decision.current), offered: cloneHead(decision.offered),
        };
      }

      const offered = cloneHead(decision.next);
      if (previous?.revisions.has(offered.revisionId)) {
        // Revision IDs are immutable throughout retained history, even if
        // a past ID is no longer the selected head.
        const current = previous.current;
        return current
          ? { kind: 'synthetic-conflict-preserved', current: cloneHead(current), offered }
          : { kind: 'deny' };
      }
      const operationId = dataField(rawOffer, 'operationId');
      if (typeof operationId !== 'string') return { kind: 'deny' };

      // Prepare every intended change on a private copy. The state swap is
      // the only synthetic commit point, with no await after publication.
      const next = copyTrialState(previous);
      next.current = offered;
      next.revisions.set(offered.revisionId, offered);
      next.receipts.set(operationId, {
        scope: { ...route }, operationId,
        revisionId: offered.revisionId,
        snapshotDigest: offered.snapshotDigest,
        committed: true,
      });
      if (fault === 'before-commit') return { kind: 'synthetic-aborted-before-commit' };
      this.#state.set(key, next);
      if (fault === 'after-commit-before-reply') {
        return { kind: 'synthetic-reply-lost-after-commit' };
      }
      return { kind: 'synthetic-committed', operationId };
    });
  }

  /** Unprotected TEST INSPECTION, not an API or a real read permission. */
  snapshotForTest(rawScope: unknown): {
    current: SyntheticRevisionHead | null;
    revisions: SyntheticRevisionHead[];
    receiptOperationIds: string[];
  } {
    const scope = scopedFixture(rawScope);
    if (!scope) throw new Error('Invalid synthetic fixture scope.');
    const state = this.#state.get(canonicalizeJson(scope));
    return {
      current: state?.current ? cloneHead(state.current) : null,
      revisions: [...(state?.revisions.values() ?? [])].map(cloneHead),
      receiptOperationIds: [...(state?.receipts.keys() ?? [])].sort(),
    };
  }
}

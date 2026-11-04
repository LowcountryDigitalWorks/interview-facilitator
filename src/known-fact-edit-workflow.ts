import { applyKnownFact14EditForReview, type KnownFact14Edit } from './known-fact-editor';
import {
  validateKnownFactSession14Record,
  type KnownFactSession14,
} from './known-fact-session';
import { canonicalizeJson } from './pack-identity';

/**
 * #34A3 — internal-only, dependency-injected 1.4 read/edit/CAS boundary.
 *
 * This module does not activate 1.4 in the application. It does not import
 * IndexedDB or a UI module; only the already separately reviewed 1.4
 * load/save adapter may be supplied when full runtime compatibility is gated.
 * The storage implementation MUST provide an atomic expected-revision check.
 */
export interface KnownFact14EditStorageForReview {
  load(sessionId: string): Promise<KnownFactSession14 | undefined>;
  save(session: KnownFactSession14, expectedRevisionId: string): Promise<KnownFactSession14>;
}

export type KnownFact14StoredEditResult =
  | { kind: 'missing' }
  | { kind: 'stale'; actualRevisionId: string }
  | { kind: 'unchanged'; session: KnownFactSession14 }
  | { kind: 'saved'; session: KnownFactSession14 };

export async function applyStoredKnownFact14EditForReview(
  input: { sessionId: string; expectedRevisionId: string; edit: KnownFact14Edit },
  store: KnownFact14EditStorageForReview,
): Promise<KnownFact14StoredEditResult> {
  if (typeof input?.sessionId !== 'string' || !input.sessionId.trim()
    || typeof input.expectedRevisionId !== 'string' || !input.expectedRevisionId.trim()) {
    throw new Error('Stored 1.4 edit requires a session ID and expected revision.');
  }

  // Validation before edit prohibits treating malformed or older 1.3 records
  // as implicitly upgradeable. A storage-read failure propagates instead of
  // masquerading as a legitimately missing interview.
  const found = await store.load(input.sessionId);
  if (found === undefined) return { kind: 'missing' };
  const source = await validateKnownFactSession14Record(found);
  if (source.sessionId !== input.sessionId) {
    throw new Error('Stored known-fact session identity mismatches the requested key.');
  }
  if (source.revisionId !== input.expectedRevisionId) {
    return { kind: 'stale', actualRevisionId: source.revisionId };
  }

  const next = await applyKnownFact14EditForReview(source, input.edit);
  if (canonicalizeJson(next) === canonicalizeJson(source)) {
    // Avoid revision/history churn for UI re-reads and accepted-fact no-ops.
    return { kind: 'unchanged', session: source };
  }

  // The trusted 1.4 save implementation re-checks the expected revision and
  // source fingerprint inside one IndexedDB transaction; the earlier read is
  // not itself a concurrency guarantee. Never swallow a late write conflict.
  const persisted = await store.save(next, input.expectedRevisionId);
  const checked = await validateKnownFactSession14Record(persisted);
  if (checked.sessionId !== input.sessionId
    || checked.revisionId === input.expectedRevisionId
    || checked.parentRevisionId !== input.expectedRevisionId) {
    throw new Error('Stored 1.4 edit did not return a new parent-linked revision.');
  }
  return { kind: 'saved', session: checked };
}

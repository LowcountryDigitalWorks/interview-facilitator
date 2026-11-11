import { canonicalizeJson } from './pack-identity';
import { validateSemanticSessionRecord, type SemanticInterviewSession } from './semantic-session';

/**
 * A bounded audit of RETAINED LOCAL snapshots, not an encrypted backup,
 * legal audit trail, tamper-proof attestation, or claim of full edit history.
 *
 * Ordinary autosave does not archive every revision. A missing link is
 * reported, never silently filled with current-session content.
 */
export interface RetainedLocalRevision {
  key: string;
  record: unknown;
}

export interface LocalRevisionContinuityReport {
  kind: 'local-revisions-only';
  status: 'none-retained' | 'linked-locally' | 'missing-link' | 'unlinked-snapshots';
  retainedCount: number;
  linkedCount: number;
  unlinkedCount: number;
  notice: string;
}

export const MAX_LOCAL_REVISION_AUDIT_ROWS = 200;

export async function auditRetainedLocalRevisionsForReview(
  rawCurrent: unknown,
  retained: readonly RetainedLocalRevision[],
): Promise<LocalRevisionContinuityReport> {
  const current = await validateSemanticSessionRecord(rawCurrent);
  if (!Array.isArray(retained) || retained.length > MAX_LOCAL_REVISION_AUDIT_ROWS) {
    throw new Error('Local revision history exceeds the safe audit limit.');
  }
  const byRevision = new Map<string, SemanticInterviewSession>();
  for (const item of retained) {
    if (!item || typeof item !== 'object' || typeof item.key !== 'string') {
      throw new Error('Retained local revision entry is invalid.');
    }
    const row = await validateSemanticSessionRecord(item.record);
    if (row.sessionId !== current.sessionId || row.revisionId === current.revisionId
      || item.key !== canonicalizeJson([row.sessionId, row.revisionId])
      || byRevision.has(row.revisionId)) {
      throw new Error('Local revision history identity or key is inconsistent.');
    }
    byRevision.set(row.revisionId, row);
  }
  if (retained.length === 0) {
    return {
      kind: 'local-revisions-only', status: 'none-retained',
      retainedCount: 0, linkedCount: 0, unlinkedCount: 0,
      notice: 'No earlier local snapshots are retained. This is not a backup.',
    };
  }
  let linkedCount = 0;
  let missing = false;
  let parent = current.parentRevisionId;
  let childUpdatedAt = current.updatedAt;
  const visited = new Set<string>([current.revisionId]);
  while (parent !== null) {
    if (visited.has(parent)) {
      throw new Error('Local revision history contains a parent cycle.');
    }
    visited.add(parent);
    const previous = byRevision.get(parent);
    if (!previous) {
      missing = true;
      break;
    }
    // A parent link must never run forward in semantic saved time.
    if (Date.parse(previous.updatedAt) > Date.parse(childUpdatedAt)) {
      throw new Error('Retained revision has a future timestamp.');
    }
    linkedCount++;
    childUpdatedAt = previous.updatedAt;
    parent = previous.parentRevisionId;
  }
  const unlinkedCount = retained.length - linkedCount;
  const status = missing ? 'missing-link'
    : unlinkedCount > 0 ? 'unlinked-snapshots' : 'linked-locally';
  const notice = status === 'linked-locally'
    ? 'Retained snapshots form a local parent chain. No off-device copy, encryption, or complete edit history has been established.'
    : status === 'missing-link'
      ? 'The local parent chain is missing at least one prior revision. Recovery history is incomplete.'
      : 'Some retained local snapshots are not in the current parent chain. No complete recovery history is established.';
  return {
    kind: 'local-revisions-only', status,
    retainedCount: retained.length, linkedCount, unlinkedCount, notice,
  };
}

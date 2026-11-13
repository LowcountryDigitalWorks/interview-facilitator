import {
  type LineageStatus,
  type PortableRevisionArchive,
  validatePortableRevisionArchiveJson,
} from './portable-revision-archive';
import {
  SEMANTIC_SESSION_SCHEMA_VERSION,
  validateSemanticSessionRecord,
  type SemanticInterviewSession,
} from './semantic-session';

/**
 * M4/E0 fresh-origin **preflight dry-run** for contract #123 portable revision archives.
 *
 * This module never writes IndexedDB, never opens import UI, and never attests
 * off-device authenticity. An unkeyed archive checksum only detects accidental
 * corruption of the envelope bytes, not trusted origin or adversarial tampering
 * (a forger can recompute the digest after edits).
 */
export const PORTABLE_RESTORE_PLAN_VERSION = 'ldw.interview-portable-restore-plan.v1' as const;

export type PortableRestorePreflightVerdict =
  | 'preflight-complete-head-validated'
  | 'preflight-incomplete-lineage'
  | 'preflight-reject';

export interface PortableRestorePreflightRevisionRow {
  revisionId: string;
  parentRevisionId: string | null;
  updatedAt: string;
  /** Validated 1.3 semantic record identity; content is not serialized into the plan. */
  sessionId: string;
  packDigest: string;
}

export interface PortableRestorePreflightScope {
  /** When set, the archive sessionId must match exactly or the plan fails closed. */
  expectedSessionId?: string;
  /** When set, the archive headRevisionId must match exactly or the plan fails closed. */
  expectedHeadRevisionId?: string;
}

export interface PortableRestorePreflightPlan {
  schemaVersion: typeof PORTABLE_RESTORE_PLAN_VERSION;
  kind: 'fresh-origin-restore-preflight-dry-run';
  verdict: PortableRestorePreflightVerdict;
  /** False unless lineage is complete-to-root and every retained record passed 1.3 validation. */
  headImportFeasible: boolean;
  sessionId: string;
  headRevisionId: string;
  archiveLineageStatus: LineageStatus;
  validatedRevisionCount: number;
  validatedRevisions: readonly PortableRestorePreflightRevisionRow[];
  integrityNotice: string;
  limitationNotice: string;
  nextOwnerApprovedStep: string;
}

function lineageBlocksImport(status: LineageStatus): boolean {
  return status !== 'complete-to-root';
}

async function validateRetainedRecords(
  archive: PortableRevisionArchive,
): Promise<PortableRestorePreflightRevisionRow[]> {
  const rows: PortableRestorePreflightRevisionRow[] = [];
  for (const revision of archive.revisions) {
    const session = await validateSemanticSessionRecord(revision.record);
    if (session.sessionId !== archive.sessionId) {
      throw new Error('Archive revision session identity does not match the envelope.');
    }
    if (session.revisionId !== revision.revisionId
      || session.parentRevisionId !== revision.parentRevisionId
      || session.updatedAt !== revision.updatedAt) {
      throw new Error('Archive revision wrapper does not match its semantic session record.');
    }
    if (session.sessionSchemaVersion !== SEMANTIC_SESSION_SCHEMA_VERSION) {
      throw new Error('Archive revision uses an unsupported semantic session schema.');
    }
    rows.push({
      revisionId: session.revisionId,
      parentRevisionId: session.parentRevisionId,
      updatedAt: session.updatedAt,
      sessionId: session.sessionId,
      packDigest: session.packIdentity.digest,
    });
  }
  const packDigests = new Set(rows.map((row) => row.packDigest));
  if (packDigests.size !== 1) {
    throw new Error('Archive contains mixed pinned interview packs.');
  }
  return rows;
}

function assertScope(archive: PortableRevisionArchive, scope: PortableRestorePreflightScope | undefined): void {
  if (!scope) return;
  if (scope.expectedSessionId !== undefined && archive.sessionId !== scope.expectedSessionId) {
    throw new Error('Portable restore scope session id does not match the archive.');
  }
  if (scope.expectedHeadRevisionId !== undefined && archive.headRevisionId !== scope.expectedHeadRevisionId) {
    throw new Error('Portable restore scope head revision id does not match the archive.');
  }
}

/**
 * Evaluate an untrusted portable archive JSON string and return a read-only
 * preflight plan. This does **not** restore application state.
 */
export async function planFreshOriginPortableRestoreDryRun(
  untrustedArchiveJson: string,
  scope?: PortableRestorePreflightScope,
): Promise<PortableRestorePreflightPlan> {
  if (typeof untrustedArchiveJson !== 'string' || untrustedArchiveJson.length === 0) {
    throw new Error('Portable restore input must be a nonempty archive JSON string.');
  }
  const archive = await validatePortableRevisionArchiveJson(untrustedArchiveJson);
  assertScope(archive, scope);
  const validatedRevisions = await validateRetainedRecords(archive);
  const blocked = lineageBlocksImport(archive.lineageStatus);
  const verdict: PortableRestorePreflightVerdict = blocked
    ? 'preflight-incomplete-lineage'
    : 'preflight-complete-head-validated';
  return {
    schemaVersion: PORTABLE_RESTORE_PLAN_VERSION,
    kind: 'fresh-origin-restore-preflight-dry-run',
    verdict,
    headImportFeasible: !blocked,
    sessionId: archive.sessionId,
    headRevisionId: archive.headRevisionId,
    archiveLineageStatus: archive.lineageStatus,
    validatedRevisionCount: validatedRevisions.length,
    validatedRevisions,
    integrityNotice: 'Archive checksum verified accidental corruption only. It is not authentication, encryption, or tamper-evidence.',
    limitationNotice: 'This dry-run does not write IndexedDB, perform import, or establish off-device confidentiality.',
    nextOwnerApprovedStep: blocked
      ? 'Owner-approved separate step required: fill missing ancestors or import only after an explicit collision/destination policy.'
      : 'Owner-approved separate step required: atomic transactional IndexedDB import with destination collision policy and rollback.',
  };
}

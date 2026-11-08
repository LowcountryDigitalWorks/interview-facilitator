import { canonicalizeJson } from './pack-identity';
import {
  planKnownFactMigration,
  SEMANTIC_13_TO_KNOWN_FACT_14_MIGRATION_ID,
} from './known-fact-session';
import { legacyArchiveKey, INDEXED_DB_LAYOUT_VERSION } from './session-migration';

/**
 * #34/#35: READ-ONLY dormant preflight for a future schema 1.4 activation.
 * Never imports main.ts, writes IndexedDB, migrates records, or authorizes
 * production use. Diagnostic output contains only counts and fixed codes:
 * no session IDs, client labels, notes, freeform validation errors or data.
 *
 * A pass proves only the evaluated snapshot. It NEVER proves external backup,
 * continued freshness, consent, privacy, durable disk flush or release safety.
 */
export const ACTIVATION_PREFLIGHT_FORMAT = 'ldw-1.4-readonly-activation-preflight-v1' as const;
export const ACTIVATION_PREFLIGHT_DB_NAME = 'ldw-interview-facilitator' as const;
export const ACTIVATION_PREFLIGHT_MAX_ROWS = 5000;
export const ACTIVATION_PREFLIGHT_MAX_ARCHIVES = 20000;

export type ActivationBlockCode14 =
  | 'INVALID_INPUT'
  | 'SOURCE_KEY_INVALID'
  | 'SOURCE_KEY_DUPLICATE'
  | 'SOURCE_KEY_MISMATCH'
  | 'SOURCE_INVALID'
  | 'SOURCE_UNSUPPORTED'
  | 'ARCHIVE_KEY_INVALID'
  | 'ARCHIVE_KEY_DUPLICATE'
  | 'ARCHIVE_CONFLICT'
  | 'ARCHIVE_REQUIRED'
  | 'ARCHIVE_REPLAY_INVALID'
  | 'ARCHIVE_REPLAY_MISMATCH';

export type ActivationFinding14 = {
  scope: 'snapshot' | 'session' | 'archive';
  index: number;
  code: ActivationBlockCode14;
};

export interface KnownFactActivationSnapshot14 {
  sessions: Array<{ key: unknown; value: unknown }>;
  archives: Array<{ key: unknown; value: unknown }>;
}

export type KnownFactActivationPreflight14 = {
  format: typeof ACTIVATION_PREFLIGHT_FORMAT;
  disposition: 'INSPECTION_PASS' | 'BLOCKED';
  /** Intentionally hard-false: not a product release or migration switch. */
  activationAuthorized: false;
  externalBackupVerified: false;
  snapshotOnly: true;
  counts: {
    sessions: number;
    archives: number;
    valid13Candidates: number;
    archived13Candidates: number;
    archivesToCreateOnFutureMigration: number;
    validated14Rows: number;
    verified14ArchiveReplays: number;
    unrelatedArchivesPreserved: number;
    blocked: number;
  };
  findings: ActivationFinding14[];
};

function key(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function makeFinding(scope: ActivationFinding14['scope'], index: number, code: ActivationBlockCode14) {
  return { scope, index, code };
}

/**
 * Pure, private-in/private-redacted-out snapshot audit.
 * The future writer MUST re-read and re-check every row and source archive in
 * its own transaction. This result is never a time-of-check authorization.
 */
export async function evaluateKnownFact14ActivationSnapshotForReview(
  input: unknown,
): Promise<KnownFactActivationPreflight14> {
  const candidate = input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown> : null;
  const sessions = candidate?.sessions;
  const archives = candidate?.archives;
  if (!Array.isArray(sessions) || !Array.isArray(archives)
    || sessions.length > ACTIVATION_PREFLIGHT_MAX_ROWS
    || archives.length > ACTIVATION_PREFLIGHT_MAX_ARCHIVES) {
    return {
      format: ACTIVATION_PREFLIGHT_FORMAT, disposition: 'BLOCKED',
      activationAuthorized: false, externalBackupVerified: false, snapshotOnly: true,
      counts: { sessions: 0, archives: 0, valid13Candidates: 0, archived13Candidates: 0,
        archivesToCreateOnFutureMigration: 0, validated14Rows: 0, verified14ArchiveReplays: 0,
        unrelatedArchivesPreserved: 0, blocked: 1 },
      findings: [makeFinding('snapshot', 0, 'INVALID_INPUT')],
    };
  }

  const findings: ActivationFinding14[] = [];
  const archiveByKey = new Map<string, { value: unknown; index: number }>();
  const encounteredArchives = new Set<string>();
  const seenSources = new Set<string>();
  let valid13Candidates = 0;
  let archived13Candidates = 0;
  let archivesToCreateOnFutureMigration = 0;
  let validated14Rows = 0;
  let verified14ArchiveReplays = 0;

  for (let index = 0; index < archives.length; index++) {
    const item = archives[index] as unknown;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      findings.push(makeFinding('archive', index, 'ARCHIVE_KEY_INVALID'));
      continue;
    }
    const archive = item as Record<string, unknown>;
    const archiveKey = key(archive.key);
    if (archiveKey === null) {
      findings.push(makeFinding('archive', index, 'ARCHIVE_KEY_INVALID'));
    } else if (archiveByKey.has(archiveKey)) {
      findings.push(makeFinding('archive', index, 'ARCHIVE_KEY_DUPLICATE'));
    } else {
      archiveByKey.set(archiveKey, { value: archive.value, index });
    }
  }

  for (let index = 0; index < sessions.length; index++) {
    const item = sessions[index] as unknown;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      findings.push(makeFinding('session', index, 'SOURCE_KEY_INVALID'));
      continue;
    }
    const row = item as Record<string, unknown>;
    const sessionKey = key(row.key);
    if (sessionKey === null) {
      findings.push(makeFinding('session', index, 'SOURCE_KEY_INVALID'));
      continue;
    }
    if (seenSources.has(sessionKey)) {
      findings.push(makeFinding('session', index, 'SOURCE_KEY_DUPLICATE'));
      continue;
    }
    seenSources.add(sessionKey);

    let plan: Awaited<ReturnType<typeof planKnownFactMigration>>;
    try { plan = await planKnownFactMigration(row.value); }
    catch {
      findings.push(makeFinding('session', index, 'SOURCE_INVALID'));
      continue;
    }
    if (plan.kind === 'unsupported') {
      findings.push(makeFinding('session', index, 'SOURCE_UNSUPPORTED'));
      continue;
    }
    if (plan.kind === 'invalid') {
      findings.push(makeFinding('session', index, 'SOURCE_INVALID'));
      continue;
    }
    if (plan.session.sessionId !== sessionKey) {
      findings.push(makeFinding('session', index, 'SOURCE_KEY_MISMATCH'));
      continue;
    }
    const archiveKey = legacyArchiveKey(
      sessionKey, '1.3.0', SEMANTIC_13_TO_KNOWN_FACT_14_MIGRATION_ID,
    );
    const archive = archiveByKey.get(archiveKey);
    if (archive) encounteredArchives.add(archiveKey);

    if (plan.kind === 'ready') {
      valid13Candidates++;
      if (!archive) {
        archivesToCreateOnFutureMigration++;
        continue;
      }
      try {
        if (canonicalizeJson(archive.value) !== plan.fingerprint) {
          findings.push(makeFinding('session', index, 'ARCHIVE_CONFLICT'));
        } else archived13Candidates++;
      } catch {
        findings.push(makeFinding('session', index, 'ARCHIVE_CONFLICT'));
      }
      continue;
    }

    validated14Rows++;
    if (!archive) {
      findings.push(makeFinding('session', index, 'ARCHIVE_REQUIRED'));
      continue;
    }
    let replay: Awaited<ReturnType<typeof planKnownFactMigration>>;
    try { replay = await planKnownFactMigration(archive.value); }
    catch {
      findings.push(makeFinding('session', index, 'ARCHIVE_REPLAY_INVALID'));
      continue;
    }
    if (replay.kind !== 'ready' || replay.session.sessionId !== sessionKey) {
      findings.push(makeFinding('session', index, 'ARCHIVE_REPLAY_INVALID'));
      continue;
    }
    try {
      if (canonicalizeJson(replay.session) !== canonicalizeJson(plan.session)) {
        findings.push(makeFinding('session', index, 'ARCHIVE_REPLAY_MISMATCH'));
      } else verified14ArchiveReplays++;
    } catch {
      findings.push(makeFinding('session', index, 'ARCHIVE_REPLAY_INVALID'));
    }
  }

  return {
    format: ACTIVATION_PREFLIGHT_FORMAT,
    disposition: findings.length > 0 ? 'BLOCKED' : 'INSPECTION_PASS',
    activationAuthorized: false,
    externalBackupVerified: false,
    snapshotOnly: true,
    counts: {
      sessions: sessions.length,
      archives: archives.length,
      valid13Candidates,
      archived13Candidates,
      archivesToCreateOnFutureMigration,
      validated14Rows,
      verified14ArchiveReplays,
      unrelatedArchivesPreserved: archiveByKey.size - encounteredArchives.size,
      blocked: findings.length,
    },
    findings,
  };
}

/**
 * Read-only audit on a caller-supplied existing connection.
 * DB name/layout assertion prevents accidental use on the separate trial DB.
 * Never calls indexedDB.open, creates stores, mutates sessions or archives,
 * or returns any raw records. All requests are enqueued synchronously.
 */
export async function inspectKnownFact14ActivationDatabaseForReview(
  db: IDBDatabase,
): Promise<KnownFactActivationPreflight14> {
  if (db.name !== ACTIVATION_PREFLIGHT_DB_NAME
    || db.version !== INDEXED_DB_LAYOUT_VERSION
    || ['sessions', 'legacy-session-archive', 'revision-history']
      .some(name => !db.objectStoreNames.contains(name))) {
    return evaluateKnownFact14ActivationSnapshotForReview(null);
  }
  const tx = db.transaction(['sessions', 'legacy-session-archive'], 'readonly');
  const sessionStore = tx.objectStore('sessions');
  const archiveStore = tx.objectStore('legacy-session-archive');
  const rawSessionKeys = sessionStore.getAllKeys();
  const rawSessions = sessionStore.getAll();
  const rawArchiveKeys = archiveStore.getAllKeys();
  const rawArchives = archiveStore.getAll();
  const settled = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('Read-only preflight aborted.'));
    tx.onerror = () => reject(tx.error ?? new Error('Read-only preflight failed.'));
  });
  const read = <T>(request: IDBRequest<T>): Promise<T> => new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Read-only preflight request failed.'));
  });
  const [sessionKeys, sessionValues, archiveKeys, archiveValues] = await Promise.all([
    read(rawSessionKeys), read(rawSessions), read(rawArchiveKeys), read(rawArchives),
  ]);
  await settled;
  if (sessionKeys.length !== sessionValues.length || archiveKeys.length !== archiveValues.length) {
    return evaluateKnownFact14ActivationSnapshotForReview(null);
  }
  return evaluateKnownFact14ActivationSnapshotForReview({
    sessions: sessionKeys.map((item, index) => ({ key: item, value: sessionValues[index] })),
    archives: archiveKeys.map((item, index) => ({ key: item, value: archiveValues[index] })),
  });
}

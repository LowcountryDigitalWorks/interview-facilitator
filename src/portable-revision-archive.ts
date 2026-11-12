/** Synthetic-only portable container for already-retained 1.3 session revisions.
 * This contract is not encryption, authentication, tamper-proof storage or backup.
 */

export const PORTABLE_REVISION_ARCHIVE_FORMAT = 'ldw-interview-revision-archive' as const;
export const PORTABLE_REVISION_ARCHIVE_VERSION = 1 as const;
export const PORTABLE_REVISION_ARCHIVE_MAX_BYTES = 5 * 1024 * 1024;
export const PORTABLE_REVISION_ARCHIVE_MAX_REVISIONS = 200;
export const PORTABLE_REVISION_ARCHIVE_MAX_RECORD_BYTES = 1024 * 1024;
export const PORTABLE_REVISION_ARCHIVE_MAX_JSON_DEPTH = 64;
export const PORTABLE_REVISION_SESSION_SCHEMA = '1.3.0' as const;

export type LineageStatus =
  | 'complete-to-root'
  | 'missing-ancestor'
  | 'unlinked-revisions'
  | 'missing-and-unlinked';

export interface PortableRevision {
  revisionId: string;
  parentRevisionId: string | null;
  updatedAt: string;
  record: unknown;
}

export interface PortableRevisionArchive {
  format: typeof PORTABLE_REVISION_ARCHIVE_FORMAT;
  archiveSchemaVersion: typeof PORTABLE_REVISION_ARCHIVE_VERSION;
  sessionSchemaVersion: typeof PORTABLE_REVISION_SESSION_SCHEMA;
  sessionId: string;
  headRevisionId: string;
  createdAt: string;
  lineageStatus: LineageStatus;
  revisions: PortableRevision[];
  checksum: { algorithm: 'SHA-256'; canonicalization: 'ldw-json-c14n-v1'; digest: string };
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function fail(message: string): never {
  throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} contains missing or unsupported fields.`);
  }
}

function boundedId(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128
    || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) {
    fail(`${label} is invalid.`);
  }
}

function canonicalTimestamp(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    fail(`${label} must be a canonical UTC timestamp.`);
  }
}

function canonicalize(value: unknown, depth = 0, ancestors = new Set<object>()): string {
  if (depth > PORTABLE_REVISION_ARCHIVE_MAX_JSON_DEPTH) fail('Archive exceeds the maximum JSON depth.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('Archive contains a non-finite number.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) fail('Archive contains a circular value.');
    ancestors.add(value);
    const serialized = `[${value.map((item) => canonicalize(item, depth + 1, ancestors)).join(',')}]`;
    ancestors.delete(value);
    return serialized;
  }
  if (!isRecord(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    || Object.getOwnPropertySymbols(value).length > 0) {
    fail('Archive contains a non-JSON value.');
  }
  if (ancestors.has(value)) fail('Archive contains a circular value.');
  ancestors.add(value);
  const keys = Object.keys(value).sort();
  const serialized = `{${keys.map((key) => {
    const child = value[key];
    if (child === undefined) fail('Archive contains an undefined field.');
    return `${JSON.stringify(key)}:${canonicalize(child, depth + 1, ancestors)}`;
  }).join(',')}}`;
  ancestors.delete(value);
  return serialized;
}

async function sha256(value: string): Promise<string> {
  if (!globalThis.crypto?.subtle) fail('SHA-256 is unavailable in this runtime.');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function readRevision(value: unknown, sessionId: string): PortableRevision {
  if (!isRecord(value)) fail('Archive revision is invalid.');
  exactKeys(value, ['revisionId', 'parentRevisionId', 'updatedAt', 'record'], 'Archive revision');
  boundedId(value.revisionId, 'Revision ID');
  if (value.parentRevisionId !== null) boundedId(value.parentRevisionId, 'Parent revision ID');
  canonicalTimestamp(value.updatedAt, 'Revision updatedAt');
  if (!isRecord(value.record)) fail('Archive session record is invalid.');
  // The record remains opaque here; the normal 1.3 semantic validator remains the
  // authority when an application later imports it. Bind this envelope to its identity.
  if (value.record.sessionSchemaVersion !== PORTABLE_REVISION_SESSION_SCHEMA
    || value.record.sessionId !== sessionId
    || value.record.revisionId !== value.revisionId
    || value.record.parentRevisionId !== value.parentRevisionId
    || value.record.updatedAt !== value.updatedAt) {
    fail('Archive revision identity does not match its session record.');
  }
  const encodedRecord = canonicalize(value.record);
  if (new TextEncoder().encode(encodedRecord).byteLength > PORTABLE_REVISION_ARCHIVE_MAX_RECORD_BYTES) {
    fail('Archive revision record exceeds the maximum encoded size.');
  }
  return {
    revisionId: value.revisionId,
    parentRevisionId: value.parentRevisionId as string | null,
    updatedAt: value.updatedAt,
    record: value.record,
  };
}

function deriveLineage(revisions: readonly PortableRevision[], headRevisionId: string): LineageStatus {
  const byId = new Map(revisions.map((revision) => [revision.revisionId, revision]));
  const visited = new Set<string>();
  let nextId: string | null = headRevisionId;
  let missing = false;
  while (nextId !== null) {
    if (visited.has(nextId)) fail('Archive revision lineage contains a cycle.');
    visited.add(nextId);
    const current = byId.get(nextId);
    if (!current) {
      missing = true;
      break;
    }
    if (current.parentRevisionId !== null) {
      const parent = byId.get(current.parentRevisionId);
      if (!parent) {
        missing = true;
        break;
      }
      if (Date.parse(parent.updatedAt) > Date.parse(current.updatedAt)) {
        fail('Archive parent revision is newer than its child.');
      }
    }
    nextId = current.parentRevisionId;
  }
  const unlinked = revisions.some((revision) => !visited.has(revision.revisionId));
  if (missing && unlinked) return 'missing-and-unlinked';
  if (missing) return 'missing-ancestor';
  if (unlinked) return 'unlinked-revisions';
  return 'complete-to-root';
}

function archiveBody(value: Omit<PortableRevisionArchive, 'checksum'>): string {
  return canonicalize(value);
}

export function serializePortableRevisionArchive(archive: PortableRevisionArchive): string {
  return canonicalize(archive);
}

/** Build a deterministic checksum envelope over already-retained synthetic 1.3 records. */
export async function createPortableRevisionArchive(input: {
  sessionId: string;
  headRevisionId: string;
  createdAt: string;
  revisions: readonly unknown[];
}): Promise<PortableRevisionArchive> {
  boundedId(input.sessionId, 'Session ID');
  boundedId(input.headRevisionId, 'Head revision ID');
  canonicalTimestamp(input.createdAt, 'Archive createdAt');
  if (!Array.isArray(input.revisions) || input.revisions.length === 0
    || input.revisions.length > PORTABLE_REVISION_ARCHIVE_MAX_REVISIONS) {
    fail('Archive revision count is outside the allowed range.');
  }
  const revisions = input.revisions.map((row) => readRevision(row, input.sessionId));
  const byId = new Map<string, PortableRevision>();
  for (const revision of revisions) {
    if (byId.has(revision.revisionId)) fail('Archive contains duplicate or conflicting revision IDs.');
    byId.set(revision.revisionId, revision);
    if (Date.parse(revision.updatedAt) > Date.parse(input.createdAt)) {
      fail('Archive creation time precedes a retained revision.');
    }
  }
  if (!byId.has(input.headRevisionId)) fail('Archive head revision is not included.');
  revisions.sort((left, right) => left.updatedAt.localeCompare(right.updatedAt)
    || left.revisionId.localeCompare(right.revisionId));
  const body = {
    format: PORTABLE_REVISION_ARCHIVE_FORMAT,
    archiveSchemaVersion: PORTABLE_REVISION_ARCHIVE_VERSION,
    sessionSchemaVersion: PORTABLE_REVISION_SESSION_SCHEMA,
    sessionId: input.sessionId,
    headRevisionId: input.headRevisionId,
    createdAt: input.createdAt,
    lineageStatus: deriveLineage(revisions, input.headRevisionId),
    revisions,
  } as const;
  const archive: PortableRevisionArchive = {
    ...body,
    checksum: { algorithm: 'SHA-256', canonicalization: 'ldw-json-c14n-v1', digest: await sha256(archiveBody(body)) },
  };
  if (new TextEncoder().encode(canonicalize(archive)).byteLength > PORTABLE_REVISION_ARCHIVE_MAX_BYTES) {
    fail('Archive exceeds the maximum encoded size.');
  }
  return archive;
}

/** Parse and validate only the portable contract; this does not restore application state. */
export async function validatePortableRevisionArchiveJson(json: string): Promise<PortableRevisionArchive> {
  if (typeof json !== 'string' || new TextEncoder().encode(json).byteLength > PORTABLE_REVISION_ARCHIVE_MAX_BYTES) {
    fail('Archive input exceeds the maximum encoded size.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    fail('Archive JSON is malformed.');
  }
  if (json !== canonicalize(parsed)) fail('Archive JSON is not in canonical form.');
  if (!isRecord(parsed)) fail('Archive envelope is invalid.');
  exactKeys(parsed, ['format', 'archiveSchemaVersion', 'sessionSchemaVersion', 'sessionId',
    'headRevisionId', 'createdAt', 'lineageStatus', 'revisions', 'checksum'], 'Archive envelope');
  if (parsed.format !== PORTABLE_REVISION_ARCHIVE_FORMAT
    || parsed.archiveSchemaVersion !== PORTABLE_REVISION_ARCHIVE_VERSION
    || parsed.sessionSchemaVersion !== PORTABLE_REVISION_SESSION_SCHEMA) {
    fail('Archive format or version is unsupported.');
  }
  boundedId(parsed.sessionId, 'Session ID');
  boundedId(parsed.headRevisionId, 'Head revision ID');
  canonicalTimestamp(parsed.createdAt, 'Archive createdAt');
  if (!Array.isArray(parsed.revisions) || parsed.revisions.length === 0
    || parsed.revisions.length > PORTABLE_REVISION_ARCHIVE_MAX_REVISIONS) {
    fail('Archive revision count is outside the allowed range.');
  }
  const revisions = parsed.revisions.map((row) => readRevision(row, parsed.sessionId as string));
  const byId = new Map<string, PortableRevision>();
  for (const revision of revisions) {
    if (byId.has(revision.revisionId)) fail('Archive contains duplicate or conflicting revision IDs.');
    byId.set(revision.revisionId, revision);
    if (Date.parse(revision.updatedAt) > Date.parse(parsed.createdAt as string)) {
      fail('Archive creation time precedes a retained revision.');
    }
  }
  if (!byId.has(parsed.headRevisionId as string)) fail('Archive head revision is not included.');
  const sorted = [...revisions].sort((left, right) => left.updatedAt.localeCompare(right.updatedAt)
    || left.revisionId.localeCompare(right.revisionId));
  if (sorted.some((revision, index) => revision.revisionId !== revisions[index]?.revisionId)) {
    fail('Archive revisions are not in canonical chronology order.');
  }
  const lineageStatus = deriveLineage(revisions, parsed.headRevisionId as string);
  if (parsed.lineageStatus !== lineageStatus) fail('Archive lineage declaration is inconsistent.');
  if (!isRecord(parsed.checksum) || parsed.checksum.algorithm !== 'SHA-256'
    || parsed.checksum.canonicalization !== 'ldw-json-c14n-v1'
    || typeof parsed.checksum.digest !== 'string' || !/^[0-9a-f]{64}$/.test(parsed.checksum.digest)) {
    fail('Archive checksum metadata is invalid.');
  }
  const { checksum: _checksum, ...body } = parsed as unknown as PortableRevisionArchive;
  if (await sha256(archiveBody(body)) !== parsed.checksum.digest) fail('Archive checksum does not match its contents.');
  return parsed as unknown as PortableRevisionArchive;
}


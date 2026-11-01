import {
  assemblePinnedSession,
  validateSessionForPack,
  validateSessionShape,
  type InterviewPack,
  type InterviewPackSnapshot,
  type InterviewSession,
  type PackIdentity,
} from './domain';

const textEncoder = new TextEncoder();

export function canonicalizeJson(value: unknown): string {
  return serializeCanonical(value);
}

function serializeCanonical(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Canonical JSON does not support non-finite numbers.');
    return JSON.stringify(value);
  }
  if (typeof value === 'undefined' || typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') {
    throw new Error('Canonical JSON does not support this value.');
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => serializeCanonical(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error('Canonical JSON does not support this object.');
    if (Object.getOwnPropertySymbols(value).length > 0) throw new Error('Canonical JSON does not support this object.');
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const entries = keys.map((key) => {
      if (record[key] === undefined) throw new Error('Canonical JSON does not support undefined object fields.');
      return `${JSON.stringify(key)}:${serializeCanonical(record[key])}`;
    });
    return `{${entries.join(',')}}`;
  }
  throw new Error('Canonical JSON does not support this value.');
}

export async function sha256Hex(value: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('Pack identity requires Web Crypto in a secure context (HTTPS or localhost). Plain HTTP on a LAN device cannot compute the pack digest.');
  const digest = await subtle.digest('SHA-256', textEncoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function snapshotPack(pack: InterviewPack): InterviewPackSnapshot {
  return {
    packSchemaVersion: pack.packSchemaVersion,
    packId: pack.packId,
    packVersion: pack.packVersion,
    title: pack.title,
    description: pack.description,
    sections: structuredClone(pack.sections),
    questions: structuredClone(pack.questions),
    knownFacts: structuredClone(pack.knownFacts),
  };
}

export async function pinPackSnapshot(pack: InterviewPack): Promise<{ packSnapshot: InterviewPackSnapshot; packIdentity: PackIdentity }> {
  const packSnapshot = snapshotPack(pack);
  const digest = await sha256Hex(canonicalizeJson(packSnapshot));
  return {
    packSnapshot,
    packIdentity: { algorithm: 'SHA-256', canonicalization: 'ldw-json-c14n-v1', digest },
  };
}

export async function createPinnedSession(
  pack: InterviewPack,
  input: { clientLabel: string; interviewerLabel?: string; interviewMode?: string },
  now = new Date(),
): Promise<InterviewSession> {
  const pinned = await pinPackSnapshot(pack);
  return assemblePinnedSession(pinned.packSnapshot, pinned.packIdentity, input, now);
}

export async function assertPackIdentity(session: InterviewSession): Promise<void> {
  const digest = await sha256Hex(canonicalizeJson(session.packSnapshot));
  if (digest !== session.packIdentity.digest) throw new Error('Pack snapshot does not match its identity digest.');
}

export async function validateSessionRecord(value: unknown): Promise<InterviewSession> {
  const session = validateSessionShape(value);
  validateSessionForPack(session);
  await assertPackIdentity(session);
  return session;
}

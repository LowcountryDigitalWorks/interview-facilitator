import { canonicalizeJson } from './pack-identity';
import { validateSemanticSessionRecord } from './semantic-session';

/**
 * Read-only local verification of a manual 1.3 single-session JSON export.
 * Does not import, write, archive, decrypt, upload, or certify recovery.
 * Display messages are static and deliberately reveal no file/session content.
 */
export const SESSION_FILE_CHECK_MAX_BYTES = 5 * 1024 * 1024;

export type LocalSessionFileCheckKind =
  | 'invalid'
  | 'valid-match'
  | 'valid-different'
  | 'valid-no-local'
  | 'valid-local-unavailable';

export interface LocalSessionFileCheck {
  kind: LocalSessionFileCheckKind;
  message: string;
}

const outcomes: Readonly<Record<LocalSessionFileCheckKind, string>> = {
  invalid: 'The selected file did not pass the 1.3 single-session JSON and size checks. No data was imported or changed.',
  'valid-match': 'Valid 1.3 single-session JSON. Its full canonical content matches the saved session on this device at the time checked. No data was imported or changed.',
  'valid-different': 'Valid 1.3 single-session JSON, but its full content differs from the copy currently saved on this device. It may be an older or divergent revision. No data was imported or changed.',
  'valid-no-local': 'Valid 1.3 single-session JSON. No session with that identity is saved in this browser context to compare. No data was imported or changed.',
  'valid-local-unavailable': 'Valid 1.3 single-session JSON, but the saved local copy could not be verified. Do not infer a match. No data was imported or changed.',
};

function outcome(kind: LocalSessionFileCheckKind): LocalSessionFileCheck {
  return { kind, message: outcomes[kind] };
}

/**
 * Use a read-only local session loader. Never call a save/import adapter.
 * A matching JSON copy is not proof of off-device retention, completeness of
 * revision history, recovery-key custody, or protection against file tampering.
 */
export async function checkLocalSessionJsonForReview(
  file: Pick<File, 'size' | 'text'>,
  loadCurrent: (sessionId: string) => Promise<unknown>,
): Promise<LocalSessionFileCheck> {
  if (!file || !Number.isSafeInteger(file.size)
    || file.size < 1 || file.size > SESSION_FILE_CHECK_MAX_BYTES) {
    return outcome('invalid');
  }

  let session: Awaited<ReturnType<typeof validateSemanticSessionRecord>>;
  try {
    const text = await file.text();
    if (new TextEncoder().encode(text).byteLength > SESSION_FILE_CHECK_MAX_BYTES) {
      return outcome('invalid');
    }
    const raw: unknown = JSON.parse(text);
    session = await validateSemanticSessionRecord(raw);
    // Reject input that the canonical validator would silently discard or
    // normalize: an exported session must compare as the complete data object.
    if (canonicalizeJson(raw) !== canonicalizeJson(session)) {
      return outcome('invalid');
    }
  } catch {
    return outcome('invalid');
  }

  try {
    const saved = await loadCurrent(session.sessionId);
    if (saved === undefined) return outcome('valid-no-local');
    const checked = await validateSemanticSessionRecord(saved);
    return outcome(canonicalizeJson(checked) === canonicalizeJson(session)
      ? 'valid-match' : 'valid-different');
  } catch {
    // A malformed local row or storage denial is not evidence of no local data.
    return outcome('valid-local-unavailable');
  }
}

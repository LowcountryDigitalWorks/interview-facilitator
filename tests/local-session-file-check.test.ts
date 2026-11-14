import { describe, expect, it } from 'vitest';
import { generalDiscoveryPack } from '../src/pack';
import { createSemanticSession } from '../src/semantic-session';
import {
  SESSION_FILE_CHECK_MAX_BYTES,
  checkLocalSessionJsonForReview,
} from '../src/local-session-file-check';

async function fixture() {
  const session = await createSemanticSession(generalDiscoveryPack, {
    clientLabel: 'SYNTHETIC BOUNDED FILE CHECK',
  }, new Date('2026-11-13T19:00:00.000Z'));
  session.runningNotes = 'SYNTHETIC SECRET NEVER DISPLAYED';
  return session;
}

function localFile(data: string | Uint8Array, claimedSize?: number) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return {
    size: claimedSize ?? bytes.byteLength,
    arrayBuffer: async () => Uint8Array.from(bytes).buffer,
  };
}

describe('read-only 1.3 JSON file preflight', () => {
  it('distinguishes an exact canonical match, missing saved copy and divergent copy without writes', async () => {
    const session = await fixture();
    const file = localFile(JSON.stringify(session));
    let reads = 0;
    const matched = await checkLocalSessionJsonForReview(file, async id => {
      reads++;
      expect(id).toBe(session.sessionId);
      return structuredClone(session);
    });
    expect(matched.kind).toBe('valid-match');
    expect(matched.message).not.toContain('SYNTHETIC');
    expect(reads).toBe(1);
    expect((await checkLocalSessionJsonForReview(file, async () => undefined)).kind)
      .toBe('valid-no-local');
    const changed = structuredClone(session);
    changed.runningNotes = 'SYNTHETIC DIFFERENT COPY';
    const diff = await checkLocalSessionJsonForReview(file, async () => changed);
    expect(diff.kind).toBe('valid-different');
    expect(diff.message).not.toContain(session.clientLabel);
  });

  it('fails closed on bad bytes, unsupported schema, extra fields and lossy canonicalization without reading storage', async () => {
    const valid = await fixture();
    let reads = 0;
    const loader = async () => { reads++; return valid; };
    const variants = [
      localFile('', 0),
      localFile('not JSON'),
      localFile(JSON.stringify({ ...valid, sessionSchemaVersion: '1.4.0' })),
      localFile(JSON.stringify({ ...valid, unsupportedField: '<script>secret</script>' })),
      localFile(JSON.stringify(valid), SESSION_FILE_CHECK_MAX_BYTES + 1),
      // File.size is an untrusted hint: enforce the actual byte length too.
      localFile(' '.repeat(SESSION_FILE_CHECK_MAX_BYTES + 1), 1),
      localFile(JSON.stringify(valid), Number.NaN),
    ];
    for (const candidate of variants) {
      const check = await checkLocalSessionJsonForReview(candidate, loader);
      expect(check.kind).toBe('invalid');
      expect(check.message).not.toContain('script');
    }
    expect(reads).toBe(0);
  });

  it('rejects malformed UTF-8 inside otherwise valid session JSON rather than silently replacing it', async () => {
    const valid = await fixture();
    const source = JSON.stringify(valid);
    const needle = 'SYNTHETIC SECRET NEVER DISPLAYED';
    const parts = source.split(needle);
    expect(parts).toHaveLength(2);
    const encoder = new TextEncoder();
    const malformedBytes = Uint8Array.from([
      ...encoder.encode(parts[0]!),
      0xff, // Not valid UTF-8; Blob.text() would substitute U+FFFD.
      ...encoder.encode(parts[1]!),
    ]);
    let reads = 0;
    const check = await checkLocalSessionJsonForReview(
      localFile(malformedBytes),
      async () => { reads++; return valid; },
    );
    expect(check.kind).toBe('invalid');
    expect(check.message).not.toContain(needle);
    expect(reads).toBe(0);
    // A naive nonfatal decoder would have transformed this into parseable JSON.
    const lossy = new TextDecoder('utf-8').decode(malformedBytes);
    expect(JSON.parse(lossy)).toMatchObject({
      runningNotes: String.fromCharCode(0xfffd),
    });
  });

  it('distinguishes unreadable local storage from a nonexistent matching session', async () => {
    const session = await fixture();
    const result = await checkLocalSessionJsonForReview(localFile(JSON.stringify(session)),
      async () => { throw new Error('SYNTHETIC STORAGE SECRET SHOULD NOT LEAK'); });
    expect(result.kind).toBe('valid-local-unavailable');
    expect(result.message).not.toContain('SYNTHETIC');
    expect(result.message).toContain('could not be verified');
  });
});

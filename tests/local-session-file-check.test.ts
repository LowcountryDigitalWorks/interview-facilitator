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

function localFile(text: string, size = new TextEncoder().encode(text).byteLength) {
  return { size, text: async () => text };
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
      // File.size is an untrusted hint: also reject oversized decoded contents.
      localFile(' '.repeat(SESSION_FILE_CHECK_MAX_BYTES + 1), 1),
      { size: Number.NaN, text: async () => JSON.stringify(valid) },
    ];
    for (const candidate of variants) {
      const check = await checkLocalSessionJsonForReview(candidate, loader);
      expect(check.kind).toBe('invalid');
      expect(check.message).not.toContain('script');
    }
    expect(reads).toBe(0);
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

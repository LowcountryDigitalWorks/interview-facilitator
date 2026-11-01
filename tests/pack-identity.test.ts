import { afterEach, describe, expect, it, vi } from 'vitest';
import { sessionPack, validateSessionForPack, validateSessionShape, visibleQuestions } from '../src/domain';
import { serializeSession, sessionToMarkdown } from '../src/markdown';
import { generalDiscoveryPack as pack } from '../src/pack';
import { assertPackIdentity, canonicalizeJson, createPinnedSession, sha256Hex, validateSessionRecord } from '../src/pack-identity';

describe('pinned pack identity', () => {
  it('canonicalizes the same object regardless of property insertion order', async () => {
    const first = { b: 1, a: { d: true, c: [1, { z: 'q', y: null }] } };
    const second = { a: { c: [1, { y: null, z: 'q' }], d: true }, b: 1 };
    expect(canonicalizeJson(first)).toBe(canonicalizeJson(second));
    expect(await sha256Hex(canonicalizeJson(first))).toBe(await sha256Hex(canonicalizeJson(second)));
  });

  it('changes the digest when question order, options, prompt, or a condition changes', async () => {
    const session = await createPinnedSession(pack, { clientLabel: 'Synthetic Client' }, new Date('2026-10-31T12:00:00.000Z'));
    const baseline = session.packIdentity.digest;
    const reordered = structuredClone(session.packSnapshot);
    const [first, second] = reordered.questions;
    reordered.questions[0] = second!;
    reordered.questions[1] = first!;
    expect(await sha256Hex(canonicalizeJson(reordered))).not.toBe(baseline);

    const promptChanged = structuredClone(session.packSnapshot);
    promptChanged.questions[0]!.prompt = 'A different historical prompt';
    expect(await sha256Hex(canonicalizeJson(promptChanged))).not.toBe(baseline);

    const optionsChanged = structuredClone(session.packSnapshot);
    const choice = optionsChanged.questions.find((question) => question.id === 'needs-booking');
    choice!.options = ['No', 'Yes', 'Not sure'];
    expect(await sha256Hex(canonicalizeJson(optionsChanged))).not.toBe(baseline);

    const conditionChanged = structuredClone(session.packSnapshot);
    const conditional = conditionChanged.questions.find((question) => question.id === 'booking-process');
    conditional!.condition = { questionId: 'needs-booking', equals: 'No' };
    expect(await sha256Hex(canonicalizeJson(conditionChanged))).not.toBe(baseline);
  });

  it('pins one structured snapshot and keeps interpreting that snapshot after the embedded pack changes', async () => {
    const source = structuredClone(pack);
    const session = await createPinnedSession(source, { clientLabel: 'Synthetic Client' }, new Date('2026-10-31T12:00:00.000Z'));
    const pinnedPrompt = session.packSnapshot.questions[0]?.prompt;
    source.questions[0]!.prompt = 'Changed after pinning';
    source.questions.reverse();
    expect(session.packSnapshot.questions[0]?.prompt).toBe(pinnedPrompt);
    expect(sessionPack(session)).toBe(session.packSnapshot);
    expect(visibleQuestions(sessionPack(session), session)[0]?.prompt).toBe(pinnedPrompt);
    expect(sessionToMarkdown(session)).toContain(pinnedPrompt!);
    expect(sessionToMarkdown(session)).not.toContain('Changed after pinning');
    const embeddedPrompt = pack.questions[0]!.prompt;
    pack.questions[0]!.prompt = 'Embedded pack changed';
    try {
      expect(visibleQuestions(sessionPack(session), session)[0]?.prompt).toBe(pinnedPrompt);
      expect(sessionToMarkdown(session)).not.toContain('Embedded pack changed');
    } finally {
      pack.questions[0]!.prompt = embeddedPrompt;
    }
    await expect(assertPackIdentity(session)).resolves.toBeUndefined();
  });

  it('fails closed when the snapshot or digest is tampered', async () => {
    const session = await createPinnedSession(pack, { clientLabel: 'Synthetic Client' }, new Date('2026-10-31T12:00:00.000Z'));
    const snapshotTamper = structuredClone(session);
    snapshotTamper.packSnapshot.questions[0]!.prompt = 'Tampered prompt';
    await expect(assertPackIdentity(snapshotTamper)).rejects.toThrow(/digest/i);
    await expect(validateSessionRecord(snapshotTamper)).rejects.toThrow(/digest/i);

    const digestTamper = structuredClone(session);
    digestTamper.packIdentity.digest = 'b'.repeat(64);
    await expect(assertPackIdentity(digestTamper)).rejects.toThrow(/digest/i);
    await expect(validateSessionRecord(digestTamper)).rejects.toThrow(/digest/i);
  });

  it('preserves the snapshot and identity exactly through canonical JSON export and import', async () => {
    const session = await createPinnedSession(pack, { clientLabel: 'Synthetic Client' }, new Date('2026-10-31T12:00:00.000Z'));
    session.answers['primary-goal']!.value = 'Keep the pinned pack.';
    const restored = await validateSessionRecord(JSON.parse(serializeSession(session)));
    expect(restored.packSnapshot).toEqual(session.packSnapshot);
    expect(restored.packIdentity).toEqual(session.packIdentity);
    expect(restored.sessionSchemaVersion).toBe('1.1.0');
  });

  it('rejects unsupported canonical values instead of dropping them', () => {
    expect(() => canonicalizeJson({ b: 1, a: undefined })).toThrow(/undefined/i);
    expect(() => canonicalizeJson(Number.NaN)).toThrow(/non-finite/i);
    expect(() => canonicalizeJson([undefined])).toThrow(/does not support this value/i);
    expect(() => canonicalizeJson(() => undefined)).toThrow(/does not support this value/i);
    expect(() => canonicalizeJson(Symbol('pack'))).toThrow(/does not support this value/i);
    expect(() => canonicalizeJson(10n)).toThrow(/does not support this value/i);
    expect(() => canonicalizeJson(new Date('2026-10-31T12:00:00.000Z'))).toThrow(/does not support this object/i);
  });

  it('reports a 1.0 session as legacy without inventing a snapshot', () => {
    const legacy = {
      sessionSchemaVersion: '1.0.0',
      sessionId: 'legacy-session',
      interviewPackId: pack.packId,
      interviewPackVersion: pack.packVersion,
      clientLabel: 'Legacy',
      interviewerLabel: '',
      interviewMode: 'Conversation',
      createdAt: '2026-10-31T12:00:00.000Z',
      updatedAt: '2026-10-31T12:00:00.000Z',
      currentQuestionId: 'existing-presence',
      knownFacts: [],
      answers: {},
      runningNotes: '',
    };
    expect(() => validateSessionShape(legacy)).toThrow(/legacy session schema 1\.0\.0/i);
    expect(() => validateSessionShape(legacy)).toThrow(/not migrated or deleted/i);
  });

  it('rejects duplicate or dangling snapshot references', async () => {
    const session = await createPinnedSession(pack, { clientLabel: 'Synthetic Client' }, new Date('2026-10-31T12:00:00.000Z'));
    const duplicateSection = structuredClone(session);
    duplicateSection.packSnapshot.sections.push(structuredClone(duplicateSection.packSnapshot.sections[0]!));
    expect(() => validateSessionForPack(duplicateSection)).toThrow(/duplicate section/i);

    const duplicateQuestion = structuredClone(session);
    duplicateQuestion.packSnapshot.questions.push(structuredClone(duplicateQuestion.packSnapshot.questions[0]!));
    expect(() => validateSessionForPack(duplicateQuestion)).toThrow(/duplicate question/i);

    const unknownSection = structuredClone(session);
    unknownSection.packSnapshot.questions[0]!.sectionId = 'missing-section';
    expect(() => validateSessionForPack(unknownSection)).toThrow(/unknown section/i);

    const unknownCondition = structuredClone(session);
    unknownCondition.packSnapshot.questions[1]!.condition = { questionId: 'missing-question', equals: 'Yes' };
    expect(() => validateSessionForPack(unknownCondition)).toThrow(/unknown question/i);
  });

  it('rejects a single-choice question with missing or empty options', async () => {
    const session = await createPinnedSession(pack, { clientLabel: 'Synthetic Client' }, new Date('2026-10-31T12:00:00.000Z'));
    expect(() => validateSessionForPack(session)).not.toThrow();
    const choice = session.packSnapshot.questions.find((question) => question.kind === 'single');
    expect(choice?.options?.length).toBeGreaterThan(0);

    const missing = structuredClone(session);
    const missingChoice = missing.packSnapshot.questions.find((question) => question.kind === 'single');
    delete missingChoice!.options;
    expect(() => validateSessionForPack(missing)).toThrow(/non-empty options/i);
    expect(() => validateSessionShape(missing)).toThrow(/non-empty options/i);

    const empty = structuredClone(session);
    const emptyChoice = empty.packSnapshot.questions.find((question) => question.kind === 'single');
    emptyChoice!.options = [];
    expect(() => validateSessionForPack(empty)).toThrow(/non-empty options/i);

    const nonString = structuredClone(session);
    const nonStringChoice = nonString.packSnapshot.questions.find((question) => question.kind === 'single');
    nonStringChoice!.options = ['Yes', 1 as unknown as string];
    expect(() => validateSessionShape(nonString)).toThrow(/options are invalid/i);
  });

  it('rejects a condition that refers to its own question', async () => {
    const session = await createPinnedSession(pack, { clientLabel: 'Synthetic Client' }, new Date('2026-10-31T12:00:00.000Z'));
    const self = structuredClone(session);
    const conditional = self.packSnapshot.questions.find((question) => question.id === 'booking-process');
    conditional!.condition = { questionId: 'booking-process', equals: 'Yes' };
    expect(() => validateSessionForPack(self)).toThrow(/own question/i);
  });
});

describe('pack digest secure context', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('names HTTPS or localhost when Web Crypto is unavailable', async () => {
    vi.stubGlobal('crypto', {});
    await expect(sha256Hex('{}')).rejects.toThrow(/secure context \(HTTPS or localhost\)/i);
    await expect(sha256Hex('{}')).rejects.toThrow(/plain HTTP on a LAN device/i);
  });
});

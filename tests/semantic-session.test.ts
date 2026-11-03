import { describe, expect, it } from 'vitest';
import { canonicalizeJson, createPinnedSession, sha256Hex } from '../src/pack-identity';
import { generalDiscoveryPack } from '../src/pack';
import { EFFECTIVE_EVIDENCE_EQUALS_V2 } from '../src/coverage-rules';
import {
  createSemanticSession,
  migratePinned12To13,
  PINNED_12_TO_13_MIGRATION_ID,
  planSemanticMigration,
  SEMANTIC_SESSION_SCHEMA_VERSION,
  validateSemanticSessionRecord,
  type SemanticInterviewSession,
} from '../src/semantic-session';

async function source12() {
  return createPinnedSession(generalDiscoveryPack, { clientLabel: 'Synthetic Client' }, new Date('2026-11-02T12:00:00.000Z'));
}

async function current13(): Promise<SemanticInterviewSession> {
  return migratePinned12To13(await source12());
}

async function recomputePackIdentity(session: SemanticInterviewSession): Promise<void> {
  session.packIdentity.digest = await sha256Hex(canonicalizeJson(session.packSnapshot));
}

describe('semantic session 1.3 migration', () => {
  it('pins v2 semantics, advances deterministic lineage, preserves metadata, and leaves the 1.2 source unchanged', async () => {
    const source = await source12();
    source.runningNotes = 'Synthetic retained notes';
    source.answers['primary-goal']!.note = 'Internal note';
    source.knownFacts.push({ id: 'synthetic-fact', label: 'Synthetic fact', value: 'Known value', provenance: 'Synthetic test' });
    const before = canonicalizeJson(source);
    const first = await migratePinned12To13(source);
    const second = await migratePinned12To13(structuredClone(source));

    expect(canonicalizeJson(source)).toBe(before);
    expect(first.sessionSchemaVersion).toBe(SEMANTIC_SESSION_SCHEMA_VERSION);
    expect(first.packSnapshot.ruleSemanticsVersion).toBe(EFFECTIVE_EVIDENCE_EQUALS_V2);
    expect(first.parentRevisionId).toBe(source.revisionId);
    expect(first.revisionId).toBe(`migration:${source.revisionId}:${PINNED_12_TO_13_MIGRATION_ID}`);
    expect(first.sessionId).toBe(source.sessionId);
    expect(first.createdAt).toBe(source.createdAt);
    expect(first.updatedAt).toBe(source.updatedAt);
    expect(first.clientLabel).toBe(source.clientLabel);
    expect(first.interviewerLabel).toBe(source.interviewerLabel);
    expect(first.interviewMode).toBe(source.interviewMode);
    expect(first.currentQuestionId).toBe(source.currentQuestionId);
    expect(first.knownFacts).toEqual(source.knownFacts);
    expect(first.runningNotes).toBe(source.runningNotes);
    expect(first.answers['primary-goal']!.note).toBe('Internal note');
    expect(canonicalizeJson(first)).toBe(canonicalizeJson(second));

    const v1Equivalent = structuredClone(first.packSnapshot) as unknown as { ruleSemanticsVersion: string };
    v1Equivalent.ruleSemanticsVersion = 'condition-equals-v1';
    expect(v1Equivalent).toEqual(source.packSnapshot);
    expect(first.packIdentity.digest).toBe(await sha256Hex(canonicalizeJson(first.packSnapshot)));
    expect(first.packIdentity.digest).not.toBe(source.packIdentity.digest);
  });

  it.each([
    ['null status retained raw', 'existing-presence', 'Unclassified', null, 'unresolved', null, false],
    ['ANSWERED blank', 'existing-presence', '', 'ANSWERED', 'unresolved', null, false],
    ['ANSWERED whitespace', 'existing-presence', '   ', 'ANSWERED', 'unresolved', null, false],
    ['ANSWERED meaningful', 'existing-presence', 'Current site', 'ANSWERED', 'captured', 'client-statement', false],
    ['ALREADY_KNOWN meaningful', 'existing-presence', 'Known context', 'ALREADY_KNOWN', 'captured', null, true],
    ['ALREADY_KNOWN blank', 'existing-presence', '   ', 'ALREADY_KNOWN', 'unresolved', null, true],
    ['MUST_CONFIRM meaningful', 'existing-presence', 'Tentative', 'MUST_CONFIRM', 'captured', null, true],
    ['MUST_CONFIRM blank', 'existing-presence', '', 'MUST_CONFIRM', 'unresolved', null, true],
    ['SKIP retained', 'existing-presence', 'Retained', 'SKIP', 'deferred', null, false],
    ['N_A retained', 'existing-presence', 'Retained', 'N_A', 'not-applicable', null, false],
    ['invalid single ANSWERED', 'needs-booking', 'Maybe later', 'ANSWERED', 'unresolved', null, false],
  ] as const)('projects %s conservatively', async (_label, questionId, value, status, resolution, source, needsConfirmation) => {
    const input = await source12();
    input.answers[questionId] = { value, status, note: `note:${questionId}` };
    const migrated = await migratePinned12To13(input);
    expect(migrated.answers[questionId]).toEqual({
      value,
      resolution,
      source,
      needsConfirmation,
      confirmation: null,
      followUp: null,
      note: `note:${questionId}`,
    });
  });

  it('does not invent accepted-known-fact provenance, confirmation events, or follow-up metadata', async () => {
    const input = await source12();
    input.answers['existing-presence'] = { value: 'Known context', status: 'ALREADY_KNOWN', note: '' };
    const migrated = await migratePinned12To13(input);
    expect(migrated.answers['existing-presence']).toMatchObject({
      resolution: 'captured',
      source: null,
      needsConfirmation: true,
      confirmation: null,
      followUp: null,
    });
  });

  it('rejects an invalid 1.2 source before conversion and does not mutate it', async () => {
    const source = await source12();
    delete source.answers['must-have'];
    const before = canonicalizeJson(source);
    const plan = await planSemanticMigration(source);
    expect(plan.kind).toBe('invalid');
    expect(canonicalizeJson(source)).toBe(before);
  });

  it('recognizes a valid 1.3 record as current without rewriting it', async () => {
    const migrated = await current13();
    const plan = await planSemanticMigration(migrated);
    expect(plan.kind).toBe('current');
    if (plan.kind === 'current') expect(canonicalizeJson(plan.session)).toBe(canonicalizeJson(migrated));
  });

  it('fails closed for future session versions and unsupported rule semantics', async () => {
    const source = await source12();
    expect(await planSemanticMigration({ ...structuredClone(source), sessionSchemaVersion: '9.0.0' })).toMatchObject({ kind: 'unsupported' });

    const wrongSourceRules = structuredClone(source) as unknown as { packSnapshot: { ruleSemanticsVersion: string }; packIdentity: { digest: string } };
    wrongSourceRules.packSnapshot.ruleSemanticsVersion = 'effective-evidence-equals-v2';
    wrongSourceRules.packIdentity.digest = await sha256Hex(canonicalizeJson(wrongSourceRules.packSnapshot));
    expect(await planSemanticMigration(wrongSourceRules)).toMatchObject({ kind: 'unsupported' });

    const wrongCurrentRules = await current13();
    (wrongCurrentRules.packSnapshot as unknown as { ruleSemanticsVersion: string }).ruleSemanticsVersion = 'future-rules';
    await recomputePackIdentity(wrongCurrentRules);
    expect(await planSemanticMigration(wrongCurrentRules)).toMatchObject({ kind: 'unsupported' });
  });

  it('requires explicit non-empty revision lineage in canonical 1.3 state', async () => {
    const missingRevision = await current13() as Partial<SemanticInterviewSession>;
    delete missingRevision.revisionId;
    await expect(validateSemanticSessionRecord(missingRevision)).rejects.toThrow(/revisionId/i);

    const emptyRevision = await current13();
    emptyRevision.revisionId = '   ';
    await expect(validateSemanticSessionRecord(emptyRevision)).rejects.toThrow(/revisionId/i);

    const missingParent = await current13() as Partial<SemanticInterviewSession>;
    delete missingParent.parentRevisionId;
    await expect(validateSemanticSessionRecord(missingParent)).rejects.toThrow(/parentRevisionId/i);

    const emptyParent = await current13();
    emptyParent.parentRevisionId = '';
    await expect(validateSemanticSessionRecord(emptyParent)).rejects.toThrow(/parentRevisionId/i);

    const nullParent = await current13();
    nullParent.parentRevisionId = null;
    await expect(validateSemanticSessionRecord(nullParent)).resolves.toBeDefined();
  });

  it('rejects unsupported fields and the legacy status field in canonical 1.3 state', async () => {
    const withTopLevelExtra = await current13() as SemanticInterviewSession & { unexpected?: string };
    withTopLevelExtra.unexpected = 'nope';
    await expect(validateSemanticSessionRecord(withTopLevelExtra)).rejects.toThrow(/unsupported field/i);

    const withStatus = await current13() as unknown as { answers: Record<string, Record<string, unknown>> };
    withStatus.answers['primary-goal']!.status = 'ANSWERED';
    await expect(validateSemanticSessionRecord(withStatus)).rejects.toThrow(/unsupported field/i);
  });

  it.each([42, false])('keeps persisted 1.3 value domain string/null and rejects %j', async (invalidValue) => {
    const session = await current13() as unknown as { answers: Record<string, Record<string, unknown>> };
    session.answers['primary-goal']!.value = invalidValue;
    await expect(validateSemanticSessionRecord(session)).rejects.toThrow(/string or null/i);
  });

  it('requires captured values to be meaningful for the pinned question', async () => {
    const blank = await current13();
    blank.answers['primary-goal'] = { ...blank.answers['primary-goal']!, value: '  ', resolution: 'captured', source: 'client-statement' };
    await expect(validateSemanticSessionRecord(blank)).rejects.toThrow(/meaningful value/i);

    const invalidOption = await current13();
    invalidOption.answers['needs-booking'] = { ...invalidOption.answers['needs-booking']!, value: 'Maybe later', resolution: 'captured', source: 'client-statement' };
    await expect(validateSemanticSessionRecord(invalidOption)).rejects.toThrow(/meaningful value/i);
  });

  it('strictly validates confirmation shape/value while allowing a meaningful stale snapshot to remain representable', async () => {
    const staleButValid = await current13();
    staleButValid.answers['primary-goal'] = {
      ...staleButValid.answers['primary-goal']!,
      value: 'Current goal',
      resolution: 'captured',
      source: 'client-statement',
      confirmation: { revisionId: 'rev-old', confirmedAt: '2026-11-02T12:01:00.000Z', value: 'Old goal' },
    };
    await expect(validateSemanticSessionRecord(staleButValid)).resolves.toBeDefined();

    const blankConfirmation = structuredClone(staleButValid);
    blankConfirmation.answers['primary-goal']!.confirmation!.value = '   ';
    await expect(validateSemanticSessionRecord(blankConfirmation)).rejects.toThrow(/confirmation value/i);

    const extraConfirmation = structuredClone(staleButValid) as unknown as { answers: Record<string, { confirmation: Record<string, unknown> | null }> };
    extraConfirmation.answers['primary-goal']!.confirmation!.extra = true;
    await expect(validateSemanticSessionRecord(extraConfirmation)).rejects.toThrow(/unsupported field/i);
  });

  it('strictly validates bounded follow-up metadata', async () => {
    const valid = await current13();
    valid.answers['primary-goal']!.followUp = { action: 'Confirm owner', owner: 'Interviewer', dueDate: '2026-11-03' };
    await expect(validateSemanticSessionRecord(valid)).resolves.toBeDefined();

    const blankAction = structuredClone(valid);
    blankAction.answers['primary-goal']!.followUp = { action: '   ' };
    await expect(validateSemanticSessionRecord(blankAction)).rejects.toThrow(/must not be empty/i);

    const extra = structuredClone(valid) as unknown as { answers: Record<string, { followUp: Record<string, unknown> | null }> };
    extra.answers['primary-goal']!.followUp!.workflowState = 'open';
    await expect(validateSemanticSessionRecord(extra)).rejects.toThrow(/unsupported field/i);
  });

  it.each([
    'missing-answer',
    'duplicate-question',
    'unknown-condition-target',
    'invalid-current-question',
    'pack-version-mismatch',
  ] as const)('rejects pack/question alignment failure: %s', async (failure) => {
    const session = await current13();
    if (failure === 'missing-answer') delete session.answers['must-have'];
    if (failure === 'duplicate-question') session.packSnapshot.questions.push(structuredClone(session.packSnapshot.questions[0]!));
    if (failure === 'unknown-condition-target') session.packSnapshot.questions[3]!.condition = { questionId: 'missing-parent', equals: 'Yes' };
    if (failure === 'invalid-current-question') session.currentQuestionId = 'missing-current';
    if (failure === 'pack-version-mismatch') session.interviewPackVersion = '9.9.9';
    if (failure === 'duplicate-question' || failure === 'unknown-condition-target') await recomputePackIdentity(session);
    await expect(validateSemanticSessionRecord(session)).rejects.toThrow();
  });

  it('rejects a semantic pack identity mismatch', async () => {
    const session = await current13();
    session.packIdentity.digest = '0'.repeat(64);
    await expect(validateSemanticSessionRecord(session)).rejects.toThrow(/identity digest/i);
  });

  it('creates an isolated canonical 1.3 session with v2 identity and exact answer keys', async () => {
    const inputPack = structuredClone(generalDiscoveryPack);
    const firstPrompt = inputPack.questions[0]!.prompt;
    const created = await createSemanticSession(
      inputPack,
      { clientLabel: 'Synthetic fresh session', interviewerLabel: 'Synthetic interviewer', interviewMode: 'Conversation' },
      new Date('2026-11-03T05:00:00.000Z'),
    );

    expect(created.sessionSchemaVersion).toBe(SEMANTIC_SESSION_SCHEMA_VERSION);
    expect(created.packSnapshot.ruleSemanticsVersion).toBe(EFFECTIVE_EVIDENCE_EQUALS_V2);
    expect(created.parentRevisionId).toBeNull();
    expect(created.createdAt).toBe('2026-11-03T05:00:00.000Z');
    expect(Object.keys(created.answers).sort()).toEqual(created.packSnapshot.questions.map((question) => question.id).sort());
    for (const answer of Object.values(created.answers)) {
      expect(answer).toMatchObject({
        value: null,
        resolution: 'unresolved',
        source: null,
        needsConfirmation: false,
        confirmation: null,
        followUp: null,
        note: '',
      });
    }

    const expectedV2Digest = await sha256Hex(canonicalizeJson(created.packSnapshot));
    const v1Snapshot = { ...structuredClone(created.packSnapshot), ruleSemanticsVersion: 'condition-equals-v1' as const };
    const v1Digest = await sha256Hex(canonicalizeJson(v1Snapshot));
    expect(created.packIdentity).toEqual({
      algorithm: 'SHA-256',
      canonicalization: 'ldw-json-c14n-v1',
      digest: expectedV2Digest,
    });
    expect(created.packIdentity.digest).not.toBe(v1Digest);

    inputPack.questions[0]!.prompt = 'Mutated caller-owned prompt';
    inputPack.knownFacts[0]!.value = 'Mutated caller-owned fact';
    expect(created.packSnapshot.questions[0]!.prompt).toBe(firstPrompt);
    expect(created.packSnapshot.knownFacts[0]!.value).not.toBe('Mutated caller-owned fact');
  });});

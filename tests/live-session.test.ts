import { describe, expect, it } from 'vitest';
import { generalDiscoveryPack } from '../src/pack';
import { createSemanticSession, type SemanticAnswerState } from '../src/semantic-session';
import {
  applyReactivationReviews,
  applyStatusControl,
  applyValueEdit,
  coverage,
  coverageBucketMap,
  nextVisibleQuestion,
  relevanceMap,
  semanticStatusLabel,
  statusControlForState,
  visibleQuestions,
} from '../src/live-session';

async function session() {
  return createSemanticSession(generalDiscoveryPack, { clientLabel: 'Synthetic' }, new Date('2026-11-02T12:00:00.000Z'));
}

function state(overrides: Partial<SemanticAnswerState> = {}): SemanticAnswerState {
  return {
    value: null,
    resolution: 'unresolved',
    source: null,
    needsConfirmation: false,
    confirmation: null,
    followUp: null,
    note: '',
    ...overrides,
  };
}

describe('live semantic session adapter', () => {
  it('keeps pending conditional objectives visible and open until authoritative parent evidence exists', async () => {
    const current = await session();
    expect(relevanceMap(current)['booking-process']).toBe('pending');
    expect(visibleQuestions(current).map((question) => question.id)).toContain('booking-process');
    expect(coverageBucketMap(current)['booking-process']).toBe('open');
    expect(coverage(current)).toMatchObject({ resolved: 0, mustConfirm: 0, remaining: 5, inactive: 0, visible: 5 });
  });

  it('uses authoritative evidence to hide and reveal conditioned objectives without raw-value leakage', async () => {
    const current = await session();
    const parent = current.packSnapshot.questions.find((question) => question.id === 'needs-booking')!;
    current.answers[parent.id] = applyValueEdit(parent, current.answers[parent.id]!, 'No');
    expect(relevanceMap(current)['booking-process']).toBe('irrelevant');
    expect(visibleQuestions(current).map((question) => question.id)).not.toContain('booking-process');
    expect(coverage(current).inactive).toBe(1);

    current.answers[parent.id] = { ...current.answers[parent.id]!, resolution: 'not-applicable', value: 'Yes' };
    expect(relevanceMap(current)['booking-process']).toBe('pending');
    expect(visibleQuestions(current).map((question) => question.id)).toContain('booking-process');
  });

  it('typing a meaningful answer captures client statement without a separate status action', async () => {
    const current = await session();
    const question = current.packSnapshot.questions.find((item) => item.id === 'primary-goal')!;
    const updated = applyValueEdit(question, current.answers[question.id]!, 'Ship a clear first release.');
    expect(updated).toMatchObject({
      value: 'Ship a clear first release.',
      resolution: 'captured',
      source: 'client-statement',
      needsConfirmation: false,
    });
    expect(statusControlForState(updated)).toBe('ANSWERED');
    expect(semanticStatusLabel(question, updated)).toBe('Current');
  });

  it('blanking an answer invalidates current capture while retaining source/history metadata', async () => {
    const current = await session();
    const question = current.packSnapshot.questions.find((item) => item.id === 'primary-goal')!;
    const captured = state({
      value: 'Confirmed goal',
      resolution: 'captured',
      source: 'client-statement',
      confirmation: { revisionId: 'rev-1', confirmedAt: '2026-11-02T12:01:00.000Z', value: 'Confirmed goal' },
    });
    const updated = applyValueEdit(question, captured, '   ');
    expect(updated.resolution).toBe('unresolved');
    expect(updated.confirmation).toBeNull();
    expect(updated.needsConfirmation).toBe(true);
    expect(updated.source).toBe('client-statement');
  });

  it('maps existing status chips to explicit semantic transitions without inventing accepted-known-fact provenance', async () => {
    const current = await session();
    const question = current.packSnapshot.questions.find((item) => item.id === 'existing-presence')!;
    const meaningful = state({ value: 'A brochure site exists.' });

    expect(applyStatusControl(question, meaningful, 'ANSWERED')).toMatchObject({ resolution: 'captured', source: 'client-statement', needsConfirmation: false });
    expect(applyStatusControl(question, meaningful, 'ALREADY_KNOWN')).toMatchObject({ resolution: 'captured', source: null, needsConfirmation: true });
    expect(applyStatusControl(question, meaningful, 'MUST_CONFIRM')).toMatchObject({ resolution: 'captured', source: 'client-statement', needsConfirmation: true });
    expect(applyStatusControl(question, meaningful, 'SKIP')).toMatchObject({ resolution: 'deferred' });
    expect(applyStatusControl(question, meaningful, 'N_A')).toMatchObject({ resolution: 'not-applicable' });
    expect(applyStatusControl(question, state({ value: '   ' }), 'ANSWERED')).toMatchObject({ resolution: 'unresolved', source: null });
  });

  it('derives selected legacy-looking controls from semantic truth', () => {
    expect(statusControlForState(state())).toBeNull();
    expect(statusControlForState(state({ resolution: 'deferred' }))).toBe('SKIP');
    expect(statusControlForState(state({ resolution: 'not-applicable' }))).toBe('N_A');
    expect(statusControlForState(state({ value: 'x', resolution: 'captured', source: 'client-statement' }))).toBe('ANSWERED');
    expect(statusControlForState(state({ value: 'x', resolution: 'captured', source: null, needsConfirmation: true }))).toBe('ALREADY_KNOWN');
    expect(statusControlForState(state({ value: 'x', resolution: 'captured', source: 'client-statement', needsConfirmation: true }))).toBe('MUST_CONFIRM');
    expect(statusControlForState(state({ value: 'x', resolution: 'captured', source: 'accepted-known-fact' }))).toBe('ALREADY_KNOWN');
  });

  it('marks retained inactive evidence for review when a branch starts reactivating through pending', async () => {
    const current = await session();
    const parent = current.packSnapshot.questions.find((question) => question.id === 'needs-booking')!;
    const child = current.packSnapshot.questions.find((question) => question.id === 'booking-process')!;
    current.answers[parent.id] = applyValueEdit(parent, current.answers[parent.id]!, 'No');
    current.answers[child.id] = state({
      value: 'Old scheduling process',
      resolution: 'captured',
      source: 'client-statement',
      confirmation: { revisionId: 'old-rev', confirmedAt: '2026-11-01T12:00:00.000Z', value: 'Old scheduling process' },
    });
    const before = relevanceMap(current);
    expect(before[child.id]).toBe('irrelevant');

    current.answers[parent.id] = applyStatusControl(parent, current.answers[parent.id]!, 'MUST_CONFIRM');
    applyReactivationReviews(current, before);

    expect(relevanceMap(current)[child.id]).toBe('pending');
    expect(current.answers[child.id]).toMatchObject({ value: 'Old scheduling process', resolution: 'captured', needsConfirmation: true, confirmation: null });
  });

  it('recomputes cascading relevance while reviewing nested reactivation', async () => {
    const current = await session();
    const parent = current.packSnapshot.questions.find((question) => question.id === 'needs-booking')!;
    const child = current.packSnapshot.questions.find((question) => question.id === 'booking-process')!;
    const grandchild = current.packSnapshot.questions.find((question) => question.id === 'must-have')!;
    grandchild.condition = { questionId: child.id, equals: 'Portal' };

    current.answers[parent.id] = applyValueEdit(parent, current.answers[parent.id]!, 'No');
    current.answers[child.id] = state({ value: 'Email', resolution: 'captured', source: 'client-statement' });
    current.answers[grandchild.id] = state({ value: 'Retained must-have', resolution: 'captured', source: 'client-statement' });
    const before = relevanceMap(current);
    expect(before[child.id]).toBe('irrelevant');
    expect(before[grandchild.id]).toBe('irrelevant');

    current.answers[parent.id] = applyValueEdit(parent, current.answers[parent.id]!, 'Yes');
    applyReactivationReviews(current, before);

    expect(current.answers[child.id]).toMatchObject({ needsConfirmation: true, confirmation: null });
    expect(relevanceMap(current)[grandchild.id]).toBe('pending');
    expect(current.answers[grandchild.id]).toMatchObject({
      value: 'Retained must-have',
      resolution: 'captured',
      needsConfirmation: true,
      confirmation: null,
    });
  });

  it('uses exclusive semantic coverage buckets and navigation', async () => {
    const current = await session();
    const first = current.packSnapshot.questions[0]!;
    const second = current.packSnapshot.questions[1]!;
    current.answers[first.id] = state({ value: 'Current', resolution: 'captured', source: 'client-statement' });
    current.answers[second.id] = state({ value: 'Tentative', resolution: 'captured', source: null, needsConfirmation: true });
    const stats = coverage(current);
    expect(stats.resolved).toBe(1);
    expect(stats.mustConfirm).toBe(1);
    expect(nextVisibleQuestion(current, first.id, 1)?.id).toBe(second.id);
  });

  it('labels conditioned captured state from its own evidence rather than losing parent context', async () => {
    const current = await session();
    const question = current.packSnapshot.questions.find((item) => item.id === 'booking-process')!;
    expect(semanticStatusLabel(question, state({ value: 'Email', resolution: 'captured', source: 'client-statement' }))).toBe('Current');
    expect(semanticStatusLabel(question, state({ value: 'Email', resolution: 'captured', source: null, needsConfirmation: true }))).toBe('Needs confirmation');
    expect(semanticStatusLabel(question, state({ value: 'Email', resolution: 'captured', source: 'accepted-known-fact' }))).toBe('Known context');
    expect(semanticStatusLabel(question, state({ value: 'Email', resolution: 'deferred', source: 'client-statement' }))).toBe('Deferred');
  });

  it('keeps explicit deferred and N/A resolutions stable across no-op and ordinary value synchronization', async () => {
    const current = await session();
    const question = current.packSnapshot.questions.find((item) => item.id === 'primary-goal')!;

    for (const resolution of ['deferred', 'not-applicable'] as const) {
      const blank = state({ resolution });
      expect(applyValueEdit(question, blank, null)).toBe(blank);

      const retained = state({ value: 'Retained historical value', resolution, source: 'client-statement' });
      expect(applyValueEdit(question, retained, 'Retained historical value')).toBe(retained);
      expect(applyValueEdit(question, retained, 'Updated retained value')).toMatchObject({
        value: 'Updated retained value',
        resolution,
        source: 'client-statement',
      });
      expect(applyValueEdit(question, retained, '   ')).toMatchObject({
        value: '   ',
        resolution,
        source: 'client-statement',
      });
    }
  });

  it('reclassifies a corrected accepted known fact as a client statement but leaves a no-op read untouched', async () => {
    const current = await session();
    const question = current.packSnapshot.questions.find((item) => item.id === 'existing-presence')!;
    const known = state({
      value: 'Known context',
      resolution: 'captured',
      source: 'accepted-known-fact',
    });

    expect(applyValueEdit(question, known, 'Known context')).toBe(known);
    expect(applyValueEdit(question, known, 'Client correction')).toMatchObject({
      value: 'Client correction',
      resolution: 'captured',
      source: 'client-statement',
      needsConfirmation: false,
      confirmation: null,
    });

    const confirmedKnown = state({
      value: 'Confirmed known context',
      resolution: 'captured',
      source: 'accepted-known-fact',
      confirmation: {
        revisionId: 'rev-known-confirmed',
        confirmedAt: '2026-11-02T12:03:00.000Z',
        value: 'Confirmed known context',
      },
    });
    expect(applyValueEdit(question, confirmedKnown, 'Client correction after confirmation')).toMatchObject({
      value: 'Client correction after confirmation',
      resolution: 'captured',
      source: 'client-statement',
      needsConfirmation: true,
      confirmation: null,
    });
  });

  it('invalidates a current confirmation when a captured client statement changes meaningfully', async () => {
    const current = await session();
    const question = current.packSnapshot.questions.find((item) => item.id === 'primary-goal')!;
    const confirmed = state({
      value: 'Original goal',
      resolution: 'captured',
      source: 'client-statement',
      confirmation: { revisionId: 'rev-confirmed', confirmedAt: '2026-11-02T12:02:00.000Z', value: 'Original goal' },
    });

    expect(applyValueEdit(question, confirmed, 'Corrected goal')).toMatchObject({
      value: 'Corrected goal',
      resolution: 'captured',
      source: 'client-statement',
      needsConfirmation: true,
      confirmation: null,
    });
  });

  it('keeps compatibility status selection aligned with tentative semantic truth', async () => {
    const current = await session();
    const question = current.packSnapshot.questions.find((item) => item.id === 'primary-goal')!;
    const sourceUnknown = state({ value: 'Provisional', resolution: 'captured', source: null, needsConfirmation: false });
    expect(statusControlForState(sourceUnknown)).toBe('ALREADY_KNOWN');
    expect(semanticStatusLabel(question, sourceUnknown)).toBe('Needs confirmation');

    for (const status of ['ALREADY_KNOWN', 'MUST_CONFIRM'] as const) {
      const blank = applyStatusControl(question, state({ value: '   ' }), status);
      expect(blank).toMatchObject({ resolution: 'unresolved', needsConfirmation: true });
      expect(statusControlForState(blank)).toBeNull();
    }
  });

  it('marks direct reactivation states for review without discarding retained evidence', async () => {
    const cases: Array<[string, SemanticAnswerState, Partial<SemanticAnswerState>]> = [
      ['captured', state({ value: 'Retained capture', resolution: 'captured', source: 'client-statement' }), { resolution: 'captured', needsConfirmation: true }],
      ['deferred', state({ value: 'Retained deferred', resolution: 'deferred', source: 'client-statement' }), { resolution: 'unresolved', needsConfirmation: true }],
      ['not-applicable', state({ value: 'Retained N/A', resolution: 'not-applicable', source: 'client-statement' }), { resolution: 'unresolved', needsConfirmation: true }],
      ['unresolved retained', state({ value: 'Retained unresolved', resolution: 'unresolved' }), { resolution: 'unresolved', needsConfirmation: true }],
      ['unresolved empty', state({ value: null, resolution: 'unresolved' }), { resolution: 'unresolved', needsConfirmation: false }],
    ];

    for (const [label, childState, expected] of cases) {
      const current = await session();
      const parent = current.packSnapshot.questions.find((question) => question.id === 'needs-booking')!;
      const child = current.packSnapshot.questions.find((question) => question.id === 'booking-process')!;
      current.answers[parent.id] = applyValueEdit(parent, current.answers[parent.id]!, 'No');
      current.answers[child.id] = childState;
      const before = relevanceMap(current);
      expect(before[child.id], label).toBe('irrelevant');

      current.answers[parent.id] = applyValueEdit(parent, current.answers[parent.id]!, 'Yes');
      applyReactivationReviews(current, before);

      expect(relevanceMap(current)[child.id], label).toBe('relevant');
      expect(current.answers[child.id], label).toMatchObject({ value: childState.value, ...expected });
    }
  });

  it('falls back to the first visible question when the current question becomes hidden', async () => {
    const current = await session();
    const parent = current.packSnapshot.questions.find((question) => question.id === 'needs-booking')!;
    const child = current.packSnapshot.questions.find((question) => question.id === 'booking-process')!;
    current.answers[parent.id] = applyValueEdit(parent, current.answers[parent.id]!, 'No');
    const firstVisible = visibleQuestions(current)[0]!;

    expect(relevanceMap(current)[child.id]).toBe('irrelevant');
    expect(nextVisibleQuestion(current, child.id, 1)?.id).toBe(firstVisible.id);
    expect(nextVisibleQuestion(current, child.id, -1)?.id).toBe(firstVisible.id);
  });
});

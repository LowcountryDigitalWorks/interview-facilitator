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
});

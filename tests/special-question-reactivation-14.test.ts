import { describe, expect, it } from 'vitest';
import { generalDiscoveryPack } from '../src/pack';
import { createSemanticSession } from '../src/semantic-session';
import {
  applyReactivationReviews, applyValueEdit, coverage, relevanceMap, visibleQuestions,
} from '../src/live-session';

const AT = new Date('2026-11-05T12:00:00.000Z');

describe('#34/#35 special-key live projection and reactivation regression', () => {
  it('returns an own "__proto__" relevance entry when the conditional parent uses that ID', async () => {
    const pack = structuredClone(generalDiscoveryPack);
    const parent = pack.questions.find(question => question.id === 'needs-booking')!;
    const child = pack.questions.find(question => question.id === 'booking-process')!;
    parent.id = '__proto__';
    child.condition!.questionId = '__proto__';

    const current = await createSemanticSession(pack, { clientLabel: 'Synthetic special parent' }, AT);
    expect(Object.prototype.hasOwnProperty.call(current.answers, '__proto__')).toBe(true);
    const before = relevanceMap(current);
    expect(Object.prototype.hasOwnProperty.call(before, '__proto__')).toBe(true);
    expect(before['__proto__']).toBe('relevant');
    expect(before['booking-process']).toBe('pending');

    const captured = applyValueEdit(parent, current.answers['__proto__']!, 'No');
    Object.defineProperty(current.answers, '__proto__', {
      value: captured, enumerable: true, writable: true, configurable: true,
    });
    const after = relevanceMap(current);
    expect(after['__proto__']).toBe('relevant');
    expect(after['booking-process']).toBe('irrelevant');
    expect(visibleQuestions(current).map(question => question.id)).not.toContain('booking-process');
    expect(coverage(current).inactive).toBe(1);
    expect(Object.getPrototypeOf(after)).toBe(Object.prototype);
    expect(Object.keys(after)).toContain('__proto__');
  });

  it('retains a reactivated "__proto__" answer as an own data field, with confirmation invalidated', async () => {
    const pack = structuredClone(generalDiscoveryPack);
    const parent = pack.questions.find(question => question.id === 'needs-booking')!;
    const child = pack.questions.find(question => question.id === 'booking-process')!;
    child.id = '__proto__';
    const current = await createSemanticSession(pack, { clientLabel: 'Synthetic special child' }, AT);

    current.answers[parent.id] = applyValueEdit(parent, current.answers[parent.id]!, 'No');
    const retained = {
      value: 'Synthetic retained scheduling answer',
      resolution: 'captured' as const,
      source: 'client-statement' as const,
      needsConfirmation: false,
      confirmation: {
        revisionId: 'synthetic-old-revision', confirmedAt: '2026-11-04T12:00:00.000Z',
        value: 'Synthetic retained scheduling answer',
      },
      followUp: { action: 'Synthetic follow-up' },
      note: 'Synthetic private historical note',
    };
    Object.defineProperty(current.answers, '__proto__', {
      value: retained, enumerable: true, writable: true, configurable: true,
    });
    const before = relevanceMap(current);
    expect(before['__proto__']).toBe('irrelevant');

    current.answers[parent.id] = applyValueEdit(parent, current.answers[parent.id]!, 'Yes');
    applyReactivationReviews(current, before);

    expect(Object.prototype.hasOwnProperty.call(current.answers, '__proto__')).toBe(true);
    expect(Object.keys(current.answers)).toContain('__proto__');
    expect(Object.getPrototypeOf(current.answers)).toBe(Object.prototype);
    expect(current.answers['__proto__']).toMatchObject({
      value: retained.value,
      resolution: 'captured',
      source: 'client-statement',
      needsConfirmation: true,
      confirmation: null,
      followUp: retained.followUp,
      note: retained.note,
    });
    expect(current.answers['__proto__']).not.toBe(retained);
    expect(relevanceMap(current)['__proto__']).toBe('relevant');
    expect(visibleQuestions(current).map(question => question.id)).toContain('__proto__');
    expect(coverage(current).mustConfirm).toBeGreaterThanOrEqual(1);
  });
});

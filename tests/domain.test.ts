import { describe, expect, it } from 'vitest';
import { coverage, validateSessionForPack, validateSessionShape, visibleQuestions } from '../src/domain';
import { createPinnedSession } from '../src/pack-identity';
import { generalDiscoveryPack as pack } from '../src/pack';

describe('interview domain', () => {
  it('keeps conditional questions hidden until their condition matches and preserves prior hidden values', async () => {
    const session = await createPinnedSession(pack, { clientLabel: 'Synthetic Client' }, new Date('2026-10-31T12:00:00Z'));
    expect(visibleQuestions(pack, session).some((question) => question.id === 'booking-process')).toBe(false);

    session.answers['needs-booking']!.value = 'Yes';
    session.answers['booking-process']!.value = 'Use a request form.';
    session.answers['booking-process']!.status = 'ANSWERED';
    expect(visibleQuestions(pack, session).some((question) => question.id === 'booking-process')).toBe(true);

    session.answers['needs-booking']!.value = 'No';
    expect(visibleQuestions(pack, session).some((question) => question.id === 'booking-process')).toBe(false);
    expect(session.answers['booking-process']).toEqual({ value: 'Use a request form.', status: 'ANSWERED', note: '' });
  });

  it('tracks must-confirm separately while preserving a provisional answer value', async () => {
    const session = await createPinnedSession(pack, { clientLabel: 'Synthetic Client' }, new Date('2026-10-31T12:00:00Z'));
    session.answers['existing-presence']!.status = 'ALREADY_KNOWN';
    session.answers['primary-goal']!.value = 'Clarify the first release.';
    session.answers['primary-goal']!.status = 'MUST_CONFIRM';
    expect(session.answers['primary-goal']!.value).toBe('Clarify the first release.');
    expect(coverage(pack, session)).toEqual({ resolved: 1, remaining: 2, mustConfirm: 1, visible: 4 });
  });

  it('rejects invalid imported answer statuses', async () => {
    const session = await createPinnedSession(pack, { clientLabel: 'Synthetic Client' }, new Date('2026-10-31T12:00:00Z'));
    const invalid = structuredClone(session) as unknown as { answers: Record<string, { status: string | null }> };
    invalid.answers['primary-goal']!.status = 'DONE';
    expect(() => validateSessionShape(invalid)).toThrow(/status is invalid/i);
  });

  it('rejects imported sessions that do not match the full pack question set', async () => {
    const session = await createPinnedSession(pack, { clientLabel: 'Synthetic Client' }, new Date('2026-10-31T12:00:00Z'));
    delete session.answers['must-have'];
    expect(() => validateSessionForPack(session)).toThrow(/missing answer state/i);
  });
});

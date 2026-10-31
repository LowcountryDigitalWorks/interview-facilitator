import { describe, expect, it } from 'vitest';
import { coverage, createSession, visibleQuestions } from '../src/domain';
import { generalDiscoveryPack as pack } from '../src/pack';

describe('interview domain', () => {
  it('keeps conditional questions hidden until their condition matches', () => {
    const session = createSession(pack, { clientLabel: 'Synthetic Client' }, new Date('2026-10-31T12:00:00Z'));
    expect(visibleQuestions(pack, session).some((question) => question.id === 'booking-process')).toBe(false);
    session.answers['needs-booking']!.value = 'Yes';
    expect(visibleQuestions(pack, session).some((question) => question.id === 'booking-process')).toBe(true);
  });

  it('tracks must-confirm separately from resolved and unanswered coverage', () => {
    const session = createSession(pack, { clientLabel: 'Synthetic Client' }, new Date('2026-10-31T12:00:00Z'));
    session.answers['existing-presence']!.status = 'ALREADY_KNOWN';
    session.answers['primary-goal']!.value = 'Clarify the first release.';
    session.answers['primary-goal']!.status = 'MUST_CONFIRM';
    expect(coverage(pack, session)).toEqual({ resolved: 1, remaining: 2, mustConfirm: 1, visible: 4 });
  });
});

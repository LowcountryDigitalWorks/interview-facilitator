import { describe, expect, it } from 'vitest';
import type { Question } from '../src/domain';
import type { SemanticQuestionState } from '../src/coverage-semantics';
import { suggestNextObjective } from '../src/next-objective';

const questions: Question[] = [
  { id: 'website', sectionId: 'discovery', prompt: 'Is there an existing website?', kind: 'single', options: ['Yes', 'No'] },
  { id: 'platform', sectionId: 'discovery', prompt: 'What platform?', kind: 'single', options: ['Managed', 'Self-hosted'], condition: { questionId: 'website', equals: 'Yes' } },
  { id: 'hosting', sectionId: 'discovery', prompt: 'Who manages hosting?', kind: 'text', condition: { questionId: 'platform', equals: 'Self-hosted' } },
  { id: 'greenfield', sectionId: 'discovery', prompt: 'What does the new site need?', kind: 'text', condition: { questionId: 'website', equals: 'No' } },
  { id: 'goals', sectionId: 'discovery', prompt: 'What outcome matters?', kind: 'text' },
];

function state(value: string | null, overrides: Partial<SemanticQuestionState> = {}): SemanticQuestionState {
  return {
    value,
    resolution: value === null ? 'unresolved' : 'captured',
    source: value === null ? null : 'client-statement',
    needsConfirmation: false,
    confirmation: null,
    followUp: null,
    ...overrides,
  };
}

describe('#37B deterministic recommended next objective', () => {
  it('follows the existing-website branch, then its multi-level hosting probe', () => {
    const states = { website: state('Yes'), platform: state('Self-hosted') };
    expect(suggestNextObjective(questions, states, 'website')).toEqual({
      questionId: 'hosting', reason: 'capture',
    });
    expect(suggestNextObjective(questions, { website: state('Yes') }, 'website')).toEqual({
      questionId: 'platform', reason: 'capture',
    });
  });

  it('routes to the greenfield branch when an earlier answer switches and ignores retained inactive answers', () => {
    const before = { website: state('Yes'), platform: state('Self-hosted'), hosting: state('Old provider') };
    const after = { ...before, website: state('No') };
    const untouched = structuredClone(after);
    expect(suggestNextObjective(questions, after, 'website')).toEqual({
      questionId: 'greenfield', reason: 'capture',
    });
    expect(after).toEqual(untouched);
    expect(suggestNextObjective(questions, before, 'website')).toEqual({
      questionId: 'goals', reason: 'capture',
    });
  });

  it('does not guess a conditional branch from tentative parent evidence', () => {
    const states = { website: state('Yes', { needsConfirmation: true }), platform: state('Managed') };
    expect(suggestNextObjective(questions, states, 'goals')).toEqual({
      questionId: 'website', reason: 'needs-confirmation',
    });
    expect(suggestNextObjective(questions, states, 'website')).toEqual({
      questionId: 'goals', reason: 'capture',
    });
  });

  it('does not automatically re-prompt deferred or not-applicable objectives', () => {
    const states = {
      website: state('No'),
      greenfield: state('prior draft', { resolution: 'deferred' as const }),
      goals: state('unused', { resolution: 'not-applicable' as const }),
    };
    expect(suggestNextObjective(questions, states, 'website')).toBeNull();
  });

  it('keeps an unresolved retained value open and distinguishes review of a captured weak source', () => {
    expect(suggestNextObjective(questions, {
      website: state('No'),
      greenfield: state('uncertain draft', { resolution: 'unresolved' }),
      goals: state('Draft outcome', { source: null }),
    }, 'website')).toEqual({ questionId: 'greenfield', reason: 'capture' });

    expect(suggestNextObjective(questions, {
      website: state('No'),
      greenfield: state('Draft outcome', { source: null }),
      goals: state('Confirmed outcome'),
    }, 'website')).toEqual({ questionId: 'greenfield', reason: 'needs-confirmation' });
  });

  it('does not label an all-resolved interview complete; it simply returns no suggestion', () => {
    const states = {
      website: state('No'),
      platform: state('Self-hosted'),
      hosting: state('inactive retained'),
      greenfield: state('Build a new site'),
      goals: state('Better discovery'),
    };
    expect(suggestNextObjective(questions, states, 'greenfield')).toBeNull();
    expect(suggestNextObjective(questions, states, 'greenfield')).toBeNull();
  });

  it('wraps in pinned order and starts at the first objective when the current ID is unknown', () => {
    expect(suggestNextObjective(questions, {}, 'goals')).toEqual({ questionId: 'website', reason: 'capture' });
    expect(suggestNextObjective(questions, {}, 'not-in-pack')).toEqual({ questionId: 'website', reason: 'capture' });
    expect(suggestNextObjective(questions, {}, null)).toEqual({ questionId: 'website', reason: 'capture' });
  });

  it('returns no suggestion for missing parents and dependency cycles instead of guessing', () => {
    const broken: Question[] = [
      { id: 'orphan', sectionId: 'one', prompt: 'Orphan', kind: 'text', condition: { questionId: 'missing', equals: 'Yes' } },
      { id: 'a', sectionId: 'one', prompt: 'A', kind: 'text', condition: { questionId: 'b', equals: 'Yes' } },
      { id: 'b', sectionId: 'one', prompt: 'B', kind: 'text', condition: { questionId: 'a', equals: 'Yes' } },
    ];
    expect(suggestNextObjective(broken, { a: state('Yes'), b: state('Yes') })).toBeNull();
    expect(suggestNextObjective([], {})).toBeNull();
  });
});

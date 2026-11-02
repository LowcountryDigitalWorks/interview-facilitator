import { describe, expect, it } from 'vitest';
import type { Question } from '../src/domain';
import type { CaptureSpec, SemanticQuestionState } from '../src/coverage-semantics';
import {
  EFFECTIVE_EVIDENCE_EQUALS_V2,
  coverageBucketForQuestion,
  deriveRelevanceMap,
  projectCoverageObjectives,
  reviewReactivatedState,
} from '../src/coverage-rules';

function question(id: string, condition?: { questionId: string; equals: string }): Question {
  return {
    id,
    sectionId: 'section',
    prompt: id,
    kind: 'single',
    options: ['Yes', 'No'],
    ...(condition ? { condition } : {}),
  };
}

const yesNoSpec: CaptureSpec = { kind: 'single', options: ['Yes', 'No'] };

function semanticState(input: Partial<SemanticQuestionState> = {}): SemanticQuestionState {
  return {
    value: null,
    resolution: 'unresolved',
    source: null,
    needsConfirmation: false,
    confirmation: null,
    followUp: null,
    ...input,
  };
}

function authoritative(value: string): SemanticQuestionState {
  return semanticState({ value, resolution: 'captured', source: 'client-statement' });
}

function tentative(value: string): SemanticQuestionState {
  return semanticState({
    value,
    resolution: 'captured',
    source: 'client-statement',
    needsConfirmation: true,
  });
}

describe('effective-evidence-equals-v2 relevance', () => {
  it('uses an explicit successor semantics identity without changing v1', () => {
    expect(EFFECTIVE_EVIDENCE_EQUALS_V2).toBe('effective-evidence-equals-v2');
  });

  it('makes unconditional objectives relevant', () => {
    expect(deriveRelevanceMap([question('root')], {})).toEqual({ root: 'relevant' });
  });

  it.each([
    ['Yes', 'relevant'],
    ['No', 'irrelevant'],
  ] as const)('uses authoritative parent evidence for exact match/mismatch: %s', (value, expected) => {
    const questions = [question('root'), question('child', { questionId: 'root', equals: 'Yes' })];
    expect(deriveRelevanceMap(questions, { root: authoritative(value) }).child).toBe(expected);
  });

  it('uses exact string equality without case folding or truthiness', () => {
    const questions = [question('root'), question('child', { questionId: 'root', equals: 'yes' })];
    expect(deriveRelevanceMap(questions, { root: authoritative('Yes') }).child).toBe('irrelevant');
  });

  it('accepts explicitly authoritative accepted-known-fact evidence once supplied by the later fact lifecycle', () => {
    const questions = [question('root'), question('child', { questionId: 'root', equals: 'Yes' })];
    const root = semanticState({ value: 'Yes', resolution: 'captured', source: 'accepted-known-fact' });
    expect(deriveRelevanceMap(questions, { root }).child).toBe('relevant');
  });

  it.each([
    ['no state', undefined],
    ['unresolved', semanticState({ value: 'Yes' })],
    ['provenance unknown', semanticState({ value: 'Yes', resolution: 'captured' })],
    ['tentative match', tentative('Yes')],
    ['tentative mismatch', tentative('No')],
    ['stale confirmation', semanticState({
      value: 'Yes',
      resolution: 'captured',
      source: 'client-statement',
      confirmation: { revisionId: 'old', confirmedAt: '2026-11-02T20:00:00.000Z', value: 'No' },
    })],
    ['invalid captured option', authoritative('Maybe')],
  ])('keeps child pending when parent evidence is not authoritative: %s', (_label, root) => {
    const questions = [question('root'), question('child', { questionId: 'root', equals: 'Yes' })];
    expect(deriveRelevanceMap(questions, root ? { root } : {}).child).toBe('pending');
  });

  it.each(['deferred', 'not-applicable'] as const)(
    'does not let stale matching raw value drive a %s parent',
    (resolution) => {
      const questions = [question('root'), question('child', { questionId: 'root', equals: 'Yes' })];
      const root = semanticState({ value: 'Yes', resolution, source: 'client-statement' });
      expect(deriveRelevanceMap(questions, { root }).child).toBe('pending');
    },
  );

  it('fails an unknown condition parent closed to pending', () => {
    const questions = [question('child', { questionId: 'missing', equals: 'Yes' })];
    expect(deriveRelevanceMap(questions, {}).child).toBe('pending');
  });
});

describe('multi-level relevance propagation', () => {
  const chain = [
    question('root'),
    question('child', { questionId: 'root', equals: 'Yes' }),
    question('grandchild', { questionId: 'child', equals: 'Yes' }),
  ];

  it('propagates authoritative matches through multiple levels', () => {
    expect(deriveRelevanceMap(chain, {
      root: authoritative('Yes'),
      child: authoritative('Yes'),
    })).toEqual({ root: 'relevant', child: 'relevant', grandchild: 'relevant' });
  });

  it('makes descendants irrelevant when an authoritative ancestor closes the branch', () => {
    expect(deriveRelevanceMap(chain, {
      root: authoritative('No'),
      child: authoritative('Yes'),
    })).toEqual({ root: 'relevant', child: 'irrelevant', grandchild: 'irrelevant' });
  });

  it('does not let an inactive child with stale matching raw evidence drive a grandchild', () => {
    const child = authoritative('Yes');
    expect(deriveRelevanceMap(chain, {
      root: authoritative('No'),
      child,
    }).grandchild).toBe('irrelevant');
  });

  it.each([
    ['unknown root', semanticState({ value: 'Yes' })],
    ['tentative root', tentative('Yes')],
  ])('propagates pending through descendants for %s', (_label, root) => {
    expect(deriveRelevanceMap(chain, {
      root,
      child: authoritative('Yes'),
    })).toEqual({ root: 'relevant', child: 'pending', grandchild: 'pending' });
  });

  it('keeps descendants pending when a relevant child has no effective evidence', () => {
    expect(deriveRelevanceMap(chain, {
      root: authoritative('Yes'),
      child: semanticState({ value: 'Yes' }),
    })).toEqual({ root: 'relevant', child: 'relevant', grandchild: 'pending' });
  });

  it('fails a two-node dependency cycle closed to pending without recursion', () => {
    const cycle = [
      question('a', { questionId: 'b', equals: 'Yes' }),
      question('b', { questionId: 'a', equals: 'Yes' }),
    ];
    expect(deriveRelevanceMap(cycle, { a: authoritative('Yes'), b: authoritative('Yes') }))
      .toEqual({ a: 'pending', b: 'pending' });
  });

  it('fails a self-cycle closed to pending without recursion', () => {
    const self = [question('self', { questionId: 'self', equals: 'Yes' })];
    expect(deriveRelevanceMap(self, { self: authoritative('Yes') })).toEqual({ self: 'pending' });
  });

  it('propagates pending through a descendant of a dependency cycle', () => {
    const cycleWithTail = [
      question('a', { questionId: 'b', equals: 'Yes' }),
      question('b', { questionId: 'a', equals: 'Yes' }),
      question('tail', { questionId: 'a', equals: 'Yes' }),
    ];
    expect(deriveRelevanceMap(cycleWithTail, {
      a: authoritative('Yes'),
      b: authoritative('Yes'),
      tail: authoritative('Yes'),
    })).toEqual({ a: 'pending', b: 'pending', tail: 'pending' });
  });

  it('propagates pending through descendants of a missing-parent objective', () => {
    const missingParentChain = [
      question('child', { questionId: 'missing', equals: 'Yes' }),
      question('grandchild', { questionId: 'child', equals: 'Yes' }),
    ];
    expect(deriveRelevanceMap(missingParentChain, { child: authoritative('Yes') }))
      .toEqual({ child: 'pending', grandchild: 'pending' });
  });

  it('derives the same relevance independent of question array order', () => {
    const states = { root: authoritative('Yes'), child: authoritative('Yes') };
    const forward = deriveRelevanceMap(chain, states);
    const reverse = deriveRelevanceMap([...chain].reverse(), states);
    expect(reverse).toEqual({ grandchild: 'relevant', child: 'relevant', root: 'relevant' });
    expect(reverse.root).toBe(forward.root);
    expect(reverse.child).toBe(forward.child);
    expect(reverse.grandchild).toBe(forward.grandchild);
  });
});

describe('reactivation review', () => {
  it('preserves captured data but invalidates current confirmation on irrelevant -> relevant', () => {
    const state = semanticState({
      value: 'Yes',
      resolution: 'captured',
      source: 'client-statement',
      needsConfirmation: false,
      confirmation: {
        revisionId: 'confirmed-revision',
        confirmedAt: '2026-11-02T20:00:00.000Z',
        value: 'Yes',
      },
      followUp: { action: 'Retained follow-up', owner: 'Interviewer' },
    });
    const updated = reviewReactivatedState('irrelevant', 'relevant', state, yesNoSpec);
    expect(updated).toEqual({
      ...state,
      needsConfirmation: true,
      confirmation: null,
    });
    expect(updated.value).toBe('Yes');
    expect(updated.source).toBe('client-statement');
    expect(updated.followUp).toBe(state.followUp);
    expect(state.confirmation).not.toBeNull();
  });

  it.each(['deferred', 'not-applicable'] as const)(
    'reclassifies reactivated %s state to unresolved review-required while retaining raw value',
    (resolution) => {
      const state = semanticState({ value: 'Yes', resolution, source: 'client-statement' });
      expect(reviewReactivatedState('irrelevant', 'relevant', state, yesNoSpec)).toEqual({
        ...state,
        resolution: 'unresolved',
        needsConfirmation: true,
        confirmation: null,
      });
    },
  );

  it('does not manufacture confirmation work for an empty unresolved reactivated state', () => {
    const state = semanticState();
    const updated = reviewReactivatedState('irrelevant', 'relevant', state, yesNoSpec);
    expect(updated).toEqual(state);
    expect(updated).not.toBe(state);
  });

  it.each(['', '   '])('does not manufacture review work from non-meaningful retained value %j', (value) => {
    const state = semanticState({ value });
    const updated = reviewReactivatedState('irrelevant', 'relevant', state, { kind: 'text' });
    expect(updated).toEqual(state);
    expect(updated.needsConfirmation).toBe(false);
  });

  it('does not treat a source label or follow-up alone as retained evidence', () => {
    const followUp = { action: 'Future action' };
    const state = semanticState({ source: 'client-statement', followUp });
    const updated = reviewReactivatedState('irrelevant', 'relevant', state, yesNoSpec);
    expect(updated).toEqual(state);
    expect(updated.needsConfirmation).toBe(false);
    expect(updated.followUp).toBe(followUp);
  });

  it('requires review when an unresolved state retains a confirmation reference', () => {
    const state = semanticState({
      confirmation: { revisionId: 'prior', confirmedAt: '2026-11-02T20:00:00.000Z', value: 'Yes' },
    });
    expect(reviewReactivatedState('irrelevant', 'relevant', state, yesNoSpec)).toEqual({
      ...state,
      needsConfirmation: true,
      confirmation: null,
    });
  });

  it('requires review for unresolved retained raw evidence on reactivation', () => {
    const state = semanticState({ value: 'Yes' });
    expect(reviewReactivatedState('irrelevant', 'relevant', state, yesNoSpec)).toEqual({
      ...state,
      needsConfirmation: true,
      confirmation: null,
    });
  });

  it.each([
    ['relevant', 'relevant'],
    ['irrelevant', 'pending'],
    ['pending', 'relevant'],
  ] as const)('is a semantic no-op for non-reactivation transition %s -> %s', (from, to) => {
    const state = authoritative('Yes');
    const updated = reviewReactivatedState(from, to, state, yesNoSpec);
    expect(updated).toEqual(state);
    expect(updated).not.toBe(state);
  });
});

describe('exclusive coverage buckets', () => {
  const objective = question('objective');

  it('gives relevance precedence: irrelevant is inactive regardless of retained state', () => {
    expect(coverageBucketForQuestion(
      objective,
      semanticState({ value: 'Yes', resolution: 'not-applicable', source: 'client-statement' }),
      'irrelevant',
    )).toBe('inactive');
  });

  it('treats pending relevance as open even when retained capture was authoritative', () => {
    expect(coverageBucketForQuestion(objective, authoritative('Yes'), 'pending')).toBe('open');
  });

  it('keeps relevant not-applicable separate from current/open coverage', () => {
    expect(coverageBucketForQuestion(
      objective,
      semanticState({ resolution: 'not-applicable' }),
      'relevant',
    )).toBe('not-applicable');
  });

  it('projects relevant authoritative capture as current', () => {
    expect(coverageBucketForQuestion(objective, authoritative('Yes'), 'relevant')).toBe('current');
  });

  it('projects relevant tentative capture as needs-confirmation', () => {
    expect(coverageBucketForQuestion(objective, tentative('Yes'), 'relevant')).toBe('needs-confirmation');
  });

  it('projects provenance-unknown captured evidence as needs-confirmation rather than current', () => {
    expect(coverageBucketForQuestion(
      objective,
      semanticState({ value: 'Yes', resolution: 'captured' }),
      'relevant',
    )).toBe('needs-confirmation');
  });

  it.each([
    ['missing state', undefined],
    ['unresolved', semanticState()],
    ['deferred', semanticState({ resolution: 'deferred' })],
    ['invalid captured option', authoritative('Maybe')],
  ])('projects %s as open', (_label, state) => {
    expect(coverageBucketForQuestion(objective, state, 'relevant')).toBe('open');
  });

  it('projects every current question to exactly one relevance state and one bucket', () => {
    const questions = [
      question('root'),
      question('child', { questionId: 'root', equals: 'Yes' }),
      question('other'),
    ];
    const projections = projectCoverageObjectives(questions, {
      root: authoritative('No'),
      child: authoritative('Yes'),
      other: tentative('Yes'),
    });
    expect(projections).toEqual([
      { questionId: 'root', relevance: 'relevant', bucket: 'current' },
      { questionId: 'child', relevance: 'irrelevant', bucket: 'inactive' },
      { questionId: 'other', relevance: 'relevant', bucket: 'needs-confirmation' },
    ]);
    expect(new Set(projections.map((projection) => projection.questionId)).size).toBe(questions.length);
  });
});

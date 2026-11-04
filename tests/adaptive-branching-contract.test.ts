import { describe, expect, it } from 'vitest';
import type { Question } from '../src/domain';
import type { SemanticQuestionState } from '../src/coverage-semantics';
import { deriveRelevanceMap, projectCoverageObjectives } from '../src/coverage-rules';

/**
 * #37A — deterministic adaptive-question acceptance contract.
 * These tests deliberately exercise the existing pure coverage engine, not
 * future AI, audio, transcript processing, or the 1.4 editor activation.
 */
const questions: Question[] = [
  { id: 'website', sectionId: 'discovery', prompt: 'Do you have a website?', kind: 'single', options: ['Yes', 'No'] },
  { id: 'platform', sectionId: 'discovery', prompt: 'Which existing platform?', kind: 'single', options: ['Managed', 'Self-hosted'], condition: { questionId: 'website', equals: 'Yes' } },
  { id: 'hosting', sectionId: 'discovery', prompt: 'Who manages hosting?', kind: 'text', condition: { questionId: 'platform', equals: 'Self-hosted' } },
  { id: 'greenfield', sectionId: 'discovery', prompt: 'What should the new site include?', kind: 'text', condition: { questionId: 'website', equals: 'No' } },
];

function answer(value: string, needsConfirmation = false): SemanticQuestionState {
  return {
    value,
    resolution: 'captured',
    source: 'client-statement',
    needsConfirmation,
    confirmation: null,
    followUp: null,
  };
}

describe('#37A adaptive branching — offline deterministic contract', () => {
  it('selects existing-site or greenfield branches from authoritative answers', () => {
    expect(deriveRelevanceMap(questions, { website: answer('Yes') })).toEqual({
      website: 'relevant', platform: 'relevant', hosting: 'pending', greenfield: 'irrelevant',
    });
    expect(deriveRelevanceMap(questions, { website: answer('No') })).toEqual({
      website: 'relevant', platform: 'irrelevant', hosting: 'irrelevant', greenfield: 'relevant',
    });
  });

  it('recomputes multi-level follow-ups when a prior answer changes, retaining evidence unchanged', () => {
    const states = { website: answer('Yes'), platform: answer('Self-hosted'), hosting: answer('Previous provider') };
    const original = structuredClone(states);
    expect(deriveRelevanceMap(questions, states).hosting).toBe('relevant');

    const changed = { ...states, website: answer('No') };
    expect(deriveRelevanceMap(questions, changed)).toEqual({
      website: 'relevant', platform: 'irrelevant', hosting: 'irrelevant', greenfield: 'relevant',
    });
    expect(states).toEqual(original);
    expect(changed.hosting).toEqual(original.hosting);

    expect(deriveRelevanceMap(questions, { ...changed, website: answer('Yes') }).hosting).toBe('relevant');
  });

  it('never treats tentative or unresolved parent evidence as a confirmed branch decision', () => {
    const tentative = deriveRelevanceMap(questions, {
      website: answer('Yes', true),
      platform: answer('Self-hosted'),
    });
    expect(tentative).toEqual({
      website: 'relevant', platform: 'pending', hosting: 'pending', greenfield: 'pending',
    });
    expect(deriveRelevanceMap(questions, {
      website: { ...answer('Yes'), resolution: 'unresolved' },
    }).platform).toBe('pending');
  });

  it('does not count retained answers in inactive branches as current coverage', () => {
    const states = {
      website: answer('No'),
      platform: answer('Self-hosted'),
      hosting: answer('Previous provider'),
      greenfield: answer('New storefront'),
    };
    const projection = projectCoverageObjectives(questions, states);
    expect(projection).toEqual([
      { questionId: 'website', relevance: 'relevant', bucket: 'current' },
      { questionId: 'platform', relevance: 'irrelevant', bucket: 'inactive' },
      { questionId: 'hosting', relevance: 'irrelevant', bucket: 'inactive' },
      { questionId: 'greenfield', relevance: 'relevant', bucket: 'current' },
    ]);
    expect(states.hosting.value).toBe('Previous provider');
  });

  it('gives the same branch result regardless of question ordering or repeated evaluation', () => {
    const states = { website: answer('Yes'), platform: answer('Self-hosted') };
    const forward = deriveRelevanceMap(questions, states);
    const reverse = deriveRelevanceMap([...questions].reverse(), states);
    for (const question of questions) expect(reverse[question.id]).toBe(forward[question.id]);
    expect(deriveRelevanceMap(questions, states)).toEqual(forward);
  });
});

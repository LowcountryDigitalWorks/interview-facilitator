import { describe, expect, it } from 'vitest';
import { findLiveInterviewPack, LIVE_INTERVIEW_PACK_OPTIONS } from '../src/interview-packs';
import {
  LIVE_PINNED_PACK_GLANCE_LAYOUT,
  PRIVATE_OUTCOME_GLANCE_NOTICE,
  PRIVATE_OUTCOME_GLANCE_VERSION,
  projectPrivateOutcomeGlance,
  projectPrivateOutcomeGlanceFromSession,
} from '../src/private-outcome-glance';
import { canonicalizeJson } from '../src/pack-identity';
import { createSemanticSession, type SemanticAnswerState, type SemanticInterviewSession } from '../src/semantic-session';
import { generalDiscoveryPack } from '../src/pack';

const AT = new Date('2026-11-12T18:00:00.000Z');

function blankState(): SemanticAnswerState {
  return {
    value: null,
    resolution: 'unresolved',
    source: null,
    needsConfirmation: false,
    confirmation: null,
    followUp: null,
    note: '',
  };
}

async function sessionForPack(packId: string): Promise<SemanticInterviewSession> {
  const pack = findLiveInterviewPack(packId);
  if (!pack) throw new Error(`Missing pack ${packId}`);
  return createSemanticSession(pack, { clientLabel: `Synthetic ${packId}` }, AT);
}

function withAnswer(
  session: SemanticInterviewSession,
  questionId: string,
  partial: Partial<SemanticAnswerState>,
): SemanticInterviewSession {
  const next = structuredClone(session);
  next.answers[questionId] = { ...blankState(), ...next.answers[questionId], ...partial };
  return next;
}

describe('private outcome glance projection', () => {
  it('covers all five live pack IDs with mapped layout keys', async () => {
    expect(LIVE_INTERVIEW_PACK_OPTIONS).toHaveLength(5);
    for (const option of LIVE_INTERVIEW_PACK_OPTIONS) {
      expect(LIVE_PINNED_PACK_GLANCE_LAYOUT[option.id]).toBeDefined();
      const session = await sessionForPack(option.id);
      const glance = projectPrivateOutcomeGlanceFromSession(session);
      expect(glance.schemaVersion).toBe(PRIVATE_OUTCOME_GLANCE_VERSION);
      expect(glance.packId).toBe(option.id);
      expect(glance.notice).toBe(PRIVATE_OUTCOME_GLANCE_NOTICE);
      expect(glance.suggestedConversationStep).toContain('human judgment');
      expect(glance.suggestedConversationStep).not.toMatch(/create (a )?task|send (an )?email/i);
    }
  });

  it('reports early blank general-discovery session as unknowns', async () => {
    const session = await sessionForPack('general-discovery-blank');
    const glance = projectPrivateOutcomeGlanceFromSession(session);
    expect(glance.outcome.items).toEqual([]);
    expect(glance.unknowns.items.some((item) => item.questionId === 'primary-goal' && item.displayValue === 'Not established')).toBe(true);
    expect(glance.unknowns.items.length).toBeGreaterThan(0);
  });

  it('places captured authoritative answers in outcome and dependencies', async () => {
    let session = await sessionForPack('general-discovery-blank');
    session = withAnswer(session, 'primary-goal', {
      value: 'SYNTHETIC GOAL',
      resolution: 'captured',
      source: 'client-statement',
    });
    session = withAnswer(session, 'must-have', {
      value: 'SYNTHETIC MUST',
      resolution: 'captured',
      source: 'client-statement',
    });
    const glance = projectPrivateOutcomeGlanceFromSession(session);
    expect(glance.outcome.items[0]?.questionId).toBe('primary-goal');
    expect(glance.outcome.items[0]?.displayValue).toBe('SYNTHETIC GOAL');
    expect(glance.dependencies.items[0]?.questionId).toBe('must-have');
    expect(glance.outcome.items[0]?.provenanceClassification).toContain('classification only');
  });

  it('omits irrelevant conditionals and keeps pending child in unknowns', async () => {
    let session = await sessionForPack('website-greenfield');
    session = withAnswer(session, 'needs-booking', {
      value: 'No',
      resolution: 'captured',
      source: 'client-statement',
    });
    const glance = projectPrivateOutcomeGlanceFromSession(session);
    const ids = [...glance.outcome.items, ...glance.dependencies.items, ...glance.unknowns.items]
      .map((item) => item.questionId);
    expect(ids).not.toContain('booking-details');
    expect(glance.unknowns.items.some((item) => item.questionId === 'booking-details')).toBe(false);
  });

  it('treats pending parent and conditional follow-ups as unknowns', async () => {
    let session = await sessionForPack('website-greenfield');
    session = withAnswer(session, 'needs-booking', { value: 'Yes', resolution: 'captured', source: 'client-statement' });
    const glance = projectPrivateOutcomeGlanceFromSession(session);
    expect(glance.unknowns.items.some((item) => item.questionId === 'booking-details')).toBe(true);
  });

  it('routes approval-required pending branch correctly for workflow pack', async () => {
    let session = await sessionForPack('workflow-automation');
    session = withAnswer(session, 'approval-required', { value: 'Yes', resolution: 'captured', source: 'client-statement' });
    const glance = projectPrivateOutcomeGlanceFromSession(session);
    expect(glance.unknowns.items.some((item) => item.questionId === 'approval-points')).toBe(true);
  });

  it('routes restore-evidence when backup affirmed', async () => {
    let session = await sessionForPack('technology-ownership');
    session = withAnswer(session, 'backup-exists', { value: 'Yes', resolution: 'captured', source: 'client-statement' });
    const glance = projectPrivateOutcomeGlanceFromSession(session);
    expect(glance.unknowns.items.some((item) => item.questionId === 'restore-evidence')).toBe(true);
  });

  it('does not promote accepted-known-fact or inference to verified client claim', async () => {
    let session = await sessionForPack('general-discovery-blank');
    session = withAnswer(session, 'primary-goal', {
      value: 'Prior context',
      resolution: 'captured',
      source: 'accepted-known-fact',
      needsConfirmation: true,
    });
    const glance = projectPrivateOutcomeGlanceFromSession(session);
    const goal = glance.unknowns.items.find((item) => item.questionId === 'primary-goal')
      ?? glance.outcome.items.find((item) => item.questionId === 'primary-goal');
    expect(goal?.provenanceClassification).toContain('not independently verified');
    session = withAnswer(session, 'must-have', {
      value: 'Guess',
      resolution: 'captured',
      source: 'interviewer-inference',
      needsConfirmation: true,
    });
    const glance2 = projectPrivateOutcomeGlanceFromSession(session);
    const bucket = glance2.unknowns.items.find((item) => item.questionId === 'must-have')
      ?? glance2.dependencies.items.find((item) => item.questionId === 'must-have');
    expect(bucket?.needsConfirmation ?? glance2.unknowns.items.some((i) => i.questionId === 'must-have')).toBe(true);
  });

  it('treats stale confirmation value as unknown evidence', async () => {
    let session = await sessionForPack('website-takeover');
    session = withAnswer(session, 'main-pain', {
      value: 'Current pain',
      resolution: 'captured',
      source: 'client-statement',
      confirmation: { revisionId: 'r1', confirmedAt: AT.toISOString(), value: 'Stale pain' },
    });
    const glance = projectPrivateOutcomeGlanceFromSession(session);
    const pain = [...glance.outcome.items, ...glance.unknowns.items].find((item) => item.questionId === 'main-pain');
    expect(pain?.needsConfirmation || glance.unknowns.items.some((i) => i.questionId === 'main-pain')).toBe(true);
  });

  it('handles unknown legacy pinned pack with neutral fallbacks', async () => {
    const legacy = await createSemanticSession(generalDiscoveryPack, { clientLabel: 'Synthetic legacy layout' }, AT);
    legacy.packSnapshot.packId = 'legacy-unknown-pack';
    const glance = projectPrivateOutcomeGlanceFromSession(legacy);
    expect(glance.outcome.items).toEqual([]);
    expect(glance.dependencies.items).toEqual([]);
    expect(glance.unknowns.items.length).toBeGreaterThan(0);
  });

  it('keeps malicious markup as literal text in displayValue', async () => {
    const hostile = '<img src=x onerror=HOSTILE_GLANCE>';
    let session = await sessionForPack('general-discovery-blank');
    session = withAnswer(session, 'primary-goal', {
      value: hostile,
      resolution: 'captured',
      source: 'client-statement',
    });
    const glance = projectPrivateOutcomeGlanceFromSession(session);
    const value = glance.outcome.items[0]?.displayValue ?? '';
    expect(value).toBe(hostile);
    expect(value).toContain('<img');
  });

  it('does not expose internal question notes in glance items', async () => {
    let session = await sessionForPack('general-discovery-blank');
    session = withAnswer(session, 'primary-goal', {
      value: 'Visible',
      resolution: 'captured',
      source: 'client-statement',
      note: 'SECRET INTERNAL NOTE',
    });
    const glance = projectPrivateOutcomeGlanceFromSession(session);
    const serialized = JSON.stringify(glance);
    expect(serialized).not.toContain('SECRET INTERNAL NOTE');
  });

  it('is deterministic and does not mutate validated session input', async () => {
    const session = await sessionForPack('website-takeover');
    session.answers['main-pain'] = {
      ...blankState(),
      value: 'Pain point',
      resolution: 'captured',
      source: 'client-statement',
    };
    const before = canonicalizeJson(session);
    const first = projectPrivateOutcomeGlanceFromSession(session);
    const second = projectPrivateOutcomeGlanceFromSession(session);
    expect(first).toEqual(second);
    expect(canonicalizeJson(session)).toBe(before);
  });

  it('fails validation without mutating invalid input', async () => {
    const bad = { sessionSchemaVersion: '9.9.9' };
    const before = canonicalizeJson(bad);
    await expect(projectPrivateOutcomeGlance(bad)).rejects.toThrow();
    expect(canonicalizeJson(bad)).toBe(before);
  });

  it('orders items by pinned question order', async () => {
    let session = await sessionForPack('website-greenfield');
    session = withAnswer(session, 'primary-outcome', {
      value: 'Outcome', resolution: 'captured', source: 'client-statement',
    });
    session = withAnswer(session, 'launch-priority', {
      value: 'Priority', resolution: 'captured', source: 'client-statement',
    });
    session = withAnswer(session, 'success-measure', {
      value: 'Measure', resolution: 'captured', source: 'client-statement',
    });
    const glance = projectPrivateOutcomeGlanceFromSession(session);
    const ids = glance.outcome.items.map((item) => item.questionId);
    const order = session.packSnapshot.questions.map((question) => question.id);
    const sorted = [...ids].sort((a, b) => order.indexOf(a) - order.indexOf(b));
    expect(ids).toEqual(sorted);
  });
});

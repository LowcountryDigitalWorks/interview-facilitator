import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INTERVIEW_PACK_ID,
  LIVE_INTERVIEW_PACK_OPTIONS,
  defaultLiveInterviewPack,
  findLiveInterviewPack,
} from '../src/interview-packs';
import { createSemanticSession, validateSemanticSessionRecord } from '../src/semantic-session';
import { canonicalizeJson } from '../src/pack-identity';
import { relevanceMap, visibleQuestions } from '../src/live-session';

describe('five live offline interview packs', () => {
  it('offers the five owner-requested interview categories without test-only synthetic facts', () => {
    expect(LIVE_INTERVIEW_PACK_OPTIONS.map(p => p.id)).toEqual([
      'general-discovery-blank',
      'website-greenfield',
      'website-takeover',
      'workflow-automation',
      'technology-ownership',
    ]);
    expect(new Set(LIVE_INTERVIEW_PACK_OPTIONS.map(p => p.id)).size).toBe(5);
    expect(DEFAULT_INTERVIEW_PACK_ID).toBe('general-discovery-blank');
    expect(defaultLiveInterviewPack().knownFacts).toEqual([]);
    for (const option of LIVE_INTERVIEW_PACK_OPTIONS) {
      const pack = findLiveInterviewPack(option.id)!;
      expect(pack.title).toBe(option.title);
      expect(pack.knownFacts).toEqual([]);
      expect(pack.questions.length).toBe(option.questions);
      expect(pack.questions.length).toBeGreaterThanOrEqual(5);
      expect(pack.sections.length).toBeGreaterThanOrEqual(2);
      expect(new Set(pack.questions.map(q => q.id)).size).toBe(pack.questions.length);
      expect(new Set(pack.sections.map(s => s.id)).size).toBe(pack.sections.length);
      for (const question of pack.questions) {
        expect(pack.sections.some(s => s.id === question.sectionId)).toBe(true);
        if (question.condition) {
          const parent = pack.questions.find(q => q.id === question.condition!.questionId);
          expect(parent?.kind).toBe('single');
          expect(parent?.options).toContain(question.condition.equals);
        }
      }
    }
  });

  it('pins independent full-schema 1.3 sessions for every pack, with no accepted fact or answer', async () => {
    const allIds = new Set<string>();
    for (const option of LIVE_INTERVIEW_PACK_OPTIONS) {
      const source = findLiveInterviewPack(option.id)!;
      const interview = await createSemanticSession(source, {
        clientLabel: 'SYNTHETIC PACK TEST',
      }, new Date('2026-11-09T10:00:00.000Z'));
      await expect(validateSemanticSessionRecord(interview)).resolves.toEqual(interview);
      expect(interview.interviewPackId).toBe(option.id);
      expect(interview.packSnapshot.title).toBe(source.title);
      expect(interview.knownFacts).toEqual([]);
      expect(interview.packSnapshot.knownFacts).toEqual([]);
      expect(interview.packIdentity.digest).toMatch(/^[a-f0-9]{64}$/);
      expect(allIds.has(interview.packIdentity.digest)).toBe(false);
      allIds.add(interview.packIdentity.digest);
      expect(Object.keys(interview.answers)).toHaveLength(source.questions.length);
      for (const answer of Object.values(interview.answers)) {
        expect(answer).toMatchObject({
          value: null, source: null, resolution: 'unresolved',
          needsConfirmation: false, confirmation: null, followUp: null,
        });
      }
      expect(visibleQuestions(interview).length).toBeLessThanOrEqual(source.questions.length);
    }
  });

  it('uses pinned pack snapshots, not mutable catalog entries, after sessions are created', async () => {
    const source = findLiveInterviewPack('website-takeover')!;
    const session = await createSemanticSession(source, {
      clientLabel: 'SYNTHETIC PINNED TAKEOVER',
    }, new Date('2026-11-09T10:00:00.000Z'));
    const baseline = canonicalizeJson(session);
    source.questions[0]!.prompt = 'SYNTHETIC EDIT OUTSIDE PINNED SNAPSHOT';
    source.knownFacts.push({
      id: 'test-only', label: 'Untrusted', value: 'Never copy',
      provenance: 'SYNTHETIC SOURCE',
    });
    expect(canonicalizeJson(session)).toBe(baseline);
    const reselected = findLiveInterviewPack('website-takeover')!;
    expect(reselected.knownFacts).toEqual([]);
    expect(reselected.questions[0]?.prompt).not.toContain('EDIT');
  });

  it('does not expose legacy synthetic-fact demo as a live new-interview option', () => {
    expect(findLiveInterviewPack('general-discovery')).toBeNull();
    for (const invalid of [null, undefined, {}, [], '__proto__', 'constructor', 'website-greenfield/../secret']) {
      expect(findLiveInterviewPack(invalid)).toBeNull();
    }
  });

  it('conditional questions remain hidden until the operator supplies a qualifying answer', async () => {
    const pack = findLiveInterviewPack('website-greenfield')!;
    const session = await createSemanticSession(pack, {
      clientLabel: 'SYNTHETIC CONDITIONAL JOURNEY',
    });
    // The live app deliberately displays pending questions until the trigger
    // is resolved. They are not yet relevant or accepted as client facts.
    expect(relevanceMap(session)['booking-details']).toBe('pending');
    expect(visibleQuestions(session).some(x => x.id === 'booking-details')).toBe(true);
    session.answers['needs-booking']!.value = 'Yes';
    session.answers['needs-booking']!.resolution = 'captured';
    session.answers['needs-booking']!.source = 'client-statement';
    expect(relevanceMap(session)['booking-details']).toBe('relevant');
    expect(visibleQuestions(session).some(x => x.id === 'booking-details')).toBe(true);
  });
});

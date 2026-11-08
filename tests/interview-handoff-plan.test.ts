import { describe, expect, it } from 'vitest';
import { generalDiscoveryPack } from '../src/pack';
import { createSemanticSession, type SemanticInterviewSession } from '../src/semantic-session';
import { exportCanonicalSessionJsonForReview } from '../src/versioned-session-io';
import { semanticSessionToMarkdown } from '../src/markdown';
import {
  INTERVIEW_HANDOFF_PLAN_VERSION,
  planPrivateInterviewHandoffForReview,
  type PrivateHandoffScope,
} from '../src/interview-handoff-plan';

async function fixture(): Promise<{ session: SemanticInterviewSession; scope: PrivateHandoffScope }> {
  const session = await createSemanticSession(generalDiscoveryPack, {
    clientLabel: 'SYNTHETIC PRIVATE CLIENT — NEVER IN OWNER CONSOLE',
  }, new Date('2026-11-08T15:00:00.000Z'));
  session.runningNotes = 'SYNTHETIC PRIVATE RUNNING NOTES';
  session.answers['primary-goal']!.value = 'SYNTHETIC INTERVIEW GOAL';
  session.answers['primary-goal']!.resolution = 'captured';
  session.answers['primary-goal']!.source = 'client-statement';
  session.answers['primary-goal']!.followUp = {
    action: 'SYNTHETIC PROPOSED NEXT STEP',
    owner: 'SYNTHETIC INTERNAL OWNER',
  };
  return {
    session,
    scope: {
      engagementRef: 'synthetic-engagement-01',
      expectedSessionId: session.sessionId,
      expectedRevisionId: session.revisionId,
      expectedPackDigest: session.packIdentity.digest,
      operatorReviewedForDraft: true,
    },
  };
}

describe('Interview post-session handoff SOURCE ONLY — no writer/transport', () => {
  it('proposes exactly 3 confidential deterministic artifacts and no external action', async () => {
    const { session, scope } = await fixture();
    const original = structuredClone(session);
    const first = await planPrivateInterviewHandoffForReview(session, scope);
    const again = await planPrivateInterviewHandoffForReview(structuredClone(session), structuredClone(scope));
    expect(first).toEqual(again);
    expect(session).toEqual(original);
    expect(first.schemaVersion).toBe(INTERVIEW_HANDOFF_PLAN_VERSION);
    expect(first.kind).toBe('private-review-only-no-provider-write');
    expect(first.notice).toContain('No upload, task, client approval or commitment');
    expect(first.artifacts.map(x => x.kind)).toEqual([
      'canonical-json', 'internal-markdown', 'follow-up-proposals',
    ]);
    expect(new Set(first.artifacts.map(x => x.idempotencyKey)).size).toBe(3);
    for (const artifact of first.artifacts) {
      expect(artifact.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
      expect(artifact.contentDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(artifact.bytes).toBe(new TextEncoder().encode(artifact.content).byteLength);
      expect(artifact.bytes).toBeGreaterThan(0);
    }
    expect(first.artifacts[0]!.content).toBe(await exportCanonicalSessionJsonForReview(session));
    expect(first.artifacts[1]!.content).toBe(semanticSessionToMarkdown(session));
    expect(first.artifacts[0]!.content).toContain('SYNTHETIC PRIVATE RUNNING NOTES');
    expect(first.artifacts[2]!.content).toContain('SYNTHETIC PROPOSED NEXT STEP');
    expect(first.nextSteps.items).toHaveLength(1);
  });

  it('rejects missing acknowledgement; an operator click is not client approval', async () => {
    const { session, scope } = await fixture();
    await expect(planPrivateInterviewHandoffForReview(session, {
      ...scope, operatorReviewedForDraft: false,
    })).rejects.toThrow('explicit operator review');
    await expect(planPrivateInterviewHandoffForReview(session, {
      ...scope, operatorReviewedForDraft: null,
    })).rejects.toThrow('explicit operator review');
    await expect(planPrivateInterviewHandoffForReview(session, {
      ...scope, extra: 'SYNTHETIC UNTRUSTED FIELD',
    })).rejects.toThrow('missing or unsupported');
  });

  it('rejects cross-session, stale-revision and incorrect pinned-pack inputs before building output', async () => {
    const { session, scope } = await fixture();
    await expect(planPrivateInterviewHandoffForReview(session, {
      ...scope, expectedSessionId: 'another-synthetic-client-session',
    })).rejects.toThrow('identity changed');
    await expect(planPrivateInterviewHandoffForReview(session, {
      ...scope, expectedRevisionId: 'stale-synthetic-revision',
    })).rejects.toThrow('identity changed');
    await expect(planPrivateInterviewHandoffForReview(session, {
      ...scope, expectedPackDigest: 'a'.repeat(64),
    })).rejects.toThrow('identity changed');
    const newer = structuredClone(session);
    newer.revisionId = 'synthetic-revision-changed';
    await expect(planPrivateInterviewHandoffForReview(newer, scope))
      .rejects.toThrow('identity changed');
  });

  it.each(['../../../outside', '../', ' engagement name', 'a?secret=b', 'a/b', ''])(
    'rejects path/URL/client-label-like engagement ref %s', async (bad) => {
      const { session, scope } = await fixture();
      await expect(planPrivateInterviewHandoffForReview(session, {
        ...scope, engagementRef: bad,
      })).rejects.toThrow('bounded opaque ID');
    },
  );

  it('changes delivery keys when a revision or content changes, never silently overwrites', async () => {
    const { session, scope } = await fixture();
    const original = await planPrivateInterviewHandoffForReview(session, scope);
    const revised = structuredClone(session);
    revised.runningNotes = 'SYNTHETIC CHANGED PRIVATE NOTES';
    revised.parentRevisionId = revised.revisionId;
    revised.revisionId = 'synthetic-next-revision';
    const next = await planPrivateInterviewHandoffForReview(revised, {
      ...scope, expectedRevisionId: revised.revisionId,
    });
    expect(next.artifacts[0]!.idempotencyKey).not.toEqual(original.artifacts[0]!.idempotencyKey);
    expect(next.artifacts[1]!.contentDigest).not.toEqual(original.artifacts[1]!.contentDigest);
    const unversionedEdit = structuredClone(session);
    unversionedEdit.runningNotes = 'SYNTHETIC UNVERSIONED PRIVATE EDIT';
    const changed = await planPrivateInterviewHandoffForReview(unversionedEdit, scope);
    expect(changed.artifacts[0]!.idempotencyKey).not.toEqual(original.artifacts[0]!.idempotencyKey);
    expect(changed.artifacts[1]!.idempotencyKey).not.toEqual(original.artifacts[1]!.idempotencyKey);
  });

  it('excludes hidden-branch proposals while preserving raw historical state in private JSON', async () => {
    const { session, scope } = await fixture();
    session.answers['needs-booking'] = {
      value: 'No', resolution: 'captured', source: 'client-statement',
      needsConfirmation: false, confirmation: null, note: '', followUp: null,
    };
    session.answers['booking-process']!.followUp = {
      action: 'SYNTHETIC HIDDEN FOLLOW-UP NOT FOR ROUTING',
    };
    const plan = await planPrivateInterviewHandoffForReview(session, scope);
    expect(plan.artifacts[0]!.content).toContain('SYNTHETIC HIDDEN FOLLOW-UP NOT FOR ROUTING');
    expect(plan.artifacts[2]!.content).not.toContain('SYNTHETIC HIDDEN FOLLOW-UP NOT FOR ROUTING');
    expect(JSON.stringify(plan.nextSteps)).not.toContain('SYNTHETIC HIDDEN FOLLOW-UP NOT FOR ROUTING');
  });

  it('changes per-artifact retry identity across engagement scopes even for same session', async () => {
    const { session, scope } = await fixture();
    const a = await planPrivateInterviewHandoffForReview(session, scope);
    const b = await planPrivateInterviewHandoffForReview(session, {
      ...scope, engagementRef: 'another-synthetic-authorized-engagement',
    });
    expect(a.artifacts[0]!.idempotencyKey).not.toBe(b.artifacts[0]!.idempotencyKey);
    expect(a.artifacts[0]!.contentDigest).toBe(b.artifacts[0]!.contentDigest);
    expect(b.engagementRef).toBe('another-synthetic-authorized-engagement');
    // IMPORTANT: scope is an opaque caller assertion, NOT authorization proof.
  });
});

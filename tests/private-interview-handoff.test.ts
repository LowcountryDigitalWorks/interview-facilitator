import { describe, expect, it } from 'vitest';
import { generalDiscoveryPack } from '../src/pack';
import { createSemanticSession } from '../src/semantic-session';
import { canonicalizeJson, sha256Hex } from '../src/pack-identity';
import {
  buildPrivateInterviewHandoffForReview,
  validatePrivateInterviewHandoffForReview,
  PRIVATE_INTERVIEW_HANDOFF_VERSION,
} from '../src/private-interview-handoff';

async function fixture() {
  const session = await createSemanticSession(generalDiscoveryPack, {
    clientLabel: 'SYNTHETIC CONFIDENTIAL INTERVIEW',
  }, new Date('2026-11-09T09:00:00.000Z'));
  session.runningNotes = 'SYNTHETIC INTERNAL CONTEXT NOT FOR A CLIENT';
  session.answers['existing-presence']!.note = 'SYNTHETIC PRIVATE QUESTION NOTE';
  session.answers['primary-goal']!.value = 'SYNTHETIC CLIENT ACTUALLY CONFIRMED';
  session.answers['primary-goal']!.source = 'client-statement';
  session.answers['primary-goal']!.resolution = 'captured';
  session.answers['primary-goal']!.followUp = {
    action: 'SYNTHETIC PREPARE WEBSITE ASSESSMENT',
    owner: 'SYNTHETIC INTERNAL TEAM',
    dueDate: 'after owner handover / TBD',
  };
  // Retained hidden evidence belongs in confidential CANONICAL archival
  // truth, not the current workflow's action proposal.
  session.answers['needs-booking']!.value = 'No';
  session.answers['needs-booking']!.source = 'client-statement';
  session.answers['needs-booking']!.resolution = 'captured';
  session.answers['booking-process']!.followUp = {
    action: 'SYNTHETIC INACTIVE ACTION — NOT WORKFLOW READY',
  };
  return session;
}

describe('private offline handoff bundle, no provider I/O', () => {
  it('produces a deterministic private canonical 1.3 + internal Markdown + approved-shape proposed steps', async () => {
    const session = await fixture();
    const prior = canonicalizeJson(session);
    const first = await buildPrivateInterviewHandoffForReview(session);
    const second = await buildPrivateInterviewHandoffForReview(structuredClone(session));
    expect(first).toBe(second);
    expect(canonicalizeJson(session)).toBe(prior);
    expect(first.endsWith('\n')).toBe(true);
    const bundle = await validatePrivateInterviewHandoffForReview(first);
    expect(bundle.schemaVersion).toBe(PRIVATE_INTERVIEW_HANDOFF_VERSION);
    expect(bundle.kind).toBe('private-human-review-only');
    expect(bundle.source).toEqual({
      sessionId: session.sessionId,
      revisionId: session.revisionId,
      packDigest: session.packIdentity.digest,
      updatedAt: session.updatedAt,
      canonicalSha256: await sha256Hex(canonicalizeJson(session)),
    });
    expect(bundle.canonicalSession).toEqual(session);
    expect(bundle.internalMarkdown).toContain('SYNTHETIC PRIVATE QUESTION NOTE');
    expect(bundle.internalMarkdown).toContain('SYNTHETIC INTERNAL CONTEXT');
    expect(bundle.proposedNextSteps.items).toEqual([{
      questionId: 'primary-goal',
      action: 'SYNTHETIC PREPARE WEBSITE ASSESSMENT',
      owner: 'SYNTHETIC INTERNAL TEAM',
      dueDate: 'after owner handover / TBD',
    }]);
    expect(canonicalizeJson(bundle.canonicalSession)).toContain('SYNTHETIC INACTIVE ACTION');
    expect(canonicalizeJson(bundle.proposedNextSteps)).not.toContain('SYNTHETIC INACTIVE ACTION');
    expect(bundle.notice).toContain('not a task approval');
  });

  it('rejects mutated canonical session, Markdown, proposals, and source identity', async () => {
    const bytes = await buildPrivateInterviewHandoffForReview(await fixture());
    const tamper = async (mutate: (value: Record<string, any>) => void) => {
      const raw = JSON.parse(bytes) as Record<string, any>;
      mutate(raw);
      await expect(validatePrivateInterviewHandoffForReview(canonicalizeJson(raw) + '\n'))
        .rejects.toThrow();
    };
    await tamper(raw => { raw.canonicalSession.runningNotes = 'SYNTHETIC TAMPERED'; });
    await tamper(raw => { raw.internalMarkdown = 'SYNTHETIC REPLACED SUMMARY'; });
    await tamper(raw => { raw.proposedNextSteps.items[0].action = 'SYNTHETIC FAKE APPROVAL'; });
    await tamper(raw => { raw.source.revisionId = 'synthetic-fake-revision'; });
    await tamper(raw => { raw.source.canonicalSha256 = '0'.repeat(64); });
    await tamper(raw => { raw.secret = 'unsupported synthetic data'; });
    await tamper(raw => { raw.source.secret = 'unsupported source field'; });
    await tamper(raw => { raw.schemaVersion = 'ldw.interview-private-handoff.v2'; });
  });

  it('fails closed on noncanonical/malformed, oversized, missing or non-string imports', async () => {
    const bytes = await buildPrivateInterviewHandoffForReview(await fixture());
    await expect(validatePrivateInterviewHandoffForReview(bytes.trimEnd()))
      .rejects.toThrow('canonical JSON text');
    await expect(validatePrivateInterviewHandoffForReview(' ' + bytes))
      .rejects.toThrow('content/proposal mismatch');
    await expect(validatePrivateInterviewHandoffForReview('not-json\n'))
      .rejects.toThrow('malformed JSON');
    await expect(validatePrivateInterviewHandoffForReview(null))
      .rejects.toThrow('canonical JSON text');
    await expect(validatePrivateInterviewHandoffForReview('X'.repeat(5_000_100) + '\n'))
      .rejects.toThrow('size bound');
    await expect(buildPrivateInterviewHandoffForReview({
      ...await fixture(), sessionSchemaVersion: '9.0.0',
    })).rejects.toThrow();
  });

  it('rejects oversized producer source before canonicalizing private derived artifacts', async () => {
    const session = await fixture();
    const originalSessionId = session.sessionId;
    session.runningNotes = 'SYNTHETIC OVERSIZED PRIVATE NOTES ' + 'x'.repeat(5_000_200);
    await expect(buildPrivateInterviewHandoffForReview(session))
      .rejects.toThrow('source exceeds safe input limits');
    expect(session.sessionId).toBe(originalSessionId);
    expect(session.runningNotes).toHaveLength(5_000_234);
    // The producer resource preflight also rejects accessor-based input
    // without reading the getter or exposing its private data.
    const accessorSession = await fixture();
    let getterRead = false;
    Object.defineProperty(accessorSession, 'runningNotes', {
      enumerable: true,
      get() { getterRead = true; throw new Error('SYNTHETIC PRIVATE GETTER'); },
    });
    await expect(buildPrivateInterviewHandoffForReview(accessorSession))
      .rejects.toThrow('source exceeds safe input limits');
    expect(getterRead).toBe(false);
  });

  it('returns a full private bundle with zero workflow tasks when no proposals exist', async () => {
    const session = await createSemanticSession(generalDiscoveryPack, {
      clientLabel: 'SYNTHETIC EMPTY OUTPUT',
    });
    const bundle = await validatePrivateInterviewHandoffForReview(
      await buildPrivateInterviewHandoffForReview(session),
    );
    expect(bundle.proposedNextSteps.items).toEqual([]);
    expect(bundle.canonicalSession.answers['primary-goal']?.value).toBeNull();
    expect(bundle.notice).toContain('provider write');
  });
});

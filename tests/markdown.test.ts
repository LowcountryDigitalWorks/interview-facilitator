import { describe, expect, it } from 'vitest';
import { validateSessionShape } from '../src/domain';
import { createPinnedSession } from '../src/pack-identity';
import { generalDiscoveryPack as pack } from '../src/pack';
import { semanticSessionToMarkdown, serializeSession, sessionToMarkdown } from '../src/markdown';
import { createSemanticSession, validateSemanticSessionRecord } from '../src/semantic-session';

describe('deterministic exports', () => {
  it('preserves semantic session state through JSON round trip', async () => {
    const session = await createPinnedSession(pack, { clientLabel: 'Synthetic Client', interviewerLabel: 'Interviewer' }, new Date('2026-10-31T12:00:00Z'));
    session.answers['primary-goal']!.value = 'Launch a useful first version.';
    session.answers['primary-goal']!.status = 'ANSWERED';
    const restored = validateSessionShape(JSON.parse(serializeSession(session)));
    expect(restored).toEqual(session);
  });

  it('generates byte-identical Markdown for unchanged canonical state', async () => {
    const session = await createPinnedSession(pack, { clientLabel: 'Synthetic Client' }, new Date('2026-10-31T12:00:00Z'));
    session.answers['existing-presence']!.value = 'A basic public website already exists.';
    session.answers['existing-presence']!.status = 'ALREADY_KNOWN';
    expect(sessionToMarkdown(session)).toBe(sessionToMarkdown(session));
  });

  it('includes visible question notes and inactive preserved answers in the internal Markdown artifact', async () => {
    const session = await createPinnedSession(pack, { clientLabel: 'Synthetic Client' }, new Date('2026-10-31T12:00:00Z'));
    session.answers['primary-goal']!.value = 'Launch a useful first version.';
    session.answers['primary-goal']!.status = 'ANSWERED';
    session.answers['primary-goal']!.note = 'Internal rationale for the current priority.';

    // booking-process is hidden while needs-booking is not Yes, but retained state is still internal evidence.
    session.answers['booking-process']!.value = 'Retained scheduling detail.';
    session.answers['booking-process']!.status = 'MUST_CONFIRM';
    session.answers['booking-process']!.note = 'Re-check if booking becomes relevant again.';
    session.runningNotes = 'Internal follow-up note.';

    const markdown = sessionToMarkdown(session);

    expect(markdown).toContain('**Internal note:**');
    expect(markdown).toContain('Internal rationale for the current priority.');
    expect(markdown).toContain('## Inactive / hidden preserved answers');
    expect(markdown).toContain('How should booking or scheduling work?');
    expect(markdown).toContain('Retained scheduling detail.');
    expect(markdown).toContain('Re-check if booking becomes relevant again.');
    expect(markdown).toContain('## Internal running notes');
    expect(markdown).toContain('Internal follow-up note.');
  });

  it('does not add an empty hidden question to the historical-evidence section', async () => {
    const session = await createPinnedSession(pack, { clientLabel: 'Synthetic Client' }, new Date('2026-10-31T12:00:00Z'));
    const markdown = sessionToMarkdown(session);

    expect(markdown).not.toContain('## Inactive / hidden preserved answers');
    expect(markdown).not.toContain('How should booking or scheduling work?');
  });

  it('defensively ignores a malformed non-string note instead of failing the internal export', async () => {
    const session = await createPinnedSession(pack, { clientLabel: 'Synthetic Client' }, new Date('2026-10-31T12:00:00Z'));
    (session.answers['primary-goal'] as unknown as { note: unknown }).note = 42;

    expect(() => sessionToMarkdown(session)).not.toThrow();
  });

  it('round-trips canonical 1.3 JSON without losing semantic answer dimensions', async () => {
    const session = await createSemanticSession(pack, { clientLabel: 'Semantic Client' }, new Date('2026-11-03T05:00:00Z'));
    session.answers['primary-goal'] = {
      value: 'Ship the semantic activation.',
      resolution: 'captured',
      source: 'client-statement',
      needsConfirmation: true,
      confirmation: null,
      followUp: { action: 'Confirm scope', owner: 'Interviewer' },
      note: 'Internal semantic note.',
    };
    const restored = await validateSemanticSessionRecord(JSON.parse(serializeSession(session)));
    expect(restored).toEqual(session);
  });

  it('labels retained non-effective values and inactive evidence clearly in canonical 1.3 Markdown', async () => {
    const session = await createSemanticSession(pack, { clientLabel: 'Semantic Markdown' }, new Date('2026-11-03T05:00:00Z'));
    session.answers['needs-booking'] = {
      value: 'No', resolution: 'captured', source: 'client-statement', needsConfirmation: false,
      confirmation: null, followUp: null, note: '',
    };
    session.answers['booking-process'] = {
      value: 'Retained booking detail', resolution: 'deferred', source: 'client-statement', needsConfirmation: false,
      confirmation: null, followUp: { action: 'Revisit only if booking returns' }, note: 'Inactive internal note.',
    };
    session.answers['primary-goal'] = {
      value: 'Retained N/A detail', resolution: 'not-applicable', source: 'client-statement', needsConfirmation: false,
      confirmation: null, followUp: null, note: '',
    };

    const markdown = semanticSessionToMarkdown(session);
    expect(markdown).toContain('## Inactive / hidden preserved answers');
    expect(markdown).toContain('Retained booking detail');
    expect(markdown).toContain('**Retained internal value (not effective evidence):**');
    expect(markdown).toContain('**Status:** Deferred');
    expect(markdown).toContain('**Status:** Not applicable');
    expect(markdown).toContain('Inactive internal note.');
    expect(markdown).toBe(semanticSessionToMarkdown(session));
  });
});

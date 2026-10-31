import { describe, expect, it } from 'vitest';
import { createSession, validateSessionShape } from '../src/domain';
import { generalDiscoveryPack as pack } from '../src/pack';
import { serializeSession, sessionToMarkdown } from '../src/markdown';

describe('deterministic exports', () => {
  it('preserves semantic session state through JSON round trip', () => {
    const session = createSession(pack, { clientLabel: 'Synthetic Client', interviewerLabel: 'Interviewer' }, new Date('2026-10-31T12:00:00Z'));
    session.answers['primary-goal']!.value = 'Launch a useful first version.';
    session.answers['primary-goal']!.status = 'ANSWERED';
    const restored = validateSessionShape(JSON.parse(serializeSession(session)));
    expect(restored).toEqual(session);
  });

  it('generates byte-identical Markdown for unchanged canonical state', () => {
    const session = createSession(pack, { clientLabel: 'Synthetic Client' }, new Date('2026-10-31T12:00:00Z'));
    session.answers['existing-presence']!.value = 'A basic public website already exists.';
    session.answers['existing-presence']!.status = 'ALREADY_KNOWN';
    expect(sessionToMarkdown(pack, session)).toBe(sessionToMarkdown(pack, session));
  });

  it('makes the full internal Markdown artifact explicit while client-safe read-back remains a separate UI surface', () => {
    const session = createSession(pack, { clientLabel: 'Synthetic Client' }, new Date('2026-10-31T12:00:00Z'));
    session.runningNotes = 'Internal follow-up note.';
    const markdown = sessionToMarkdown(pack, session);
    expect(markdown).toContain('## Internal running notes');
    expect(markdown).toContain('Internal follow-up note.');
  });
});

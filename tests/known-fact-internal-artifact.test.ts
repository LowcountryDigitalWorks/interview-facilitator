import { describe, expect, it } from 'vitest';
import { knownFact14EvidenceAppendixForReview } from '../src/known-fact-internal-artifact';
import { acceptKnownFact, correctKnownFact, projectAcceptedKnownFact } from '../src/known-fact-evidence';
import { migrateSemantic13ToKnownFact14 } from '../src/known-fact-session';
import { generalDiscoveryPack } from '../src/pack';
import { createSemanticSession } from '../src/semantic-session';

const AT = '2026-11-04T20:00:00.000Z';

async function base14() {
  const source = await createSemanticSession(
    generalDiscoveryPack, { clientLabel: 'Synthetic 1.4 internal artifact' }, new Date(AT),
  );
  source.knownFacts.push({
    id: 'source-1', label: 'Platform', value: 'Legacy product', provenance: 'Synthetic questionnaire',
    questionId: 'existing-presence',
  });
  return migrateSemantic13ToKnownFact14(source);
}

describe('#35A internal 1.4 provenance artifact foundation', () => {
  it('is deterministic, non-mutating and includes historical acceptance and correction lineage', async () => {
    const session = await base14();
    session.knownFactLedger = acceptKnownFact(session.knownFactLedger, {
      id: 'accept-1', factId: 'source-1', acceptedAt: AT,
      expectedRevisionId: session.revisionId, currentRevisionId: session.revisionId,
    });
    session.knownFactLedger = correctKnownFact(session.knownFactLedger, {
      id: 'corrected-1', supersedesFactId: 'source-1',
      value: 'Newer synthetic source value', provenance: 'Human-reviewed correction',
      sourceReference: 'Synthetic private reference',
      expectedRevisionId: session.revisionId, currentRevisionId: session.revisionId,
    });
    const before = structuredClone(session);
    const markdown = await knownFact14EvidenceAppendixForReview(session);
    expect(markdown).toContain('INTERNAL / CONFIDENTIAL');
    expect(markdown).toContain('Source and corrected facts');
    expect(markdown).toContain('Human acceptance events (historical, not client confirmation)');
    expect(markdown).toContain('accept\\-1');
    expect(markdown).toContain('corrected\\-1');
    expect(markdown).toContain('Superseded');
    expect(markdown).toContain('Human\\-reviewed correction');
    expect(markdown).toContain('Newer synthetic source value');
    expect(markdown).toContain('Synthetic private reference');
    expect(markdown).toBe(await knownFact14EvidenceAppendixForReview(session));
    expect(session).toEqual(before);
  });

  it('shows accepted links and human-review state without claiming client confirmation', async () => {
    const session = await base14();
    session.knownFactLedger = acceptKnownFact(session.knownFactLedger, {
      id: 'accept-1', factId: 'source-1', acceptedAt: AT,
      expectedRevisionId: session.revisionId, currentRevisionId: session.revisionId,
    });
    const result = projectAcceptedKnownFact(
      session.knownFactLedger, 'accept-1', 'existing-presence', { kind: 'text' },
      session.answers['existing-presence']!,
    );
    session.answers['existing-presence'] = { ...session.answers['existing-presence']!, ...result.answer };
    session.knownFactAnswerLinks['existing-presence'] = {
      kind: 'accepted', factId: 'source-1', acceptanceId: 'accept-1',
    };
    const output = await knownFact14EvidenceAppendixForReview(session);
    expect(output).toContain('Current answer provenance links');
    expect(output).toContain('existing\\-presence');
    expect(output).toContain('Human acceptance events');
    expect(output).toContain('not client confirmation');
    expect(output).toContain('Needs human confirmation');
  });

  it('preserves legacy-unverified distinction without inventing an acceptance event', async () => {
    const source = await createSemanticSession(
      generalDiscoveryPack, { clientLabel: 'Synthetic legacy' }, new Date(AT),
    );
    source.answers['existing-presence'] = {
      value: 'Old website', resolution: 'captured', source: 'accepted-known-fact',
      needsConfirmation: true, confirmation: null, followUp: null, note: '',
    };
    const session = await migrateSemantic13ToKnownFact14(source);
    const markdown = await knownFact14EvidenceAppendixForReview(session);
    expect(markdown).toContain('legacy\\-unverified');
    expect(markdown).toContain('Legacy evidence has no verified acceptance event');
    expect(markdown).toContain('**Needs human confirmation:** Yes');
  });

  it('escapes untrusted HTML, Markdown controls and multiline values as inert text', async () => {
    const session = await base14();
    session.knownFactLedger.facts[0]!.value = '# Forged heading\n<script>alert(1)</script>';
    session.knownFacts[0]!.value = '# Forged heading\n<script>alert(1)</script>';
    const markdown = await knownFact14EvidenceAppendixForReview(session);
    expect(markdown).toContain('> \\# Forged heading');
    expect(markdown).toContain('&lt;script&gt;alert\\(1\\)&lt;/script&gt;');
    expect(markdown).not.toContain('<script>');
    expect(markdown).not.toContain('\n# Forged heading');
  });

  it('rejects legacy or malformed 1.4 records without producing an artifact', async () => {
    const legacy = await createSemanticSession(
      generalDiscoveryPack, { clientLabel: 'Synthetic old' }, new Date(AT),
    );
    await expect(knownFact14EvidenceAppendixForReview(legacy)).rejects.toThrow(/schema version/i);
    const session = await base14();
    await expect(knownFact14EvidenceAppendixForReview({
      ...session, unapprovedField: 'would be omitted silently',
    })).rejects.toThrow(/unsupported field/i);
  });

  it('keeps setext-like lines, bare URLs and unusual line separators inert', async () => {
    const session = await base14();
    const unsafe = 'Status\\n===\\nhttps://example.test/path\\nwww.example.test\\nuser@example.test';
    const unicode = 'Before\\u2028middle\\u0085after';
    session.knownFacts[0]!.value = unsafe;
    session.knownFactLedger.facts[0]!.value = unsafe;
    session.knownFacts[0]!.provenance = unicode;
    session.knownFactLedger.facts[0]!.provenance = unicode;

    const output = await knownFact14EvidenceAppendixForReview(session);
    expect(output).toContain('\\=\\=\\=');
    expect(output).not.toContain('\\n===\\n');
    expect(output).not.toContain('https://example.test');
    expect(output).toContain('https\\:');
    expect(output).not.toContain('www.example.test');
    expect(output).not.toContain('user@example.test');
    expect(output).not.toContain('\\u2028');
    expect(output).not.toContain('\\u0085');
    expect(output).toContain('u2028');
    expect(output).toContain('u0085');
  });
});

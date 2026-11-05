import { validateKnownFactSession14Record } from './known-fact-session';

/**
 * #35A — deterministic, INTERNAL-only provenance appendix for canonical 1.4.
 *
 * This is a human-readable derivative, never a restore format, never a client
 * Read-back projection, and deliberately not wired to the live 1.3 app.
 * Canonical JSON remains the complete session/evidence source of truth.
 */

function escapeMarkdown(value: string): string {
  return value
    // Expose non-ASCII line separator/control characters as visible codepoints.
    // The original raw values remain losslessly available in canonical JSON.
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u0085/g, '\\u0085')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([\\`*_{}\[\]()#+\-.!|~=:@])/g, '\\$1');
}

function inline(value: string): string {
  return escapeMarkdown(value.replace(/\r\n?/g, '\n').replace(/\n/g, ' ↵ '));
}

function field(lines: string[], label: string, value: string | undefined): void {
  lines.push(`- **${label}:** ${inline(value ?? 'Not recorded')}`);
}

function quotedValue(lines: string[], label: string, value: string): void {
  lines.push(`**${label}:**`, '');
  for (const line of value.replace(/\r\n?/g, '\n').split('\n')) {
    // Escaped blockquote text cannot create HTML, headings or task controls.
    lines.push(`> ${escapeMarkdown(line)}`);
  }
  lines.push('');
}

export async function knownFact14EvidenceAppendixForReview(raw: unknown): Promise<string> {
  const session = await validateKnownFactSession14Record(raw);
  const ledger = session.knownFactLedger;
  const superseded = new Set(ledger.facts.flatMap((fact) =>
    fact.supersedesFactId === undefined ? [] : [fact.supersedesFactId]));
  const questionLabels = new Map(session.packSnapshot.questions.map((question) =>
    [question.id, question.prompt] as const));

  const lines: string[] = [
    '## Internal 1.4 known-fact provenance appendix',
    '',
    '**INTERNAL / CONFIDENTIAL — not a client Read-back or restore file.**',
    '',
  ];
  field(lines, 'Session ID', session.sessionId);
  field(lines, 'Schema', session.sessionSchemaVersion);
  field(lines, 'Revision', session.revisionId);
  field(lines, 'Parent revision', session.parentRevisionId ?? 'None');
  lines.push('', '### Source and corrected facts', '');
  if (ledger.facts.length === 0) lines.push('_None._', '');

  for (const [index, fact] of ledger.facts.entries()) {
    lines.push(`#### Fact ${index + 1}`, '');
    field(lines, 'Fact ID', fact.id);
    field(lines, 'Label', fact.label);
    field(lines, 'Ledger status', superseded.has(fact.id) ? 'Superseded' : 'Current');
    field(lines, 'Question ID', fact.questionId);
    if (fact.questionId) field(lines, 'Question prompt', questionLabels.get(fact.questionId));
    field(lines, 'Provenance', fact.provenance);
    field(lines, 'Source reference', fact.sourceReference);
    field(lines, 'Observed at', fact.observedAt);
    field(lines, 'Recorded at', fact.recordedAt);
    field(lines, 'Supersedes fact ID', fact.supersedesFactId);
    lines.push('');
    quotedValue(lines, 'Evidence value snapshot', fact.value);
  }

  lines.push('### Human acceptance events (historical, not client confirmation)', '');
  if (ledger.acceptances.length === 0) lines.push('_None._', '');
  for (const [index, acceptance] of ledger.acceptances.entries()) {
    lines.push(`#### Acceptance ${index + 1}`, '');
    field(lines, 'Acceptance ID', acceptance.id);
    field(lines, 'Fact ID', acceptance.factId);
    field(lines, 'Source revision', acceptance.revisionId);
    field(lines, 'Accepted at', acceptance.acceptedAt);
    lines.push('');
    quotedValue(lines, 'Accepted value snapshot', acceptance.valueSnapshot);
  }

  lines.push('### Current answer provenance links', '');
  const links = Object.entries(session.knownFactAnswerLinks);
  if (links.length === 0) lines.push('_None._', '');
  for (const question of session.packSnapshot.questions) {
    const link = session.knownFactAnswerLinks[question.id];
    if (!link) continue;
    field(lines, 'Question', question.prompt);
    field(lines, 'Question ID', question.id);
    field(lines, 'Link kind', link.kind);
    if (link.kind === 'accepted') {
      field(lines, 'Fact ID', link.factId);
      field(lines, 'Acceptance ID', link.acceptanceId);
    } else {
      lines.push('- **Verification:** Legacy evidence has no verified acceptance event.');
    }
    field(lines, 'Needs human confirmation',
      session.answers[question.id]?.needsConfirmation ? 'Yes' : 'No');
    lines.push('');
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

import { coverage, coverageBucketMap, relevanceMap, semanticStatusLabel } from './live-session';
import { knownFact14EvidenceAppendixForReview } from './known-fact-internal-artifact';
import { validateKnownFactSession14Record } from './known-fact-session';
import type { Question } from './domain';
import type { SemanticAnswerState } from './semantic-session';

/** #35D: confidential, deterministic 1.4 report. No live UI, restore or client disclosure. */
function safe(value: string): string {
  return value.replace(/[\u000b\u000c\u0085\u2028\u2029]/g, (ch) =>
    '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'))
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/([\\\x60*_{}\[\]()#+\-.!|~:=@])/g, '\\$1');
}
function inline(value: string | undefined): string {
  return safe((value ?? 'Not recorded').replace(/\r\n?|\n/g, ' ↵ '));
}
function field(lines: string[], label: string, value: string | undefined): void {
  lines.push('- **' + label + ':** ' + inline(value));
}
function detail(lines: string[], label: string, value: string): void {
  lines.push('**' + label + ':**', '');
  for (const line of value.replace(/\r\n?/g, '\n').split('\n')) lines.push('> ' + safe(line));
  lines.push('');
}
function preserved(state: SemanticAnswerState | undefined): boolean {
  return Boolean(state && (state.value !== null || state.note.trim()
    || state.resolution !== 'unresolved' || state.source !== null
    || state.needsConfirmation || state.confirmation || state.followUp));
}
function evidenceSource(state: SemanticAnswerState): string {
  if (state.source === 'client-statement') return 'Recorded client statement (not signed)';
  if (state.source === 'accepted-known-fact') return 'Accepted known fact (see historical appendix)';
  if (state.source === 'interviewer-inference') return 'Interviewer inference (unconfirmed)';
  return 'Unestablished';
}
function addQuestion(lines: string[], question: Question, state: SemanticAnswerState | undefined,
  index: number, zone: 'current' | 'pending' | 'inactive'): void {
  lines.push('### Question ' + index, '');
  field(lines, 'Question', question.prompt);
  field(lines, 'Question ID', question.id);
  field(lines, 'Evidence zone', zone === 'current' ? 'Currently relevant'
    : zone === 'pending' ? 'Conditional / pending — NOT current' : 'Inactive / hidden — NOT current');
  if (!state) { field(lines, 'Status', 'Open (no stored answer)'); lines.push(''); return; }
  let status = semanticStatusLabel(question, state);
  if (state.resolution === 'captured' && (state.source === null
    || state.source === 'interviewer-inference')) status = 'Needs confirmation';
  field(lines, 'Effective status', zone === 'current' ? status : 'Not effective — ' + status);
  field(lines, 'Resolution', state.resolution);
  field(lines, 'Source classification', evidenceSource(state));
  field(lines, 'Needs human confirmation', state.needsConfirmation ? 'Yes' : 'No');
  if (state.confirmation) {
    field(lines, 'Recorded confirmation revision', state.confirmation.revisionId);
    field(lines, 'Recorded confirmation date', state.confirmation.confirmedAt);
    detail(lines, 'Historical confirmation value (internal)', state.confirmation.value);
  }
  if (state.value !== null) detail(lines,
    zone === 'current' && state.resolution === 'captured'
      ? 'Recorded answer (status above governs)' : 'Retained INTERNAL value (NOT current evidence)',
    state.value);
  else field(lines, 'Answer', 'No text recorded');
  if (state.followUp) {
    detail(lines, 'INTERNAL follow-up action', state.followUp.action);
    field(lines, 'INTERNAL follow-up owner', state.followUp.owner);
    field(lines, 'INTERNAL due date', state.followUp.dueDate);
  }
  if (state.note.trim()) detail(lines, 'INTERNAL question note', state.note);
  lines.push('');
}

/** Validated 1.4 only; never a restore, consent, completed lifecycle or public presentation. */
export async function knownFact14InternalInterviewReportForReview(raw: unknown): Promise<string> {
  const session = await validateKnownFactSession14Record(raw);
  const relevance = relevanceMap(session);
  const buckets = coverageBucketMap(session);
  const stats = coverage(session);
  const lines: string[] = [
    '# Internal interview evidence report — schema 1.4', '',
    '**INTERNAL / CONFIDENTIAL — not a client Read-back or restore file.**',
    '**This is not client confirmation, consent, signature or lifecycle completion.**', '',
  ];
  field(lines, 'Client label (internal)', session.clientLabel);
  field(lines, 'Session ID (internal)', session.sessionId);
  field(lines, 'Revision', session.revisionId);
  field(lines, 'Parent revision', session.parentRevisionId ?? 'None');
  field(lines, 'Pinned pack', session.packSnapshot.title);
  field(lines, 'Pack version', session.packSnapshot.packVersion);
  field(lines, 'Pack SHA-256 digest', session.packIdentity.digest);
  field(lines, 'Interviewer', session.interviewerLabel);
  field(lines, 'Interview mode', session.interviewMode);
  field(lines, 'Created', session.createdAt);
  field(lines, 'Updated', session.updatedAt);
  lines.push('', '## Current coverage (derived, not completed-state approval)', '');
  field(lines, 'Currently relevant objectives', String(stats.visible));
  field(lines, 'Current', String(stats.resolved));
  field(lines, 'Needs confirmation', String(stats.mustConfirm));
  field(lines, 'Open', String(stats.remaining));
  field(lines, 'Not applicable', String(stats.notApplicable));
  field(lines, 'Inactive and conditional', String(stats.inactive));
  lines.push('', '## Currently relevant questions', '');
  let count = 0;
  for (const section of session.packSnapshot.sections) {
    const questions = session.packSnapshot.questions.filter((q) =>
      q.sectionId === section.id && relevance[q.id] === 'relevant');
    if (questions.length === 0) continue;
    lines.push('### Section', '');
    field(lines, 'Title', section.title);
    lines.push('');
    for (const question of questions) {
      addQuestion(lines, question, session.answers[question.id], ++count, 'current');
    }
  }
  if (count === 0) lines.push('_None._', '');
  lines.push('## Currently relevant questions needing confirmation', '');
  const uncertain = session.packSnapshot.questions.filter((q) =>
    relevance[q.id] === 'relevant' && buckets[q.id] === 'needs-confirmation');
  if (uncertain.length === 0) lines.push('_None._', '');
  else for (const question of uncertain) field(lines, 'Needs confirmation', question.prompt);
  lines.push('', '## Conditional / pending questions — NOT current', '');
  const pending = session.packSnapshot.questions.filter((q) => relevance[q.id] === 'pending');
  if (pending.length === 0) lines.push('_None._', '');
  else pending.forEach((q, i) => addQuestion(lines, q, session.answers[q.id], i + 1, 'pending'));
  lines.push('## Inactive / hidden preserved evidence (internal history)', '');
  const inactive = session.packSnapshot.questions.filter((q) =>
    relevance[q.id] === 'irrelevant' && preserved(session.answers[q.id]));
  if (inactive.length === 0) lines.push('_None._', '');
  else inactive.forEach((q, i) => addQuestion(lines, q, session.answers[q.id], i + 1, 'inactive'));
  lines.push('## Internal running notes', '');
  if (session.runningNotes.trim()) detail(lines, 'INTERNAL running notes', session.runningNotes);
  else lines.push('_None._', '');
  lines.push('## Historical known-fact provenance (internal appendix follows)', '',
    'Historical interviewer acceptance is not client sign-off.', '');
  const appendix = await knownFact14EvidenceAppendixForReview(session);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n\n' + appendix.trimEnd() + '\n';
}

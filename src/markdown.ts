import type { InterviewSession, Question } from './domain';
import { sessionPack as legacySessionPack, visibleQuestions as legacyVisibleQuestions } from './domain';
import { coverageBucketMap, semanticStatusLabel, visibleQuestions as semanticVisibleQuestions } from './live-session';
import type { SemanticAnswerState, SemanticInterviewSession } from './semantic-session';

const legacyStatusLabel: Record<string, string> = {
  ANSWERED: 'Answered',
  ALREADY_KNOWN: 'Already known',
  SKIP: 'Skipped',
  N_A: 'Not applicable',
  MUST_CONFIRM: 'Must confirm'
};

export function serializeSession(session: InterviewSession | SemanticInterviewSession): string {
  return JSON.stringify(session, null, 2) + '\n';
}

function semanticNote(session: SemanticInterviewSession, questionId: string): string {
  return session.answers[questionId]?.note.trim() ?? '';
}

function appendSemanticQuestion(lines: string[], question: Question, session: SemanticInterviewSession): void {
  const state = session.answers[question.id];
  if (!state) return;
  const trimmedValue = state.value?.trim() ?? '';
  const value = trimmedValue || '_No answer recorded_';
  const note = semanticNote(session, question.id);
  lines.push(`### ${question.prompt}`, '', `**Status:** ${semanticStatusLabel(question, state)}`, '');
  if (trimmedValue && (state.resolution === 'deferred' || state.resolution === 'not-applicable')) {
    lines.push('**Retained internal value (not effective evidence):**', '', trimmedValue, '');
  } else {
    lines.push(value, '');
  }
  if (state.followUp) {
    const details = [state.followUp.action, state.followUp.owner ? `Owner: ${state.followUp.owner}` : '', state.followUp.dueDate ? `Due: ${state.followUp.dueDate}` : ''].filter(Boolean);
    lines.push('**Follow-up:**', '', details.join(' — '), '');
  }
  if (note) lines.push('**Internal note:**', '', note, '');
}

function hasSemanticPreservedState(state: SemanticAnswerState | undefined): boolean {
  return Boolean(state && (
    state.value?.trim()
    || state.note.trim()
    || state.resolution !== 'unresolved'
    || state.source !== null
    || state.needsConfirmation
    || state.confirmation
    || state.followUp
  ));
}

export function semanticSessionToMarkdown(session: SemanticInterviewSession): string {
  const pack = session.packSnapshot;
  const visible = semanticVisibleQuestions(session);
  const visibleIds = new Set(visible.map((question) => question.id));
  const buckets = coverageBucketMap(session);
  const lines: string[] = [
    `# ${session.clientLabel} — Interview`,
    '',
    `- Pack: ${pack.title} (${pack.packVersion})`,
    `- Session: ${session.sessionId}`,
    `- Interview mode: ${session.interviewMode}`,
    ...(session.interviewerLabel ? [`- Interviewer: ${session.interviewerLabel}`] : []),
    `- Created: ${session.createdAt}`,
    `- Updated: ${session.updatedAt}`,
    ''
  ];

  for (const section of pack.sections) {
    const questions = visible.filter((question) => question.sectionId === section.id);
    if (!questions.length) continue;
    lines.push(`## ${section.title}`, '');
    for (const question of questions) appendSemanticQuestion(lines, question, session);
  }

  const inactiveQuestions = pack.questions.filter(
    (question) => !visibleIds.has(question.id) && hasSemanticPreservedState(session.answers[question.id])
  );
  if (inactiveQuestions.length) {
    lines.push(
      '## Inactive / hidden preserved answers',
      '',
      '_These answers are not currently relevant under the active conditions, but are retained as internal historical evidence._',
      ''
    );
    for (const question of inactiveQuestions) appendSemanticQuestion(lines, question, session);
  }

  const mustConfirm = visible.filter((question) => buckets[question.id] === 'needs-confirmation');
  lines.push('## Needs confirmation', '');
  if (!mustConfirm.length) lines.push('_None._', '');
  else for (const question of mustConfirm) lines.push(`- ${question.prompt}`);

  if (session.runningNotes.trim()) lines.push('', '## Internal running notes', '', session.runningNotes.trim(), '');
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

function legacyTrimmedNote(session: InterviewSession, questionId: string): string {
  const note = session.answers[questionId]?.note;
  return typeof note === 'string' ? note.trim() : '';
}

function appendLegacyQuestion(lines: string[], question: Question, session: InterviewSession): void {
  const state = session.answers[question.id];
  const value = state?.value?.trim() || '_No answer recorded_';
  const status = state?.status ? legacyStatusLabel[state.status] : 'Unresolved';
  const note = legacyTrimmedNote(session, question.id);
  lines.push(`### ${question.prompt}`, '', `**Status:** ${status}`, '', value, '');
  if (note) lines.push('**Internal note:**', '', note, '');
}

function hasLegacyPreservedState(session: InterviewSession, questionId: string): boolean {
  const state = session.answers[questionId];
  return Boolean(state?.value?.trim() || state?.status || legacyTrimmedNote(session, questionId));
}

/** Historical formatter retained for migration-regression fixtures. Live 1.3 UI uses semanticSessionToMarkdown. */
export function sessionToMarkdown(session: InterviewSession): string {
  const pack = legacySessionPack(session);
  const visible = legacyVisibleQuestions(pack, session);
  const visibleIds = new Set(visible.map((question) => question.id));
  const lines: string[] = [
    `# ${session.clientLabel} — Interview`, '',
    `- Pack: ${pack.title} (${pack.packVersion})`, `- Session: ${session.sessionId}`,
    `- Interview mode: ${session.interviewMode}`,
    ...(session.interviewerLabel ? [`- Interviewer: ${session.interviewerLabel}`] : []),
    `- Created: ${session.createdAt}`, `- Updated: ${session.updatedAt}`, ''
  ];
  for (const section of pack.sections) {
    const questions = visible.filter((question) => question.sectionId === section.id);
    if (!questions.length) continue;
    lines.push(`## ${section.title}`, '');
    for (const question of questions) appendLegacyQuestion(lines, question, session);
  }
  const inactiveQuestions = pack.questions.filter((question) => !visibleIds.has(question.id) && hasLegacyPreservedState(session, question.id));
  if (inactiveQuestions.length) {
    lines.push('## Inactive / hidden preserved answers', '', '_These answers are not currently relevant under the active conditions, but are retained as internal historical evidence._', '');
    for (const question of inactiveQuestions) appendLegacyQuestion(lines, question, session);
  }
  const mustConfirm = visible.filter((question) => session.answers[question.id]?.status === 'MUST_CONFIRM');
  lines.push('## Unresolved / must confirm', '');
  if (!mustConfirm.length) lines.push('_None._', '');
  else for (const question of mustConfirm) lines.push(`- ${question.prompt}`);
  if (session.runningNotes.trim()) lines.push('', '## Internal running notes', '', session.runningNotes.trim(), '');
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

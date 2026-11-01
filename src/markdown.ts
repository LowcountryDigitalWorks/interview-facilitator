import type { InterviewPack, InterviewSession, Question } from './domain';
import { visibleQuestions } from './domain';

const statusLabel: Record<string, string> = {
  ANSWERED: 'Answered',
  ALREADY_KNOWN: 'Already known',
  SKIP: 'Skipped',
  N_A: 'Not applicable',
  MUST_CONFIRM: 'Must confirm'
};

export function serializeSession(session: InterviewSession): string {
  return JSON.stringify(session, null, 2) + '\n';
}

function trimmedNote(session: InterviewSession, questionId: string): string {
  const note = session.answers[questionId]?.note;
  return typeof note === 'string' ? note.trim() : '';
}

function appendQuestion(lines: string[], question: Question, session: InterviewSession): void {
  const state = session.answers[question.id];
  const value = state?.value?.trim() || '_No answer recorded_';
  const status = state?.status ? statusLabel[state.status] : 'Unresolved';
  const note = trimmedNote(session, question.id);
  lines.push(`### ${question.prompt}`, '', `**Status:** ${status}`, '', value, '');
  if (note) lines.push('**Internal note:**', '', note, '');
}

function hasPreservedInternalState(session: InterviewSession, questionId: string): boolean {
  const state = session.answers[questionId];
  return Boolean(state?.value?.trim() || state?.status || trimmedNote(session, questionId));
}

export function sessionToMarkdown(pack: InterviewPack, session: InterviewSession): string {
  const visible = visibleQuestions(pack, session);
  const visibleIds = new Set(visible.map((question) => question.id));
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
    for (const question of questions) appendQuestion(lines, question, session);
  }

  const inactiveQuestions = pack.questions.filter(
    (question) => !visibleIds.has(question.id) && hasPreservedInternalState(session, question.id)
  );
  if (inactiveQuestions.length) {
    lines.push(
      '## Inactive / hidden preserved answers',
      '',
      '_These answers are not currently relevant under the active conditions, but are retained as internal historical evidence._',
      ''
    );
    for (const question of inactiveQuestions) appendQuestion(lines, question, session);
  }

  const mustConfirm = visible.filter((question) => session.answers[question.id]?.status === 'MUST_CONFIRM');
  lines.push('## Unresolved / must confirm', '');
  if (!mustConfirm.length) lines.push('_None._', '');
  else for (const question of mustConfirm) lines.push(`- ${question.prompt}`);

  if (session.runningNotes.trim()) lines.push('', '## Internal running notes', '', session.runningNotes.trim(), '');
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

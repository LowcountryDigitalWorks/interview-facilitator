import type { InterviewPack, InterviewSession } from './domain';
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

export function sessionToMarkdown(pack: InterviewPack, session: InterviewSession): string {
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
    const questions = visibleQuestions(pack, session).filter((question) => question.sectionId === section.id);
    if (!questions.length) continue;
    lines.push(`## ${section.title}`, '');
    for (const question of questions) {
      const state = session.answers[question.id];
      const value = state?.value?.trim() || '_No answer recorded_';
      const status = state?.status ? statusLabel[state.status] : 'Unresolved';
      lines.push(`### ${question.prompt}`, '', `**Status:** ${status}`, '', value, '');
    }
  }

  const mustConfirm = visibleQuestions(pack, session).filter((question) => session.answers[question.id]?.status === 'MUST_CONFIRM');
  lines.push('## Unresolved / must confirm', '');
  if (!mustConfirm.length) lines.push('_None._', '');
  else for (const question of mustConfirm) lines.push(`- ${question.prompt}`);

  if (session.runningNotes.trim()) lines.push('', '## Internal running notes', '', session.runningNotes.trim(), '');
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

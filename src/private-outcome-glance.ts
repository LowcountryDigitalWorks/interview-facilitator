import type { Question } from './domain';
import {
  captureSpecForQuestion,
  relevanceMap,
  type LiveInterviewSession,
} from './live-session';
import {
  coverageBucketForQuestion,
  type CoverageBucket,
  type Relevance,
} from './coverage-rules';
import {
  effectiveEvidence,
  isMeaningfulCaptureValue,
  type CaptureSpec,
} from './coverage-semantics';
import {
  validateSemanticSessionRecord,
  type SemanticAnswerState,
  type SemanticInterviewSession,
} from './semantic-session';

/**
 * M3A — pure PRIVATE outcome glance projection for human synthesis review only.
 * Not for client Read-back, Presentation, export surfaces, provider/CRM/task routing,
 * or any automatic commitment or consent claim.
 */
export const PRIVATE_OUTCOME_GLANCE_VERSION = 'ldw.private-outcome-glance.v1' as const;

export const PRIVATE_OUTCOME_GLANCE_NOTICE =
  'Private interviewer glance only. Values are classification-weighted session evidence, not verified client approval, legal attestation, or an actionable task.';

export const LIVE_PINNED_PACK_GLANCE_LAYOUT: Readonly<Record<string, {
  outcome: readonly string[];
  dependencies: readonly string[];
}>> = {
  'general-discovery-blank': { outcome: ['primary-goal'], dependencies: ['must-have'] },
  'website-greenfield': {
    outcome: ['primary-outcome', 'launch-priority', 'success-measure'],
    dependencies: ['content-owner', 'domain-owner'],
  },
  'website-takeover': {
    outcome: ['main-pain', 'priority'],
    dependencies: ['critical-dependencies', 'rollback', 'approval'],
  },
  'workflow-automation': {
    outcome: ['workflow-outcome', 'first-proof', 'success-criteria'],
    dependencies: ['systems', 'approval-points', 'exceptions'],
  },
  'technology-ownership': {
    outcome: ['business-services', 'near-term'],
    dependencies: ['critical-owners', 'access-handoffs', 'high-risks', 'decision-authority', 'restore-evidence'],
  },
};

const MAX_DISPLAY_EXCERPT = 240;
const MAX_ITEMS_PER_SECTION = 16;

export interface PrivateOutcomeGlanceItem {
  questionId: string;
  prompt: string;
  displayValue: string;
  relevance: Relevance;
  bucket: CoverageBucket;
  visible: boolean;
  needsConfirmation: boolean;
  provenanceClassification: string | null;
}

export interface PrivateOutcomeGlanceProjection {
  schemaVersion: typeof PRIVATE_OUTCOME_GLANCE_VERSION;
  packId: string;
  packVersion: string;
  outcome: { items: PrivateOutcomeGlanceItem[] };
  dependencies: { items: PrivateOutcomeGlanceItem[] };
  unknowns: { items: PrivateOutcomeGlanceItem[] };
  suggestedConversationStep: string;
  notice: typeof PRIVATE_OUTCOME_GLANCE_NOTICE;
}

function excerptValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return 'Not established';
  return trimmed.length > MAX_DISPLAY_EXCERPT
    ? `${trimmed.slice(0, MAX_DISPLAY_EXCERPT - 1)}…`
    : trimmed;
}

function provenanceClassification(
  state: SemanticAnswerState,
  spec: CaptureSpec,
  bucket: CoverageBucket,
): string | null {
  if (state.resolution === 'not-applicable') return 'Marked not applicable';
  if (!isMeaningfulCaptureValue(spec, state.value) && state.resolution !== 'deferred') return null;
  if (state.source === 'client-statement') {
    return 'client-statement (classification only; not independently verified)';
  }
  if (state.source === 'accepted-known-fact') {
    return 'accepted-known-fact (classification only; not independently verified)';
  }
  if (state.source === 'interviewer-inference') {
    return 'interviewer-inference (classification only; requires human review)';
  }
  if (bucket === 'needs-confirmation' || state.needsConfirmation) {
    return 'needs-confirmation (classification only)';
  }
  if (state.resolution === 'captured') return 'source-not-recorded (classification only)';
  return null;
}

function shouldTreatAsUnknown(
  relevance: Relevance,
  bucket: CoverageBucket,
  state: SemanticAnswerState | undefined,
  spec: CaptureSpec,
): boolean {
  if (relevance === 'pending') return true;
  if (relevance === 'irrelevant') return false;
  if (!state) return true;
  if (bucket === 'needs-confirmation' || state.needsConfirmation) return true;
  if (bucket === 'open') return true;
  if (state.resolution === 'captured') {
    const evidence = effectiveEvidence(spec, state);
    if (evidence.strength === 'tentative') return true;
  }
  if (state.resolution === 'unresolved') return true;
  return false;
}

const PENDING_APPLICABILITY_DISPLAY = 'Not established — pending applicability';

function displayValueFor(
  state: SemanticAnswerState | undefined,
  spec: CaptureSpec,
  relevance: Relevance,
): string {
  if (relevance === 'pending') {
    if (state && isMeaningfulCaptureValue(spec, state.value)) {
      return PENDING_APPLICABILITY_DISPLAY;
    }
    return 'Not established';
  }
  if (!state) return 'Not established';
  if (!isMeaningfulCaptureValue(spec, state.value)) return 'Not established';
  return excerptValue(String(state.value));
}

function buildItem(
  question: Question,
  session: LiveInterviewSession,
  relevance: Relevance,
  bucket: CoverageBucket,
): PrivateOutcomeGlanceItem | null {
  if (relevance === 'irrelevant') return null;
  const state = session.answers[question.id];
  const spec = captureSpecForQuestion(question);
  return {
    questionId: question.id,
    prompt: question.prompt,
    displayValue: displayValueFor(state, spec, relevance),
    relevance,
    bucket,
    visible: true,
    needsConfirmation: Boolean(state?.needsConfirmation) || bucket === 'needs-confirmation',
    provenanceClassification: state ? provenanceClassification(state, spec, bucket) : null,
  };
}

function questionOrderIndex(questions: readonly Question[], questionId: string): number {
  const index = questions.findIndex((question) => question.id === questionId);
  return index < 0 ? Number.MAX_SAFE_INTEGER : index;
}

function sortItems(questions: readonly Question[], items: PrivateOutcomeGlanceItem[]): PrivateOutcomeGlanceItem[] {
  return [...items].sort(
    (left, right) => questionOrderIndex(questions, left.questionId) - questionOrderIndex(questions, right.questionId),
  ).slice(0, MAX_ITEMS_PER_SECTION);
}

function suggestConversationStep(unknowns: PrivateOutcomeGlanceItem[]): string {
  const prompts = unknowns
    .filter((item) => (
      item.displayValue === 'Not established'
      || item.displayValue === PENDING_APPLICABILITY_DISPLAY
      || item.needsConfirmation
    ))
    .slice(0, 3)
    .map((item) => item.prompt);
  if (!prompts.length) {
    return 'No prioritized evidence gaps were flagged in this glance; continue private review before any external summary.';
  }
  return `Suggested conversation follow-up (human judgment only): revisit ${prompts.join('; ')}. `
    + 'This is not a task assignment, CRM action, email, or client approval.';
}

function layoutForPack(packId: string): { outcome: readonly string[]; dependencies: readonly string[] } {
  if (typeof packId !== 'string' || !Object.hasOwn(LIVE_PINNED_PACK_GLANCE_LAYOUT, packId)) {
    return { outcome: [], dependencies: [] };
  }
  return LIVE_PINNED_PACK_GLANCE_LAYOUT[packId]!;
}

export function projectPrivateOutcomeGlanceFromSession(
  session: SemanticInterviewSession,
): PrivateOutcomeGlanceProjection {
  const questions = session.packSnapshot.questions;
  const relevance = relevanceMap(session);
  const layout = layoutForPack(session.packSnapshot.packId);
  const byId = new Map(questions.map((question) => [question.id, question]));

  const outcome: PrivateOutcomeGlanceItem[] = [];
  const dependencies: PrivateOutcomeGlanceItem[] = [];
  const unknowns: PrivateOutcomeGlanceItem[] = [];
  const assigned = new Set<string>();

  const considerMapped = (questionId: string, target: 'outcome' | 'dependencies'): void => {
    const question = byId.get(questionId);
    if (!question) {
      unknowns.push({
        questionId,
        prompt: 'Mapped question (not present in pinned snapshot)',
        displayValue: 'Not established',
        relevance: 'pending',
        bucket: 'open',
        visible: false,
        needsConfirmation: false,
        provenanceClassification: null,
      });
      assigned.add(questionId);
      return;
    }
    const rel = relevance[questionId] ?? 'pending';
    const bucket = coverageBucketForQuestion(question, session.answers[questionId], rel);
    const item = buildItem(question, session, rel, bucket);
    if (!item) return;
    assigned.add(questionId);
    if (shouldTreatAsUnknown(rel, bucket, session.answers[questionId], captureSpecForQuestion(question))) {
      unknowns.push(item);
      return;
    }
    if (target === 'outcome') outcome.push(item);
    else dependencies.push(item);
  };

  for (const questionId of layout.outcome) considerMapped(questionId, 'outcome');
  for (const questionId of layout.dependencies) considerMapped(questionId, 'dependencies');

  for (const question of questions) {
    if (assigned.has(question.id)) continue;
    const rel = relevance[question.id] ?? 'pending';
    if (rel === 'irrelevant') continue;
    const bucket = coverageBucketForQuestion(question, session.answers[question.id], rel);
    if (!shouldTreatAsUnknown(rel, bucket, session.answers[question.id], captureSpecForQuestion(question))) continue;
    const item = buildItem(question, session, rel, bucket);
    if (item) unknowns.push(item);
  }

  const sortedUnknowns = sortItems(questions, unknowns);
  return {
    schemaVersion: PRIVATE_OUTCOME_GLANCE_VERSION,
    packId: session.packSnapshot.packId,
    packVersion: session.packSnapshot.packVersion,
    outcome: { items: sortItems(questions, outcome) },
    dependencies: { items: sortItems(questions, dependencies) },
    unknowns: { items: sortedUnknowns },
    suggestedConversationStep: suggestConversationStep(sortedUnknowns),
    notice: PRIVATE_OUTCOME_GLANCE_NOTICE,
  };
}

export async function projectPrivateOutcomeGlance(
  raw: unknown,
): Promise<PrivateOutcomeGlanceProjection> {
  const session = await validateSemanticSessionRecord(raw);
  return projectPrivateOutcomeGlanceFromSession(session);
}

import type { CoverageBucket } from './coverage-rules';
import type { EvidenceSource } from './coverage-semantics';
import type { SemanticAnswerState } from './semantic-session';

export type PrivateEvidenceLensTone = 'neutral' | 'review-required' | 'needs-confirmation';

export interface PrivateEvidenceLensProjection {
  show: boolean;
  provenanceLabel: string | null;
  uncertaintyLabel: string | null;
  tone: PrivateEvidenceLensTone;
}

const PROVENANCE: Record<EvidenceSource, string> = {
  'client-statement': 'Reported by client (not independently verified)',
  'accepted-known-fact': 'Prior fact accepted for use (not independently verified)',
  'interviewer-inference': 'Interviewer inference — review/confirm',
};

const SOURCE_NOT_RECORDED = 'Source not recorded';
const NEEDS_CONFIRMATION = 'Needs confirmation before reliance';
const DEFERRED = 'Deferred — not finalized';
const STALE_CONFIRMATION = 'Recorded confirmation may not match current answer';

function hasCapturedValue(state: SemanticAnswerState): boolean {
  return Boolean(state.value?.trim());
}

export function shouldShowPrivateEvidenceLens(
  state: SemanticAnswerState,
  bucket: CoverageBucket,
): boolean {
  if (bucket === 'inactive') return false;
  if (state.resolution === 'not-applicable') return false;
  if (bucket === 'needs-confirmation' || state.needsConfirmation) return true;
  if (state.resolution === 'captured' && hasCapturedValue(state)) return true;
  if (state.resolution === 'deferred' && hasCapturedValue(state)) return true;
  return false;
}

function provenanceFor(state: SemanticAnswerState): string | null {
  if (state.source === 'client-statement'
    || state.source === 'accepted-known-fact'
    || state.source === 'interviewer-inference') {
    return PROVENANCE[state.source];
  }
  if (state.resolution === 'captured' && hasCapturedValue(state)) {
    return SOURCE_NOT_RECORDED;
  }
  if (hasCapturedValue(state) && state.source === null) {
    return SOURCE_NOT_RECORDED;
  }
  return null;
}

function uncertaintyFor(
  state: SemanticAnswerState,
  bucket: CoverageBucket,
): string | null {
  if (bucket === 'needs-confirmation' || state.needsConfirmation) {
    return NEEDS_CONFIRMATION;
  }
  if (state.resolution === 'deferred') {
    return DEFERRED;
  }
  const confirmation = state.confirmation;
  if (confirmation) {
    const confirmed = String(confirmation.value ?? '').trim();
    const current = state.value?.trim() ?? '';
    if (confirmed && current && confirmed !== current) {
      return STALE_CONFIRMATION;
    }
  }
  return null;
}

function toneFor(state: SemanticAnswerState, bucket: CoverageBucket): PrivateEvidenceLensTone {
  if (bucket === 'needs-confirmation' || state.needsConfirmation) {
    return 'needs-confirmation';
  }
  if (state.source === 'interviewer-inference') {
    return 'review-required';
  }
  return 'neutral';
}

export function projectPrivateEvidenceLens(
  state: SemanticAnswerState,
  bucket: CoverageBucket,
): PrivateEvidenceLensProjection {
  if (!shouldShowPrivateEvidenceLens(state, bucket)) {
    return { show: false, provenanceLabel: null, uncertaintyLabel: null, tone: 'neutral' };
  }
  return {
    show: true,
    provenanceLabel: provenanceFor(state),
    uncertaintyLabel: uncertaintyFor(state, bucket),
    tone: toneFor(state, bucket),
  };
}

/** Fixed-string HTML only; never interpolates user capture text. */
export function renderPrivateEvidenceLensHtml(lens: PrivateEvidenceLensProjection): string {
  if (!lens.show) return '';
  const toneClass = `evidence-lens--${lens.tone}`;
  const parts: string[] = [];
  if (lens.provenanceLabel) {
    parts.push(`<span class="evidence-lens-provenance">${lens.provenanceLabel}</span>`);
  }
  if (lens.uncertaintyLabel) {
    parts.push(`<span class="evidence-lens-uncertainty">${lens.uncertaintyLabel}</span>`);
  }
  if (!parts.length) return '';
  return `<p class="evidence-lens ${toneClass}" role="note" data-evidence-lens>${parts.join('')}</p>`;
}

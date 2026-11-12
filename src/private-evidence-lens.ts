import type { CoverageBucket } from './coverage-rules';
import type { CaptureValue, EvidenceSource } from './coverage-semantics';
import type { SemanticAnswerState } from './semantic-session';

export type PrivateEvidenceLensTone = 'neutral' | 'review-required' | 'needs-confirmation';

export interface PrivateEvidenceLensProjection {
  show: boolean;
  provenanceLabel: string | null;
  uncertaintyLabel: string | null;
  tone: PrivateEvidenceLensTone;
}

const SOURCE_NOT_RECORDED = 'Source not recorded';
const NEEDS_CONFIRMATION = 'Needs confirmation before reliance';
const DEFERRED = 'Deferred — not finalized';
const STALE_CONFIRMATION = 'Recorded confirmation may not match current answer';

const PROVENANCE: Record<EvidenceSource, string> = {
  'client-statement': 'Recorded as client statement (not independently verified)',
  'accepted-known-fact': 'Prior fact accepted for use (not independently verified)',
  'interviewer-inference': 'Interviewer inference — review/confirm',
};

const ALLOWED_PROVENANCE_LABELS = new Set<string>([
  ...Object.values(PROVENANCE),
  SOURCE_NOT_RECORDED,
]);
const ALLOWED_UNCERTAINTY_LABELS = new Set<string>([
  NEEDS_CONFIRMATION,
  DEFERRED,
  STALE_CONFIRMATION,
]);

function hasCapturedValue(state: SemanticAnswerState): boolean {
  return Boolean(state.value?.trim());
}

/** Matches coverage-semantics captureValuesEqual (exact, not trimmed). */
function captureValuesEqual(left: CaptureValue, right: CaptureValue): boolean {
  if (left === right) return true;
  return typeof left === 'number' && typeof right === 'number' && Number.isNaN(left) && Number.isNaN(right);
}

function escapeLabelText(value: string): string {
  return value.replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[char] ?? char);
}

function assertRegisteredLabel(value: string | null, allowed: Set<string>): string | null {
  if (value === null) return null;
  if (!allowed.has(value)) {
    throw new Error('PRIVATE_EVIDENCE_LENS_LABEL_CONTRACT');
  }
  return escapeLabelText(value);
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
  const value = state.value;
  if (confirmation && value !== null
    && !captureValuesEqual(confirmation.value, value)) {
    return STALE_CONFIRMATION;
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
  const provenance = assertRegisteredLabel(lens.provenanceLabel, ALLOWED_PROVENANCE_LABELS);
  const uncertainty = assertRegisteredLabel(lens.uncertaintyLabel, ALLOWED_UNCERTAINTY_LABELS);
  if (provenance) {
    parts.push(`<span class="evidence-lens-provenance">${provenance}</span>`);
  }
  if (uncertainty) {
    parts.push(`<span class="evidence-lens-uncertainty">${uncertainty}</span>`);
  }
  if (!parts.length) return '';
  return `<p class="evidence-lens ${toneClass}" role="note" data-evidence-lens>${parts.join('')}</p>`;
}

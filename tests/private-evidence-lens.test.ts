import { describe, expect, it } from 'vitest';
import type { CoverageBucket } from '../src/coverage-rules';
import {
  projectPrivateEvidenceLens,
  renderPrivateEvidenceLensHtml,
  shouldShowPrivateEvidenceLens,
} from '../src/private-evidence-lens';
import type { SemanticAnswerState } from '../src/semantic-session';

function state(partial: Partial<SemanticAnswerState> & Pick<SemanticAnswerState, 'resolution'>): SemanticAnswerState {
  return {
    value: null,
    source: null,
    needsConfirmation: false,
    confirmation: null,
    followUp: null,
    note: '',
    ...partial,
  };
}

describe('private evidence lens projection', () => {
  it('maps evidence sources to neutral provenance labels', () => {
    expect(projectPrivateEvidenceLens(
      state({ resolution: 'captured', value: 'yes', source: 'client-statement' }),
      'current',
    ).provenanceLabel).toBe('Reported by client (not independently verified)');
    expect(projectPrivateEvidenceLens(
      state({ resolution: 'captured', value: 'yes', source: 'accepted-known-fact' }),
      'current',
    ).provenanceLabel).toBe('Prior fact accepted for use (not independently verified)');
    expect(projectPrivateEvidenceLens(
      state({ resolution: 'captured', value: 'guess', source: 'interviewer-inference' }),
      'needs-confirmation',
    ).tone).toBe('needs-confirmation');
    expect(projectPrivateEvidenceLens(
      state({ resolution: 'captured', value: 'guess', source: 'interviewer-inference' }),
      'current',
    ).tone).toBe('review-required');
  });

  it('hides badges for unresolved blank answers', () => {
    expect(shouldShowPrivateEvidenceLens(state({ resolution: 'unresolved' }), 'open')).toBe(false);
    expect(projectPrivateEvidenceLens(state({ resolution: 'unresolved' }), 'open').show).toBe(false);
  });

  it('shows source not recorded only for captured values', () => {
    const lens = projectPrivateEvidenceLens(
      state({ resolution: 'captured', value: 'Captured text', source: null }),
      'current',
    );
    expect(lens.show).toBe(true);
    expect(lens.provenanceLabel).toBe('Source not recorded');
  });

  it('keeps needs confirmation distinct from provenance', () => {
    const lens = projectPrivateEvidenceLens(
      state({
        resolution: 'captured',
        value: 'Held',
        source: 'client-statement',
        needsConfirmation: true,
      }),
      'needs-confirmation',
    );
    expect(lens.uncertaintyLabel).toBe('Needs confirmation before reliance');
    expect(lens.tone).toBe('needs-confirmation');
    expect(lens.provenanceLabel).toContain('not independently verified');
    expect(lens.provenanceLabel).not.toMatch(/verified$/i);
  });

  it('flags stale confirmation without claiming verified', () => {
    const lens = projectPrivateEvidenceLens(
      state({
        resolution: 'captured',
        value: 'New wording',
        source: 'client-statement',
        confirmation: {
          revisionId: 'rev-1',
          confirmedAt: '2026-01-01T00:00:00.000Z',
          value: 'Old wording',
        },
      }),
      'current',
    );
    expect(lens.uncertaintyLabel).toBe('Recorded confirmation may not match current answer');
    expect(JSON.stringify(lens)).not.toContain('Verified');
  });

  it('does not interpolate hostile answer text into html', () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const lens = projectPrivateEvidenceLens(
      state({ resolution: 'captured', value: hostile, source: 'client-statement' }),
      'current',
    );
    const html = renderPrivateEvidenceLensHtml(lens);
    expect(html).not.toContain(hostile);
    expect(html).not.toContain('<img');
    expect(html).toContain('data-evidence-lens');
  });

  it('hides lens for inactive and not-applicable buckets', () => {
    const buckets: CoverageBucket[] = ['inactive', 'not-applicable'];
    for (const bucket of buckets) {
      expect(projectPrivateEvidenceLens(
        state({ resolution: 'not-applicable', value: null }),
        bucket,
      ).show).toBe(false);
    }
  });
});

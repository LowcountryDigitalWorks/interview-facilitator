import { describe, expect, it } from 'vitest';
import { formatConnectivityLabel, formatSaveLabel } from '../src/indicators';

describe('formatSaveLabel', () => {
  it('shows saving before persistence wording', () => {
    expect(formatSaveLabel('saving', 'persistent')).toBe('Saving locally…');
  });

  it('shows error without clearing persistence context on next saved state', () => {
    expect(formatSaveLabel('error', 'persistent')).toBe('Local save failed');
    expect(formatSaveLabel('saved', 'persistent')).toBe('Saved on this device');
  });
});

describe('formatConnectivityLabel', () => {
  it('reflects offline and offline-ready online states', () => {
    expect(formatConnectivityLabel(false, true)).toBe('Offline');
    expect(formatConnectivityLabel(true, false)).toBe('Online');
    expect(formatConnectivityLabel(true, true)).toBe('Online · offline ready');
  });
});

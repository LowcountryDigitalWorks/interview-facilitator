export type SaveState = 'saved' | 'saving' | 'error';
export type PersistenceState = 'unknown' | 'persistent' | 'best-effort';

export function formatSaveLabel(
  saveState: SaveState,
  persistenceState: PersistenceState,
): string {
  if (saveState === 'saving') return 'Saving locally…';
  if (saveState === 'error') return 'Local save failed';
  if (persistenceState === 'best-effort') return 'Saved locally · backup recommended';
  if (persistenceState === 'persistent') return 'Saved on this device';
  return 'Saved locally';
}

export function formatConnectivityLabel(online: boolean, offlineReady: boolean): string {
  if (!online) return offlineReady ? 'Offline · App ready' : 'Offline · Keep this tab open';
  return offlineReady ? 'Online · Offline ready' : 'Online · Offline not ready';
}

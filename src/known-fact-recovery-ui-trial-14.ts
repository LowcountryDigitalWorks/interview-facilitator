import {
  createLifecycleTrial14BackupForReview,
  loadKnownFactLifecycleTrial14ForReview,
  restoreKnownFactLifecycleTrial14ForReview,
  validateLifecycleTrial14BackupForReview,
} from './known-fact-lifecycle-storage-trial-14';

/**
 * #35 DORMANT SOURCE-ONLY / SYNTHETIC browser trial.
 *
 * Human-controlled confidential JSON export and explicit empty-slot restore.
 * NOT imported by main.ts, never opens the production IndexedDB database and
 * never imports a file silently. SHA-256 is a corruption checksum, NOT a
 * signature, encryption, consent, external backup or retention guarantee.
 *
 * Caller supplies an already-open isolated trial database and optional exact
 * export session ID. Caller owns and closes the connection on teardown.
 */
export const RECOVERY_TRIAL_MAX_FILE_BYTES = 5_000_000;
export const RECOVERY_TRIAL_FILENAME = 'ldw-interview-lifecycle-1.4-trial-confidential.json';
const mounted = new WeakMap<HTMLElement, () => void>();

function requireHost(value: unknown): asserts value is HTMLElement {
  if (!value || typeof value !== 'object' || (value as HTMLElement).nodeType !== 1
    || typeof (value as HTMLElement).replaceChildren !== 'function'
    || !(value as HTMLElement).ownerDocument?.defaultView) {
    throw new Error('Recovery trial requires a document element.');
  }
}

function element<T extends keyof HTMLElementTagNameMap>(
  doc: Document, tag: T, text?: string,
): HTMLElementTagNameMap[T] {
  const node = doc.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

export type RecoveryTrialMounted14 = {
  dispose: () => void;
};

export function mountKnownFactRecoveryTrial14ForReview(
  host: HTMLElement,
  db: IDBDatabase,
  options: { exportSessionId?: string } = {},
): RecoveryTrialMounted14 {
  requireHost(host);
  mounted.get(host)?.();
  const doc = host.ownerDocument;
  const win = doc.defaultView;
  if (!win) throw new Error('Recovery trial requires a browser document.');
  let disposed = false;
  let sequence = 0;
  let stagedBytes: string | null = null;
  let busy = false;

  const heading = element(doc, 'h2', 'Confidential lifecycle recovery — trial only');
  const notice = element(doc, 'p',
    'This prototype does not operate on the live interview app. Keep exported JSON private: it is not encrypted or authenticated. '
    + 'Store any backup separately using an approved secure location; local download alone is not verified recovery.');
  const exportButton = element(doc, 'button', 'Download selected trial backup');
  exportButton.type = 'button';
  exportButton.disabled = !(typeof options.exportSessionId === 'string' && options.exportSessionId.trim());
  const exportCaption = element(doc, 'p',
    'Export requires a selected trial session. A downloaded file must be independently retained and checked.');
  const fileLabel = element(doc, 'label', 'Choose a confidential trial backup JSON file');
  const fileInput = element(doc, 'input');
  fileInput.type = 'file';
  fileInput.accept = '.json,application/json';
  const inputId = 'recovery-trial-file-' + crypto.randomUUID();
  fileInput.id = inputId;
  fileLabel.htmlFor = inputId;
  const stageInfo = element(doc, 'p', 'No backup selected.');
  const confirmLabel = element(doc, 'label');
  const confirm = element(doc, 'input');
  confirm.type = 'checkbox';
  const confirmText = element(doc, 'span',
    ' I understand this is an explicit restore into an empty trial slot; it cannot overwrite existing trial data.');
  confirmLabel.append(confirm, confirmText);
  const restoreButton = element(doc, 'button', 'Restore selected backup into empty trial slot');
  restoreButton.type = 'button';
  restoreButton.disabled = true;
  const cancelButton = element(doc, 'button', 'Cancel selected backup');
  cancelButton.type = 'button';
  cancelButton.disabled = true;
  const status = element(doc, 'p', 'No export or restore has been attempted.');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.setAttribute('aria-atomic', 'true');
  const controls = element(doc, 'div');
  controls.append(exportButton, exportCaption, fileLabel, fileInput, stageInfo,
    confirmLabel, restoreButton, cancelButton, status);
  host.replaceChildren(heading, notice, controls);

  function refresh(): void {
    restoreButton.disabled = disposed || busy || stagedBytes === null || !confirm.checked;
    confirm.disabled = disposed || busy || stagedBytes === null;
    exportButton.disabled = disposed || busy || !(typeof options.exportSessionId === 'string'
      && options.exportSessionId.trim());
    fileInput.disabled = disposed || busy;
    cancelButton.disabled = disposed || busy || (stagedBytes === null && !fileInput.files?.length);
  }

  function clear(message: string): void {
    sequence++;
    stagedBytes = null;
    fileInput.value = '';
    confirm.checked = false;
    stageInfo.textContent = 'No backup selected.';
    status.textContent = message;
    refresh();
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    sequence++;
    stagedBytes = null;
    fileInput.value = '';
    confirm.checked = false;
    exportButton.disabled = true;
    fileInput.disabled = true;
    cancelButton.disabled = true;
    restoreButton.disabled = true;
    if (mounted.get(host) === dispose) mounted.delete(host);
    host.replaceChildren();
  }
  mounted.set(host, dispose);

  fileInput.addEventListener('change', async () => {
    if (disposed || busy) return;
    const token = ++sequence;
    stagedBytes = null;
    confirm.checked = false;
    const file = fileInput.files?.[0];
    stageInfo.textContent = 'No backup selected.';
    if (!file) {
      status.textContent = 'No backup selected; no restore attempted.';
      refresh();
      return;
    }
    cancelButton.disabled = false;
    if (file.size === 0 || file.size > RECOVERY_TRIAL_MAX_FILE_BYTES) {
      clear('Backup rejected: invalid size. Nothing was restored.');
      return;
    }
    status.textContent = 'Validating selected backup locally…';
    // File.text and SHA-256 may be asynchronous; stale selections/unmounts
    // must never re-arm Restore or disclose a former preview.
    try {
      const bytes = await file.text();
      if (disposed || token !== sequence) return;
      if (bytes.length === 0 || bytes.length > RECOVERY_TRIAL_MAX_FILE_BYTES) {
        clear('Backup rejected: invalid size. Nothing was restored.');
        return;
      }
      const lifecycle = await validateLifecycleTrial14BackupForReview(bytes);
      if (disposed || token !== sequence) return;
      stagedBytes = bytes;
      stageInfo.textContent = 'Validated confidential trial backup. Lifecycle: '
        + (lifecycle.status === 'completed' ? 'Completed' : 'Draft')
        + '. Preserved completed snapshots: ' + lifecycle.completedRevisions.length
        + '. No interview content is displayed here.';
      status.textContent = 'Backup validated locally. Check the acknowledgement and press Restore to proceed.';
      refresh();
    } catch {
      if (disposed || token !== sequence) return;
      clear('Backup rejected: invalid or unverified contents. Nothing was restored.');
    }
  });

  confirm.addEventListener('change', () => {
    if (disposed) return;
    refresh();
  });
  cancelButton.addEventListener('click', () => {
    if (disposed || busy) return;
    clear('Selection cancelled. No restore was attempted.');
  });

  restoreButton.addEventListener('click', async () => {
    if (disposed || busy || !confirm.checked || stagedBytes === null) return;
    const bytes = stagedBytes;
    busy = true;
    sequence++;
    refresh();
    status.textContent = 'Restoring to an empty trial slot…';
    try {
      // The storage adapter independently validates the bytes again and
      // fails closed on occupied keys, including races between stage/click.
      await restoreKnownFactLifecycleTrial14ForReview(db, bytes);
      if (!disposed) clear('Trial restore committed locally. External backup and physical durability are not verified.');
    } catch {
      if (!disposed) clear('Restore was not applied. Check whether the trial slot is occupied or the backup is invalid.');
    } finally {
      busy = false;
      if (!disposed) refresh();
    }
  });

  exportButton.addEventListener('click', async () => {
    if (disposed || busy || !options.exportSessionId?.trim()) return;
    const token = ++sequence;
    busy = true;
    refresh();
    status.textContent = 'Preparing confidential trial download…';
    try {
      const stored = await loadKnownFactLifecycleTrial14ForReview(db, options.exportSessionId);
      if (!stored) throw new Error('No trial record.');
      const bytes = await createLifecycleTrial14BackupForReview(stored.lifecycle);
      if (disposed || token !== sequence) return;
      const url = win.URL.createObjectURL(new win.Blob([bytes], { type: 'application/json' }));
      try {
        const anchor = element(doc, 'a');
        anchor.href = url;
        anchor.download = RECOVERY_TRIAL_FILENAME;
        anchor.hidden = true;
        host.appendChild(anchor);
        anchor.click();
        anchor.remove();
        status.textContent = 'Local download requested. Verify and retain the confidential file securely.';
      } finally {
        // Revoke only after download navigation has been scheduled.
        win.setTimeout(() => win.URL.revokeObjectURL(url), 10_000);
      }
    } catch {
      if (!disposed && token === sequence) status.textContent =
        'Backup download unavailable. No external backup has been verified.';
    } finally {
      busy = false;
      if (!disposed) refresh();
    }
  });

  refresh();
  return { dispose };
}

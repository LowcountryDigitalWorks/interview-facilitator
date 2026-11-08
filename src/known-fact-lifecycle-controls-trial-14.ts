import { completeKnownFactLifecycle14, reopenKnownFactLifecycle14 } from './known-fact-lifecycle-14';
import {
  LifecycleTrialConflictError,
  loadKnownFactLifecycleTrial14ForReview,
  saveKnownFactLifecycleTrial14ForReview,
  type LifecycleTrialRecord14,
} from './known-fact-lifecycle-storage-trial-14';

/**
 * #34: HUMAN-CONTROLLED, ISOLATED 1.4 LIFECYCLE UI TRIAL ONLY.
 * NOT imported by main.ts; never opens the live 1.3 PWA database.
 * The caller supplies an already-open, separately reviewed trial DB and a
 * synthetic session ID. No client content, private notes or IDs are rendered.
 * Completion is NOT 100% coverage, external backup or customer approval.
 */
const mounted = new WeakMap<HTMLElement, () => void>();

function element<T extends keyof HTMLElementTagNameMap>(
  document: Document, tag: T, text?: string,
): HTMLElementTagNameMap[T] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

function checkboxWithLabel(document: Document, label: string): {
  container: HTMLLabelElement; checkbox: HTMLInputElement;
} {
  const container = element(document, 'label');
  const checkbox = element(document, 'input');
  checkbox.type = 'checkbox';
  container.append(checkbox, element(document, 'span', ' ' + label));
  return { container, checkbox };
}

function requireHost(host: unknown): asserts host is HTMLElement {
  if (!host || typeof host !== 'object'
    || (host as HTMLElement).nodeType !== 1
    || typeof (host as HTMLElement).replaceChildren !== 'function'
    || !(host as HTMLElement).ownerDocument?.defaultView) {
    throw new Error('Lifecycle trial controls require a document element.');
  }
}

export type LifecycleControlsTrialMounted14 = { dispose: () => void };

/**
 * The returned handle permits only teardown. There is no programmatic
 * Complete/Reopen shortcut; those commands require explicit button clicks.
 * Reload is a deliberate human action after an optimistic-CAS conflict.
 */
export function mountKnownFactLifecycleControlsTrial14ForReview(
  host: HTMLElement,
  db: IDBDatabase,
  sessionId: string,
): LifecycleControlsTrialMounted14 {
  requireHost(host);
  if (typeof sessionId !== 'string' || !sessionId.trim()) {
    throw new Error('A selected trial session is required.');
  }
  mounted.get(host)?.();
  const document = host.ownerDocument;
  let disposed = false;
  let busy = false;
  let stale = false;
  let record: LifecycleTrialRecord14 | null = null;
  let view: 'controls' | 'discussion' = 'controls';
  let epoch = 0;

  const heading = element(document, 'h2', 'Lifecycle controls — isolated 1.4 trial');
  const notice = element(document, 'p',
    'Internal synthetic trial only. No live interviews, customer consent, '
    + 'external backup or production activation. Complete does not mean all '
    + 'questions are answered; outstanding follow-ups are retained.');
  const summary = element(document, 'p', 'Loading trial lifecycle…');
  const preview = element(document, 'p', '');
  const controls = element(document, 'div');
  const viewButton = element(document, 'button', 'View discussion guidance');
  const returnButton = element(document, 'button', 'Return to lifecycle controls');
  const refreshButton = element(document, 'button', 'Reload current trial state');
  const completeAck = checkboxWithLabel(document,
    'I am deliberately marking this Draft complete; this is not client approval and unresolved items remain.');
  const reopenAck = checkboxWithLabel(document,
    'I am deliberately reopening the preserved Completed revision as a new Draft.');
  const completeButton = element(document, 'button', 'Mark Draft complete — trial only');
  const reopenButton = element(document, 'button', 'Reopen as new Draft — trial only');
  const status = element(document, 'p', 'Loading local trial state…');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.setAttribute('aria-atomic', 'true');
  for (const button of [viewButton, returnButton, refreshButton, completeButton, reopenButton]) {
    button.type = 'button';
  }
  controls.append(viewButton, returnButton, refreshButton,
    completeAck.container, completeButton, reopenAck.container, reopenButton);
  host.replaceChildren(heading, notice, summary, preview, controls, status);

  function update(): void {
    const draft = record?.lifecycle.status === 'draft';
    const completed = record?.lifecycle.status === 'completed';
    const controlsVisible = view === 'controls';
    preview.hidden = controlsVisible;
    if (!controlsVisible) {
      preview.textContent = 'Discussion view is navigation only. Review and select '
        + 'disclosable facts separately before any client Read-back. '
        + 'Opening this view does not record a read-back, complete a session, '
        + 'confirm facts or imply consent.';
    } else preview.textContent = '';
    viewButton.hidden = !controlsVisible;
    returnButton.hidden = controlsVisible;
    completeAck.container.hidden = !controlsVisible || !draft;
    completeButton.hidden = !controlsVisible || !draft;
    reopenAck.container.hidden = !controlsVisible || !completed;
    reopenButton.hidden = !controlsVisible || !completed;
    const disabled = disposed || busy || stale;
    viewButton.disabled = disabled || !record;
    returnButton.disabled = disabled;
    refreshButton.disabled = disposed || busy;
    completeAck.checkbox.disabled = disabled || !draft || !controlsVisible;
    reopenAck.checkbox.disabled = disabled || !completed || !controlsVisible;
    completeButton.disabled = disabled || !draft || !controlsVisible || !completeAck.checkbox.checked;
    reopenButton.disabled = disabled || !completed || !controlsVisible || !reopenAck.checkbox.checked;
    // Never expose session ID, client label, notes, raw error, source links,
    // fact values or other private/unsanitized fields in controls.
    summary.textContent = record
      ? 'Local trial state: ' + (draft ? 'Draft' : 'Completed')
        + '. Preserved completed revisions: ' + record.lifecycle.completedRevisions.length
        + '. Local generation: ' + record.generation + '.'
      : 'No selected trial lifecycle loaded.';
  }

  async function reload(): Promise<void> {
    if (disposed || busy) return;
    busy = true;
    const token = ++epoch;
    update();
    status.textContent = 'Reading the selected local trial state…';
    try {
      const next = await loadKnownFactLifecycleTrial14ForReview(db, sessionId);
      if (disposed || token !== epoch) return;
      record = next;
      stale = false;
      view = 'controls';
      completeAck.checkbox.checked = false;
      reopenAck.checkbox.checked = false;
      status.textContent = next
        ? 'Trial record loaded. No lifecycle change was made.'
        : 'No trial record found. Nothing was changed.';
    } catch {
      if (disposed || token !== epoch) return;
      record = null;
      stale = true;
      status.textContent = 'Local trial state could not be verified. No change was made.';
    } finally {
      busy = false;
      if (!disposed && token === epoch) update();
    }
  }

  async function command(kind: 'complete' | 'reopen'): Promise<void> {
    if (disposed || busy || stale || !record || view !== 'controls') return;
    if (kind === 'complete' && (record.lifecycle.status !== 'draft' || !completeAck.checkbox.checked)) return;
    if (kind === 'reopen' && (record.lifecycle.status !== 'completed' || !reopenAck.checkbox.checked)) return;
    const selected = record;
    busy = true;
    const token = ++epoch;
    update();
    status.textContent = 'Applying the explicit trial lifecycle change…';
    try {
      const now = new Date().toISOString();
      const next = kind === 'complete'
        ? await completeKnownFactLifecycle14(selected.lifecycle, {
          expectedRevisionId: selected.lifecycle.session.revisionId,
          eventId: crypto.randomUUID(),
          completedAt: now,
          acknowledgedFollowUpQuestionIds: [],
        })
        : await reopenKnownFactLifecycle14(selected.lifecycle, {
          expectedRevisionId: selected.lifecycle.session.revisionId,
          eventId: crypto.randomUUID(),
          newRevisionId: crypto.randomUUID(),
          reopenedAt: now,
        });
      // A detached UI must never initiate a new trial write after teardown.
      if (disposed || token !== epoch) return;
      const saved = await saveKnownFactLifecycleTrial14ForReview(db, next, {
        generation: selected.generation, digest: selected.digest,
      });
      if (disposed || token !== epoch) return;
      record = saved;
      completeAck.checkbox.checked = false;
      reopenAck.checkbox.checked = false;
      view = 'controls';
      status.textContent = kind === 'complete'
        ? 'Draft marked Completed in the isolated trial. No client sign-off recorded.'
        : 'Completed revision retained; new Draft saved in the isolated trial.';
    } catch (error) {
      if (disposed || token !== epoch) return;
      stale = true;
      completeAck.checkbox.checked = false;
      reopenAck.checkbox.checked = false;
      status.textContent = error instanceof LifecycleTrialConflictError
        ? 'Trial state changed in another tab. No overwrite. Reload the current trial state.'
        : 'Trial change could not be verified. Reload before another attempt.';
    } finally {
      busy = false;
      if (!disposed && token === epoch) update();
    }
  }

  viewButton.addEventListener('click', () => {
    if (disposed || busy || stale || !record) return;
    view = 'discussion';
    completeAck.checkbox.checked = false;
    reopenAck.checkbox.checked = false;
    update();
    status.textContent = 'Discussion guidance opened. No lifecycle change was made.';
  });
  returnButton.addEventListener('click', () => {
    if (disposed || busy) return;
    view = 'controls';
    update();
    status.textContent = 'Returned to lifecycle controls. No lifecycle change was made.';
  });
  refreshButton.addEventListener('click', () => { void reload(); });
  completeAck.checkbox.addEventListener('change', update);
  reopenAck.checkbox.addEventListener('change', update);
  completeButton.addEventListener('click', () => { void command('complete'); });
  reopenButton.addEventListener('click', () => { void command('reopen'); });

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    epoch++;
    record = null;
    completeAck.checkbox.checked = false;
    reopenAck.checkbox.checked = false;
    if (mounted.get(host) === dispose) mounted.delete(host);
    host.replaceChildren();
  }
  mounted.set(host, dispose);
  update();
  void reload();
  return { dispose };
}

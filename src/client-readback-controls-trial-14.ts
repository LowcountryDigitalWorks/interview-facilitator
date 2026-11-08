import { isMeaningfulCaptureValue } from './coverage-semantics';
import { captureSpecForQuestion, relevanceMap } from './live-session';
import { validateKnownFactSession14Record, type KnownFactSession14 } from './known-fact-session';
import {
  prepareKnownFact14ReadBackReviewForReview,
  type ReadBack14ReviewedEntry,
} from './client-readback-14';
import {
  invalidateReviewedKnownFact14ReadBackForReview,
  renderReviewedKnownFact14ReadBackForReview,
} from './client-readback-render-14';

/**
 * #35F: DORMANT human-selected Read-back browser trial. This does not import
 * main.ts, open IndexedDB, write history, record consent, or start a provider.
 *
 * Two separate DOM hosts are mandatory: a PRIVATE review host and a discussion
 * preview host. PRIVATE captured values are removed from the DOM before any
 * client-facing preview is displayed. Callers must never screen-share the
 * private review step. A preview is not an approval or sign-off.
 */
const mounted = new WeakMap<HTMLElement, () => void>();

function requireSeparateHosts(privateHost: HTMLElement, previewHost: HTMLElement): void {
  for (const host of [privateHost, previewHost]) {
    if (!host || host.nodeType !== 1 || !host.ownerDocument?.defaultView
      || typeof host.replaceChildren !== 'function') {
      throw new Error('Read-back trial requires valid document elements.');
    }
    const constructor = host.ownerDocument.defaultView.HTMLElement;
    if (!(host instanceof constructor)) {
      throw new Error('Read-back trial hosts must belong to their document realm.');
    }
  }
  if (privateHost === previewHost || privateHost.ownerDocument !== previewHost.ownerDocument
    || privateHost.contains(previewHost) || previewHost.contains(privateHost)) {
    throw new Error('Private review and client preview require separate non-nested hosts.');
  }
}

function node<K extends keyof HTMLElementTagNameMap>(
  document: Document, tag: K, value?: string,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (value !== undefined) el.textContent = value;
  return el;
}

function snapshot(raw: KnownFactSession14): KnownFactSession14 {
  return JSON.parse(JSON.stringify(raw)) as KnownFactSession14;
}

type SelectedRow = {
  id: string;
  value: string | null;
  followUp?: string;
  checked: HTMLInputElement;
  publicLabel: HTMLInputElement;
  shareFollowUp?: HTMLInputElement;
};

/**
 * This function is deliberately an isolated synthetic-only UX proof. An
 * external source getter allows a fresh revision + full-session digest check
 * immediately before rendering, not an atomic or lasting source lock. Pilot
 * data-handling/release gates remain separately required.
 */
export function mountKnownFact14ReadBackSelectionTrialForReview(
  privateHost: HTMLElement,
  previewHost: HTMLElement,
  getCurrentSource: () => unknown | Promise<unknown>,
): { dispose: () => void } {
  requireSeparateHosts(privateHost, previewHost);
  if (typeof getCurrentSource !== 'function') {
    throw new Error('Read-back trial requires an explicit source reader.');
  }
  mounted.get(privateHost)?.();
  const document = privateHost.ownerDocument;
  const listeners = new AbortController();
  let disposed = false;
  let epoch = 0;

  async function loadPrivateReview(): Promise<void> {
    if (disposed) return;
    const token = ++epoch;
    invalidateReviewedKnownFact14ReadBackForReview(previewHost);
    privateHost.replaceChildren(node(document, 'p', 'Loading private synthetic review…'));
    try {
      const checked = await validateKnownFactSession14Record(await getCurrentSource());
      const source = snapshot(checked);
      const identity = await prepareKnownFact14ReadBackReviewForReview(source);
      if (disposed || token !== epoch) return;

      const heading = node(document, 'h2', 'Private Read-back selection — 1.4 trial');
      const warning = node(document, 'p',
        'PRIVATE INTERVIEWER SCREEN. Do not screen-share this step. Select each item '
        + 'individually and type the reviewed public label. Preview is for discussion '
        + 'only; it is not a read-back record, confirmation, consent or approval.');
      const entries = node(document, 'div');
      const selection: SelectedRow[] = [];
      const relevant = relevanceMap(source);
      for (const question of source.packSnapshot.questions) {
        if (relevant[question.id] !== 'relevant') continue;
        const answer = source.answers[question.id];
        if (!answer) continue;
        const captured = answer.resolution === 'captured'
          && isMeaningfulCaptureValue(captureSpecForQuestion(question), answer.value);
        const value = captured ? answer.value : null;
        const item = node(document, 'fieldset');
        item.appendChild(node(document, 'legend', question.prompt));
        const selected = node(document, 'input');
        selected.type = 'checkbox';
        const selectLabel = node(document, 'label');
        selectLabel.append(selected, document.createTextNode(' Review this item for disclosure'));
        item.appendChild(selectLabel);
        item.appendChild(node(document, 'p',
          'Current source value (private): ' + (value ?? '(no current answer)')));
        const label = node(document, 'input');
        label.type = 'text';
        label.maxLength = 120;
        label.placeholder = 'Type public discussion label';
        const labelWrap = node(document, 'label');
        labelWrap.append(document.createTextNode('Reviewed public label: '), label);
        item.appendChild(labelWrap);
        let followUpSelected: HTMLInputElement | undefined;
        if (answer.followUp?.action) {
          item.appendChild(node(document, 'p',
            'Current follow-up (private): ' + answer.followUp.action));
          followUpSelected = node(document, 'input');
          followUpSelected.type = 'checkbox';
          const followUpLabel = node(document, 'label');
          followUpLabel.append(followUpSelected,
            document.createTextNode(' Separately disclose this exact follow-up'));
          item.appendChild(followUpLabel);
        }
        selection.push({
          id: question.id, value, followUp: answer.followUp?.action,
          checked: selected, publicLabel: label, shareFollowUp: followUpSelected,
        });
        entries.appendChild(item);
      }
      const previewButton = node(document, 'button', 'Show selected discussion preview — trial');
      previewButton.type = 'button';
      const refreshButton = node(document, 'button', 'Discard selections and reload');
      refreshButton.type = 'button';
      const status = node(document, 'p', 'No content disclosed. No lifecycle change recorded.');
      status.setAttribute('role', 'status');
      refreshButton.addEventListener('click', () => { void loadPrivateReview(); },
        { signal: listeners.signal });
      previewButton.addEventListener('click', () => {
        if (disposed || token !== epoch) return;
        const selected: ReadBack14ReviewedEntry[] = selection
          .filter(row => row.checked.checked)
          .map(row => ({
            questionId: row.id,
            publicLabel: row.publicLabel.value,
            reviewedValue: row.value,
            ...(row.shareFollowUp?.checked && row.followUp
              ? { reviewedFollowUp: row.followUp } : {}),
          }));
        void showDiscussion(source, identity, selected);
      }, { signal: listeners.signal });
      privateHost.replaceChildren(heading, warning, entries, previewButton, refreshButton, status);
    } catch {
      if (disposed || token !== epoch) return;
      const alert = node(document, 'p', 'Private source cannot be verified. No disclosure permitted.');
      alert.setAttribute('role', 'alert');
      const retry = node(document, 'button', 'Retry private source review');
      retry.type = 'button';
      retry.addEventListener('click', () => { void loadPrivateReview(); },
        { signal: listeners.signal });
      privateHost.replaceChildren(alert, retry);
    }
  }

  async function showDiscussion(
    source: KnownFactSession14,
    identity: Awaited<ReturnType<typeof prepareKnownFact14ReadBackReviewForReview>>,
    entries: ReadBack14ReviewedEntry[],
  ): Promise<void> {
    if (disposed) return;
    const token = ++epoch;
    // Remove all private answer/metadata DOM before showing any client view.
    privateHost.replaceChildren();
    invalidateReviewedKnownFact14ReadBackForReview(previewHost);
    try {
      const fresh = snapshot(await validateKnownFactSession14Record(await getCurrentSource()));
      const current = await prepareKnownFact14ReadBackReviewForReview(fresh);
      if (disposed || token !== epoch) return;
      if (current.expectedRevisionId !== identity.expectedRevisionId
        || current.expectedSessionDigest !== identity.expectedSessionDigest) {
        throw new Error('Source changed after private selection.');
      }
      // Projection itself revalidates exact labels, values, relevance and
      // follow-ups against the session. It rejects unreviewed or hidden fields.
      await renderReviewedKnownFact14ReadBackForReview(previewHost, fresh, {
        ...identity, entries,
      });
      if (disposed || token !== epoch) {
        invalidateReviewedKnownFact14ReadBackForReview(previewHost);
        return;
      }
    } catch {
      if (disposed || token !== epoch) return;
      invalidateReviewedKnownFact14ReadBackForReview(previewHost);
      const notice = node(document, 'p',
        'Discussion preview unavailable. Source or selections require fresh private review.');
      notice.setAttribute('role', 'alert');
      previewHost.appendChild(notice);
    }
    if (disposed || token !== epoch) return;
    const back = node(document, 'button', 'End preview and return to private review');
    back.type = 'button';
    back.addEventListener('click', () => { void loadPrivateReview(); },
      { signal: listeners.signal });
    previewHost.appendChild(back);
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    epoch++;
    listeners.abort();
    privateHost.replaceChildren();
    invalidateReviewedKnownFact14ReadBackForReview(previewHost);
    if (mounted.get(privateHost) === dispose) mounted.delete(privateHost);
  }

  mounted.set(privateHost, dispose);
  void loadPrivateReview();
  return { dispose };
}

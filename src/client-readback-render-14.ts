import { projectReviewedKnownFact14ReadBackForReview } from './client-readback-14';

/**
 * #35E dormant human-reviewed client Read-back DOM adapter.
 *
 * Only an exact 1.4 source + human-selected disclosure command may reach the
 * projector. A caller cannot pass a preassembled "client-safe" object, notes
 * or HTML. This is DISCUSSION ONLY, not a signature, consent or confirmation.
 *
 * Do not wire to live 1.3 app until independent source/privacy review and
 * versioned read-back UX are accepted.
 */
const renderSequence = new WeakMap<HTMLElement, number>();

function addTextElement(
  doc: Document, parent: Node, tag: string, value: string,
): void {
  const element = doc.createElement(tag);
  element.textContent = value;
  parent.appendChild(element);
}

function requireHost(host: unknown): asserts host is HTMLElement {
  if (!host || typeof host !== 'object') {
    throw new Error('Read-back renderer requires an element host.');
  }
  const candidate = host as HTMLElement;
  if (candidate.nodeType !== 1) {
    throw new Error('Read-back renderer requires an element host.');
  }
  if (typeof candidate.replaceChildren !== 'function'
    || !candidate.ownerDocument
    || candidate.ownerDocument.nodeType !== 9
    || typeof candidate.ownerDocument.createElement !== 'function'
    || typeof candidate.ownerDocument.createDocumentFragment !== 'function') {
    throw new Error('Read-back renderer host does not support safe DOM text nodes.');
  }
  const constructor = candidate.ownerDocument.defaultView?.HTMLElement;
  if (constructor && !(candidate instanceof constructor)) {
    throw new Error('Read-back renderer requires a host element from its document realm.');
  }
}

/**
 * Call when hiding, closing, switching session, unmounting or clearing the
 * Read-back surface. A plain host.replaceChildren() is NOT sufficient to
 * revoke an in-flight result: this generation fence prevents stale repaint.
 * This does not cancel validation CPU work; it prevents later disclosure.
 * Never calls projectors, storage, network, or the live 1.3 application.
 */
export function invalidateReviewedKnownFact14ReadBackForReview(host: HTMLElement): void {
  requireHost(host);
  renderSequence.set(host, (renderSequence.get(host) ?? 0) + 1);
  host.replaceChildren();
}

/**
 * Clears any previous preview BEFORE awaiting source validation. A stale
 * rejected or overlapping render must not preserve or revive a prior view.
 * No text from validation errors is surfaced into the client document.
 */
export async function renderReviewedKnownFact14ReadBackForReview(
  host: HTMLElement,
  rawSession: unknown,
  rawReview: unknown,
): Promise<'rendered' | 'superseded'> {
  requireHost(host);
  const token = (renderSequence.get(host) ?? 0) + 1;
  renderSequence.set(host, token);
  const doc = host.ownerDocument;

  // Fail closed even if the validation is delayed or rejects.
  host.replaceChildren();

  try {
    const preview = await projectReviewedKnownFact14ReadBackForReview(rawSession, rawReview);
    if (renderSequence.get(host) !== token) return 'superseded';

    const fragment = doc.createDocumentFragment();
    addTextElement(doc, fragment, 'h2', 'Client Read-back — discussion preview');
    addTextElement(doc, fragment, 'p', preview.notice);
    addTextElement(doc, fragment, 'p', 'Reviewed revision: ' + preview.revision);
    addTextElement(doc, fragment, 'p', 'Source updated: ' + preview.sessionUpdatedAt);

    if (preview.entries.length === 0) {
      addTextElement(doc, fragment, 'p', 'No items selected for disclosure.');
    } else {
      const list = doc.createElement('ol');
      for (const entry of preview.entries) {
        const item = doc.createElement('li');
        addTextElement(doc, item, 'h3', entry.label);
        addTextElement(doc, item, 'p', 'Status: ' + entry.status);
        addTextElement(
          doc, item, 'p',
          entry.value === null ? 'No current answer text selected.' : entry.value,
        );
        if (entry.followUp !== undefined) {
          addTextElement(doc, item, 'p', 'Follow-up for discussion: ' + entry.followUp);
        }
        list.appendChild(item);
      }
      fragment.appendChild(list);
    }

    // No innerHTML, text-to-markup, template strings, links, image URLs,
    // data-* attributes or raw session/ledger fields anywhere in output.
    if (renderSequence.get(host) !== token) return 'superseded';
    host.replaceChildren(fragment);
    return 'rendered';
  } catch (error) {
    if (renderSequence.get(host) === token) {
      const notice = doc.createElement('p');
      // Announce the generic failure without revealing validator errors or
      // previously approved client data to an assistive-technology listener.
      // Success previews deliberately have no live region: disclosure requires
      // human review and should not automatically read aloud the entire record.
      notice.setAttribute('role', 'alert');
      notice.textContent = 'Read-back unavailable. Review the current session before presenting.';
      host.replaceChildren(notice);
    }
    throw error;
  }
}

import { prepareInterviewCandidateReviewForReview, type InterviewPrepReview } from './interview-workflow-bridge';
import { validateSemanticSessionRecord } from './semantic-session';
import { relevanceMap } from './live-session';
import { canonicalizeJson, sha256Hex } from './pack-identity';

/**
 * #105 — DORMANT, SYNTHETIC-ONLY HUMAN INTERVIEW PREP REVIEW.
 * Private single-device browser trial: no app entry import, IndexedDB,
 * provider read, accepted fact mutation, workflow task, or client publication.
 *
 * A human may explicitly choose a candidate for further client confirmation.
 * Choice is NOT accepting source truth or declaring a question Answered.
 * The callback receives only source-bound candidate IDs, never private
 * text/source refs. No automatic callback on mounting, reload or navigation.
 */
export const PREP_REVIEW_SELECTION_VERSION = 'ldw.prep-selection.v1' as const;

export interface PrivatePrepSelectionForReview {
  schemaVersion: typeof PREP_REVIEW_SELECTION_VERSION;
  jobKey: string;
  sessionId: string;
  expectedRevisionId: string;
  expectedPackDigest: string;
  expectedSessionDigest: string;
  expectedPacketDigest: string;
  selections: { questionId: string; candidateId: string }[];
  notice: 'Selections are proposals for client confirmation, not accepted answers or workflow actions.';
}

type Pair = { questionId: string; candidateId: string; control: HTMLInputElement };
const active = new WeakMap<HTMLElement, () => void>();

function node<K extends keyof HTMLElementTagNameMap>(
  doc: Document, tag: K, text?: string,
): HTMLElementTagNameMap[K] {
  const element = doc.createElement(tag);
  if (text !== undefined) element.textContent = text;
  return element;
}
function requireHost(host: HTMLElement): void {
  if (!host || host.nodeType !== 1 || !host.ownerDocument?.defaultView
    || !(host instanceof host.ownerDocument.defaultView.HTMLElement)
    || typeof host.replaceChildren !== 'function') {
    throw new Error('Private preparation review requires a document element.');
  }
}
function digest(source: unknown): Promise<string> {
  // Freeze only JSON material so noncanonical browser objects never become
  // part of a cross-tab/source identity claim.
  return sha256Hex(canonicalizeJson(JSON.parse(JSON.stringify(source))));
}

export function mountPrivateInterviewPrepReviewTrial(
  host: HTMLElement,
  readCurrentPacket: () => unknown | Promise<unknown>,
  readCurrentSession: () => unknown | Promise<unknown>,
  onHumanSelection: (selection: PrivatePrepSelectionForReview) => void,
): { dispose: () => void } {
  requireHost(host);
  if (typeof readCurrentPacket !== 'function' || typeof readCurrentSession !== 'function'
    || typeof onHumanSelection !== 'function') {
    throw new Error('Private preparation review requires explicit readers and local selection receiver.');
  }
  active.get(host)?.();
  const doc = host.ownerDocument;
  const listeners = new AbortController();
  let disposed = false;
  let epoch = 0;

  async function load(): Promise<void> {
    if (disposed) return;
    const token = ++epoch;
    host.replaceChildren(node(doc, 'p', 'Loading synthetic private preparation review…'));
    try {
      const [packetRaw, sourceRaw] = await Promise.all([
        readCurrentPacket(), readCurrentSession(),
      ]);
      const session = await validateSemanticSessionRecord(sourceRaw);
      const plan = await prepareInterviewCandidateReviewForReview(packetRaw, session);
      const [sessionDigest, packetDigest] = await Promise.all([
        digest(session), digest(packetRaw),
      ]);
      if (disposed || token !== epoch) return;
      render(plan, session, sessionDigest, packetDigest, token);
    } catch {
      if (disposed || token !== epoch) return;
      failed('Preparation data could not be verified. Nothing was selected.');
    }
  }

  function failed(message: string): void {
    const alert = node(doc, 'p', message);
    alert.setAttribute('role', 'alert');
    const retry = node(doc, 'button', 'Reload private review');
    retry.type = 'button';
    retry.addEventListener('click', () => { void load(); }, { signal: listeners.signal });
    host.replaceChildren(alert, retry);
  }

  function render(
    plan: InterviewPrepReview,
    session: Awaited<ReturnType<typeof validateSemanticSessionRecord>>,
    sessionDigest: string,
    packetDigest: string,
    loadedEpoch: number,
  ): void {
    const heading = node(doc, 'h2', 'Private preparation — candidate review trial');
    const notice = node(doc, 'p',
      'PRIVATE INTERVIEWER SCREEN. Do not share this screen. Existing sources may '
      + 'be stale or contradictory. Selecting evidence prepares a proposal for '
      + 'client confirmation; it does not answer a question, accept a fact, '
      + 'record consent, or send a task. No external storage or workflow is connected.');
    const questions = node(doc, 'div');
    const pairs: Pair[] = [];
    const relevance = relevanceMap(session);
    let groupNumber = 0;

    for (const row of plan.questions) {
      // Do not offer a presently hidden/pending branch for promotion.
      if (relevance[row.questionId] !== 'relevant') continue;
      const q = session.packSnapshot.questions.find(question => question.id === row.questionId);
      if (!q) continue;
      const fieldset = node(doc, 'fieldset');
      fieldset.appendChild(node(doc, 'legend', q.prompt));
      if (row.conflict) {
        fieldset.appendChild(node(doc, 'p',
          'Conflicting source values. Choose one only after private review, or leave all unselected.'));
      }
      groupNumber++;
      for (const candidate of row.candidates) {
        const label = node(doc, 'label');
        const radio = node(doc, 'input');
        radio.type = 'radio';
        radio.name = 'prep-human-choice-' + groupNumber;
        radio.value = candidate.candidateId;
        // Never preselect from provider confidence or source ordering.
        const value = node(doc, 'span',
          ' Select candidate: ' + candidate.proposedValue
          + ' — source: ' + candidate.sourceSystem
          + '; observed: ' + candidate.observedAt
          + '; claimed confidence: ' + candidate.confidence);
        label.append(radio, value);
        fieldset.appendChild(label);
        pairs.push({ questionId: row.questionId, candidateId: candidate.candidateId, control: radio });
      }
      questions.appendChild(fieldset);
    }

    const ackLabel = node(doc, 'label');
    const acknowledge = node(doc, 'input');
    acknowledge.type = 'checkbox';
    ackLabel.append(acknowledge, doc.createTextNode(
      ' I deliberately reviewed the selected source candidates; they still need client confirmation.'),
    );
    const submit = node(doc, 'button', 'Prepare selected candidate proposal — trial only');
    submit.type = 'button';
    submit.disabled = true;
    const refresh = node(doc, 'button', 'Discard choices and reload private sources');
    refresh.type = 'button';
    const status = node(doc, 'p', 'No selection produced. No canonical answers changed.');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    function update(): void {
      submit.disabled = disposed || !acknowledge.checked || !pairs.some(pair => pair.control.checked);
    }
    acknowledge.addEventListener('change', update, { signal: listeners.signal });
    for (const pair of pairs) {
      pair.control.addEventListener('change', update, { signal: listeners.signal });
    }
    refresh.addEventListener('click', () => { void load(); }, { signal: listeners.signal });

    submit.addEventListener('click', () => {
      if (disposed || loadedEpoch !== epoch || submit.disabled || !acknowledge.checked) return;
      const selected = pairs.filter(pair => pair.control.checked)
        .map(pair => ({ questionId: pair.questionId, candidateId: pair.candidateId }));
      if (selected.length === 0) return;
      submit.disabled = true;
      const token = ++epoch;
      status.textContent = 'Rechecking the exact private source and selection…';
      void (async () => {
        try {
          const [latestPacket, latestSource] = await Promise.all([
            readCurrentPacket(), readCurrentSession(),
          ]);
          const currentSession = await validateSemanticSessionRecord(latestSource);
          const currentPlan = await prepareInterviewCandidateReviewForReview(latestPacket, currentSession);
          const [freshSessionDigest, freshPacketDigest] = await Promise.all([
            digest(currentSession), digest(latestPacket),
          ]);
          if (disposed || token !== epoch) return;
          if (freshSessionDigest !== sessionDigest || freshPacketDigest !== packetDigest
            || currentPlan.jobKey !== plan.jobKey || currentPlan.sessionId !== plan.sessionId
            || currentPlan.revisionId !== plan.revisionId) {
            throw new Error('Source changed before proposal.');
          }
          const currentlyRelevant = relevanceMap(currentSession);
          for (const entry of selected) {
            const question = currentPlan.questions.find(q => q.questionId === entry.questionId);
            if (currentlyRelevant[entry.questionId] !== 'relevant'
              || !question?.candidates.some(c => c.candidateId === entry.candidateId)) {
              throw new Error('Selected evidence changed.');
            }
          }
          // Erase all private values BEFORE invoking a synchronous local
          // receiver. No storage/provider transaction can be inferred here.
          host.replaceChildren();
          onHumanSelection({
            schemaVersion: PREP_REVIEW_SELECTION_VERSION,
            jobKey: currentPlan.jobKey,
            sessionId: currentSession.sessionId,
            expectedRevisionId: currentSession.revisionId,
            expectedPackDigest: currentSession.packIdentity.digest,
            expectedSessionDigest: freshSessionDigest,
            expectedPacketDigest: freshPacketDigest,
            selections: selected,
            notice: 'Selections are proposals for client confirmation, not accepted answers or workflow actions.',
          });
          if (disposed || token !== epoch) return;
          host.replaceChildren(node(doc, 'p',
            'Private candidate proposal assembled in local memory. No answers or tasks were changed.'));
        } catch {
          if (disposed || token !== epoch) return;
          failed('Private source changed or proposal was not accepted. Discarded choices; reload before retry.');
        }
      })();
    }, { signal: listeners.signal });
    host.replaceChildren(heading, notice, questions, ackLabel, submit, refresh, status);
    if (pairs.length === 0) {
      submit.disabled = true;
      status.textContent = 'No currently relevant candidates available for human selection.';
    }
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    ++epoch;
    listeners.abort();
    if (active.get(host) === dispose) active.delete(host);
    host.replaceChildren();
  }
  active.set(host, dispose);
  void load();
  return { dispose };
}

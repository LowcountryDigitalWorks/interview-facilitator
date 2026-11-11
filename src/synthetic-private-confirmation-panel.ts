import { commitClientConfirmedPrepForReview, PREP_CONFIRMATION_TRIAL_VERSION, type ClientConfirmationInputForReview, type ConfirmedPrepCompareAndSaveForReview } from './interview-prep-confirmation-trial';
import { stageSelectedInterviewPrepForReview } from './interview-prep-staging-overlay';
import type { PrivatePrepSelectionForReview } from './interview-prep-review-ui-trial';
import type { InterviewPrepPacket } from './interview-workflow-bridge';
import type { SemanticInterviewSession } from './semantic-session';

/**
 * #105 synthetic-only, interviewer-visible client confirmation. The source
 * suggestion NEVER prepopulates the separately typed client statement.
 * The injected native store is the ONLY persistence boundary. No CRM/provider,
 * authentication, customer data, task or network operation is implemented.
 */
export interface SyntheticConfirmationHost {
  readCurrent: () => SemanticInterviewSession;
  flushPending: () => Promise<void>;
  isCurrent: () => boolean;
  store: ConfirmedPrepCompareAndSaveForReview;
  onSaved: (session: SemanticInterviewSession) => void;
}

function node<K extends keyof HTMLElementTagNameMap>(
  doc: Document, tag: K, contents?: string,
): HTMLElementTagNameMap[K] {
  const el = doc.createElement(tag);
  if (contents !== undefined) el.textContent = contents;
  return el;
}

export async function mountSyntheticConfirmationPanel(
  host: HTMLElement,
  source: SemanticInterviewSession,
  packet: InterviewPrepPacket,
  selection: PrivatePrepSelectionForReview,
  adapters: SyntheticConfirmationHost,
): Promise<{ dispose(): void }> {
  if (!host || !host.ownerDocument || !adapters || !adapters.isCurrent()) {
    throw new Error('Synthetic private confirmation screen is no longer active.');
  }
  const overlay = await stageSelectedInterviewPrepForReview(source, packet, selection);
  if (!host.isConnected || !adapters.isCurrent()) {
    throw new Error('Synthetic selection became stale before confirmation.');
  }
  let active = true;
  let busy = false;
  const doc = host.ownerDocument;
  const listeners = new AbortController();

  const title = node(doc, 'h3', 'Record a separate client-confirmed statement — synthetic only');
  const notice = node(doc, 'p',
    'Research suggestions are NOT answers. Enter what the synthetic client actually stated. '
    + 'The earlier candidate selection is not consent or confirmation. '
    + 'This action writes one synthetic local interview answer; it never sends a task or a provider update.');
  const choicesLabel = node(doc, 'label', 'Question for explicit client confirmation');
  const choices = node(doc, 'select');
  choices.setAttribute('aria-label', 'Question for explicit client confirmation');
  for (const candidate of overlay.candidates) {
    const q = source.packSnapshot.questions.find(x => x.id === candidate.questionId);
    if (!q) throw new Error('Synthetic confirmation question is no longer valid.');
    const option = node(doc, 'option', q.prompt);
    option.value = candidate.questionId;
    choices.appendChild(option);
  }
  choicesLabel.appendChild(choices);
  const statementLabel = node(doc, 'label', 'What the synthetic client actually confirmed');
  const statement = node(doc, 'textarea');
  statement.rows = 3;
  statement.maxLength = 2000;
  statement.required = true;
  statement.placeholder = 'Enter a separate synthetic client statement. Do not paste source suggestions.';
  statement.setAttribute('aria-label', 'What the synthetic client actually confirmed');
  statementLabel.appendChild(statement);

  const acknowledgeLabel = node(doc, 'label');
  const acknowledge = node(doc, 'input');
  acknowledge.type = 'checkbox';
  acknowledgeLabel.append(acknowledge, doc.createTextNode(
    ' I personally confirmed this separate statement during the synthetic interview; '
    + 'it is not an automatic acceptance of the research candidate.'),
  );
  const submit = node(doc, 'button', 'Save synthetic client-confirmed answer locally');
  submit.type = 'button';
  submit.disabled = true;
  const status = node(doc, 'p', 'No confirmed answer has been saved.');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');

  const eligible = () => active && !busy && adapters.isCurrent()
    && acknowledge.checked && statement.value.trim().length > 0
    && statement.value.length <= 2000;
  const update = () => { submit.disabled = !eligible(); };
  statement.addEventListener('input', update, { signal: listeners.signal });
  acknowledge.addEventListener('change', update, { signal: listeners.signal });
  choices.addEventListener('change', () => {
    statement.value = '';
    acknowledge.checked = false;
    status.textContent = 'A separate statement is required for the selected question.';
    update();
  }, { signal: listeners.signal });

  submit.addEventListener('click', () => {
    if (!eligible() || !overlay.candidates.some(c => c.questionId === choices.value)) return;
    busy = true;
    // Freeze the attested inputs until the exact local commit settles.
    choices.disabled = true;
    statement.disabled = true;
    acknowledge.disabled = true;
    submit.disabled = true;
    submit.setAttribute('aria-busy', 'true');
    status.textContent = 'Checking and saving the exact synthetic interview…';
    const selected = overlay.candidates.find(c => c.questionId === choices.value)!;
    const input: ClientConfirmationInputForReview = {
      schemaVersion: PREP_CONFIRMATION_TRIAL_VERSION,
      sessionId: overlay.sessionId,
      jobKey: overlay.jobKey,
      questionId: selected.questionId,
      candidateId: selected.candidateId,
      clientStatement: statement.value,
      confirmedAt: new Date().toISOString(),
      operatorAttestation: 'client-confirmed-in-interview',
      operatorAcknowledged: true,
    };
    void (async () => {
      try {
        await adapters.flushPending();
        if (!active || !adapters.isCurrent()) return;
        const current = adapters.readCurrent();
        const result = await commitClientConfirmedPrepForReview(
          current, packet, overlay, input, {
            compareAndSave: (sessionId, expected, proposed) => {
              if (!active || !adapters.isCurrent()) return Promise.resolve(null);
              return adapters.store.compareAndSave(sessionId, expected, proposed);
            },
          },
        );
        if (!active || !adapters.isCurrent()) return;
        if (result.kind === 'stale-no-write') {
          status.textContent = 'The local interview changed. No confirmation was saved. Reload and re-review.';
          return;
        }
        adapters.onSaved(result.session);
      } catch {
        if (active && adapters.isCurrent()) {
          status.textContent = 'Could not verify the synthetic confirmation save. Reopen the interview before retrying; no success is claimed.';
        }
      } finally {
        busy = false;
        submit.removeAttribute('aria-busy');
        // Success replaces this private panel. On failure restore controls
        // while requiring a new human attestation before any retry.
        if (active && adapters.isCurrent()) {
          choices.disabled = false;
          statement.disabled = false;
          acknowledge.disabled = false;
          acknowledge.checked = false;
          update();
        }
      }
    })();
  }, { signal: listeners.signal });

  host.replaceChildren(title, notice, choicesLabel, statementLabel, acknowledgeLabel, submit, status);
  return {
    dispose() {
      if (!active) return;
      active = false;
      listeners.abort();
      // Confidential typed statement and candidate choice are removed.
      host.replaceChildren();
    },
  };
}

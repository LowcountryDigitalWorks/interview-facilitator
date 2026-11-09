import './styles.css';
import type { AnswerStatus, Question } from './domain';
import { DEFAULT_INTERVIEW_PACK_ID, LIVE_INTERVIEW_PACK_OPTIONS, defaultLiveInterviewPack, findLiveInterviewPack } from './interview-packs';
import { deleteSession, exportRecoveryBackup, listSessions, loadKnownFactSession14ForReview, loadSession, migrateLegacySession, replaceSessionWithHistory, requestPersistentStorage, RevisionConflictError, saveSession } from './storage';
import { exportCanonicalSessionJsonForReview } from './versioned-session-io';
import { semanticSessionToMarkdown, serializeSession } from './markdown';
import { proposeInterviewNextStepsForReview } from './interview-workflow-bridge';
import { canonicalizeJson } from './pack-identity';
import { buildPrivateInterviewHandoffForReview } from './private-interview-handoff';
import { formatConnectivityLabel, formatSaveLabel, type PersistenceState, type SaveState } from './indicators';
import { SessionAutosaveCoordinator } from './autosave';
import { readSessionList } from './session-list';
import { beginSessionSwitch, importSessionWithCollisionHandling, openStoredSession, SessionSwitchGate, shouldFlushActiveSession, type ImportCollisionChoice, type OpenStoredSessionResult } from './session-durability';
import { enterPresentation, exitPresentation, isPresentationMode, projectSemanticReadBack, type PresentationMode } from './presentation';
import { paintUpdateSlot, startControlledUpdates } from './pwa';
import { createSemanticSession, validateSemanticSessionRecord, type SemanticAnswerState, type SemanticInterviewSession } from './semantic-session';
import {
  applyReactivationReviews,
  applyStatusControl,
  applyValueEdit,
  coverage,
  coverageBucketMap,
  nextVisibleQuestion,
  relevanceMap,
  semanticStatusLabel,
  sessionPack,
  statusControlForState,
  visibleQuestions,
} from './live-session';

const appElement = document.querySelector<HTMLDivElement>('#app');
if (!appElement) throw new Error('App root not found.');
const app: HTMLDivElement = appElement;

type View = 'home' | 'new' | 'interview' | 'review';

let view: View = 'home';
let session: SemanticInterviewSession | null = null;
let saveState: SaveState = 'saved';
let saveError: unknown = null;
let persistenceState: PersistenceState = 'unknown';
let offlineReady = false;
let presentationMode: PresentationMode = 'private';
// Transient navigation only; never part of the canonical session or read-back consent.
let readBackReturnTarget: { sessionId: string; questionId: string } | null = null;
type HomeNotice =
  | null
  | { kind: 'read'; message: string }
  | { kind: 'save'; message: string; sessionId: string };

let homeNotice: HomeNotice = null;
const sessionSwitchGate = new SessionSwitchGate();

const autosave = new SessionAutosaveCoordinator(saveSession);

const statusOptions: { value: AnswerStatus; label: string }[] = [
  { value: 'ANSWERED', label: 'Answered' },
  { value: 'ALREADY_KNOWN', label: 'Already known' },
  { value: 'SKIP', label: 'Skip' },
  { value: 'N_A', label: 'N/A' },
  { value: 'MUST_CONFIRM', label: 'Must confirm' }
];

function updateSlotMarkup(): string {
  return `<span class="update-slot" data-update-slot data-client-release="${escapeHtml(__APP_RELEASE__)}"></span>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char] ?? char);
}

function download(filename: string, contents: string, type: string): void {
  const blob = new Blob([contents], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function currentQuestion(): Question | undefined {
  if (!session) return undefined;
  const active = session;
  const questions = visibleQuestions(active);
  return questions.find((question) => question.id === active.currentQuestionId) ?? questions[0];
}

async function refreshPersistenceState(): Promise<void> {
  try {
    persistenceState = (await requestPersistentStorage()) === true ? 'persistent' : 'best-effort';
  } catch {
    persistenceState = 'best-effort';
  }
}

function scheduleSave(): void {
  if (!session) return;
  autosave.schedule(session, {
    onScheduled: (sessionId) => {
      if (session?.sessionId !== sessionId) return;
      saveError = null;
      saveState = 'saving';
    },
    onSaved: (sessionId, savedSession) => {
      if (session?.sessionId !== sessionId) return;
      session.updatedAt = savedSession.updatedAt;
      session.revisionId = savedSession.revisionId;
      session.parentRevisionId = savedSession.parentRevisionId;
      saveError = null;
      saveState = 'saved';
      updateStateIndicators();
    },
    onError: (sessionId, error) => {
      console.error('Local save failed.', error);
      if (session?.sessionId !== sessionId) return;
      saveError = error;
      saveState = 'error';
      updateStateIndicators();
    }
  });
}

function saveLabel(): string {
  return formatSaveLabel(saveState, persistenceState);
}

function saveAlertMessage(): string {
  if (saveState !== 'error') return '';
  if (saveError instanceof RevisionConflictError) return 'Another tab saved a newer revision. Reload to use it; export a backup before leaving to preserve this tab’s unsaved edits.';
  return 'Local save failed. Export a backup or retry before leaving this interview.';
}

function connectivityLabel(): string {
  return formatConnectivityLabel(navigator.onLine, offlineReady);
}

function updateStateIndicators(): void {
  app.querySelectorAll<HTMLElement>('[data-save-indicator]').forEach((element) => {
    element.textContent = saveLabel();
    element.classList.toggle('danger', saveState === 'error');
  });
  app.querySelectorAll<HTMLElement>('[data-save-alert]').forEach((element) => {
    element.textContent = saveAlertMessage();
  });
  app.querySelectorAll<HTMLElement>('[data-connectivity-indicator]').forEach((element) => {
    element.textContent = connectivityLabel();
  });
}

function refreshConnectivityIndicators(announce = false): void {
  if (view === 'new') return;
  updateStateIndicators();
  if (announce) {
    app.querySelectorAll<HTMLElement>('[data-connectivity-status]').forEach((element) => {
      element.textContent = connectivityLabel();
    });
  }
}

function focusPrimaryAnswer(): void {
  queueMicrotask(() => app.querySelector<HTMLElement>('#answer, input[name="answer"]')?.focus());
}

function visibleQuestionKey(active: SemanticInterviewSession): string {
  return visibleQuestions(active).map((item) => item.id).join('\u001f');
}

function blankSemanticState(): SemanticAnswerState {
  return {
    value: null,
    resolution: 'unresolved',
    source: null,
    needsConfirmation: false,
    confirmation: null,
    followUp: null,
    note: '',
  };
}

function setInert(element: Element | null | undefined, inert: boolean): void {
  if (!element || !(element instanceof HTMLElement)) return;
  element.inert = inert;
}

function focusReviewHeading(): void {
  queueMicrotask(() => app.querySelector<HTMLElement>('#review-title')?.focus());
}

function focusReadBackChange(questionId: string, sessionId: string): void {
  queueMicrotask(() => {
    if (view !== 'review' || session?.sessionId !== sessionId) return;
    const target = Array.from(app.querySelectorAll<HTMLElement>('[data-change]'))
      .find((button) => button.dataset.change === questionId);
    (target ?? app.querySelector<HTMLElement>('#review-title'))?.focus();
  });
}

async function openStoredSessionForPack(sessionId: string): Promise<OpenStoredSessionResult<SemanticInterviewSession>> {
  const result = await openStoredSession({
    sessionId,
    flush: (id) => autosave.flushAndWait(id),
    load: loadSession,
  });
  return result;
}

function chooseImportCollision(existing: SemanticInterviewSession): Promise<ImportCollisionChoice> {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'import-collision-dialog';
    dialog.setAttribute('aria-labelledby', 'import-collision-title');
    dialog.innerHTML = `
      <div class="import-collision-content">
        <p class="eyebrow">Import collision</p>
        <h2 id="import-collision-title">This interview already exists on this device.</h2>
        <p>The imported file has the same session ID as <strong>${escapeHtml(existing.clientLabel)}</strong>, but its interview content is different.</p>
        <div class="known-preview">
          <strong>Safest choice: Import as copy</strong>
          <p>This keeps the current interview unchanged and gives the imported file a new session and revision lineage.</p>
        </div>
        <div class="button-row">
          <button type="button" class="primary" data-import-choice="copy">Import as copy</button>
          <button type="button" class="secondary" data-import-choice="replace">Replace existing</button>
          <button type="button" class="secondary" data-import-choice="cancel">Cancel — keep current</button>
        </div>
        <p class="helper-text">Replace existing is explicit: the current validated revision is retained in local revision history before the imported content becomes current.</p>
      </div>`;
    const settle = (choice: ImportCollisionChoice) => {
      if (dialog.open) dialog.close();
      dialog.remove();
      resolve(choice);
    };
    dialog.querySelectorAll<HTMLButtonElement>('[data-import-choice]').forEach((button) => {
      button.addEventListener('click', () => settle(button.dataset.importChoice as ImportCollisionChoice));
    });
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      settle('cancel');
    }, { once: true });
    document.body.append(dialog);
    dialog.showModal();
    dialog.querySelector<HTMLButtonElement>('[data-import-choice="copy"]')?.focus();
  });
}

async function renderHome(): Promise<void> {
  readBackReturnTarget = null;
  const listState = await readSessionList(listSessions);
  const storageError = listState.kind === 'error';
  const recent = listState.kind === 'ready' ? listState.sessions : [];
  const unreadableCount = listState.kind === 'ready' ? listState.unreadableCount : 0;
  const storedRows = listState.kind === 'ready' ? listState.rows : [];
  const readOnly14 = storedRows.filter((row) => row.classification === 'current-known-fact-14');
  if (storageError) console.error('Unable to read local interviews.', listState.error);

  app.innerHTML = `
    <header class="app-header"><div><strong>Interview Facilitator</strong><span>Local-first discovery cockpit</span></div><span class="state-pill" data-connectivity-indicator>${escapeHtml(connectivityLabel())}</span>${updateSlotMarkup()}</header>
    <main id="main" class="home-shell">
      <section class="hero-card">
        <p class="eyebrow">Human-led discovery</p>
        <h1>Keep the conversation natural. Keep the coverage visible.</h1>
        <p>Run a guided interview without turning the call into form filling. Sessions save locally and remain usable without a network after the app is cached.</p>
        <div class="known-preview"><strong>Local data stays local to this browser/app context.</strong><p>Installing later or switching browsers may not carry an in-progress interview with you. Use Export backup before changing devices, browsers, or install context.</p></div>
        <div class="button-row"><button class="primary" data-action="new" ${storageError ? 'disabled aria-describedby="storage-read-error"' : ''}>New interview</button><button class="secondary" data-action="import" ${storageError ? 'disabled aria-describedby="storage-read-error"' : ''}>Import session JSON</button></div>
        <input id="import-file" type="file" accept="application/json,.json" hidden />
      </section>
      <section class="section-block">
        <div class="section-heading"><div><p class="eyebrow">On this device</p><h2>Recent interviews</h2></div><span>${storageError ? 'Storage unavailable' : `${recent.length + readOnly14.length} local`}</span></div>
        <div class="session-list">
          ${storageError ? `
            <div id="storage-read-error" class="known-preview" role="alert" aria-live="assertive">
              <strong>Local interviews could not be read.</strong>
              <p>Your browser's local interview storage is currently unavailable. This does not mean your interviews were deleted. Retry before creating or importing another local interview.</p>
              <div class="button-row"><button class="secondary" data-action="retry-storage">Retry local storage</button>${session ? '<button class="secondary" data-action="return-active">Return to active interview</button><button class="secondary" data-action="export-active">Export active backup</button>' : ''}</div>
            </div>` : `
            ${homeNotice ? renderHomeNotice(homeNotice) : ''}
            ${unreadableCount > 0 ? `
            <div class="known-preview" role="status">
              <strong>${unreadableCount} local interview${unreadableCount === 1 ? '' : 's'} could not be read.</strong>
              <p>${unreadableCount === 1 ? 'It was' : 'They were'} not deleted.</p>
            </div>` : ''}
            ${readOnly14.map((row) => `<div class="known-preview"><strong>${escapeHtml(row.session.clientLabel)} — 1.4 interview (read-only)</strong><p>This validated interview remains on this device. Editing and importing 1.4 JSON are not supported in this build. You can export a complete canonical JSON backup, but this build cannot restore that backup. Keep the original local record until a compatible version is available.</p><button type="button" class="secondary" data-versioned-json-id="${escapeHtml(row.sessionId)}">Export full 1.4 JSON backup</button></div>`).join('')}
            ${storedRows.filter((row) => row.classification === 'legacy-migratable').map((row) => `<div class="known-preview"><strong>Older interview format</strong><p>This interview can be upgraded while preserving its original record.</p><button class="secondary" data-upgrade-id="${escapeHtml(row.sessionId)}">Upgrade</button></div>`).join('')}
            ${storedRows.filter((row) => row.classification === 'unsupported-recoverable').map((row) => `<div class="known-preview"><strong>Unsupported interview format</strong><p>Back up this internal recovery data. It is not a client interview artifact.</p><button class="secondary" data-recovery-id="${escapeHtml(row.sessionId)}">Download recovery backup</button></div>`).join('')}
            ${storedRows.filter((row) => row.classification === 'malformed-unreadable').map((row) => `<div class="known-preview" role="status"><strong>An interview record could not be read.</strong><p>It remains stored and was left unchanged.</p>${row.recoveryAvailable ? `<button class="secondary" data-recovery-id="${escapeHtml(row.sessionId)}">Download recovery backup</button>` : ''}</div>`).join('')}
            ${recent.length ? recent.map((item) => `
              <button class="session-card" data-session-id="${escapeHtml(item.sessionId)}">
                <span><strong>${escapeHtml(item.clientLabel)}</strong><small>${escapeHtml(item.interviewMode)} · updated ${escapeHtml(new Date(item.updatedAt).toLocaleString())}</small></span>
                <span aria-hidden="true">→</span>
              </button>`).join('') : readOnly14.length ? '' : '<div class="empty-card">No saved interviews yet.</div>'}`}
        </div>
      </section>
    </main>`;

  app.querySelector('[data-action="retry-storage"]')?.addEventListener('click', () => { homeNotice = null; void renderHome(); });
  app.querySelector('[data-action="dismiss-home-notice"]')?.addEventListener('click', () => { homeNotice = null; void renderHome(); });
  app.querySelector('[data-action="return-active"]')?.addEventListener('click', () => { if (!session) return; homeNotice = null; view = 'interview'; render(); });
  app.querySelector('[data-action="export-active"]')?.addEventListener('click', () => {
    if (!session) return;
    download(`${session.clientLabel.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-interview.json`, serializeSession(session), 'application/json');
  });
  app.querySelectorAll<HTMLButtonElement>('[data-versioned-json-id]').forEach((button) => button.addEventListener('click', async () => {
    if (button.disabled) return;
    button.disabled = true;
    try {
      // Re-read the current persisted row before export: a different tab may
      // have advanced it since the home list was rendered. Never use a stale
      // displayed copy or route 1.4 through 1.3 serialization.
      const stored = await loadKnownFactSession14ForReview(button.dataset.versionedJsonId ?? '');
      if (!stored) {
        homeNotice = { kind: 'read', message: 'This 1.4 interview is no longer on this device, possibly because another tab removed it. No backup was created. The local session list has been refreshed.' };
        await renderHome();
        return;
      }
      const contents = await exportCanonicalSessionJsonForReview(stored);
      download(`${stored.clientLabel.replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'interview'}-1.4-backup.json`, contents, 'application/json');
    } catch (error) {
      const sizeLimited = error instanceof Error && error.message === 'Session export exceeds the safe size limit.';
      homeNotice = { kind: 'read', message: sizeLimited
        ? 'This 1.4 interview is larger than the safe JSON export limit. No backup was created. The local record was not changed, and this build has no oversized-file recovery export. Keep the original device and do not clear browser storage.'
        : 'The 1.4 interview could not be validated or exported. No backup was created. The local record was not modified by this export attempt. Retry after checking local storage; do not clear this device until a usable backup exists.' };
      await renderHome();
    } finally {
      button.disabled = false;
    }
  }));
  app.querySelectorAll<HTMLElement>('[data-upgrade-id]').forEach((button) => button.addEventListener('click', async () => {
    if (!(button instanceof HTMLButtonElement) || button.disabled) return;
    button.disabled = true;
    try {
      const result = await migrateLegacySession(button.dataset.upgradeId ?? '');
      if (result.kind === 'migrated' || result.kind === 'already-migrated') { homeNotice = null; await renderHome(); }
      else {
        const detail = 'reason' in result ? ` ${result.reason}` : ` (${result.kind})`;
        homeNotice = { kind: 'read', message: `Upgrade did not complete.${detail} The original interview and any prior recovery record were preserved.` };
        await renderHome();
      }
    } catch (error) {
      const detail = error instanceof Error ? ` ${error.message}` : '';
      homeNotice = { kind: 'read', message: `Upgrade failed.${detail} The original interview and any prior recovery record were preserved.` };
      await renderHome();
    } finally {
      button.disabled = false;
    }
  }));
  app.querySelectorAll<HTMLElement>('[data-recovery-id]').forEach((button) => button.addEventListener('click', async () => {
    try {
      const contents = await exportRecoveryBackup(button.dataset.recoveryId ?? '');
      download('interview-facilitator-recovery-backup.json', contents, 'application/json');
    } catch (error) {
      homeNotice = { kind: 'read', message: error instanceof Error ? error.message : 'Recovery backup could not be created. The stored interview was left unchanged.' };
      await renderHome();
    }
  }));

  if (!storageError) {
    app.querySelector('[data-action="new"]')?.addEventListener('click', () => { homeNotice = null; view = 'new'; render(); });
    app.querySelector('[data-action="import"]')?.addEventListener('click', () => (app.querySelector<HTMLInputElement>('#import-file')?.click()));
  }

  app.querySelector<HTMLInputElement>('#import-file')?.addEventListener('change', async (event) => {
    const fileInput = event.currentTarget as HTMLInputElement;
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    let imported: SemanticInterviewSession;
    try {
      imported = await validateSemanticSessionRecord(JSON.parse(await file.text()));
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Unable to import session.');
      return;
    }

    const gated = await sessionSwitchGate.run(async () => {
      const outcome = await beginSessionSwitch({
        active: session,
        nextSessionId: imported.sessionId,
        flush: (sessionId) => autosave.flushAndWait(sessionId),
        proceed: () => importSessionWithCollisionHandling({
          imported,
          flush: (sessionId) => autosave.flushAndWait(sessionId),
          load: loadSession,
          chooseCollision: chooseImportCollision,
          save: async (value, expectedRevisionId) => {
            await refreshPersistenceState();
            return saveSession(value, expectedRevisionId);
          },
          replace: async (value, expectedRevisionId) => {
            await refreshPersistenceState();
            return replaceSessionWithHistory(value, expectedRevisionId);
          },
        }),
      });
      if (outcome.kind === 'save-failure') {
        await showOutgoingSaveFailure(outcome.error);
        return;
      }
      const result = outcome.value;

      if (result.kind === 'imported' || result.kind === 'noop' || result.kind === 'forked' || result.kind === 'replaced') {
        // A successful import, including a same-ID replacement, starts a new navigation context.
        readBackReturnTarget = null;
        session = result.session;
        homeNotice = null;
        saveError = null;
        saveState = 'saved';
        presentationMode = exitPresentation();
        view = 'interview';
        render();
        return;
      }
      if (result.kind === 'aborted-cancelled') return;
      if (result.kind === 'aborted-read') {
        console.error('Unable to check the local interview before import.', result.error);
        homeNotice = { kind: 'read', message: 'The local interview could not be read, so the imported file was not saved. No local interviews were changed.' };
        await renderHome();
        return;
      }

      console.error('Local import did not complete.', result.error);
      saveState = 'error';
      homeNotice = {
        kind: 'save',
        sessionId: imported.sessionId,
        message: result.kind === 'aborted-flush'
          ? 'Pending local edits could not be saved, so the imported file was not written. The in-memory interview is unchanged.'
          : result.error instanceof RevisionConflictError
            ? 'Another tab changed this interview after the import decision. Import was stopped and the newer local revision was left unchanged.'
            : 'The imported file could not be saved. Existing local interviews and retained revision history were left unchanged.',
      };
      await renderHome();
    });
    if (gated.kind === 'busy') return;
  });
  app.querySelectorAll<HTMLElement>('[data-session-id]').forEach((button) => button.addEventListener('click', async () => {
    const sessionId = button.dataset.sessionId ?? '';
    const gated = await sessionSwitchGate.run(async () => {
      const outcome = await beginSessionSwitch({
        active: session,
        nextSessionId: sessionId,
        flush: (id) => autosave.flushAndWait(id),
        proceed: () => openStoredSessionForPack(sessionId),
      });
      if (outcome.kind === 'save-failure') {
        await showOutgoingSaveFailure(outcome.error);
        return;
      }
      const result = outcome.value;
      if (result.kind === 'opened') {
        // Opening a stored copy must not inherit a prior Read-back correction target.
        readBackReturnTarget = null;
        session = result.session;
        homeNotice = null;
        saveState = 'saved';
        await refreshPersistenceState();
        presentationMode = exitPresentation();
        view = 'interview';
        render();
        return;
      }
      if (result.kind === 'missing') {
        homeNotice = { kind: 'read', message: 'The selected interview is no longer available in local storage. No other local interviews were changed.' };
        await renderHome();
        return;
      }
      if (result.kind === 'save-failure') {
        console.error('Unable to save local interview before opening.', result.error);
        saveState = 'error';
        homeNotice = {
          kind: 'save',
          sessionId,
          message: 'The latest edits could not be saved on this device. Opening was stopped so an older saved copy would not hide those edits. No other local interviews were changed.',
        };
        await renderHome();
        return;
      }
      console.error('Unable to open local interview.', result.error);
      homeNotice = { kind: 'read', message: 'The selected interview could not be read. No other local interviews were changed. Retry from the list when local storage is available.' };
      await renderHome();
    });
    if (gated.kind === 'busy') return;
  }));
  paintUpdateSlot();
}

async function showOutgoingSaveFailure(error: unknown): Promise<void> {
  console.error('Local save failed.', error);
  saveError = error;
  if (!session) return;
  saveState = 'error';
  homeNotice = {
    kind: 'save',
    sessionId: session.sessionId,
    message: error instanceof RevisionConflictError
      ? 'Another tab saved a newer revision. Reload to use it; export this active backup before leaving to preserve this tab’s unsaved edits. Switching was stopped.'
      : 'The latest edits could not be saved on this device. Switching was stopped so this interview stays available to return to or export. No other local interview was changed.',
  };
  view = 'home';
  await renderHome();
}

function renderHomeNotice(notice: Exclude<HomeNotice, null>): string {
  if (notice.kind === 'save') {
    const canRecover = session?.sessionId === notice.sessionId;
    return `<div class="known-preview" role="alert" aria-live="assertive"><strong>Local save failed.</strong><p>${escapeHtml(notice.message)}</p><div class="button-row"><button class="secondary" data-action="dismiss-home-notice">Dismiss</button>${canRecover ? '<button class="secondary" data-action="return-active">Return to active interview</button><button class="secondary" data-action="export-active">Export active backup</button>' : ''}</div></div>`;
  }
  return `<div class="known-preview" role="status" aria-live="polite"><strong>Local interview could not be opened.</strong><p>${escapeHtml(notice.message)}</p><div class="button-row"><button class="secondary" data-action="dismiss-home-notice">Dismiss</button></div></div>`;
}

function renderNew(): void {
  readBackReturnTarget = null;
  const pack = defaultLiveInterviewPack();
  app.innerHTML = `
    <header class="app-header"><div><strong>Interview Facilitator</strong><span>New interview</span></div>${updateSlotMarkup()}</header>
    <main id="main" class="form-shell">
      <button class="text-button" data-action="home">← Back</button>
      <p class="eyebrow">Prepare · <span data-prepare-pack-title>${escapeHtml(pack.title)}</span> · pack v<span data-prepare-pack-version>${escapeHtml(pack.packVersion)}</span></p><h1>Prepare this interview</h1><p data-prepare-pack-description>${escapeHtml(pack.description)}</p>
      <form id="new-form" class="setup-card">
        <label>Interview type
          <select id="interview-pack" name="packId" required>
            ${LIVE_INTERVIEW_PACK_OPTIONS.map((option) => `<option value="${escapeHtml(option.id)}" ${option.id === DEFAULT_INTERVIEW_PACK_ID ? 'selected' : ''}>${escapeHtml(option.title)}</option>`).join('')}
          </select>
        </label>
        <p class="helper-text" data-prepare-pack-summary>${pack.questions.length} guided questions. Client facts are not imported or accepted automatically.</p>
        <label>Project or client label<input name="clientLabel" required autocomplete="off" placeholder="Example Project" /></label>
        <label>Interviewer <span>(optional)</span><input name="interviewerLabel" autocomplete="off" /></label>
        <label>Interview mode<select name="interviewMode"><option>Conversation</option><option>Phone</option><option>Video call</option><option>In person</option></select></label>
        <section class="known-preview" aria-labelledby="prepare-known-title">
           <h2 id="prepare-known-title">Known context for review</h2>
           <p>No client-specific information has been preloaded. Add confirmed answers during the interview; never enter credentials or other secrets. Any future private preparation requires separate authorized review.</p>
           ${pack.knownFacts.length
             ? pack.knownFacts.map((fact) => `<div class="prepare-fact"><strong>${escapeHtml(fact.label)}</strong><p>${escapeHtml(fact.value)}</p><small>Source: ${escapeHtml(fact.provenance)}</small></div>`).join('')
             : '<p>No known context supplied with this pack.</p>'}
         </section>
         <section class="prepare-readiness" aria-labelledby="prepare-readiness-title">
           <h2 id="prepare-readiness-title">Before you start</h2>
           <dl>
             <div><dt>Local save</dt><dd data-prepare-save>Not saved yet. Start interview saves a new local record; keep an export backup separately.</dd></div>
             <div><dt>Offline shell</dt><dd data-prepare-offline>${offlineReady
               ? 'This exact application release reports its offline shell ready on this device. Client data still needs a separate backup.'
               : 'Offline readiness has not been confirmed for this application release. The first load may need connectivity.'}</dd></div>
             <div><dt>Browser storage</dt><dd data-prepare-storage>${persistenceState === 'persistent'
               ? 'The browser previously reported protected storage for this origin; local data can still be cleared by user or device policy.'
               : persistenceState === 'best-effort'
                 ? 'Best effort on this device; browser data can be removed.'
                 : 'Protection not yet checked for this interview. Local browser data is not a backup.'}</dd></div>
             <div><dt>Backup</dt><dd>After starting, use Export JSON backup and store a copy outside this browser.</dd></div>
           </dl>
         </section>
        <button class="primary" type="submit">Start interview</button>
      </form>
    </main>`;
  app.querySelector('[data-action="home"]')?.addEventListener('click', () => { view = 'home'; render(); });
  const packPicker = app.querySelector<HTMLSelectElement>('#interview-pack');
  packPicker?.addEventListener('change', () => {
    const selected = findLiveInterviewPack(packPicker.value);
    if (!selected) {
      packPicker.setCustomValidity('Choose an available interview type.');
      return;
    }
    packPicker.setCustomValidity('');
    const title = app.querySelector<HTMLElement>('[data-prepare-pack-title]');
    const version = app.querySelector<HTMLElement>('[data-prepare-pack-version]');
    const description = app.querySelector<HTMLElement>('[data-prepare-pack-description]');
    const summary = app.querySelector<HTMLElement>('[data-prepare-pack-summary]');
    if (title) title.textContent = selected.title;
    if (version) version.textContent = selected.packVersion;
    if (description) description.textContent = selected.description;
    if (summary) summary.textContent = `${selected.questions.length} guided questions. Client facts are not imported or accepted automatically.`;
  });
  app.querySelector<HTMLFormElement>('#new-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    const selected = findLiveInterviewPack(data.get('packId'));
    if (!selected) {
      packPicker?.setCustomValidity('Choose an available interview type.');
      packPicker?.reportValidity();
      return;
    }
    const gated = await sessionSwitchGate.run(async () => {
      const next = await createSemanticSession(selected, {
        clientLabel: String(data.get('clientLabel') ?? ''),
        interviewerLabel: String(data.get('interviewerLabel') ?? ''),
        interviewMode: String(data.get('interviewMode') ?? '')
      });
      try {
        const outcome = await beginSessionSwitch({
          active: session,
          nextSessionId: next.sessionId,
          flush: (id) => autosave.flushAndWait(id),
          proceed: async () => {
            await refreshPersistenceState();
            return saveSession(next, null);
          },
        });
        if (outcome.kind === 'save-failure') {
          await showOutgoingSaveFailure(outcome.error);
          return;
        }
        // A newly created session never inherits transient correction navigation.
        readBackReturnTarget = null;
        session = outcome.value;
        homeNotice = null;
        saveState = 'saved';
        presentationMode = exitPresentation();
        view = 'interview';
        render();
      } catch (error) {
        saveState = 'error';
        alert(error instanceof Error ? error.message : 'Unable to create local interview.');
      }
    });
    if (gated.kind === 'busy') return;
  });
  paintUpdateSlot();
}

function answerControl(question: Question, value: string): string {
  const describedBy = question.help ? ' aria-describedby="question-help"' : '';
  if (question.kind === 'textarea') return `<textarea id="answer" rows="6" aria-labelledby="question-prompt"${describedBy} placeholder="Capture the useful answer, not a transcript.">${escapeHtml(value)}</textarea>`;
  if (question.kind === 'single') return `<fieldset class="choice-group" aria-labelledby="question-prompt"${describedBy}><legend class="sr-only">${escapeHtml(question.prompt)}</legend>${(question.options ?? []).map((option) => `<label class="choice"><input type="radio" name="answer" value="${escapeHtml(option)}" ${value === option ? 'checked' : ''}/><span>${escapeHtml(option)}</span></label>`).join('')}</fieldset>`;
  return `<input id="answer" aria-labelledby="question-prompt"${describedBy} value="${escapeHtml(value)}" />`;
}

function renderInterview(): void {
  if (!session) { view = 'home'; void render(); return; }
  const question = currentQuestion();
  if (!question) return;
  if (session.currentQuestionId !== question.id) session.currentQuestionId = question.id;
  const state = session.answers[question.id] ?? blankSemanticState();
  const stats = coverage(session);
  const buckets = coverageBucketMap(session);
  const section = sessionPack(session).sections.find((item) => item.id === question.sectionId);
  const facts = session.knownFacts.filter((fact) => !fact.questionId || fact.questionId === question.id);
  const presenting = isPresentationMode(presentationMode);

  app.innerHTML = `
    <header class="app-header cockpit-header">
      <div><strong>${escapeHtml(session.clientLabel)}</strong><span>${escapeHtml(sessionPack(session).title)}</span></div>
      <div class="header-states"><span class="state-pill ${saveState === 'error' ? 'danger' : ''}" data-save-indicator aria-live="off">${escapeHtml(saveLabel())}</span>${presenting ? '<span class="state-pill">Presentation view</span><button class="secondary small" data-action="exit-presentation">Exit presentation</button>' : `<span class="state-pill header-connectivity" data-connectivity-indicator>${escapeHtml(connectivityLabel())}</span><button class="secondary small header-presentation" data-action="enter-presentation">Presentation view</button><button class="icon-button header-export" data-action="export" aria-label="Export JSON backup">⇩</button>`}${updateSlotMarkup()}</div>
      <span class="sr-only" role="alert" data-save-alert>${escapeHtml(saveAlertMessage())}</span>
      <span class="sr-only" role="status" aria-live="polite" data-connectivity-status></span>
    </header>
    <main id="main" class="cockpit" ${presenting ? 'style="display:block"' : ''}>
      ${presenting ? '' : `<aside class="coverage-rail" id="coverage-mobile-panel" aria-labelledby="coverage-panel-title">
        <button class="text-button mobile-panel-close" data-action="close-mobile-panel">Close coverage</button>
        <div class="rail-heading"><p class="eyebrow" id="coverage-panel-title">Coverage</p><strong data-coverage-resolved>${stats.resolved} current · ${stats.notApplicable} N/A</strong><span data-coverage-summary>${stats.remaining} currently remaining · ${stats.mustConfirm} must confirm</span></div>
        ${sessionPack(session).sections.map((item) => {
          const questions = visibleQuestions(session!).filter((candidate) => candidate.sectionId === item.id);
          if (!questions.length) return '';
          const done = questions.filter((candidate) => ['current', 'not-applicable'].includes(buckets[candidate.id] ?? 'open')).length;
          return `<div class="coverage-section" data-section-id="${escapeHtml(item.id)}"><span>${escapeHtml(item.title)}</span><small data-section-count>${done}/${questions.length}</small>${questions.map((candidate) => `<button class="question-dot ${candidate.id === question.id ? 'current' : ''} ${buckets[candidate.id] === 'needs-confirmation' ? 'confirm' : ''}" data-question-id="${escapeHtml(candidate.id)}"><span>${escapeHtml(candidate.prompt)}</span></button>`).join('')}</div>`;
        }).join('')}
      </aside>`}
      <section class="question-stage">
        ${presenting ? '<div class="known-preview"><strong>Presentation view</strong><p>Internal notes, provenance, coverage, status controls, and private tools are intentionally excluded. Answer text can still contain sensitive material, so use interviewer judgment while sharing.</p></div>' : `<div class="mobile-tools"><button class="secondary small" type="button" data-action="coverage" id="coverage-mobile-trigger" aria-controls="coverage-mobile-panel" aria-expanded="false" data-coverage-mobile>Coverage ${stats.resolved + stats.notApplicable}/${stats.visible}</button><button class="secondary small" type="button" data-action="context" id="context-mobile-trigger" aria-controls="context-mobile-panel" aria-expanded="false">Context ${facts.length}</button></div>`}
        <p class="eyebrow">${escapeHtml(section?.title ?? '')}</p>
        <h1 id="question-prompt">${escapeHtml(question.prompt)}</h1>
        ${question.help ? `<p id="question-help" class="question-help">${escapeHtml(question.help)}</p>` : ''}
        <div class="answer-block">${answerControl(question, state.value ?? '')}</div>
        ${presenting ? '' : `<label class="notes-label">Question notes <span>internal</span><textarea id="question-note" rows="3" placeholder="Optional interviewer note">${escapeHtml(state.note)}</textarea></label>
        <fieldset class="follow-up-fields" aria-describedby="follow-up-help"><legend>Proposed next step <span>internal, optional</span></legend>
          <label class="notes-label">Proposed follow-up action <textarea id="follow-up-action" rows="2" maxlength="2000" placeholder="Draft an action to review after the interview; no task is created">${escapeHtml(state.followUp?.action ?? '')}</textarea></label>
          <label class="notes-label">Suggested owner <span>not an assignment</span><input id="follow-up-owner" type="text" maxlength="160" value="${escapeHtml(state.followUp?.owner ?? '')}" placeholder="Person or team (optional)"/></label>
          <label class="notes-label">Suggested due date <span>not a commitment</span><input id="follow-up-due-date" type="text" value="${escapeHtml(state.followUp?.dueDate ?? '')}" placeholder="YYYY-MM-DD recommended; older notes are preserved"/></label>
          <p id="follow-up-help" class="helper-text">Only an action is required. Owner and date are suggestions, not assignments or commitments. Drafts save locally and remain hidden in Presentation mode.${relevanceMap(session)[question.id] === 'pending' ? ' This conditional question is pending, so its draft is excluded from active next steps until it becomes relevant.' : ''}</p>
        </fieldset>
        <section class="quick-capture" aria-labelledby="quick-capture-title">
          <h2 id="quick-capture-title">Quick capture</h2>
          <p id="quick-capture-help">Park volunteered or out-of-order details here. Notes autosave locally, stay private in Presentation view, and do not count toward coverage until you transfer them into a question answer.</p>
          <label class="notes-label">Parking notes <span>internal</span><textarea id="running-notes" rows="4" aria-describedby="quick-capture-help" placeholder="Notes to revisit during this interview">${escapeHtml(session.runningNotes)}</textarea></label>
        </section>
        <fieldset class="status-fieldset"><legend>Question status</legend><div class="status-grid">${statusOptions.map((option) => { const selected = statusControlForState(state) === option.value; return `<label class="status-chip ${selected ? 'selected' : ''}"><input type="radio" name="status" value="${option.value}" ${selected ? 'checked' : ''}/><span>${escapeHtml(option.label)}</span></label>`; }).join('')}</div></fieldset>`}
        ${readBackReturnTarget?.sessionId === session.sessionId ? '<div class="button-row"><button class="secondary" type="button" data-action="return-to-readback">Return to Read-back</button></div>' : ''}
        <div class="action-dock"><button class="secondary" data-action="back" ${nextVisibleQuestion(session, question.id, -1) ? '' : 'disabled'}>Back</button><button class="primary" data-action="next">${nextVisibleQuestion(session, question.id, 1) ? 'Continue' : 'Review interview'}</button></div>
      </section>
      ${presenting ? '' : `<aside class="context-rail" id="context-mobile-panel" aria-labelledby="context-panel-title">
        <button class="text-button mobile-panel-close" data-action="close-mobile-panel">Close context</button>
        <section><p class="eyebrow" id="context-panel-title">Known context</p>${facts.length ? facts.map((fact) => `<div class="fact-card"><strong>${escapeHtml(fact.label)}</strong><p>${escapeHtml(fact.value)}</p><small>${escapeHtml(fact.provenance)}</small></div>`).join('') : '<p class="muted">No known facts linked to this question.</p>'}</section>
      </aside>`}
    </main>`;

  const updateCoverageSummary = (): void => {
    if (!session || presenting) return;
    const latest = coverage(session);
    const latestBuckets = coverageBucketMap(session);
    app.querySelector<HTMLElement>('[data-coverage-resolved]')?.replaceChildren(document.createTextNode(`${latest.resolved} current · ${latest.notApplicable} N/A`));
    app.querySelector<HTMLElement>('[data-coverage-summary]')?.replaceChildren(document.createTextNode(`${latest.remaining} currently remaining · ${latest.mustConfirm} must confirm`));
    app.querySelector<HTMLElement>('[data-coverage-mobile]')?.replaceChildren(document.createTextNode(`Coverage ${latest.resolved + latest.notApplicable}/${latest.visible}`));
    app.querySelectorAll<HTMLElement>('[data-section-id]').forEach((sectionElement) => {
      if (!session) return;
      const sectionId = sectionElement.dataset.sectionId ?? '';
      const questions = visibleQuestions(session).filter((candidate) => candidate.sectionId === sectionId);
      const done = questions.filter((candidate) => ['current', 'not-applicable'].includes(latestBuckets[candidate.id] ?? 'open')).length;
      sectionElement.querySelector<HTMLElement>('[data-section-count]')?.replaceChildren(document.createTextNode(`${done}/${questions.length}`));
    });
    app.querySelectorAll<HTMLElement>('[data-question-id]').forEach((button) => {
      const questionId = button.dataset.questionId ?? '';
      button.classList.toggle('confirm', latestBuckets[questionId] === 'needs-confirmation');
    });
  };

  const syncStatusControls = (): void => {
    if (!session || presenting) return;
    const selected = statusControlForState(session.answers[question.id] ?? blankSemanticState());
    app.querySelectorAll<HTMLInputElement>('input[name="status"]').forEach((input) => {
      const isSelected = input.value === selected;
      input.checked = isSelected;
      input.closest<HTMLElement>('.status-chip')?.classList.toggle('selected', isSelected);
    });
  };

  const syncPrivateNotes = (): void => {
    if (!session || presenting) return;
    const current = session.answers[question.id] ?? blankSemanticState();
    current.note = app.querySelector<HTMLTextAreaElement>('#question-note')?.value ?? current.note;
    const followUpField = app.querySelector<HTMLTextAreaElement>('#follow-up-action');
    if (followUpField) {
      const action = followUpField.value.trim();
      const owner = app.querySelector<HTMLInputElement>('#follow-up-owner')?.value.trim() ?? '';
      const rawDueDate = app.querySelector<HTMLInputElement>('#follow-up-due-date')?.value ?? '';
      // Preserve legacy free-text due dates on unrelated note/answer edits.
      // No provider is allowed to parse or act on this unverified suggestion.
      const dueDate = rawDueDate.trim() ? rawDueDate : '';
      current.followUp = action
        ? {
          action,
          ...(owner ? { owner } : {}),
          ...(dueDate ? { dueDate } : {}),
        }
        : null;
    }
    session.answers[question.id] = current;
    session.runningNotes = app.querySelector<HTMLTextAreaElement>('#running-notes')?.value ?? session.runningNotes;
  };

  const commitValue = (nextValue: string | null): void => {
    if (!session) return;
    const before = relevanceMap(session);
    const current = session.answers[question.id] ?? blankSemanticState();
    session.answers[question.id] = applyValueEdit(question, current, nextValue);
    syncPrivateNotes();
    applyReactivationReviews(session, before);
    scheduleSave();
  };

  const commitStatus = (nextStatus: AnswerStatus): void => {
    if (!session) return;
    const before = relevanceMap(session);
    const current = session.answers[question.id] ?? blankSemanticState();
    session.answers[question.id] = applyStatusControl(question, current, nextStatus);
    syncPrivateNotes();
    applyReactivationReviews(session, before);
    scheduleSave();
  };

  const applyAnswer = (): void => {
    if (!session) return;
    const current = session.answers[question.id] ?? blankSemanticState();
    const textarea = app.querySelector<HTMLTextAreaElement>('#answer');
    const input = app.querySelector<HTMLInputElement>('#answer');
    const radio = app.querySelector<HTMLInputElement>('input[name="answer"]:checked');
    const nextValue = textarea?.value ?? input?.value ?? radio?.value ?? current.value;
    commitValue(nextValue);
  };

  const rerenderIfVisibilityChanged = (beforeKey: string, preferredRadioValue?: string): boolean => {
    if (!session) return false;
    const afterVisible = visibleQuestions(session);
    const afterKey = afterVisible.map((item) => item.id).join('\u001f');
    const currentStillVisible = afterVisible.some((item) => item.id === question.id);
    if (beforeKey === afterKey && currentStillVisible) return false;
    if (!currentStillVisible) session.currentQuestionId = afterVisible[0]?.id ?? session.currentQuestionId;
    renderInterview();
    queueMicrotask(() => {
      const restored = preferredRadioValue === undefined ? null : Array.from(app.querySelectorAll<HTMLInputElement>('input[name="answer"]'))
        .find((candidate) => candidate.value === preferredRadioValue);
      if (restored && session?.currentQuestionId === question.id) restored.focus();
      else focusPrimaryAnswer();
    });
    return true;
  };

  app.querySelectorAll<HTMLInputElement>('input[name="answer"]').forEach((element) => element.addEventListener('change', () => {
    if (!session) return;
    const beforeKey = visibleQuestionKey(session);
    commitValue(element.value);
    if (rerenderIfVisibilityChanged(beforeKey, element.value)) return;
    syncStatusControls();
    updateCoverageSummary();
    queueMicrotask(() => element.focus());
  }));

  app.querySelectorAll<HTMLInputElement>('input[name="status"]').forEach((element) => element.addEventListener('change', () => {
    if (!session) return;
    const beforeKey = visibleQuestionKey(session);
    commitStatus(element.value as AnswerStatus);
    if (rerenderIfVisibilityChanged(beforeKey)) return;
    syncStatusControls();
    updateCoverageSummary();
    queueMicrotask(() => element.focus());
  }));

  app.querySelector<HTMLElement>('#answer')?.addEventListener('input', () => {
    if (!session) return;
    const beforeKey = visibleQuestionKey(session);
    const textarea = app.querySelector<HTMLTextAreaElement>('#answer');
    const input = app.querySelector<HTMLInputElement>('#answer');
    commitValue(textarea?.value ?? input?.value ?? null);
    if (!rerenderIfVisibilityChanged(beforeKey)) {
      syncStatusControls();
      updateCoverageSummary();
    }
  });
  app.querySelector<HTMLTextAreaElement>('#question-note')?.addEventListener('input', () => { syncPrivateNotes(); scheduleSave(); });
  for (const id of ['#follow-up-action', '#follow-up-owner', '#follow-up-due-date']) {
    app.querySelector<HTMLElement>(id)?.addEventListener('input', () => { syncPrivateNotes(); scheduleSave(); });
    if (id === '#follow-up-due-date') {
      app.querySelector<HTMLElement>(id)?.addEventListener('change', () => { syncPrivateNotes(); scheduleSave(); });
    }
  }
  app.querySelector<HTMLTextAreaElement>('#running-notes')?.addEventListener('input', () => { syncPrivateNotes(); scheduleSave(); });

  app.querySelectorAll<HTMLElement>('[data-question-id]').forEach((button) => button.addEventListener('click', () => { applyAnswer(); if (session) session.currentQuestionId = button.dataset.questionId ?? session.currentQuestionId; renderInterview(); focusPrimaryAnswer(); }));
  app.querySelector('[data-action="back"]')?.addEventListener('click', () => { applyAnswer(); const previous = session && nextVisibleQuestion(session, question.id, -1); if (previous && session) session.currentQuestionId = previous.id; renderInterview(); focusPrimaryAnswer(); });
  app.querySelector('[data-action="next"]')?.addEventListener('click', () => { applyAnswer(); const next = session && nextVisibleQuestion(session, question.id, 1); if (next && session) { session.currentQuestionId = next.id; renderInterview(); focusPrimaryAnswer(); } else { readBackReturnTarget = null; presentationMode = enterPresentation(); view = 'review'; renderReview(); focusReviewHeading(); } });
  app.querySelector('[data-action="return-to-readback"]')?.addEventListener('click', () => {
    if (!session || readBackReturnTarget?.sessionId !== session.sessionId) return;
    const target = readBackReturnTarget;
    applyAnswer();
    readBackReturnTarget = null;
    view = 'review';
    renderReview();
    focusReadBackChange(target.questionId, target.sessionId);
  });
  app.querySelector('[data-action="enter-presentation"]')?.addEventListener('click', () => { applyAnswer(); presentationMode = enterPresentation(); renderInterview(); focusPrimaryAnswer(); });
  app.querySelector('[data-action="exit-presentation"]')?.addEventListener('click', () => { applyAnswer(); presentationMode = exitPresentation(); renderInterview(); focusPrimaryAnswer(); });
  app.querySelector('[data-action="export"]')?.addEventListener('click', () => { if (session) download(`${session.clientLabel.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-interview.json`, serializeSession(session), 'application/json'); });
  let mobileTrigger: HTMLElement | null = null;
  let mobilePanel: HTMLElement | null = null;
  let mobileEscapeHandler: ((event: KeyboardEvent) => void) | null = null;
  let mobileTrapHandler: ((event: KeyboardEvent) => void) | null = null;

  const coverageTrigger = app.querySelector<HTMLElement>('#coverage-mobile-trigger');
  const contextTrigger = app.querySelector<HTMLElement>('#context-mobile-trigger');
  const coveragePanel = app.querySelector<HTMLElement>('#coverage-mobile-panel');
  const contextPanel = app.querySelector<HTMLElement>('#context-mobile-panel');
  const questionStage = app.querySelector<HTMLElement>('.question-stage');
  const headerPrivateControls = app.querySelectorAll<HTMLElement>('.header-presentation, .header-export');

  const focusableWithin = (root: HTMLElement): HTMLElement[] => Array.from(
    root.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'),
  ).filter((node) => node.offsetParent !== null || root.contains(document.activeElement));

  const closeMobilePanel = (): void => {
    app.querySelector('.cockpit')?.classList.remove('mobile-panel-open');
    app.querySelectorAll('.coverage-rail, .context-rail').forEach((panel) => {
      panel.classList.remove('mobile-open');
      if (panel instanceof HTMLElement) {
        panel.removeAttribute('role');
        panel.removeAttribute('aria-modal');
      }
    });
    coverageTrigger?.setAttribute('aria-expanded', 'false');
    contextTrigger?.setAttribute('aria-expanded', 'false');
    setInert(questionStage, false);
    setInert(coveragePanel, false);
    setInert(contextPanel, false);
    headerPrivateControls.forEach((control) => setInert(control, false));
    if (mobileEscapeHandler) {
      document.removeEventListener('keydown', mobileEscapeHandler);
      mobileEscapeHandler = null;
    }
    if (mobileTrapHandler && mobilePanel) {
      mobilePanel.removeEventListener('keydown', mobileTrapHandler);
      mobileTrapHandler = null;
    }
    mobilePanel = null;
    const restore = mobileTrigger;
    mobileTrigger = null;
    restore?.focus();
  };

  const openMobilePanel = (panel: HTMLElement | null, trigger: HTMLElement): void => {
    if (!panel) return;
    if (mobilePanel && mobilePanel !== panel) closeMobilePanel();
    mobileTrigger = trigger;
    mobilePanel = panel;
    app.querySelector('.cockpit')?.classList.add('mobile-panel-open');
    app.querySelectorAll('.coverage-rail, .context-rail').forEach((candidate) => {
      candidate.classList.toggle('mobile-open', candidate === panel);
      if (candidate instanceof HTMLElement && candidate !== panel) setInert(candidate, true);
    });
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    coverageTrigger?.setAttribute('aria-expanded', String(panel === coveragePanel));
    contextTrigger?.setAttribute('aria-expanded', String(panel === contextPanel));
    setInert(questionStage, true);
    headerPrivateControls.forEach((control) => setInert(control, true));

    mobileEscapeHandler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeMobilePanel();
      }
    };
    document.addEventListener('keydown', mobileEscapeHandler);

    mobileTrapHandler = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !mobilePanel) return;
      const items = focusableWithin(mobilePanel);
      if (!items.length) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    panel.addEventListener('keydown', mobileTrapHandler);
    queueMicrotask(() => panel.querySelector<HTMLElement>('[data-action="close-mobile-panel"]')?.focus());
  };

  coverageTrigger?.addEventListener('click', (event) => {
    if (mobilePanel === coveragePanel) {
      closeMobilePanel();
      return;
    }
    openMobilePanel(coveragePanel, event.currentTarget as HTMLElement);
  });
  contextTrigger?.addEventListener('click', (event) => {
    if (mobilePanel === contextPanel) {
      closeMobilePanel();
      return;
    }
    openMobilePanel(contextPanel, event.currentTarget as HTMLElement);
  });
  app.querySelectorAll<HTMLElement>('[data-action="close-mobile-panel"]').forEach((button) => button.addEventListener('click', closeMobilePanel));
  paintUpdateSlot();
}

function renderReview(): void {
  if (!session) { view = 'home'; void render(); return; }
  const stats = coverage(session);
  const questions = visibleQuestions(session);
  const buckets = coverageBucketMap(session);
  const presenting = isPresentationMode(presentationMode);
  // Private display only; the exported source is validated separately by the
  // canonical #105 projection before a local file is generated.
  const relevance = relevanceMap(session);
  const proposedActions = session.packSnapshot.questions
    .filter((question) => relevance[question.id] === 'relevant'
      && Boolean(session?.answers[question.id]?.followUp?.action.trim()))
    .map((question) => ({
      question: question.prompt, action: session!.answers[question.id]!.followUp!.action,
      owner: session!.answers[question.id]!.followUp!.owner,
      dueDate: session!.answers[question.id]!.followUp!.dueDate,
    }));
  const deferredActionCount = session.packSnapshot.questions.filter(
    (question) => relevance[question.id] !== 'relevant'
      && Boolean(session?.answers[question.id]?.followUp?.action.trim()),
  ).length;
  app.innerHTML = `
    <header class="app-header"><div><strong>${escapeHtml(session.clientLabel)}</strong><span>${presenting ? 'Presentation read-back' : 'Private review'}</span></div><div class="header-states"><span class="state-pill ${saveState === 'error' ? 'danger' : ''}" data-save-indicator>${escapeHtml(saveLabel())}</span>${presenting ? '<button class="secondary small" data-action="exit-presentation">Exit presentation</button>' : '<button class="secondary small" data-action="enter-presentation">Presentation view</button>'}${updateSlotMarkup()}</div><span class="sr-only" role="alert" data-save-alert>${escapeHtml(saveAlertMessage())}</span></header>
    <main id="main" class="review-shell">
      <button class="text-button" data-action="return">← Return to interview</button>
      <p class="eyebrow">Read-back</p><h1 id="review-title" tabindex="-1">Read back what matters before ending the conversation.</h1>
      ${presenting ? '' : `<div class="review-stats"><span>${stats.resolved} current</span><span>${stats.notApplicable} N/A</span><span>${stats.remaining} currently remaining</span><span>${stats.mustConfirm} must confirm</span></div>`}
      ${sessionPack(session).sections.map((section) => {
        const sectionQuestions = questions.filter((question) => question.sectionId === section.id);
        if (!sectionQuestions.length) return '';
        return `<section class="review-section"><h2>${escapeHtml(section.title)}</h2>${sectionQuestions.map((question) => {
          const state = session!.answers[question.id] ?? blankSemanticState();
          const projected = projectSemanticReadBack(question, state);
          const valueLabel = presenting ? projected.valueLabel : (state.value?.trim() || 'No answer recorded');
          const bucket = buckets[question.id] ?? 'open';
          const statusLabel = bucket === 'current'
            ? semanticStatusLabel(question, state)
            : bucket === 'needs-confirmation'
              ? 'Needs confirmation'
              : bucket === 'not-applicable'
                ? 'Not applicable'
                : state.resolution === 'deferred'
                  ? 'Deferred'
                  : 'Open';
          return `<div class="summary-row"><div><strong>${escapeHtml(question.prompt)}</strong><p>${escapeHtml(valueLabel)}</p><small>${escapeHtml(statusLabel)}</small></div><button class="text-button" data-change="${escapeHtml(question.id)}" aria-label="Change ${escapeHtml(question.prompt)}">Change</button></div>`;
        }).join('')}</section>`;
      }).join('')}
      <section class="review-section unresolved"><h2>Needs confirmation</h2>${questions.filter((question) => buckets[question.id] === 'needs-confirmation').map((question) => `<p>• ${escapeHtml(question.prompt)}</p>`).join('') || '<p>None.</p>'}</section>
      ${presenting ? '' : `<section class="review-section" aria-labelledby="next-steps-title">
        <h2 id="next-steps-title">Proposed next steps — internal only</h2>
        <p>These are drafts to review in the governed client workflow, not approved tasks, commitments or messages. Hidden or pending question actions are excluded from the export.</p>
        ${deferredActionCount ? `<p class="helper-text" role="status">${deferredActionCount} draft action(s) on conditional or inactive questions were retained locally, but are not included in the active proposals.</p>` : ''}
        ${proposedActions.length
          ? `<ul>${proposedActions.map((entry) => `<li><strong>${escapeHtml(entry.question)}</strong>: ${escapeHtml(entry.action)}${entry.owner ? ` · Proposed owner: ${escapeHtml(entry.owner)}` : ''}${entry.dueDate ? ` · Suggested due: ${escapeHtml(entry.dueDate)}` : ''}</li>`).join('')}</ul>`
          : '<p>No currently relevant follow-up proposals recorded.</p>'}
        <button class="secondary" type="button" data-action="next-step-proposals" ${proposedActions.length ? '' : 'disabled'}>Export proposed next steps JSON (private)</button>
      </section>`}
      ${presenting
        ? '<div class="known-preview"><strong>Presentation view</strong><p>Internal notes, provenance, coverage details, delete controls, and internal exports are excluded. This view cannot guarantee that free-text answers themselves contain no sensitive information.</p></div>'
        : '<div class="known-preview"><strong>Private review</strong><p>Internal tools are available here. Use Presentation view before screen sharing or client read-back.</p></div>'}
      ${presenting
        ? ''
        : '<div class="button-row"><button class="primary" data-action="enter-presentation">Open presentation view</button><button class="secondary" data-action="json">Export full JSON backup</button><button class="secondary" data-action="markdown">Export internal Markdown</button><button class="secondary" data-action="handoff">Export private handoff bundle JSON</button><button class="secondary" data-action="home">Home</button><button class="secondary" data-action="delete">Delete local session</button></div>'}
    </main>`;
  app.querySelector('[data-action="return"]')?.addEventListener('click', () => { readBackReturnTarget = null; view = 'interview'; renderInterview(); focusPrimaryAnswer(); });
  app.querySelectorAll<HTMLElement>('[data-change]').forEach((button) => button.addEventListener('click', () => {
    if (!session) return;
    const targetQuestionId = button.dataset.change;
    if (!targetQuestionId || !visibleQuestions(session).some((question) => question.id === targetQuestionId)) return;
    readBackReturnTarget = { sessionId: session.sessionId, questionId: targetQuestionId };
    session.currentQuestionId = targetQuestionId;
    view = 'interview';
    renderInterview();
    focusPrimaryAnswer();
  }));
  app.querySelectorAll('[data-action="enter-presentation"]').forEach((button) => button.addEventListener('click', () => { presentationMode = enterPresentation(); renderReview(); focusReviewHeading(); }));
  app.querySelectorAll('[data-action="exit-presentation"]').forEach((button) => button.addEventListener('click', () => { presentationMode = exitPresentation(); renderReview(); focusReviewHeading(); }));
  app.querySelector('[data-action="json"]')?.addEventListener('click', () => { if (session) download('interview.json', serializeSession(session), 'application/json'); });
  app.querySelector('[data-action="markdown"]')?.addEventListener('click', () => { if (session) download('interview.md', semanticSessionToMarkdown(session), 'text/markdown'); });
  app.querySelector('[data-action="handoff"]')?.addEventListener('click', async () => {
    if (!session || view !== 'review' || isPresentationMode(presentationMode)) return;
    const targetId = session.sessionId;
    try {
      // Confidential full-session package, NOT an approved provider action.
      await autosave.flushAndWait(targetId);
      if (!session || session.sessionId !== targetId
        || view !== 'review' || isPresentationMode(presentationMode)) return;
      const source = structuredClone(session);
      const sourceCanonical = canonicalizeJson(source);
      const bytes = await buildPrivateInterviewHandoffForReview(source);
      if (!session || session.sessionId !== source.sessionId
        || session.revisionId !== source.revisionId
        || canonicalizeJson(session) !== sourceCanonical || autosave.hasPending(targetId)
        || view !== 'review' || isPresentationMode(presentationMode)) return;
      download('interview-private-handoff.json', bytes, 'application/json');
    } catch {
      alert('Unable to verify and save the current local interview. No private handoff file was exported.');
    }
  });
  app.querySelector('[data-action="next-step-proposals"]')?.addEventListener('click', async () => {
    if (!session || view !== 'review' || isPresentationMode(presentationMode)) return;
    const targetId = session.sessionId;
    try {
      // Do not represent an unsaved or stale draft as a workflow-ready export.
      await autosave.flushAndWait(targetId);
      if (session?.sessionId !== targetId || view !== 'review' || isPresentationMode(presentationMode)) return;
      const source = structuredClone(session);
      const exactSnapshot = canonicalizeJson(source);
      const proposal = await proposeInterviewNextStepsForReview(source);
      // Revision IDs alone do not catch in-flight local edits during async
      // projection. Compare the full canonical snapshot and the save queue.
      if (session?.sessionId !== source.sessionId || session?.revisionId !== source.revisionId
        || canonicalizeJson(session) !== exactSnapshot || autosave.hasPending(targetId)
        || view !== 'review' || isPresentationMode(presentationMode)) return;
      if (proposal.items.length === 0) return;
      download('interview-next-step-proposals-private.json', JSON.stringify(proposal, null, 2) + '\n', 'application/json');
    } catch {
      alert('Could not verify or save the current local interview. No proposed next-step file was exported.');
    }
  });
  app.querySelector('[data-action="home"]')?.addEventListener('click', () => { presentationMode = exitPresentation(); view = 'home'; render(); });
  app.querySelector('[data-action="delete"]')?.addEventListener('click', async () => {
    if (!session) return;
    if (!confirm('Delete this local interview? Export a backup first if you need one. This cannot be undone.')) return;
    const deletingSession = session;
    const sessionId = deletingSession.sessionId;
    try {
      await autosave.cancelAndWait(sessionId);
      await deleteSession(sessionId, deletingSession.revisionId);
      if (session?.sessionId === sessionId) session = null;
      presentationMode = exitPresentation();
      view = 'home';
      render();
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Unable to delete local interview.');
    }
  });
  paintUpdateSlot();
}
async function render(): Promise<void> {
  if (view === 'home') return renderHome();
  if (view === 'new') return renderNew();
  if (view === 'review') return renderReview();
  return renderInterview();
}

function flushActiveSessionBestEffort(): void {
  const sessionId = session?.sessionId;
  if (!sessionId) return;
  void autosave.flushAndWait(sessionId).catch((error: unknown) => {
    console.error('Local save failed.', error);
    if (session?.sessionId !== sessionId) return;
    saveState = 'error';
    updateStateIndicators();
  });
}

window.addEventListener('online', () => refreshConnectivityIndicators(true));
window.addEventListener('offline', () => refreshConnectivityIndicators(true));
window.addEventListener('pagehide', () => {
  if (shouldFlushActiveSession({ type: 'pagehide' })) flushActiveSessionBestEffort();
});
document.addEventListener('visibilitychange', () => {
  if (shouldFlushActiveSession({ type: 'visibilitychange', visibilityState: document.visibilityState })) {
    flushActiveSessionBestEffort();
  }
});

document.documentElement.dataset.appRelease = __APP_RELEASE__;
startControlledUpdates({
  getSessionId: () => session?.sessionId ?? null,
  flush: (sessionId) => autosave.flushAndWait(sessionId),
  onSaveError: () => {
    saveState = 'error';
    updateStateIndicators();
  },
  setOfflineReady: (ready) => {
    offlineReady = ready;
    updateStateIndicators();
  },
});

void render();

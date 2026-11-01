import './styles.css';
import type { AnswerStatus, InterviewSession, Question } from './domain';
import { coverage, createSession, nextVisibleQuestion, relevantKnownFacts, validateSessionForPack, validateSessionShape, visibleQuestions } from './domain';
import { generalDiscoveryPack as pack } from './pack';
import { deleteSession, listSessions, loadSession, requestPersistentStorage, saveSession } from './storage';
import { serializeSession, sessionToMarkdown } from './markdown';
import { formatConnectivityLabel, formatSaveLabel, type PersistenceState, type SaveState } from './indicators';
import { SessionAutosaveCoordinator } from './autosave';
import { readSessionList } from './session-list';
import { beginSessionSwitch, importSessionReplacement, openStoredSession, SessionSwitchGate, shouldFlushActiveSession, type OpenStoredSessionResult } from './session-durability';
import { enterPresentation, exitPresentation, isPresentationMode, projectReadBack, type PresentationMode } from './presentation';

const appElement = document.querySelector<HTMLDivElement>('#app');
if (!appElement) throw new Error('App root not found.');
const app: HTMLDivElement = appElement;

type View = 'home' | 'new' | 'interview' | 'review';

let view: View = 'home';
let session: InterviewSession | null = null;
let saveState: SaveState = 'saved';
let persistenceState: PersistenceState = 'unknown';
let offlineReady = false;
let presentationMode: PresentationMode = 'private';
type HomeNotice =
  | null
  | { kind: 'read'; message: string }
  | { kind: 'save'; message: string; sessionId: string };

let homeNotice: HomeNotice = null;
const sessionSwitchGate = new SessionSwitchGate();
let pendingInterviewFocus: 'prompt' | null = null;
let pendingReviewFocus = false;
let phonePanel: 'coverage' | 'context' | null = null;
let phoneInvoker: HTMLElement | null = null;
let saveFailureAnnounced = false;
let announcedConnectivity: string | null = null;

const autosave = new SessionAutosaveCoordinator(saveSession);

const statusOptions: { value: AnswerStatus; label: string }[] = [
  { value: 'ANSWERED', label: 'Answered' },
  { value: 'ALREADY_KNOWN', label: 'Already known' },
  { value: 'SKIP', label: 'Skip' },
  { value: 'N_A', label: 'N/A' },
  { value: 'MUST_CONFIRM', label: 'Must confirm' }
];

const SHELL_CACHE_URLS = ['/', '/index.html', '/manifest.webmanifest', '/icon.svg', '/assets/app.js', '/assets/app.css'] as const;

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
  return visibleQuestions(pack, session).find((question) => question.id === session?.currentQuestionId) ?? visibleQuestions(pack, session)[0];
}

async function refreshPersistenceState(): Promise<void> {
  try {
    persistenceState = (await requestPersistentStorage()) === true ? 'persistent' : 'best-effort';
  } catch {
    persistenceState = 'best-effort';
  }
}

async function isShellCacheReady(): Promise<boolean> {
  if (!('caches' in window)) return false;
  try {
    const cached = await Promise.all(SHELL_CACHE_URLS.map((path) => caches.match(path)));
    return cached.every((response) => response !== undefined);
  } catch {
    return false;
  }
}

function scheduleSave(): void {
  if (!session) return;
  autosave.schedule(session, {
    onScheduled: (sessionId) => {
      if (session?.sessionId !== sessionId) return;
      saveState = 'saving';
      updateStateIndicators();
    },
    onSaved: (sessionId, savedSession) => {
      if (session?.sessionId !== sessionId) return;
      session.updatedAt = savedSession.updatedAt;
      saveState = 'saved';
      updateStateIndicators();
    },
    onError: (sessionId, error) => {
      console.error('Local save failed.', error);
      if (session?.sessionId !== sessionId) return;
      saveState = 'error';
      updateStateIndicators();
    }
  });
}

function saveLabel(): string {
  return formatSaveLabel(saveState, persistenceState);
}

function connectivityLabel(): string {
  return formatConnectivityLabel(navigator.onLine, offlineReady);
}

function announceConsequential(message: string, tone: 'polite' | 'assertive'): void {
  const region = app.querySelector<HTMLElement>('#consequential-status');
  if (!region) return;
  region.setAttribute('role', tone === 'assertive' ? 'alert' : 'status');
  region.setAttribute('aria-live', tone);
  region.textContent = '';
  region.textContent = message;
}

function updateStateIndicators(): void {
  app.querySelectorAll<HTMLElement>('[data-save-indicator]').forEach((element) => {
    element.textContent = saveLabel();
    element.classList.toggle('danger', saveState === 'error');
  });
  app.querySelectorAll<HTMLElement>('[data-connectivity-indicator]').forEach((element) => {
    element.textContent = connectivityLabel();
  });
  if (saveState === 'error' && !saveFailureAnnounced) {
    announceConsequential(saveLabel(), 'assertive');
    saveFailureAnnounced = true;
  } else if (saveState === 'saved' && saveFailureAnnounced) {
    announceConsequential('Local save recovered.', 'polite');
    saveFailureAnnounced = false;
  }
  const connectivity = connectivityLabel();
  if (announcedConnectivity !== null && announcedConnectivity !== connectivity) announceConsequential(connectivity, 'polite');
  announcedConnectivity = connectivity;
}

function refreshConnectivityIndicators(): void {
  if (view === 'new') return;
  updateStateIndicators();
}

async function openStoredSessionForPack(sessionId: string): Promise<OpenStoredSessionResult> {
  const result = await openStoredSession({
    sessionId,
    flush: (id) => autosave.flushAndWait(id),
    load: loadSession,
  });
  if (result.kind !== 'opened') return result;
  try {
    validateSessionForPack(result.session, pack);
    return result;
  } catch (error) {
    return { kind: 'read-failure', error };
  }
}

async function renderHome(): Promise<void> {
  const listState = await readSessionList(listSessions);
  const storageError = listState.kind === 'error';
  const recent = listState.kind === 'ready' ? listState.sessions : [];
  const unreadableCount = listState.kind === 'ready' ? listState.unreadableCount : 0;
  if (storageError) console.error('Unable to read local interviews.', listState.error);

  app.innerHTML = `
    <header class="app-header"><div><strong>Interview Facilitator</strong><span>Local-first discovery cockpit</span></div><span class="state-pill" data-connectivity-indicator>${escapeHtml(connectivityLabel())}</span></header>
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
        <div class="section-heading"><div><p class="eyebrow">On this device</p><h2>Recent interviews</h2></div><span>${storageError ? 'Storage unavailable' : `${recent.length} local`}</span></div>
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
            ${recent.length ? recent.map((item) => `
              <button class="session-card" data-session-id="${escapeHtml(item.sessionId)}">
                <span><strong>${escapeHtml(item.clientLabel)}</strong><small>${escapeHtml(item.interviewMode)} · updated ${escapeHtml(new Date(item.updatedAt).toLocaleString())}</small></span>
                <span aria-hidden="true">→</span>
              </button>`).join('') : '<div class="empty-card">No saved interviews yet.</div>'}`}
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

  if (!storageError) {
    app.querySelector('[data-action="new"]')?.addEventListener('click', () => { homeNotice = null; view = 'new'; render(); });
    app.querySelector('[data-action="import"]')?.addEventListener('click', () => (app.querySelector<HTMLInputElement>('#import-file')?.click()));
  }

  app.querySelector<HTMLInputElement>('#import-file')?.addEventListener('change', async (event) => {
    const fileInput = event.currentTarget as HTMLInputElement;
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    let imported: InterviewSession;
    try {
      imported = validateSessionShape(JSON.parse(await file.text()));
      validateSessionForPack(imported, pack);
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Unable to import session.');
      return;
    }

    const gated = await sessionSwitchGate.run(async () => {
      const outcome = await beginSessionSwitch({
        active: session,
        nextSessionId: imported.sessionId,
        flush: (sessionId) => autosave.flushAndWait(sessionId),
        proceed: () => importSessionReplacement({
          imported,
          flush: (sessionId) => autosave.flushAndWait(sessionId),
          load: loadSession,
          confirmReplace: () => confirm('A local interview with this session ID already exists. Replace it with the imported file? Cancel keeps the local interview unchanged.'),
          save: async (value) => {
            await refreshPersistenceState();
            await saveSession(value);
          },
        }),
      });
      if (outcome.kind === 'save-failure') {
        await showOutgoingSaveFailure(outcome.error);
        return;
      }
      const result = outcome.value;

      if (result.kind === 'replaced') {
        session = result.session;
        homeNotice = null;
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

      console.error('Local import did not replace the saved interview.', result.error);
      saveState = 'error';
      homeNotice = {
        kind: 'save',
        sessionId: imported.sessionId,
        message: result.kind === 'aborted-flush'
          ? 'Pending local edits could not be saved, so the imported file was not written. The in-memory interview is unchanged.'
          : 'The imported file could not be saved. The previously saved local interview was left in place.',
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
}

async function showOutgoingSaveFailure(error: unknown): Promise<void> {
  console.error('Local save failed.', error);
  if (!session) return;
  saveState = 'error';
  homeNotice = {
    kind: 'save',
    sessionId: session.sessionId,
    message: 'The latest edits could not be saved on this device. Switching was stopped so this interview stays available to return to or export. No other local interview was changed.',
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
  app.innerHTML = `
    <header class="app-header"><div><strong>Interview Facilitator</strong><span>New interview</span></div></header>
    <main id="main" class="form-shell">
      <button class="text-button" data-action="home">← Back</button>
      <p class="eyebrow">Pack 1 of 1</p><h1>${escapeHtml(pack.title)}</h1><p>${escapeHtml(pack.description)}</p>
      <form id="new-form" class="setup-card">
        <label>Project or client label<input name="clientLabel" required autocomplete="off" placeholder="Example Project" /></label>
        <label>Interviewer <span>(optional)</span><input name="interviewerLabel" autocomplete="off" /></label>
        <label>Interview mode<select name="interviewMode"><option>Conversation</option><option>Phone</option><option>Video call</option><option>In person</option></select></label>
        <div class="known-preview"><strong>Known context ready</strong><p>${pack.knownFacts.length} synthetic fact is available to demonstrate provenance/reuse.</p></div>
        <button class="primary" type="submit">Start interview</button>
      </form>
    </main>`;
  app.querySelector('[data-action="home"]')?.addEventListener('click', () => { view = 'home'; render(); });
  app.querySelector<HTMLFormElement>('#new-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    const gated = await sessionSwitchGate.run(async () => {
      const next = createSession(pack, {
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
            await saveSession(next);
            return next;
          },
        });
        if (outcome.kind === 'save-failure') {
          await showOutgoingSaveFailure(outcome.error);
          return;
        }
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
}

function answerControl(question: Question, value: string): string {
  const described = question.help ? ' aria-describedby="question-help"' : '';
  const labelled = ' aria-labelledby="question-prompt"';
  if (question.kind === 'textarea') return `<textarea id="answer"${labelled}${described} rows="6" placeholder="Capture the useful answer, not a transcript.">${escapeHtml(value)}</textarea>`;
  if (question.kind === 'single') return `<fieldset class="choice-group"><legend class="sr-only">${escapeHtml(question.prompt)}</legend>${(question.options ?? []).map((option) => `<label class="choice"><input type="radio" name="answer" value="${escapeHtml(option)}" ${value === option ? 'checked' : ''}/><span>${escapeHtml(option)}</span></label>`).join('')}</fieldset>`;
  return `<input id="answer"${labelled}${described} value="${escapeHtml(value)}" />`;
}

function visibleQuestionKey(): string {
  if (!session) return '';
  return visibleQuestions(pack, session).map((item) => item.id).join('\n');
}

function paintInterviewChrome(): void {
  if (!session) return;
  const stats = coverage(pack, session);
  const coverageButton = app.querySelector<HTMLButtonElement>('[data-action="coverage"]');
  if (coverageButton) {
    const expanded = coverageButton.getAttribute('aria-expanded');
    coverageButton.textContent = `Coverage ${stats.resolved}/${stats.visible}`;
    if (expanded) coverageButton.setAttribute('aria-expanded', expanded);
  }
  const resolved = app.querySelector<HTMLElement>('[data-coverage-resolved]');
  if (resolved) resolved.textContent = `${stats.resolved} resolved`;
  const remaining = app.querySelector<HTMLElement>('[data-coverage-remaining]');
  if (remaining) remaining.textContent = `${stats.remaining} currently remaining · ${stats.mustConfirm} must confirm`;
  app.querySelectorAll<HTMLButtonElement>('[data-question-id]').forEach((button) => {
    const status = session?.answers[button.dataset.questionId ?? '']?.status;
    button.classList.toggle('confirm', status === 'MUST_CONFIRM');
  });
  app.querySelectorAll<HTMLInputElement>('input[name="status"]').forEach((input) => {
    input.closest('.status-chip')?.classList.toggle('selected', input.checked);
  });
}

function setInterviewBackgroundInert(panel: HTMLElement | null): void {
  for (const node of [app.querySelector('header'), app.querySelector('.question-stage'), app.querySelector('#coverage-panel'), app.querySelector('#context-panel')]) {
    if (!(node instanceof HTMLElement)) continue;
    node.inert = panel !== null && node !== panel;
  }
}

function closePhonePanel(restoreFocus = true): void {
  const panel = phonePanel ? app.querySelector<HTMLElement>(phonePanel === 'coverage' ? '#coverage-panel' : '#context-panel') : null;
  panel?.classList.remove('mobile-open');
  panel?.removeAttribute('role');
  panel?.removeAttribute('aria-modal');
  panel?.removeAttribute('aria-labelledby');
  const button = phonePanel ? app.querySelector<HTMLButtonElement>(`[data-action="${phonePanel}"]`) : null;
  button?.setAttribute('aria-expanded', 'false');
  setInterviewBackgroundInert(null);
  const restore = phoneInvoker;
  phonePanel = null;
  phoneInvoker = null;
  if (restoreFocus) restore?.focus();
}

function openPhonePanel(which: 'coverage' | 'context', invoker: HTMLElement): void {
  if (phonePanel === which) {
    closePhonePanel();
    return;
  }
  if (phonePanel) closePhonePanel(false);
  const panel = app.querySelector<HTMLElement>(which === 'coverage' ? '#coverage-panel' : '#context-panel');
  const button = app.querySelector<HTMLButtonElement>(`[data-action="${which}"]`);
  if (!panel || !button) return;
  phonePanel = which;
  phoneInvoker = invoker;
  panel.classList.add('mobile-open');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-labelledby', which === 'coverage' ? 'coverage-panel-title' : 'context-panel-title');
  button.setAttribute('aria-expanded', 'true');
  setInterviewBackgroundInert(panel);
  panel.querySelector<HTMLButtonElement>('[data-action="close-panel"]')?.focus();
}

function renderInterview(): void {
  phonePanel = null;
  phoneInvoker = null;
  if (!session) { view = 'home'; void render(); return; }
  const question = currentQuestion();
  if (!question) return;
  if (session.currentQuestionId !== question.id) session.currentQuestionId = question.id;
  const state = session.answers[question.id] ?? { value: null, status: null, note: '' };
  const stats = coverage(pack, session);
  const section = pack.sections.find((item) => item.id === question.sectionId);
  const facts = relevantKnownFacts(question, session);
  const presenting = isPresentationMode(presentationMode);

  app.innerHTML = `
    <header class="app-header cockpit-header">
      <div><strong>${escapeHtml(session.clientLabel)}</strong><span>${escapeHtml(pack.title)}</span></div>
      <div class="header-states"><span class="state-pill ${saveState === 'error' ? 'danger' : ''}" data-save-indicator>${escapeHtml(saveLabel())}</span>${presenting ? '<span class="state-pill">Presentation view</span><button class="secondary small" data-action="exit-presentation">Exit presentation</button>' : `<span class="state-pill" data-connectivity-indicator>${escapeHtml(connectivityLabel())}</span><button class="secondary small" data-action="enter-presentation">Presentation view</button><button class="icon-button" data-action="export" aria-label="Export backup">⇩</button>`}<div id="consequential-status" class="sr-only" role="status"></div></div>
    </header>
    <main id="main" class="cockpit" ${presenting ? 'style="display:block"' : ''}>
      ${presenting ? '' : `<aside id="coverage-panel" class="coverage-rail" aria-label="Interview coverage">
        <div class="rail-heading"><h2 id="coverage-panel-title">Coverage</h2><button type="button" class="secondary rail-close" data-action="close-panel">Close</button><strong data-coverage-resolved>${stats.resolved} resolved</strong><span data-coverage-remaining>${stats.remaining} currently remaining · ${stats.mustConfirm} must confirm</span></div>
        ${pack.sections.map((item) => {
          const questions = visibleQuestions(pack, session!).filter((candidate) => candidate.sectionId === item.id);
          if (!questions.length) return '';
          const done = questions.filter((candidate) => session!.answers[candidate.id]?.status && session!.answers[candidate.id]?.status !== 'MUST_CONFIRM').length;
          return `<div class="coverage-section"><span>${escapeHtml(item.title)}</span><small>${done}/${questions.length}</small>${questions.map((candidate) => `<button class="question-dot ${candidate.id === question.id ? 'current' : ''} ${session!.answers[candidate.id]?.status === 'MUST_CONFIRM' ? 'confirm' : ''}" data-question-id="${escapeHtml(candidate.id)}"><span>${escapeHtml(candidate.prompt)}</span></button>`).join('')}</div>`;
        }).join('')}
      </aside>`}
      <section class="question-stage">
        ${presenting ? '<div class="known-preview"><strong>Presentation view</strong><p>Internal notes, provenance, coverage, status controls, and private tools are intentionally excluded. Answer text can still contain sensitive material, so use interviewer judgment while sharing.</p></div>' : `<div class="mobile-tools"><button type="button" class="secondary small" data-action="coverage" aria-controls="coverage-panel" aria-expanded="false">Coverage ${stats.resolved}/${stats.visible}</button><button type="button" class="secondary small" data-action="context" aria-controls="context-panel" aria-expanded="false">Context ${facts.length}</button></div>`}
        <p class="eyebrow">${escapeHtml(section?.title ?? '')}</p>
        <h1 id="question-prompt" tabindex="-1">${escapeHtml(question.prompt)}</h1>
        ${question.help ? `<p id="question-help" class="question-help">${escapeHtml(question.help)}</p>` : ''}
        <div class="answer-block">${answerControl(question, state.value ?? '')}</div>
        ${presenting ? '' : `<label class="notes-label">Question notes <span>internal</span><textarea id="question-note" rows="3" placeholder="Optional interviewer note">${escapeHtml(state.note)}</textarea></label>
        <fieldset class="status-fieldset"><legend>Question status</legend><div class="status-grid">${statusOptions.map((option) => `<label class="status-chip ${state.status === option.value ? 'selected' : ''}"><input type="radio" name="status" value="${option.value}" ${state.status === option.value ? 'checked' : ''}/><span>${escapeHtml(option.label)}</span></label>`).join('')}</div></fieldset>`}
        <div class="action-dock"><button class="secondary" data-action="back" ${nextVisibleQuestion(pack, session, question.id, -1) ? '' : 'disabled'}>Back</button><button class="primary" data-action="next">${nextVisibleQuestion(pack, session, question.id, 1) ? 'Continue' : 'Review interview'}</button></div>
      </section>
      ${presenting ? '' : `<aside id="context-panel" class="context-rail">
        <div class="rail-heading"><h2 id="context-panel-title">Known context</h2><button type="button" class="secondary rail-close" data-action="close-panel">Close</button></div>
        <section>${facts.length ? facts.map((fact) => `<div class="fact-card"><strong>${escapeHtml(fact.label)}</strong><p>${escapeHtml(fact.value)}</p><small>${escapeHtml(fact.provenance)}</small></div>`).join('') : '<p class="muted">No known facts linked to this question.</p>'}</section>
        <section><label class="notes-label">Running notes <span>internal</span><textarea id="running-notes" rows="10" placeholder="Cross-question notes">${escapeHtml(session.runningNotes)}</textarea></label></section>
      </aside>`}
    </main>`;

  const applyAnswer = (): void => {
    if (!session) return;
    const current = session.answers[question.id] ?? { value: null, status: null, note: '' };
    const textarea = app.querySelector<HTMLTextAreaElement>('#answer');
    const input = app.querySelector<HTMLInputElement>('#answer');
    const radio = app.querySelector<HTMLInputElement>('input[name="answer"]:checked');
    current.value = textarea?.value ?? input?.value ?? radio?.value ?? current.value;
    if (!presenting) {
      current.note = app.querySelector<HTMLTextAreaElement>('#question-note')?.value ?? current.note;
      current.status = (app.querySelector<HTMLInputElement>('input[name="status"]:checked')?.value as AnswerStatus | undefined) ?? current.status;
      session.runningNotes = app.querySelector<HTMLTextAreaElement>('#running-notes')?.value ?? session.runningNotes;
    }
    session.answers[question.id] = current;
    scheduleSave();
  };

  app.querySelectorAll<HTMLInputElement>('input[name="status"]').forEach((element) => element.addEventListener('change', () => {
    applyAnswer();
    if (!presenting) paintInterviewChrome();
  }));
  app.querySelectorAll<HTMLInputElement>('input[name="answer"]').forEach((element) => element.addEventListener('change', () => {
    const before = visibleQuestionKey();
    applyAnswer();
    if (presenting || visibleQuestionKey() === before) return;
    const selected = element.value;
    pendingInterviewFocus = null;
    renderInterview();
    app.querySelector<HTMLInputElement>(`input[name="answer"][value="${CSS.escape(selected)}"]`)?.focus();
  }));
  app.querySelectorAll<HTMLTextAreaElement>('#answer, #question-note, #running-notes').forEach((element) => element.addEventListener('input', applyAnswer));
  app.querySelectorAll<HTMLElement>('[data-question-id]').forEach((button) => button.addEventListener('click', () => {
    applyAnswer();
    if (session) session.currentQuestionId = button.dataset.questionId ?? session.currentQuestionId;
    phonePanel = null;
    phoneInvoker = null;
    pendingInterviewFocus = 'prompt';
    renderInterview();
  }));
  app.querySelector('[data-action="back"]')?.addEventListener('click', () => { applyAnswer(); const previous = session && nextVisibleQuestion(pack, session, question.id, -1); if (previous && session) session.currentQuestionId = previous.id; pendingInterviewFocus = 'prompt'; renderInterview(); });
  app.querySelector('[data-action="next"]')?.addEventListener('click', () => { applyAnswer(); const next = session && nextVisibleQuestion(pack, session, question.id, 1); if (next && session) { session.currentQuestionId = next.id; pendingInterviewFocus = 'prompt'; renderInterview(); } else { presentationMode = enterPresentation(); view = 'review'; pendingReviewFocus = true; render(); } });
  app.querySelector('[data-action="enter-presentation"]')?.addEventListener('click', () => { applyAnswer(); presentationMode = enterPresentation(); renderInterview(); });
  app.querySelector('[data-action="exit-presentation"]')?.addEventListener('click', () => { applyAnswer(); presentationMode = exitPresentation(); pendingInterviewFocus = 'prompt'; renderInterview(); });
  app.querySelector('[data-action="export"]')?.addEventListener('click', () => { if (session) download(`${session.clientLabel.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-interview.json`, serializeSession(session), 'application/json'); });
  app.querySelector<HTMLButtonElement>('[data-action="coverage"]')?.addEventListener('click', (event) => openPhonePanel('coverage', event.currentTarget as HTMLElement));
  app.querySelector<HTMLButtonElement>('[data-action="context"]')?.addEventListener('click', (event) => openPhonePanel('context', event.currentTarget as HTMLElement));
  app.querySelectorAll<HTMLButtonElement>('[data-action="close-panel"]').forEach((button) => button.addEventListener('click', () => closePhonePanel()));
  if (pendingInterviewFocus === 'prompt') {
    pendingInterviewFocus = null;
    app.querySelector<HTMLElement>('#question-prompt')?.focus();
  }
}

function renderReview(): void {
  if (!session) { view = 'home'; void render(); return; }
  const stats = coverage(pack, session);
  const questions = visibleQuestions(pack, session);
  const presenting = isPresentationMode(presentationMode);
  app.innerHTML = `
    <header class="app-header"><div><strong>${escapeHtml(session.clientLabel)}</strong><span>${presenting ? 'Presentation read-back' : 'Private review'}</span></div><div class="header-states"><span class="state-pill ${saveState === 'error' ? 'danger' : ''}" data-save-indicator>${escapeHtml(saveLabel())}</span>${presenting ? '<button class="secondary small" data-action="exit-presentation">Exit presentation</button>' : '<button class="secondary small" data-action="enter-presentation">Presentation view</button>'}</div></header>
    <main id="main" class="review-shell">
      <button class="text-button" data-action="return">← Return to interview</button>
      <p class="eyebrow">Read-back</p><h1 id="readback-heading" tabindex="-1">Read back what matters before ending the conversation.</h1>
      ${presenting ? '' : `<div class="review-stats"><span>${stats.resolved} resolved</span><span>${stats.remaining} currently not resolved</span><span>${stats.mustConfirm} must confirm</span></div>`}
      ${pack.sections.map((section) => {
        const sectionQuestions = questions.filter((question) => question.sectionId === section.id);
        if (!sectionQuestions.length) return '';
        return `<section class="review-section"><h2>${escapeHtml(section.title)}</h2>${sectionQuestions.map((question) => {
          const state = session!.answers[question.id];
          const projected = projectReadBack(state?.value ?? null, state?.status ?? null);
          const valueLabel = presenting ? projected.valueLabel : (state?.value?.trim() || 'No answer recorded');
          const statusLabel = presenting ? projected.statusLabel : (statusOptions.find((item) => item.value === state?.status)?.label ?? 'Unresolved');
          return `<div class="summary-row"><div><strong>${escapeHtml(question.prompt)}</strong><p>${escapeHtml(valueLabel)}</p><small>${escapeHtml(statusLabel)}</small></div><button class="text-button" data-change="${escapeHtml(question.id)}" aria-label="Change ${escapeHtml(question.prompt)}">Change</button></div>`;
        }).join('')}</section>`;
      }).join('')}
      <section class="review-section unresolved"><h2>Needs confirmation</h2>${questions.filter((question) => session!.answers[question.id]?.status === 'MUST_CONFIRM').map((question) => `<p>• ${escapeHtml(question.prompt)}</p>`).join('') || '<p>None.</p>'}</section>
      ${presenting
        ? '<div class="known-preview"><strong>Presentation view</strong><p>Internal notes, provenance, coverage details, delete controls, and internal exports are excluded. This view cannot guarantee that free-text answers themselves contain no sensitive information.</p></div>'
        : '<div class="known-preview"><strong>Private review</strong><p>Internal tools are available here. Use Presentation view before screen sharing or client read-back.</p></div>'}
      ${presenting
        ? ''
        : '<div class="button-row"><button class="primary" data-action="enter-presentation">Open presentation view</button><button class="secondary" data-action="json">Export full JSON backup</button><button class="secondary" data-action="markdown">Export internal Markdown</button><button class="secondary" data-action="home">Home</button><button class="secondary" data-action="delete">Delete local session</button></div>'}
    </main>`;
  app.querySelector('[data-action="return"]')?.addEventListener('click', () => { pendingInterviewFocus = 'prompt'; view = 'interview'; render(); });
  app.querySelectorAll<HTMLElement>('[data-change]').forEach((button) => button.addEventListener('click', () => { if (session) session.currentQuestionId = button.dataset.change ?? session.currentQuestionId; pendingInterviewFocus = 'prompt'; view = 'interview'; render(); }));
  app.querySelectorAll('[data-action="enter-presentation"]').forEach((button) => button.addEventListener('click', () => { presentationMode = enterPresentation(); renderReview(); }));
  app.querySelectorAll('[data-action="exit-presentation"]').forEach((button) => button.addEventListener('click', () => { presentationMode = exitPresentation(); renderReview(); }));
  app.querySelector('[data-action="json"]')?.addEventListener('click', () => { if (session) download('interview.json', serializeSession(session), 'application/json'); });
  app.querySelector('[data-action="markdown"]')?.addEventListener('click', () => { if (session) download('interview.md', sessionToMarkdown(pack, session), 'text/markdown'); });
  app.querySelector('[data-action="home"]')?.addEventListener('click', () => { presentationMode = exitPresentation(); view = 'home'; render(); });
  app.querySelector('[data-action="delete"]')?.addEventListener('click', async () => {
    if (!session) return;
    if (!confirm('Delete this local interview? Export a backup first if you need one. This cannot be undone.')) return;
    const sessionId = session.sessionId;
    try {
      await autosave.cancelAndWait(sessionId);
      await deleteSession(sessionId);
      if (session?.sessionId === sessionId) session = null;
      presentationMode = exitPresentation();
      view = 'home';
      render();
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Unable to delete local interview.');
    }
  });
  if (pendingReviewFocus) {
    pendingReviewFocus = false;
    app.querySelector<HTMLElement>('#readback-heading')?.focus();
  }
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

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && phonePanel) closePhonePanel();
});
window.addEventListener('online', () => refreshConnectivityIndicators());
window.addEventListener('offline', () => refreshConnectivityIndicators());
window.addEventListener('pagehide', () => {
  if (shouldFlushActiveSession({ type: 'pagehide' })) flushActiveSessionBestEffort();
});
document.addEventListener('visibilitychange', () => {
  if (shouldFlushActiveSession({ type: 'visibilitychange', visibilityState: document.visibilityState })) {
    flushActiveSessionBestEffort();
  }
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').then(async () => {
    const readyRegistration = await navigator.serviceWorker.ready;
    offlineReady = Boolean(readyRegistration.active) && await isShellCacheReady();
    refreshConnectivityIndicators();
  }).catch(() => { offlineReady = false; });
}

void render();

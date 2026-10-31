import './styles.css';
import type { AnswerStatus, InterviewSession, Question } from './domain';
import { coverage, createSession, nextVisibleQuestion, relevantKnownFacts, validateSessionForPack, validateSessionShape, visibleQuestions } from './domain';
import { generalDiscoveryPack as pack } from './pack';
import { deleteSession, listSessions, loadSession, requestPersistentStorage, saveSession } from './storage';
import { serializeSession, sessionToMarkdown } from './markdown';
import { formatConnectivityLabel, formatSaveLabel, type PersistenceState, type SaveState } from './indicators';
import { SessionAutosaveCoordinator } from './autosave';
import { readSessionList } from './session-list';
import { importSessionReplacement, openStoredSession, shouldFlushActiveSession } from './session-durability';

const appElement = document.querySelector<HTMLDivElement>('#app');
if (!appElement) throw new Error('App root not found.');
const app: HTMLDivElement = appElement;

type View = 'home' | 'new' | 'interview' | 'review';

let view: View = 'home';
let session: InterviewSession | null = null;
let saveState: SaveState = 'saved';
let persistenceState: PersistenceState = 'unknown';
let offlineReady = false;
let shareSafe = false;
type HomeNotice =
  | null
  | { kind: 'read'; message: string }
  | { kind: 'save'; message: string; sessionId: string };

let homeNotice: HomeNotice = null;

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

function updateStateIndicators(): void {
  app.querySelectorAll<HTMLElement>('[data-save-indicator]').forEach((element) => {
    element.textContent = saveLabel();
    element.classList.toggle('danger', saveState === 'error');
  });
  app.querySelectorAll<HTMLElement>('[data-connectivity-indicator]').forEach((element) => {
    element.textContent = connectivityLabel();
  });
}

function refreshConnectivityIndicators(): void {
  if (view === 'new') return;
  updateStateIndicators();
}

async function renderHome(): Promise<void> {
  const listState = await readSessionList(listSessions);
  const storageError = listState.kind === 'error';
  const recent = listState.kind === 'ready' ? listState.sessions : [];
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

    const result = await importSessionReplacement({
      imported,
      flush: (sessionId) => autosave.flushAndWait(sessionId),
      load: loadSession,
      confirmReplace: () => confirm('A local interview with this session ID already exists. Replace it with the imported file? Cancel keeps the local interview unchanged.'),
      save: async (value) => {
        await refreshPersistenceState();
        await saveSession(value);
      },
    });

    if (result.kind === 'replaced') {
      session = result.session;
      homeNotice = null;
      saveState = 'saved';
      shareSafe = false;
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
  app.querySelectorAll<HTMLElement>('[data-session-id]').forEach((button) => button.addEventListener('click', async () => {
    const sessionId = button.dataset.sessionId ?? '';
    const result = await openStoredSession({
      sessionId,
      flush: (id) => autosave.flushAndWait(id),
      load: loadSession,
    });
    if (result.kind === 'opened') {
      session = result.session;
      homeNotice = null;
      saveState = 'saved';
      await refreshPersistenceState();
      shareSafe = false;
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
  }));
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
    session = createSession(pack, {
      clientLabel: String(data.get('clientLabel') ?? ''),
      interviewerLabel: String(data.get('interviewerLabel') ?? ''),
      interviewMode: String(data.get('interviewMode') ?? '')
    });
    try {
      await refreshPersistenceState();
      await saveSession(session);
      homeNotice = null;
      saveState = 'saved';
      shareSafe = false;
      view = 'interview';
      render();
    } catch (error) {
      saveState = 'error';
      alert(error instanceof Error ? error.message : 'Unable to create local interview.');
    }
  });
}

function answerControl(question: Question, value: string): string {
  if (question.kind === 'textarea') return `<textarea id="answer" rows="6" placeholder="Capture the useful answer, not a transcript.">${escapeHtml(value)}</textarea>`;
  if (question.kind === 'single') return `<fieldset class="choice-group"><legend class="sr-only">${escapeHtml(question.prompt)}</legend>${(question.options ?? []).map((option) => `<label class="choice"><input type="radio" name="answer" value="${escapeHtml(option)}" ${value === option ? 'checked' : ''}/><span>${escapeHtml(option)}</span></label>`).join('')}</fieldset>`;
  return `<input id="answer" value="${escapeHtml(value)}" />`;
}

function renderInterview(): void {
  if (!session) { view = 'home'; void render(); return; }
  const question = currentQuestion();
  if (!question) return;
  if (session.currentQuestionId !== question.id) session.currentQuestionId = question.id;
  const state = session.answers[question.id] ?? { value: null, status: null, note: '' };
  const stats = coverage(pack, session);
  const section = pack.sections.find((item) => item.id === question.sectionId);
  const facts = relevantKnownFacts(question, session);

  app.innerHTML = `
    <header class="app-header cockpit-header">
      <div><strong>${escapeHtml(session.clientLabel)}</strong><span>${escapeHtml(pack.title)}</span></div>
      <div class="header-states"><span class="state-pill ${saveState === 'error' ? 'danger' : ''}" data-save-indicator>${escapeHtml(saveLabel())}</span><span class="state-pill" data-connectivity-indicator>${escapeHtml(connectivityLabel())}</span><button class="secondary small" data-action="share">${shareSafe ? 'Private view' : 'Share-safe view'}</button><button class="icon-button" data-action="export" aria-label="Export backup">⇩</button></div>
    </header>
    <main id="main" class="cockpit" ${shareSafe ? 'style="display:block"' : ''}>
      ${shareSafe ? '' : `<aside class="coverage-rail" aria-label="Interview coverage">
        <div class="rail-heading"><p class="eyebrow">Coverage</p><strong>${stats.resolved} resolved</strong><span>${stats.remaining} currently remaining · ${stats.mustConfirm} must confirm</span></div>
        ${pack.sections.map((item) => {
          const questions = visibleQuestions(pack, session!).filter((candidate) => candidate.sectionId === item.id);
          if (!questions.length) return '';
          const done = questions.filter((candidate) => session!.answers[candidate.id]?.status && session!.answers[candidate.id]?.status !== 'MUST_CONFIRM').length;
          return `<div class="coverage-section"><span>${escapeHtml(item.title)}</span><small>${done}/${questions.length}</small>${questions.map((candidate) => `<button class="question-dot ${candidate.id === question.id ? 'current' : ''} ${session!.answers[candidate.id]?.status === 'MUST_CONFIRM' ? 'confirm' : ''}" data-question-id="${escapeHtml(candidate.id)}"><span>${escapeHtml(candidate.prompt)}</span></button>`).join('')}</div>`;
        }).join('')}
      </aside>`}
      <section class="question-stage">
        ${shareSafe ? '<div class="known-preview"><strong>Share-safe view</strong><p>Internal notes, context, coverage, and status controls are hidden. Use the client-safe read-back for the preferred end-of-call screen share.</p></div>' : `<div class="mobile-tools"><button class="secondary small" data-action="coverage">Coverage ${stats.resolved}/${stats.visible}</button><button class="secondary small" data-action="context">Context ${facts.length}</button></div>`}
        <p class="eyebrow">${escapeHtml(section?.title ?? '')}</p>
        <h1>${escapeHtml(question.prompt)}</h1>
        ${question.help ? `<p class="question-help">${escapeHtml(question.help)}</p>` : ''}
        <div class="answer-block">${answerControl(question, state.value ?? '')}</div>
        ${shareSafe ? '' : `<label class="notes-label">Question notes <span>internal</span><textarea id="question-note" rows="3" placeholder="Optional interviewer note">${escapeHtml(state.note)}</textarea></label>
        <fieldset class="status-fieldset"><legend>Question status</legend><div class="status-grid">${statusOptions.map((option) => `<label class="status-chip ${state.status === option.value ? 'selected' : ''}"><input type="radio" name="status" value="${option.value}" ${state.status === option.value ? 'checked' : ''}/><span>${escapeHtml(option.label)}</span></label>`).join('')}</div></fieldset>`}
        <div class="action-dock"><button class="secondary" data-action="back" ${nextVisibleQuestion(pack, session, question.id, -1) ? '' : 'disabled'}>Back</button><button class="primary" data-action="next">${nextVisibleQuestion(pack, session, question.id, 1) ? 'Continue' : 'Review interview'}</button></div>
      </section>
      ${shareSafe ? '' : `<aside class="context-rail">
        <section><p class="eyebrow">Known context</p>${facts.length ? facts.map((fact) => `<div class="fact-card"><strong>${escapeHtml(fact.label)}</strong><p>${escapeHtml(fact.value)}</p><small>${escapeHtml(fact.provenance)}</small></div>`).join('') : '<p class="muted">No known facts linked to this question.</p>'}</section>
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
    if (!shareSafe) {
      current.note = app.querySelector<HTMLTextAreaElement>('#question-note')?.value ?? current.note;
      current.status = (app.querySelector<HTMLInputElement>('input[name="status"]:checked')?.value as AnswerStatus | undefined) ?? current.status;
      session.runningNotes = app.querySelector<HTMLTextAreaElement>('#running-notes')?.value ?? session.runningNotes;
    }
    session.answers[question.id] = current;
    scheduleSave();
  };

  app.querySelectorAll<HTMLInputElement>('input[name="answer"], input[name="status"]').forEach((element) => element.addEventListener('change', () => { applyAnswer(); if (!shareSafe) renderInterview(); }));
  app.querySelectorAll<HTMLTextAreaElement>('#answer, #question-note, #running-notes').forEach((element) => element.addEventListener('input', applyAnswer));
  app.querySelectorAll<HTMLElement>('[data-question-id]').forEach((button) => button.addEventListener('click', () => { applyAnswer(); if (session) session.currentQuestionId = button.dataset.questionId ?? session.currentQuestionId; renderInterview(); }));
  app.querySelector('[data-action="back"]')?.addEventListener('click', () => { applyAnswer(); const previous = session && nextVisibleQuestion(pack, session, question.id, -1); if (previous && session) session.currentQuestionId = previous.id; renderInterview(); });
  app.querySelector('[data-action="next"]')?.addEventListener('click', () => { applyAnswer(); const next = session && nextVisibleQuestion(pack, session, question.id, 1); if (next && session) { session.currentQuestionId = next.id; renderInterview(); } else { shareSafe = false; view = 'review'; render(); } });
  app.querySelector('[data-action="share"]')?.addEventListener('click', () => { applyAnswer(); shareSafe = !shareSafe; renderInterview(); });
  app.querySelector('[data-action="export"]')?.addEventListener('click', () => { if (session) download(`${session.clientLabel.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-interview.json`, serializeSession(session), 'application/json'); });
  app.querySelector('[data-action="coverage"]')?.addEventListener('click', () => app.querySelector('.coverage-rail')?.classList.toggle('mobile-open'));
  app.querySelector('[data-action="context"]')?.addEventListener('click', () => app.querySelector('.context-rail')?.classList.toggle('mobile-open'));
}

function renderReview(): void {
  if (!session) { view = 'home'; void render(); return; }
  const stats = coverage(pack, session);
  const questions = visibleQuestions(pack, session);
  app.innerHTML = `
    <header class="app-header"><div><strong>${escapeHtml(session.clientLabel)}</strong><span>Client-safe read-back</span></div><span class="state-pill ${saveState === 'error' ? 'danger' : ''}" data-save-indicator>${escapeHtml(saveLabel())}</span></header>
    <main id="main" class="review-shell">
      <button class="text-button" data-action="return">← Return to interview</button>
      <p class="eyebrow">Review</p><h1>Read back what matters before ending the conversation.</h1>
      <div class="review-stats"><span>${stats.resolved} resolved</span><span>${stats.remaining} currently not resolved</span><span>${stats.mustConfirm} must confirm</span></div>
      ${pack.sections.map((section) => {
        const sectionQuestions = questions.filter((question) => question.sectionId === section.id);
        if (!sectionQuestions.length) return '';
        return `<section class="review-section"><h2>${escapeHtml(section.title)}</h2>${sectionQuestions.map((question) => {
          const state = session!.answers[question.id];
          return `<div class="summary-row"><div><strong>${escapeHtml(question.prompt)}</strong><p>${escapeHtml(state?.value?.trim() || 'No answer recorded')}</p><small>${escapeHtml(statusOptions.find((item) => item.value === state?.status)?.label ?? 'Unresolved')}</small></div><button class="text-button" data-change="${escapeHtml(question.id)}">Change</button></div>`;
        }).join('')}</section>`;
      }).join('')}
      <section class="review-section unresolved"><h2>Must confirm</h2>${questions.filter((question) => session!.answers[question.id]?.status === 'MUST_CONFIRM').map((question) => `<p>• ${escapeHtml(question.prompt)}</p>`).join('') || '<p>None.</p>'}</section>
      <div class="known-preview"><strong>Client-safe screen</strong><p>Internal question notes and running notes are intentionally omitted here. Full JSON and Markdown exports remain internal working artifacts.</p></div>
      <div class="button-row"><button class="primary" data-action="json">Export full JSON backup</button><button class="secondary" data-action="markdown">Export internal Markdown</button><button class="secondary" data-action="home">Home</button><button class="secondary" data-action="delete">Delete local session</button></div>
    </main>`;
  app.querySelector('[data-action="return"]')?.addEventListener('click', () => { shareSafe = false; view = 'interview'; render(); });
  app.querySelectorAll<HTMLElement>('[data-change]').forEach((button) => button.addEventListener('click', () => { if (session) session.currentQuestionId = button.dataset.change ?? session.currentQuestionId; shareSafe = false; view = 'interview'; render(); }));
  app.querySelector('[data-action="json"]')?.addEventListener('click', () => { if (session) download('interview.json', serializeSession(session), 'application/json'); });
  app.querySelector('[data-action="markdown"]')?.addEventListener('click', () => { if (session) download('interview.md', sessionToMarkdown(pack, session), 'text/markdown'); });
  app.querySelector('[data-action="home"]')?.addEventListener('click', () => { view = 'home'; render(); });
  app.querySelector('[data-action="delete"]')?.addEventListener('click', async () => {
    if (!session) return;
    if (!confirm('Delete this local interview? Export a backup first if you need one. This cannot be undone.')) return;
    const sessionId = session.sessionId;
    try {
      await autosave.cancelAndWait(sessionId);
      await deleteSession(sessionId);
      if (session?.sessionId === sessionId) session = null;
      shareSafe = false;
      view = 'home';
      render();
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Unable to delete local interview.');
    }
  });
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

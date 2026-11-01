export type UpdatePhase = 'ready' | 'applying' | 'blocked' | 'stale' | 'missing' | null;

interface UpdateDependencies {
  getSessionId: () => string | null;
  flush: (sessionId: string) => Promise<void>;
  onSaveError: (error: unknown) => void;
  setOfflineReady: (ready: boolean) => void;
}

let dependencies: UpdateDependencies | null = null;
let updateReady = false;
let staleRelease = false;
let applying = false;
let blocked = false;
let missingMessage: string | null = null;
let expectedRelease: string | null = null;
let controllerListenerAttached = false;
let reloadScheduled = false;

function askRelease(worker: ServiceWorker): Promise<string> {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = window.setTimeout(() => reject(new Error('The app release did not respond.')), 4000);
    channel.port1.onmessage = (event: MessageEvent<{ release?: string }>) => {
      window.clearTimeout(timer);
      resolve(event.data?.release ?? '');
    };
    worker.postMessage({ type: 'GET_RELEASE' }, [channel.port2]);
  });
}

function currentPhase(): UpdatePhase {
  if (applying) return 'applying';
  if (blocked) return 'blocked';
  if (missingMessage) return 'missing';
  if (staleRelease) return 'stale';
  if (updateReady) return 'ready';
  return null;
}

function button(label: string, action: string): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = 'secondary small';
  element.dataset.action = action;
  element.textContent = label;
  return element;
}

function pill(text: string): HTMLSpanElement {
  const element = document.createElement('span');
  element.className = 'state-pill';
  element.textContent = text;
  return element;
}

export function paintUpdateSlot(): void {
  const phase = currentPhase();
  document.querySelectorAll<HTMLElement>('[data-update-slot]').forEach((slot) => {
    slot.replaceChildren();
    if (phase === 'applying') {
      slot.append(pill('Applying update…'));
      return;
    }
    if (phase === 'blocked') {
      slot.append(pill('Update blocked — local save failed; export/retry'));
      slot.append(button(staleRelease ? 'Save and reload' : 'Apply update', staleRelease ? 'reload-release' : 'apply-update'));
    } else if (phase === 'missing') {
      slot.append(pill(missingMessage ?? 'Update is no longer waiting.'));
      return;
    } else if (phase === 'stale') {
      slot.append(pill('Updated app available — save and reload'));
      slot.append(button('Save and reload', 'reload-release'));
    } else if (phase === 'ready') {
      slot.append(pill('Update ready'));
      slot.append(button('Apply update', 'apply-update'));
    }
    slot.querySelector<HTMLButtonElement>('[data-action="apply-update"]')?.addEventListener('click', () => { void applyUpdate(); });
    slot.querySelector<HTMLButtonElement>('[data-action="reload-release"]')?.addEventListener('click', () => { void reloadAfterSave(); });
  });
}

async function reloadAfterSave(): Promise<void> {
  const sessionId = dependencies?.getSessionId() ?? null;
  if (sessionId && dependencies) {
    try {
      await dependencies.flush(sessionId);
      blocked = false;
    } catch (error) {
      console.error('Local save failed.', error);
      dependencies.onSaveError(error);
      blocked = true;
      paintUpdateSlot();
      return;
    }
  }
  window.location.reload();
}

async function applyUpdate(): Promise<void> {
  if (applying || !dependencies) return;
  const sessionId = dependencies.getSessionId();
  if (sessionId) {
    try {
      await dependencies.flush(sessionId);
      blocked = false;
    } catch (error) {
      console.error('Local save failed.', error);
      dependencies.onSaveError(error);
      blocked = true;
      paintUpdateSlot();
      return;
    }
  }
  const registration = await navigator.serviceWorker.getRegistration();
  const waiting = registration?.waiting ?? null;
  if (!waiting) {
    updateReady = false;
    missingMessage = 'Update is no longer waiting.';
    paintUpdateSlot();
    return;
  }
  try {
    expectedRelease = await askRelease(waiting);
  } catch (error) {
    console.error('Unable to read the waiting release.', error);
    missingMessage = 'Update is no longer waiting.';
    paintUpdateSlot();
    return;
  }
  ensureControllerListener();
  applying = true;
  blocked = false;
  missingMessage = null;
  paintUpdateSlot();
  waiting.postMessage({ type: 'SKIP_WAITING' });
}

function reloadOnce(): void {
  if (reloadScheduled) return;
  reloadScheduled = true;
  window.location.reload();
}

async function onControllerChange(): Promise<void> {
  const controller = navigator.serviceWorker.controller;
  if (!controller || !dependencies) return;
  let release = '';
  try {
    release = await askRelease(controller);
  } catch (error) {
    console.error('Unable to read the active release.', error);
    if (applying) {
      applying = false;
      missingMessage = 'Update did not activate the waiting release.';
      paintUpdateSlot();
    }
    return;
  }
  if (applying) {
    applying = false;
    if (expectedRelease && release !== expectedRelease) {
      missingMessage = 'Update did not activate the waiting release.';
      paintUpdateSlot();
      return;
    }
    reloadOnce();
    return;
  }
  updateReady = false;
  missingMessage = null;
  if (release !== __APP_RELEASE__) {
    staleRelease = true;
    dependencies.setOfflineReady(false);
  } else {
    staleRelease = false;
    blocked = false;
    dependencies.setOfflineReady(true);
  }
  paintUpdateSlot();
}

function watchRegistration(registration: ServiceWorkerRegistration): void {
  const noteWaiting = (): void => {
    if (registration.waiting && navigator.serviceWorker.controller) {
      updateReady = true;
      missingMessage = null;
      paintUpdateSlot();
    }
  };
  noteWaiting();
  registration.addEventListener('updatefound', () => {
    const worker = registration.installing;
    worker?.addEventListener('statechange', () => {
      if (worker.state === 'installed') noteWaiting();
    });
  });
}

function ensureControllerListener(): void {
  if (controllerListenerAttached || !('serviceWorker' in navigator)) return;
  controllerListenerAttached = true;
  navigator.serviceWorker.addEventListener('controllerchange', () => { void onControllerChange(); });
  navigator.serviceWorker.addEventListener('message', (event: MessageEvent<{ type?: string; release?: string; claimed?: boolean }>) => {
    if (event.data?.type !== 'RELEASE_ACTIVATED') return;
    (window as Window & { __releaseClaimed?: boolean }).__releaseClaimed = event.data.claimed === true;
    const release = event.data.release ?? '';
    if (applying && (!expectedRelease || release === expectedRelease)) {
      reloadOnce();
      return;
    }
    if (release !== __APP_RELEASE__ && navigator.serviceWorker.controller) {
      staleRelease = true;
      updateReady = false;
      missingMessage = null;
      paintUpdateSlot();
    }
  });
}

export function startControlledUpdates(next: UpdateDependencies): void {
  dependencies = next;
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  ensureControllerListener();
  void navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).then(async (registration) => {
    watchRegistration(registration);
    const controller = navigator.serviceWorker.controller;
    if (!controller) return;
    const release = await askRelease(controller);
    next.setOfflineReady(release === __APP_RELEASE__);
    paintUpdateSlot();
  }).catch((error: unknown) => {
    console.error('App shell registration failed.', error);
    next.setOfflineReady(false);
  });
}

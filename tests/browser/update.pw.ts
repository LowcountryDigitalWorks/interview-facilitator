import { expect, test, type Page } from '@playwright/test';

test.beforeEach(async ({ request }) => {
  const response = await request.post('/__control', { data: { root: 'release-a' } });
  expect(response.ok()).toBeTruthy();
});

async function controllerRelease(page: Page): Promise<string | null> {
  return page.evaluate(async () => {
    const controller = navigator.serviceWorker.controller;
    if (!controller) return null;
    const channel = new MessageChannel();
    return new Promise<string>((resolve) => {
      channel.port1.onmessage = (event: MessageEvent<{ release?: string }>) => resolve(event.data.release ?? '');
      controller.postMessage({ type: 'GET_RELEASE' }, [channel.port2]);
    });
  });
}

async function cacheNames(page: Page): Promise<string[]> {
  return page.evaluate(async () => caches.keys());
}

async function cachedShell(page: Page, release: string, pathname: string): Promise<string | null> {
  return page.evaluate(async ({ release, pathname }) => {
    const cache = await caches.open(`interview-facilitator-shell-${release}`);
    const response = await cache.match(`${pathname}?release=${encodeURIComponent(release)}`);
    return response ? response.text() : null;
  }, { release, pathname });
}

async function waitForRelease(page: Page, release: string): Promise<void> {
  await expect.poll(() => controllerRelease(page)).toBe(release);
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.appRelease ?? '')).toBe(release);
}

async function publishRelease(page: Page, release: 'release-a' | 'release-b'): Promise<void> {
  const response = await page.request.post('/__control', { data: { root: release } });
  expect(response.ok()).toBeTruthy();
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    await registration?.update();
  });
}

test('release A controls the page and exact offline-ready follows that release', async ({ page }) => {
  await page.goto('/');
  await waitForRelease(page, 'release-a');
  await expect(page.getByText('Online · offline ready')).toBeVisible();
  await expect(page.getByText('Update ready')).toHaveCount(0);
});

test('a waiting release B leaves the active tab on A until Apply update', async ({ page }) => {
  await page.goto('/');
  await waitForRelease(page, 'release-a');
  await page.evaluate(() => { window.sessionStorage.setItem('stay-on-a', 'yes'); });
  const answer = page.locator('#answer');
  await page.getByRole('button', { name: 'New interview' }).click();
  await page.getByLabel('Project or client label').fill('Controlled Update');
  await page.getByRole('button', { name: 'Start interview' }).click();
  await answer.evaluate((element) => { element.dataset.identity = 'kept'; });
  await page.evaluate(async () => {
    const cache = await caches.open('interview-facilitator-shell-release-old');
    await cache.put('/old', new Response('old-shell'));
  });

  await publishRelease(page, 'release-b');
  await expect(page.getByText('Update ready')).toBeVisible();
  await expect.poll(() => controllerRelease(page)).toBe('release-a');
  await expect(answer).toHaveAttribute('data-identity', 'kept');
  await expect.poll(() => page.evaluate(() => window.sessionStorage.getItem('stay-on-a'))).toBe('yes');
  const names = await cacheNames(page);
  expect(names).toContain('interview-facilitator-shell-release-a');
  expect(names).toContain('interview-facilitator-shell-release-b');
  expect(names).toContain('interview-facilitator-shell-release-old');
  const cachedB = await cachedShell(page, 'release-b', '/assets/app.js');
  const cachedA = await cachedShell(page, 'release-a', '/assets/app.js');
  const networkB = await page.evaluate(async () => (await fetch('/assets/app.js?release=release-b', { cache: 'reload' })).text());
  const networkCssB = await page.evaluate(async () => (await fetch('/assets/app.css?release=release-b', { cache: 'reload' })).text());
  expect(cachedB).toBe(networkB);
  expect(cachedB).toContain('release-b');
  expect(cachedB).not.toContain('release-a');
  expect(cachedA).toContain('release-a');
  expect(cachedA).not.toBe(cachedB);
  expect(await cachedShell(page, 'release-b', '/assets/app.css')).toBe(networkCssB);
});

test('Apply update flushes the dirty edit, activates B, and preserves sentinel storage', async ({ page, context }) => {
  await page.goto('/');
  await waitForRelease(page, 'release-a');
  await page.evaluate(async () => {
    const cache = await caches.open('unrelated-sentinel');
    await cache.put('/sentinel', new Response('keep-me'));
    const oldShell = await caches.open('interview-facilitator-shell-release-old');
    await oldShell.put('/old', new Response('old-shell'));
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('ldw-interview-facilitator', 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('sessions')) request.result.createObjectStore('sessions', { keyPath: 'sessionId' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('sessions', 'readwrite');
      tx.objectStore('sessions').put({ sessionId: 'sentinel-session', marker: 'sentinel-row' });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  });

  await page.getByRole('button', { name: 'New interview' }).click();
  await page.getByLabel('Project or client label').fill('Persisted Update');
  await page.getByRole('button', { name: 'Start interview' }).click();
  await page.locator('#answer').fill('persisted-before-update');
  await publishRelease(page, 'release-b');
  await expect(page.getByText('Update ready')).toBeVisible();
  await page.getByRole('button', { name: 'Apply update' }).click();
  await page.waitForFunction(() => document.documentElement.dataset.appRelease === 'release-b');
  await waitForRelease(page, 'release-b');
  await expect(page.getByText('Online · offline ready')).toBeVisible();

  const stored = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('ldw-interview-facilitator', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const rows = await new Promise<unknown[]>((resolve, reject) => {
      const request = db.transaction('sessions', 'readonly').objectStore('sessions').getAll();
      request.onsuccess = () => resolve(request.result as unknown[]);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return JSON.stringify(rows);
  });
  expect(stored).toContain('persisted-before-update');
  expect(stored).toContain('sentinel-row');
  const names = await cacheNames(page);
  expect(names).toContain('unrelated-sentinel');
  expect(names).toContain('interview-facilitator-shell-release-a');
  expect(names).toContain('interview-facilitator-shell-release-b');
  expect(names).not.toContain('interview-facilitator-shell-release-old');
  const activeJs = await cachedShell(page, 'release-b', '/assets/app.js');
  expect(activeJs).toContain('release-b');
  expect(activeJs).not.toContain('release-a');

  await context.setOffline(true);
  await page.reload();
  await waitForRelease(page, 'release-b');
  await expect(page.getByRole('button', { name: 'New interview' })).toBeVisible();
  await expect(page.getByText('Offline')).toBeVisible();
});

test('a second tab does not auto-reload and can save before moving to B', async ({ page, context }) => {
  await page.goto('/');
  await waitForRelease(page, 'release-a');
  const other = await context.newPage();
  await other.goto('/');
  await waitForRelease(other, 'release-a');
  await other.evaluate(() => {
    window.sessionStorage.setItem('tab-two-stayed', 'yes');
    (window as Window & { __stay?: string }).__stay = 'resident';
  });
  await other.getByRole('button', { name: 'New interview' }).click();
  await other.getByLabel('Project or client label').fill('Second Tab');
  await other.getByRole('button', { name: 'Start interview' }).click();

  await publishRelease(page, 'release-b');
  await expect(page.getByText('Update ready')).toBeVisible();
  await page.getByRole('button', { name: 'Apply update' }).click();
  await page.waitForFunction(() => document.documentElement.dataset.appRelease === 'release-b');
  await waitForRelease(page, 'release-b');

  await expect.poll(() => other.evaluate(() => window.sessionStorage.getItem('tab-two-stayed'))).toBe('yes');
  await expect.poll(() => other.evaluate(() => (window as Window & { __stay?: string }).__stay ?? 'reloaded')).toBe('resident');
  await expect(other.getByText('Updated app available — save and reload')).toBeVisible();
  const stayed = await other.evaluate(async () => {
    const read = async (worker: ServiceWorker | null) => {
      if (!worker) return null;
      const channel = new MessageChannel();
      return new Promise<string>((resolve) => {
        channel.port1.onmessage = (event: MessageEvent<{ release?: string }>) => resolve(event.data.release ?? '');
        worker.postMessage({ type: 'GET_RELEASE' }, [channel.port2]);
      });
    };
    const registration = await navigator.serviceWorker.getRegistration();
    return {
      controller: await read(navigator.serviceWorker.controller),
      active: await read(registration?.active ?? null),
      claimed: (window as Window & { __releaseClaimed?: boolean }).__releaseClaimed === true,
    };
  });
  expect(stayed.claimed).toBe(false);
  expect(stayed.active).toBe('release-b');
  await expect.poll(() => other.evaluate(() => document.documentElement.dataset.appRelease ?? '')).toBe('release-a');
  const names = await cacheNames(other);
  expect(names).toContain('interview-facilitator-shell-release-a');
  expect(names).toContain('interview-facilitator-shell-release-b');
  await context.setOffline(true);
  await expect(other.locator('#answer')).toBeVisible();
  const offlineJs = await other.evaluate(async () => (await fetch('/assets/app.js')).text());
  expect(offlineJs).toContain(stayed.controller === 'release-a' ? 'release-a' : 'release-b');
  await context.setOffline(false);
  await other.locator('#answer').fill('saved-from-stale-tab');
  await other.getByRole('button', { name: 'Save and reload' }).click();
  await other.waitForFunction(() => document.documentElement.dataset.appRelease === 'release-b');
  await waitForRelease(other, 'release-b');
  const stored = await other.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('ldw-interview-facilitator', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const rows = await new Promise<unknown[]>((resolve, reject) => {
      const request = db.transaction('sessions', 'readonly').objectStore('sessions').getAll();
      request.onsuccess = () => resolve(request.result as unknown[]);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return JSON.stringify(rows);
  });
  expect(stored).toContain('saved-from-stale-tab');
  await other.close();
});

test('a failed local save blocks activation and leaves B waiting', async ({ page }) => {
  await page.goto('/');
  await waitForRelease(page, 'release-a');
  await page.evaluate(() => { window.sessionStorage.setItem('blocked-update', 'yes'); });
  await page.getByRole('button', { name: 'New interview' }).click();
  await page.getByLabel('Project or client label').fill('Blocked Update');
  await page.getByRole('button', { name: 'Start interview' }).click();
  await publishRelease(page, 'release-b');
  await expect(page.getByText('Update ready')).toBeVisible();
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('ldw-interview-facilitator', 2);
    request.onupgradeneeded = () => {
      if (request.result.objectStoreNames.contains('sessions')) request.result.deleteObjectStore('sessions');
    };
    request.onsuccess = () => { request.result.close(); resolve(); };
    request.onerror = () => reject(request.error);
  }));
  await page.locator('#answer').fill('must-not-activate');
  await expect(page.locator('[data-save-indicator]')).toContainText('Local save failed');
  await page.getByRole('button', { name: 'Apply update' }).click();
  await expect(page.getByText('Update blocked — local save failed; export/retry')).toBeVisible();
  await expect.poll(() => controllerRelease(page)).toBe('release-a');
  await expect.poll(() => page.evaluate(() => window.sessionStorage.getItem('blocked-update'))).toBe('yes');
  const waiting = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    const worker = registration?.waiting;
    if (!worker) return null;
    const channel = new MessageChannel();
    return new Promise<string>((resolve) => {
      channel.port1.onmessage = (event: MessageEvent<{ release?: string }>) => resolve(event.data.release ?? '');
      worker.postMessage({ type: 'GET_RELEASE' }, [channel.port2]);
    });
  });
  expect(waiting).toBe('release-b');
});

test('an unknown same-origin session path is not intercepted or cached', async ({ page }) => {
  await page.goto('/');
  await waitForRelease(page, 'release-a');
  const status = await page.evaluate(async () => {
    const response = await fetch('/synthetic-session-api');
    return response.status;
  });
  expect(status).toBe(404);
  const cached = await page.evaluate(async () => {
    const names = await caches.keys();
    for (const name of names) {
      const cache = await caches.open(name);
      if (await cache.match('/synthetic-session-api')) return true;
    }
    return false;
  });
  expect(cached).toBe(false);
});
